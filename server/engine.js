// The agent runtime: ingests wallets, trains per-user agents and the Grand Chud,
// and runs every agent's paper portfolio against the market.
// PAPER ONLY. There is no code path here that signs or sends a transaction.
import crypto from 'node:crypto';
import { getDb, save } from './store.js';
import { market, MARKET } from './market.js';
import { fetchSwaps, toRoundTrips, demoRoundTrips, demoPersona, historySource } from './history.js';
import { stats, diagnose, backtest, fit, replay, skill, describePolicy, defaultPolicy } from './analyzer.js';
import { median, clamp, short } from './util.js';

const START_SOL = 10;
const CALLSIGNS = ['GLOWWORM', 'BASILISK', 'NULLPTR', 'GREMLIN', 'VOIDCAT', 'SPECTRE', 'MOTHMAN', 'KILOBYTE', 'WRAITH', 'HEXBUG', 'PHOSPHOR', 'GHOUL'];

// ---------- wallets ----------
export async function ingestWallet(address, { verified = false, demo = false, agent = false } = {}) {
  const db = getDb();
  let trips, source;
  const live = !demo && historySource() === 'helius';
  if (live) {
    const swaps = await fetchSwaps(address);
    const rt = toRoundTrips(swaps);
    trips = rt.closed; source = 'helius';
    var open = rt.open; var lastTs = swaps.length ? swaps[swaps.length - 1].ts : 0;
  } else {
    const rt = demoRoundTrips(address); trips = rt.closed; open = rt.open; source = 'demo'; lastTs = Date.now();
  }
  const s = stats(trips);
  const prev = db.wallets[address];
  const w = db.wallets[address] = {
    address, verified: verified || prev?.verified || false, demo: source === 'demo', source,
    addedAt: prev?.addedAt || Date.now(), syncedAt: Date.now(), lastSwapTs: lastTs,
    trips, open, stats: s, diagnoses: diagnose(s), skill: skill(trips),
    backtest: trips.length >= 12 ? backtest(trips) : null,
    recentBuys: prev?.recentBuys || [],
    persona: source === 'demo' ? demoPersona(address) : undefined,
  };
  if (agent || db.agents[address]) upsertAgent(w);
  retrainGrand();
  save();
  return w;
}

function upsertAgent(w) {
  const db = getDb();
  const h = crypto.createHash('sha256').update(w.address).digest('hex');
  const a = db.agents[w.address] ||= {
    owner: w.address, id: `CHUD-${h.slice(0, 4).toUpperCase()}`, callsign: CALLSIGNS[parseInt(h.slice(4, 6), 16) % CALLSIGNS.length],
    createdAt: Date.now(), status: 'running', portfolio: newPortfolio(), log: [],
  };
  a.policy = w.backtest?.policy || defaultPolicy();
  a.maxHoldH = clamp((w.stats.holdWinH || 2) * 2, 1, 48);
  a.policyText = describePolicy(a.policy);
  log(a, `policy loaded from ${w.stats.trades} trades: ${a.policyText}`, 'sys');
  return a;
}

const newPortfolio = () => ({ start: START_SOL, cash: START_SOL, positions: [], closed: [], equity: [[Date.now(), START_SOL]] });
function log(bot, msg, kind = 'info') { bot.log.unshift({ ts: Date.now(), msg, kind }); bot.log.length = Math.min(bot.log.length, 150); }

// ---------- grand chud ----------
export function retrainGrand() {
  const db = getDb();
  const ws = Object.values(db.wallets).filter((w) => w.trips.length >= 5);
  // normalise every wallet to unit size so whales don't drown out everyone else
  const pooled = ws.flatMap((w) => { const m = median(w.trips.map((t) => t.costSol)) || 1; return w.trips.map((t) => ({ ...t, costSol: t.costSol / m, pnlSol: t.pnlSol / m })); });
  const g = db.grand ||= { id: 'GRAND CHUD', createdAt: Date.now(), portfolio: newPortfolio(), log: [], status: 'running' };
  g.wallets = ws.length; g.trades = pooled.length; g.trainedAt = Date.now();
  if (pooled.length >= 12) {
    const bt = backtest(pooled);
    g.policy = bt.policy; g.backtest = bt.outOfSample;
  } else { g.policy = defaultPolicy(); g.backtest = null; }
  g.maxHoldH = clamp(median(ws.map((w) => w.stats.holdWinH || 2)) * 2 || 4, 1, 48);
  g.policyText = describePolicy(g.policy);
  g.weights = Object.fromEntries(ws.map((w) => [w.address, Math.max(0, w.skill)]));
  log(g, `retrained on ${ws.length} wallets / ${pooled.length} trades → ${g.policyText}`, 'sys');
}

function consensus() {
  const db = getDb(); const g = db.grand; const out = {};
  const cutoff = Date.now() - 6 * 36e5;
  for (const w of Object.values(db.wallets)) {
    const wt = g?.weights?.[w.address] || 0; if (wt <= 0) continue;
    for (const b of w.recentBuys || []) if (b.ts > cutoff) {
      const c = out[b.mint] ||= { mint: b.mint, symbol: b.symbol, score: 0, wallets: new Set() };
      if (!c.wallets.has(w.address)) { c.score += wt; c.wallets.add(w.address); }
    }
  }
  return Object.values(out).map((c) => ({ ...c, wallets: [...c.wallets] })).sort((a, b) => b.score - a.score);
}

// ---------- paper execution ----------
function slip(sizeSol, tok) { return clamp((sizeSol * market.solUsd) / Math.max(tok?.liquidityUsd || 1e4, 1) * 2, 0.005, 0.2) + 0.01; }

function buy(bot, tok, sizeSol, reason) {
  const pf = bot.portfolio;
  if (pf.cash < sizeSol || sizeSol < 0.01 || pf.positions.some((p) => p.mint === tok.mint)) return;
  const fill = tok.priceUsd * (1 + slip(sizeSol, tok));
  const qty = (sizeSol * market.solUsd) / fill;
  pf.cash -= sizeSol;
  pf.positions.push({ mint: tok.mint, symbol: tok.symbol, qty, entry: fill, cost: sizeSol, openedAt: Date.now(), peak: fill, tpHit: false, reason });
  market.pinned.add(tok.mint);
  log(bot, `BUY  ${tok.symbol.padEnd(8)} ${sizeSol.toFixed(2)} SOL @ $${fmtP(fill)}  [${reason}]`, 'buy');
}
function sell(bot, p, frac, price, why) {
  const pf = bot.portfolio; const tok = market.token(p.mint);
  const q = p.qty * frac; const gross = (q * price) / market.solUsd;
  const proceeds = gross * (1 - slip(gross, tok));
  const costPart = p.cost * frac;
  pf.cash += proceeds; p.qty -= q; p.cost -= costPart;
  const pnl = proceeds - costPart;
  pf.closed.unshift({ mint: p.mint, symbol: p.symbol, cost: costPart, proceeds, pnl, mult: proceeds / costPart, openedAt: p.openedAt, closedAt: Date.now(), why });
  pf.closed.length = Math.min(pf.closed.length, 200);
  log(bot, `SELL ${p.symbol.padEnd(8)} ${Math.round(frac * 100)}% → ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL (${(proceeds / costPart).toFixed(2)}x) [${why}]`, pnl >= 0 ? 'win' : 'loss');
  if (frac >= 0.999) pf.positions = pf.positions.filter((x) => x !== p);
  bot.streak = pnl < 0 ? (bot.streak || 0) + 1 : 0;
  if (bot.policy.cooldownAfter && bot.streak >= bot.policy.cooldownAfter) {
    bot.pausedUntil = Date.now() + bot.policy.cooldownH * 36e5; bot.streak = 0;
    log(bot, `tilt guard: ${bot.policy.cooldownAfter} losses in a row, cooling down ${bot.policy.cooldownH}h`, 'sys');
  }
}
const fmtP = (x) => (x < 0.001 ? x.toExponential(2) : x.toFixed(4));

function manage(bot) {
  const P = bot.policy;
  for (const p of [...bot.portfolio.positions]) {
    const tok = market.token(p.mint); const px = market.price(p.mint);
    if (px == null || tok?.dead) { if (tok?.dead || Date.now() - p.openedAt > 6 * 36e5) sell(bot, p, 1, (px ?? p.entry * 0.02), 'rugged/delisted'); continue; }
    p.peak = Math.max(p.peak, px); const m = px / p.entry;
    if (P.sl && m <= 1 - P.sl) { sell(bot, p, 1, px, `stop -${Math.round(P.sl * 100)}%`); continue; }
    if (P.tp && !p.tpHit && m >= P.tp) { p.tpHit = true; sell(bot, p, P.tpFrac || 1, px, `take-profit ${P.tp}x`); if ((P.tpFrac || 1) >= 1) continue; }
    if (p.tpHit && px < p.peak * 0.6) { sell(bot, p, 1, px, 'trailing stop'); continue; }
    if (!P.tp && m > 2 && px < p.peak * 0.65) { sell(bot, p, 1, px, 'trailing stop'); continue; }
    if ((Date.now() - p.openedAt) / 36e5 > (bot.maxHoldH || 6) && m < 1.2) sell(bot, p, 1, px, 'time stop');
  }
}

function equity(bot) {
  const pf = bot.portfolio;
  return pf.cash + pf.positions.reduce((s, p) => s + (p.qty * (market.price(p.mint) ?? 0)) / market.solUsd, 0);
}

function canEnter(bot) {
  if (bot.status !== 'running') return false;
  if (bot.pausedUntil && Date.now() < bot.pausedUntil) return false;
  if (bot.policy.badBuckets?.includes(Math.floor(new Date().getUTCHours() / 6))) return false;
  return bot.portfolio.positions.length < 6;
}
function size(bot, conviction = 1) {
  const eq = equity(bot); const cap = bot.policy.sizeCapX ? 0.06 * bot.policy.sizeCapX : 0.1;
  return +Math.min(bot.portfolio.cash * 0.9, eq * clamp(0.04 * conviction, 0.02, cap)).toFixed(3);
}

// Generic meme screener used when the agent scouts on its own.
function screen(t) {
  if (t.liquidityUsd < 12e3 || t.ageMin > 72 * 60) return 0;
  let s = 0;
  if (t.change5m > 2 && t.change5m < 40) s += 1;
  if (t.change1h > 10 && t.change1h < 300) s += 0.7;
  if ((t.buys1h || 0) > (t.sells1h || 0) * 1.2) s += 0.6;
  if (t.volume24h > t.liquidityUsd) s += 0.5;
  if (t.ageMin < 180) s += 0.3;
  return s;
}

// ---------- main loop ----------
let running = false;
export async function tick() {
  if (running) return; running = true;
  try {
    const db = getDb();
    await market.tick();
    await pollWalletActivity();
    const cands = market.candidates().map((t) => ({ t, s: screen(t) })).filter((x) => x.s >= 2).sort((a, b) => b.s - a.s);
    for (const a of Object.values(db.agents)) {
      manage(a);
      if (canEnter(a)) {
        const w = db.wallets[a.owner];
        const shadow = (w?.recentBuys || []).filter((b) => b.ts > (a.lastShadowTs || a.createdAt));
        for (const b of shadow) {
          a.lastShadowTs = b.ts; await market.ensure([b.mint]);
          const tok = market.token(b.mint);
          if (tok && !tok.dead) buy(a, tok, size(a, 1.2), `shadowing your buy`);
        }
        if (cands.length && Math.random() < 0.15) { const pick = cands[Math.floor(Math.random() * Math.min(3, cands.length))]; buy(a, pick.t, size(a, pick.s / 3), `scout score ${pick.s.toFixed(1)}`); }
      }
      sample(a);
    }
    const g = db.grand;
    if (g) {
      manage(g);
      g.consensus = consensus().slice(0, 10);
      if (canEnter(g)) {
        for (const c of g.consensus) {
          if (c.score < 0.5 || g.portfolio.positions.some((p) => p.mint === c.mint) || g.portfolio.closed.some((p) => p.mint === c.mint)) continue;
          await market.ensure([c.mint]); const tok = market.token(c.mint);
          if (tok && !tok.dead) buy(g, tok, size(g, 1 + c.score), `consensus ${c.wallets.length}w score ${c.score.toFixed(2)}`);
        }
        if (cands.length && Math.random() < 0.08) { const pick = cands[0]; if (pick.s >= 2.5) buy(g, pick.t, size(g, 0.8), `scout score ${pick.s.toFixed(1)}`); }
      }
      sample(g);
    }
    save();
  } catch (e) { console.error('[tick]', e); }
  finally { running = false; }
}
const BUST_SOL = 0.1; // under 1% of the starting 10 SOL there's nothing left to trade with
function sample(bot) {
  const eq = equity(bot); bot.equityNow = eq;
  if (!bot.busted && eq < BUST_SOL) {
    bot.busted = Date.now(); bot.status = 'rekt';
    log(bot, `ITS OVER. equity ${eq.toFixed(4)} SOL. agent is out of SOL and has stopped trading.`, 'loss');
  }
  const e = bot.portfolio.equity; if (!e.length || Date.now() - e[e.length - 1][0] > 60e3) { e.push([Date.now(), +eq.toFixed(4)]); if (e.length > 720) e.shift(); }
}

// Watch connected wallets for new buys (so agents can shadow and the Grand Chud can see consensus).
async function pollWalletActivity() {
  const db = getDb();
  for (const w of Object.values(db.wallets)) {
    w.recentBuys = (w.recentBuys || []).filter((b) => b.ts > Date.now() - 24 * 36e5);
    if (w.demo) {
      if (MARKET === 'sim' && w.persona) for (const b of market.simulateBuys(w.address, w.persona)) w.recentBuys.push(b);
      continue;
    }
    if (Date.now() - (w.polledAt || 0) < 3 * 6e4) continue;
    w.polledAt = Date.now();
    try {
      const swaps = await fetchSwaps(w.address, { maxPages: 1 });
      for (const s of swaps || []) if (s.side === 'buy' && s.ts > (w.lastSwapTs || 0)) w.recentBuys.push({ mint: s.mint, symbol: s.symbol || short(s.mint), ts: s.ts, sol: s.sol });
      if (swaps?.length) w.lastSwapTs = Math.max(w.lastSwapTs || 0, swaps[swaps.length - 1].ts);
    } catch (e) { console.warn('[poll]', short(w.address), e.message); }
  }
}

// ---------- views ----------
export function botView(b) {
  if (!b) return null;
  const pf = b.portfolio; const eq = equity(b);
  return {
    id: b.id, callsign: b.callsign, owner: b.owner, status: b.status, busted: b.busted || null, pausedUntil: b.pausedUntil, policy: b.policy, policyText: b.policyText, maxHoldH: b.maxHoldH,
    equity: eq, start: pf.start, pnl: eq - pf.start, cash: pf.cash,
    positions: pf.positions.map((p) => { const px = market.price(p.mint) ?? 0; const v = (p.qty * px) / market.solUsd; return { symbol: p.symbol, mint: p.mint, cost: p.cost, value: v, mult: p.cost ? v / p.cost : 0, ageMin: (Date.now() - p.openedAt) / 6e4, reason: p.reason, tpHit: p.tpHit }; }),
    closed: pf.closed.slice(0, 25), wins: pf.closed.filter((c) => c.pnl >= 0).length, losses: pf.closed.filter((c) => c.pnl < 0).length,
    equityCurve: pf.equity.map((e) => e[1]).concat([eq]), log: b.log.slice(0, 60),
    backtest: b.backtest, wallets: b.wallets, trades: b.trades, trainedAt: b.trainedAt, consensus: b.consensus,
  };
}
export function walletView(w) {
  if (!w) return null;
  const { trips, persona, ...rest } = w;
  return { ...rest, recentTrips: [...trips].sort((a, b) => b.exitTs - a.exitTs).slice(0, 30) };
}
export function leaderboard() {
  const db = getDb();
  const rows = Object.values(db.wallets).map((w) => {
    const a = db.agents[w.address];
    return { address: w.address, verified: w.verified, demo: w.demo, skill: w.skill, trades: w.stats.trades, winRate: w.stats.winRate, pnlSol: w.stats.pnlSol,
      oos: w.backtest?.outOfSample, agent: a ? { id: a.id, callsign: a.callsign, pnl: equity(a) - a.portfolio.start, busted: a.busted || null } : null };
  }).sort((x, y) => y.skill - x.skill);
  return { rows, grand: db.grand ? { pnl: equity(db.grand) - db.grand.portfolio.start, wallets: db.grand.wallets, busted: db.grand.busted || null } : null };
}
