import { answerMove, isSolved, type Puzzle } from "./grade.js";

// One race: the same Kimi K3.1 Pro gets the same clock on a chess puzzle. The Cerebras lane is a
// live stream from Cerebras. The GPU lane is the same tokens at a measured GPU decode rate, so it
// answers only if those tokens fit inside the clock at that rate. Both clocks start at the lane's
// first token: queueing and time to first token are left out on both sides.

export const MODEL = "moonshotai-kimi-k3.1-pro-trial";

/** An OpenAI-compatible chat endpoint serving Kimi K3.1 Pro. */
export interface Endpoint {
  name: string;
  url: string;
  model: string;
  apiKey: string;
}

export const cerebras = (apiKey: string): Endpoint => ({
  name: "Cerebras",
  url: "https://api.cerebras.ai/v1/chat/completions",
  model: MODEL,
  apiKey,
});

/** Kimi K3.1 Pro on Fireworks' GPU serverless, for racing a live GPU lane (scripts/live.ts). */
export const fireworks = (apiKey: string): Endpoint => ({
  name: "Fireworks",
  url: "https://api.fireworks.ai/inference/v1/chat/completions",
  model: "accounts/fireworks/models/kimi-k3p1-pro",
  apiKey,
});
/** Kimi K3.1 Pro on a GPU host (Morph, via OpenRouter), first token to last, Nov 22, 2026. */
export const GPU_TOKENS_PER_S = 156;
export const GPU_SOURCE = "Kimi K3.1 Pro on a GPU host (Morph via OpenRouter), measured Nov 22, 2026";
/** Reasoning text runs about 2.95 characters per token (5,762 tokens over 17,141 characters). */
export const CHARS_PER_TOKEN = 2.95;

export interface Delta {
  /** Seconds since the lane's first token. */
  t: number;
  text: string;
  kind: "reasoning" | "answer";
}

export interface LaneResult {
  answered: boolean;
  move: string | null;
  solved: boolean;
  /** Seconds from first token to the answer, or the clock when it ran out. */
  seconds: number;
  tokens: number;
}

export interface PuzzleResult {
  puzzle: Puzzle;
  clockS: number;
  queueRetries: number;
  firstTokenS: number;
  deltas: Delta[];
  /** Server-side decode time Cerebras reported, when the stream finished. */
  serverCompletionS: number | null;
  cerebras: LaneResult;
  gpu: LaneResult & { neededS: number };
}

export type RaceEvent =
  | { type: "puzzle"; index: number; total: number; puzzle: Puzzle; clockS: number; gpuTokensPerS: number }
  | { type: "queue"; attempt: number }
  | { type: "first-token"; afterS: number }
  | { type: "delta"; delta: Delta }
  | { type: "result"; result: Omit<PuzzleResult, "deltas"> }
  | { type: "score"; cerebras: number; gpu: number; of: number; clockS: number };

export function promptFor(puzzle: Puzzle): string {
  const side = puzzle.fen.split(" ")[1] === "w" ? "White" : "Black";
  return [
    `Chess puzzle. FEN: ${puzzle.fen}`,
    `${side} to move and mate in 2. Find the first move.`,
    "End your answer with one line: MOVE: <uci>, e.g. MOVE: e2e4",
  ].join("\n");
}

interface StreamChunk {
  // Cerebras streams thinking as `reasoning`, Fireworks as `reasoning_content`.
  choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null } }[];
  usage?: { completion_tokens?: number };
  time_info?: { completion_time?: number };
}

const QUEUE_LIMIT = 60;
/** Waits `ms`, or less if `signal` aborts. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Opens the stream, waiting out the shared queue's 429s (they are not on either clock). */
async function open(
  endpoint: Endpoint,
  body: unknown,
  emit: (e: RaceEvent) => void,
  signal?: AbortSignal,
): Promise<{ response: Response; retries: number }> {
  for (let attempt = 0; attempt < QUEUE_LIMIT; attempt++) {
    if (signal?.aborted) throw new Error("race cancelled");
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 429 || response.status === 503) {
      await response.body?.cancel();
      emit({ type: "queue", attempt: attempt + 1 });
      await sleep(Math.min(1500 + attempt * 500, 6000), signal);
      continue;
    }
    if (!response.ok || !response.body) {
      throw new Error(`${endpoint.name} ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return { response, retries: attempt };
  }
  throw new Error(`${endpoint.name} queue did not admit the request after ${QUEUE_LIMIT} tries`);
}

export interface LiveLane {
  lane: LaneResult;
  deltas: Delta[];
  retries: number;
  firstTokenS: number;
  serverCompletionS: number | null;
  /** The clock ran out before the answer, so the stream was cut. */
  timedOut: boolean;
}

/** Streams one puzzle from `endpoint` on a clock that starts at its first token, and grades it. */
export async function streamLane(
  endpoint: Endpoint,
  puzzle: Puzzle,
  clockS: number,
  emit: (e: RaceEvent) => void,
  signal?: AbortSignal,
): Promise<LiveLane> {
  const started = performance.now();
  const body = {
    model: endpoint.model,
    messages: [{ role: "user", content: promptFor(puzzle) }],
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: "high",
    max_completion_tokens: 16000,
  };
  const { response, retries } = await open(endpoint, body, emit, signal);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();

  const deltas: Delta[] = [];
  let first: number | null = null;
  // Only what arrives inside the clock counts: a MOVE line after it can't replace the answer.
  let inWindow = "";
  let chars = 0;
  let usageTokens: number | null = null;
  let serverS: number | null = null;
  let answeredAt: number | null = null;
  let timedOut = false;
  let buffer = "";

  const cutOff = () => {
    if (answeredAt !== null) return;
    timedOut = true;
    void reader.cancel();
  };
  // Guards a stream that never starts; replaced by the lane's clock at the first token.
  let deadline = setTimeout(cutOff, (clockS + 600) * 1000);

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trimEnd();
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const chunk = JSON.parse(line.slice(6)) as StreamChunk;
        if (chunk.usage?.completion_tokens) usageTokens = chunk.usage.completion_tokens;
        if (chunk.time_info?.completion_time) serverS = chunk.time_info.completion_time;
        for (const choice of chunk.choices ?? []) {
          const reasoning = choice.delta?.reasoning ?? choice.delta?.reasoning_content ?? "";
          const content = choice.delta?.content ?? "";
          if (!reasoning && !content) continue;
          const now = performance.now();
          if (first === null) {
            first = now;
            emit({ type: "first-token", afterS: (now - started) / 1000 });
            clearTimeout(deadline);
            deadline = setTimeout(cutOff, clockS * 1000);
          }
          const t = (now - first) / 1000;
          for (const [text, kind] of [[reasoning, "reasoning"], [content, "answer"]] as const) {
            if (!text) continue;
            chars += text.length;
            const delta: Delta = { t, text, kind };
            deltas.push(delta);
            emit({ type: "delta", delta });
          }
          if (t > clockS) continue;
          inWindow += content;
          if (answeredAt === null && answerMove(inWindow)) answeredAt = t;
        }
      }
    }
  } finally {
    clearTimeout(deadline);
  }

  const tokens = usageTokens ?? Math.round(chars / CHARS_PER_TOKEN);
  const move = answeredAt === null ? null : answerMove(inWindow);
  return {
    lane: {
      answered: answeredAt !== null,
      move,
      solved: answeredAt !== null && isSolved(puzzle, move),
      seconds: answeredAt ?? clockS,
      tokens,
    },
    deltas,
    retries,
    firstTokenS: first === null ? 0 : (first - started) / 1000,
    serverCompletionS: serverS,
    timedOut,
  };
}

/** Races one puzzle. Emits every step; returns the graded result for both lanes. */
export async function racePuzzle(
  puzzle: Puzzle,
  clockS: number,
  apiKey: string,
  emit: (e: RaceEvent) => void,
  signal?: AbortSignal,
): Promise<PuzzleResult> {
  const live = await streamLane(cerebras(apiKey), puzzle, clockS, emit, signal);
  const { lane: cerebrasLane, deltas, timedOut } = live;
  const { tokens, move } = cerebrasLane;
  // The GPU lane decodes the same tokens: it answers only if all of them fit in the clock.
  const neededS = tokens / GPU_TOKENS_PER_S;
  const gpuAnswered = cerebrasLane.answered && !timedOut && neededS <= clockS;
  const gpu = {
    answered: gpuAnswered,
    move: gpuAnswered ? move : null,
    solved: gpuAnswered && cerebrasLane.solved,
    seconds: gpuAnswered ? neededS : clockS,
    tokens: Math.min(tokens, Math.floor(clockS * GPU_TOKENS_PER_S)),
    neededS,
  };
  const result: PuzzleResult = {
    puzzle,
    clockS,
    queueRetries: live.retries,
    firstTokenS: live.firstTokenS,
    deltas,
    serverCompletionS: live.serverCompletionS,
    cerebras: cerebrasLane,
    gpu,
  };
  const { deltas: _omit, ...summary } = result;
  emit({ type: "result", result: summary });
  return result;
}
