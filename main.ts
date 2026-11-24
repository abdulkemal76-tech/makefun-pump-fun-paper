// Burst-breakout bot for the pump.fun paper-trading replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the wire
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.
//
// Strategy in one line: buy only a visible accelerating buy burst on a young curve,
// one fixed 0.15 SOL stake per coin, and sell whole on the first of stop loss (-22%),
// trailing stop (-20% once +12% up), hard take-profit (2x), flow fade, or time limit.
// Tiny 0.01 SOL probe round trips keep the run above the house guardrails (20+ coins
// round-tripped) on quiet stretches. See strategy.ts for the full rules.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
