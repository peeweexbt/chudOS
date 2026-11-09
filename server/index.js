import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { load, getDb, save } from './store.js';
import { isAddress, issueMessage, verify, makeToken, requireAuth } from './auth.js';
import { ingestWallet, tick, botView, walletView, leaderboard, retrainGrand } from './engine.js';
import { MARKET, market } from './market.js';
import { historySource } from './history.js';
import bs58 from 'bs58';

load();
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.resolve('public')));

const ALLOW_DEMO = process.env.ALLOW_DEMO !== '0';
const TICK_MS = +process.env.TICK_MS || (MARKET === 'sim' ? 5000 : 15000);

// crude per-IP rate limit for the expensive endpoints
const hits = new Map();
const limit = (n, ms) => (req, res, next) => {
  const k = req.ip + req.path; const now = Date.now(); const h = (hits.get(k) || []).filter((t) => now - t < ms);
  if (h.length >= n) return res.status(429).json({ error: 'slow down, chud' });
  h.push(now); hits.set(k, h); next();
};
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });

app.get('/api/config', (req, res) => res.json({ market: MARKET, history: historySource(), execution: 'paper', allowDemo: ALLOW_DEMO, solUsd: market.solUsd }));

app.get('/api/auth/nonce', (req, res) => {
  const { address } = req.query;
  if (!isAddress(address)) return res.status(400).json({ error: 'bad address' });
  res.json({ message: issueMessage(address) });
});

app.post('/api/auth/verify', limit(10, 60e3), wrap(async (req, res) => {
  const { address, message, signature } = req.body || {};
  if (!isAddress(address) || !verify(address, message || '', signature || '')) return res.status(401).json({ error: 'signature rejected' });
  const w = await ingestWallet(address, { verified: true, agent: true });
  res.json({ token: makeToken(address), wallet: walletView(w) });
}));

// Try the product without a wallet: random throwaway address with synthetic history.
app.post('/api/auth/demo', limit(5, 60e3), wrap(async (req, res) => {
  if (!ALLOW_DEMO) return res.status(403).json({ error: 'demo disabled' });
  const address = bs58.encode(crypto.randomBytes(32));
  const w = await ingestWallet(address, { demo: true, agent: true });
  res.json({ token: makeToken(address, true), wallet: walletView(w) });
}));

app.get('/api/me', requireAuth, (req, res) => {
  const db = getDb();
  res.json({ wallet: walletView(db.wallets[req.user.address]), agent: botView(db.agents[req.user.address]) });
});
app.post('/api/me/sync', requireAuth, limit(3, 60e3), wrap(async (req, res) => {
  const w = await ingestWallet(req.user.address, { demo: req.user.demo, agent: true });
  res.json({ wallet: walletView(w), agent: botView(getDb().agents[req.user.address]) });
}));
app.post('/api/me/agent/:action(pause|resume|reset)', requireAuth, (req, res) => {
  const a = getDb().agents[req.user.address]; if (!a) return res.status(404).json({ error: 'no agent' });
  if (req.params.action === 'reset') { a.portfolio = { start: 10, cash: 10, positions: [], closed: [], equity: [[Date.now(), 10]] }; a.busted = null; a.status = 'running'; a.streak = 0; a.pausedUntil = 0; a.log.unshift({ ts: Date.now(), msg: 'paper portfolio reset to 10 SOL', kind: 'sys' }); }
  else if (a.busted) return res.status(409).json({ error: 'agent is out of SOL. its over. use "agent reset" to give it a fresh 10 SOL' });
  else a.status = req.params.action === 'pause' ? 'paused' : 'running';
  save(); res.json({ agent: botView(a) });
});

// Feed any address to the Grand Chud (read-only, no agent assigned).
app.post('/api/feed', limit(6, 60e3), wrap(async (req, res) => {
  const { address } = req.body || {};
  if (!isAddress(address)) return res.status(400).json({ error: 'bad address' });
  const w = await ingestWallet(address, {});
  res.json({ wallet: walletView(w) });
}));
app.get('/api/wallet/:address', (req, res) => {
  const w = getDb().wallets[req.params.address];
  if (!w) return res.status(404).json({ error: 'unknown wallet' });
  res.json({ wallet: walletView(w) });
});
app.get('/api/grand', (req, res) => res.json({ grand: botView(getDb().grand) }));
app.get('/api/leaderboard', (req, res) => res.json(leaderboard()));
app.get('/api/market', (req, res) => res.json({ solUsd: market.solUsd, tokens: market.candidates().sort((a, b) => b.volume24h - a.volume24h).slice(0, 15).map(({ hist, quality, ...t }) => t) }));
app.get('/healthz', (req, res) => res.send('ok'));

if (!getDb().grand) retrainGrand();
setInterval(tick, TICK_MS); tick();
const port = +process.env.PORT || 3000;
app.listen(port, () => console.log(`CHUD OS online :${port}  market=${MARKET} history=${historySource()} execution=PAPER`));
