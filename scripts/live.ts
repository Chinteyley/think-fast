// Races both lanes live: each puzzle goes to Kimi K3.1 Pro on Cerebras and on a GPU host
// (Fireworks) at the same time, each on the same clock from its own first token. Unlike the race
// page, where the GPU lane is the Cerebras tokens replayed at a measured rate, the GPU lane here is
// its own stream, so the two lanes think their own thoughts. Saves to ~/.think-fast/runs/live.
//   bun scripts/live.ts [count] [start] [clock_s]
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Puzzle } from "../src/grade.ts";
import puzzleSet from "../src/puzzles.json" with { type: "json" };
import { cerebras, fireworks, type LiveLane, streamLane } from "../src/race.ts";

const [count = 15, start = 0, clockS = 20] = process.argv.slice(2).map(Number);
const [cerebrasKey, fireworksKey] = [process.env.CEREBRAS_API_KEY, process.env.FIREWORKS_API_KEY];
if (!cerebrasKey || !fireworksKey) throw new Error("CEREBRAS_API_KEY and FIREWORKS_API_KEY must be set");
const lanes = [cerebras(cerebrasKey), fireworks(fireworksKey)];

const chosen = (puzzleSet as Puzzle[]).slice(start).slice(0, count);
const startedAt = new Date().toISOString();
const results: { puzzle: Puzzle; lanes: Record<string, LiveLane> }[] = [];
const dir = join(homedir(), ".think-fast", "runs", "live");
const file = `${startedAt.replace(/[:.]/g, "-")}.json`;
await mkdir(dir, { recursive: true });

/** Decode rate over the lane's stream, first token to last (tokens estimated if it was cut). */
const rate = (l: LiveLane) => l.lane.tokens / Math.max(l.deltas.at(-1)?.t ?? 0, 1e-3);
const show = (l: LiveLane) =>
  `${l.lane.answered ? `${l.lane.move}${l.lane.solved ? "✓" : "✗"} ${l.lane.seconds.toFixed(1)}s` : l.timedOut ? "TIME" : "no answer"} · ${l.lane.tokens} tok · ${rate(l).toFixed(0)} tok/s`;

for (const puzzle of chosen) {
  const raced = await Promise.all(lanes.map((e) => streamLane(e, puzzle, clockS, () => {})));
  results.push({ puzzle, lanes: Object.fromEntries(lanes.map((e, i) => [e.name, raced[i]!])) });
  console.log(`${puzzle.id} r${puzzle.rating} · ${lanes.map((e, i) => `${e.name} ${show(raced[i]!)}`).join(" · ")}`);
  // Saved after every puzzle, so a stopped run keeps what it raced.
  await writeFile(
    join(dir, file),
    JSON.stringify({ startedAt, clockS, lanes: lanes.map(({ name, url, model }) => ({ name, url, model })), results }),
  );
}
const solved = (name: string) => results.filter((r) => r.lanes[name]!.lane.solved).length;
console.log(`clock ${clockS}s · ${lanes.map((e) => `${e.name} ${solved(e.name)}/${results.length}`).join(" · ")} · ${file}`);
