// The agent runtime: ingests wallets, trains per-user agents and the Grand Chud,
// and runs every agent's book against the market. Paper by default; see ./live.js for mainnet.
import crypto from 'node:crypto';
import { getDb, save } from './store.js';
import { market, MARKET } from './market.js';
import { fetchSwaps, toRoundTrips, demoRoundTrips, demoPersona, historySource } from './history.js';
import { stats, diagnose, backtest, fit, replay, skill, describePolicy, defaultPolicy } from './analyzer.js';
import { median, clamp, short } from './util.js';
import * as live from './live.js';

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

// ---------- execution ----------
// Paper books simulate fills. Live books (Grand Chud with LIVE on) hit mainnet via ./live.js.
// User agents never sign: when their owner has opted in, the agent files proposals the owner signs in Phantom.
function slip(sizeSol, tok) { return clamp((sizeSol * market.solUsd) / Math.max(tok?.liquidityUsd || 1e4, 1) * 2, 0.005, 0.2) + 0.01; }
function logOnce(bot, key, msg, kind = 'sys') {
  bot._once ||= {}; if (bot._once[key] && Date.now() - bot._once[key] < 10 * 6e4) return;
  bot._once[key] = Date.now(); log(bot, msg, kind);
}

async function buy(bot, tok, sizeSol, reason) {
  const pf = bot.portfolio;
  if (pf.positions.some((p) => p.mint === tok.mint)) return;
  if (pf.live) return liveBuy(bot, tok, sizeSol, reason);
  if (pf.cash < sizeSol || sizeSol < 0.01) return;
  const fill = tok.priceUsd * (1 + slip(sizeSol, tok));
  const qty = (sizeSol * market.solUsd) / fill;
  pf.cash -= sizeSol;
  pf.positions.push({ mint: tok.mint, symbol: tok.symbol, qty, entry: fill, cost: sizeSol, openedAt: Date.now(), peak: fill, tpHit: false, reason });
  market.pinned.add(tok.mint);
  log(bot, `BUY  ${tok.symbol.padEnd(8)} ${sizeSol.toFixed(2)} SOL @ $${fmtP(fill)}  [${reason}]`, 'buy');
  if (bot.liveBook?.enabled) proposeBuy(bot, tok, reason);
}
async function sell(bot, p, frac, price, why) {
  const pf = bot.portfolio;
  if (pf.live) return liveSell(bot, p, frac, why);
  const tok = market.token(p.mint);
  const gross = (p.qty * frac * price) / market.solUsd;
  bookSale(bot, pf, p, frac, gross * (1 - slip(gross, tok)), why);
}
function bookSale(bot, pf, p, frac, proceeds, why, extra = {}) {
  const costPart = p.cost * frac;
  pf.cash = (pf.cash || 0) + proceeds; p.qty -= p.qty * frac; p.cost -= costPart;
  const pnl = proceeds - costPart;
  pf.closed.unshift({ mint: p.mint, symbol: p.symbol, cost: costPart, proceeds, pnl, mult: costPart ? proceeds / costPart : 0, openedAt: p.openedAt, closedAt: Date.now(), why, ...extra });
  pf.closed.length = Math.min(pf.closed.length, 200);
  log(bot, `${extra.sig ? 'LIVE ' : ''}SELL ${p.symbol.padEnd(8)} ${Math.round(frac * 100)}% → ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${(costPart ? proceeds / costPart : 0).toFixed(2)}x) [${why}]${extra.sig ? ` tx ${short(extra.sig)}` : ''}`, pnl >= 0 ? 'win' : 'loss');
  if (frac >= 0.999) pf.positions = pf.positions.filter((x) => x !== p);
  if (pf !== bot.portfolio) return; // tilt guard tracks the agent's main book
  bot.streak = pnl < 0 ? (bot.streak || 0) + 1 : 0;
  if (bot.policy.cooldownAfter && bot.streak >= bot.policy.cooldownAfter) {
    bot.pausedUntil = Date.now() + bot.policy.cooldownH * 36e5; bot.streak = 0;
    log(bot, `tilt guard: ${bot.policy.cooldownAfter} losses in a row, cooling down ${bot.policy.cooldownH}h`, 'sys');
  }
}
const fmtP = (x) => (x < 0.001 ? x.toExponential(2) : x.toFixed(4));

// ---- live books: Grand Chud (its own wallet) and automatic agent wallets. server-signed, capped ----
const isGrand = (bot) => bot === getDb().grand;
const riskKey = (bot) => (isGrand(bot) ? 'grand' : bot.owner);
const signer = (bot) => (isGrand(bot) ? live.grandKeypair() : live.agentKeypair(bot.owner, bot.wallet));
async function liveBuy(g, tok, sizeSol, reason) {
  const pf = g.portfolio;
  if (!g.liveOn) return;
  if (!isGrand(g) && !live.mayAutoTrade(g.owner)) return logOnce(g, 'allow', 'live buying blocked: wallet is no longer on the invite list');
  g._fail ||= {}; if (Date.now() - (g._fail[tok.mint] || 0) < 15 * 6e4) return; // don't hammer a token that just failed
  sizeSol = +Math.min(sizeSol, live.CFG.maxTradeSol).toFixed(4);
  const err = live.checkBuy(riskKey(g), sizeSol, tok, pf.positions.length);
  if (err) return logOnce(g, `skip:${tok.mint}:${err.slice(0, 12)}`, `skip live buy ${tok.symbol}: ${err}`);
  live.reserveSpend(riskKey(g), sizeSol);
  log(g, `LIVE BUY ${tok.symbol} ${sizeSol} SOL → sending [${reason}]`, 'sys');
  try {
    const r = await live.swapBuy(signer(g), tok.mint, sizeSol);
    pf.tradeDelta = (pf.tradeDelta || 0) - r.cost;
    if (!(r.qty > 0)) throw new Error('swap confirmed but no tokens received');
    const entry = (r.cost * market.solUsd) / r.qty;
    pf.positions.push({ mint: tok.mint, symbol: tok.symbol, qty: r.qty, entry, cost: r.cost, openedAt: Date.now(), peak: entry, tpHit: false, reason, sig: r.sig });
    market.pinned.add(tok.mint);
    log(g, `LIVE BUY ${tok.symbol.padEnd(8)} ${r.cost.toFixed(4)} SOL @ $${fmtP(entry)} tx ${short(r.sig)}`, 'buy');
  } catch (e) { live.releaseSpend(riskKey(g), sizeSol); g._fail[tok.mint] = Date.now(); log(g, `live buy ${tok.symbol} failed: ${e.message} (skipping it for 15 min)`, 'loss'); }
}
async function liveSell(g, p, frac, why) {
  if (p.selling) return; p.selling = true;
  try {
    const r = await live.swapSell(signer(g), p.mint, frac);
    g.portfolio.tradeDelta = (g.portfolio.tradeDelta || 0) + r.proceeds;
    if (!r.sig) { log(g, `${p.symbol}: wallet holds none, dropping position`, 'sys'); g.portfolio.positions = g.portfolio.positions.filter((x) => x !== p); return; }
    bookSale(g, g.portfolio, p, frac, r.proceeds, why, { sig: r.sig });
  } catch (e) { log(g, `live sell ${p.symbol} failed: ${e.message} (will retry)`, 'loss'); if (p.tpHit && why.startsWith('take-profit')) p.tpHit = false; }
  finally { p.selling = false; }
}

// ---- user agents: proposals the owner approves in Phantom ----
const pid = () => crypto.randomBytes(5).toString('hex');
function proposeBuy(a, tok, reason) {
  const L = a.liveBook;
  if (L.positions.some((p) => p.mint === tok.mint) || L.proposals.some((x) => x.mint === tok.mint && isOpen(x))) return;
  const sizeSol = +Math.min(L.tradeSol || live.CFG.maxTradeSol, live.CFG.maxTradeSol).toFixed(4);
  const openBuys = L.proposals.filter((x) => x.side === 'buy' && isOpen(x)).length;
  const err = live.checkBuy(a.owner, sizeSol, tok, L.positions.length + openBuys);
  if (err) return logOnce(a, `skip:${tok.mint}`, `no live proposal for ${tok.symbol}: ${err}`);
  L.proposals.unshift({ id: pid(), side: 'buy', mint: tok.mint, symbol: tok.symbol, sizeSol, reason, priceUsd: tok.priceUsd, createdAt: Date.now(), expiresAt: Date.now() + 120e3, status: 'pending' });
  log(a, `PROPOSE LIVE BUY ${tok.symbol} ${sizeSol} SOL. approve it in the LIVE panel within 2 min`, 'sys');
  trimProposals(L);
}
function proposeSellFor(a) {
  return async (p, frac, price, why) => {
    const L = a.liveBook;
    if (L.proposals.some((x) => x.mint === p.mint && x.side === 'sell' && isOpen(x))) return;
    L.proposals.unshift({ id: pid(), side: 'sell', mint: p.mint, symbol: p.symbol, frac, qty: p.qty, reason: why, priceUsd: price, createdAt: Date.now(), expiresAt: Date.now() + 120e3, status: 'pending', tp: why.startsWith('take-profit') });
    log(a, `PROPOSE LIVE SELL ${p.symbol} ${Math.round(frac * 100)}% [${why}]. approve it in the LIVE panel`, 'sys');
    trimProposals(L);
  };
}
const isOpen = (x) => ['pending', 'built', 'submitted'].includes(x.status);
function trimProposals(L) { L.proposals = L.proposals.filter((x, i) => isOpen(x) || i < 30); }

async function settleProposals(a) {
  const L = a.liveBook; if (!L) return;
  for (const x of L.proposals) {
    if ((x.status === 'pending' || x.status === 'built') && Date.now() > x.expiresAt) {
      x.status = 'expired';
      if (x.side === 'buy' && x.reserved) live.releaseSpend(a.owner, x.sizeSol);
      if (x.tp) { const p = L.positions.find((q) => q.mint === x.mint); if (p) p.tpHit = false; }
      continue;
    }
    if (x.status !== 'submitted') continue;
    let st; try { st = await live.sigStatus(x.sig); } catch (e) { continue; }
    if (st === 'pending') { if (Date.now() - x.submittedAt > 180e3) { x.status = 'failed'; x.error = 'not confirmed after 3 min'; if (x.side === 'buy') live.releaseSpend(a.owner, x.sizeSol); } continue; }
    if (st === 'failed') { x.status = 'failed'; x.error = 'transaction failed on-chain'; if (x.side === 'buy') live.releaseSpend(a.owner, x.sizeSol); log(a, `live ${x.side} ${x.symbol} failed on-chain`, 'loss'); continue; }
    // confirmed
    if (x.side === 'buy') {
      let qty = 0; try { qty = (await live.tokenBalance(a.owner, x.mint)).ui - (x.beforeUi || 0); } catch {}
      if (!(qty > 0)) { x.tries = (x.tries || 0) + 1; if (x.tries < 5) continue; qty = (+x.quote.outAmount || 0) / 1e6; }
      const cost = (+x.quote.inAmount || x.sizeSol * 1e9) / 1e9; const entry = (cost * market.solUsd) / qty;
      L.positions.push({ mint: x.mint, symbol: x.symbol, qty, entry, cost, openedAt: Date.now(), peak: entry, tpHit: false, reason: x.reason, sig: x.sig });
      market.pinned.add(x.mint);
      log(a, `LIVE BUY ${x.symbol} confirmed: ${cost.toFixed(4)} SOL, tx ${short(x.sig)}`, 'buy');
    } else {
      const p = L.positions.find((q) => q.mint === x.mint);
      if (p) bookSale(a, L, p, Math.min(1, x.qtyUi / p.qty || x.frac), (+x.quote.outAmount || 0) / 1e9, x.reason, { sig: x.sig });
    }
    x.status = 'done';
  }
}
export function liveBookView(L) {
  if (!L) return null;
  const val = (p) => ((p.qty * (market.price(p.mint) ?? 0)) / market.solUsd);
  return { enabled: !!L.enabled, tradeSol: L.tradeSol, realized: L.closed.reduce((s, c) => s + c.pnl, 0),
    positions: L.positions.map((p) => ({ symbol: p.symbol, mint: p.mint, cost: p.cost, value: val(p), mult: p.cost ? val(p) / p.cost : 0, ageMin: (Date.now() - p.openedAt) / 6e4, sig: p.sig })),
    proposals: L.proposals.slice(0, 12).map(({ quote, ...x }) => x), closed: L.closed.slice(0, 15),
    spentToday: live.ledger(L.key || '').spent };
}

async function manage(bot, positions = bot.portfolio.positions, sellFn = (p, f, px, why) => sell(bot, p, f, px, why)) {
  const P = bot.policy;
  for (const p of [...positions]) {
    const tok = market.token(p.mint); const px = market.price(p.mint);
    if (px == null || tok?.dead) { if (tok?.dead || Date.now() - p.openedAt > 6 * 36e5) await sellFn(p, 1, (px ?? p.entry * 0.02), 'rugged/delisted'); continue; }
    p.peak = Math.max(p.peak, px); const m = px / p.entry;
    if (P.sl && m <= 1 - P.sl) { await sellFn(p, 1, px, `stop -${Math.round(P.sl * 100)}%`); continue; }
    if (P.tp && !p.tpHit && m >= P.tp) { p.tpHit = true; await sellFn(p, P.tpFrac || 1, px, `take-profit ${P.tp}x`); if ((P.tpFrac || 1) >= 1) continue; }
    if (p.tpHit && px < p.peak * 0.6) { await sellFn(p, 1, px, 'trailing stop'); continue; }
    if (!P.tp && m > 2 && px < p.peak * 0.65) { await sellFn(p, 1, px, 'trailing stop'); continue; }
    if ((Date.now() - p.openedAt) / 36e5 > (bot.maxHoldH || 6) && m < 1.2) await sellFn(p, 1, px, 'time stop');
  }
}

function equity(bot) {
  const pf = bot.portfolio;
  return pf.cash + pf.positions.reduce((s, p) => s + (p.qty * (market.price(p.mint) ?? 0)) / market.solUsd, 0);
}

function canEnter(bot) {
  if (bot.status !== 'running') return false;
  if (bot.portfolio.live && (!bot.liveOn || live.riskState().killed)) return false;
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
      if (a.portfolio.live) await refreshLiveCash(a);
      else if (a.wallet && Date.now() - (a.walletBalAt || 0) > 60e3) { a.walletBalAt = Date.now(); live.solBalance(a.wallet.pub).then((b) => { a.walletBal = b; }).catch(() => {}); }
      await manage(a);
      if (a.liveBook) {
        a.liveBook.key = a.owner;
        await settleProposals(a);
        if (a.liveBook.positions.length) { await market.ensure(a.liveBook.positions.map((p) => p.mint)); await manage(a, a.liveBook.positions, proposeSellFor(a)); }
      }
      if (canEnter(a)) {
        const w = db.wallets[a.owner];
        const shadow = (w?.recentBuys || []).filter((b) => b.ts > (a.lastShadowTs || a.createdAt));
        for (const b of shadow) {
          a.lastShadowTs = b.ts; await market.ensure([b.mint]);
          const tok = market.token(b.mint);
          if (tok && !tok.dead) await buy(a, tok, size(a, 1.2), `shadowing your buy`);
        }
        if (cands.length && Math.random() < 0.15) { const pick = cands[Math.floor(Math.random() * Math.min(3, cands.length))]; await buy(a, pick.t, size(a, pick.s / 3), `scout score ${pick.s.toFixed(1)}`); }
      }
      sample(a);
      if (a.portfolio.live) live.checkDrawdown(a.owner, equity(a) + live.CFG.feeReserveSol, (why) => { a.liveOn = false; log(a, `DRAWDOWN STOP: ${why}. live buying off; open positions still managed.`, 'loss'); });
    }
    const g = db.grand;
    if (g) {
      if (g.portfolio.live) await refreshLiveCash(g);
      await manage(g);
      g.consensus = consensus().slice(0, 10);
      if (canEnter(g)) {
        for (const c of g.consensus) {
          if (c.score < 0.5 || g.portfolio.positions.some((p) => p.mint === c.mint) || g.portfolio.closed.some((p) => p.mint === c.mint)) continue;
          await market.ensure([c.mint]); const tok = market.token(c.mint);
          if (tok && !tok.dead) await buy(g, tok, size(g, 1 + c.score), `consensus ${c.wallets.length}w score ${c.score.toFixed(2)}`);
        }
        if (cands.length && Math.random() < 0.08) { const pick = cands[0]; if (pick.s >= 2.5) await buy(g, pick.t, size(g, 0.8), `scout score ${pick.s.toFixed(1)}`); }
      }
      sample(g);
      if (g.portfolio.live) live.checkDrawdown('grand', equity(g) + live.CFG.feeReserveSol);
    }
    save();
  } catch (e) { console.error('[tick]', e); }
  finally { running = false; }
}
// Pull the wallet's SOL balance. Anything not explained by our own trades is a deposit/withdrawal
// and moves the starting balance instead of showing up as profit or loss.
async function refreshLiveCash(bot) {
  const pf = bot.portfolio;
  try {
    const addr = isGrand(bot) ? live.grandAddress() : bot.wallet.pub;
    const bal = await live.solBalance(addr);
    if (pf.lastBal != null) {
      const external = (bal - pf.lastBal) - (pf.tradeDelta || 0);
      if (Math.abs(external) > 0.002) {
        pf.start += external; const l = live.ledger(riskKey(bot)); if (l.startEquity != null) l.startEquity += external;
        log(bot, `${external > 0 ? 'deposit' : 'withdrawal'} detected: ${external > 0 ? '+' : ''}${external.toFixed(4)} SOL`, 'sys');
      }
    }
    pf.lastBal = bal; pf.tradeDelta = 0;
    // never trade more than MAX_AGENT_SOL from a user's agent wallet
    const usable = isGrand(bot) ? bal : Math.min(bal, live.CFG.maxAgentSol);
    pf.cash = Math.max(0, usable - live.CFG.feeReserveSol);
  } catch (e) { logOnce(bot, 'bal', `balance read failed: ${e.message}`); }
  await market.ensure(pf.positions.map((p) => p.mint));
}

const BUST_SOL = 0.1; // paper: under 1% of the starting 10 SOL there's nothing left to trade with
function sample(bot) {
  const eq = equity(bot); bot.equityNow = eq;
  const floor = bot.portfolio.live ? bot.portfolio.start * 0.1 : BUST_SOL;
  if (!bot.busted && eq < floor && !bot.portfolio.positions.length) {
    bot.busted = Date.now(); bot.status = 'rekt';
    log(bot, `ITS OVER. equity ${eq.toFixed(4)} SOL. agent is out of SOL and has stopped trading.`, 'loss');
  }
  const e = bot.portfolio.equity; if (!e.length || Date.now() - e[e.length - 1][0] > 60e3) { e.push([Date.now(), +eq.toFixed(4)]); if (e.length > 720) e.shift(); }
}

// ---------- live controls (called from the API) ----------
export async function setGrandLive(on) {
  const g = getDb().grand;
  if (on) {
    if (!live.CFG.enabled) throw new Error('LIVE_TRADING is not enabled on the server');
    if (!live.grandAddress()) throw new Error('GRAND_SECRET_KEY is not set');
    if (!g.portfolio.live) {
      const bal = await live.solBalance(live.grandAddress());
      if (bal < 0.05) throw new Error(`Grand Chud wallet ${live.grandAddress()} only has ${bal} SOL. fund it first`);
      g.paperPortfolio = g.portfolio;
      g.portfolio = { live: true, start: bal, cash: Math.max(0, bal - live.CFG.feeReserveSol), positions: [], closed: [], equity: [[Date.now(), bal]] };
      g.busted = null; g.status = 'running';
    }
    g.liveOn = true; log(g, `LIVE MODE ON. wallet ${live.grandAddress()}`, 'sys');
  } else {
    g.liveOn = false;
    if (!g.portfolio.positions.length && g.portfolio.live) { g.livePortfolio = g.portfolio; g.portfolio = g.paperPortfolio || newPortfolio(); g.busted = null; g.status = 'running'; log(g, 'live mode off. back to paper.', 'sys'); }
    else log(g, 'live buying off. existing live positions will still be managed and sold.', 'sys');
  }
  save();
}
// ---- automatic agent wallets ----
export function ensureAgentWallet(owner) {
  const a = getDb().agents[owner]; if (!a) throw new Error('no agent');
  if (!a.wallet) { a.wallet = live.newAgentWallet(owner); log(a, `agent wallet created: ${a.wallet.pub}`, 'sys'); save(); }
  return a;
}
export async function setAutoLive(owner, on) {
  const a = getDb().agents[owner]; if (!a) throw new Error('no agent');
  if (on) {
    if (!live.CFG.enabled) throw new Error('live trading is disabled on this server');
    if (!live.custodyReady()) throw new Error('agent wallets are not configured on this server (MASTER_KEY)');
    if (!live.mayAutoTrade(owner)) throw new Error('your wallet is not on the invite list for automatic trading');
    ensureAgentWallet(owner);
    if (a.liveBook?.enabled) a.liveBook.enabled = false; // one live mode at a time
    if (!a.portfolio.live) {
      const bal = await live.solBalance(a.wallet.pub);
      if (bal < 0.05) throw new Error(`agent wallet has ${bal} SOL. deposit at least 0.05 SOL to ${a.wallet.pub} first`);
      a.paperPortfolio = a.portfolio;
      a.portfolio = { live: true, start: Math.min(bal, live.CFG.maxAgentSol), cash: 0, lastBal: null, positions: [], closed: [], equity: [[Date.now(), Math.min(bal, live.CFG.maxAgentSol)]] };
      a.busted = null; a.status = 'running';
    }
    const l = live.ledger(owner); l.tripped = false; l.startEquity = null; // fresh drawdown baseline each time auto is (re)started
    a.liveOn = true; log(a, `AUTO LIVE ON. trading from ${a.wallet.pub} (max ${live.CFG.maxAgentSol} SOL used)`, 'sys');
  } else {
    a.liveOn = false; backToPaperIfFlat(a);
    log(a, a.portfolio.live ? 'auto live buying off. open positions are still managed until sold.' : 'auto live off. back to paper.', 'sys');
  }
  save(); return a;
}
function backToPaperIfFlat(a) { if (a.portfolio.live && !a.portfolio.positions.length && !a.liveOn) { a.livePortfolio = a.portfolio; a.portfolio = a.paperPortfolio || newPortfolio(); a.busted = null; a.status = 'running'; } }
export async function liquidate(owner) {
  const a = getDb().agents[owner]; if (!a?.portfolio.live) return { closed: 0, remaining: 0 };
  a.liveOn = false; let n = 0;
  for (const p of [...a.portfolio.positions]) { await liveSell(a, p, 1, 'manual close-all'); n++; }
  backToPaperIfFlat(a); save();
  return { closed: n, remaining: a.portfolio.live ? a.portfolio.positions.length : 0 };
}
export async function withdraw(owner) {
  const a = getDb().agents[owner]; if (!a?.wallet) throw new Error('no agent wallet');
  if (a.portfolio.live && a.portfolio.positions.length) throw new Error('agent still holds tokens. run "close all" first');
  a.liveOn = false; backToPaperIfFlat(a);
  const r = await live.withdrawAll(owner, a.wallet);
  log(a, `WITHDREW ${r.sol.toFixed(4)} SOL to ${short(owner)} tx ${short(r.sig)}`, 'sys'); save();
  return r;
}

export function setUserLive(addr, on, tradeSol) {
  const a = getDb().agents[addr]; if (!a) throw new Error('no agent');
  a.liveBook ||= { enabled: false, positions: [], closed: [], proposals: [] };
  a.liveBook.enabled = !!on;
  if (tradeSol) a.liveBook.tradeSol = clamp(+tradeSol, 0.001, live.CFG.maxTradeSol);
  if (!on) for (const x of a.liveBook.proposals) if (x.status === 'pending') x.status = 'cancelled';
  log(a, on ? `LIVE PROPOSALS ON. ${a.liveBook.tradeSol || live.CFG.maxTradeSol} SOL per trade, you sign every swap` : 'live proposals off', 'sys');
  save(); return a;
}
export async function buildProposal(addr, id) {
  const a = getDb().agents[addr]; const x = a?.liveBook?.proposals.find((p) => p.id === id);
  if (!x) throw new Error('proposal not found');
  if (x.status !== 'pending' && x.status !== 'built') throw new Error(`proposal is ${x.status}`);
  if (Date.now() > x.expiresAt) throw new Error('proposal expired');
  if (x.side === 'buy') {
    if (x.status === 'pending') {
      const err = live.checkBuy(addr, x.sizeSol, market.token(x.mint) || { mint: x.mint, liquidityUsd: 0 }, a.liveBook.positions.length);
      if (err) { x.status = 'blocked'; x.error = err; throw new Error(err); }
      live.reserveSpend(addr, x.sizeSol); x.reserved = true;
    }
    const r = await live.buildUserBuy(addr, x.mint, x.sizeSol);
    Object.assign(x, { status: 'built', quote: r.quote, beforeUi: r.beforeUi, builtAt: Date.now(), expiresAt: Math.max(x.expiresAt, Date.now() + 80e3) });
    return { tx: r.tx, quote: r.quote, side: 'buy', symbol: x.symbol, sizeSol: x.sizeSol };
  }
  const p = a.liveBook.positions.find((q) => q.mint === x.mint); if (!p) throw new Error('position already closed');
  const r = await live.buildUserSell(addr, x.mint, p.qty, x.frac);
  Object.assign(x, { status: 'built', quote: r.quote, qtyUi: r.qtyUi, builtAt: Date.now(), expiresAt: Math.max(x.expiresAt, Date.now() + 80e3) });
  return { tx: r.tx, quote: r.quote, side: 'sell', symbol: x.symbol };
}
export function submittedProposal(addr, id, sig) {
  const x = getDb().agents[addr]?.liveBook?.proposals.find((p) => p.id === id);
  if (!x || x.status !== 'built') throw new Error('proposal not awaiting a signature');
  Object.assign(x, { status: 'submitted', sig, submittedAt: Date.now() }); save();
}
export function rejectProposal(addr, id) {
  const a = getDb().agents[addr]; const x = a?.liveBook?.proposals.find((p) => p.id === id);
  if (!x || !['pending', 'built'].includes(x.status)) throw new Error('nothing to reject');
  x.status = 'rejected'; if (x.side === 'buy' && x.reserved) live.releaseSpend(addr, x.sizeSol);
  if (x.tp) { const p = a.liveBook.positions.find((q) => q.mint === x.mint); if (p) p.tpHit = false; }
  save();
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
    mode: pf.live ? 'live' : 'paper', liveOn: !!b.liveOn, wallet: b.wallet?.pub || (pf.live ? live.grandAddress() : null), walletBal: pf.live ? pf.lastBal : b.walletBal, liveBook: liveBookView(b.liveBook),
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
