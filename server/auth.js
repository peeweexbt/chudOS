// Sign-in-with-Solana: the wallet signs a one-time message; we verify the
// ed25519 signature against the public key. No private keys ever touch us.
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { getDb } from './store.js';

const nonces = new Map(); // address -> {nonce, exp}

export function isAddress(a) {
  try { return typeof a === 'string' && bs58.decode(a).length === 32; } catch { return false; }
}

export function issueMessage(address) {
  const nonce = crypto.randomBytes(12).toString('hex');
  nonces.set(address, { nonce, exp: Date.now() + 5 * 60e3 });
  return `CHUD OS // AUTHENTICATE\n\nWallet: ${address}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}\n\nSigning proves you own this wallet. It does not move funds.`;
}

export function verify(address, message, signatureB58) {
  const n = nonces.get(address);
  if (!n || n.exp < Date.now() || !message.includes(`Nonce: ${n.nonce}`)) return false;
  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode(message), bs58.decode(signatureB58), bs58.decode(address));
  if (ok) nonces.delete(address);
  return ok;
}

const hmac = (s) => crypto.createHmac('sha256', getDb().secret).update(s).digest('hex').slice(0, 32);
export function makeToken(address, demo = false) {
  const exp = Date.now() + 7 * 864e5;
  const body = `${address}.${exp}.${demo ? 1 : 0}`;
  return `${body}.${hmac(body)}`;
}
export function readToken(tok) {
  if (!tok) return null;
  const [address, exp, demo, sig] = tok.split('.');
  if (!sig || hmac(`${address}.${exp}.${demo}`) !== sig || +exp < Date.now()) return null;
  return { address, demo: demo === '1' };
}
export function requireAuth(req, res, next) {
  const s = readToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!s) return res.status(401).json({ error: 'not authenticated' });
  req.user = s; next();
}
