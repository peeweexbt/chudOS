// Market data adapters. Both expose the same interface:
//   tick(), candidates() -> [token], price(mint) -> usd|null, solUsd
// live: DexScreener public API (no key). sim: synthetic meme coin market.
import { seedRng, clamp } from './util.js';

export const MARKET = process.env.MARKET === 'sim' ? 'sim' : 'live';
const WSOL = 'So11111111111111111111111111111111111111112';

class LiveMarket {
  constructor() { this.tokens = new Map(); this.solUsd = 150; this.last = 0; }
  async tick() {
    if (Date.now() - this.last < 20e3) return; this.last = Date.now();
    try {
      const [boosts, profiles] = await Promise.all([
        j('https://api.dexscreener.com/token-boosts/latest/v1'), j('https://api.dexscreener.com/token-profiles/latest/v1')]);
      const fresh = [...(boosts || []), ...(profiles || [])].filter((x) => x.chainId === 'solana').map((x) => x.tokenAddress);
      const watch = new Set([...fresh, ...this.tokens.keys(), WSOL]);
      await this.refresh([...watch]);
    } catch (e) { console.warn('[market] dexscreener', e.message); }
  }
  async refresh(mints) {
    for (let i = 0; i < mints.length; i += 30) {
      const pairs = await j(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`);
      const best = {};
      for (const p of pairs || []) { const m = p.baseToken.address; if (!best[m] || (p.liquidity?.usd || 0) > (best[m].liquidity?.usd || 0)) best[m] = p; }
      for (const [m, p] of Object.entries(best)) {
        if (m === WSOL) { this.solUsd = +p.priceUsd || this.solUsd; continue; }
        this.tokens.set(m, { mint: m, symbol: p.baseToken.symbol, priceUsd: +p.priceUsd, liquidityUsd: p.liquidity?.usd || 0,
          volume24h: p.volume?.h24 || 0, ageMin: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 6e4 : 1e9,
          change5m: p.priceChange?.m5 || 0, change1h: p.priceChange?.h1 || 0, fdv: p.fdv || 0, buys1h: p.txns?.h1?.buys || 0, sells1h: p.txns?.h1?.sells || 0, seen: Date.now() });
      }
    }
    // forget stale tokens we don't hold
    for (const [m, t] of this.tokens) if (Date.now() - t.seen > 30 * 6e4 && !this.pinned?.has(m)) this.tokens.delete(m);
  }
  async ensure(mints) { const miss = mints.filter((m) => !this.tokens.has(m)); if (miss.length) await this.refresh(miss).catch(() => {}); }
  candidates() { return [...this.tokens.values()]; }
  price(m) { return this.tokens.get(m)?.priceUsd ?? null; }
  token(m) { return this.tokens.get(m); }
}

async function j(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ---------------- simulation ----------------
const NAMES = ['PEPE', 'CHAD', 'WOJAK', 'BONKUS', 'GIGA', 'MOGGER', 'COPE', 'SEETHE', 'FROGO', 'GOBLIN', 'SIGMA', 'NPC', 'BASED', 'GRUG', 'DOOMER', 'BLOOMER', 'ZOOMER', 'COOMER', 'JEETY', 'APU', 'KEK', 'GME2', 'CATWIF', 'DOGWIF', 'HAMSTER', 'TRUMPET', 'SOLCAT', 'LASER', 'GLOWIE', 'CHUDLING'];
class SimMarket {
  constructor() { this.r = seedRng('chud-sim-' + Date.now()); this.tokens = new Map(); this.solUsd = 150; this.last = Date.now(); this.n = 0; for (let i = 0; i < 18; i++) this.launch(true); }
  launch(old = false) {
    const r = this.r; const mint = `sim${(++this.n).toString(36)}${Math.floor(r() * 1e9).toString(36)}`;
    const t = { mint, symbol: NAMES[Math.floor(r() * NAMES.length)] + (r() < 0.5 ? '' : Math.floor(r() * 9)), priceUsd: 1e-5 * (0.3 + r() * 3),
      liquidityUsd: 8e3 + r() * 6e4, volume24h: 0, born: Date.now() - (old ? r() * 6 * 36e5 : 0), change5m: 0, change1h: 0,
      quality: (r() - 0.55) * 0.02, vol: 0.03 + r() * 0.05, dead: false, hist: [] };
    t.fdv = t.priceUsd * 1e9; this.tokens.set(mint, t); return t;
  }
  async tick() {
    const steps = Math.min(60, Math.floor((Date.now() - this.last) / 5e3)); if (!steps) return; this.last += steps * 5e3;
    const r = this.r;
    for (let s = 0; s < steps; s++) {
      if (r() < 0.06) this.launch();
      for (const t of this.tokens.values()) {
        if (t.dead) continue;
        let ret = t.quality + t.vol * gauss(r);
        if (r() < 0.004) ret += 0.3 + r() * 0.8;                        // pump
        if (r() < 0.0025 + Math.max(0, -t.quality) * 0.08) { ret = -0.97; t.dead = true; t.liquidityUsd *= 0.03; } // rug
        t.quality += gauss(r) * 0.0008 - t.quality * 0.002;
        t.priceUsd *= Math.exp(clamp(ret, -4, 1.5));
        t.liquidityUsd = Math.max(500, t.liquidityUsd * Math.exp(ret * 0.5));
        t.volume24h = t.volume24h * 0.995 + Math.abs(ret) * t.liquidityUsd;
        t.hist.push(t.priceUsd); if (t.hist.length > 720) t.hist.shift();
        const back = (k) => t.hist[Math.max(0, t.hist.length - 1 - k)];
        t.change5m = (t.priceUsd / back(60) - 1) * 100; t.change1h = (t.priceUsd / back(720) - 1) * 100;
        t.fdv = t.priceUsd * 1e9; t.ageMin = (Date.now() - t.born) / 6e4;
        t.buys1h = Math.round(t.volume24h / 400 * (1 + clamp(ret * 10, -0.5, 0.5))); t.sells1h = Math.round(t.volume24h / 400);
      }
      for (const [m, t] of this.tokens) if (t.dead && Date.now() - t.born > 4 * 36e5 && !this.pinned?.has(m)) this.tokens.delete(m);
    }
  }
  async ensure() {}
  candidates() { return [...this.tokens.values()].filter((t) => !t.dead); }
  price(m) { return this.tokens.get(m)?.priceUsd ?? null; }
  token(m) { return this.tokens.get(m); }
  // Simulated "this wallet just bought X": skilled wallets tend to pick tokens with real drift.
  simulateBuys(wallet, persona) {
    const r = this.r; if (r() > 0.04) return [];
    const c = this.candidates(); if (!c.length) return [];
    const scored = c.map((t) => ({ t, s: t.quality * 60 * persona.skill + gauss(r) * 0.5 })).sort((a, b) => b.s - a.s);
    const pick = scored[Math.floor(r() ** 2 * Math.min(6, scored.length))].t;
    return [{ mint: pick.mint, symbol: pick.symbol, ts: Date.now(), sol: persona.baseSize }];
  }
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

export const market = MARKET === 'sim' ? new SimMarket() : new LiveMarket();
market.pinned = new Set();
