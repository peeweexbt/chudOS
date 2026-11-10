import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { load, getDb, save } from './store.js';
import { isAddress, issueMessage, verify, makeToken, requireAuth } from './auth.js';
import { ingestWallet, tick, botView, walletView, leaderboard, retrainGrand, setGrandLive, setUserLive, ensureAgentWallet, setAutoLive, liquidate, withdraw, buildProposal, submittedProposal, rejectProposal } from './engine.js';
import * as live from './live.js';
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

app.get('/api/config', (req, res) => res.json({ market: MARKET, history: historySource(), execution: live.CFG.enabled ? 'live-capable' : 'paper', allowDemo: ALLOW_DEMO, solUsd: market.solUsd, live: live.publicConfig(), grandLive: !!getDb().grand?.liveOn }));

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
  res.json({ wallet: walletView(db.wallets[req.user.address]), agent: botView(db.agents[req.user.address]), isAdmin: !req.user.demo && live.isAdmin(req.user.address), demoLogin: req.user.demo, mayAutoTrade: !req.user.demo && live.mayAutoTrade(req.user.address), live: live.publicConfig() });
});
app.post('/api/me/sync', requireAuth, limit(3, 60e3), wrap(async (req, res) => {
  const w = await ingestWallet(req.user.address, { demo: req.user.demo, agent: true });
  res.json({ wallet: walletView(w), agent: botView(getDb().agents[req.user.address]) });
}));
app.post('/api/me/agent/:action(pause|resume|reset)', requireAuth, (req, res) => {
  const a = getDb().agents[req.user.address]; if (!a) return res.status(404).json({ error: 'no agent' });
  if (req.params.action === 'reset' && a.portfolio.live) return res.status(409).json({ error: 'agent is trading live. stop it, close all and withdraw instead' });
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
// ---------- live trading ----------
const CONFIRM = 'I UNDERSTAND';
app.post('/api/me/live', requireAuth, (req, res) => {
  const { enable, confirm, tradeSol } = req.body || {};
  if (enable) {
    if (req.user.demo) return res.status(403).json({ error: 'demo wallets cannot trade live' });
    if (!live.CFG.enabled) return res.status(403).json({ error: 'live trading is disabled on this server' });
    if (confirm !== CONFIRM) return res.status(400).json({ error: `type "${CONFIRM}" to confirm` });
  }
  try { const a = setUserLive(req.user.address, !!enable, tradeSol); res.json({ agent: botView(a) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/me/proposals/:id/build', requireAuth, limit(20, 60e3), wrap(async (req, res) => res.json(await buildProposal(req.user.address, req.params.id))));
app.post('/api/me/proposals/:id/submitted', requireAuth, (req, res) => {
  const sig = (req.body || {}).signature;
  try { if (!sig || bs58.decode(sig).length !== 64) throw new Error('bad signature'); submittedProposal(req.user.address, req.params.id, sig); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/me/proposals/:id/reject', requireAuth, (req, res) => { try { rejectProposal(req.user.address, req.params.id); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });

// fully automatic agent wallets (server holds an encrypted key per agent; withdrawals only go to the owner)
const noDemo = (req, res, next) => (req.user.demo ? res.status(403).json({ error: 'demo wallets cannot trade live' }) : next());
app.post('/api/me/agent-wallet', requireAuth, noDemo, (req, res) => {
  if (!live.custodyReady()) return res.status(503).json({ error: 'agent wallets are not configured on this server' });
  if (!live.mayAutoTrade(req.user.address)) return res.status(403).json({ error: 'your wallet is not on the invite list for automatic trading' });
  try { res.json({ agent: botView(ensureAgentWallet(req.user.address)) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/me/auto', requireAuth, noDemo, limit(10, 60e3), wrap(async (req, res) => {
  const { enable, confirm } = req.body || {};
  if (enable && confirm !== CONFIRM) return res.status(400).json({ error: `type "${CONFIRM}" to confirm` });
  try { res.json({ agent: botView(await setAutoLive(req.user.address, !!enable)) }); } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post('/api/me/close-all', requireAuth, noDemo, limit(3, 60e3), wrap(async (req, res) => res.json(await liquidate(req.user.address))));
app.post('/api/me/withdraw', requireAuth, noDemo, limit(3, 60e3), wrap(async (req, res) => res.json(await withdraw(req.user.address))));
// Export the agent wallet's private key so the owner is never locked out. Needs a fresh wallet signature.
app.post('/api/me/agent-wallet/export', requireAuth, noDemo, limit(3, 60e3), (req, res) => {
  const { message, signature } = req.body || {};
  if (!verify(req.user.address, message || '', signature || '')) return res.status(401).json({ error: 'fresh wallet signature required' });
  const a = getDb().agents[req.user.address]; if (!a?.wallet) return res.status(404).json({ error: 'no agent wallet' });
  try { res.json({ address: a.wallet.pub, secretKey: bs58.encode(live.agentKeypair(req.user.address, a.wallet).secretKey) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

const requireAdmin = (req, res, next) => (!req.user.demo && live.isAdmin(req.user.address) ? next() : res.status(403).json({ error: 'admin only' }));
app.post('/api/admin/kill', requireAuth, requireAdmin, (req, res) => { live.kill((req.body || {}).reason || 'manual kill switch', req.user.address); res.json(live.publicConfig()); });
app.post('/api/admin/unkill', requireAuth, requireAdmin, (req, res) => { live.unkill(); res.json(live.publicConfig()); });
app.post('/api/admin/grand', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { on, confirm } = req.body || {};
  if (on && confirm !== CONFIRM) return res.status(400).json({ error: `type "${CONFIRM}" to confirm` });
  await setGrandLive(!!on); res.json({ grand: botView(getDb().grand) });
}));

app.get('/healthz', (req, res) => res.send('ok'));

if (!getDb().grand) retrainGrand();
setInterval(tick, TICK_MS); tick();
const port = +process.env.PORT || 3000;
app.listen(port, () => console.log(`CHUD OS online :${port}  market=${MARKET} history=${historySource()} live=${live.CFG.enabled ? 'ENABLED' : 'off'} grandWallet=${live.grandAddress() || '-'} admins=${live.CFG.admins.length}`));
