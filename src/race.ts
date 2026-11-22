import { answerMove, isSolved, type Puzzle } from "./grade.js";

// One race: the same Kimi K3.1 Pro gets the same clock on a chess puzzle. The Cerebras lane is a
// live stream from Cerebras. The GPU lane is the same tokens at a measured GPU decode rate, so it
// answers only if those tokens fit inside the clock at that rate. Both clocks start at the lane's
// first token: queueing and time to first token are left out on both sides.

export const MODEL = "moonshotai-kimi-k3.1-pro-trial";
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
  choices?: { delta?: { content?: string | null; reasoning?: string | null } }[];
  usage?: { completion_tokens?: number };
  time_info?: { completion_time?: number };
}

const QUEUE_LIMIT = 60;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Opens the stream, waiting out the shared queue's 429s (they are not on either clock). */
async function open(
  apiKey: string,
  body: unknown,
  emit: (e: RaceEvent) => void,
  signal?: AbortSignal,
): Promise<{ response: Response; retries: number }> {
  for (let attempt = 0; attempt < QUEUE_LIMIT; attempt++) {
    if (signal?.aborted) throw new Error("race cancelled");
    const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
      throw new Error(`Cerebras ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return { response, retries: attempt };
  }
  throw new Error(`Cerebras queue did not admit the request after ${QUEUE_LIMIT} tries`);
}

/** Races one puzzle. Emits every step; returns the graded result for both lanes. */
export async function racePuzzle(
  puzzle: Puzzle,
  clockS: number,
  apiKey: string,
  emit: (e: RaceEvent) => void,
  signal?: AbortSignal,
): Promise<PuzzleResult> {
  const started = performance.now();
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: promptFor(puzzle) }],
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: "high",
    max_completion_tokens: 16000,
  };
  const { response, retries } = await open(apiKey, body, emit, signal);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();

  const deltas: Delta[] = [];
  let first: number | null = null;
  let answer = "";
  let chars = 0;
  let usageTokens: number | null = null;
  let serverS: number | null = null;
  let answeredAt: number | null = null;
  let timedOut = false;
  let buffer = "";

  const deadline = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, (clockS + 600) * 1000); // replaced at first token; this only guards a stream that never starts

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const chunk = JSON.parse(line.slice(6)) as StreamChunk;
        if (chunk.usage?.completion_tokens) usageTokens = chunk.usage.completion_tokens;
        if (chunk.time_info?.completion_time) serverS = chunk.time_info.completion_time;
        for (const choice of chunk.choices ?? []) {
          const reasoning = choice.delta?.reasoning ?? "";
          const content = choice.delta?.content ?? "";
          if (!reasoning && !content) continue;
          const now = performance.now();
          if (first === null) {
            first = now;
            emit({ type: "first-token", afterS: (now - started) / 1000 });
            clearTimeout(deadline);
            setTimeout(() => {
              if (answeredAt === null) {
                timedOut = true;
                void reader.cancel();
              }
            }, clockS * 1000);
          }
          const t = (now - first) / 1000;
          for (const [text, kind] of [[reasoning, "reasoning"], [content, "answer"]] as const) {
            if (!text) continue;
            chars += text.length;
            const delta: Delta = { t, text, kind };
            deltas.push(delta);
            emit({ type: "delta", delta });
          }
          answer += content;
          if (answeredAt === null && answerMove(answer) && t <= clockS) answeredAt = t;
        }
      }
    }
  } finally {
    clearTimeout(deadline);
  }

  const tokens = usageTokens ?? Math.round(chars / CHARS_PER_TOKEN);
  const move = answeredAt === null ? null : answerMove(answer);
  const cerebras: LaneResult = {
    answered: answeredAt !== null,
    move,
    solved: answeredAt !== null && isSolved(puzzle, move),
    seconds: answeredAt ?? clockS,
    tokens,
  };
  // The GPU lane decodes the same tokens: it answers only if all of them fit in the clock.
  const neededS = tokens / GPU_TOKENS_PER_S;
  const gpuAnswered = cerebras.answered && !timedOut && neededS <= clockS;
  const gpu = {
    answered: gpuAnswered,
    move: gpuAnswered ? move : null,
    solved: gpuAnswered && cerebras.solved,
    seconds: gpuAnswered ? neededS : clockS,
    tokens: Math.min(tokens, Math.floor(clockS * GPU_TOKENS_PER_S)),
    neededS,
  };
  const result: PuzzleResult = {
    puzzle,
    clockS,
    queueRetries: retries,
    firstTokenS: first === null ? 0 : (first - started) / 1000,
    deltas,
    serverCompletionS: serverS,
    cerebras,
    gpu,
  };
  const { deltas: _omit, ...summary } = result;
  emit({ type: "result", result: summary });
  return result;
}
