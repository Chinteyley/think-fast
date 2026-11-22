import { describe, expect, it } from "vitest";
import { answerMove, forcesMateIn2, isSolved, type Puzzle } from "./grade.js";
import puzzles from "./puzzles.json" with { type: "json" };

const set = puzzles as Puzzle[];

describe("answerMove", () => {
  it("reads the last MOVE line, case-insensitive promotion", () => {
    expect(answerMove("maybe MOVE: e2e4\n...\nMOVE: F7E8Q")).toBe("f7e8q");
    expect(answerMove("MOVE: `h5h2`")).toBe("h5h2");
    expect(answerMove("I think Qh7 is mate")).toBeNull();
  });
});

describe("grading", () => {
  it("accepts every puzzle's own first move", () => {
    for (const p of set) expect(isSolved(p, p.solution[0])).toBe(true);
  });

  it("rejects an illegal move, a non-move and a legal move that does not mate", () => {
    const p = set[0]!;
    expect(isSolved(p, "a1a1")).toBe(false);
    expect(isSolved(p, null)).toBe(false);
    const quiet = set.map((q) => ({ q, wrong: wrongMove(q) })).find((x) => x.wrong);
    expect(quiet && forcesMateIn2(quiet.q.fen, quiet.wrong!)).toBe(false);
  });
});

/** Some legal first move that is not the solution (used to check the grader says no). */
function wrongMove(p: Puzzle): string | undefined {
  const files = "abcdefgh";
  for (const f of files) for (let r = 1; r <= 8; r++) for (const g of files) for (let s = 1; s <= 8; s++) {
    const uci = `${f}${r}${g}${s}`;
    if (uci !== p.solution[0] && !forcesMateIn2(p.fen, uci) && legal(p.fen, uci)) return uci;
  }
  return undefined;
}

import { Chess } from "chess.js";
function legal(fen: string, uci: string): boolean {
  try {
    new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    return true;
  } catch {
    return false;
  }
}
