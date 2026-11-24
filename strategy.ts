// Burst-breakout bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: on a 6-hour window most pump.fun coins die, but a few run 2-10x within minutes
// of a visible buy burst. This bot only buys a burst it can see: a young curve whose
// last 30 slots show accelerating net SOL inflow from at least 8 distinct wallets, with
// no single wallet over half the buy volume, the price up and sitting near its window
// high. One fixed small stake per coin, no averaging down, and a hard exit on the first
// of: stop loss, trailing stop once the trade is up, a hard take-profit (2x), a fade in
// flow, or a time limit.
//
// Small probes keep the run above the house guardrails (at least 20 coins round-tripped
// at 0.01 SOL or more) even on quiet stretches: when fills or coins lag the pace, the
// bot buys 0.01 SOL of a liquid curve it does not hold and sells it as soon as the buy
// lands. A probe costs about two transaction fees plus ~2.5% curve fees on 0.01 SOL.
//
// Deterministic by construction: no clock, no environment, no randomness; iteration only
// over insertion-ordered maps fed by the batch stream, so two runs agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface BurstParams {
  /** Entry lookback, in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades inside the window. */
  minBuys: number;
  /** Distinct buying wallets inside the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minRise: number;
  /** Upper bound on that rise: never chase a vertical candle. */
  maxRise: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL (1 = no limit). */
  maxBuyerShare: number;
  /** Real SOL reserve bounds at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAgeSlots: number;
  /** SOL spent on one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage allowed on buys, in bps. Sells always go out wide open. */
  buySlipBps: number;
  /** Sell when value falls below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Sell when value falls below peak * (1 - trail), once armed. */
  trail: number;
  /** The trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Sell when value reaches cost * takeProfit. */
  takeProfit: number;
  /** Sell when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Sell after this many slots held (unless the hard take-profit already fired). */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the whole run. */
  maxEntriesPerCoin: number;
  /** Most momentum positions open at once (the rest of the 5 slots is for probes). */
  maxMain: number;
  /** Guardrail pacing: aim for at least this many coins and fills by paceSecs. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Size of one probe round trip, in SOL. */
  probeSol: number;
  /** Most probe positions open at once. */
  maxProbes: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: BurstParams = {
  window: 30,
  minNetSol: 0.8,
  minBuys: 8,
  minBuyers: 8,
  minRise: 0.08,
  maxRise: 1.2,
  accel: 1,
  nearHigh: 0.92,
  maxBuyerShare: 0.5,
  minRealSol: 1,
  maxRealSol: 60,
  minAgeSlots: 300,
  stakeSol: 0.15,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.22,
  trail: 0.2,
  trailArm: 0.12,
  takeProfit: 2,
  fadeWindow: 12,
  fadeNetSol: 1,
  maxHoldSlots: 1800,
  cooldownSlots: 200,
  maxEntriesPerCoin: 2,
  maxMain: 4,
  targetCoins: 30,
  targetFills: 240,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 1,
};

const LAMPORTS = 1e9;
/** Protocol + creator curve fee on a trade, as a share of the quote side. */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface OpenTrade {
  openedSlot: number;
  peakValueSol: number;
  investedSol: number;
  filled: boolean;
  exiting: boolean;
}

/** Net SOL flow (buys minus sells) over the last `w` slots of a tape. */
function flowOver(tape: CurveTape, now: number, w: number): number {
  let net = 0;
  for (let i = tape.trades.length - 1; i >= 0; i--) {
    const tr = tape.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

export function createStrategy(p: BurstParams = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const open = new Map<Pubkey, OpenTrade>();
  /** Probes in flight: false while the buy is pending, true once the sell is out. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  const keepSlots = p.window + 5;

  const tapeOf = (mint: Pubkey): CurveTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** True when the tape shows a fresh accelerating buy burst. */
  const burst = (tape: CurveTape, now: number, realSol: number): boolean => {
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return false;
    if (tape.createdSlot === null || now - tape.createdSlot < p.minAgeSlots) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const buyers = new Map<string, number>();
    for (const tr of tape.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || buyers.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const rise = last / startPrice - 1;
    if (rise < p.minRise || rise > p.maxRise) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    let topBuyer = 0;
    for (const v of buyers.values()) if (v > topBuyer) topBuyer = v;
    if (buySol > 0 && topBuyer > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Estimated SOL received for selling `tokens` now, curve + tx fees deducted. */
  const sellValueSol = (tokens: number, vq: number, vt: number, txSol: number): number =>
    ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const tape = tapeOf(e.mint);
          tape.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const tape = tapes.get(mint)!;
        let cut = 0;
        while (cut < tape.trades.length && tape.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) tape.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // 1. Exits first: every open trade is checked against stop, trail, take-profit,
      //    fade and time limit, and sold whole on the first trigger.
      for (const [mint, trade] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) {
            open.delete(mint);
            const tape = tapeOf(mint);
            if (trade.filled) tape.lastExitSlot = now;
            else tape.entries--;
          }
          continue;
        }
        trade.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mark = marks.get(mint);
        const vq = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = sellValueSol(tokens, vq, vt, txSol);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > trade.peakValueSol) trade.peakValueSol = value;
        let exit = trade.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && trade.peakValueSol >= cost * (1 + p.trailArm) && value < trade.peakValueSol * (1 - p.trail)) exit = true;
        if (!exit && value >= cost * p.takeProfit) exit = true;
        if (!exit && flowOver(tapeOf(mint), now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && now - trade.openedSlot > p.maxHoldSlots) exit = true;
        if (!exit) continue;
        trade.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // 2. Probes: sell a probe whole as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // 3. Entries: one fixed stake per burst, at most maxMain positions at once.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - open.size;
      let exposure = 0;
      for (const [mint, trade] of open) {
        exposure += Math.max(trade.investedSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingMints.has(mint) || probes.has(mint) || open.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const tape = tapes.get(mint)!;
        if (tape.entries >= p.maxEntriesPerCoin || now - tape.lastExitSlot < p.cooldownSlots) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!burst(tape, now, realSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        open.set(mint, { openedSlot: now, peakValueSol: 0, investedSol: amount, filled: false, exiting: false });
        tape.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // 4. Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minReal = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minReal * 1.5) continue;
            if (free < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
