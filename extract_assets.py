#!/usr/bin/env python3
"""
extract_assets.py - pull a website's media into four folders, plus a mobile
scroll-through video. No LLM and no paid API calls.

    python extract_assets.py --url https://gamma.app                  -> out/gamma.app/
    python extract_assets.py --url https://gamma.app --out out/gamma.app/

out/<tool>/                       (<tool> = domain without www)
  scroll/     00_page_scroll.mp4 (1080x1920) + section clips 01_<heading>.mp4 ...
  embedded/   page videos: <video> tags, direct .mp4/.webm/.mov/.m3u8 links and
              YouTube/Vimeo/Loom/Wistia iframes (yt-dlp; if that fails, the embed
              is recorded playing for 8 s with Playwright). All .mp4.
  gifs/       .gif and animated .webp/.png/.avif originals, each with an .mp4 copy
  images/     still images (no favicons, tracking pixels or files under 5 KB)
  raw/        .webm/.mov originals and the raw Playwright recordings (not shown in the UI)
  manifest.json   one entry per file: category, filename, source URL, type, size ...
  report.json     status, the one-line message, why a category is empty, diagnostics
  run.log         full debug log

Exit code 0 only when the page loaded; a 4xx/5xx after 3 retries exits 1.
"""

import argparse
import hashlib
import io
import json
import logging
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests
from playwright.sync_api import Error as PWError
from playwright.sync_api import sync_playwright

try:
    from PIL import Image, ImageSequence
    Image.MAX_IMAGE_PIXELS = None
except ImportError:  # pragma: no cover
    Image = None
try:
    import imagehash
except ImportError:  # pragma: no cover
    imagehash = None

import warnings
warnings.filterwarnings("ignore", module="PIL")

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

log = logging.getLogger("extract_assets")

ROOT = Path(__file__).resolve().parent
CATEGORIES = ("scroll", "embedded", "gifs", "images")
OUT_W, OUT_H = 1080, 1920
ASSET_DEVICE = "iPhone 14"
ASSET_VIEWPORT = {"width": 390, "height": 844}
REC_VIEWPORT = {"width": 360, "height": 640}
EMBED_REC_VIEWPORT = {"width": 1280, "height": 720}
MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
NAV_TIMEOUT_MS = 45000
BACKOFF = [5, 10, 20]                 # 3 retries after the first try; the last one headed
MIN_BYTES = 5 * 1024                  # stills only
NEAR_DUP = 4                          # phash distance
MAX_SCROLL_STEPS = 120
MAX_CLICKS = 30
MAX_VIDEOS = 30
MAX_HLS = 5
MAX_BYTES = 500 * 1024 * 1024
MAX_SECTION_CLIPS = 6
CLIP_SECONDS = 7.0
EMBED_REC_SECONDS = 8.0

VIDEO_EXT = (".mp4", ".webm", ".mov", ".m4v", ".ogv", ".m3u8")
SEGMENT_RE = re.compile(r"\.(ts|m4s|m4a|aac|mp3|vtt|key)(\?|$)|/seg(ment)?[-_]?\d+|[?&](range|bytestart)=", re.I)
EMBED_RE = re.compile(r"(youtube(-nocookie)?\.com/(embed|watch|shorts)|youtu\.be/|player\.vimeo\.com/video/|vimeo\.com/\d+|"
                      r"loom\.com/(embed|share)/|wistia\.(com|net)/(embed|medias)|wi\.st/)", re.I)
FAVICON_RE = re.compile(r"favicon|apple-touch-icon|mstile|android-chrome-\d+|/icons?/|\.ico(\?|$)", re.I)
TRACKING_RE = re.compile(r"pixel|beacon|/collect\?|facebook\.com/tr|doubleclick|analytics|/track", re.I)
BOT_RE = re.compile(r"verify you are human|are you a robot|checking your browser|attention required|"
                    r"access denied|captcha|unusual traffic|just a moment", re.I)
SHOW_MORE_RE = re.compile(r"^\s*(show|see|view|load|read)\s+(more|all)\b", re.I)
CT_EXT = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
          "image/avif": ".avif", "image/apng": ".png", "image/svg+xml": ".svg", "image/x-icon": ".ico",
          "image/vnd.microsoft.icon": ".ico", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
          "video/ogg": ".ogv", "application/vnd.apple.mpegurl": ".m3u8", "application/x-mpegurl": ".m3u8"}

COOKIE_SELECTORS = [
    "#onetrust-accept-btn-handler", "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "button#accept-cookies", "[data-testid*='cookie' i] button", ".cc-allow", ".cc-btn.cc-dismiss",
    "button[aria-label*='accept' i]", "button[aria-label*='agree' i]",
]
COOKIE_TEXT = re.compile(r"^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(ay)?|"
                         r"consent|yes,? i agree|reject( all)?|decline)\s*$", re.I)

try:
    from pipeline.grabber import CHAT_WIDGET_CSS
except Exception:  # keep the extractor standalone
    CHAT_WIDGET_CSS = ("#intercom-container, .intercom-lightweight-app, #hubspot-messages-iframe-container, "
                       "#drift-widget, .crisp-client, iframe#launcher, #webWidget, [id^='tawk'], #fc_frame, "
                       "iframe[title*='chat' i], [id*='chat-widget' i], [class*='chat-widget' i]"
                       "{ display: none !important; }")

# ---------------------------------------------------------------- page JS

PROMOTE_LAZY_JS = """() => {
  for (const img of document.querySelectorAll('img')) {
    img.loading = 'eager';
    for (const a of ['data-src', 'data-lazy-src', 'data-original']) {
      const v = img.getAttribute(a);
      if (v && !img.getAttribute('src')) img.setAttribute('src', v);
    }
  }
  for (const v of document.querySelectorAll('video[preload="none"]')) v.preload = 'metadata';
}"""

# withBg: also read computed background images (slow on big pages, so only on the final passes)
COLLECT_DOM_JS = """(withBg) => {
  const out = [], seen = new Set();
  const abs = u => { try { return new URL(u, location.href).href } catch (e) { return null } };
  const pos = el => { const r = el.getBoundingClientRect();
    return {y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height)} };
  const add = (u, kind, el) => {
    if (!u) return; u = abs(String(u).trim());
    if (!u || !/^https?:/.test(u)) return;
    const k = kind + '|' + u; if (seen.has(k)) return; seen.add(k);
    out.push({url: u, kind, ...pos(el)});
  };
  const best = ss => { let bu = null, bw = -1;
    for (const part of String(ss).split(/,\\s+(?=\\S)/)) {
      const [u, d] = part.trim().split(/\\s+/); const w = parseFloat(d) || 1;
      if (u && w > bw) { bw = w; bu = u } }
    return bu };
  for (const img of document.querySelectorAll('img')) {
    add(img.currentSrc || img.src, 'img', img);
    for (const a of ['srcset', 'data-srcset']) { const v = img.getAttribute(a); if (v) add(best(v), 'img', img) }
    for (const a of ['data-src', 'data-lazy-src', 'data-original', 'data-lazy']) add(img.getAttribute(a), 'img', img);
  }
  for (const s of document.querySelectorAll('picture source')) {
    const v = s.getAttribute('srcset') || s.getAttribute('data-srcset');
    if (v) add(best(v), 'img', s.parentElement.querySelector('img') || s.parentElement);
  }
  for (const v of document.querySelectorAll('video')) {
    add(v.currentSrc || v.getAttribute('src') || v.getAttribute('data-src'), 'video', v);
    for (const s of v.querySelectorAll('source')) add(s.getAttribute('src') || s.getAttribute('data-src'), 'video', v);
    if (v.poster) add(v.poster, 'img', v);
  }
  if (withBg) for (const el of document.querySelectorAll('body *')) {
    for (const pseudo of [null, '::before', '::after']) {
      const bg = getComputedStyle(el, pseudo).backgroundImage;
      if (bg && bg !== 'none' && bg.includes('url('))
        for (const m of bg.matchAll(/url\\(["']?(.*?)["']?\\)/g)) add(m[1], 'img', el);
    }
  }
  for (const f of document.querySelectorAll('iframe')) add(f.src || f.getAttribute('data-src'), 'iframe', f);
  for (const el of document.querySelectorAll('[class*="wistia_async_"]')) {
    const m = el.className.match(/wistia_async_(\\w+)/);
    if (m) add('https://fast.wistia.net/embed/iframe/' + m[1], 'iframe', el);
  }
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.href;
    if (/\\.(mp4|webm|mov|m4v|m3u8)(\\?|#|$)/i.test(h)) add(h, 'video', a);
    else if (/\\.gif(\\?|#|$)/i.test(h)) add(h, 'img', a);
    else if (/(youtube\\.com\\/(watch|shorts)|youtu\\.be\\/|vimeo\\.com\\/\\d|loom\\.com\\/share\\/)/i.test(h)) add(h, 'iframe', a);
  }
  return out;
}"""

HEADINGS_JS = """() => [...document.querySelectorAll('h1, h2, h3, [role=heading]')]
  .filter(h => h.offsetParent !== null && (h.innerText || '').trim().length > 1)
  .map(h => ({y: Math.round(h.getBoundingClientRect().top + scrollY), text: h.innerText.trim().slice(0, 80)}))
  .sort((a, b) => a.y - b.y)"""

SCROLL_NESTED_JS = """async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const boxes = [...document.querySelectorAll('body *')].filter(el => {
    const cs = getComputedStyle(el);
    return ((/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 20) ||
            (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100));
  }).slice(0, 25);
  for (const el of boxes) {
    for (let i = 1; i <= 4; i++) {
      el.scrollLeft = el.scrollWidth * i / 4; el.scrollTop = el.scrollHeight * i / 4; await sleep(150);
    }
    el.scrollLeft = 0; el.scrollTop = 0;
  }
  return boxes.length;
}"""

HIDE_POPUPS_JS = """() => {
  window.__rpHide = () => {
    let n = 0; const vw = innerWidth, vh = innerHeight;
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.top <= 2 && r.height < vh * 0.16 && r.width > vw * 0.8) continue;           // site header bar
      const z = parseInt(cs.zIndex) || 0;
      if (z <= 0 && r.width >= vw * 0.9 && r.height >= vh * 0.9) continue;               // fixed page background
      el.style.setProperty('display', 'none', 'important'); n++;
    }
    for (const el of [document.documentElement, document.body])
      if (getComputedStyle(el).overflowY === 'hidden') el.style.setProperty('overflow-y', 'auto', 'important');
    return n;
  };
  return window.__rpHide();
}"""

PRESCROLL_JS = """async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 80; i++) {
    const before = scrollY; scrollBy(0, innerHeight * 0.9); await sleep(140);
    if (scrollY === before) break;
  }
  await sleep(500); scrollTo(0, 0);
}"""

# Eased scroll top -> bottom with ~1 s pauses at section/heading stops and a nudge to any
# carousel in view during each pause. 12 s minimum; the caller's budget caps it.
SMOOTH_SCROLL_JS = """async ({budgetMs, pauseMs, holdMs}) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const maxY = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight;
  if (maxY < 20) { await sleep(12000); return {maxY, moveMs: 0, stops: 0} }
  let moveMs = Math.max(8000, Math.min(15000, maxY / 700 * 1000));
  const cands = [...document.querySelectorAll('section, h2, [class*="section" i]')]
    .map(el => Math.round(el.getBoundingClientRect().top + scrollY - 70))
    .filter(y => y > innerHeight * 0.5 && y < maxY - innerHeight * 0.3).sort((a, b) => a - b);
  const stops = [];
  for (const y of cands) if (!stops.length || y - stops[stops.length - 1] > innerHeight * 1.2) stops.push(y);
  const maxStops = Math.max(0, Math.floor((budgetMs - moveMs - holdMs) / pauseMs));
  let picked = stops;
  if (stops.length > maxStops) picked = Array.from({length: maxStops}, (_, i) => stops[Math.floor((i + 0.5) * stops.length / maxStops)]);
  moveMs = Math.max(moveMs, 12000 - holdMs - picked.length * pauseMs);
  const points = [0, ...picked, maxY];
  const ease = t => 0.5 - Math.cos(Math.PI * t) / 2;
  const nudge = () => {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || el.scrollWidth <= el.clientWidth + 40) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowX)) continue;
      el.scrollBy({left: el.clientWidth * 0.8, behavior: 'smooth'}); return true;
    }
    return false;
  };
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i], dur = moveMs * (to - from) / maxY;
    await new Promise(res => { const t0 = performance.now();
      const step = now => { const t = Math.min(1, (now - t0) / dur); scrollTo(0, from + (to - from) * ease(t));
        t < 1 ? requestAnimationFrame(step) : res() };
      requestAnimationFrame(step) });
    if (window.__rpHide) window.__rpHide();
    if (i < points.length - 1) { nudge(); await sleep(pauseMs) }
  }
  await sleep(holdMs);
  return {maxY, moveMs, stops: picked.length};
}"""

# Screen-sized stretches of the page worth a short clip: videos, canvases, Lottie, GIFs and running
# CSS/JS animations score high, elements with hover transitions a little. Best maxN, in page order.
SECTIONS_JS = """(maxN) => {
  const vh = innerHeight, docH = document.documentElement.scrollHeight;
  const absY = el => el.getBoundingClientRect().top + scrollY;
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 30 };
  const motion = [];
  for (const el of document.querySelectorAll('video, canvas, lottie-player, dotlottie-player, [data-animation-path], img[src*=".gif" i]'))
    if (shown(el)) motion.push({el, w: 3});
  try { for (const a of document.getAnimations()) { const t = a.effect && a.effect.target;
    if (t && t.nodeType === 1 && a.playState === 'running' && shown(t)) motion.push({el: t, w: 1}) } } catch (e) {}
  for (const h of document.querySelectorAll('a, button, [class*="card" i]'))
    if (shown(h) && getComputedStyle(h).transitionDuration.split(',').some(d => parseFloat(d) > 0)) motion.push({el: h, w: 0.5, hover: true});
  const buckets = new Map();
  for (const m of motion) {
    const y = absY(m.el), k = Math.floor(y / (vh * 0.9));
    const b = buckets.get(k) || {score: 0, ys: [], hover: []};
    b.score += m.w; b.ys.push(y);
    if (m.hover && b.hover.length < 3) { m.el.dataset.rpHover = Math.random().toString(36).slice(2, 8); b.hover.push(m.el.dataset.rpHover) }
    buckets.set(k, b);
  }
  const heads = [...document.querySelectorAll('h1, h2, h3, [role=heading]')].filter(shown)
    .map(h => ({y: absY(h), t: (h.innerText || '').trim()})).filter(h => h.t).sort((a, b) => a.y - b.y);
  return [...buckets.values()].filter(b => b.score >= 2).sort((a, b) => b.score - a.score).slice(0, maxN)
    .map(b => { const y0 = Math.min(...b.ys), head = heads.filter(h => h.y <= y0 + 40).pop();
      return {y: Math.round(Math.max(0, Math.min(y0 - vh * 0.25, docH - vh))), h: vh, score: b.score,
              heading: head ? head.t.slice(0, 60) : '', hover: b.hover} })
    .sort((a, b) => a.y - b.y);
}"""

# Starts a slow eased drift and returns at once (the clip records while it runs).
DRIFT_JS = """({fromY, px, ms}) => { const t0 = performance.now();
  const step = now => { const t = Math.min(1, (now - t0) / ms);
    scrollTo(0, fromY + px * (0.5 - Math.cos(Math.PI * t) / 2)); if (t < 1) requestAnimationFrame(step) };
  requestAnimationFrame(step) }"""

PLAY_VIDEOS_JS = """() => { for (const v of document.querySelectorAll('video')) { v.muted = true; v.play().catch(() => {}) } }"""


# ---------------------------------------------------------------- small helpers

def tool_name(url: str) -> str:
    """Folder name for a URL: the domain without www (https://www.gamma.app/x -> gamma.app)."""
    if "://" not in url:
        url = "https://" + url
    host = (urlparse(url).hostname or "site").lower()
    return host[4:] if host.startswith("www.") else host


def slug(text, limit=30):
    text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(text) > limit:
        cut = text[:limit]
        text = cut.rsplit("-", 1)[0] if "-" in cut[limit // 2:] else cut
    return text.strip("-") or "section"


def section_for(y, headings, fold=844):
    if y is None:
        return "page"
    above = [h for h in headings if h["y"] <= y + 40]
    if not above:
        return "hero" if y < fold else "section"
    return slug(above[-1]["text"])


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(cmd, timeout=600):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def ffprobe(path):
    try:
        r = run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], timeout=60)
        data = json.loads(r.stdout or "{}")
    except Exception:
        return {}
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if not v:
        return {}
    dur = v.get("duration") or (data.get("format") or {}).get("duration")
    return {"width": v.get("width"), "height": v.get("height"), "codec": v.get("codec_name"),
            "pix_fmt": v.get("pix_fmt"), "duration": round(float(dur), 2) if dur not in (None, "N/A") else None,
            "audio": any(s.get("codec_type") == "audio" for s in data.get("streams", [])),
            "format": (data.get("format") or {}).get("format_name", "")}


def original_name(url):
    return (unquote(Path(urlparse(url).path).name) or "file")[:120]


def guess_ext(url, ct=""):
    ext = Path(urlparse(url).path).suffix.lower()
    if re.fullmatch(r"\.[a-z0-9]{2,5}", ext or ""):
        return ".jpg" if ext == ".jpeg" else ext
    return CT_EXT.get((ct or "").split(";")[0].strip().lower(), ".bin")


def is_video_url(url, ct=""):
    ct = (ct or "").lower()
    if SEGMENT_RE.search(url) or "iso.segment" in ct or "mp2t" in ct:
        return False
    return urlparse(url).path.lower().endswith(VIDEO_EXT) or ct.startswith("video/") or "mpegurl" in ct


def humans(n):
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{n / 1024:.0f} KB"


def close_cookie_popups(page):
    clicked = 0
    for frame in page.frames[:6]:
        for sel in COOKIE_SELECTORS:
            try:
                loc = frame.locator(sel).first
                if loc.is_visible(timeout=200):
                    loc.click(timeout=1500)
                    clicked += 1
                    break
            except PWError:
                pass
        try:
            for b in frame.get_by_role("button", name=COOKIE_TEXT).all()[:3]:
                if b.is_visible(timeout=200):
                    b.click(timeout=1500)
                    clicked += 1
                    break
        except PWError:
            pass
    if clicked:
        page.wait_for_timeout(500)
    return clicked


# ---------------------------------------------------------------- page loading

def open_page(pw, url, state):
    """Load the page as an iPhone 14 (390x844). Retries 3 times with 5/10/20 s backoff,
    the last try in a visible browser. Returns (browser, context, page) or Nones."""
    device = dict(pw.devices[ASSET_DEVICE])
    device["viewport"] = dict(ASSET_VIEWPORT)
    state["viewport"] = device["viewport"]
    state["user_agent"] = device.get("user_agent")
    for attempt in range(len(BACKOFF) + 1):
        headed = attempt == len(BACKOFF)
        if attempt:
            wait = BACKOFF[attempt - 1]
            log.info("retry %d/%d in %ds%s", attempt, len(BACKOFF), wait, " (visible browser)" if headed else "")
            time.sleep(wait)
        try:
            browser = pw.chromium.launch(headless=not headed, args=["--autoplay-policy=no-user-gesture-required"])
        except PWError as e:
            log.warning("browser launch failed (%s); trying headless", str(e).splitlines()[0])
            browser = pw.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required"])
        ctx = browser.new_context(**device)
        page = ctx.new_page()
        doc = {}

        def on_response(resp, page=page, doc=doc):
            try:
                if resp.request.resource_type == "document" and resp.frame == page.main_frame:
                    doc["status"] = resp.status
                record_media(resp, state)
            except Exception:
                pass

        page.on("response", on_response)
        page.on("console", lambda m: m.type == "error" and len(state["console_errors"]) < 50
                and state["console_errors"].append(m.text[:300]))
        err, status = None, None
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            status = resp.status if resp else doc.get("status")
        except PWError as e:
            err = str(e).splitlines()[0]
            status = doc.get("status")
        state["attempts"].append({"attempt": attempt + 1, "headed": headed, "status": status, "error": err})
        log.info("attempt %d: HTTP %s%s", attempt + 1, status, f" ({err})" if err else "")
        state["http_status"] = status
        if status and status < 400:
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except PWError:
                log.debug("networkidle not reached in 10 s; continuing")
            try:
                text = (page.title() or "") + " " + page.evaluate("document.body ? document.body.innerText.slice(0, 2000) : ''")
            except PWError:
                text = ""
            if BOT_RE.search(text) and len(text) < 1500:
                state["bot_check"] = True
                log.warning("page looks like a bot check; continuing with what loaded")
            return browser, ctx, page
        state["last_error"] = err
        browser.close()
    return None, None, None


def record_media(resp, state):
    url = resp.url
    if not url.startswith("http"):
        return
    ct = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    rt = resp.request.resource_type
    if not (rt in ("image", "media") or ct.startswith(("image/", "video/")) or "mpegurl" in ct
            or urlparse(url).path.lower().endswith(VIDEO_EXT)):
        return
    if len(state["media_requests"]) < 1500:
        state["media_requests"].append({"url": url[:500], "content_type": ct, "status": resp.status, "resource_type": rt})
    if resp.status >= 400:
        return
    if is_video_url(url, ct):
        state["network"].setdefault(url, {"kind": "video", "ct": ct})
    elif rt == "image" or ct.startswith("image/"):
        state["network"].setdefault(url, {"kind": "img", "ct": ct})


# ---------------------------------------------------------------- exploring

def collect(page, found, bg=False):
    try:
        items = page.evaluate(COLLECT_DOM_JS, bg)
    except PWError as e:
        log.debug("collect failed: %s", e)
        return
    for it in items:
        cur = found.get(it["url"])
        if cur is None:
            found[it["url"]] = it
        elif it["h"] > 0 and (cur.get("h", 0) <= 0 or it["y"] < cur["y"]):
            cur.update(y=it["y"], w=it["w"], h=it["h"])


def scroll_page(page, found):
    stuck = 0
    for i in range(MAX_SCROLL_STEPS):
        before = page.evaluate("scrollY")
        page.evaluate("scrollBy(0, innerHeight * 0.8)")
        page.wait_for_timeout(250)
        if i % 3 == 0:
            page.evaluate(PROMOTE_LAZY_JS)
            collect(page, found)
        if page.evaluate("scrollY") == before:
            stuck += 1
            page.wait_for_timeout(600)
            if stuck >= 3:
                break
        else:
            stuck = 0
    log.info("scrolled %d steps", i + 1)
    collect(page, found, bg=True)


def click_reveals(page, found):
    """Open tabs, step through carousels and press 'show more' without leaving the page."""
    start = page.url.split("#")[0]
    clicks = 0
    groups = [
        page.locator("[role=tab]"),
        page.locator("button[aria-label*='next' i], .swiper-button-next, .slick-next, "
                     "[class*='carousel' i] [class*='next' i], [class*='arrow-right' i]"),
        page.get_by_role("button", name=SHOW_MORE_RE),
    ]
    for gi, loc in enumerate(groups):
        try:
            els = loc.all()[:15]
        except PWError:
            continue
        for el in els:
            if clicks >= MAX_CLICKS:
                break
            try:
                if not el.is_visible(timeout=200):
                    continue
                href = el.get_attribute("href", timeout=500)
                if href and not href.startswith(("#", "javascript")):
                    continue
                for _ in range(4 if gi == 1 else 1):
                    el.click(timeout=1500, no_wait_after=True)
                    clicks += 1
                    page.wait_for_timeout(450)
                collect(page, found)
            except PWError:
                continue
            if page.url.split("#")[0] != start:
                log.debug("click navigated to %s; going back", page.url)
                try:
                    page.go_back(timeout=15000)
                except PWError:
                    page.goto(start, timeout=NAV_TIMEOUT_MS)
    log.info("clicked %d tabs/arrows/show-more", clicks)


# ---------------------------------------------------------------- downloading

_tls = threading.local()


def session(cookies, ua):
    s = getattr(_tls, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = ua
        for c in cookies:
            s.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))
        _tls.s = s
    return s


def download(url, dest_stem, referer, cookies, ua, ct_hint=""):
    """Full download (no Range header) to dest_stem + ext. Returns (path, error)."""
    if url.lower().split("?")[0].endswith(".m3u8") or "mpegurl" in ct_hint:
        return download_hls(url, dest_stem.with_suffix(".mp4"), referer, ua)
    try:
        s = session(cookies, ua)
        with s.get(url, stream=True, timeout=(10, 60), headers={"Referer": referer}) as r:
            if r.status_code >= 400:
                return None, f"HTTP {r.status_code}"
            ct = r.headers.get("content-type", "")
            if "mpegurl" in ct.lower():
                return download_hls(url, dest_stem.with_suffix(".mp4"), referer, ua)
            dest = dest_stem.with_suffix(guess_ext(url, ct))
            size = 0
            with open(dest, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        break
                    f.write(chunk)
            if size > MAX_BYTES:
                dest.unlink(missing_ok=True)
                return None, "over 500 MB"
            return dest, None
    except requests.RequestException as e:
        return None, type(e).__name__


def download_hls(url, dest, referer, ua):
    headers = f"Referer: {referer}\r\nUser-Agent: {ua}\r\n"
    try:
        r = run(["ffmpeg", "-y", "-loglevel", "error", "-headers", headers, "-i", url, "-c", "copy",
                 "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", str(dest)], timeout=300)
        if r.returncode == 0 and dest.exists() and dest.stat().st_size > 10000:
            return dest, None
        log.debug("ffmpeg hls failed: %s", r.stderr[-300:])
    except subprocess.TimeoutExpired:
        log.debug("ffmpeg hls timed out")
    path, err = ytdlp(url, dest.parent, dest.stem, referer)
    return path, err


class _YtdlpLog:
    def debug(self, msg):
        log.debug("yt-dlp: %s", msg)

    info = debug

    def warning(self, msg):
        log.debug("yt-dlp warning: %s", msg)

    def error(self, msg):
        log.debug("yt-dlp error: %s", msg)


def ytdlp(url, folder, stem, referer):
    try:
        import yt_dlp
    except ImportError:
        return None, "yt-dlp not installed"
    opts = {"outtmpl": str(folder / f"{stem}.%(ext)s"), "quiet": True, "no_warnings": True, "noprogress": True,
            "logger": _YtdlpLog(), "noplaylist": True, "playlist_items": "1", "socket_timeout": 20,
            "format": "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b",
            "merge_output_format": "mp4", "http_headers": {"Referer": referer}, "retries": 2}
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            info = y.extract_info(url, download=True)
    except Exception as e:
        return None, str(e).splitlines()[0][:200]
    hits = [p for p in folder.glob(f"{stem}.*") if p.suffix not in (".part", ".ytdl", ".json", ".title")]
    if not hits:
        return None, "yt-dlp produced no file"
    if info and info.get("title"):
        (folder / f"{stem}.title").write_text(info["title"], encoding="utf-8")
    return max(hits, key=lambda p: p.stat().st_size), None


def browser_fetch(ctx, url, dest_stem, referer):
    try:
        r = ctx.request.get(url, headers={"Referer": referer}, timeout=30000)
        if not r.ok:
            return None, f"HTTP {r.status}"
        dest = dest_stem.with_suffix(guess_ext(url, r.headers.get("content-type", "")))
        dest.write_bytes(r.body())
        return dest, None
    except PWError as e:
        return None, str(e).splitlines()[0][:200]


def embed_url(u):
    """Normalise an iframe src to something yt-dlp understands."""
    m = re.search(r"youtube(?:-nocookie)?\.com/embed/([\w-]{11})", u)
    if m:
        return f"https://www.youtube.com/watch?v={m.group(1)}"
    m = re.search(r"player\.vimeo\.com/video/(\d+)", u)
    if m:
        h = re.search(r"[?&]h=(\w+)", u)
        return f"https://vimeo.com/{m.group(1)}" + (f"/{h.group(1)}" if h else "")
    m = re.search(r"loom\.com/embed/(\w+)", u)
    if m:
        return f"https://www.loom.com/share/{m.group(1)}"
    return u


def record_embed(pw, url, referer, raw_dir, staging, stem):
    """Fallback for an embed yt-dlp can't fetch: play it muted at 1280x720 and record 8 s."""
    play_url = url + ("&" if "?" in url else "?") + "autoplay=1&mute=1&muted=1"
    tmp = Path(tempfile.mkdtemp(prefix="rp_embed_"))
    browser = pw.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required"])
    try:
        ctx = browser.new_context(viewport=EMBED_REC_VIEWPORT, record_video_dir=str(tmp),
                                  record_video_size=EMBED_REC_VIEWPORT, extra_http_headers={"Referer": referer})
        page = ctx.new_page()
        t0 = time.time()
        resp = page.goto(play_url, wait_until="domcontentloaded", timeout=30000)
        if resp and resp.status >= 400:
            ctx.close()
            return None, f"embed page returned {resp.status}"
        page.wait_for_timeout(2500)
        try:
            page.mouse.click(EMBED_REC_VIEWPORT["width"] / 2, EMBED_REC_VIEWPORT["height"] / 2)
        except PWError:
            pass
        page.evaluate(PLAY_VIDEOS_JS)
        page.wait_for_timeout(1000)
        start = time.time()
        page.wait_for_timeout(EMBED_REC_SECONDS * 1000)
        end = time.time()
        video = page.video
        t_close = time.time()
        ctx.close()
        raw = Path(video.path())
        raw_dest = raw_dir / f"{stem}.webm"
        raw_dir.mkdir(parents=True, exist_ok=True)
        staging.mkdir(parents=True, exist_ok=True)
        shutil.move(str(raw), raw_dest)
    except PWError as e:
        return None, str(e).splitlines()[0][:200]
    finally:
        browser.close()
        shutil.rmtree(tmp, ignore_errors=True)
    k = (ffprobe(raw_dest).get("duration") or (t_close - t0)) / max(t_close - t0, 0.1)
    out = staging / f"{stem}_rec.mp4"
    if encode_segment(raw_dest, out, (start - t0) * k, (end - start) * k, None):
        return out, None
    return None, "could not encode the embed recording"


# ---------------------------------------------------------------- classifying & converting

def inspect(path):
    """('video'|'animated'|'gif-still'|'still'|'svg'|'other', facts)."""
    try:
        with open(path, "rb") as f:
            head = f.read(1024)
    except OSError:
        return "other", {}
    low = head.lower().lstrip()
    if b"<svg" in low or (low.startswith(b"<?xml") and b"svg" in low):
        return "svg", {}
    if low.startswith((b"<!doctype", b"<html", b"{", b"[")):
        return "other", {}
    if Image is not None:
        try:
            with Image.open(path) as im:
                frames = getattr(im, "n_frames", 1)
                fmt = (im.format or "").upper()
                facts = {"width": im.width, "height": im.height, "frames": frames, "format": fmt}
                if frames > 1:
                    durs = []
                    for i in range(min(frames, 3000)):
                        im.seek(i)
                        durs.append(im.info.get("duration") or 100)
                    facts["duration"] = round(sum(durs) / 1000, 2)
                    facts["fps"] = max(1.0, min(50.0, 1000 / (sum(durs) / len(durs))))
                    return "animated", facts
                return ("gif-still" if fmt == "GIF" else "still"), facts
        except Exception:
            pass
    p = ffprobe(path)
    if p.get("width") and (p.get("duration") or 0) > 0.2:
        return "video", p
    return "other", {}


def middle_frame(path, kind):
    """The middle frame as a PIL image, for perceptual hashing."""
    try:
        if kind in ("still", "animated"):
            im = Image.open(path)
            if kind == "animated":
                im.seek(getattr(im, "n_frames", 1) // 2)
            return im.convert("RGB")
        dur = ffprobe(path).get("duration") or 1
        r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{dur / 2:.2f}", "-i", str(path), "-frames:v", "1",
                            "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True, timeout=60)
        if r.returncode == 0 and r.stdout:
            return Image.open(io.BytesIO(r.stdout)).convert("RGB")
    except Exception as e:
        log.debug("middle frame failed for %s: %s", path.name, e)
    return None


def phash(path, kind):
    if imagehash is None:
        return None
    im = middle_frame(path, kind)
    return imagehash.phash(im) if im is not None else None


def to_mp4_video(src, dest):
    """Any video -> browser-safe mp4 (H.264, yuv420p). Copies the streams when it already is one."""
    p = ffprobe(src)
    if p.get("codec") == "h264" and p.get("pix_fmt") == "yuv420p" and "mp4" in p.get("format", ""):
        r = run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-c", "copy", "-movflags", "+faststart", str(dest)])
        if r.returncode == 0 and dest.exists():
            return True
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    cmd += ["-c:a", "aac", "-b:a", "128k"] if p.get("audio") else ["-an"]
    r = run(cmd + [str(dest)], timeout=1800)
    if r.returncode != 0:
        log.debug("ffmpeg convert failed for %s: %s", src.name, r.stderr[-300:])
    return r.returncode == 0 and dest.exists()


def animated_to_mp4(src, dest, facts):
    """GIF / animated WebP / APNG / AVIF -> mp4 (white behind transparency)."""
    if facts.get("format") == "GIF":
        r = run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-movflags", "+faststart", "-pix_fmt", "yuv420p",
                 "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-crf", "18", str(dest)], timeout=600)
        if r.returncode == 0 and dest.exists():
            return True
    w, h = facts["width"], facts["height"]
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
           "-r", f"{facts.get('fps', 10):.3f}", "-i", "-", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white",
           "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dest)]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with Image.open(src) as im:
            for frame in ImageSequence.Iterator(im):
                rgba = frame.convert("RGBA")
                bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                proc.stdin.write(Image.alpha_composite(bg, rgba).convert("RGB").tobytes())
        proc.stdin.close()
        proc.wait(timeout=600)
        return proc.returncode == 0 and dest.exists()
    except Exception as e:
        log.debug("animated->mp4 failed for %s: %s", src.name, e)
        return False


def encode_segment(raw, dest, start, dur, size):
    """Cut [start, start+dur] of a Playwright recording to mp4 (scaled with lanczos when size is given)."""
    vf = (f"scale={size[0]}:{size[1]}:flags=lanczos," if size else "") + "fps=30,format=yuv420p"
    r = run(["ffmpeg", "-y", "-v", "error", "-ss", f"{max(0.0, start):.3f}", "-i", str(raw), "-t", f"{dur:.3f}",
             "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", "-an",
             str(dest)], timeout=600)
    if r.returncode != 0:
        log.debug("encode failed: %s", r.stderr[-300:])
    return r.returncode == 0 and dest.exists()


# ---------------------------------------------------------------- scroll video

def record_scroll(pw, url, out_dir):
    """Mobile 360x640 scroll-through + short clips of sections that move.
    Returns (items for the manifest, error message or None)."""
    raw_dir, scroll_dir = out_dir / "raw", out_dir / "scroll"
    tmp = Path(tempfile.mkdtemp(prefix="rp_scroll_"))
    browser = pw.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required"])
    marks, sections = {}, []
    try:
        ctx = browser.new_context(viewport=REC_VIEWPORT, screen=REC_VIEWPORT, is_mobile=True, has_touch=True,
                                  device_scale_factor=2, user_agent=MOBILE_UA, record_video_dir=str(tmp),
                                  record_video_size=REC_VIEWPORT)
        page = ctx.new_page()
        t0 = time.time()
        status = None
        for attempt in range(2):
            try:
                resp = page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                status = resp.status if resp else None
            except PWError as e:
                status = None
                log.debug("scroll page load error: %s", e)
            if status and status < 400:
                break
            time.sleep(BACKOFF[0])
        if not status or status >= 400:
            ctx.close()
            return [], (f"Site returned {status} - no video." if status else "Site timed out - no video.")
        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except PWError:
            pass
        close_cookie_popups(page)
        try:
            page.add_style_tag(content=CHAT_WIDGET_CSS)
        except PWError:
            pass
        page.evaluate(HIDE_POPUPS_JS)
        page.evaluate(PRESCROLL_JS)
        page.evaluate(PLAY_VIDEOS_JS)
        page.evaluate("window.__rpHide && window.__rpHide()")
        page.wait_for_timeout(1500)
        marks["scroll_start"] = time.time()
        plan = page.evaluate(SMOOTH_SCROLL_JS, {"budgetMs": 23000, "pauseMs": 1000, "holdMs": 1000})
        marks["scroll_end"] = time.time()
        log.info("scroll: page %spx, move %.1fs, %d pauses", plan.get("maxY"), plan.get("moveMs", 0) / 1000,
                 plan.get("stops", 0))

        try:
            sections = page.evaluate(SECTIONS_JS, MAX_SECTION_CLIPS)
        except PWError:
            sections = []
        log.info("> Recording %d section clips", len(sections))
        for s in sections:
            y = s["y"]
            page.evaluate(f"scrollTo(0, {y})")
            page.evaluate(PLAY_VIDEOS_JS)
            page.wait_for_timeout(400)
            s["start"] = time.time()
            page.evaluate(DRIFT_JS, {"fromY": y, "px": min(s["h"] * 0.3, 300), "ms": CLIP_SECONDS * 1000})
            for hv in s["hover"]:
                try:
                    box = page.locator(f"[data-rp-hover='{hv}']").bounding_box(timeout=500)
                    if box:
                        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=12)
                        page.wait_for_timeout(1200)
                except PWError:
                    pass
            left = CLIP_SECONDS - (time.time() - s["start"])
            if left > 0:
                page.wait_for_timeout(left * 1000)
            s["end"] = time.time()
        video = page.video
        t_close = time.time()
        ctx.close()
        raw_dest = raw_dir / "00_page_scroll.webm"
        raw_dir.mkdir(parents=True, exist_ok=True)
        scroll_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(Path(video.path())), raw_dest)
    except PWError as e:
        return [], "Scroll recording failed: " + str(e).splitlines()[0][:150]
    finally:
        browser.close()
        shutil.rmtree(tmp, ignore_errors=True)

    k = (ffprobe(raw_dest).get("duration") or (t_close - t0)) / max(t_close - t0, 0.1)
    log.debug("recording clock factor %.3f", k)
    main = scroll_dir / "00_page_scroll.mp4"
    start = (marks["scroll_start"] - t0) * k + 0.1
    dur = min((marks["scroll_end"] - marks["scroll_start"]) * k, 25.0)
    if not encode_segment(raw_dest, main, start, dur, (OUT_W, OUT_H)):
        return [], "Could not encode the scroll video."
    items = [{"path": main, "type": "page_scroll", "y": 0, "title": ""}]

    hashes, n = [], 0
    for s in sections:
        if "end" not in s:
            continue
        name = slug(s["heading"]) if s["heading"] else ("hero" if s["y"] < REC_VIEWPORT["height"] else f"clip{n + 1:02d}")
        dest = scroll_dir / f"{n + 1:02d}_{name}.mp4"
        if not encode_segment(raw_dest, dest, (s["start"] - t0) * k, (s["end"] - s["start"]) * k, (OUT_W, OUT_H)):
            continue
        h = phash(dest, "video")
        if h is not None and any(h - o <= NEAR_DUP for o in hashes):
            log.debug("section clip %s looks like an earlier one; dropped", dest.name)
            dest.unlink(missing_ok=True)
            continue
        if h is not None:
            hashes.append(h)
        n += 1
        items.append({"path": dest, "type": "section_clip", "y": s["y"], "title": s["heading"]})
    return items, None


# ---------------------------------------------------------------- main flow

def clear_dir(d):
    """Delete a folder. Windows can hold a just-written file open for a moment (indexer, antivirus),
    so retry, and if a file still won't go, leave it to be overwritten."""
    for _ in range(6):
        shutil.rmtree(d, ignore_errors=True)
        if not d.exists():
            return
        time.sleep(0.5)
    log.debug("could not fully clear %s", d)


def extract(url, out_dir):
    started = time.time()
    if "://" not in url:
        url = "https://" + url
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for sub in (*CATEGORIES, "raw", ".staging", "gifs_videos"):
        clear_dir(out_dir / sub)
    for name in ("manifest.json", "report.json", "run.log"):
        (out_dir / name).unlink(missing_ok=True)
    for sub in (*CATEGORIES, "raw", ".staging"):
        (out_dir / sub).mkdir(exist_ok=True)

    fh = logging.FileHandler(out_dir / "run.log", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S"))
    log.addHandler(fh)

    state = {"url": url, "tool": tool_name(url), "status": "failed", "message": "", "http_status": None,
             "attempts": [], "network": {}, "media_requests": [], "console_errors": [], "bot_check": False,
             "reasons": {}}
    manifest = []
    try:
        log.info("> Opening %s", url)
        manifest = _extract(url, out_dir, state)
    except Exception as e:
        log.exception("extract crashed")
        state["status"] = "failed"
        state["message"] = state["message"] or f"Extraction crashed ({type(e).__name__}) - nothing extracted."
    finally:
        shutil.rmtree(out_dir / ".staging", ignore_errors=True)
        out_dir.mkdir(parents=True, exist_ok=True)
        counts = {c: sum(1 for m in manifest if m["category"] == c) for c in CATEGORIES}
        report = {
            "url": url, "tool": state["tool"], "status": state["status"], "message": state["message"],
            "http_status": state["http_status"], "attempts": state["attempts"], "counts": counts,
            "empty_reasons": {c: r for c, r in state["reasons"].items() if not counts.get(c)},
            "skipped": state.get("skipped", {}), "found": state.get("found", {}),
            "failed_downloads": state.get("failed", []), "embeds": state.get("embeds", []),
            "scroll_video": state.get("scroll_info", {}),
            "viewport": state.get("viewport"), "user_agent": state.get("user_agent"),
            "bot_check": state["bot_check"], "console_errors": state["console_errors"],
            "media_requests": state["media_requests"], "seconds": round(time.time() - started, 1),
            "finished": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        (out_dir / "manifest.json").write_text(json.dumps(
            {"kind": "extract", "url": url, "tool": state["tool"], "status": state["status"],
             "message": state["message"], "counts": counts, "finished": report["finished"], "items": manifest},
            indent=2), encoding="utf-8")
        log.info("done in %.0fs: %s", report["seconds"], ", ".join(f"{c} {n}" for c, n in counts.items()))
        log.removeHandler(fh)
        fh.close()
    return report, manifest


def _extract(url, out_dir, state):
    staging, raw_dir = out_dir / ".staging", out_dir / "raw"
    found, cands = {}, []
    with sync_playwright() as pw:
        browser, ctx, page = open_page(pw, url, state)
        if page is None:
            st = state["http_status"]
            state["message"] = (f"Site returned {st} - nothing extracted. Try again." if st else
                                "Site did not load (timed out) - nothing extracted. Try again.")
            state["reasons"] = {c: state["message"] for c in CATEGORIES}
            return []
        try:
            close_cookie_popups(page)
            log.info("> Scrolling the page")
            page.evaluate(PROMOTE_LAZY_JS)
            collect(page, found)
            scroll_page(page, found)
            click_reveals(page, found)
            try:
                log.info("scrolled %d nested scrollers", page.evaluate(SCROLL_NESTED_JS))
            except PWError:
                pass
            page.evaluate("scrollTo(0, 0)")
            page.wait_for_timeout(300)
            headings = page.evaluate(HEADINGS_JS)
            collect(page, found, bg=True)
            for u, it in found.items():
                cands.append({"url": u, "kind": it["kind"], "y": it["y"] if it.get("h", 0) > 0 else None, "ct": ""})
            for u, it in state["network"].items():
                if u not in found:
                    cands.append({"url": u, "kind": it["kind"], "y": None, "ct": it["ct"]})
            for c in cands:
                if c["kind"] == "img" and is_video_url(c["url"]):
                    c["kind"] = "video"
            log.info("found %d media URLs (%d in the page, %d from network only)",
                     len(cands), len(found), len(cands) - len(found))
            staged = download_all(pw, ctx, page, cands, staging, raw_dir, state)
        finally:
            browser.close()

        state["status"] = "ok"
        if state["bot_check"]:
            state["message"] = "Site showed a bot check - results may be incomplete."
        log.info("> Recording scroll video")
        scroll_items, err = record_scroll(pw, url, out_dir)
        state["scroll_info"] = {"error": err, "section_clips": max(0, len(scroll_items) - 1)}
        if err:
            log.warning("scroll video: %s", err)

    log.info("> Sorting files")
    manifest = finish(staged, scroll_items, headings, out_dir, state)
    state["reasons"]["scroll"] = err or "no scroll video was recorded"
    if not manifest:
        state["message"] = state["message"] or "Nothing extracted from this page."
    return manifest


def download_all(pw, ctx, page, cands, staging, raw_dir, state):
    """Download every candidate. Returns staged files: {path, url, y, kind[, title]}."""
    ref = page.url
    cookies = ctx.cookies()
    ua = state.get("user_agent") or MOBILE_UA
    videos = [c for c in cands if c["kind"] == "video"]
    hls = [c for c in videos if c["url"].lower().split("?")[0].endswith(".m3u8") or "mpegurl" in c["ct"]]
    videos = [c for c in videos if c not in hls][:MAX_VIDEOS] + hls[:MAX_HLS]
    images = [c for c in cands if c["kind"] == "img"]
    iframes = [c for c in cands if c["kind"] == "iframe"]
    embeds = [c for c in iframes if EMBED_RE.search(c["url"])]
    state["found"] = {"video_urls": len(videos), "iframes": len(iframes), "video_iframes": len(embeds),
                      "image_urls": len(images)}
    state["failed"] = []
    staged = []
    jobs = videos + images
    log.info("> Downloading %d files", len(jobs))

    def one(i_c):
        i, c = i_c
        stem = staging / f"f{i:04d}"
        staging.mkdir(parents=True, exist_ok=True)
        path, err = download(c["url"], stem, ref, cookies, ua, c["ct"])
        return i, c, stem, path, err

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(one, enumerate(jobs)))
    for i, c, stem, path, err in results:
        if path is None and err and err.startswith("HTTP 40"):
            path, _ = browser_fetch(ctx, c["url"], stem, ref)
        if path is None:
            state["failed"].append({"url": c["url"], "error": err})
            continue
        staged.append({"path": path, "url": c["url"], "y": c["y"], "kind": c["kind"]})
    log.info("downloaded %d of %d (%d failed)", len(staged), len(jobs), len(state["failed"]))

    seen, state["embeds"] = set(), []
    for i, c in enumerate(embeds):
        target = embed_url(c["url"])
        if target in seen:
            continue
        seen.add(target)
        log.info("> Downloading embed %s", target)
        path, err = ytdlp(target, staging, f"e{i:03d}", ref)
        entry = {"url": c["url"], "resolved": target}
        if path:
            title = staging / f"e{i:03d}.title"
            entry["result"] = "downloaded"
            staged.append({"path": path, "url": c["url"], "y": c["y"], "kind": "embed",
                           "title": title.read_text(encoding="utf-8") if title.exists() else ""})
        else:
            log.info("yt-dlp could not fetch it (%s); recording it playing", err)
            path, err2 = record_embed(pw, c["url"], ref, raw_dir, staging, f"embed_{i:02d}")
            entry["result"] = "recorded playing" if path else f"failed: {err}; recording: {err2}"
            if path:
                staged.append({"path": path, "url": c["url"], "y": c["y"], "kind": "embed_recording"})
        state["embeds"].append(entry)
    return staged


def finish(staged, scroll_items, headings, out_dir, state):
    """Classify, filter stills, dedupe per category, name by page position, make mp4 versions."""
    skipped = {"under_5kb": 0, "favicon": 0, "tracking_pixel": 0, "svg": 0, "not_media": 0,
               "duplicate_sha256": 0, "duplicate_phash": 0, "convert_failed": 0}
    groups = {"embedded": [], "gifs": [], "images": []}
    for it in staged:
        kind, facts = inspect(it["path"])
        it["facts"] = facts
        if kind == "video":
            it["type"] = it["kind"] if it["kind"] in ("embed", "embed_recording") else "video"
            groups["embedded"].append(it)
        elif kind == "animated":
            fmt = facts.get("format") or "?"
            it["type"] = "gif" if fmt == "GIF" else "animated_" + {"PNG": "png"}.get(fmt, fmt.lower())
            groups["gifs"].append(it)
        elif kind in ("still", "gif-still"):
            w, h = facts.get("width") or 0, facts.get("height") or 0
            if facts.get("format") == "ICO" or FAVICON_RE.search(it["url"]):
                skipped["favicon"] += 1
            elif max(w, h) <= 3 or w * h <= 16 or (TRACKING_RE.search(it["url"]) and max(w, h) < 50):
                skipped["tracking_pixel"] += 1
            elif it["path"].stat().st_size < MIN_BYTES:
                skipped["under_5kb"] += 1
            else:
                it["type"] = "image"
                groups["images"].append(it)
        elif kind == "svg":
            skipped["svg"] += 1
        else:
            skipped["not_media"] += 1

    manifest = []
    for cat, items in groups.items():
        # dedupe: SHA-256, then perceptual hash of the middle frame; keep the biggest at its earliest position
        items.sort(key=lambda it: -((it["facts"].get("width") or 0) * (it["facts"].get("height") or 0)))
        kept, shas, hashes = [], {}, []
        mkind = {"embedded": "video", "gifs": "animated", "images": "still"}[cat]
        for it in items:
            digest = sha256(it["path"])
            if digest in shas:
                skipped["duplicate_sha256"] += 1
                _merge_pos(shas[digest], it)
                continue
            h = phash(it["path"], mkind)
            twin = next((o for o, oh in hashes if h is not None and oh is not None and h - oh <= NEAR_DUP
                         and _similar_shape(o, it, cat)), None)
            if twin is not None:
                skipped["duplicate_phash"] += 1
                _merge_pos(twin, it)
                continue
            shas[digest] = it
            hashes.append((it, h))
            kept.append(it)
        kept.sort(key=lambda it: (it["y"] is None, it["y"] or 0))
        for n, it in enumerate(kept, 1):
            label = section_for(it["y"], headings, ASSET_VIEWPORT["height"])
            if it["y"] is None and it.get("title"):
                label = slug(it["title"])
            entry = place(cat, it, f"{n:02d}_{label}", out_dir)
            if entry is None:
                skipped["convert_failed"] += 1
                continue
            entry.update(page_order=n, page_y=it["y"], section=label)
            manifest.append(entry)

    for n, it in enumerate(scroll_items):
        p, f = it["path"], ffprobe(it["path"])
        manifest.append({"category": "scroll", "type": it["type"], "filename": p.name, "path": f"scroll/{p.name}",
                         "mp4": f"scroll/{p.name}", "source_url": state["url"],
                         "original_filename": "recorded with Playwright", "width": f.get("width"),
                         "height": f.get("height"), "duration": f.get("duration"), "size_bytes": p.stat().st_size,
                         "page_order": n, "page_y": it["y"], "section": slug(it["title"]) if it["title"] else ""})

    state["skipped"] = skipped
    found, emb = state.get("found", {}), state.get("embeds", [])
    state["reasons"].update({
        "embedded": (f"found {found.get('video_urls', 0)} video URLs and {len(emb)} video iframes, "
                     "but none could be downloaded or recorded" if found.get("video_urls") or emb else
                     "no <video> tags, no direct .mp4/.webm/.mov/.m3u8 links, no YouTube/Vimeo/Loom/Wistia iframes"
                     f" ({found.get('iframes', 0)} other iframes)"),
        "gifs": (f"no .gif files and no animated webp/png/avif ({found.get('image_urls', 0)} image URLs checked, "
                 "all single-frame)"),
        "images": (f"no still images left after filtering ({skipped['under_5kb']} under 5 KB, {skipped['favicon']} "
                   f"favicons, {skipped['tracking_pixel']} tracking pixels, {skipped['svg']} SVGs)"),
    })
    return manifest


def _merge_pos(keep, dup):
    if dup["y"] is not None and (keep["y"] is None or dup["y"] < keep["y"]):
        keep["y"] = dup["y"]


def _similar_shape(a, b, cat):
    if cat != "images":
        return True
    try:
        ra = a["facts"]["width"] / a["facts"]["height"]
        rb = b["facts"]["width"] / b["facts"]["height"]
    except (KeyError, ZeroDivisionError, TypeError):
        return False
    return abs(ra - rb) / max(ra, rb) < 0.05


def place(cat, it, stem, out_dir):
    """Move a staged file into its category folder under its final name; make the mp4 version."""
    src, facts = it["path"], it["facts"]
    folder = out_dir / cat
    folder.mkdir(parents=True, exist_ok=True)
    (out_dir / "raw").mkdir(exist_ok=True)
    ext = src.suffix.lower() or ".bin"
    entry = {"category": cat, "type": it["type"], "source_url": it["url"], "original_filename": original_name(it["url"]),
             "width": facts.get("width"), "height": facts.get("height"), "duration": facts.get("duration")}
    if cat == "images":
        if ext in (".bin", ".jpeg"):
            ext = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif", "AVIF": ".avif"}.get(facts.get("format"), ".jpg")
        dest = folder / f"{stem}{ext}"
        shutil.move(str(src), dest)
        entry.update(filename=dest.name, path=f"{cat}/{dest.name}", mp4=None, size_bytes=dest.stat().st_size)
        return entry
    if cat == "gifs":
        ext = {"GIF": ".gif", "WEBP": ".webp", "PNG": ".png", "AVIF": ".avif"}.get(facts.get("format"), ext)
        dest = folder / f"{stem}{ext}"
        shutil.move(str(src), dest)
        mp4 = folder / f"{stem}.mp4"
        if not animated_to_mp4(dest, mp4, facts):
            log.warning("could not convert %s to mp4", dest.name)
            mp4 = None
        entry.update(filename=dest.name, path=f"{cat}/{dest.name}", mp4=f"{cat}/{mp4.name}" if mp4 else None,
                     size_bytes=dest.stat().st_size, mp4_size_bytes=mp4.stat().st_size if mp4 else None)
        return entry
    dest = folder / f"{stem}.mp4"
    if not to_mp4_video(src, dest):
        return None
    if ext != ".mp4" and it["type"] != "embed_recording":
        shutil.move(str(src), out_dir / "raw" / f"{stem}{ext}")
    if it["type"] == "embed_recording":
        entry["original_filename"] = "recorded playing in the browser"
    elif it.get("title"):
        entry["original_filename"] = it["title"]
    f = ffprobe(dest)
    entry.update(filename=dest.name, path=f"{cat}/{dest.name}", mp4=f"{cat}/{dest.name}", size_bytes=dest.stat().st_size,
                 width=f.get("width"), height=f.get("height"), duration=f.get("duration"))
    return entry


def main():
    ap = argparse.ArgumentParser(description="Extract a site's scroll video, embedded clips, GIFs and images.")
    ap.add_argument("url_pos", nargs="?", help=argparse.SUPPRESS)
    ap.add_argument("--url", help="website URL, e.g. https://gamma.app")
    ap.add_argument("--out", help="output folder (default out/<domain>/)")
    a = ap.parse_args()
    url = a.url or a.url_pos
    if not url:
        ap.error("--url is required")
    if "://" not in url:
        url = "https://" + url
    out_dir = Path(a.out) if a.out else ROOT / "out" / tool_name(url)

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(logging.INFO)
    console.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%H:%M:%S"))
    log.addHandler(console)
    log.setLevel(logging.DEBUG)
    for noisy in ("urllib3", "PIL"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    report, manifest = extract(url, out_dir)
    print()
    print(f"{report['tool']}  ({url})  status: {report['status']}" + (f"  - {report['message']}" if report["message"] else ""))
    for c in CATEGORIES:
        files = [m for m in manifest if m["category"] == c]
        line = f"  {c:<9} {len(files):>3} files  {humans(sum(m['size_bytes'] for m in files)):>9}"
        if not files and c in report["empty_reasons"]:
            line += f"  ({report['empty_reasons'][c]})"
        print(line)
    print(f"  folder: {out_dir.resolve()}")
    return 0 if report["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
