import { afterEach, describe, expect, it, vi } from "vitest";
import type { Puzzle } from "./grade.js";
import puzzles from "./puzzles.json" with { type: "json" };
import { fireworks, racePuzzle, streamLane } from "./race.js";

// The lane verdicts behind the score: Cerebras answers if its MOVE line lands inside the clock;
// the GPU lane gets the same tokens at 156 tok/s and answers only if all of them fit in it.
const QC2vI = (puzzles as Puzzle[]).find((p) => p.id === "QC2vI")!;
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** A stream that thinks for `chunks` deltas, then answers, then reports `tokens` used. */
function stream(tokens: number, answer: string | null, chunks = 3, thinking = "reasoning") {
  const enc = new TextEncoder();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise((r) => setTimeout(r, 20));
      if (sent++ < chunks || answer === null) return c.enqueue(enc.encode(sse({ choices: [{ delta: { [thinking]: "thinking " } }] })));
      c.enqueue(enc.encode(sse({ choices: [{ delta: { content: `MOVE: ${answer}` } }] }) + sse({ choices: [], usage: { completion_tokens: tokens } }) + "data: [DONE]\n\n"));
      c.close();
    },
  });
}

const race = (body: ReadableStream<Uint8Array>, clockS: number) => {
  vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));
  return racePuzzle(QC2vI, clockS, "test-key", () => {});
};

afterEach(() => vi.unstubAllGlobals());

describe("racePuzzle", () => {
  it("scores both lanes when the tokens fit the clock at GPU speed", async () => {
    const r = await race(stream(300, "h5h2"), 5);
    expect(r.cerebras).toMatchObject({ answered: true, solved: true, move: "h5h2", tokens: 300 });
    expect(r.gpu).toMatchObject({ answered: true, solved: true });
    expect(r.gpu.neededS).toBeCloseTo(300 / 156);
  });

  it("times the GPU lane out when the same tokens need longer than the clock", async () => {
    const r = await race(stream(1000, "h5h2"), 5);
    expect(r.cerebras.solved).toBe(true);
    expect(r.gpu).toMatchObject({ answered: false, solved: false, seconds: 5 });
  });

  it("cuts Cerebras off at the clock when no answer arrives", async () => {
    const r = await race(stream(0, null), 0.2);
    expect(r.cerebras).toMatchObject({ answered: false, solved: false, seconds: 0.2 });
    expect(r.gpu.answered).toBe(false);
  });

  it("starts a Fireworks lane's clock at its first reasoning_content token", async () => {
    vi.stubGlobal("fetch", async () => new Response(stream(300, "h5h2", 3, "reasoning_content"), { status: 200 }));
    const live = await streamLane(fireworks("test-key"), QC2vI, 5, () => {});
    expect(live.deltas.filter((d) => d.kind === "reasoning")).toHaveLength(3);
    expect(live.lane).toMatchObject({ answered: true, solved: true });
    expect(live.lane.seconds).toBeGreaterThan(0.03);
  });

  it("grades the answer given inside the clock, not a MOVE line that arrives after it", async () => {
    const enc = new TextEncoder();
    const events = [
      [0, { reasoning: "thinking " }],
      [10, { content: "MOVE: h5h1\n" }],
      [90, { content: "MOVE: h5h2" }],
    ] as const;
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const [wait, delta] of events) {
          await new Promise((r) => setTimeout(r, wait));
          c.enqueue(enc.encode(sse({ choices: [{ delta }] }).replace("\n\n", "\r\n\r\n")));
        }
        c.enqueue(enc.encode("data: [DONE]\r\n\r\n"));
        c.close();
      },
    });
    const r = await race(body, 0.05);
    expect(r.cerebras).toMatchObject({ answered: true, move: "h5h1", solved: false });
  });
});
