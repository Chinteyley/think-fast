---
name: think-fast
description: Race Kimi K3.1 Pro on Cerebras against GPU speed on real chess puzzles with the think_fast tool, when someone asks to race, benchmark speed, or "think fast".
---

# Think Fast

`think_fast` gives the same model (Kimi K3.1 Pro) the same clock on real Lichess mate-in-2
puzzles, once at Cerebras speed (a live stream) and once at a measured GPU speed (the same tokens
at that rate). A lane scores only if it answers inside the clock and the move forces mate.

1. Call `think_fast` once. Defaults: 5 puzzles, 20 s. Pass `count`, `start` or `clock_s` only
   when the person asks for them.
2. Tell the person to watch it live at `/think-fast` on this Gateway (the tool returns when the
   race ends; it can take a few minutes while Cerebras' queue is busy).
3. Reply with the tool's score line first, then one line per puzzle as the tool printed it, then
   the replay link. Do not add numbers the tool did not return.
