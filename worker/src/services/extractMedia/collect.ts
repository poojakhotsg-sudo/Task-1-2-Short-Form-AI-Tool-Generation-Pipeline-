import type { Frame, Page, Response } from 'playwright';
import {
  COOKIE_SELECTORS, COOKIE_TEXT_RE, CONSENT_HIDE_JS, COLLECT_DOM_JS, PROMOTE_LAZY_JS, PLAY_VIDEOS_JS,
  CAROUSEL_NEXT_SELECTOR, SHOW_MORE_RE, MAX_SCROLL_STEPS, MAX_CLICKS, SCROLL_TIMEOUT_S, SCROLL_STEP, SCROLL_WAIT_MS,
} from './constants.js';
import { isVideoUrl, VIDEO_EXT } from './pure.js';

// Playwright-dependent asset-collection pieces of extract_assets.py,
// ported from close_cookie_popups()/dismiss_consent() (lines 532-573),
// collect()/_merge_items() (lines 696-722), scroll_page() (lines 729-
// 759), click_reveals() (lines 761-816), and record_media()/
// network_counts() (lines 635-661).
//
// A real, separate implementation from the worker's other
// closeCookiePopups (pageInteraction.ts, used by capture_site/
// fetch_site_text/record_missing_shot_clips), not a shared one — same
// as the source: AUDIT.md already flagged that extract_assets.py and
// grabber.py have "two independent implementations, not shared" for
// this exact function, each with its own selector/text list. This port
// keeps that split rather than quietly merging them.

export interface FoundItem {
  url: string;
  kind: 'img' | 'video' | 'iframe';
  y: number;
  w: number;
  h: number;
}

export type FoundMap = Map<string, FoundItem>;

export async function closeCookiePopups(page: Page): Promise<number> {
  let clicked = 0;
  const frames = page.frames().slice(0, 10); // CMPs like Sourcepoint/TrustArc render inside an iframe
  for (const frame of frames) {
    for (const sel of COOKIE_SELECTORS) {
      try {
        const loc = frame.locator(sel).first();
        if (await loc.isVisible({ timeout: 200 })) {
          await loc.click({ timeout: 1500 });
          clicked += 1;
          break;
        }
      } catch {
        // matches the source's bare except around a single selector attempt
      }
    }
    try {
      const buttons = await frame.getByRole('button', { name: COOKIE_TEXT_RE }).all();
      for (const b of buttons.slice(0, 3)) {
        if (await b.isVisible({ timeout: 200 })) {
          await b.click({ timeout: 1500 });
          clicked += 1;
          break;
        }
      }
    } catch {
      // same bare-except convention as the source
    }
  }
  if (clicked > 0) await page.waitForTimeout(500);
  return clicked;
}

export async function dismissConsent(page: Page, rounds = 3): Promise<number> {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const n = await closeCookiePopups(page);
    total += n;
    if (n === 0) break;
    await page.waitForTimeout(700);
  }
  try {
    await page.evaluate<number>(CONSENT_HIDE_JS); // hidden count is logged in the source; not surfaced here
  } catch {
    // matches the source's bare except
  }
  return total;
}

interface RawCollectItem {
  url: string;
  kind: 'img' | 'video' | 'iframe';
  y: number;
  w: number;
  h: number;
}

// extract_assets.py's _merge_items() (lines 696-703).
function mergeItems(items: RawCollectItem[], found: FoundMap): void {
  for (const it of items) {
    const cur = found.get(it.url);
    if (cur === undefined) {
      found.set(it.url, { ...it });
    } else if (it.h > 0 && (cur.h <= 0 || it.y < cur.y)) {
      cur.y = it.y;
      cur.w = it.w;
      cur.h = it.h;
    }
  }
}

async function evaluateFrame(frame: Page | Frame, withBg: boolean): Promise<RawCollectItem[]> {
  return frame.evaluate<RawCollectItem[]>(COLLECT_DOM_JS, withBg);
}

// extract_assets.py's collect() (lines 706-721): main frame + same-
// origin child frames (cross-origin frames throw and are skipped
// silently, matching the source's bare except).
export async function collect(page: Page, found: FoundMap, bg = false): Promise<void> {
  try {
    const items = await evaluateFrame(page, bg);
    mergeItems(items, found);
  } catch {
    // matches the source's "collect main-frame failed" bare except
  }
  for (const frame of page.frames().slice(1)) {
    try {
      if (frame.isDetached()) continue;
      const items = await evaluateFrame(frame, bg);
      mergeItems(items, found);
    } catch {
      // cross-origin frames throw here — skipped silently, same as the source
    }
  }
}

// extract_assets.py's scroll_page() (lines 729-759).
export async function scrollPage(page: Page, found: FoundMap): Promise<number> {
  let stuck = 0;
  const deadline = Date.now() + SCROLL_TIMEOUT_S * 1000;
  let i = 0;
  for (; i < MAX_SCROLL_STEPS; i++) {
    if (Date.now() > deadline) break;
    const before = await page.evaluate<number>('scrollY');
    await page.evaluate(`scrollBy(0, innerHeight * ${SCROLL_STEP})`);
    await page.waitForTimeout(SCROLL_WAIT_MS);
    if (i % 2 === 0) {
      await page.evaluate(PROMOTE_LAZY_JS);
      await page.evaluate(PLAY_VIDEOS_JS);
      await collect(page, found);
    }
    if (i % 8 === 7) {
      await dismissConsent(page, 1);
    }
    if (i % 10 === 9) {
      try {
        await page.waitForLoadState('networkidle', { timeout: 3000 });
      } catch {
        // matches the source's bare except
      }
    }
    const after = await page.evaluate<number>('scrollY');
    if (after === before) {
      stuck += 1;
      await page.waitForTimeout(600);
      if (stuck >= 3) break;
    } else {
      stuck = 0;
    }
  }
  await collect(page, found, true);
  return i + 1;
}

// extract_assets.py's click_reveals() (lines 761-816): tabs, carousel-
// next buttons, and "show more" controls, each clicked in place without
// leaving the page (a navigating click is undone with go_back()).
export async function clickReveals(page: Page, found: FoundMap): Promise<number> {
  const start = page.url().split('#')[0];
  let clicks = 0;
  const done = new Set<string>();

  const groups: { locator: ReturnType<Page['locator']>; repeats: number }[] = [
    { locator: page.locator("[role=tab]:not([aria-selected='true'])"), repeats: 1 },
    { locator: page.locator(CAROUSEL_NEXT_SELECTOR), repeats: 4 },
    { locator: page.getByRole('button', { name: SHOW_MORE_RE }), repeats: 1 },
  ];

  for (const { locator, repeats } of groups) {
    let els;
    try {
      els = (await locator.all()).slice(0, 20);
    } catch {
      continue;
    }
    for (const el of els) {
      if (clicks >= MAX_CLICKS) break;
      try {
        if (!(await el.isVisible({ timeout: 200 })) || !(await el.isEnabled({ timeout: 200 }))) continue;
        const href = await el.getAttribute('href', { timeout: 500 });
        if (href && !href.startsWith('#') && !href.startsWith('javascript')) continue;

        await el.evaluate((x: HTMLElement) => x.scrollIntoView({ block: 'center', inline: 'center' }));
        await page.waitForTimeout(300);
        const box = await el.boundingBox();
        const scrollY = await page.evaluate<number>('scrollY');
        const spot = box ? `${Math.round(box.x)},${Math.round(box.y + scrollY)}` : null;
        if (spot !== null && done.has(spot)) continue;
        if (spot !== null) done.add(spot);

        for (let r = 0; r < repeats; r++) {
          try {
            await el.click({ timeout: 1500, noWaitAfter: true });
          } catch {
            await el.evaluate((x: HTMLElement) => x.click());
          }
          clicks += 1;
          await page.waitForTimeout(600);
        }
        await page.evaluate(PLAY_VIDEOS_JS);
        try {
          await page.waitForLoadState('networkidle', { timeout: 2000 });
        } catch {
          // matches the source's bare except
        }
        await collect(page, found);
      } catch {
        continue;
      }
      if (page.url().split('#')[0] !== start) {
        try {
          await page.goBack({ timeout: 15000 });
        } catch {
          await page.goto(start, { timeout: 45000 });
        }
      }
    }
  }
  return clicks;
}

export interface NetworkEntry {
  kind: 'video' | 'img';
  ct: string;
  type: 'video' | 'gif' | 'webp' | 'image';
}

export interface MediaRequestLog {
  url: string;
  contentType: string;
  status: number;
  resourceType: string;
}

// extract_assets.py's record_media() (lines 635-653) — a response
// listener that notes every image/video network response (for
// candidates the page never actually rendered, e.g. a lazy image that
// never entered the viewport but still got requested by some other
// trigger).
export function recordMedia(
  resp: Response,
  network: Map<string, NetworkEntry>,
  mediaRequests: MediaRequestLog[]
): void {
  const url = resp.url();
  if (!url.startsWith('http')) return;
  const ct = (resp.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
  const rt = resp.request().resourceType();
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  const looksLikeMedia =
    rt === 'image' || rt === 'media' || ct.startsWith('image/') || ct.startsWith('video/') || ct.includes('mpegurl') ||
    VIDEO_EXT.some((ext) => path.endsWith(ext));
  if (!looksLikeMedia) return;

  if (mediaRequests.length < 1500) {
    mediaRequests.push({ url: url.slice(0, 500), contentType: ct, status: resp.status(), resourceType: rt });
  }
  if (resp.status() >= 400) return;

  if (isVideoUrl(url, ct)) {
    if (!network.has(url)) network.set(url, { kind: 'video', ct, type: 'video' });
  } else if (rt === 'image' || ct.startsWith('image/')) {
    const ext = path.match(/\.[a-z0-9]+$/)?.[0] || '';
    const type = ct === 'image/gif' || ext === '.gif' ? 'gif' : ct === 'image/webp' || ext === '.webp' ? 'webp' : 'image';
    if (!network.has(url)) network.set(url, { kind: 'img', ct, type });
  }
}

// extract_assets.py's network_counts() (lines 656-661).
export function networkCounts(network: Map<string, NetworkEntry>): Record<string, number> {
  const counts: Record<string, number> = { video: 0, gif: 0, webp: 0, image: 0 };
  for (const entry of network.values()) {
    counts[entry.type] = (counts[entry.type] || 0) + 1;
  }
  return counts;
}
