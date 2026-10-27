import type { Page } from 'playwright';

// Playwright-dependent pieces of grabber.py (cookie/chat-widget handling,
// bot-check detection, page load) — ported faithfully from the Python
// source, not reinterpreted. These can't be unit-tested without a real
// browser, same as the rest of section-clip recording; pageSections.ts
// holds the pure, testable parts split out from this.

const COOKIE_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  "button[data-testid*='accept' i]",
  "button[id*='accept' i]",
  "button[class*='accept' i]",
  '.cc-allow',
  '.cc-dismiss',
];

const COOKIE_TEXT_RE =
  /^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(ay)?|i understand|understood|continue|close|dismiss|no thanks|reject( all)?)\s*$/i;

const BOT_CHECK_RE =
  /just a moment|verify (that )?you are (a )?human|checking (if the site connection|your browser)|attention required|are you a robot|pardon our interruption|access denied|captcha|enable javascript and cookies to continue|request blocked|unusual traffic/i;

const CHAT_WIDGET_CSS = `
#intercom-container, #intercom-frame, .intercom-lightweight-app, .intercom-launcher,
iframe[name^="intercom"], #hubspot-messages-iframe-container, #drift-widget,
#drift-frame-controller, #drift-frame-chat, .drift-frame-controller, .crisp-client,
iframe#launcher, #webWidget, [id^="tawk"], .tawk-min-container, #fc_frame,
#chat-widget-container, #tidio-chat, #beacon-container, .BeaconFabButtonFrame,
.zsiq_floatmain, #zsiq_float, #gorgias-chat-container, #front-chat-container,
iframe[title*="chat" i], iframe[title*="messaging" i], [id*="chat-widget" i],
[class*="chat-widget" i], [class*="ChatWidget"], [aria-label*="open chat" i]
{ display: none !important; visibility: hidden !important; }
`;

const HIDE_CORNER_WIDGETS_JS = `() => {
  let n = 0;
  document.querySelectorAll('body *').forEach(el => {
    const st = getComputedStyle(el);
    if (st.position !== 'fixed') return;
    const r = el.getBoundingClientRect();
    if (r.width > 460 || r.height > 720 || r.width < 30) return;
    if (r.bottom < innerHeight - 260 || (r.left > 260 && r.right < innerWidth - 260)) return;
    const sig = (el.id + ' ' + el.className + ' ' + (el.getAttribute('aria-label') || '') + ' ' +
                 (el.tagName === 'IFRAME' ? el.title + ' ' + el.src : '')).toLowerCase();
    if (/chat|messenger|intercom|drift|crisp|zendesk|support|helpdesk|livechat|widget|launcher/.test(sig)) {
      el.style.setProperty('display', 'none', 'important'); n++;
    }
  });
  return n;
}`;

const HIDE_COOKIE_BANNERS_JS = `() => document.querySelectorAll('body *').forEach(el => {
  const st = getComputedStyle(el);
  if ((st.position === 'fixed' || st.position === 'sticky') &&
      /cookie|consent|gdpr|privacy/i.test(el.id + ' ' + el.className + ' ' + (el.innerText || '').slice(0, 400)) &&
      el.getBoundingClientRect().height < innerHeight * 0.9)
    el.style.setProperty('display', 'none', 'important');
})`;

export async function closeCookiePopups(page: Page): Promise<number> {
  let clicked = 0;
  for (const frame of page.frames()) {
    for (const sel of COOKIE_SELECTORS) {
      try {
        const loc = frame.locator(sel).first();
        if (await loc.isVisible({ timeout: 300 })) {
          await loc.click({ timeout: 1500 });
          clicked += 1;
        }
      } catch {
        // matches the source's bare except — a selector that errors
        // (detached, not found, etc.) just means "no popup here."
      }
    }
    try {
      const buttons = frame.getByRole('button', { name: COOKIE_TEXT_RE });
      const count = Math.min(await buttons.count(), 3);
      for (let i = 0; i < count; i++) {
        const b = buttons.nth(i);
        if (await b.isVisible({ timeout: 300 })) {
          await b.click({ timeout: 1500 });
          clicked += 1;
          break;
        }
      }
    } catch {
      // same as above
    }
  }
  try {
    await page.evaluate(HIDE_COOKIE_BANNERS_JS);
  } catch {
    // PlaywrightError equivalent — page may have navigated away mid-call
  }
  return clicked;
}

export async function hideChatWidgets(page: Page): Promise<number> {
  try {
    await page.addStyleTag({ content: CHAT_WIDGET_CSS });
    return await page.evaluate(HIDE_CORNER_WIDGETS_JS);
  } catch {
    return 0;
  }
}

export async function cleanPage(page: Page): Promise<{ clicked: number; hidden: number }> {
  const clicked = await closeCookiePopups(page);
  const hidden = await hideChatWidgets(page);
  return { clicked, hidden };
}

export async function botCheck(page: Page): Promise<string> {
  let text: string;
  try {
    text = await page.evaluate(
      "() => (document.title + ' ' + (document.body ? document.body.innerText : '')).slice(0, 1500)"
    );
  } catch {
    return '';
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  const m = BOT_CHECK_RE.exec(text);
  return m && words < 250 ? `bot check: '${m[0]}'` : '';
}

export async function loadPage(page: Page, url: string): Promise<{ ok: boolean; reason: string }> {
  let resp;
  try {
    resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    // Playwright's TimeoutError and other navigation errors both land
    // here in the JS SDK (unlike Python's separate Timeout/Error
    // classes) — tolerate a slow-DOM timeout the same way the source
    // does, only failing outright on a harder navigation error.
    if (/Timeout.*exceeded/i.test(message)) {
      resp = null;
    } else {
      return { ok: false, reason: `could not open page: ${message}` };
    }
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {
    // network never went idle — common with analytics/streams; continue
  }
  await page.waitForTimeout(1500);

  let reason = await botCheck(page);
  for (let i = 0; i < 4 && reason; i++) {
    await page.waitForTimeout(4000);
    reason = await botCheck(page);
  }
  if (reason) return { ok: false, reason };

  if (resp && resp.status() >= 400) {
    return { ok: false, reason: `HTTP ${resp.status()}` };
  }

  try {
    const len: number = await page.evaluate(
      "() => (document.body ? document.body.innerText : '').trim().length"
    );
    if (len < 20) return { ok: false, reason: 'page loaded empty' };
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return { ok: false, reason: `page broke while loading: ${message}` };
  }

  return { ok: true, reason: '' };
}

// grabber.py's _prepare(): load, clean, and scroll once so lazy content
// loads, then return to the top.
export async function preparePage(page: Page, url: string): Promise<{ clicked: number; hidden: number }> {
  const { ok, reason } = await loadPage(page, url);
  if (!ok) throw new Error(reason);

  const { clicked, hidden } = await cleanPage(page);

  const info = await page.evaluate<{ height: number; vh: number }>(FIND_BLOCKS_JS);
  for (let y = 0; y < info.height; y += Math.floor(info.vh / 2)) {
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
    await page.waitForTimeout(250);
  }
  await cleanPage(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);

  return { clicked, hidden };
}

// Content blocks top to bottom: page-y, height, visible text, whether
// they hold media. Exported so preparePage and the main capture service
// share one definition.
export const FIND_BLOCKS_JS = `() => {
  const vh = innerHeight, vw = innerWidth;
  const els = new Set(document.querySelectorAll(
    'header, main section, section, main > div, [class*="section" i], [id*="section" i], ' +
    '[class*="hero" i], article, footer'));
  document.querySelectorAll('h1, h2, h3').forEach(h => {
    let el = h;
    while (el.parentElement && el.getBoundingClientRect().height < 300) el = el.parentElement;
    els.add(el);
  });
  const blocks = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.height < 200 || r.width < vw * 0.5 || r.height > document.documentElement.scrollHeight * 0.8) continue;
    if (st.display === 'none' || st.visibility === 'hidden' || st.position === 'fixed') continue;
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!text && !el.querySelector('img, video, canvas, picture')) continue;
    const hd = el.querySelector('h1, h2, h3, h4');
    const title = ((hd && hd.innerText) || text).replace(/\\s+/g, ' ').trim().slice(0, 80);
    blocks.push({y: Math.round(r.top + scrollY), h: Math.round(r.height), text: text.slice(0, 800), title,
                 video: !!el.querySelector('video, iframe[src*="youtube"], iframe[src*="vimeo"]'),
                 img: !!el.querySelector('img, picture, canvas')});
  }
  blocks.sort((a, b) => a.y - b.y || a.h - b.h);
  const out = [];
  for (const b of blocks) if (!out.length || b.y - out[out.length - 1].y > vh * 0.3) out.push(b);
  return {blocks: out, height: document.documentElement.scrollHeight, vh};
}`;
