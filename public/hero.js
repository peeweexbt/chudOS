// ASCII hero: plays public/frames.json on a canvas. Every frame is drawn on the same
// grid with the same split as the logo: left half white (human), right half green (machine).
// Frames transition with a scramble-decode; multi-frame GIF sources play at their own timing.
const GLYPHS = '.,:;-=+*#%@01<>/\\|[]{}$&';
const WHITE = '#f2f5f0', GREEN = '#3dff6e';

export async function mountHero(canvas) {
  const data = await fetch('/frames.json').then((r) => r.json());
  const { cols, rows, frames } = data;
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let cw = 0, ch = 0, dpr = 1;

  function size() {
    const w = canvas.clientWidth; dpr = window.devicePixelRatio || 1;
    cw = w / cols; ch = cw * 1.9;
    canvas.style.height = `${ch * rows}px`;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(ch * rows * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${Math.max(4, ch * 0.92)}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textBaseline = 'top';
  }

  // grid currently on screen
  let grid = frames[0].rows.map((r) => r.split(''));
  function draw(glitchRow = -1, shift = 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const mid = cols / 2;
    for (const [color, glow, from, to] of [[WHITE, 'rgba(255,255,255,.35)', 0, mid], [GREEN, 'rgba(61,255,110,.75)', mid, cols]]) {
      ctx.fillStyle = color; ctx.shadowColor = glow; ctx.shadowBlur = color === GREEN ? cw * 1.2 : cw * 0.4;
      for (let y = 0; y < rows; y++) {
        const dx = y === glitchRow ? shift : 0;
        const line = grid[y];
        for (let x = Math.floor(from); x < to; x++) { const c = line[x]; if (c && c !== ' ') ctx.fillText(c, x * cw + dx, y * ch); }
      }
    }
    // the logo's dotted seam down the middle
    ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(61,255,110,.55)';
    for (let y = 0; y < rows; y += 2) ctx.fillRect(mid * cw - 1, y * ch + ch * 0.3, 2, ch * 0.4);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frameLoop = (fn) => new Promise((done) => { const start = performance.now(); const step = (t) => (fn(t - start) ? requestAnimationFrame(step) : done()); requestAnimationFrame(step); });

  // scramble from current grid into target over `ms`
  async function morph(target, ms = 900) {
    const tgt = target.rows.map((r) => r.split(''));
    const delay = tgt.map((r, y) => r.map((_, x) => Math.random() * 0.6 + (Math.abs(x - cols / 2) / cols) * 0.4));
    const src = grid.map((r) => [...r]);
    await frameLoop((t) => {
      const p = Math.min(1, t / ms);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const d = delay[y][x];
        if (p >= d + 0.25) grid[y][x] = tgt[y][x];
        else if (p >= d) grid[y][x] = (tgt[y][x] !== ' ' || src[y][x] !== ' ') ? GLYPHS[(Math.random() * GLYPHS.length) | 0] : ' ';
        else grid[y][x] = src[y][x];
      }
      draw(); return p < 1;
    });
  }
  async function idle(ms) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (!reduce && Math.random() < 0.12) { draw((Math.random() * rows) | 0, (Math.random() - 0.5) * cw * 6); await wait(70); }
      draw(); await wait(140);
    }
  }

  size(); draw();
  new ResizeObserver(() => { size(); draw(); }).observe(canvas);
  if (document.fonts) document.fonts.ready.then(() => { size(); draw(); });
  if (reduce || frames.length < 2) return;

  // group frames by source image so GIF frames play as one clip
  const clips = [];
  for (const f of frames) { const key = f.src.split('#')[0]; const last = clips[clips.length - 1]; if (last?.key === key) last.frames.push(f); else clips.push({ key, frames: [f] }); }
  let i = 0;
  await idle(3500);
  for (;;) {
    i = (i + 1) % clips.length; const clip = clips[i];
    await morph(clip.frames[0]);
    if (clip.frames.length > 1) {
      for (let loop = 0; loop < 2; loop++) for (const f of clip.frames) { grid = f.rows.map((r) => r.split('')); draw(); await wait(f.hold || 90); }
    }
    await idle(i === 0 ? 4500 : 2800);
  }
}
