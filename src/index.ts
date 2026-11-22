import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { Puzzle } from "./grade.js";
import { PAGE } from "./page.js";
import puzzleSet from "./puzzles.json" with { type: "json" };
import { GPU_SOURCE, GPU_TOKENS_PER_S, MODEL, type PuzzleResult, type RaceEvent, racePuzzle, sleep } from "./race.js";

// Think Fast: an OpenClaw tool that races Kimi K3.1 Pro on Cerebras against GPU speed on real
// Lichess mate-in-2 puzzles, on the same clock, and a live race page served by the Gateway at
// /think-fast. Every run is saved so the page can replay it at its real timings.

const PUZZLES = puzzleSet as Puzzle[];
const Params = Type.Object({
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: PUZZLES.length, description: `Puzzles to race, default 5 (the set has ${PUZZLES.length})` })),
  start: Type.Optional(Type.Integer({ minimum: 0, maximum: PUZZLES.length - 1, description: "Index of the first puzzle, default 0" })),
  clock_s: Type.Optional(Type.Number({ minimum: 5, maximum: 120, description: "Seconds of thinking per puzzle, from each lane's first token. Default 20" })),
});
type RaceParams = Static<typeof Params>;
const RUNS_DIR = join(homedir(), ".think-fast", "runs");
/** The runs shipped in the repo, so the page replays them with no API key. */
const BUNDLED_RUNS = fileURLToPath(new URL("../runs/", import.meta.url));
const listeners = new Set<(e: RaceEvent) => void>();
let running = false;

const emit = (e: RaceEvent): void => {
  for (const listener of listeners) listener(e);
};

function events(req: IncomingMessage, res: ServerResponse): boolean {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  const send = (e: RaceEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  listeners.add(send);
  req.on("close", () => listeners.delete(send));
  return true;
}

async function runs(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const name = basename(decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^\/think-fast\/runs\/?/, "")));
  if (!name) {
    const listed = await Promise.all([RUNS_DIR, BUNDLED_RUNS].map((dir) => readdir(dir).catch(() => [])));
    const files = [...new Set(listed.flat())].filter((f) => f.endsWith(".json")).sort();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(files));
    return true;
  }
  const body =
    (await readFile(join(RUNS_DIR, name), "utf8").catch(() => null)) ??
    (await readFile(join(BUNDLED_RUNS, name), "utf8").catch(() => null));
  if (body === null) res.writeHead(404).end("no such run");
  else res.writeHead(200, { "Content-Type": "application/json" }).end(body);
  return true;
}

function summary(results: PuzzleResult[], clockS: number): string {
  const c = results.filter((r) => r.cerebras.solved).length;
  const g = results.filter((r) => r.gpu.solved).length;
  const rows = results.map((r, i) => {
    const lane = (l: PuzzleResult["cerebras"]) => (l.answered ? `${l.move} ${l.solved ? "✓" : "✗"} ${l.seconds.toFixed(1)}s` : "time");
    return `${i + 1}. ${r.puzzle.url} · Cerebras ${lane(r.cerebras)} · GPU ${lane(r.gpu)} · ${r.cerebras.tokens} tokens`;
  });
  return [`Same clock (${clockS} s from first token). Cerebras solved ${c}/${results.length}, GPU speed solved ${g}/${results.length}.`, ...rows].join("\n");
}

export default definePluginEntry({
  id: "think-fast",
  name: "Think Fast",
  description: "Race the same Kimi K3.1 Pro on Cerebras against GPU speed on real chess puzzles, on the same clock.",
  register(api) {
    api.registerHttpRoute({
      path: "/think-fast",
      auth: "plugin",
      match: "exact",
      handler: async (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
        return true;
      },
    });
    api.registerHttpRoute({ path: "/think-fast/events", auth: "plugin", match: "exact", handler: async (req, res) => events(req, res) });
    api.registerHttpRoute({ path: "/think-fast/runs", auth: "plugin", match: "prefix", handler: runs });

    api.registerTool({
      name: "think_fast",
      label: "Think Fast race",
      description:
        `Race ${MODEL} on Cerebras against GPU speed (${GPU_TOKENS_PER_S} tok/s, ${GPU_SOURCE}) on real Lichess mate-in-2 puzzles, on the same clock per puzzle. Shows live at /think-fast on the Gateway and returns the score.`,
      parameters: Params,
      async execute(_id, raw, signal) {
        const params: RaceParams = Value.Parse(Params, raw);
        const apiKey = process.env.CEREBRAS_API_KEY;
        if (!apiKey) throw new Error("CEREBRAS_API_KEY is not set for the Gateway");
        if (running) throw new Error("A race is already running; watch it at /think-fast");
        running = true;
        const clockS = params.clock_s ?? 20;
        const chosen = PUZZLES.slice(params.start ?? 0).slice(0, params.count ?? 5);
        const startedAt = new Date().toISOString();
        const results: PuzzleResult[] = [];
        try {
          for (const [index, puzzle] of chosen.entries()) {
            emit({ type: "puzzle", index, total: chosen.length, puzzle, clockS, gpuTokensPerS: GPU_TOKENS_PER_S });
            const result = await racePuzzle(puzzle, clockS, apiKey, emit, signal);
            results.push(result);
            // The GPU lane can still be thinking on the page after Cerebras' stream ends: hold the
            // next puzzle until both lanes have their verdict, then a beat to read it (as a replay does).
            const end = Math.max(result.cerebras.seconds, result.gpu.answered ? result.gpu.neededS : clockS);
            const shown = result.deltas.at(-1)?.t ?? 0;
            await sleep(Math.max(0, end - shown) * 1000 + 2500, signal);
          }
        } finally {
          running = false;
        }
        const solved = { cerebras: results.filter((r) => r.cerebras.solved).length, gpu: results.filter((r) => r.gpu.solved).length };
        emit({ type: "score", ...solved, of: results.length, clockS });
        await mkdir(RUNS_DIR, { recursive: true });
        const file = `${startedAt.replace(/[:.]/g, "-")}.json`;
        await writeFile(join(RUNS_DIR, file), JSON.stringify({ startedAt, model: MODEL, clockS, gpuTokensPerS: GPU_TOKENS_PER_S, gpuSource: GPU_SOURCE, results }));
        const text = `${summary(results, clockS)}\nReplay: /think-fast?run=${file}`;
        return { content: [{ type: "text", text }], details: { file, ...solved, of: results.length, clockS } };
      },
    });
  },
});
