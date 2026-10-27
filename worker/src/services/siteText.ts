import { chromium } from 'playwright';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { closeCookiePopups, botCheck } from './pageInteraction.js';

const execFileAsync = promisify(execFile);

// PIPE-04's site-text fetching, ported from pipeline/script_gen.py's
// fetch_site_text()/_load()/_embed_info(). Needs real browser automation
// (a separate Playwright session from capture_site's — script_gen.py
// runs its own) — this is why `script` genuinely needs a worker task at
// all, not just an LLM call. Same discovery as match.ts's
// record_missing_shot_clips and grab's section recording: PIPE-04's
// one-line "asks Claude for a script" summary hid real browser work,
// confirmed only by reading the actual source.
const MAX_SITE_CHARS = 40_000;
const MAX_SUBPAGES = 2;
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SUBPAGE_HINT_RE = /feature|product|how-it-works|use-case|solutions|examples|showcase/i;
const EMBED_RE = /(youtube\.com\/embed\/|youtube-nocookie\.com\/embed\/|player\.vimeo\.com\/video\/|wistia|loom\.com\/embed\/)/;
const BOT_CHECK_HINT_RE = /just a moment|verify you are human|checking your browser/i;

const PAGE_TEXT_JS = `() => {
  const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
  return [document.title, meta ? meta.content : '', document.body ? document.body.innerText : '']
    .filter(Boolean).join('\\n');
}`;

const SCROLL_FOR_LAZY_TEXT_JS = `async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 900) {
    scrollTo(0, y);
    await new Promise(r => setTimeout(r, 150));
  }
}`;

async function pageText(page: import('playwright').Page): Promise<string> {
  return page.evaluate<string>(PAGE_TEXT_JS);
}

// script_gen.py's _load(): simpler than grabber.py's _prepare() — no
// section-finding, just enough to get readable text (networkidle wait,
// cookie-popup dismissal, a scroll pass so lazy-loaded sections render).
async function loadForText(page: import('playwright').Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch {
    // common with analytics/streams — continue with what loaded
  }
  await page.waitForTimeout(1500);
  await closeCookiePopups(page);
  await page.evaluate(SCROLL_FOR_LAZY_TEXT_JS);
  return pageText(page);
}

// yt-dlp's title+description for an embedded demo video — '' if yt-dlp
// is missing, times out, or the call fails. Matches the source's
// graceful degrade exactly (a missing embed description never fails the
// whole stage).
async function embedInfo(src: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      ['--skip-download', '--no-warnings', '--print', '%(title)s', '--print', '%(description)s', src],
      { timeout: 60000 }
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function fetchSiteText(url: string): Promise<string> {
  const browser = await chromium.launch();
  const parts: string[] = [];

  try {
    const page = await browser.newPage({ userAgent: DESKTOP_UA, viewport: { width: 1440, height: 900 } });
    try {
      let home = await loadForText(page, url);
      // Give a bot check a chance to clear before giving up on this page's text.
      if (BOT_CHECK_HINT_RE.test(home.slice(0, 300)) || (await botCheck(page))) {
        await page.waitForTimeout(8000);
        home = await pageText(page);
      }
      parts.push(`=== ${page.url()}\n${home}`);

      // Thin landing pages often explain the product in an embedded demo
      // video instead of page text.
      const iframeSrcs = await page.evaluate<string[]>(
        "[...document.querySelectorAll('iframe')].map(f => f.src)"
      );
      for (const src of iframeSrcs) {
        if (src && EMBED_RE.test(src)) {
          const info = await embedInfo(src.split('?')[0]);
          if (info) parts.push(`=== embedded video ${src}\n${info}`);
        }
      }

      const host = new URL(page.url()).hostname;
      const links = await page.evaluate<string[]>("[...document.querySelectorAll('a[href]')].map(a => a.href)");
      const subpages: string[] = [];
      for (const rawLink of links) {
        const link = rawLink.split('#')[0];
        let linkHost: string;
        try {
          linkHost = new URL(link).hostname;
        } catch {
          continue;
        }
        if (
          linkHost === host &&
          SUBPAGE_HINT_RE.test(link) &&
          !subpages.includes(link) &&
          link !== page.url()
        ) {
          subpages.push(link);
        }
      }

      for (const link of subpages.slice(0, MAX_SUBPAGES)) {
        try {
          parts.push(`=== ${link}\n${await loadForText(page, link)}`);
        } catch {
          // matches the source's per-subpage try/except — one bad
          // subpage doesn't abort the whole fetch
        }
      }
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }

  let text = parts.join('\n\n').replace(/\n\s*\n+/g, '\n').trim();
  if (text.length > MAX_SITE_CHARS) {
    text = text.slice(0, MAX_SITE_CHARS);
  }
  return text;
}
