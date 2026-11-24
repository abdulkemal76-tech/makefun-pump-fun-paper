[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/abdulkemal76-tech/makefun-pump-fun-paper/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/abdulkemal76-tech/makefun-pump-fun-paper/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Burst-Breakout Bot — Pump.fun Paper Sprint

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. One program (`main.ts`, Node 22, stdlib only) that the house replays on 6 hours of real pump.fun market data; highest net PnL wins.

## Strategy

Buy only a visible accelerating buy burst on a young bonding curve, and sell whole on the first exit trigger:

- **Entry:** curve at least 300 slots old, real SOL reserve 1–60, and over the last 30 slots: net buy inflow ≥ 0.8 SOL from at least 8 distinct buyers across ≥ 8 buy trades, no single wallet over 50% of the buy volume, price up 8–120% and sitting within 8% of its window high, with the newer half of the window inflowing faster than the older half.
- **Size:** one fixed 0.15 SOL stake per coin, at most 4 momentum positions open at once (max exposure 1 SOL).
- **Exits:** stop loss −22%, trailing stop −20% once +12% up, hard take-profit at 2x, flow fade (net outflow > 1 SOL over 12 slots), or a 1800-slot time limit.
- **Guardrails:** tiny 0.01 SOL probe round trips keep the run above the house minimums (20+ coins round-tripped) on quiet stretches.

The strategy was tuned by backtesting 40+ variants on the kit's dev window with the kit's offline simulator, picking a flat region rather than a single best cell: near breakeven on the dev slice (−0.005 SOL), 65 coins, 290 fills, max drawdown 2.8%.

## Layout

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the burst-breakout strategy.
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts` shim, vendored byte for byte.
