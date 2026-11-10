// LIVE EXECUTION on Solana mainnet via Jupiter.
// Safety model:
//  - Nothing trades for real unless LIVE_TRADING=enabled on the server.
//  - The Grand Chud signs with its OWN dedicated wallet (GRAND_SECRET_KEY). Fund it only with what you can lose.
//  - User agents never hold user keys: they propose, the user signs each swap in Phantom.
//  - Hard caps on every live buy: per-trade size, daily spend, open positions, slippage/price impact, min liquidity.
//  - Global kill switch (admin or automatic on daily drawdown) blocks all live buys. Sells stay allowed so risk can be reduced.
import { Connection, Keypair, VersionedTransaction, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getDb, save } from './store.js';

export const WSOL = 'So11111111111111111111111111111111111111112';
const num = (v, d) => (v === undefined || v === '' ? d : +v);
export const CFG = {
  enabled: process.env.LIVE_TRADING === 'enabled',
  rpc: process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com'),
  jup: process.env.JUP_API || 'https://lite-api.jup.ag/swap/v1',
  maxTradeSol: num(process.env.MAX_TRADE_SOL, 0.05),
  maxDailySol: num(process.env.MAX_DAILY_SOL, 0.5),
  maxOpen: num(process.env.MAX_OPEN_LIVE, 3),
  slippageBps: num(process.env.SLIPPAGE_BPS, 300),
  minLiqUsd: num(process.env.MIN_LIQUIDITY_USD, 25000),
  dailyLossKill: num(process.env.DAILY_LOSS_KILL, 0.3),
  feeReserveSol: 0.02,
  maxPriorityLamports: num(process.env.MAX_PRIORITY_LAMPORTS, 500000),
  maxAgentSol: num(process.env.MAX_AGENT_SOL, 1),
  allowlist: (process.env.LIVE_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
  admins: (process.env.ADMIN_WALLETS || '').split(',').map((s) => s.trim()).filter(Boolean),
};
if (CFG.enabled && process.env.MARKET === 'sim' && !process.env.LIVE_TEST) {
  console.error('[live] refusing LIVE_TRADING with MARKET=sim; live disabled'); CFG.enabled = false;
}

let conn;
export const connection = () => (conn ||= new Connection(CFG.rpc, 'confirmed'));

let grandKp = null;
if (process.env.GRAND_SECRET_KEY) {
  try {
    const s = process.env.GRAND_SECRET_KEY.trim();
    grandKp = Keypair.fromSecretKey(s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s));
  } catch { console.error('[live] GRAND_SECRET_KEY is not a valid secret key; Grand Chud stays on paper'); }
}
export const grandAddress = () => grandKp?.publicKey.toBase58() || null;
export const isAdmin = (addr) => CFG.admins.includes(addr);
// who may run a fully automatic agent wallet: admins + LIVE_ALLOWLIST ("*" = everyone)
export const mayAutoTrade = (addr) => isAdmin(addr) || CFG.allowlist.includes('*') || CFG.allowlist.includes(addr);

// ---------- risk ledger ----------
const today = () => new Date().toISOString().slice(0, 10);
export function riskState() { const db = getDb(); return (db.risk ||= { killed: false, books: {} }); }
export function ledger(key) {
  const r = riskState(); const b = (r.books[key] ||= {});
  if (b.day !== today()) { b.day = today(); b.spent = 0; b.startEquity = null; }
  return b;
}
export function kill(reason, by) { Object.assign(riskState(), { killed: true, killedAt: Date.now(), killedReason: reason, killedBy: by }); save(); console.warn('[live] KILL SWITCH:', reason); }
export function unkill() { Object.assign(riskState(), { killed: false, killedReason: null }); save(); }

export function checkBuy(key, sizeSol, tok, openCount) {
  if (!CFG.enabled) return 'live trading is disabled on the server';
  const r = riskState();
  if (r.killed) return `kill switch engaged (${r.killedReason})`;
  if (!(sizeSol > 0) || sizeSol > CFG.maxTradeSol + 1e-9) return `size ${sizeSol} SOL is over the ${CFG.maxTradeSol} SOL per-trade cap`;
  const l = ledger(key);
  if (l.spent + sizeSol > CFG.maxDailySol + 1e-9) return `daily cap reached (${l.spent.toFixed(3)} / ${CFG.maxDailySol} SOL)`;
  if (openCount >= CFG.maxOpen) return `already ${openCount} open live positions (max ${CFG.maxOpen})`;
  if (!tok || tok.dead) return 'token unavailable';
  if ((tok.liquidityUsd || 0) < CFG.minLiqUsd) return `liquidity $${Math.round(tok.liquidityUsd || 0)} under $${CFG.minLiqUsd} floor`;
  try { new PublicKey(tok.mint); } catch { return 'not a real mint'; }
  return null;
}
export function reserveSpend(key, sol) { ledger(key).spent += sol; save(); }
export function releaseSpend(key, sol) { const l = ledger(key); l.spent = Math.max(0, l.spent - sol); save(); }
export function checkDrawdown(key, equity, onTrip) {
  const l = ledger(key); if (l.startEquity == null) { l.startEquity = equity; return false; }
  if (!riskState().killed && !l.tripped && equity < l.startEquity * (1 - CFG.dailyLossKill)) {
    const why = `${key === 'grand' ? 'grand chud' : key.slice(0, 4)} is down ${Math.round(100 * (1 - equity / l.startEquity))}% today`;
    if (onTrip) { if (!l.tripped) { l.tripped = true; onTrip(why); } } else kill(why, 'auto');
    return true;
  }
  return false;
}

// ---------- Jupiter ----------
export async function quote(inputMint, outputMint, amountAtomic) {
  const u = new URL(`${CFG.jup}/quote`);
  u.search = new URLSearchParams({ inputMint, outputMint, amount: String(amountAtomic), slippageBps: String(CFG.slippageBps), restrictIntermediateTokens: 'true' });
  const r = await fetch(u);
  if (!r.ok) throw new Error(`jupiter quote ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const q = await r.json();
  const impact = +q.priceImpactPct || 0; // fraction
  if (impact * 1e4 > CFG.slippageBps) throw new Error(`price impact ${(impact * 100).toFixed(2)}% is over the ${CFG.slippageBps / 100}% cap`);
  return q;
}
export async function swapTx(q, userPublicKey) {
  const r = await fetch(`${CFG.jup}/swap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: CFG.maxPriorityLamports, priorityLevel: 'high' } } }),
  });
  if (!r.ok) throw new Error(`jupiter swap ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).swapTransaction; // base64 VersionedTransaction
}

// ---------- chain reads ----------
export async function solBalance(owner) { return (await connection().getBalance(new PublicKey(owner))) / 1e9; }
export async function tokenBalance(owner, mint) {
  const r = await connection().getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
  let amount = 0n, decimals = 0, ui = 0;
  for (const a of r.value) { const t = a.account.data.parsed.info.tokenAmount; amount += BigInt(t.amount); decimals = t.decimals; ui += +t.uiAmount || 0; }
  return { amount, decimals, ui };
}
export async function sigStatus(sig) {
  const { value: [s] } = await connection().getSignatureStatuses([sig], { searchTransactionHistory: true });
  if (!s) return 'pending';
  if (s.err) return 'failed';
  return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'ok' : 'pending';
}
async function confirm(sig, ms = 75e3) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const st = await sigStatus(sig);
    if (st === 'ok') return; if (st === 'failed') throw new Error(`transaction failed on-chain: ${sig}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`not confirmed in time: ${sig}`);
}

// ---------- Grand Chud (server signer, own wallet only) ----------
async function signAndSend(b64, kp) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  if (!tx.message.staticAccountKeys[0].equals(kp.publicKey)) throw new Error('swap tx fee payer is not the bot wallet; refusing to sign');
  tx.sign([kp]);
  const sig = await connection().sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await confirm(sig);
  return sig;
}
export const grandKeypair = () => grandKp;
export async function swapBuy(kp, mint, sizeSol) {
  const me = kp.publicKey.toBase58();
  const solBefore = await solBalance(me); const before = await tokenBalance(me, mint);
  if (solBefore - sizeSol < CFG.feeReserveSol) throw new Error(`wallet has ${solBefore.toFixed(4)} SOL, not enough for ${sizeSol} + fee reserve`);
  const q = await quote(WSOL, mint, Math.floor(sizeSol * 1e9));
  const sig = await signAndSend(await swapTx(q, me), kp);
  const after = await tokenBalance(me, mint); const solAfter = await solBalance(me);
  return { sig, qty: after.ui - before.ui, decimals: after.decimals, cost: solBefore - solAfter };
}
export async function swapSell(kp, mint, frac) {
  const me = kp.publicKey.toBase58();
  const bal = await tokenBalance(me, mint);
  if (bal.amount === 0n) return { sig: null, proceeds: 0, sold: 0 };
  const amt = frac >= 0.999 ? bal.amount : (bal.amount * BigInt(Math.floor(frac * 1e6))) / 1000000n;
  const solBefore = await solBalance(me);
  const q = await quote(mint, WSOL, amt);
  const sig = await signAndSend(await swapTx(q, me), kp);
  return { sig, proceeds: (await solBalance(me)) - solBefore, sold: Number(amt) / 10 ** bal.decimals };
}

// ---------- user agents (user signs in Phantom) ----------
export async function buildUserBuy(owner, mint, sizeSol) {
  const q = await quote(WSOL, mint, Math.floor(sizeSol * 1e9));
  const before = await tokenBalance(owner, mint).catch(() => ({ ui: 0 }));
  return { tx: await swapTx(q, owner), quote: summarize(q), beforeUi: before.ui };
}
export async function buildUserSell(owner, mint, qtyUi, frac) {
  const bal = await tokenBalance(owner, mint);
  if (bal.amount === 0n) throw new Error('you no longer hold this token');
  // never sell more than the agent bought, even if the wallet holds more
  const capAtomic = BigInt(Math.floor(qtyUi * frac * 10 ** bal.decimals));
  const amt = capAtomic < bal.amount ? capAtomic : bal.amount;
  const q = await quote(mint, WSOL, amt);
  return { tx: await swapTx(q, owner), quote: summarize(q), qtyUi: Number(amt) / 10 ** bal.decimals };
}
const summarize = (q) => ({ inAmount: q.inAmount, outAmount: q.outAmount, priceImpactPct: q.priceImpactPct, slippageBps: q.slippageBps });

export function publicConfig() {
  const r = riskState();
  return { serverEnabled: CFG.enabled, custody: !!MASTER, maxAgentSol: CFG.maxAgentSol, killed: r.killed, killedReason: r.killedReason, grandAddress: grandAddress(),
    limits: { maxTradeSol: CFG.maxTradeSol, maxDailySol: CFG.maxDailySol, maxOpen: CFG.maxOpen, slippageBps: CFG.slippageBps, minLiqUsd: CFG.minLiqUsd, dailyLossKill: CFG.dailyLossKill } };
}

// ---------- custodial agent wallets ----------
// Each user's agent gets its own keypair. The secret is encrypted with AES-256-GCM under MASTER_KEY
// (32 bytes, hex or base64) and bound to the owner's address. Funds can only be withdrawn to the owner.
import crypto from 'node:crypto';
const MASTER = (() => {
  const v = process.env.MASTER_KEY; if (!v) return null;
  const b = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (b.length !== 32) { console.error('[live] MASTER_KEY must be 32 bytes (64 hex chars); agent wallets disabled'); return null; }
  return b;
})();
export const custodyReady = () => !!MASTER;
export function newAgentWallet(owner) {
  if (!MASTER) throw new Error('MASTER_KEY is not set on the server');
  const kp = Keypair.generate(); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MASTER, iv); c.setAAD(Buffer.from(owner));
  const ct = Buffer.concat([c.update(Buffer.from(kp.secretKey)), c.final()]);
  return { pub: kp.publicKey.toBase58(), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'), createdAt: Date.now() };
}
export function agentKeypair(owner, w) {
  if (!MASTER) throw new Error('MASTER_KEY is not set on the server');
  const d = crypto.createDecipheriv('aes-256-gcm', MASTER, Buffer.from(w.iv, 'base64')); d.setAAD(Buffer.from(owner)); d.setAuthTag(Buffer.from(w.tag, 'base64'));
  const kp = Keypair.fromSecretKey(Buffer.concat([d.update(Buffer.from(w.ct, 'base64')), d.final()]));
  if (kp.publicKey.toBase58() !== w.pub) throw new Error('agent wallet key mismatch');
  return kp;
}
// Withdraw SOL from an agent wallet. Destination is always the owner; there is no parameter for it.
export async function withdrawAll(owner, w) {
  const kp = agentKeypair(owner, w); const c = connection();
  const lamports = await c.getBalance(kp.publicKey); const fee = 5000;
  if (lamports <= fee) throw new Error('agent wallet is empty');
  const { blockhash } = await c.getLatestBlockhash();
  const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(owner), lamports: lamports - fee }));
  tx.sign(kp);
  const sig = await c.sendRawTransaction(tx.serialize());
  await confirm(sig);
  return { sig, sol: (lamports - fee) / 1e9 };
}
