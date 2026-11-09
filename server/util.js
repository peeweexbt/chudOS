export function seedRng(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
export const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
export const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const short = (a) => a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '';
export const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
