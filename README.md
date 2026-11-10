# CHUD OS

Terminal-style Solana meme coin agent platform.

- **Connect a wallet** (Phantom, Solflare, Backpack). You sign a one-time message to prove ownership; no transaction is ever requested.
- **Your agent** pulls your swap history, rebuilds it into round trips, diagnoses your habits (bag holding, paper hands, tilt, revenge sizing, rug magnet, bad hours), then learns exit and discipline rules by replaying your own trades. It's graded walk-forward: rules learned on your first 60% of trades, scored on the last 40% it never saw. It then runs a 10 SOL paper book, shadowing your new buys with its own exits and scouting on its own.
- **The Grand Chud** pools every connected or fed wallet (size-normalised), fits shared rules, weights each wallet by a skill score, and buys what the most skilled wallets are buying ("consensus"), on its own paper book.

**Paper by default.** Mainnet trading exists but is off unless the server sets `LIVE_TRADING=enabled` (see "Live trading" below).

## Run locally
```
npm install
MARKET=sim npm start          # synthetic market, no keys needed
HELIUS_API_KEY=... npm start  # real history + live DexScreener prices
```
Open http://localhost:3000. Terminal commands: `help`, `connect`, `demo`, `sync`, `agent pause|resume|reset`, `feed <address>`, `inspect <address>`, `market`.

## Deploy (Railway or Render)
One always-on Node process serves the site and runs the agent loop. Keep it to **one instance** (state lives in a JSON file).
- Railway: new project from the repo, add a volume mounted at `/app/data`, set `HELIUS_API_KEY`, `DB_FILE=/app/data/db.json`.
- Render: `render.yaml` is included (starter plan + 1 GB disk).

## Layout
```
server/index.js      API + static hosting + tick loop
server/auth.js       sign-in-with-Solana (ed25519 verify), HMAC session tokens
server/history.js    Helius swap parsing -> round trips; synthetic demo history
server/analyzer.js   stats, diagnoses, policy replay/grid search, walk-forward backtest, skill score
server/market.js     DexScreener live feed / simulated market
server/engine.js     agents, Grand Chud, paper execution, wallet activity polling
server/execution.js  live execution stub (disabled)
public/              terminal UI (no build step)
```

## Honest limits
- Backtest stops assume the price crossed your stop on the way to your exit (true unless it gapped/rugged, which we treat as no fill), plus 4% slippage. Without tick data we can't model time stops in the backtest.
- Only SOL-quoted single-hop swaps are parsed; USDC routes are skipped.
- JSON store = single instance. Move to Postgres before scaling out.
- Not financial advice. Meme coins mostly go to zero.

## ASCII hero animation
The big face at the top is drawn from `public/frames.json` by `public/hero.js` (left half white, right half green, scramble transitions between images). To add or swap art, including every frame of a GIF:
```
python3 tools/ascii_frames.py assets/logo.png assets/face2.jpg path/to/your.gif > public/frames.json
```
Requires Pillow (`pip install pillow`). GIF frames play at their own timing.

## ITS OVER
When an agent's (or the Grand Chud's) paper equity drops under 0.1 SOL it's marked busted: it stops trading, its profile pic becomes `public/its-over.webp`, and the next time its owner opens the site the image floods the screen. `agent reset` gives it a fresh 10 SOL. Type `itsover` in the terminal to preview the effect.


## Live trading (Solana mainnet)
Swaps go through Jupiter. Two modes, both off by default:

| | Who signs | When it trades |
|---|---|---|
| **Grand Chud** | the server, with its own dedicated wallet (`GRAND_SECRET_KEY`) | on its own, after an admin clicks GO LIVE and types I UNDERSTAND |
| **User agents, automatic** | the server, with the agent's own wallet (one per user, key encrypted with `MASTER_KEY`) | on its own, after the user deposits SOL and types I UNDERSTAND |
| **User agents, approve mode** | the user, in Phantom, every single swap | the agent proposes; the user has 2 minutes to SIGN or reject |

**Automatic agent wallets (custodial).** Each user's agent gets its own Solana wallet. The private key is encrypted (AES-256-GCM, bound to the owner's address) with `MASTER_KEY`; the plaintext key is never written to disk. The user deposits SOL to the agent wallet address shown in the LIVE panel. Withdrawals can only go to the owner's wallet (there is no destination parameter), and only when the agent holds no tokens (`closeall` first). Owners can export the key at any time with a fresh wallet signature, so they are never locked out. The agent trades at most `MAX_AGENT_SOL` and stops buying by itself if it is down `DAILY_LOSS_KILL` on the day. Invite-only: admins plus `LIVE_ALLOWLIST` (`*` opens it to everyone). Running this means you hold other people's money; get legal advice before opening it to the public.

**Limits** (env, applied to every live buy): `MAX_TRADE_SOL` 0.05, `MAX_DAILY_SOL` 0.5 per book per UTC day, `MAX_OPEN_LIVE` 3, `SLIPPAGE_BPS` 300 (also the max price impact), `MIN_LIQUIDITY_USD` 25000. Sells are always allowed so positions can be exited.

**Kill switch:** admins (`ADMIN_WALLETS`) get KILL SWITCH / RELEASE buttons and `kill` / `unkill` commands. It trips by itself if the Grand Chud's wallet is down `DAILY_LOSS_KILL` (30%) on the day. While killed: no live buys anywhere, sells still run.

**Going live checklist**
1. Create a new Phantom wallet for the Grand Chud, export its private key, fund it with a small amount (e.g. 0.3 SOL).
2. Railway variables: `LIVE_TRADING=enabled`, `GRAND_SECRET_KEY=...`, `ADMIN_WALLETS=<your main wallet address>`, `HELIUS_API_KEY=...`, `MARKET=live`.
3. Connect your admin wallet on the site, open the Grand Chud panel, GO LIVE. Watch the first trade in the log and on Solscan.
4. For automatic agent wallets: set `MASTER_KEY` (`openssl rand -hex 32`, back it up), optionally `LIVE_ALLOWLIST`, `MAX_AGENT_SOL`. In the LIVE panel: CREATE AGENT WALLET, deposit, START AUTO TRADING.
5. To stop: KILL SWITCH (stops buys) or STOP LIVE BUYS (Grand Chud winds down to paper once flat).

`LIVE_TRADING` is refused when `MARKET=sim`. `server/live.js` holds all mainnet code.
