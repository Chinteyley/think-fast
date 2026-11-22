// Runs the same race engine the plugin uses, from the command line, and saves the run where the
// race page replays it (~/.think-fast/runs). For collecting a full scoreboard while the
// Cerebras queue is too busy for a live agent turn.
//   bun scripts/race.ts [count] [start] [clock_s]
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Puzzle } from "../src/grade.ts";
import puzzleSet from "../src/puzzles.json" with { type: "json" };
import { GPU_SOURCE, GPU_TOKENS_PER_S, MODEL, type PuzzleResult, racePuzzle } from "../src/race.ts";

const [count = 15, start = 0, clockS = 20] = process.argv.slice(2).map(Number);
const apiKey = process.env.CEREBRAS_API_KEY;
if (!apiKey) throw new Error("CEREBRAS_API_KEY is not set");

const chosen = (puzzleSet as Puzzle[]).slice(start).slice(0, count);
const startedAt = new Date().toISOString();
const results: PuzzleResult[] = [];
const dir = join(homedir(), ".think-fast", "runs");
const file = `${startedAt.replace(/[:.]/g, "-")}.json`;
await mkdir(dir, { recursive: true });

for (const puzzle of chosen) {
  let retries = 0;
  const result = await racePuzzle(puzzle, clockS, apiKey, (e) => {
    if (e.type === "queue") retries = e.attempt;
  });
  results.push(result);
  const lane = (l: PuzzleResult["cerebras"]) => (l.answered ? `${l.move}${l.solved ? "✓" : "✗"} ${l.seconds.toFixed(1)}s` : "TIME");
  console.log(
    `${puzzle.id} r${puzzle.rating} · cerebras ${lane(result.cerebras)} · gpu ${lane(result.gpu)} (needs ${result.gpu.neededS.toFixed(1)}s) · ${result.cerebras.tokens} tok · server ${result.serverCompletionS?.toFixed(2) ?? "-"}s · 429s ${retries}`,
  );
  // Saved after every puzzle, so a stopped run still replays.
  await writeFile(join(dir, file), JSON.stringify({ startedAt, model: MODEL, clockS, gpuTokensPerS: GPU_TOKENS_PER_S, gpuSource: GPU_SOURCE, results }));
}
const c = results.filter((r) => r.cerebras.solved).length;
const g = results.filter((r) => r.gpu.solved).length;
console.log(`clock ${clockS}s · Cerebras ${c}/${results.length} · GPU speed ${g}/${results.length} · ${file}`);
