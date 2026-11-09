# CHUD OS

Terminal-style Solana meme coin agent platform.

- **Connect a wallet** (Phantom, Solflare, Backpack). You sign a one-time message to prove ownership; no transaction is ever requested.
- **Your agent** pulls your swap history, rebuilds it into round trips, diagnoses your habits (bag holding, paper hands, tilt, revenge sizing, rug magnet, bad hours), then learns exit and discipline rules by replaying your own trades. It's graded walk-forward: rules learned on your first 60% of trades, scored on the last 40% it never saw. It then runs a 10 SOL paper book, shadowing your new buys with its own exits and scouting on its own.
- **The Grand Chud** pools every connected or fed wallet (size-normalised), fits shared rules, weights each wallet by a skill score, and buys what the most skilled wallets are buying ("consensus"), on its own paper book.

**Execution is paper only.** `server/execution.js` throws on purpose. Live trading needs an explicit opt-in.

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
