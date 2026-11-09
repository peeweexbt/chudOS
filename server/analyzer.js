// Studies round trips, diagnoses habits, and fits an exit/discipline policy
// by replaying the wallet's own trades under candidate rules.
import { median, mean, std, clamp, round } from './util.js';

const SLIP = 0.04; // stop fills ~4% worse than the trigger

export function stats(trips) {
  const t = [...trips].sort((a, b) => a.entryTs - b.entryTs);
  const wins = t.filter((x) => x.multiple >= 1), losses = t.filter((x) => x.multiple < 1);
  const pnl = t.reduce((s, x) => s + x.pnlSol, 0);
  const sizes = t.map((x) => x.costSol);
  // behaviour after a loss streak vs normal
  let streak = 0; const afterLoss = [], normal = [];
  for (const x of t) { (streak >= 2 ? afterLoss : normal).push(x); streak = x.multiple < 1 ? streak + 1 : 0; }
  const wr = (a) => (a.length ? a.filter((x) => x.multiple >= 1).length / a.length : 0);
  const buckets = [0, 1, 2, 3].map((b) => {
    const a = t.filter((x) => Math.floor(new Date(x.entryTs).getUTCHours() / 6) === b);
    return { bucket: b, label: `${String(b * 6).padStart(2, '0')}-${String(b * 6 + 6).padStart(2, '0')}h UTC`, n: a.length, winRate: wr(a), pnl: a.reduce((s, x) => s + x.pnlSol, 0) };
  });
  const days = t.length ? Math.max(1, (t[t.length - 1].entryTs - t[0].entryTs) / 864e5) : 1;
  return {
    trades: t.length, wins: wins.length, losses: losses.length, winRate: wr(t), pnlSol: pnl,
    volumeSol: sizes.reduce((s, x) => s + x, 0), medianSize: median(sizes),
    medWinMult: median(wins.map((x) => x.multiple)), medLossMult: median(losses.map((x) => x.multiple)),
    bestMult: Math.max(0, ...t.map((x) => x.multiple)), worstMult: t.length ? Math.min(...t.map((x) => x.multiple)) : 0,
    rugRate: t.length ? t.filter((x) => x.multiple < 0.1).length / t.length : 0,
    holdWinH: median(wins.map((x) => x.holdSec / 3600)), holdLossH: median(losses.map((x) => x.holdSec / 3600)),
    tilt: { afterLossN: afterLoss.length, afterLossWinRate: wr(afterLoss), normalWinRate: wr(normal),
      afterLossSize: median(afterLoss.map((x) => x.costSol)), normalSize: median(normal.map((x) => x.costSol)) },
    tradesPerDay: t.length / days, buckets,
  };
}

export function diagnose(s) {
  const d = [];
  if (!s.trades) return d;
  if (s.holdLossH > s.holdWinH * 2 && s.losses >= 5) d.push({ tag: 'BAG_HOLDER', text: `You hold losers ${(s.holdLossH / Math.max(s.holdWinH, 0.01)).toFixed(1)}x longer than winners.` });
  if (s.wins >= 5 && s.medWinMult < 1.6) d.push({ tag: 'PAPER_HANDS', text: `Median winner exits at ${s.medWinMult.toFixed(2)}x. You sell runners early.` });
  if (s.tilt.afterLossN >= 5 && s.tilt.afterLossWinRate < s.tilt.normalWinRate - 0.08) d.push({ tag: 'TILT', text: `After 2+ losses your win rate drops to ${pct(s.tilt.afterLossWinRate)} (vs ${pct(s.tilt.normalWinRate)}).` });
  if (s.tilt.afterLossN >= 5 && s.tilt.afterLossSize > s.tilt.normalSize * 1.3) d.push({ tag: 'REVENGE_SIZING', text: `You size up ${(s.tilt.afterLossSize / s.tilt.normalSize).toFixed(1)}x after losing streaks.` });
  if (s.rugRate > 0.1) d.push({ tag: 'RUG_MAGNET', text: `${pct(s.rugRate)} of trades ended -90% or worse.` });
  if (s.tradesPerDay > 8) d.push({ tag: 'OVERTRADER', text: `${s.tradesPerDay.toFixed(1)} trades/day.` });
  const bad = s.buckets.filter((b) => b.n >= 5 && b.pnl < 0 && b.winRate < s.winRate - 0.1);
  for (const b of bad) d.push({ tag: 'BAD_HOURS', text: `${b.label}: ${pct(b.winRate)} win rate, ${b.pnl.toFixed(2)} SOL.` });
  if (!d.length) d.push({ tag: 'CLEAN', text: 'No glaring leaks. Agent will focus on exits and sizing.' });
  return d;
}
const pct = (x) => `${Math.round(x * 100)}%`;

// Replay trades under a policy. Only uses facts we can know from the history:
// if the user's final exit was below the stop, price must have crossed it (unless
// it gapped through, i.e. a rug); if the exit was above the take-profit, price reached it.
export function replay(trips, policy, refSize) {
  const t = [...trips].sort((a, b) => a.entryTs - b.entryTs);
  let pnl = 0, taken = 0, wins = 0, streak = 0, pausedUntil = 0, eq = 0, peak = 0, dd = 0;
  const cap = policy.sizeCapX ? refSize * policy.sizeCapX : Infinity;
  for (const x of t) {
    if (x.entryTs < pausedUntil) continue;
    if (policy.badBuckets?.includes(Math.floor(new Date(x.entryTs).getUTCHours() / 6))) continue;
    const size = Math.min(x.costSol, cap);
    const m = exitMultiple(x.multiple, policy);
    const p = size * (m - 1);
    pnl += p; taken++; if (m >= 1) wins++;
    eq += p; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    streak = m < 1 ? streak + 1 : 0;
    if (policy.cooldownAfter && streak >= policy.cooldownAfter) { pausedUntil = x.exitTs + policy.cooldownH * 36e5; streak = 0; }
  }
  return { pnlSol: pnl, taken, skipped: t.length - taken, winRate: taken ? wins / taken : 0, maxDdSol: dd };
}
function exitMultiple(m, { tp, tpFrac, sl }) {
  if (sl && m <= 1 - sl && m >= 0.1) return (1 - sl) * (1 - SLIP); // stop would have fired on the way down
  if (tp && m >= tp) return tpFrac * tp * (1 - 0.01) + (1 - tpFrac) * m; // scale out at TP, ride the rest
  return m;
}

const GRID = (() => {
  const g = [];
  for (const tp of [null, 1.5, 2, 3, 5]) for (const tpFrac of tp ? [0.5, 1] : [0])
    for (const sl of [null, 0.25, 0.35, 0.5]) for (const cd of [[0, 0], [2, 6], [3, 12]])
      for (const sizeCapX of [null, 1, 1.5]) for (const hours of [false, true])
        g.push({ tp, tpFrac, sl, cooldownAfter: cd[0], cooldownH: cd[1], sizeCapX, useBadHours: hours });
  return g;
})();

export function fit(trips, { minTrades = 12 } = {}) {
  const t = [...trips].sort((a, b) => a.entryTs - b.entryTs);
  const refSize = median(t.map((x) => x.costSol)) || 1;
  if (t.length < minTrades) return { policy: defaultPolicy(), note: 'not enough trades, using defaults', refSize };
  const badBuckets = stats(t).buckets.filter((b) => b.n >= 5 && b.pnl < 0 && b.winRate < stats(t).winRate - 0.1).map((b) => b.bucket);
  const score = (r) => r.pnlSol - 0.5 * r.maxDdSol;
  let best = null;
  for (const g of GRID) {
    const p = { ...g, badBuckets: g.useBadHours ? badBuckets : [] };
    const r = replay(t, p, refSize);
    if (!best || score(r) > best.s) best = { p, s: score(r), r };
  }
  return { policy: best.p, refSize, fitResult: best.r };
}

// Walk-forward: learn on the first 60%, grade on the last 40% (never seen).
export function backtest(trips) {
  const t = [...trips].sort((a, b) => a.entryTs - b.entryTs);
  const cut = Math.floor(t.length * 0.6);
  const train = t.slice(0, cut), test = t.slice(cut);
  const { policy, refSize } = fit(train);
  const you = test.reduce((s, x) => s + x.pnlSol, 0);
  const agent = replay(test, policy, refSize);
  const full = fit(t);
  return {
    outOfSample: { trades: test.length, youPnl: you, youWinRate: test.length ? test.filter((x) => x.multiple >= 1).length / test.length : 0, agentPnl: agent.pnlSol, agentWinRate: agent.winRate, agentSkipped: agent.skipped },
    policy: full.policy, refSize: full.refSize, inSample: full.fitResult,
  };
}

export function defaultPolicy() {
  return { tp: 2, tpFrac: 0.5, sl: 0.35, cooldownAfter: 3, cooldownH: 6, sizeCapX: 1, useBadHours: false, badBuckets: [] };
}

// Skill score: risk-adjusted per-trade edge, shrunk toward 0 for small samples.
export function skill(trips) {
  if (trips.length < 5) return 0;
  const r = trips.map((x) => clamp(Math.log(Math.max(x.multiple, 0.01)), -3, 3));
  return round(clamp((mean(r) / (std(r) || 1)) * Math.sqrt(trips.length) / 3, -3, 3), 3);
}

export function describePolicy(p) {
  const parts = [];
  parts.push(p.tp ? `take ${Math.round(p.tpFrac * 100)}% at ${p.tp}x` : 'no fixed take-profit');
  parts.push(p.sl ? `stop at -${Math.round(p.sl * 100)}%` : 'no stop');
  if (p.cooldownAfter) parts.push(`pause ${p.cooldownH}h after ${p.cooldownAfter} losses`);
  if (p.sizeCapX) parts.push(`cap size at ${p.sizeCapX}x median`);
  if (p.badBuckets?.length) parts.push(`skip ${p.badBuckets.map((b) => `${b * 6}-${b * 6 + 6}h`).join(', ')} UTC`);
  return parts.join(' · ');
}
