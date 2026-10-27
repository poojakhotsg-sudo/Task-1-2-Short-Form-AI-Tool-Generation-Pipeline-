import type { Page } from 'playwright';
import type { PageBlock } from './pageSections.js';

// Playwright-dependent recording choreography from grabber.py — ported
// faithfully (scroll/hover/drift timing, easing curve), not
// reinterpreted. Not unit-tested directly (needs a real browser); the
// pure parts live in pageSections.ts.

const VIEWPORT_W = 390;
const VIEWPORT_H = 844;

export const CURSOR_JS = `() => {
  if (window.__gvCursor) return;
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;' +
    'border-radius:50%;background:rgba(255,255,255,.85);border:3px solid rgba(0,0,0,.75);' +
    'box-shadow:0 2px 10px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;' +
    'transition:transform .08s;transform:translate(-100px,-100px)';
  document.documentElement.appendChild(c);
  window.__gvCursor = c;
  addEventListener('mousemove', e => c.style.transform = \`translate(\${e.clientX}px,\${e.clientY}px)\`, true);
}`;

export const SMOOTH_SCROLL_JS = `([target, ms]) => new Promise(res => {
  const start = scrollY, dist = target - start, t0 = performance.now();
  const ease = t => t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;
  const step = now => {
    const p = Math.min(1, (now - t0) / ms);
    scrollTo(0, start + dist * ease(p));
    p < 1 ? requestAnimationFrame(step) : res();
  };
  requestAnimationFrame(step);
})`;

export const HOVER_TARGETS_JS = `([bandTop, bandBottom]) => {
  const vh = innerHeight, vw = innerWidth;
  const els = [...document.querySelectorAll(
    'button, a[class*="btn" i], a[class*="button" i], [role="button"], [class*="card" i], img, video, picture, h2, h3')];
  const pts = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) continue;
    if (r.top < vh * 0.1 || r.bottom > vh * 0.92 || r.left < 0 || r.right > vw) continue;
    const pageY = r.top + scrollY;
    if (bandBottom > bandTop && (pageY < bandTop || pageY > bandBottom)) continue;
    pts.push([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
  }
  const out = [];
  for (const p of pts) if (!out.some(q => Math.hypot(p[0]-q[0], p[1]-q[1]) < 200)) out.push(p);
  return out.slice(0, 6);
}`;

async function hoverAround(page: Page, seconds: number, band: [number, number] = [0, 0]): Promise<void> {
  const end = Date.now() + seconds * 1000;
  let targets: [number, number][] =
    (await page.evaluate(HOVER_TARGETS_JS, band)) ||
    (await page.evaluate(HOVER_TARGETS_JS, [0, 0])) ||
    [[VIEWPORT_W / 2, VIEWPORT_H / 2]];
  if (targets.length === 0) targets = [[VIEWPORT_W / 2, VIEWPORT_H / 2]];

  let i = 0;
  while (Date.now() < end) {
    const [x, y] = targets[i % targets.length];
    await page.mouse.move(x, y, { steps: 25 });
    await page.waitForTimeout(700);
    i += 1;
  }
}

// grabber.py's record_shot(): scroll into the block, hover, drift.
// Returns [start, end] seconds into the recording (relative to t0),
// matching the Python monotonic-clock-relative-to-session-start
// convention exactly, since cut_clip() slices the continuous video
// recording using these same offsets.
export async function recordShot(
  page: Page,
  block: PageBlock,
  maxY: number,
  vh: number,
  seconds: number,
  t0: number
): Promise<[number, number]> {
  const offset = block.h < vh * 0.8 ? Math.floor((vh - block.h) / 2) : 40;
  const target = Math.min(Math.max(block.y - offset, 0), maxY);

  await page.evaluate((y) => window.scrollTo(0, y), Math.max(target - Math.floor(vh / 3), 0));
  await page.waitForTimeout(500);

  const start = (Date.now() - t0) / 1000;
  if (target > 0) {
    await page.evaluate(SMOOTH_SCROLL_JS, [target, 1500]);
  }
  await hoverAround(page, seconds * 0.5, [block.y, block.y + block.h]);

  const drift = Math.max(Math.min(block.h - Math.floor(vh / 2), Math.floor(vh / 3)), 120);
  await page.evaluate(SMOOTH_SCROLL_JS, [Math.min(target + drift, maxY), Math.floor(seconds * 300)]);

  const elapsedSinceStart = (Date.now() - t0) / 1000 - start;
  const left = seconds - elapsedSinceStart;
  if (left > 0) {
    await page.waitForTimeout(Math.floor(left * 1000));
  }
  return [start, (Date.now() - t0) / 1000];
}

const PLAY_VIDEOS_JS = `([top, bottom]) => {
  let n = 0;
  document.querySelectorAll('video').forEach(v => {
    const r = v.getBoundingClientRect(), y = r.top + scrollY;
    if (r.width < 80 || y + r.height < top || y > bottom) return;
    v.muted = true; v.loop = true;
    const p = v.play(); if (p) p.catch(() => {});
    n++;
  });
  return n;
}`;

// grabber.py's record_motion(): the static-clip retry — play the
// section's video(s), then scroll slowly through it while hovering
// buttons/cards (as opposed to recordShot's single scroll-in + hover +
// drift). Returns [start, end, videosPlayed].
export async function recordMotion(
  page: Page,
  block: PageBlock,
  maxY: number,
  vh: number,
  seconds: number,
  t0: number
): Promise<[number, number, number]> {
  const band: [number, number] = [block.y, block.y + block.h];
  const startY = Math.min(Math.max(block.y - Math.floor(vh / 5), 0), maxY);
  const endY = Math.min(
    Math.max(block.y + block.h - Math.floor((vh * 3) / 4), startY + Math.floor(vh / 2)),
    maxY
  );

  await page.evaluate((y) => window.scrollTo(0, y), startY);
  const played: number = await page.evaluate(PLAY_VIDEOS_JS, band);
  await page.waitForTimeout(400);

  const start = (Date.now() - t0) / 1000;
  const steps = Math.max(Math.floor(seconds / 0.6), 4);
  let targets: [number, number][] = [];

  for (let i = 0; i < steps; i++) {
    if (i % 3 === 0) {
      targets =
        (await page.evaluate(HOVER_TARGETS_JS, band)) ||
        (await page.evaluate(HOVER_TARGETS_JS, [0, 0])) ||
        [[VIEWPORT_W / 2, VIEWPORT_H / 2]];
      if (targets.length === 0) targets = [[VIEWPORT_W / 2, VIEWPORT_H / 2]];
    }
    const y = startY + ((endY - startY) * (i + 1)) / steps;
    await page.evaluate(SMOOTH_SCROLL_JS, [Math.trunc(y), 450]);
    const [x, ty] = targets[i % targets.length];
    await page.mouse.move(x, ty, { steps: 10 });
  }

  const elapsedSinceStart = (Date.now() - t0) / 1000 - start;
  const left = seconds - elapsedSinceStart;
  if (left > 0) {
    await page.waitForTimeout(Math.floor(left * 1000));
  }
  return [start, (Date.now() - t0) / 1000, played];
}

// grabber.py's save_hero(): screenshot from the top of the page down to
// the end of the h1's section (at most one screen).
export async function saveHero(page: Page, heroBottom: number, vh: number): Promise<Buffer> {
  // Python: `min(max(hero_bottom, 600), vh) if hero_bottom else vh` — a
  // falsy hero_bottom (0/undetected) bypasses the clamp entirely and
  // uses the full viewport height, it does NOT clamp 0 up to 600.
  const height = heroBottom ? Math.min(Math.max(heroBottom, 600), vh) : vh;
  const viewport = page.viewportSize();
  const width = viewport?.width ?? VIEWPORT_W;
  return page.screenshot({ clip: { x: 0, y: 0, width, height } });
}
