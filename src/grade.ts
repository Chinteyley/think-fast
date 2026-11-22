import { Chess } from "chess.js";

/** A mate-in-2 puzzle from the Lichess puzzle database (CC0): the position and its solution line. */
export type Puzzle = {
  id: string;
  rating: number;
  fen: string;
  solution: string[];
  themes: string[];
  url: string;
};

const UCI = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;
const MOVE_LINE = /MOVE:\s*`?([a-h][1-8][a-h][1-8][qrbn]?)`?/gi;

/** The answer's move: the last `MOVE: <uci>` line in the model's reply, or null. */
export function answerMove(text: string): string | null {
  const matches = [...text.matchAll(MOVE_LINE)];
  const last = matches.at(-1)?.[1];
  return last ? last.toLowerCase() : null;
}

function play(board: Chess, uci: string): boolean {
  const m = UCI.exec(uci);
  if (!m) return false;
  try {
    board.move({ from: m[1], to: m[2], promotion: m[3] });
    return true;
  } catch {
    return false;
  }
}

/** True when `uci` is legal and forces mate in at most two moves: every reply has a mating answer. */
export function forcesMateIn2(fen: string, uci: string): boolean {
  const board = new Chess(fen);
  if (!play(board, uci)) return false;
  if (board.isCheckmate()) return true;
  const replies = board.moves({ verbose: true });
  if (replies.length === 0) return false; // stalemate
  return replies.every((reply) => {
    board.move(reply);
    const mates = board.moves({ verbose: true }).some((answer) => {
      board.move(answer);
      const mate = board.isCheckmate();
      board.undo();
      return mate;
    });
    board.undo();
    return mates;
  });
}

/** A first move is right when it is the puzzle's own or another move that also forces mate in 2. */
export function isSolved(puzzle: Puzzle, uci: string | null): boolean {
  if (!uci) return false;
  return uci === puzzle.solution[0] || forcesMateIn2(puzzle.fen, uci);
}
