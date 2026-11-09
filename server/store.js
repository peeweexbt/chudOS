// Tiny JSON-file store. Good enough for an MVP on one Railway/Render instance
// (mount a volume at /app/data). Swap for Postgres when you outgrow it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = process.env.DB_FILE || path.resolve('data/db.json');
const empty = () => ({ wallets: {}, agents: {}, grand: null, secret: null });
let db = empty();
let timer = null;

export function load() {
  try { db = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* fresh */ }
  if (!db.secret) { db.secret = crypto.randomBytes(32).toString('hex'); save(); }
  return db;
}
export const getDb = () => db;
export function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(FILE + '.tmp', FILE);
  }, 500);
}
