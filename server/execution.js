// Live execution is intentionally NOT implemented. Every agent trades a paper
// portfolio. When Cats opts in, this is where a Jupiter swap + per-user
// delegated signer (e.g. a session key with spend limits) would go, behind
// LIVE_TRADING=enabled plus a per-user opt-in and hard size caps.
export function executeSwap() {
  throw new Error('live execution disabled: CHUD OS runs in paper mode');
}
