"""
grabber.py - stage 2: scan a tool's website and record a clip of each section.

    python -m pipeline.grabber https://gamma.app gamma [--sections 8] [--headed]

Using Playwright at 1080x1920 it:
  1. closes cookie popups and hides chat widgets,
  2. saves out/<tool>/site_data.json (title, description, h1/h2, feature text,
     video URLs, large image URLs, recorded sections) and out/<tool>/hero.png,
  3. records an 8-10s clip of each distinct section (one per heading, up to 8):
     smooth scroll in, hover over elements, drift down -> clips/clipNN_<heading>.mp4,
  4. re-records any clip that QA finds "mostly static" once with more motion
     (plays the section's video, scrolls slowly, hovers buttons/cards),
  5. downloads <video>/<source> files (and embedded YouTube/Vimeo demos via yt-dlp),
  6. writes out/<tool>/manifest.json with the clips in "library" (section heading,
     text, QA result). The match stage (matcher.py) turns script.txt into shots
     and picks the best library clip for each.

site_data.json and manifest.json are always written; if the grab fails, the
error is in both. Bot checks are detected and reported, never bypassed. Public
pages only: never fills forms or signs in. Uploaded (_manual) clips are kept.
"""

import argparse
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

from . import qa
from .browser_utils import launch_or_connect, block_resources, safe_close

W, H = 1080, 1920
VIEWPORT_W, VIEWPORT_H = 390, 844
MIN_CLIP_S, MAX_CLIP_S = 8.0, 10.0
MAX_SECTIONS = 8
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1")

log = logging.getLogger("grabber")


def mobile_device(p):
    """Return an iPhone 14 phone device profile configured for 390x844 mobile layout."""
    dev = dict(p.devices["iPhone 14"])
    dev["viewport"] = {"width": VIEWPORT_W, "height": VIEWPORT_H}
    dev["is_mobile"] = True
    dev["has_touch"] = True
    return dev


def check_mobile_layout(page, log_obj=log):
    """Check and log the viewport size and user agent for mobile layout verification."""
    vp = page.viewport_size
    ua = page.evaluate("navigator.userAgent")
    log_obj.info("Playwright mobile layout check: viewport=%s, user_agent=%s", vp, ua)
    print(f"Playwright mobile layout check: viewport={vp}, user_agent={ua}")
    return vp, ua

# ---------- popups & widgets ----------

COOKIE_SELECTORS = [
    "#onetrust-accept-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    "button[data-testid*='accept' i]",
    "button[id*='accept' i]",
    "button[class*='accept' i]",
    ".cc-allow", ".cc-dismiss",
]
COOKIE_TEXT = re.compile(
    r"^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(ay)?|"
    r"i understand|understood|continue|close|dismiss|no thanks|reject( all)?)\s*$",
    re.I,
)

# Stays in the page, so widgets that load late are hidden too.
CHAT_WIDGET_CSS = """
#intercom-container, #intercom-frame, .intercom-lightweight-app, .intercom-launcher,
iframe[name^="intercom"], #hubspot-messages-iframe-container, #drift-widget,
#drift-frame-controller, #drift-frame-chat, .drift-frame-controller, .crisp-client,
iframe#launcher, #webWidget, [id^="tawk"], .tawk-min-container, #fc_frame,
#chat-widget-container, #tidio-chat, #beacon-container, .BeaconFabButtonFrame,
.zsiq_floatmain, #zsiq_float, #gorgias-chat-container, #front-chat-container,
iframe[title*="chat" i], iframe[title*="messaging" i], [id*="chat-widget" i],
[class*="chat-widget" i], [class*="ChatWidget"], [aria-label*="open chat" i]
{ display: none !important; visibility: hidden !important; }
"""

# Generic fallback: small fixed boxes in the bottom corners that look like chat launchers.
HIDE_CORNER_WIDGETS_JS = """
() => {
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
}
"""

HIDE_COOKIE_BANNERS_JS = """
() => document.querySelectorAll('body *').forEach(el => {
  const st = getComputedStyle(el);
  if ((st.position === 'fixed' || st.position === 'sticky') &&
      /cookie|consent|gdpr|privacy/i.test(el.id + ' ' + el.className + ' ' + (el.innerText || '').slice(0, 400)) &&
      el.getBoundingClientRect().height < innerHeight * 0.9)
    el.style.setProperty('display', 'none', 'important');
})
"""

BOT_CHECK_RE = re.compile(
    r"just a moment|verify (that )?you are (a )?human|checking (if the site connection|your browser)|"
    r"attention required|are you a robot|pardon our interruption|access denied|captcha|"
    r"enable javascript and cookies to continue|request blocked|unusual traffic", re.I)

# ---------- page scripts ----------

# Fake cursor so hovers are visible in the recording (headless video has no pointer).
CURSOR_JS = """
(() => {
  if (window.__gvCursor) return;
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;' +
    'border-radius:50%;background:rgba(255,255,255,.85);border:3px solid rgba(0,0,0,.75);' +
    'box-shadow:0 2px 10px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;' +
    'transition:transform .08s;transform:translate(-100px,-100px)';
  document.documentElement.appendChild(c);
  window.__gvCursor = c;
  addEventListener('mousemove', e => c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`, true);
})();
"""

SMOOTH_SCROLL_JS = """
([target, ms]) => new Promise(res => {
  const start = scrollY, dist = target - start, t0 = performance.now();
  const ease = t => t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;
  const step = now => {
    const p = Math.min(1, (now - t0) / ms);
    scrollTo(0, start + dist * ease(p));
    p < 1 ? requestAnimationFrame(step) : res();
  };
  requestAnimationFrame(step);
})
"""

# Content blocks top to bottom: page-y, height, visible text, and whether they hold media.
FIND_BLOCKS_JS = """
() => {
  const vh = innerHeight, vw = innerWidth;
  const els = new Set(document.querySelectorAll(
    'header, main section, section, main > div, [class*="section" i], [id*="section" i], ' +
    '[class*="hero" i], article, footer'));
  // Headings mark sections even on div-soup pages: use their nearest tall ancestor.
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
  const out = [];  // keep the tightest block for each screen position
  for (const b of blocks) if (!out.length || b.y - out[out.length - 1].y > vh * 0.3) out.push(b);
  return {blocks: out, height: document.documentElement.scrollHeight, vh};
}
"""

# Hover targets currently in the viewport: buttons, cards, images, links.
HOVER_TARGETS_JS = """
([bandTop, bandBottom]) => {
  const vh = innerHeight, vw = innerWidth;
  const els = [...document.querySelectorAll(
    'button, a[class*="btn" i], a[class*="button" i], [role="button"], [class*="card" i], img, video, picture, h2, h3')];
  const pts = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) continue;
    if (r.top < vh * 0.1 || r.bottom > vh * 0.92 || r.left < 0 || r.right > vw) continue;
    const pageY = r.top + scrollY;  // only hover inside the matched section, if one is given
    if (bandBottom > bandTop && (pageY < bandTop || pageY > bandBottom)) continue;
    pts.push([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
  }
  const out = [];
  for (const p of pts) if (!out.some(q => Math.hypot(p[0]-q[0], p[1]-q[1]) < 200)) out.push(p);
  return out.slice(0, 6);
}
"""

# One URL per <video>: its playing source, else the first mp4 <source>, else any <source>.
# Also picks up lazy-loaded (data-src, data-lazy-src) and autoplay background videos.
VIDEO_SRCS_JS = """
() => {
  const ok = u => u && !u.startsWith('blob:') && !u.startsWith('data:');
  const urls = [];
  document.querySelectorAll('video').forEach(v => {
    const lazySrc = v.getAttribute('data-src') || v.getAttribute('data-lazy-src') ||
                    v.getAttribute('data-video-src') || v.getAttribute('data-url') || null;
    const sources = [...v.querySelectorAll('source')].map(s =>
      s.src || s.getAttribute('data-src') || s.getAttribute('data-lazy-src')).filter(ok);
    const pick = [v.currentSrc, v.src, lazySrc].find(ok)
      || sources.find(u => /\\.mp4(\\?|$)/i.test(u)) || sources[0];
    if (pick) urls.push({pick, all: sources.concat([v.currentSrc, v.src, lazySrc].filter(ok)),
                         autoplay: v.autoplay || v.hasAttribute('autoplay'),
                         muted: v.muted, loop: v.loop});
  });
  return urls;
}
"""

# A second-pass JS that tries to force-load hidden/lazy <video> elements so their src resolves.
LAZY_VIDEO_TRIGGER_JS = """
() => {
  let n = 0;
  document.querySelectorAll('video').forEach(v => {
    // Promote data-src / data-lazy-src to src so the browser fetches the real URL
    ['data-src','data-lazy-src','data-video-src','data-url'].forEach(attr => {
      const u = v.getAttribute(attr);
      if (u && !v.src) { v.src = u; n++; }
    });
    // Promote on child <source> elements too
    v.querySelectorAll('source').forEach(s => {
      ['data-src','data-lazy-src'].forEach(attr => {
        const u = s.getAttribute(attr);
        if (u && !s.src) { s.src = u; n++; }
      });
    });
    v.load();
  });
  return n;
}
"""

# Collect all embed iframe srcs matching known demo platforms.
ALL_EMBEDS_JS = """
() => {
  const re = /youtube|youtu\\.be|vimeo|wistia|loom\\.com\\/embed|mux\\.com|bunnycdn|jwplatform|kaltura|brightcove|vidyard/i;
  return [...document.querySelectorAll('iframe')]
    .map(f => f.src || f.getAttribute('data-src') || '')
    .filter(s => s && re.test(s))
    .map(s => s.split('?')[0]);
}
"""

# Page facts for site_data.json: title, description, headings, feature text, videos, big images.
SITE_DATA_JS = """
() => {
  const clean = t => (t || '').replace(/\\s+/g, ' ').trim();
  const vis = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const abs = u => { try { return new URL(u, location.href).href; } catch (e) { return null; } };
  const ok = u => u && !u.startsWith('blob:') && !u.startsWith('data:');
  const uniq = a => [...new Set(a.filter(Boolean))];
  const meta = n => { const m = document.querySelector(`meta[name="${n}"], meta[property="${n}"]`);
    return m ? clean(m.content) : ''; };
  const heads = tag => uniq([...document.querySelectorAll(tag)].filter(vis).map(h => clean(h.innerText)))
    .filter(t => t.length > 1 && t.length < 200);

  // Feature text: each h3/h4 (or card heading) with the first paragraph that follows it.
  const features = [];
  const seen = new Set();
  for (const h of document.querySelectorAll('h3, h4, [class*="feature" i] :is(h2, h3, strong)')) {
    if (!vis(h)) continue;
    const title = clean(h.innerText);
    if (!title || title.length > 120 || seen.has(title)) continue;
    let p = null, el = h;
    for (let i = 0; i < 4 && el && !p; i++) {
      let sib = el.nextElementSibling;
      while (sib && !p) { if (/^(P|DIV|SPAN)$/.test(sib.tagName) && clean(sib.innerText).length > 20) p = sib; sib = sib.nextElementSibling; }
      el = el.parentElement;
    }
    const text = p ? clean(p.innerText).slice(0, 300) : '';
    seen.add(title);
    features.push({title, text});
    if (features.length >= 40) break;
  }

  const videos = [];
  document.querySelectorAll('video').forEach(v => {
    [v.currentSrc, v.src, v.getAttribute('data-src')].forEach(u => ok(u) && videos.push(abs(u)));
    v.querySelectorAll('source').forEach(s => [s.src, s.getAttribute('data-src')].forEach(u => ok(u) && videos.push(abs(u))));
  });
  const embeds = [...document.querySelectorAll('iframe')].map(f => f.src)
    .filter(u => /youtube|vimeo|wistia|loom/.test(u || '')).map(u => u.split('?')[0]);

  const images = [];
  document.querySelectorAll('img').forEach(img => {
    const r = img.getBoundingClientRect(), u = img.currentSrc || img.src;
    if (!ok(u)) return;
    if (img.naturalWidth >= 600 || (r.width >= 400 && r.height >= 250))
      images.push({url: abs(u), width: img.naturalWidth, height: img.naturalHeight, alt: clean(img.alt).slice(0, 120)});
  });
  // CSS background images on large elements (hero art is often done this way).
  for (const el of document.querySelectorAll('body *')) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || !bg.includes('url(')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 400 || r.height < 250) continue;
    for (const m of bg.matchAll(/url\\(["']?([^"')]+)["']?\\)/g))
      if (ok(m[1])) images.push({url: abs(m[1]), width: Math.round(r.width), height: Math.round(r.height),
                                alt: '', css_background: true});
  }
  // Hero = the tall-enough ancestor of the first visible h1, measured from the top of the page.
  let heroBottom = 0;
  const h1 = [...document.querySelectorAll('h1')].find(vis);
  if (h1) {
    let el = h1;
    while (el.parentElement && el.parentElement !== document.body && el.getBoundingClientRect().height < 500)
      el = el.parentElement;
    heroBottom = Math.round(el.getBoundingClientRect().bottom + scrollY);
  }
  const imgSeen = new Set();
  return {
    hero_bottom: heroBottom,
    title: clean(document.title), description: meta('description') || meta('og:description'),
    h1: heads('h1'), h2: heads('h2'), features,
    videos: uniq(videos), embeds: uniq(embeds),
    images: images.filter(i => !imgSeen.has(i.url) && imgSeen.add(i.url)).slice(0, 60),
  };
}
"""

EMBED_RE = re.compile(r"(youtube\.com/embed/|youtube-nocookie\.com/embed/|player\.vimeo\.com/video/|wistia|loom\.com/embed/)")


def slugify(name):
    return re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-")


def close_cookie_popups(page):
    """Click common consent buttons (main frame and iframes), then hide leftover banners."""
    clicked = 0
    for frame in page.frames:
        for sel in COOKIE_SELECTORS:
            try:
                loc = frame.locator(sel).first
                if loc.is_visible(timeout=300):
                    loc.click(timeout=1500)
                    clicked += 1
            except Exception:
                pass
        try:
            buttons = frame.get_by_role("button", name=COOKIE_TEXT)
            for i in range(min(buttons.count(), 3)):
                b = buttons.nth(i)
                if b.is_visible(timeout=300):
                    b.click(timeout=1500)
                    clicked += 1
                    break
        except Exception:
            pass
    try:
        page.evaluate(HIDE_COOKIE_BANNERS_JS)
    except PlaywrightError:
        pass
    return clicked


def hide_chat_widgets(page):
    try:
        page.add_style_tag(content=CHAT_WIDGET_CSS)
        return page.evaluate(HIDE_CORNER_WIDGETS_JS)
    except PlaywrightError as e:
        log.warning("could not hide chat widgets: %s", e)
        return 0


def clean_page(page):
    clicked = close_cookie_popups(page)
    hidden = hide_chat_widgets(page)
    return clicked, hidden


# ---------- bot checks & loading ----------

def bot_check(page):
    """Return a short reason if the page looks like a bot-check/blocked page, else ''."""
    try:
        text = page.evaluate("() => (document.title + ' ' + (document.body ? document.body.innerText : '')).slice(0, 1500)")
    except PlaywrightError:
        return ""
    words = len(text.split())
    m = BOT_CHECK_RE.search(text)
    return f"bot check: '{m.group(0)}'" if m and words < 250 else ""


def load_page(page, url):
    """Navigate, tolerating slow sites. Returns (ok, reason)."""
    try:
        resp = page.goto(url, wait_until="domcontentloaded", timeout=45000)
    except PlaywrightTimeout:
        log.warning("timed out waiting for DOM of %s; continuing with what loaded", url)
        resp = None
    except PlaywrightError as e:
        return False, f"could not open page: {e.message.splitlines()[0]}"
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except PlaywrightTimeout:
        log.info("network never went idle (common with analytics/streams); continuing")
    page.wait_for_timeout(1500)

    # Some challenges clear themselves after a few seconds; wait, but never try to solve them.
    reason = bot_check(page)
    for _ in range(4):
        if not reason:
            break
        log.info("%s - waiting to see if it clears", reason)
        page.wait_for_timeout(4000)
        reason = bot_check(page)
    if reason:
        return False, reason
    if resp is not None and resp.status >= 400:
        return False, f"HTTP {resp.status}"
    try:
        if page.evaluate("() => (document.body ? document.body.innerText : '').trim().length") < 20:
            return False, "page loaded empty"
    except PlaywrightError as e:
        return False, f"page broke while loading: {e.message.splitlines()[0]}"
    return True, ""


# ---------- shot -> section matching ----------

STOP = set("""a an and are as at be by can for from get gets in into is it its of on or our that the
their then this to up use uses using with you your clip shot show shows showing screen page website
site section visible scroll scrolling over vertical close closeup shot view tool app just one""".split())


def _stem(w):
    for suf in ("ing", "es", "ed", "s"):
        if len(w) > 4 + len(suf) - 1 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def _tokens(text, drop=()):
    return {_stem(w) for w in re.findall(r"[a-z0-9]+", text.lower())
            if len(w) > 2 and w not in STOP and w not in drop}


# Every visible heading with the block it heads (nearest ancestor at least 300px tall), page-y.
HEADINGS_JS = """
() => {
  const out = [];
  document.querySelectorAll('h1, h2, h3, h4, h5, [role="heading"]').forEach(h => {
    const r = h.getBoundingClientRect(), st = getComputedStyle(h);
    if (r.width === 0 || r.height === 0 || st.display === 'none' || st.visibility === 'hidden') return;
    const text = (h.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!text || text.length > 160) return;
    let el = h;
    while (el.parentElement && el.parentElement !== document.body && el.getBoundingClientRect().height < 300)
      el = el.parentElement;
    const b = el.getBoundingClientRect();
    out.push({text, tag: h.tagName.toLowerCase(), hy: Math.round(r.top + scrollY),
              y: Math.round(b.top + scrollY), h: Math.round(Math.min(b.height, innerHeight * 1.5))});
  });
  return out;
}
"""


def _words(text):
    return re.findall(r"[a-z0-9]+", text.lower().replace("'", ""))


def _common_run(a, b):
    """Length of the longest run of consecutive words shared by word lists a and b."""
    best, prev = 0, [0] * (len(b) + 1)
    for x in a:
        cur = [0] * (len(b) + 1)
        for j, y in enumerate(b, 1):
            if x == y:
                cur[j] = prev[j - 1] + 1
                best = max(best, cur[j])
        prev = cur
    return best


def match_heading(visual, headings):
    """Pick the heading named in a shot's "visual_needed" text.

    A quoted phrase ('Visual storytelling without limits') wins if a heading contains it; otherwise
    the heading sharing the longest run of consecutive words ("Meet your new creative partner
    section..." -> "Meet your new creative partner."). Needs 3+ words in a row, or the whole
    heading if it is shorter. Returns (heading, words_matched) or (None, reason)."""
    if not headings:
        return None, "no headings found on the page"
    vw = _words(visual)
    for phrase in re.findall(r"['\"‘“]([^'\"’”]{6,})['\"’”]", visual):
        pw = " ".join(_words(phrase))
        for hd in headings:
            if pw and pw in " ".join(_words(hd["text"])):
                return hd, len(pw.split())
    best, best_run = None, 0
    for hd in headings:
        hw = _words(hd["text"])
        run = _common_run(vw, hw)
        if run >= 3 or (run >= 2 and run == len(hw)):
            # prefer longer runs, then headings matched more completely, then the higher one on the page
            key = (run, run / max(len(hw), 1), -hd["hy"])
            if best is None or key > best[0]:
                best = (key, hd)
                best_run = run
    if best:
        return best[1], best_run
    return None, "no heading on the page shares 3+ consecutive words with it"


# ---------- recording ----------

def hover_around(page, seconds, band=(0, 0)):
    """Glide the mouse across visible interactive elements (inside `band`, page-y) for ~`seconds`."""
    end = time.monotonic() + seconds
    targets = (page.evaluate(HOVER_TARGETS_JS, list(band)) or page.evaluate(HOVER_TARGETS_JS, [0, 0])
               or [[VIEWPORT_W // 2, VIEWPORT_H // 2]])
    i = 0
    while time.monotonic() < end:
        x, y = targets[i % len(targets)]
        page.mouse.move(x, y, steps=25)
        page.wait_for_timeout(700)
        i += 1


def record_shot(page, block, max_y, vh, seconds, t0):
    """Scroll into the block, hover, drift. Returns (start, end) seconds into the recording."""
    # Short sections are centred on screen; tall ones start just above their top edge.
    offset = (vh - block["h"]) // 2 if block["h"] < vh * 0.8 else 40
    target = min(max(block["y"] - offset, 0), max_y)
    # Off-camera lead-in so the clip opens mid-motion rather than on a jump cut.
    page.evaluate(f"scrollTo(0, {max(target - vh // 3, 0)})")
    page.wait_for_timeout(500)
    start = time.monotonic() - t0
    if target > 0:
        page.evaluate(SMOOTH_SCROLL_JS, [target, 1500])
    hover_around(page, seconds * 0.5, (block["y"], block["y"] + block["h"]))
    drift = max(min(block["h"] - vh // 2, vh // 3), 120)
    page.evaluate(SMOOTH_SCROLL_JS, [min(target + drift, max_y), int(seconds * 300)])
    left = seconds - (time.monotonic() - t0 - start)
    if left > 0:
        page.wait_for_timeout(int(left * 1000))
    return start, time.monotonic() - t0


PLAY_VIDEOS_JS = """
([top, bottom]) => {
  let n = 0;
  document.querySelectorAll('video').forEach(v => {
    const r = v.getBoundingClientRect(), y = r.top + scrollY;
    if (r.width < 80 || y + r.height < top || y > bottom) return;
    v.muted = true; v.loop = true;
    const p = v.play(); if (p) p.catch(() => {});
    n++;
  });
  return n;
}
"""


def record_motion(page, block, max_y, vh, seconds, t0):
    """Retry for a static section: play its videos, then scroll slowly through it while
    hovering buttons/cards. Returns (start, end, videos_played)."""
    band = [block["y"], block["y"] + block["h"]]
    start_y = min(max(block["y"] - vh // 5, 0), max_y)
    end_y = min(max(block["y"] + block["h"] - vh * 3 // 4, start_y + vh // 2), max_y)
    page.evaluate(f"scrollTo(0, {start_y})")
    played = page.evaluate(PLAY_VIDEOS_JS, band)
    page.wait_for_timeout(400)
    start = time.monotonic() - t0
    steps = max(int(seconds / 0.6), 4)
    targets = []
    for i in range(steps):
        if i % 3 == 0:  # positions change as the page scrolls
            targets = page.evaluate(HOVER_TARGETS_JS, band) or page.evaluate(HOVER_TARGETS_JS, [0, 0]) or [[VIEWPORT_W // 2, VIEWPORT_H // 2]]
        y = start_y + (end_y - start_y) * (i + 1) / steps
        page.evaluate(SMOOTH_SCROLL_JS, [int(y), 450])
        x, ty = targets[i % len(targets)]
        page.mouse.move(x, ty, steps=10)
    left = seconds - (time.monotonic() - t0 - start)
    if left > 0:
        page.wait_for_timeout(int(left * 1000))
    return start, time.monotonic() - t0, played


def cut_clip(webm, start, end, out, seconds):
    dur = min(end - start, seconds + 0.5)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{start:.2f}", "-i", str(webm), "-t", f"{dur:.2f}",
        "-vf", f"scale={W}:{H}:flags=lanczos,fps=30",
        "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-an", str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=180)


# ---------- page videos ----------

def save_hero(page, hero_bottom, vh, out):
    """Screenshot the hero: top of the page down to the end of the h1's section (at most one screen)."""
    height = min(max(hero_bottom, 600), vh) if hero_bottom else vh
    vp_w = (page.viewport_size or {}).get("width", VIEWPORT_W)
    try:
        page.screenshot(path=str(out), clip={"x": 0, "y": 0, "width": vp_w, "height": height})
        return out.name
    except PlaywrightError as e:
        log.warning("hero screenshot failed: %s", e)
        return None


def convert_video_to_vertical_segments(video_path, clips_dir):
    """Convert video_path to 1080x1920 (blurred background if landscape),
    trimmed to 3-8s segments. Long videos cut into several segments.
    Returns list of generated segment Path objects."""
    dur, w, h = qa.probe(video_path)
    if dur <= 0:
        return []

    is_landscape = (w > h) or (w / max(h, 1) > (W / H) + 0.05)
    if is_landscape:
        vf = (
            f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=25:5[bg];"
            f"[0:v]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30"
        )
    else:
        vf = f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps=30"

    segments = []
    if dur <= 8.5:
        segments.append((0.0, max(min(dur, 8.0), 3.0)))
    else:
        t = 0.0
        while t < dur:
            rem = dur - t
            if rem < 3.0:
                break
            seg_len = min(6.0, rem)
            if rem - seg_len < 3.0 and rem <= 8.5:
                seg_len = rem
            segments.append((t, seg_len))
            t += seg_len

    generated = []
    base_stem = video_path.stem
    for i, (start_t, seg_dur) in enumerate(segments, 1):
        suffix = f"_seg{i:02d}" if len(segments) > 1 else "_seg01"
        out_name = f"{base_stem}{suffix}.mp4"
        out_path = clips_dir / out_name
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-ss", f"{start_t:.2f}", "-i", str(video_path), "-t", f"{seg_dur:.2f}",
            "-filter_complex" if is_landscape else "-vf", vf,
            "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-an", str(out_path)
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            if out_path.exists() and out_path.stat().st_size > 1000:
                generated.append(out_path)
        except Exception as e:
            log.warning("could not convert %s segment %d: %s", video_path.name, i, e)
    return generated


def download_videos(page, network_videos, dest, base_url, extra_urls=()):
    urls, seen = [], set()
    for v in page.evaluate(VIDEO_SRCS_JS):
        full = urljoin(base_url, v["pick"])
        if full not in seen:
            urls.append(full)
        seen.update(urljoin(base_url, u) for u in v["all"] + [v["pick"]])
    # Videos seen on the network but not attached to a <video> tag (e.g. loaded by script).
    for u in sorted(network_videos):
        if u not in seen:
            urls.append(u)
            seen.add(u)
    for u in extra_urls:
        full = urljoin(base_url, u)
        if full not in seen:
            urls.append(full)
            seen.add(full)
    saved = []
    for u in urls:
        try:
            resp = page.request.get(u, timeout=60000)
            if not resp.ok:
                log.warning("video %s: HTTP %s", u, resp.status)
                continue
            body = resp.body()
            if len(body) < 20_000:  # tracking pixels / tiny placeholders
                continue
            ctype = resp.headers.get("content-type", "").split(";")[0]
            ext = Path(urlparse(u).path).suffix.lower()
            if ext not in {".mp4", ".webm", ".mov", ".m4v"}:
                ext = mimetypes.guess_extension(ctype) or ".mp4"
            out = dest / f"site_video{len(saved) + 1:02d}{ext}"
            out.write_bytes(body)
            saved.append({"file": f"clips/{out.name}", "source": u, "mb": round(len(body) / 1e6, 1)})
        except Exception as e:
            log.warning("could not download video %s: %s", u, e)
    return saved


def download_embeds(page, dest):
    """Fetch embedded YouTube/Vimeo/Loom/Wistia players with yt-dlp, if installed."""
    srcs = []
    for f in page.evaluate("[...document.querySelectorAll('iframe')].map(f => f.src)"):
        if f and EMBED_RE.search(f) and f.split("?")[0] not in srcs:
            srcs.append(f.split("?")[0])
    ytdlp = shutil.which("yt-dlp")
    saved, missed = [], []
    for src in srcs:
        if not ytdlp:
            missed.append(src)
            continue
        out = dest / f"embed_video{len(saved) + 1:02d}.mp4"
        cmd = [ytdlp, "-q", "--no-warnings", "--no-playlist",
               "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
               "--merge-output-format", "mp4", "-o", str(out), src]
        try:
            ok = subprocess.run(cmd, capture_output=True, timeout=300).returncode == 0
        except subprocess.TimeoutExpired:
            ok = False
        if ok and out.exists():
            saved.append({"file": f"clips/{out.name}", "source": src, "mb": round(out.stat().st_size / 1e6, 1)})
        else:
            log.warning("yt-dlp could not fetch %s", src)
            missed.append(src)
    return saved, missed


# ---------- demo-video extraction ----------

# Section labels assigned to clips in order, for named output.
_SECTION_LABELS = [
    "hero", "use_case_1", "use_case_2", "use_case_3",
    "feature_1", "feature_2", "feature_3", "footer",
]


def _section_label(idx):
    """Return a human-readable section label for the idx-th video (0-indexed)."""
    if idx < len(_SECTION_LABELS):
        return _SECTION_LABELS[idx]
    return f"section_{idx + 1}"


def _trim_to_duration(src, out, duration_s, log_obj=log):
    """Re-encode src to 1080x1920 and trim to at most duration_s seconds.
    Uses the blurred-background letterbox from convert_video_to_vertical_segments.
    Returns True on success."""
    dur, w, h = qa.probe(src)
    if dur <= 0:
        log_obj.warning("trim_to_duration: can't probe %s", src)
        return False
    trim = min(float(duration_s), dur) if duration_s else min(dur, MAX_CLIP_S)
    trim = max(trim, 3.0)
    is_landscape = (w > h) or (w / max(h, 1) > (W / H) + 0.05)
    if is_landscape:
        vf = (
            f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=25:5[bg];"
            f"[0:v]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30"
        )
        filter_arg = "-filter_complex"
    else:
        vf = f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps=30"
        filter_arg = "-vf"
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", "0", "-i", str(src), "-t", f"{trim:.2f}",
        filter_arg, vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-an", str(out),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=240)
        return out.exists() and out.stat().st_size > 5000
    except Exception as e:
        log_obj.warning("trim_to_duration failed for %s: %s", src, e)
        return False


def _record_embed_playwright(p, src_url, out, headed=False, record_seconds=10.0, log_obj=log):
    """Record an embed (YouTube/Vimeo/etc.) playing in a Playwright browser session.
    Returns True if the recording succeeded and out was written."""
    log_obj.info("Playwright fallback: recording embed %s", src_url)
    with tempfile.TemporaryDirectory() as tmp:
        browser = launch_or_connect(p, headed=headed)
        video = None
        try:
            dev = mobile_device(p)
            ctx = browser.new_context(
                **dev,
                record_video_dir=tmp,
                record_video_size={"width": VIEWPORT_W, "height": VIEWPORT_H},
            )
            try:
                ctx.set_default_timeout(20000)
                page = ctx.new_page()
                try:
                    block_resources(page)
                    try:
                        page.goto(src_url, wait_until="domcontentloaded", timeout=30000)
                    except PlaywrightTimeout:
                        pass
                    except PlaywrightError as e:
                        log_obj.warning("embed load failed: %s", e)
                        return False
                    # Try to click the play button
                    for sel in ["button[aria-label*='play' i]", ".ytp-play-button", ".vp-play",
                                "button.play", "[data-plyr='play']", "video"]:
                        try:
                            loc = page.locator(sel).first
                            if loc.is_visible(timeout=1500):
                                loc.click(timeout=2000)
                                break
                        except Exception:
                            pass
                    # Also try JS autoplay on any <video> in the frame
                    try:
                        page.evaluate("() => { document.querySelectorAll('video').forEach(v => { v.muted=true; v.play().catch(()=>{}); }); }")
                    except Exception:
                        pass
                    page.wait_for_timeout(int(record_seconds * 1000))
                    video = page.video
                finally:
                    safe_close(page=page)
            finally:
                safe_close(context=ctx)
        finally:
            safe_close(browser=browser)

        if video is None:
            return False
        webm = Path(video.path())
        if not webm.exists():
            return False
        dur, _, _ = qa.probe(webm)
        if dur < 1.0:
            return False
        return _trim_to_duration(webm, out, record_seconds, log_obj)


def extract_demo_videos(
    url,
    tool,
    out_root="out",
    shot_list=None,
    headed=False,
    log_obj=None,
):
    """Full video extraction step for one tool:

    1. Loads the page with Playwright (mobile layout), scrolls to trigger lazy content.
    2. Collects direct <video> URLs (src, data-src, <source> children).
    3. Collects embed iframes (YouTube/Vimeo/Loom/Wistia/…).
    4. Downloads direct videos via HTTP (already in download_videos).
    5. Downloads embeds via yt-dlp; Playwright-records any that fail.
    6. Trims each clip to the matching shot's duration_seconds (or DEFAULT_CLIP_S).
    7. Saves to out/<tool>/clips/ named by section: hero.mp4, use_case_1.mp4, …
    8. Writes out/<tool>/video_extraction.log with a full count/source/type report.

    Returns a list of dicts: {section, file, source, type, duration_s, status}
    """
    DEFAULT_CLIP_S = 9.0
    url = url if url.startswith("http") else "https://" + url
    tool_slug = slugify(tool)
    tool_dir = Path(out_root) / tool_slug
    clips_dir = tool_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    # Set up a dedicated logger that also writes video_extraction.log
    vlog = logging.getLogger(f"grabber.video_extraction.{tool_slug}")
    vlog.setLevel(logging.INFO)
    for h in list(vlog.handlers):
        vlog.removeHandler(h)
        h.close()
    log_path = tool_dir / "video_extraction.log"
    fh = logging.FileHandler(log_path, mode="w", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%H:%M:%S"))
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter(f"  [{tool_slug}] %(message)s"))
    vlog.addHandler(fh)
    vlog.addHandler(ch)
    vlog.propagate = False
    if log_obj is None:
        log_obj = vlog

    # Build duration map from shot_list if provided
    duration_map = {}  # section_idx (0-based) -> duration_s
    if shot_list:
        for i, s in enumerate(shot_list):
            dur = s.get("duration_seconds") or DEFAULT_CLIP_S
            duration_map[i] = float(dur)
    vlog.info("=== Video extraction: %s  url=%s ===", tool, url)

    results = []
    network_videos = set()

    with sync_playwright() as p:
        # ---- Phase 1: scrape all video URLs ----
        browser = launch_or_connect(p, headed=headed)
        try:
            dev = mobile_device(p)
            ctx = browser.new_context(**dev)
            try:
                ctx.set_default_timeout(20000)
                page = ctx.new_page()
                try:
                    block_resources(page, block_types=("image", "font"))
                    page.on("response", lambda r: network_videos.add(r.url)
                            if r.headers.get("content-type", "").startswith("video/")
                            and not r.url.startswith("blob:") else None)

                    ok, reason = load_page(page, url)
                    if not ok:
                        vlog.error("page failed to load: %s", reason)
                        return results

                    clean_page(page)
                    # Full scroll to trigger lazy loading
                    info = page.evaluate(FIND_BLOCKS_JS)
                    for y in range(0, info["height"], info["vh"] // 2):
                        page.evaluate(f"scrollTo(0, {y})")
                        page.wait_for_timeout(200)
                    # Trigger lazy data-src promotion
                    promoted = page.evaluate(LAZY_VIDEO_TRIGGER_JS)
                    vlog.info("lazy-video trigger promoted %d src attributes", promoted)
                    page.wait_for_timeout(1500)

                    # Collect direct video URLs
                    direct_entries = page.evaluate(VIDEO_SRCS_JS)
                    final_url = page.url

                    # Also include any network-intercepted video URLs not already in direct_entries
                    direct_urls = {urljoin(final_url, v["pick"]) for v in direct_entries if v.get("pick")}
                    extra_urls = [u for u in sorted(network_videos) if u not in direct_urls]
                    extra_entries = [{"pick": u, "all": [u], "autoplay": False, "muted": False, "loop": False}
                                    for u in extra_urls]
                    all_direct = direct_entries + extra_entries

                    # Collect embed iframes
                    embed_srcs = []
                    for s in page.evaluate(ALL_EMBEDS_JS):
                        full = urljoin(final_url, s)
                        if full not in embed_srcs:
                            embed_srcs.append(full)

                    vlog.info("found %d direct video src(s), %d embed iframe(s)",
                              len(all_direct), len(embed_srcs))
                    if not all_direct and not embed_srcs:
                        vlog.info("NOTHING FOUND: no <video> tags or embed iframes on %s", url)

                    # ---- Phase 2: download direct videos ----
                    downloaded_direct = []
                    for entry in all_direct:
                        src_url = urljoin(final_url, entry["pick"])
                        vtype = "autoplay-bg" if entry.get("autoplay") and entry.get("muted") else "video"
                        try:
                            resp = page.request.get(src_url, timeout=60000)
                            if not resp.ok:
                                vlog.warning("HTTP %s for %s – skipped", resp.status, src_url)
                                continue
                            body = resp.body()
                            if len(body) < 20_000:
                                vlog.info("skip tiny file (%d bytes) %s", len(body), src_url)
                                continue
                            ext = Path(urlparse(src_url).path).suffix.lower()
                            if ext not in {".mp4", ".webm", ".mov", ".m4v"}:
                                ext = ".mp4"
                            raw = clips_dir / f"_raw_direct_{len(downloaded_direct) + 1:02d}{ext}"
                            raw.write_bytes(body)
                            downloaded_direct.append({"raw": raw, "source": src_url, "type": vtype})
                            vlog.info("downloaded direct video: %s  (%.1f MB, type=%s)",
                                      src_url, len(body) / 1e6, vtype)
                        except Exception as e:
                            vlog.warning("could not download %s: %s", src_url, e)
                finally:
                    safe_close(page=page)
            finally:
                safe_close(context=ctx)
        finally:
            safe_close(browser=browser)

        # ---- Phase 3: download embeds via yt-dlp (Playwright fallback on failure) ----
        ytdlp = shutil.which("yt-dlp")
        downloaded_embeds = []
        for src in embed_srcs:
            raw = clips_dir / f"_raw_embed_{len(downloaded_embeds) + 1:02d}.mp4"
            if ytdlp:
                cmd = [ytdlp, "-q", "--no-warnings", "--no-playlist",
                       "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
                       "--merge-output-format", "mp4", "-o", str(raw), src]
                try:
                    ok_dl = subprocess.run(cmd, capture_output=True, timeout=300).returncode == 0
                except subprocess.TimeoutExpired:
                    ok_dl = False
                if ok_dl and raw.exists() and raw.stat().st_size > 5000:
                    downloaded_embeds.append({"raw": raw, "source": src, "type": "embed-ytdlp"})
                    vlog.info("yt-dlp downloaded embed: %s  (%.1f MB)", src, raw.stat().st_size / 1e6)
                    continue
                else:
                    vlog.warning("yt-dlp failed for %s – falling back to Playwright recording", src)
            else:
                vlog.info("yt-dlp not found – using Playwright recording for %s", src)
            # Playwright fallback
            if _record_embed_playwright(p, src, raw, headed=headed, log_obj=vlog):
                downloaded_embeds.append({"raw": raw, "source": src, "type": "embed-playwright"})
                vlog.info("Playwright-recorded embed: %s", src)
            else:
                vlog.warning("embed could not be obtained: %s", src)

    # ---- Phase 4: trim, name by section, and write final clips ----
    all_clips = downloaded_direct + downloaded_embeds
    vlog.info("total clips to process: %d (%d direct, %d embed)",
              len(all_clips), len(downloaded_direct), len(downloaded_embeds))

    if not all_clips:
        vlog.info("no clips to trim – video extraction produced nothing for %s", tool)
    else:
        vlog.info("\nClip summary:")

    for i, entry in enumerate(all_clips):
        label = _section_label(i)
        dur_s = duration_map.get(i, DEFAULT_CLIP_S)
        out_name = f"{label}.mp4"
        out_path = clips_dir / out_name
        src_path = entry["raw"]
        success = _trim_to_duration(src_path, out_path, dur_s, vlog)
        status = "ok" if success else "failed"
        # Clean up raw file whether or not the trim succeeded
        try:
            src_path.unlink(missing_ok=True)
        except Exception:
            pass
        record = {
            "section": label,
            "file": f"clips/{out_name}",
            "source": entry["source"],
            "type": entry["type"],
            "duration_s": dur_s,
            "status": status,
        }
        results.append(record)
        probe_dur, _, _ = qa.probe(out_path) if success else (0, 0, 0)
        vlog.info("  [%s] %s  source=%s  type=%s  target=%.1fs  actual=%.1fs  status=%s",
                  label, out_name, entry["source"][:60], entry["type"], dur_s, probe_dur, status)

    # Summary footer
    ok_count = sum(1 for r in results if r["status"] == "ok")
    vlog.info("=== Done: %d/%d clips extracted for %s ===", ok_count, len(results), tool)
    if not results:
        vlog.info("  (no videos or embeds found on the page)")

    # Persist the results to video_extraction.json for later pipeline stages
    out_json = tool_dir / "video_extraction.json"
    out_json.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    vlog.info("results saved to %s", out_json)

    for h in list(vlog.handlers):
        vlog.removeHandler(h)
        h.close()
    return results


# ---------- main entry ----------

def _setup_logging(tool_dir):
    log.setLevel(logging.INFO)
    for h in list(log.handlers):
        log.removeHandler(h)
        h.close()
    fh = logging.FileHandler(tool_dir / "grab.log", mode="w", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%H:%M:%S"))
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter("  %(levelname)s %(message)s"))
    ch.setLevel(logging.WARNING)
    log.addHandler(fh)
    log.addHandler(ch)
    log.propagate = False


def clip_name(shot):
    words = slugify(shot.get("visual_needed", "")).split("-")
    name = "-".join(w for w in words if w)[:32].strip("-") or "clip"
    return f"shot{int(shot['shot']):02d}_{name}.mp4"


def load_shot_list(tool_dir):
    """out/<tool>/shot_list.json as a list of shots, or (None, reason)."""
    path = tool_dir / "shot_list.json"
    if not path.exists():
        return None, f"{path} not found (the script stage writes it)"
    try:
        shots = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return None, f"could not read {path.name}: {e}"
    if not isinstance(shots, list) or not all(isinstance(s, dict) and "shot" in s for s in shots):
        return None, f"{path.name} is not a list of shots with a 'shot' number"
    for s in shots:  # accept "Visual needed" / "visual needed" spellings too
        for k in list(s):
            if k != "visual_needed" and re.sub(r"[\s_]+", "_", k.strip().lower()) == "visual_needed":
                s["visual_needed"] = s.pop(k)
    return shots, ""


def library_name(n, title):
    name = slugify(title)[:32].strip("-") or "section"
    return f"clip{n:02d}_{name}.mp4"


def pick_sections(blocks, max_n=MAX_SECTIONS):
    """Distinct sections to record: one per heading, top to bottom, spread out if there are many."""
    seen, picks = set(), []
    for b in blocks:
        key = re.sub(r"\W+", " ", (b.get("title") or b["text"][:60]).lower()).strip()
        if key and key not in seen:
            seen.add(key)
            picks.append(b)
    if len(picks) > max_n:
        if max_n <= 1:
            picks = picks[:max_n]
        else:
            idx = sorted({round(i * (len(picks) - 1) / (max_n - 1)) for i in range(max_n)})
            picks = [picks[i] for i in idx]
    return picks


def _open_session(p, tmp, headed):
    browser = launch_or_connect(p, headed=headed)
    dev = mobile_device(p)
    ctx = browser.new_context(**dev,
                              record_video_dir=tmp,
                              record_video_size={"width": VIEWPORT_W, "height": VIEWPORT_H})
    ctx.set_default_timeout(20000)
    page = ctx.new_page()
    block_resources(page)
    check_mobile_layout(page, log)
    return browser, ctx, page


def _close_session(browser, ctx, page):
    video = page.video if page else None
    safe_close(page=page, context=ctx, browser=browser)
    return Path(video.path()) if video else None


def _prepare(page, url):
    """Load, clean, and scroll once so lazy content loads."""
    ok, reason = load_page(page, url)
    if not ok:
        raise RuntimeError(reason)
    clicked, hidden = clean_page(page)
    info = page.evaluate(FIND_BLOCKS_JS)
    for y in range(0, info["height"], info["vh"] // 2):
        page.evaluate(f"scrollTo(0, {y})")
        page.wait_for_timeout(250)
    clean_page(page)
    page.evaluate("scrollTo(0, 0)")
    page.wait_for_timeout(600)
    return clicked, hidden


def _is_static(reasons):
    return any(r.startswith("mostly static") for r in reasons)


def empty_site_data(url):
    return {"url": url, "final_url": None, "title": "", "description": "", "h1": [], "h2": [],
            "features": [], "videos": [], "embeds": [], "images": [], "hero_png": None,
            "sections_recorded": [], "error": None}


def grab(url, tool, out_root="out", seconds=9.0, headed=False, max_sections=MAX_SECTIONS):
    """Scan the page and record a library of section clips. Always writes site_data.json and
    manifest.json (with the error filled in if something failed). Returns the manifest."""
    url = url if url.startswith("http") else "https://" + url
    seconds = min(max(seconds, MIN_CLIP_S), MAX_CLIP_S)
    tool_dir = Path(out_root) / slugify(tool)
    clips_dir = tool_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    _setup_logging(tool_dir)

    old = {}
    try:
        old = json.loads((tool_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    manifest = {
        "tool": tool, "url": url, "status": "ok", "error": None, "library": [],
        "shot_list": None, "shots": old.get("shots", []), "clips": old.get("clips", {}),
        "needs_trial": old.get("needs_trial", []), "site_videos": [], "embeds_not_downloaded": [],
    }
    site_data = empty_site_data(url)
    # Written now so a crash or a killed process still leaves a site_data.json saying so.
    site_data["error"] = "grab started but did not finish (process stopped or crashed)"
    (tool_dir / "site_data.json").write_text(json.dumps(site_data, indent=2), encoding="utf-8")
    site_data["error"] = None

    shot_list, why = load_shot_list(tool_dir)
    if shot_list is None:
        # Expected on a full run: grab comes before script. match records the per-shot clips later.
        log.info("no per-shot clips in grab (%s): recording page sections and site videos; "
                 "the match stage records per-shot clips once the script stage has written shot_list.json", why)
    else:
        manifest["shot_list"] = str(tool_dir / "shot_list.json")
        manifest["shots"] = _shot_entries(shot_list, old.get("shots", []), tool_dir)
        web = [s for s in manifest["shots"] if s["source"] == "website"]
        log.info("shot_list.json: %d shots, %d website, %d trial", len(manifest["shots"]), len(web),
                 sum(s["source"] == "trial" for s in manifest["shots"]))
    try:
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg not found on PATH")
        for f in list(clips_dir.glob("clip[0-9][0-9]_*.mp4")) + list(clips_dir.glob("shot[0-9][0-9]_*.mp4")):
            if not f.stem.endswith("_manual"):  # stale grabbed clips; never a person's upload
                f.unlink()
        _record_library(url, tool_dir, clips_dir, manifest, site_data, seconds, headed, max_sections)
    except BaseException as ex:  # includes Ctrl+C, so the files below still say what happened
        msg = str(ex).splitlines()[0] if str(ex) else type(ex).__name__
        manifest.update(status="blocked" if re.search(r"bot check|HTTP 40[13]|HTTP 429", msg) else "failed", error=msg)
        log.error("could not grab %s: %s", url, msg)
        for s in manifest["shots"]:
            if s.get("status") == "pending":
                s.update(status="failed", error=f"grab failed before this shot was recorded: {msg}")
        if not isinstance(ex, Exception):
            raise
    finally:
        for s in manifest["shots"]:
            if s.get("status") == "pending":
                s.update(status="failed", error="grab stopped before this shot was recorded")
        if manifest["shots"]:
            qa.refresh_clip_map(manifest, tool_dir)
        site_data["error"] = manifest["error"]
        site_data["sections_recorded"] = [{"clip": c["file"], "name": c["section"]}
                                          for c in manifest["library"] if c.get("file")]
        (tool_dir / "site_data.json").write_text(json.dumps(site_data, indent=2, ensure_ascii=False), encoding="utf-8")
        (tool_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        log.info("site_data.json + manifest.json written")
    return manifest


def _shot_entries(shot_list, old_shots, tool_dir):
    """manifest["shots"] from shot_list.json. Website shots start "pending"; trial shots are skipped,
    keeping any trial recording or manual upload already made for them."""
    old = {s.get("shot"): s for s in old_shots}
    out = []
    for s in sorted(shot_list, key=lambda s: int(s["shot"])):
        n = int(s["shot"])
        entry = {"shot": n, "source": s.get("source") or "website", "visual_needed": s.get("visual_needed", ""),
                 "script_line": s.get("script_line", ""), "duration_seconds": s.get("duration_seconds"),
                 "trial_steps": s.get("trial_steps") or [], "file": None}
        prev = old.get(n) or {}
        if prev.get("status") in ("manual", "recorded") and prev.get("file") and (tool_dir / prev["file"]).exists():
            entry.update({k: v for k, v in prev.items() if k not in entry or k == "file"})
        elif entry["source"] == "trial":
            entry.update(status="needs_trial", error="trial shot: recorded inside the tool, not from the website")
        elif not entry["visual_needed"]:
            entry.update(status="failed", error="shot has no visual_needed text to look for")
        else:
            entry["status"] = "pending"
        out.append(entry)
    return out


def _find_shot_sections(page, shots):
    """Match each pending website shot to a heading on the page. Returns [(shot, block)]."""
    if not shots:
        return []
    headings = page.evaluate(HEADINGS_JS)
    log.info("%d headings on the page", len(headings))
    found = []
    for s in shots:
        if s.get("status") != "pending":
            continue
        hd, how = match_heading(s["visual_needed"], headings)
        if hd is None:
            log.warning("section not found for shot %d: %s (falling back to catalog)", s["shot"], how)
            continue
        s.update(section=hd["text"], y=hd["y"], h=hd["h"],
                 matched={"by": "heading", "heading": hd["text"], "tag": hd["tag"], "words": how, "y": hd["y"]})
        log.info("shot %d: %r -> %s %r at y=%d", s["shot"], s["visual_needed"], hd["tag"], hd["text"], hd["y"])
        found.append((s, {"y": hd["y"], "h": hd["h"], "title": hd["text"]}))
    return found


def _record_library(url, tool_dir, clips_dir, manifest, site_data, seconds, headed, max_sections):
    network_videos = set()
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        # ---- pass 1: scan the page, record each section ----
        browser, ctx, page = _open_session(p, tmp, headed)
        t0 = time.monotonic()
        page.on("response", lambda r: network_videos.add(r.url)
                if r.headers.get("content-type", "").startswith("video/") and not r.url.startswith("blob:") else None)
        segments, picks, shot_segs = [], [], []
        try:
            clicked, hidden = _prepare(page, url)
            final_url = page.url
            log.info("loaded %s; cookie buttons clicked: %d, chat widgets hidden: %d", final_url, clicked, hidden)
            test_png = tool_dir / "test_screenshot.png"
            try:
                page.screenshot(path=str(test_png))
                log.info("Saved mobile test screenshot: %s", test_png)
                print(f"Saved mobile test screenshot: {test_png}")
            except Exception as e:
                log.warning("Could not save mobile test screenshot: %s", e)
            info = page.evaluate(FIND_BLOCKS_JS)
            site_data.update(page.evaluate(SITE_DATA_JS), final_url=final_url)
            site_data["hero_png"] = save_hero(page, site_data.pop("hero_bottom", 0), info["vh"], tool_dir / "hero.png")
            page.evaluate(CURSOR_JS)
            page.mouse.move(VIEWPORT_W // 2, VIEWPORT_H // 3)
            page.wait_for_timeout(800)

            info = page.evaluate(FIND_BLOCKS_JS)
            blocks = info["blocks"] or [{"y": 0, "h": info["vh"], "text": "", "title": "Top of page", "video": False}]
            max_y = max(0, info["height"] - info["vh"])
            picks = pick_sections(blocks, max_sections)
            log.info("page height %dpx, %d blocks, recording %d sections", info["height"], len(blocks), len(picks))
            for b in picks:
                try:
                    segments.append(record_shot(page, b, max_y, info["vh"], seconds, t0))
                except Exception as ex:
                    segments.append(None)
                    log.error("section %r: recording failed: %s", b.get("title"), ex)
            # One clip per website shot in shot_list.json, if available
            for s, b in _find_shot_sections(page, manifest.get("shots", [])):
                try:
                    shot_segs.append((s, b, record_shot(page, b, max_y, info["vh"], seconds, t0)))
                except Exception as ex:
                    s.update(status="failed", error=f"recording failed: {str(ex).splitlines()[0]}")
                    log.error("shot %d: %s", s["shot"], s["error"])
            extra_urls = site_data.get("videos", [])
            manifest["site_videos"] = download_videos(page, network_videos, clips_dir, final_url, extra_urls=extra_urls)
            embeds, missed = download_embeds(page, clips_dir)
            manifest["site_videos"] += embeds
            manifest["embeds_not_downloaded"] = missed
        finally:
            webm = _close_session(browser, ctx, page)

        for n, (b, seg) in enumerate(zip(picks, segments), 1):
            entry = {"index": n - 1, "file": None, "section": b.get("title", ""), "text": b["text"][:800],
                     "y": b["y"], "h": b["h"], "has_video": b.get("video", False), "retried": False}
            manifest["library"].append(entry)
            if seg is None:
                entry["error"] = "recording failed"
                continue
            out = clips_dir / library_name(n, b.get("title", ""))
            try:
                cut_clip(webm, seg[0], seg[1], out, seconds)
            except Exception as ex:
                entry["error"] = f"ffmpeg cut failed: {ex}"
                continue
            metrics, reasons = qa.check_clip(out)
            entry.update(file=f"clips/{out.name}", seconds=metrics.get("seconds"),
                         qa="fail" if reasons else "pass", qa_reasons=reasons, qa_metrics=metrics)

        # Convert downloaded videos to 1080x1920 vertical 3-8s segments
        for v in manifest.get("site_videos", []):
            raw_path = tool_dir / v["file"]
            if raw_path.exists():
                segs = convert_video_to_vertical_segments(raw_path, clips_dir)
                for seg in segs:
                    metrics, reasons = qa.check_clip(seg)
                    manifest["library"].append({
                        "file": f"clips/{seg.name}",
                        "section": f"Site Video: {raw_path.stem}",
                        "text": v.get("source", ""),
                        "seconds": metrics.get("seconds"),
                        "qa": "fail" if reasons else "pass",
                        "qa_reasons": reasons,
                        "qa_metrics": metrics
                    })

        for s, b, (start, end) in shot_segs:
            out = clips_dir / clip_name(s)
            try:
                cut_clip(webm, start, end, out, seconds)
            except Exception as ex:
                s.update(status="failed", error=f"ffmpeg cut failed: {ex}")
                log.error("shot %d: %s", s["shot"], s["error"])
                continue
            metrics, reasons = qa.check_clip(out)
            s.update(file=f"clips/{out.name}", status="ok", error=None, seconds=metrics.get("seconds"),
                     qa="fail" if reasons else "pass", qa_reasons=reasons, qa_metrics=metrics)
            if reasons:
                log.warning("shot %d: clip saved but fails QA: %s", s["shot"], "; ".join(reasons))
        for s in manifest["shots"]:
            if s.get("status") == "pending":  # not matched to a direct heading
                s.update(status="missing", error="section not found on page (will check catalog/assets in match stage)")
                log.info("shot %d: heading not directly on page, will match from catalog/assets", s["shot"])

        # ---- pass 2: one retry with motion for clips that came out static ----
        static = [c for c in manifest["library"] + [s for s in manifest["shots"] if s.get("status") == "ok"]
                  if c.get("file") and _is_static(c.get("qa_reasons", []))]
        if not static:
            return
        log.info("retrying %d static clip(s) with motion: %s", len(static), [c["section"] for c in static])
        browser, ctx, page = _open_session(p, tmp, headed)
        t0 = time.monotonic()
        retries = []
        try:
            _prepare(page, url)
            page.evaluate(CURSOR_JS)
            info = page.evaluate(FIND_BLOCKS_JS)
            max_y = max(0, info["height"] - info["vh"])
            by_title = {bl.get("title"): bl for bl in info["blocks"]}
            for c in static:
                b = by_title.get(c.get("section")) or {"y": c.get("y", 0), "h": c.get("h", info["vh"])}
                try:
                    retries.append((c, record_motion(page, b, max_y, info["vh"], seconds, t0)))
                except Exception as ex:
                    log.error("retry %r failed: %s", c["section"], ex)
        finally:
            webm = _close_session(browser, ctx, page)
        for c, (start, end, played) in retries:
            out = clips_dir / Path(c["file"]).name
            tmp_out = out.with_name(out.stem + "_retry.mp4")
            try:
                cut_clip(webm, start, end, tmp_out, seconds)
            except Exception as ex:
                log.error("retry cut %r failed: %s", c["section"], ex)
                continue
            metrics, reasons = qa.check_clip(tmp_out)
            how = "played its video, scrolled slowly and hovered" if played else "scrolled slowly and hovered"
            c["retried"] = True
            if _is_static(reasons) and metrics.get("motion", 0) <= (c.get("qa_metrics") or {}).get("motion", 0):
                tmp_out.unlink(missing_ok=True)  # no better: keep the first take, still a fail
                c["qa_reasons"] = c["qa_reasons"] + [f"still static after a retry ({how})"]
                c["retry"] = "still static"
            else:
                os.replace(tmp_out, out)
                still = _is_static(reasons)
                c.update(seconds=metrics.get("seconds"), qa="fail" if reasons else "pass",
                         qa_reasons=reasons + ([f"still static after a retry ({how})"] if still else []),
                         qa_metrics=metrics, retry="still static" if still else f"fixed: {how}")
            log.info("retry %r: %s", c["section"], c["retry"])


def record_missing_shot_clips(url, tool_dir, shots, headed=False, seconds=6.0):
    """Record mobile viewport clips for pending website shots in shot_list.json.
    Updates each shot entry with file, status, QA metrics, or reports missing if assets are insufficient."""
    tool_dir = Path(tool_dir)
    clips_dir = tool_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    pending = [s for s in shots if s.get("source") == "website" and not s.get("file")]
    if not pending:
        return shots

    log.info("recording per-shot mobile clips for %d website shot(s)...", len(pending))
    try:
        with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
            browser, ctx, page = _open_session(p, tmp, headed)
            t0 = time.monotonic()
            shot_segs = []
            try:
                _prepare(page, url)
                page.evaluate(CURSOR_JS)
                info = page.evaluate(FIND_BLOCKS_JS)
                max_y = max(0, info["height"] - info["vh"])
                vh = info["vh"]

                for s, b in _find_shot_sections(page, pending):
                    try:
                        shot_segs.append((s, b, record_shot(page, b, max_y, vh, seconds, t0)))
                    except Exception as ex:
                        s.update(status="failed", error=f"recording failed: {str(ex).splitlines()[0]}")
                        log.error("shot %d: %s", s["shot"], s["error"])
            finally:
                webm = _close_session(browser, ctx, page)

            if webm and webm.exists():
                for s, b, (start, end) in shot_segs:
                    out = clips_dir / clip_name(s)
                    try:
                        cut_clip(webm, start, end, out, seconds)
                        metrics, reasons = qa.check_clip(out)
                        s.update(
                            file=f"clips/{out.name}",
                            status="ok",
                            error=None,
                            seconds=metrics.get("seconds"),
                            qa="fail" if reasons else "pass",
                            qa_reasons=reasons,
                            qa_metrics=metrics,
                            matched={"by": "mobile_page_section", "heading": b.get("title", ""), "y": b.get("y", 0)},
                        )
                        log.info("shot %d clip recorded: %s (qa: %s)", s["shot"], out.name, s["qa"])
                    except Exception as ex:
                        s.update(status="failed", error=f"cut failed: {ex}")
                        log.error("shot %d cut error: %s", s["shot"], ex)
    except Exception as e:
        log.warning("could not record per-shot mobile clips: %s", e)

    for s in pending:
        if not s.get("file"):
            s.update(
                file=None,
                status="missing",
                error=f"insufficient website assets for visual: '{s.get('visual_needed') or s.get('script_line')}'",
            )
            log.warning("shot %d: %s", s["shot"], s["error"])

    return shots


def print_summary(m):
    print(f"\n=== {m['tool']} : {m['url']}  [{m['status']}]")
    if m["error"]:
        print(f"  ! {m['error']}")
    for c in m["library"]:
        if not c.get("file"):
            print(f"  FAILED  {c['section'][:50]:<50} {c.get('error', '')}")
            continue
        mark = "PASS" if c.get("qa") == "pass" else "FAIL"
        extra = f"  [retry: {c['retry']}]" if c.get("retry") else ""
        print(f"  {mark}    {Path(c['file']).name:<44} {'; '.join(c.get('qa_reasons') or [])}{extra}")
    for v in m["site_videos"]:
        print(f"  site video: {Path(v['file']).name:<20} {v['mb']:5.1f} MB  from {v['source']}")
    for src in m["embeds_not_downloaded"]:
        print(f"  embedded video not downloaded: {src}")
    ok = sum(c.get("qa") == "pass" for c in m["library"])
    print(f"Section clips: {ok}/{len(m['library'])} pass QA   site videos: {len(m['site_videos'])}")


def main():
    ap = argparse.ArgumentParser(description="Scan a tool's website and record a clip of each section.")
    ap.add_argument("url")
    ap.add_argument("tool")
    ap.add_argument("--seconds", type=float, default=9.0, help="clip length, clamped to 8-10")
    ap.add_argument("--sections", type=int, default=MAX_SECTIONS, help="max sections to record")
    ap.add_argument("--headed", action="store_true", help="show the browser while recording")
    ap.add_argument("--out", default="out")
    a = ap.parse_args()
    m = grab(a.url, a.tool, a.out, a.seconds, a.headed, a.sections)
    print_summary(m)
    sys.exit(0 if m["status"] == "ok" else 1)


if __name__ == "__main__":
    main()
