// The race page the plugin serves at /think-fast: the board, two lanes of thinking and their
// clocks, and the score. Live from /think-fast/events, or a saved run replayed at its real
// timings with ?run=<file>. Plain HTML and JS, so the Gateway serves it with no build step.

export const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Think Fast</title>
<style>
:root{--bg:#0b0c10;--panel:#14161c;--line:#262a33;--ink:#f5f5f4;--soft:#d4d7dd;--orange:#f15a29;--gpu:#c9ccd3;--ok:#4ade80;--bad:#f87171}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 "SF Pro Text",Inter,system-ui,sans-serif}
.wrap{display:grid;grid-template-rows:auto 1fr auto;height:100vh;padding:28px 36px;gap:22px}
header{display:flex;align-items:baseline;justify-content:space-between}
h1{margin:0;font-size:34px;letter-spacing:-.5px}h1 b{color:var(--orange)}
.sub{color:var(--soft);font-size:17px}
.stage{display:grid;grid-template-columns:1fr auto 1fr;gap:28px;min-height:0}
.lane{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px 22px;display:grid;grid-template-rows:auto auto 1fr auto;min-height:0;gap:10px}
.lane.cb{border-color:#5a2a1a}
.who{font-weight:700;font-size:19px}.who small{display:block;font-weight:500;color:var(--soft);font-size:14px;margin-top:2px}
.clock{font:700 64px/1 "SF Mono",ui-monospace,Menlo,monospace;letter-spacing:-2px}
.cb .clock{color:var(--orange)}.gp .clock{color:var(--gpu)}
.meta{font:500 15px "SF Mono",ui-monospace,Menlo,monospace;color:var(--soft)}
.think{overflow:hidden;font:400 13.5px/1.45 "SF Mono",ui-monospace,Menlo,monospace;color:#aeb3bd;white-space:pre-wrap;word-break:break-word;display:flex;flex-direction:column;justify-content:flex-end;mask-image:linear-gradient(transparent,#000 22%)}
.verdict{font:700 26px/1.2 "SF Pro Display",Inter,system-ui,sans-serif;min-height:34px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.wait{color:var(--soft)}
.mid{display:grid;grid-template-rows:auto auto auto;gap:14px;align-content:start;justify-items:center}
.board{display:grid;grid-template-columns:repeat(8,58px);grid-template-rows:repeat(8,58px);border-radius:10px;overflow:hidden;border:1px solid var(--line)}
.sq{display:grid;place-items:center;font-size:44px;line-height:1}.l{background:#e8e2d0}.d{background:#a08c6d}
.sq.from{box-shadow:inset 0 0 0 4px var(--orange)}.sq.to{box-shadow:inset 0 0 0 4px var(--orange);background:#f7b28f}
.pw{color:#fff;-webkit-text-stroke:1.2px #111}.pb{color:#111}
.task{font-size:17px;color:var(--soft);text-align:center}.task b{color:var(--ink)}
.queue{font:500 14px "SF Mono",ui-monospace,monospace;color:var(--soft);min-height:20px;text-align:center}
footer{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding-top:16px}
.score{font:700 24px "SF Pro Display",Inter,system-ui,sans-serif}.score .c{color:var(--orange)}.score .g{color:var(--gpu)}
.note{color:var(--soft);font-size:14px;max-width:62%;text-align:right}
</style></head><body><div class="wrap">
<header><h1>Think <b>Fast</b></h1><div class="sub" id="sub">Same Kimi K3.1 Pro, same tokens, same clock. Only the speed differs.</div></header>
<div class="stage">
  <section class="lane cb"><div class="who">Kimi K3.1 Pro · Cerebras<small id="c-src">live stream from Cerebras</small></div>
    <div class="clock" id="c-clock">--.-</div><div class="think" id="c-think"></div>
    <div><div class="meta" id="c-meta">0 tokens</div><div class="verdict" id="c-verdict"></div></div></section>
  <section class="mid"><div class="task" id="task">Waiting for a race…</div><div class="board" id="board"></div><div class="queue" id="queue"></div></section>
  <section class="lane gp"><div class="who">Kimi K3.1 Pro · GPU speed<small id="g-src">the Cerebras tokens, replayed at a measured GPU rate</small></div>
    <div class="clock" id="g-clock">--.-</div><div class="think" id="g-think"></div>
    <div><div class="meta" id="g-meta">0 tokens</div><div class="verdict" id="g-verdict"></div></div></section>
</div>
<footer><div class="score" id="score">Cerebras <span class="c">0</span> · GPU speed <span class="g">0</span></div>
<div class="note" id="note">Each clock starts at that lane's first token; queue time is not counted.</div></footer>
</div>
<script>
const $ = (id) => document.getElementById(id);
const CPT = 2.95;
const GLYPH = {k:"♚",q:"♛",r:"♜",b:"♝",n:"♞",p:"♟"};
let state = null, score = {c:0,g:0,n:0}, raf = 0;

function drawBoard(fen, mv){
  const rows = fen.split(" ")[0].split("/"); const flip = fen.split(" ")[1] === "b";
  const cells = [];
  rows.forEach((row, r) => { let f = 0; for (const ch of row) {
    if (/\\d/.test(ch)) { for (let i = 0; i < +ch; i++) cells.push({r, f: f++, p: null}); }
    else cells.push({r, f: f++, p: ch}); } });
  if (flip) cells.reverse();
  const b = $("board"); b.replaceChildren();
  for (const c of cells) {
    const d = document.createElement("div"); const sq = "abcdefgh"[c.f] + (8 - c.r);
    d.className = "sq " + ((c.r + c.f) % 2 ? "d" : "l");
    if (mv && sq === mv.slice(0,2)) d.classList.add("from");
    if (mv && sq === mv.slice(2,4)) d.classList.add("to");
    if (c.p) { const s = document.createElement("span"); s.textContent = GLYPH[c.p.toLowerCase()];
      s.className = c.p === c.p.toUpperCase() ? "pw" : "pb"; d.append(s); }
    b.append(d);
  }
}
function fmt(s){ return Math.max(0, s).toFixed(1); }
function tail(text){ return text.length > 2600 ? text.slice(-2600) : text; }

function showScore(c, g, n){
  $("score").innerHTML = "Cerebras <span class=c>" + c + "</span> · GPU speed <span class=g>" + g + "</span> <span style='color:var(--soft);font-weight:500;font-size:17px'>of " + n + " solved</span>";
}
function onEvent(e){
  // The race's own total, for a page that joined part-way.
  if (e.type === "score") { showScore(e.cerebras, e.gpu, e.of); return; }
  // A page opened mid-puzzle waits for the next one.
  if (!state && e.type !== "puzzle") return;
  if (e.type === "puzzle") {
    cancelAnimationFrame(raf);
    state = {p: e.puzzle, clock: e.clockS, rate: e.gpuTokensPerS, text: "", first: null, result: null};
    $("g-src").textContent = "the Cerebras tokens, replayed at " + e.gpuTokensPerS + " tok/s (rate measured on a GPU host)";
    $("task").innerHTML = "Puzzle " + (e.index+1) + " of " + e.total + " · <b>" + (e.puzzle.fen.split(" ")[1]==="w"?"White":"Black") + " mates in 2</b> · rated " + e.puzzle.rating;
    drawBoard(e.puzzle.fen, null);
    for (const k of ["c","g"]) { $(k+"-clock").textContent = fmt(e.clockS); $(k+"-think").textContent = "";
      $(k+"-meta").textContent = "0 tokens"; $(k+"-verdict").textContent = ""; $(k+"-verdict").className = "verdict"; }
    $("queue").textContent = "";
  } else if (e.type === "queue") {
    $("queue").textContent = "Cerebras queue is full (HTTP 429), retry " + e.attempt + " · clocks not started";
  } else if (e.type === "first-token") {
    $("queue").textContent = ""; state.first = performance.now(); tick();
  } else if (e.type === "delta") {
    state.text += e.delta.text;
  } else if (e.type === "result") {
    state.result = e.result;
  }
}
function verdict(k, lane, label){
  const v = $(k+"-verdict");
  if (!lane.answered) { v.textContent = "TIME · no answer"; v.className = "verdict bad"; return; }
  v.textContent = (lane.solved ? "✓ " : "✗ ") + lane.move + " in " + lane.seconds.toFixed(1) + " s";
  v.className = "verdict " + (lane.solved ? "ok" : "bad");
}
function tick(){
  const s = state; if (!s || s.first === null) return;
  const t = (performance.now() - s.first) / 1000; const r = s.result;
  // Cerebras lane: the live text, its clock until it answers or runs out.
  const cDone = r && (r.cerebras.answered ? t >= r.cerebras.seconds : true);
  $("c-clock").textContent = fmt(s.clock - (cDone ? (r.cerebras.answered ? r.cerebras.seconds : s.clock) : Math.min(t, s.clock)));
  $("c-think").textContent = tail(s.text);
  $("c-meta").textContent = Math.round((r && cDone ? r.cerebras.tokens : s.text.length / CPT)).toLocaleString() + " tokens";
  if (cDone && !$("c-verdict").textContent) { verdict("c", r.cerebras); if (r.cerebras.answered) drawBoard(s.p.fen, r.cerebras.move); }
  // GPU lane: the same text, revealed at the measured GPU rate, until the same clock.
  const gt = Math.min(t, s.clock); const gChars = Math.floor(gt * s.rate * CPT);
  $("g-think").textContent = tail(s.text.slice(0, gChars));
  const gDone = r && (r.gpu.answered ? t >= r.gpu.neededS : t >= s.clock);
  $("g-clock").textContent = fmt(s.clock - (gDone ? (r.gpu.answered ? r.gpu.neededS : s.clock) : gt));
  $("g-meta").textContent = Math.round(Math.min(gt * s.rate, r ? r.cerebras.tokens : Infinity)).toLocaleString() + " tokens";
  if (gDone && !$("g-verdict").textContent) verdict("g", r.gpu);
  if (cDone && gDone) {
    score.n++; if (r.cerebras.solved) score.c++; if (r.gpu.solved) score.g++;
    showScore(score.c, score.g, score.n);
    return;
  }
  raf = requestAnimationFrame(tick);
}

const params = new URLSearchParams(location.search);
const run = params.get("run");
if (run) replay(run); else { const es = new EventSource("/think-fast/events"); es.onmessage = (m) => onEvent(JSON.parse(m.data)); }

// Replays a saved run with its recorded timings: each puzzle's deltas at their own times.
async function replay(file){
  const data = await (await fetch("/think-fast/runs/" + encodeURIComponent(file))).json();
  $("c-src").textContent = "saved run, at its real token timings";
  $("note").textContent = "Replay of a recorded run (" + data.startedAt + "), at its real token timings. Queue time is not shown or counted.";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(+(new URLSearchParams(location.search).get("delay") || 1500));
  // ?only=<puzzle id> replays just that puzzle (numbered as in the full run).
  const only = new URLSearchParams(location.search).get("only");
  for (const [i, res] of data.results.entries()) {
    if (only && res.puzzle.id !== only) continue;
    onEvent({type:"puzzle", index:i, total:data.results.length, puzzle:res.puzzle, clockS:data.clockS, gpuTokensPerS:data.gpuTokensPerS});
    await wait(1200);
    onEvent({type:"first-token"});
    const t0 = performance.now();
    for (const d of res.deltas) { const due = d.t * 1000 - (performance.now() - t0); if (due > 0) await wait(due); onEvent({type:"delta", delta:d}); }
    const { deltas, ...summary } = res; onEvent({type:"result", result: summary});
    const end = Math.max(res.cerebras.seconds, res.gpu.answered ? res.gpu.neededS : data.clockS);
    const left = end * 1000 - (performance.now() - t0); if (left > 0) await wait(left);
    await wait(2500);
  }
}
</script></body></html>`;
