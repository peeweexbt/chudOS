// Pulls a wallet's swap history and turns it into round-trip positions.
// Live source: Helius enhanced transactions API (HELIUS_API_KEY).
// Fallback: a deterministic synthetic history so the product works without keys.
import { seedRng } from './util.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const QUOTES = new Set([WSOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const HELIUS = process.env.HELIUS_API_KEY;

export const historySource = () => (HELIUS ? 'helius' : 'demo');

export async function fetchSwaps(address, { maxPages = 5, until } = {}) {
  if (!HELIUS) return null;
  const out = [];
  let before;
  for (let p = 0; p < maxPages; p++) {
    const url = new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);
    url.searchParams.set('api-key', HELIUS);
    url.searchParams.set('type', 'SWAP');
    url.searchParams.set('limit', '100');
    if (before) url.searchParams.set('before', before);
    if (until) url.searchParams.set('until', until);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`helius ${r.status}`);
    const txs = await r.json();
    if (!txs.length) break;
    for (const tx of txs) { const s = parseSwap(tx, address); if (s) out.push(s); }
    before = txs[txs.length - 1].signature;
    if (txs.length < 100) break;
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// Reduce one enhanced tx to {side, mint, tokenAmt, sol} from the wallet's point of view.
export function parseSwap(tx, wallet) {
  if (tx.transactionError) return null;
  const acct = (tx.accountData || []).find((a) => a.account === wallet);
  let sol = acct ? acct.nativeBalanceChange / 1e9 : 0;
  const deltas = {};
  for (const t of tx.tokenTransfers || []) {
    const amt = +t.tokenAmount || 0;
    if (t.toUserAccount === wallet) deltas[t.mint] = (deltas[t.mint] || 0) + amt;
    if (t.fromUserAccount === wallet) deltas[t.mint] = (deltas[t.mint] || 0) - amt;
  }
  if (deltas[WSOL]) { sol += deltas[WSOL]; delete deltas[WSOL]; }
  const mints = Object.entries(deltas).filter(([m, d]) => !QUOTES.has(m) && Math.abs(d) > 0);
  if (mints.length !== 1 || Object.keys(deltas).some((m) => QUOTES.has(m))) return null; // skip USDC/multi-hop oddities
  const [mint, d] = mints[0];
  const side = d > 0 && sol < 0 ? 'buy' : d < 0 && sol > 0 ? 'sell' : null;
  if (!side) return null;
  const sym = (tx.description || '').match(/for [\d,.]+ (\S+)$/)?.[1] || (tx.description || '').match(/swapped [\d,.]+ (\S+) for/)?.[1];
  return { sig: tx.signature, ts: tx.timestamp * 1000, side, mint, symbol: sym && sym !== 'SOL' ? sym : null, tokenAmt: Math.abs(d), sol: Math.abs(sol) };
}

// FIFO-ish aggregation of swaps into round trips per mint.
export function toRoundTrips(swaps) {
  const open = {}; const closed = [];
  for (const s of swaps) {
    let p = open[s.mint];
    if (s.side === 'buy') {
      if (!p) p = open[s.mint] = { mint: s.mint, symbol: s.symbol, entryTs: s.ts, qty: 0, maxQty: 0, cost: 0, proceeds: 0, buys: 0, sells: 0 };
      p.qty += s.tokenAmt; p.maxQty = Math.max(p.maxQty, p.qty); p.cost += s.sol; p.buys++;
      p.symbol ||= s.symbol;
    } else if (p) {
      p.qty -= s.tokenAmt; p.proceeds += s.sol; p.sells++;
      if (p.qty <= p.maxQty * 0.01) {
        closed.push(finish(p, s.ts)); delete open[s.mint];
      }
    }
  }
  return { closed, open: Object.values(open).map((p) => ({ mint: p.mint, symbol: p.symbol, entryTs: p.entryTs, costSol: p.cost, qty: p.qty })) };
}
const finish = (p, ts) => ({
  mint: p.mint, symbol: p.symbol || p.mint.slice(0, 5), entryTs: p.entryTs, exitTs: ts,
  costSol: p.cost, proceedsSol: p.proceeds, pnlSol: p.proceeds - p.cost,
  multiple: p.cost > 0 ? p.proceeds / p.cost : 0, holdSec: (ts - p.entryTs) / 1000, buys: p.buys, sells: p.sells,
});

// ---------- demo history ----------
const SYL = ['PEPE', 'CHAD', 'WIF', 'BONK', 'GIGA', 'MOG', 'NUT', 'COPE', 'SEND', 'FROG', 'RUG', 'MOON', 'DEGEN', 'BOZO', 'GOAT', 'HAWK', 'SIGMA', 'CUM', 'POPCAT', 'JEET'];

export function demoPersona(address) {
  const r = seedRng('persona' + address);
  return {
    skill: r() * 0.9 - 0.3,       // edge in picking tokens (-0.3..0.6)
    bagHolder: r(),                // holds losers too long
    paperHands: r(),               // sells winners too early
    tilt: r(),                     // revenge trades after losses
    baseSize: +(0.2 + r() * 2.5).toFixed(2),
  };
}

export function demoRoundTrips(address, now = Date.now()) {
  const r = seedRng(address); const P = demoPersona(address);
  const n = 50 + Math.floor(r() * 90);
  let t = now - 60 * 864e5; let streak = 0; const trips = [];
  for (let i = 0; i < n; i++) {
    t += (r() * 22 + (streak >= 2 ? -10 : 0) + 2) * 36e5 * 0.5;
    const tilted = streak >= 2 && r() < P.tilt;
    const size = P.baseSize * (0.5 + r()) * (tilted ? 1.8 + r() * 2 : 1);
    // path: peak multiple reached, then where the user actually got out
    const quality = P.skill + (tilted ? -0.35 : 0) + (r() - 0.5) * 0.6;
    const peak = Math.exp(Math.max(-2.5, quality * 1.8 + (r() ** 3) * 3.2 - 0.4));
    const rug = r() < 0.12 - P.skill * 0.08;
    let mult;
    if (rug) mult = 0.01 + r() * 0.06;
    else if (peak > 1.2) mult = peak * (P.paperHands > 0.5 ? 0.35 + r() * 0.35 : 0.55 + r() * 0.4) + (r() < P.bagHolder * 0.5 ? -peak * 0.4 : 0);
    else mult = peak * (0.4 + r() * 0.6) * (P.bagHolder > 0.5 ? 0.6 + r() * 0.3 : 1);
    mult = Math.max(0.01, mult);
    const hold = (mult < 1 ? (P.bagHolder * 20 + 1) : (P.paperHands > 0.5 ? 0.3 : 3)) * (0.3 + r() * 2) * 36e5;
    const sym = SYL[Math.floor(r() * SYL.length)] + (r() < 0.4 ? Math.floor(r() * 99) : '');
    const mint = 'demo' + Math.floor(r() * 1e12).toString(36) + i;
    trips.push({ mint, symbol: sym, entryTs: t, exitTs: t + hold, costSol: size, proceedsSol: size * mult, pnlSol: size * (mult - 1), multiple: mult, holdSec: hold / 1000, buys: 1, sells: 1, peak: Math.max(peak, mult) });
    streak = mult < 1 ? streak + 1 : 0;
    t += hold;
    if (t > now - 36e5) break;
  }
  return { closed: trips, open: [] };
}
