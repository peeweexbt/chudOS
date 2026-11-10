import { mountHero } from './hero.js';
// CHUD OS client. No framework: panels are re-rendered from /api state every few seconds.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const sol = (x, d = 2) => `${x >= 0 ? '+' : ''}${(+x || 0).toFixed(d)}`;
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const cls = (x) => (x >= 0 ? 'up' : 'dn');
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`; };

let token = null; try { token = localStorage.getItem('chud.token'); } catch {}
let cfg = {}; let me = null; let grand = null; let board = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---------- boot ----------
const BANNER = String.raw`
  ██████╗██╗  ██╗██╗   ██╗██████╗      ██████╗ ███████╗
 ██╔════╝██║  ██║██║   ██║██╔══██╗    ██╔═══██╗██╔════╝
 ██║     ███████║██║   ██║██║  ██║    ██║   ██║███████╗
 ██║     ██╔══██║██║   ██║██║  ██║    ██║   ██║╚════██║
 ╚██████╗██║  ██║╚██████╔╝██████╔╝    ╚██████╔╝███████║
  ╚═════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝      ╚═════╝ ╚══════╝`;
async function boot() {
  cfg = await api('/api/config').catch(() => ({}));
  const lines = [BANNER, '',
    `> BIOS ............................................. OK`,
    `> mounting /dev/solana ............................. OK`,
    `> market feed ................................ ${(cfg.market || '?').toUpperCase().padStart(6)}`,
    `> trade history source ....................... ${(cfg.history || '?').toUpperCase().padStart(6)}`,
    `> execution mode ............................. ${'PAPER'.padStart(6)}`,
    `> waking the Grand Chud ............................ OK`, ''];
  const el = $('#boot-log');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const l of lines) { el.textContent += l + '\n'; if (!reduce) await new Promise((r) => setTimeout(r, l === BANNER ? 250 : 120)); }
  if (token) { try { await refresh(); return enter(); } catch { token = null; } }
  $('#boot-actions').hidden = false;
  $('#boot-actions .primary').focus();
}
$('#boot-actions').addEventListener('click', async (e) => {
  const act = e.target.dataset.act; if (!act) return;
  if (act === 'enter') return enter();
  enter(); await run(act === 'phantom' ? 'connect phantom' : act);
});
// terminal popup: always visible, can be minimised to its title bar
function setTermMin(min) { $('#term').classList.toggle('min', min); $('#os').classList.toggle('term-min', min); $('#term-min').textContent = min ? '▢' : '_'; $('#term-min').setAttribute('aria-label', min ? 'restore terminal' : 'minimise terminal'); try { localStorage.setItem('chud.termMin', min ? '1' : ''); } catch {} }
$('.term-head').addEventListener('click', () => setTermMin(!$('#term').classList.contains('min')));
try { if (localStorage.getItem('chud.termMin')) setTermMin(true); } catch {}
function enter() { $('#boot').hidden = true; $('#os').hidden = false; $('#cmd').focus(); render(); help(true); checkBust(); }

// ---------- wallet connect ----------
function providers() {
  const out = [];
  if (window.phantom?.solana?.isPhantom) out.push(['phantom', window.phantom.solana]);
  if (window.solflare?.isSolflare) out.push(['solflare', window.solflare]);
  if (window.backpack?.isBackpack) out.push(['backpack', window.backpack]);
  if (!out.length && window.solana) out.push(['solana', window.solana]);
  return out;
}
const MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
function noPhantom() {
  if (MOBILE) { // reopen this page inside Phantom's in-app browser
    print('opening CHUD OS inside the Phantom app…');
    location.href = `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;
  } else {
    print('Phantom not detected. Install it, refresh this page, then hit CONNECT PHANTOM again.', 'e');
    window.open('https://phantom.com/download', '_blank', 'noopener');
  }
}
async function connect(name) {
  const ps = providers();
  if (name === 'phantom' && !ps.some(([n]) => n === 'phantom')) return noPhantom();
  const p = (name && ps.find(([n]) => n === name)) || ps[0];
  if (!p) { print('No Solana wallet extension found. Install Phantom, Solflare or Backpack — or type "demo".', 'e'); return; }
  const [pname, prov] = p;
  print(`handshake with ${pname}…`);
  const res = await prov.connect();
  const address = (res?.publicKey || prov.publicKey).toString();
  const { message } = await api(`/api/auth/nonce?address=${address}`);
  print('requesting signature (proves ownership, moves no funds)…');
  const signed = await prov.signMessage(new TextEncoder().encode(message), 'utf8');
  const sig = signed?.signature || signed;
  print('pulling trade history + training your agent. this can take a few seconds…');
  const r = await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ address, message, signature: b58(new Uint8Array(sig)) }) });
  setToken(r.token); await refresh();
  print(`linked ${short(address)}. agent ${me.agent?.id} "${me.agent?.callsign}" is online.`, 'ok');
}
async function demo() {
  print('minting a throwaway demo wallet with synthetic meme coin history…');
  const r = await api('/api/auth/demo', { method: 'POST' });
  setToken(r.token); await refresh();
  print(`demo wallet ${short(r.wallet.address)} linked. agent ${me.agent?.id} "${me.agent?.callsign}" is online.`, 'ok');
}
function setToken(t) { token = t; try { t ? localStorage.setItem('chud.token', t) : localStorage.removeItem('chud.token'); } catch {} }
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  const d = [0]; for (const byte of bytes) { let c = byte; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
  let s = ''; for (const b of bytes) { if (b) break; s += '1'; } for (let i = d.length - 1; i >= 0; i--) s += ALPH[d[i]];
  return s.replace(/^1(?=[1-9A-Za-z])/, (m) => (bytes[0] === 0 ? m : ''));
}

// ---------- terminal ----------
function print(msg, kind = '') { if (kind === 'e' || kind === 'ok') setTermMin(false); const o = $('#out'); const line = document.createElement('div'); line.className = kind; line.textContent = msg; o.append(line); o.scrollTop = o.scrollHeight; }
function help(short) {
  if (short) return print('CHUD OS ready. type "help" for commands.', 'w');
  print([
    'connect [phantom|solflare|backpack]  link your wallet (signature only, no funds move)',
    'demo                                 try it with a synthetic wallet',
    'sync                                 re-pull your history and retrain your agent',
    'agent pause|resume|reset             control your agent\'s paper book',
    'feed <address>                       feed any wallet to the Grand Chud (read-only)',
    'inspect <address>                    show a fed wallet\'s stats',
    'market                               top tokens the agents are watching',
    'live on|off                          let your agent propose real trades you sign in Phantom',
    'approve [n] | reject [n]             act on your agent\'s nth open live proposal',
    'agentwallet | auto on|off           automatic agent wallet: create, start/stop',
    'closeall | withdraw | exportkey      sell everything, pull SOL back to you, export the key',
    'kill | unkill | golive | stoplive    admin: kill switch, Grand Chud live mode',
    'logout | clear | help'].join('\n'));
}
const history = []; let hi = 0;
$('#prompt').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#cmd').value.trim(); $('#cmd').value = ''; if (!v) return; history.push(v); hi = history.length; print(`chud@os:~$ ${v}`, 'w'); run(v); });
$('#cmd').addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' && hi > 0) { $('#cmd').value = history[--hi]; e.preventDefault(); } if (e.key === 'ArrowDown') { $('#cmd').value = history[++hi] || ''; hi = Math.min(hi, history.length); } });
document.addEventListener('click', (e) => { const c = e.target.closest('[data-cmd]')?.dataset.cmd; if (c) { print(`chud@os:~$ ${c}`, 'w'); run(c); } });

async function run(line) {
  const [cmd, ...args] = line.split(/\s+/);
  try {
    switch (cmd.toLowerCase()) {
      case 'help': case '?': return help();
      case 'clear': $('#out').textContent = ''; return;
      case 'connect': return await connect(args[0]);
      case 'demo': return await demo();
      case 'live': {
        if (args[0] === 'on') return liveOptIn();
        if (args[0] === 'off') { await api('/api/me/live', { method: 'POST', body: JSON.stringify({ enable: false }) }); await refresh(); return print('live proposals off.', 'ok'); }
        const L = cfg.live || {}; return print(`server live: ${L.serverEnabled ? 'enabled' : 'disabled'}${L.killed ? ` · KILL SWITCH (${L.killedReason})` : ''}\nlimits: ${limitsText(L.limits)}\nusage: live on|off`);
      }
      case 'agentwallet': await api('/api/me/agent-wallet', { method: 'POST' }); await refresh(); return print(`agent wallet ready: ${me.agent.wallet}. deposit SOL to it.`, 'ok');
      case 'auto': {
        if (args[0] === 'off') { await api('/api/me/auto', { method: 'POST', body: JSON.stringify({ enable: false }) }); await refresh(); return print('auto buying off.', 'ok'); }
        const r = await modal(`${WARNING}<p>Your agent will trade <b>by itself</b> from its agent wallet ${esc(me.agent?.wallet || '')}, using at most ${cfg.live?.limits ? esc(cfg.live.maxAgentSol) : ''} SOL, within: ${esc(limitsText(cfg.live?.limits))}. It stops buying on its own if it loses ${Math.round((cfg.live?.limits?.dailyLossKill || 0) * 100)}% in a day.</p><label>Type <b>I UNDERSTAND</b> <input name="confirm" autocomplete="off" required></label>`);
        if (!r) return print('cancelled.');
        await api('/api/me/auto', { method: 'POST', body: JSON.stringify({ enable: true, confirm: r.confirm.trim().toUpperCase() }) }); await refresh(); return print('AUTO TRADING ON. your agent is trading real SOL.', 'e');
      }
      case 'closeall': { print('selling every live position…'); const r = await api('/api/me/close-all', { method: 'POST' }); await refresh(); return print(`closed ${r.closed}. ${r.remaining ? `${r.remaining} could not be sold yet, retry.` : 'flat.'}`, 'ok'); }
      case 'withdraw': { print('withdrawing all SOL to your wallet…'); const r = await api('/api/me/withdraw', { method: 'POST' }); await refresh(); return print(`withdrew ${r.sol.toFixed(4)} SOL. tx ${r.sig.slice(0, 10)}…`, 'ok'); }
      case 'exportkey': return exportKey();
      case 'approve': { const x = openProposals()[+(args[0] || 1) - 1]; if (!x) return print('no such proposal.', 'e'); return approve(x.id); }
      case 'reject': { const x = openProposals()[+(args[0] || 1) - 1]; if (!x) return print('no such proposal.', 'e'); await api(`/api/me/proposals/${x.id}/reject`, { method: 'POST' }); await refresh(); return print('rejected.', 'ok'); }
      case 'kill': await api('/api/admin/kill', { method: 'POST', body: JSON.stringify({ reason: args.join(' ') || 'manual kill switch' }) }); await refresh(); return print('KILL SWITCH ENGAGED. all live buying stopped.', 'e');
      case 'unkill': await api('/api/admin/unkill', { method: 'POST' }); await refresh(); return print('kill switch released.', 'ok');
      case 'golive': return grandLive(true);
      case 'stoplive': return grandLive(false);
      case 'itsover': return itsOver({ id: 'PREVIEW', busted: Date.now() });
      case 'logout': setToken(null); me = null; render(); return print('session wiped.');
      case 'sync': if (!token) return print('connect first.', 'e'); print('resyncing…'); await api('/api/me/sync', { method: 'POST' }); await refresh(); return print('agent retrained.', 'ok');
      case 'agent': { if (!token) return print('connect first.', 'e'); const a = args[0]; if (!['pause', 'resume', 'reset'].includes(a)) return print('usage: agent pause|resume|reset', 'e'); await api(`/api/me/agent/${a}`, { method: 'POST' }); await refresh(); return print(`agent ${a}d.`, 'ok'); }
      case 'feed': { if (!args[0]) return print('usage: feed <solana address>', 'e'); print(`feeding ${short(args[0])} to the Grand Chud…`); const r = await api('/api/feed', { method: 'POST', body: JSON.stringify({ address: args[0] }) }); await refresh(); return print(`ingested ${r.wallet.stats.trades} round trips. skill ${r.wallet.skill}.`, 'ok'); }
      case 'inspect': { const { wallet: w } = await api(`/api/wallet/${args[0]}`); return print(`${w.address}\n trades ${w.stats.trades}  win ${pct(w.stats.winRate)}  pnl ${sol(w.stats.pnlSol)} SOL  skill ${w.skill}\n ${w.diagnoses.map((d) => d.tag).join(' ')}`); }
      case 'market': { const m = await api('/api/market'); return print(m.tokens.map((t) => `${t.symbol.padEnd(10)} liq $${(t.liquidityUsd / 1e3).toFixed(0)}k  5m ${t.change5m.toFixed(1)}%  1h ${t.change1h.toFixed(1)}%`).join('\n') || 'no tokens yet'); }
      default: return print(`unknown command: ${cmd}. try "help".`, 'e');
    }
  } catch (e) { print(`ERR ${e.message}`, 'e'); }
}

// ---------- data + render ----------
async function refresh() {
  api('/api/config').then((c) => { cfg = c; }).catch(() => {});
  const [m, g, b] = await Promise.all([token ? api('/api/me').catch((e) => { if (/auth/.test(e.message)) setToken(null); return null; }) : null, api('/api/grand'), api('/api/leaderboard')]);
  me = m; grand = g.grand; board = b; render();
  checkBust();
}
function checkBust() { if (!$('#os').hidden) for (const bot of [me?.agent, grand]) if (bot?.busted && !seenBust(bot)) return itsOver(bot); }

// ---------- ITS OVER ----------
function avatar(b) {
  const over = !!b.busted;
  return `<img class="avatar ${over ? 'over' : ''}" src="${over ? '/its-over-sm.webp' : '/logo.png'}" alt="${over ? 'its over' : esc(b.callsign || b.id)}" title="${over ? 'out of SOL' : esc(b.id)}">`;
}
function seenBust(b) { try { return localStorage.getItem(`chud.bust.${b.id}`) === String(b.busted); } catch { return window.__bust?.[b.id] === b.busted; } }
function markBust(b) { try { localStorage.setItem(`chud.bust.${b.id}`, String(b.busted)); } catch { (window.__bust ||= {})[b.id] = b.busted; } }
let overActive = false;
function itsOver(b) {
  if (overActive || $('#os').hidden) return; markBust(b); overActive = true;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ov = document.createElement('div'); ov.className = 'its-over'; ov.setAttribute('role', 'alertdialog'); ov.setAttribute('aria-label', `${b.id} is out of SOL`);
  ov.innerHTML = `<div class="its-over-card"><img src="/its-over.webp" alt="ITS OVER"><p>${esc(b.callsign ? `${b.id} "${b.callsign}"` : b.id)} IS OUT OF SOL</p><small>${b.owner ? 'type "agent reset" to give it a fresh 10 SOL · ' : ''}click to dismiss</small></div>`;
  document.body.append(ov);
  print(`!!! ${b.id} IS OUT OF SOL. ITS OVER.`, 'e');
  const timers = [];
  if (!reduce) {
    // spray copies all over the screen in bursts (kept under 3 flashes/sec)
    for (let i = 0; i < 42; i++) timers.push(setTimeout(() => {
      const im = document.createElement('img'); im.src = '/its-over.webp'; im.alt = ''; im.className = 'spray';
      const w = 90 + Math.random() * 220;
      Object.assign(im.style, { width: `${w}px`, left: `${Math.random() * 100 - 8}vw`, top: `${Math.random() * 100 - 10}vh`, transform: `rotate(${(Math.random() - 0.5) * 50}deg)`, filter: Math.random() < 0.4 ? 'invert(1) sepia(1) hue-rotate(70deg) saturate(6)' : 'none' });
      ov.insertBefore(im, ov.firstChild);
    }, i * 90));
    ov.classList.add('flashing');
    timers.push(setTimeout(() => ov.classList.remove('flashing'), 4200));
  }
  const close = () => { timers.forEach(clearTimeout); ov.remove(); overActive = false; removeEventListener('keydown', onKey); $('#cmd').focus(); };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') close(); };
  ov.addEventListener('click', close); addEventListener('keydown', onKey);
}
setInterval(() => { if (!$('#os').hidden) refresh().catch(() => {}); }, 4000);
setInterval(() => { $('#clock').textContent = new Date().toISOString().slice(11, 19) + ' UTC'; }, 1000);

function render() {
  const L = cfg.live || {}; const userLive = me?.agent?.liveBook?.enabled;
  const exec = L.killed ? '<span class="pill dn blink">KILL SWITCH</span>' : (cfg.grandLive || userLive) ? '<span class="pill dn">EXEC: LIVE</span>' : L.serverEnabled ? '<span class="pill am">EXEC: PAPER · LIVE READY</span>' : '<span class="pill am">EXEC: PAPER</span>';
  $('#status').innerHTML = `${exec}<span>MKT: ${esc((cfg.market || '').toUpperCase())}</span><span>HIST: ${esc((cfg.history || '').toUpperCase())}</span>${board ? `<span>WALLETS: ${board.rows.length}</span>` : ''}`;
  renderWallet(); renderAgent(); renderLive(); renderGrand(); renderBoard();
}

function renderWallet() {
  const w = me?.wallet;
  const bw = $('#bar-wallet');
  if (w) { bw.textContent = `● ${short(w.address)}`; bw.className = 'btn mini linked'; bw.dataset.cmd = 'sync'; bw.title = 'linked · click to resync'; }
  else { bw.textContent = '👻 CONNECT PHANTOM'; bw.className = 'btn mini phantom'; bw.dataset.cmd = 'connect phantom'; bw.title = ''; }
  $('#wallet-tag').textContent = w ? (me.demoLogin ? 'DEMO' : w.verified ? 'VERIFIED' : 'WATCH') : 'OFFLINE';
  if (!w) { $('#wallet-body').innerHTML = `<p class="dim">No wallet linked.</p><p><button class="btn primary phantom" data-cmd="connect phantom">[ 👻 CONNECT PHANTOM ]</button></p><p><button class="btn ghost" data-cmd="connect">[ OTHER WALLET ]</button> <button class="btn ghost" data-cmd="demo">[ DEMO ]</button></p>`; $('#diag-body').innerHTML = '<p class="dim">Awaiting trade history…</p>'; $('#trips-body').innerHTML = ''; return; }
  const s = w.stats;
  $('#wallet-body').innerHTML = `<dl class="kv">
    <dt>wallet</dt><dd title="${esc(w.address)}">${short(w.address)}</dd>
    <dt>round trips</dt><dd>${s.trades}</dd>
    <dt>win rate</dt><dd>${pct(s.winRate)}</dd>
    <dt>realised pnl</dt><dd class="${cls(s.pnlSol)}">${sol(s.pnlSol)} SOL</dd>
    <dt>median size</dt><dd>${s.medianSize.toFixed(2)} SOL</dd>
    <dt>median winner</dt><dd>${(s.medWinMult || 0).toFixed(2)}x</dd>
    <dt>median loser</dt><dd>${(s.medLossMult || 0).toFixed(2)}x</dd>
    <dt>hold win / loss</dt><dd>${(s.holdWinH || 0).toFixed(1)}h / ${(s.holdLossH || 0).toFixed(1)}h</dd>
    <dt>skill score</dt><dd>${w.skill}</dd>
    <dt>source</dt><dd>${esc(w.source)} · synced ${ago(w.syncedAt)} ago</dd></dl>`;
  $('#diag-body').innerHTML = w.diagnoses.map((d) => `<div class="diag ${d.tag === 'CLEAN' ? 'ok' : ''}"><b>${esc(d.tag)}</b>${esc(d.text)}</div>`).join('');
  $('#trips-body').innerHTML = `<table><tr><th>token</th><th class="r">size</th><th class="r">x</th><th class="r">pnl</th><th class="r">held</th></tr>${w.recentTrips.map((t) => `<tr><td>${esc(t.symbol)}</td><td class="r">${t.costSol.toFixed(2)}</td><td class="r ${cls(t.multiple - 1)}">${t.multiple.toFixed(2)}</td><td class="r ${cls(t.pnlSol)}">${sol(t.pnlSol)}</td><td class="r">${(t.holdSec / 3600).toFixed(1)}h</td></tr>`).join('')}</table>`;
}

function renderAgent() {
  const a = me?.agent, w = me?.wallet;
  $('#agent-tag').textContent = a ? `${a.id} · ${a.callsign}` : '—';
  if (!a) { $('#versus-body').innerHTML = '<p class="dim">An agent is assigned once a wallet is linked.</p>'; $('#agent-body').innerHTML = ''; return; }
  const o = w?.backtest?.outOfSample;
  $('#versus-body').innerHTML = (o ? `
    <div class="vs">
      <div class="side you"><div class="lbl">YOU</div><div class="big ${''}">${sol(o.youPnl)}</div><div class="wd">SOL · ${pct(o.youWinRate)} win</div></div>
      <div class="x">VS</div>
      <div class="side bot">${avatar(a)}<div class="lbl">${esc(a.callsign)}</div><div class="big">${sol(o.agentPnl)}</div><div>SOL · ${pct(o.agentWinRate)} win</div></div>
    </div>
    <p class="dim">Walk-forward test: rules learned on your first 60% of trades, replayed on the last ${o.trades} trades it never saw (${o.agentSkipped} skipped by guards). ${o.agentPnl > o.youPnl ? `<span class="up">Agent beats you by ${(o.agentPnl - o.youPnl).toFixed(2)} SOL.</span>` : '<span class="am">You beat the agent on this sample. Respect.</span>'}</p>`
    : `<div class="solo">${avatar(a)}<p class="dim">Need 12+ closed round trips for a fair backtest. Agent is running on default rules.</p></div>`) +
    `<div class="rules">RULES › <code>${esc(a.policyText)}</code> · time stop ${a.maxHoldH.toFixed(1)}h</div>`;
  $('#agent-body').innerHTML = book(a);
  document.querySelector('#p-agent h2 span').textContent = a.mode === 'live' ? '// AGENT BOOK · LIVE SOL' : '// AGENT PAPER BOOK';
}

function book(b) {
  const paused = b.busted ? '<span class="dn blink">ITS OVER · OUT OF SOL</span>' : b.status !== 'running' ? '<span class="am">PAUSED</span>' : b.pausedUntil && b.pausedUntil > Date.now() ? `<span class="am">COOLDOWN ${ago(2 * Date.now() - b.pausedUntil)}</span>` : b.mode === 'live' ? '<span class="dn">LIVE·MAINNET</span>' : '<span class="up">LIVE·PAPER</span>';
  return `<dl class="kv">
    <dt>status</dt><dd>${paused}</dd>
    <dt>equity</dt><dd>${b.equity.toFixed(3)} SOL <span class="${cls(b.pnl)}">(${sol(b.pnl, 3)})</span></dd>
    <dt>closed</dt><dd>${b.wins}W / ${b.losses}L</dd></dl>
    <pre class="chart" aria-label="equity curve">${chart(b.equityCurve, b.start)}</pre>
    <div class="sub">OPEN POSITIONS</div>
    ${b.positions.length ? `<table><tr><th>token</th><th class="r">cost</th><th class="r">x</th><th class="r">age</th><th>why</th></tr>${b.positions.map((p) => `<tr><td>${esc(p.symbol)}</td><td class="r">${p.cost.toFixed(2)}</td><td class="r ${cls(p.mult - 1)}">${p.mult.toFixed(2)}</td><td class="r">${p.ageMin.toFixed(0)}m</td><td class="dim">${esc(p.reason)}</td></tr>`).join('')}</table>` : '<p class="dim">flat.</p>'}
    <div class="sub">LOG</div>
    <ul class="log">${b.log.map((l) => `<li class="${l.kind}"><span class="t">${new Date(l.ts).toISOString().slice(11, 19)}</span> ${esc(l.msg)}</li>`).join('')}</ul>`;
}

function chart(vals, base, H = 7, W = 56) {
  if (!vals?.length) return '';
  const v = vals.length > W ? vals.filter((_, i) => i % Math.ceil(vals.length / W) === 0).concat(vals[vals.length - 1]) : vals;
  const lo = Math.min(...v, base), hi = Math.max(...v, base), rng = hi - lo || 1;
  const rows = Array.from({ length: H }, () => Array(v.length).fill(' '));
  const blocks = ' ▁▂▃▄▅▆▇█';
  v.forEach((x, i) => { const h = ((x - lo) / rng) * H; for (let r = 0; r < H; r++) { const fill = h - r; rows[H - 1 - r][i] = fill >= 1 ? '█' : fill > 0 ? blocks[Math.round(fill * 8)] : ' '; } });
  const baseRow = H - 1 - Math.floor(((base - lo) / rng) * (H - 0.001));
  return rows.map((r, i) => `${(i === 0 ? hi : i === H - 1 ? lo : i === baseRow ? base : '').toString().slice(0, 6).padStart(6)} │${r.join('')}`).join('\n');
}

function renderGrand() {
  const g = grand;
  if (!g) { $('#grand-body').innerHTML = '<p class="dim">dormant.</p>'; return; }
  $('#grand-tag').textContent = g.mode === 'live' ? (g.liveOn ? 'LIVE · MAINNET' : 'LIVE · SELL-ONLY') : `${g.wallets || 0} WALLETS FED`;
  $('#grand-tag').className = g.mode === 'live' ? 'tag dn' : 'tag';
  const o = g.backtest;
  $('#grand-body').innerHTML = `
    <div class="solo">${avatar(g)}<p class="dim">Learns from every wallet that connects or is fed. Pools their trades (size-normalised), fits shared exit + discipline rules, and buys what the most skilled wallets are buying.</p></div>
    <dl class="kv">
      <dt>trained on</dt><dd>${g.trades || 0} trades · ${g.trainedAt ? ago(g.trainedAt) + ' ago' : '—'}</dd>
      ${o ? `<dt>walk-forward</dt><dd>crowd ${sol(o.youPnl, 1)}u → chud <span class="${cls(o.agentPnl - o.youPnl)}">${sol(o.agentPnl, 1)}u</span></dd>` : ''}
    </dl>
    <div class="rules">RULES › <code>${esc(g.policyText || '')}</code></div>
    ${g.mode === 'live' ? `<p class="dn">Trading real SOL from <span title="${esc(g.wallet)}">${short(g.wallet)}</span>.</p>` : ''}
    ${me?.isAdmin ? adminControls(g) : ''}
    <div class="sub">CONSENSUS (last 6h)</div>
    ${g.consensus?.length ? `<table><tr><th>token</th><th class="r">wallets</th><th class="r">score</th></tr>${g.consensus.slice(0, 6).map((c) => `<tr><td>${esc(c.symbol)}</td><td class="r">${c.wallets.length}</td><td class="r">${c.score.toFixed(2)}</td></tr>`).join('')}</table>` : '<p class="dim">no skilled wallet has bought anything recently.</p>'}
    <div class="sub">BOOK</div>
    ${book(g)}`;
}

function renderBoard() {
  const b = board; if (!b) return;
  $('#board-body').innerHTML = `<table><tr><th>#</th><th>wallet</th><th class="r">skill</th><th class="r">pnl</th><th class="r">agent</th></tr>
    ${b.grand ? `<tr><td>★</td><td class="up">GRAND CHUD</td><td class="r">—</td><td class="r">—</td><td class="r ${cls(b.grand.pnl)}">${b.grand.busted ? '<img class="av-xs" src="/its-over-sm.webp" alt="its over"> ' : ''}${sol(b.grand.pnl, 3)}</td></tr>` : ''}
    ${b.rows.map((r, i) => `<tr><td>${i + 1}</td><td class="${me?.wallet?.address === r.address ? 'w' : ''}">${short(r.address)}${r.demo ? ' <span class="dim">demo</span>' : r.verified ? ' ✓' : ''}</td><td class="r">${r.skill}</td><td class="r ${cls(r.pnlSol)}">${sol(r.pnlSol, 1)}</td><td class="r ${r.agent ? cls(r.agent.pnl) : 'dim'}">${r.agent?.busted ? '<img class="av-xs" src="/its-over-sm.webp" alt="its over"> ' : ''}${r.agent ? sol(r.agent.pnl, 3) : '—'}</td></tr>`).join('')}</table>
    <p class="dim">wallet pnl = realised history · agent pnl = paper book since assignment (SOL)</p>`;
}

// ---------- LIVE TRADING ----------
const limitsText = (l = {}) => `${l.maxTradeSol} SOL/trade · ${l.maxDailySol} SOL/day · ${l.maxOpen} open · ${(l.slippageBps || 0) / 100}% max slippage · $${Math.round((l.minLiqUsd || 0) / 1000)}k min liquidity · auto-kill at -${Math.round((l.dailyLossKill || 0) * 100)}%/day`;
function autoSection(L) {
  const a = me.agent; const live = a.mode === 'live';
  if (!L.serverEnabled) return '';
  if (!L.custody) return '<p class="dim">Automatic agent wallets are not configured on this server.</p>';
  if (!me.mayAutoTrade) return '<p class="dim">Automatic trading is invite-only right now.</p>';
  let h = '<div class="sub">AUTOMATIC · AGENT WALLET</div>';
  if (!a.wallet) return h + `<p>Your agent gets its own wallet and trades it by itself. You deposit SOL, it trades within the limits, and withdrawals only ever go back to your wallet.</p><button class="btn danger" data-cmd="agentwallet">[ CREATE AGENT WALLET ]</button>`;
  h += `<dl class="kv"><dt>agent wallet</dt><dd><button class="copy" data-copy="${esc(a.wallet)}" title="copy address">${short(a.wallet)} ⧉</button></dd>
    <dt>balance</dt><dd>${a.walletBal == null ? '…' : `${(+a.walletBal).toFixed(4)} SOL`}</dd><dt>uses at most</dt><dd>${L.maxAgentSol} SOL</dd>
    <dt>status</dt><dd>${live ? (a.liveOn ? '<span class="dn blink">AUTO TRADING</span>' : '<span class="am">SELL-ONLY (winding down)</span>') : 'off (paper)'}</dd></dl>`;
  if (!live) h += `<p class="dim">Deposit SOL to the address above from your wallet, then start.</p><button class="btn danger" data-cmd="auto on">[ START AUTO TRADING ]</button>`;
  else h += `<p>${a.liveOn ? '<button class="btn mini ghost" data-cmd="auto off">STOP BUYING</button>' : '<button class="btn mini danger" data-cmd="auto on">RESUME</button>'} <button class="btn mini ghost" data-cmd="closeall">CLOSE ALL</button></p>`;
  h += `<p><button class="btn mini ghost" data-cmd="withdraw">WITHDRAW TO MY WALLET</button> <button class="btn mini ghost" data-cmd="exportkey">EXPORT KEY</button></p>`;
  return h;
}
document.addEventListener('click', (e) => { const c = e.target.closest('[data-copy]')?.dataset.copy; if (c) { navigator.clipboard?.writeText(c); print(`copied ${c}`, 'ok'); } });
async function exportKey() {
  const prov = window.phantom?.solana || providers()[0]?.[1]; if (!prov) throw new Error('Phantom not found');
  if (!prov.publicKey) await prov.connect();
  const { message } = await api(`/api/auth/nonce?address=${me.wallet.address}`);
  const signed = await prov.signMessage(new TextEncoder().encode(message), 'utf8');
  const r = await api('/api/me/agent-wallet/export', { method: 'POST', body: JSON.stringify({ message, signature: b58(new Uint8Array(signed?.signature || signed)) }) });
  await modal(`<h3>AGENT WALLET KEY</h3><p>Anyone with this key controls the agent wallet. Import it into Phantom if you ever need to move funds yourself. Never share it.</p><label>address<input readonly value="${esc(r.address)}"></label><label>private key<input readonly value="${esc(r.secretKey)}" onclick="this.select()"></label>`);
}
const openProposals = () => (me?.agent?.liveBook?.proposals || []).filter((x) => ['pending', 'built'].includes(x.status));
function renderLive() {
  const L = cfg.live || {}; const lb = me?.agent?.liveBook; const tag = $('#live-tag');
  tag.textContent = L.killed ? 'KILLED' : lb?.enabled ? 'ON' : L.serverEnabled ? 'READY' : 'OFF'; tag.className = `tag ${L.killed || lb?.enabled ? 'dn' : ''}`;
  let h = '';
  if (L.killed) h += `<div class="diag"><b>KILL SWITCH ENGAGED</b>${esc(L.killedReason || '')}. No live buys until an admin releases it. Sells still allowed.</div>`;
  if (!L.serverEnabled) h += '<p class="dim">Live trading is switched off on this server. Everything is paper.</p>';
  h += `<p class="dim">LIMITS › ${esc(limitsText(L.limits))}</p>`;
  if (!me?.wallet) h += '<p class="dim">Connect Phantom to let your agent propose real trades.</p>';
  else if (me.demoLogin) h += '<p class="dim">Demo wallets cannot trade live.</p>';
  else if (me.agent) h += autoSection(L);
  if (!me?.wallet || me.demoLogin || me.agent?.mode === 'live') {}
  else if (!lb?.enabled) h += L.serverEnabled ? `<div class="sub">OR: APPROVE EACH TRADE</div><p class="dim">Your agent proposes swaps from <b>your</b> Phantom wallet and you sign every one.</p><button class="btn ghost mini" data-cmd="live on">[ ENABLE PROPOSALS ]</button>` : '';
  else {
    const pending = openProposals();
    h += `<dl class="kv"><dt>per trade</dt><dd>${lb.tradeSol || L.limits?.maxTradeSol} SOL</dd><dt>spent today</dt><dd>${(lb.spentToday || 0).toFixed(3)} / ${L.limits?.maxDailySol} SOL</dd><dt>realised</dt><dd class="${cls(lb.realized)}">${sol(lb.realized, 4)} SOL</dd></dl>`;
    h += `<div class="sub">AWAITING YOUR SIGNATURE</div>` + (pending.length ? pending.map((x, i) => `<div class="prop"><span><b>${i + 1}. ${x.side.toUpperCase()} ${esc(x.symbol)}</b> ${x.side === 'buy' ? `${x.sizeSol} SOL` : `${Math.round(x.frac * 100)}%`} <span class="dim">${esc(x.reason)} · ${Math.max(0, Math.round((x.expiresAt - Date.now()) / 1000))}s</span></span><span><button class="btn mini ok" data-approve="${x.id}">SIGN</button> <button class="btn mini ghost" data-cmd="reject ${i + 1}">X</button></span></div>`).join('') : '<p class="dim">nothing yet. the agent proposes when it would trade.</p>');
    const sub = (lb.proposals || []).filter((x) => x.status === 'submitted');
    if (sub.length) h += `<p class="am">${sub.length} swap(s) confirming on-chain…</p>`;
    h += `<div class="sub">LIVE POSITIONS</div>` + (lb.positions.length ? `<table><tr><th>token</th><th class="r">cost</th><th class="r">x</th><th class="r">age</th></tr>${lb.positions.map((p) => `<tr><td>${esc(p.symbol)}</td><td class="r">${p.cost.toFixed(3)}</td><td class="r ${cls(p.mult - 1)}">${p.mult.toFixed(2)}</td><td class="r">${p.ageMin.toFixed(0)}m</td></tr>`).join('')}</table>` : '<p class="dim">flat.</p>');
    h += `<p><button class="btn ghost mini" data-cmd="live off">[ TURN LIVE OFF ]</button></p>`;
  }
  $('#live-body').innerHTML = h;
}
document.addEventListener('click', (e) => { const id = e.target.closest('[data-approve]')?.dataset.approve; if (id) approve(id); });

function modal(html) {
  return new Promise((resolve) => {
    const m = document.createElement('div'); m.className = 'modal'; m.setAttribute('role', 'dialog');
    m.innerHTML = `<form class="modal-card">${html}<div class="row"><button type="button" class="btn ghost" data-x>[ CANCEL ]</button><button class="btn danger">[ CONFIRM ]</button></div></form>`;
    document.body.append(m); const f = m.querySelector('form'); f.querySelector('input')?.focus();
    m.querySelector('[data-x]').onclick = () => { m.remove(); resolve(null); };
    f.onsubmit = (e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(f)); m.remove(); resolve(data); };
  });
}
const WARNING = `<h3>⚠ REAL MONEY</h3><ul><li>Meme coins are extremely risky. Most go to zero, many are rugs. Assume you will lose everything you put in.</li><li>The agent's backtest and paper results do not predict live results. Slippage, fees and failed transactions are real.</li><li>Nothing here is financial advice.</li></ul>`;
async function liveOptIn() {
  const L = cfg.live || {};
  const r = await modal(`${WARNING}<p>Your agent will <b>propose</b> swaps from your wallet. You sign every one in Phantom. Limits: ${esc(limitsText(L.limits))}.</p>
    <label>SOL per trade (max ${L.limits?.maxTradeSol}) <input name="tradeSol" type="number" step="0.001" min="0.001" max="${L.limits?.maxTradeSol}" value="${L.limits?.maxTradeSol}"></label>
    <label>Type <b>I UNDERSTAND</b> <input name="confirm" autocomplete="off" required></label>`);
  if (!r) return print('cancelled.');
  await api('/api/me/live', { method: 'POST', body: JSON.stringify({ enable: true, confirm: r.confirm.trim().toUpperCase(), tradeSol: +r.tradeSol }) });
  await refresh(); print('live proposals ON. approve trades in the LIVE panel.', 'ok');
}
async function grandLive(on) {
  let confirm;
  if (on) { const r = await modal(`${WARNING}<p>The Grand Chud will buy and sell on its own from its dedicated wallet, within: ${esc(limitsText(cfg.live?.limits))}.</p><label>Type <b>I UNDERSTAND</b> <input name="confirm" autocomplete="off" required></label>`); if (!r) return print('cancelled.'); confirm = r.confirm.trim().toUpperCase(); }
  await api('/api/admin/grand', { method: 'POST', body: JSON.stringify({ on, confirm }) }); await refresh();
  print(on ? 'GRAND CHUD IS LIVE ON MAINNET.' : 'Grand Chud live buying off.', on ? 'e' : 'ok');
}
function adminControls(g) {
  const L = cfg.live || {};
  return `<div class="admin"><span class="dim">ADMIN ›</span> ${L.serverEnabled ? (g.liveOn ? '<button class="btn mini ghost" data-cmd="stoplive">STOP LIVE BUYS</button>' : '<button class="btn mini danger" data-cmd="golive">GO LIVE</button>') : '<span class="dim">server live off</span>'}
    ${L.killed ? '<button class="btn mini ok" data-cmd="unkill">RELEASE KILL SWITCH</button>' : '<button class="btn mini danger" data-cmd="kill">KILL SWITCH</button>'}</div>`;
}

let web3p;
const loadWeb3 = () => (web3p ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/solana-web3-1.98.0.min.js'; s.onload = () => res(window.solanaWeb3); s.onerror = () => rej(new Error('could not load Solana library')); document.head.append(s); }));
let approving = false;
async function approve(id) {
  if (approving) return; approving = true;
  try {
    const prov = window.phantom?.solana || providers()[0]?.[1];
    if (!prov) throw new Error('Phantom not found');
    if (!prov.publicKey) await prov.connect();
    if (prov.publicKey.toString() !== me.wallet.address) throw new Error(`Phantom is on ${short(prov.publicKey.toString())}, switch it to ${short(me.wallet.address)}`);
    print('building swap via Jupiter…');
    const b = await api(`/api/me/proposals/${id}/build`, { method: 'POST' });
    const web3 = await loadWeb3();
    const tx = web3.VersionedTransaction.deserialize(Uint8Array.from(atob(b.tx), (c) => c.charCodeAt(0)));
    print(`sign the ${b.side} of ${b.symbol} in Phantom…`, 'w');
    const { signature } = await prov.signAndSendTransaction(tx);
    await api(`/api/me/proposals/${id}/submitted`, { method: 'POST', body: JSON.stringify({ signature }) });
    print(`sent. tx ${signature.slice(0, 10)}… confirming on-chain.`, 'ok'); await refresh();
  } catch (e) { print(`ERR ${e.message}`, 'e'); }
  finally { approving = false; }
}

document.querySelectorAll('canvas.hero').forEach((c) => mountHero(c).catch((e) => console.warn('hero', e)));
boot();
