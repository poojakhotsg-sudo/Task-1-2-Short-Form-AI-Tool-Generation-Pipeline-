#!/usr/bin/env python3
"""
extract_assets.py - Standalone script to extract ALL media from a website untouched,
using a mobile Playwright context (iPhone 14, 390x844) with NO AI involved.

Usage:
    python extract_assets.py gamma https://gamma.app
    python extract_assets.py pomelli https://labs.google.com/pomelli
    python extract_assets.py <tool> <url> [--out out] [--headed] [--min-size 5120]

Collects:
    - <img> (src, srcset, data-src, etc.)
    - CSS background images (computed & inline, pseudo-elements)
    - <picture>/<source>
    - GIFs
    - SVGs (external and standalone inline)
    - <video> and <source>, lazy videos
    - iframe embeds (YouTube, Vimeo, Loom, Wistia)

Saves everything into:
    out/<tool>/assets/images
    out/<tool>/assets/gifs
    out/<tool>/assets/videos
    out/<tool>/assets.json
    out/<tool>/gallery.html
"""

import argparse
import base64
import html
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

import requests
from playwright.sync_api import sync_playwright

try:
    from PIL import Image
except ImportError:
    Image = None

# Ensure console output doesn't crash on Windows with Unicode characters
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("extract_assets")

MIN_SIZE_BYTES_DEFAULT = 5120  # 5 KB threshold
VIEWPORT_W, VIEWPORT_H = 390, 844
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1"
)

def slugify(text: str) -> str:
    s = re.sub(r"[^\w.-]+", "-", (text or "").lower()).strip("-")
    return s or "site"

def tool_name(url: str) -> str:
    host = (urlparse(url if "://" in url else "https://" + url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host

# ---- Cookie-banner selectors & text patterns (same as grabber.py) ----
COOKIE_SELECTORS = [
    "[id*='cookie'] button", "[class*='cookie'] button",
    "[id*='consent'] button", "[class*='consent'] button",
    "[id*='gdpr'] button",   "[class*='gdpr'] button",
    "button[id*='accept']",  "button[class*='accept']",
    "#onetrust-accept-btn-handler", ".onetrust-accept-btn-handler",
    "[aria-label*='Accept']", "[aria-label*='Agree']",
    "button.fc-cta-consent", "button[data-testid='accept-button']",
]
COOKIE_TEXT = re.compile(
    r"^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it"
    r"|ok(ay)?|i understand|understood|continue|close|dismiss|no thanks|reject( all)?)\s*$",
    re.I,
)


def close_cookie_popups(page) -> bool:
    """Dismiss any visible cookie / consent banner. Returns True if one was dismissed."""
    dismissed = False
    for sel in COOKIE_SELECTORS:
        try:
            btns = page.query_selector_all(sel)
            for btn in btns:
                if not btn.is_visible():
                    continue
                txt = (btn.inner_text() or "").strip()
                if not txt or COOKIE_TEXT.match(txt):
                    try:
                        btn.click(timeout=3000)
                        page.wait_for_timeout(500)
                        dismissed = True
                        log.info("Cookie banner dismissed via '%s' (text: '%s')", sel, txt)
                        return dismissed
                    except Exception:
                        pass
        except Exception:
            pass
    return dismissed

# Comprehensive JS scraper executed in the browser context
EXTRACT_MEDIA_DOM_JS = """
() => {
  const cleanText = t => (t || '').replace(/\\s+/g, ' ').trim();
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));

  function getNearestHeading(el) {
    if (!el) return 'Hero';
    let bestHeading = null;
    for (const h of headings) {
      const text = cleanText(h.innerText || h.textContent);
      if (!text) continue;
      const pos = el.compareDocumentPosition(h);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
        bestHeading = text;
      } else if (pos === 0) {
        return text;
      }
    }
    if (bestHeading) return bestHeading;
    const firstH = headings.find(h => cleanText(h.innerText || h.textContent));
    const firstText = firstH ? cleanText(firstH.innerText || firstH.textContent) : '';
    const rect = el.getBoundingClientRect();
    if (rect.top + window.scrollY < 600) return 'Hero';
    return firstText || 'Hero';
  }

  const items = [];
  const seenUrls = new Set();

  function addItem(url, type, el, extra = {}) {
    if (!url || typeof url !== 'string') return;
    url = url.trim();
    if (!url || url.startsWith('javascript:') || url.startsWith('about:')) return;
    if (!url.startsWith('data:') && !url.startsWith('inline:')) {
      try {
        url = new URL(url, window.location.href).href;
      } catch (e) {
        return;
      }
    }
    if (seenUrls.has(url)) return;
    seenUrls.add(url);

    let dims = { width: 0, height: 0 };
    if (el) {
      dims.width = el.naturalWidth || el.videoWidth || el.clientWidth || Math.round(el.getBoundingClientRect().width) || 0;
      dims.height = el.naturalHeight || el.videoHeight || el.clientHeight || Math.round(el.getBoundingClientRect().height) || 0;
    }

    items.push({
      url,
      type,
      section: getNearestHeading(el),
      dimensions: dims,
      ...extra
    });
  }

  // 1. <img> tags
  document.querySelectorAll('img').forEach(img => {
    const urls = [];
    if (img.currentSrc) urls.push(img.currentSrc);
    if (img.src) urls.push(img.src);
    ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-hi-res-src', 'data-fallback'].forEach(attr => {
      const u = img.getAttribute(attr);
      if (u) urls.push(u);
    });
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (srcset) {
      srcset.split(',').forEach(part => {
        const candidate = part.trim().split(/\\s+/)[0];
        if (candidate) urls.push(candidate);
      });
    }
    for (const u of urls) {
      const isGif = /\\.gif(\\?|$)/i.test(u);
      const isSvg = /\\.svg(\\?|$)/i.test(u);
      addItem(u, isGif ? 'gif' : (isSvg ? 'svg' : 'image'), img);
    }
  });

  // 2. <picture> <source>
  document.querySelectorAll('picture source').forEach(src => {
    const parentPic = src.closest('picture') || src;
    const srcset = src.getAttribute('srcset') || src.getAttribute('data-srcset');
    if (srcset) {
      srcset.split(',').forEach(part => {
        const candidate = part.trim().split(/\\s+/)[0];
        if (candidate) {
          const isGif = /\\.gif(\\?|$)/i.test(candidate);
          const isSvg = /\\.svg(\\?|$)/i.test(candidate);
          addItem(candidate, isGif ? 'gif' : (isSvg ? 'svg' : 'image'), parentPic);
        }
      });
    }
    const s = src.getAttribute('src') || src.getAttribute('data-src');
    if (s) {
      const isGif = /\\.gif(\\?|$)/i.test(s);
      const isSvg = /\\.svg(\\?|$)/i.test(s);
      addItem(s, isGif ? 'gif' : (isSvg ? 'svg' : 'image'), parentPic);
    }
  });

  // 3. CSS background-image
  document.querySelectorAll('*').forEach(el => {
    const checkBg = (st) => {
      const bg = st && st.backgroundImage;
      if (bg && bg !== 'none') {
        const matches = bg.match(/url\\((['"]?)(.*?)\\1\\)/g);
        if (matches) {
          matches.forEach(m => {
            const raw = m.replace(/^url\\(['"]?/, '').replace(/['"]?\\)$/, '').trim();
            if (raw && !raw.startsWith('data:')) {
              const isGif = /\\.gif(\\?|$)/i.test(raw);
              const isSvg = /\\.svg(\\?|$)/i.test(raw);
              addItem(raw, isGif ? 'gif' : (isSvg ? 'svg' : 'image'), el, { is_background: true });
            }
          });
        }
      }
    };
    try {
      checkBg(window.getComputedStyle(el));
      checkBg(window.getComputedStyle(el, ':before'));
      checkBg(window.getComputedStyle(el, ':after'));
    } catch(e){}
  });

  // 4. <video> and <source>
  document.querySelectorAll('video').forEach(v => {
    const urls = [];
    if (v.currentSrc) urls.push(v.currentSrc);
    if (v.src) urls.push(v.src);
    ['data-src', 'data-lazy-src', 'data-video-src', 'data-url'].forEach(attr => {
      const u = v.getAttribute(attr);
      if (u) urls.push(u);
    });
    v.querySelectorAll('source').forEach(s => {
      if (s.src) urls.push(s.src);
      ['data-src', 'data-lazy-src', 'data-video-src'].forEach(attr => {
        const u = s.getAttribute(attr);
        if (u) urls.push(u);
      });
    });
    for (const u of urls) {
      addItem(u, 'video', v);
    }
  });

  // 5. iframe embeds (YouTube, Vimeo, Loom, Wistia, etc.)
  const embedRe = /youtube|youtu\\.be|vimeo|loom\\.com\\/embed|wistia|mux\\.com|bunnycdn|jwplatform|vidyard/i;
  document.querySelectorAll('iframe').forEach(f => {
    const src = f.src || f.getAttribute('data-src') || '';
    if (src && embedRe.test(src)) {
      addItem(src, 'embed', f, { is_embed: true });
    }
  });

  // 6. Standalone Inline <svg>
  let svgIdx = 0;
  document.querySelectorAll('svg').forEach(svg => {
    // Only capture standalone SVGs that are non-trivial (e.g. illustrations, graphics)
    const rect = svg.getBoundingClientRect();
    if (rect.width >= 32 && rect.height >= 32) {
      svgIdx++;
      const xml = new XMLSerializer().serializeToString(svg);
      items.push({
        url: `inline:svg_${svgIdx}`,
        inline_svg_content: xml,
        type: 'svg',
        section: getNearestHeading(svg),
        dimensions: { width: Math.round(rect.width), height: Math.round(rect.height) }
      });
    }
  });

  return items;
}
"""

PROMOTE_LAZY_MEDIA_JS = """
() => {
  let count = 0;
  document.querySelectorAll('img, video, source, picture source, iframe').forEach(el => {
    ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-video-src', 'data-hi-res-src'].forEach(attr => {
      const val = el.getAttribute(attr);
      if (val && !el.src) {
        try { el.src = val; count++; } catch (e) {}
      }
    });
    const srcset = el.getAttribute('data-srcset');
    if (srcset && !el.getAttribute('srcset')) {
      try { el.setAttribute('srcset', srcset); count++; } catch (e) {}
    }
  });
  return count;
}
"""


def slugify(text: str) -> str:
    """Normalize tool name into a safe directory slug."""
    text = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"[-\s]+", "_", text).strip("_")


def sanitize_filename(filename: str) -> str:
    """Sanitize filename for Windows filesystems."""
    clean = re.sub(r'[\\/*?:"<>|]', "_", filename)
    clean = clean.strip(". ")
    return clean or "asset"


def format_bytes(num_bytes: int) -> str:
    """Format bytes into a human readable string."""
    if num_bytes < 1024:
        return f"{num_bytes} B"
    elif num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    elif num_bytes < 1024 * 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{num_bytes / (1024 * 1024 * 1024):.2f} GB"


def get_image_dimensions(filepath: Path, fallback: dict) -> dict:
    """Extract natural dimensions of an image file."""
    if Image:
        try:
            with Image.open(filepath) as im:
                return {"width": int(im.size[0]), "height": int(im.size[1])}
        except Exception:
            pass

    # If SVG, try parsing viewBox or width/height attributes
    if filepath.suffix.lower() == ".svg":
        try:
            import xml.etree.ElementTree as ET
            tree = ET.parse(filepath)
            root = tree.getroot()
            vb = root.attrib.get("viewBox")
            if vb:
                parts = vb.replace(",", " ").split()
                if len(parts) == 4:
                    return {
                        "width": round(float(parts[2])),
                        "height": round(float(parts[3])),
                    }
            w = root.attrib.get("width")
            h = root.attrib.get("height")
            if w and h:
                w_num = float(re.sub(r"[^\d.]", "", w))
                h_num = float(re.sub(r"[^\d.]", "", h))
                return {"width": round(w_num), "height": round(h_num)}
        except Exception:
            pass

    return fallback


def get_video_dimensions(filepath: Path, fallback: dict) -> dict:
    """Extract video dimensions using ffprobe."""
    try:
        cmd = [
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=s=x:p=0",
            str(filepath),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if res.returncode == 0 and "x" in res.stdout:
            parts = res.stdout.strip().split("x")
            return {"width": int(parts[0]), "height": int(parts[1])}
    except Exception:
        pass
    return fallback


def pick_unique_filepath(dest_dir: Path, filename: str) -> Path:
    """Return a non-colliding filepath in dest_dir."""
    dest_path = dest_dir / filename
    if not dest_path.exists():
        return dest_path
    stem = dest_path.stem
    suffix = dest_path.suffix
    i = 2
    while (dest_dir / f"{stem}_{i}{suffix}").exists():
        i += 1
    return dest_dir / f"{stem}_{i}{suffix}"


def download_embed_ytdlp(url: str, dest_dir: Path) -> tuple[bool, Path | None, str]:
    """Attempt to download full quality video from an embed URL using yt-dlp."""
    try:
        import yt_dlp
    except ImportError:
        return False, None, "yt_dlp not installed"

    # Use yt-dlp to download directly to dest_dir with original title
    ydl_opts = {
        "outtmpl": str(dest_dir / "%(title).80s [%(id)s].%(ext)s"),
        "format": "bv*+ba/b",
        "windowsfilenames": True,
        "restrictfilenames": True,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if info:
                # Find the downloaded file
                expected_fn = ydl.prepare_filename(info)
                p = Path(expected_fn)
                if p.exists():
                    return True, p, ""
                # Also check with actual ext (e.g. mp4, mkv, webm)
                for cand in dest_dir.glob(f"{p.stem}.*"):
                    if cand.is_file():
                        return True, cand, ""
        return False, None, "yt-dlp produced no output file"
    except Exception as e:
        return False, None, str(e)


def extract_assets(
    tool: str,
    url: str,
    out_root: str = "out",
    headed: bool = False,
    min_size_bytes: int = MIN_SIZE_BYTES_DEFAULT,
    timeout_ms: int = 60000,
) -> dict:
    """
    Main extraction routine for a tool website.
    Returns a dictionary summarizing the extraction results.
    """
    tool_slug = slugify(tool) if tool else slugify(tool_name(url))
    out_path = Path(out_root)
    if out_path.name == tool_slug:
        tool_dir = out_path
    else:
        tool_dir = out_path / tool_slug
    # Clear old files in out/<tool>/ at the start of each run
    if tool_dir.exists():
        for child in list(tool_dir.iterdir()):
            try:
                if child.is_dir():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)
            except Exception:
                pass

    assets_dir = tool_dir / "assets"
    img_dir = assets_dir / "images"
    gif_dir = assets_dir / "gifs"
    vid_dir = assets_dir / "videos"

    for d in (img_dir, gif_dir, vid_dir):
        d.mkdir(parents=True, exist_ok=True)

    print(f"\n{'='*70}")
    print(f"  ASSET EXTRACTION: {tool} ({url})")
    print(f"  Output directory: {tool_dir}")
    print(f"  Min file size:    {format_bytes(min_size_bytes)}")
    print(f"{'='*70}\n")

    items_to_process = []
    network_responses = {}

    # ---- Playwright report accumulators ----
    run_log = []  # list of {"t": seconds_since_start, "msg": str}
    console_errors = []
    failed_requests = []
    pw_start = time.time()

    def log_step(msg: str):
        t = round(time.time() - pw_start, 2)
        run_log.append({"t": t, "msg": msg})
        print(msg)

    with sync_playwright() as p:
        dev = dict(p.devices["iPhone 14"])
        dev["viewport"] = {"width": VIEWPORT_W, "height": VIEWPORT_H}
        dev["is_mobile"] = True
        dev["has_touch"] = True

        browser = p.chromium.launch(headless=not headed)
        browser_name = "chromium"
        try:
            browser_version = browser.version
        except Exception:
            browser_version = "unknown"

        context = browser.new_context(**dev)
        page = context.new_page()

        # Console errors listener
        def on_console(msg):
            if msg.type == "error":
                txt = msg.text
                console_errors.append(txt)
                log.debug("[console error] %s", txt)

        page.on("console", on_console)

        # Network failure listener
        def on_req_failed(req):
            failed_requests.append({
                "url": req.url,
                "method": req.method,
                "failure": req.failure or "unknown",
            })

        page.on("requestfailed", on_req_failed)

        # Log viewport check
        vp = page.viewport_size
        ua = page.evaluate("navigator.userAgent")
        log_step(f"[Mobile Layout Check] Viewport: {vp}, User-Agent: {ua}")
        log.info("Mobile layout active: %s, %s", vp, ua)

        # Track network responses for binary images/media
        def on_response(response):
            try:
                ct = response.headers.get("content-type", "").lower()
                r_url = response.url
                if (
                    ct.startswith("image/")
                    or ct.startswith("video/")
                    or any(r_url.lower().endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp4", ".webm"))
                ):
                    if not r_url.startswith("data:"):
                        network_responses[r_url] = {
                            "content_type": ct,
                            "status": response.status,
                        }
            except Exception:
                pass

        page.on("response", on_response)

        # ---- Navigate ----
        log_step(f"Navigating to {url}...")
        print("[PROGRESS] Navigating to page...")
        http_status = None
        final_url = url
        page_title = ""
        page_load_time = 0.0
        nav_start = time.time()
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            if resp:
                http_status = resp.status
                final_url = page.url
            page_load_time = round(time.time() - nav_start, 2)
            page_title = page.title() or ""
        except Exception as e:
            log_step(f"Navigation error: {e}")
        # ---- Bot check detection ----
        BOT_CHECK_RE = re.compile(
            r"just a moment|verify (that )?you are (a )?human|checking (if the site connection|your browser)|"
            r"attention required|are you a robot|pardon our interruption|access denied|captcha|"
            r"enable javascript and cookies to continue|request blocked|unusual traffic", re.I)

        body_snippet = ""
        try:
            body_snippet = page.evaluate("() => (document.body ? document.body.innerText : '')").strip()[:1500]
        except Exception:
            pass

        if BOT_CHECK_RE.search(page_title) or BOT_CHECK_RE.search(body_snippet):
            msg = "Blocked: use the marketing URL or tick Show browser"
            log_step(f"[BLOCKED] {msg}")
            print(f"[BLOCKED] {msg}")
            atf_path = tool_dir / "above_the_fold.png"
            try:
                page.screenshot(path=str(atf_path), full_page=False)
            except Exception:
                pass
            pw_report = {
                "setup": {
                    "browser_name": browser_name,
                    "browser_version": browser_version,
                    "device_profile": "iPhone 14",
                    "viewport": f"{VIEWPORT_W}x{VIEWPORT_H}",
                    "user_agent": MOBILE_UA,
                    "is_mobile": True,
                    "has_touch": True,
                },
                "page": {
                    "final_url": final_url,
                    "title": page_title,
                    "http_status": http_status,
                    "page_load_time_seconds": page_load_time,
                    "total_page_height_px": 0,
                },
                "screenshots": {
                    "above_the_fold": "above_the_fold.png" if atf_path.exists() else None,
                    "page_mobile": None,
                },
                "scroll_log": {"scroll_steps": 0, "lazy_items_promoted": 0, "scroll_duration_seconds": 0},
                "findings": {
                    "found": {"images": 0, "background_images": 0, "gifs": 0, "svgs": 0, "videos": 0, "embeds": 0},
                    "downloaded": 0, "skipped_too_small": 0, "failed": 0, "failed_items": [],
                },
                "errors": {"console_errors": console_errors, "failed_network_requests": failed_requests, "cookie_banner_dismissed": False},
                "run_log": run_log,
                "blocked": True,
                "blocked_message": msg,
            }
            with open(tool_dir / "playwright_report.json", "w", encoding="utf-8") as pf:
                json.dump(pw_report, pf, indent=2, ensure_ascii=False)
            browser.close()
            return {
                "tool": tool,
                "url": url,
                "counts": {},
                "skipped": 0,
                "failed": 0,
                "total_saved": 0,
                "blocked": True,
                "blocked_message": msg,
                "playwright_report": str(tool_dir / "playwright_report.json"),
            }

        # ---- Cookie dismissal ----
        cookie_dismissed = close_cookie_popups(page)
        if cookie_dismissed:
            log_step("Cookie banner dismissed")
        else:
            log_step("No cookie banner found")

        # ---- Above-the-fold screenshot (scroll position 0) ----
        atf_path = tool_dir / "above_the_fold.png"
        try:
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(300)
            page.screenshot(path=str(atf_path), full_page=False)
            log_step(f"Saved above-the-fold screenshot: {atf_path.name}")
        except Exception as e:
            log_step(f"Warning: could not save above_the_fold.png — {e}")

        # ---- Scroll to trigger lazy loading ----
        log_step("Scrolling full page slowly to trigger lazy loading...")
        print("[PROGRESS] Scrolling page to trigger lazy loading...")
        scroll_start = time.time()
        scroll_height = page.evaluate("() => document.documentElement.scrollHeight")
        y = 0
        step = 350
        scroll_steps = 0
        while y < scroll_height:
            y += step
            page.evaluate(f"window.scrollTo(0, {y})")
            page.wait_for_timeout(200)
            scroll_height = page.evaluate("() => document.documentElement.scrollHeight")
            scroll_steps += 1
        scroll_duration = round(time.time() - scroll_start, 2)

        # ---- Promote lazy media ----
        promoted = page.evaluate(PROMOTE_LAZY_MEDIA_JS)
        if promoted:
            log_step(f"Promoted {promoted} lazy-loading media attributes")
        page.wait_for_timeout(1000)

        # ---- Total page height ----
        total_page_height = page.evaluate("() => document.documentElement.scrollHeight")

        # ---- Full-page mobile screenshot ----
        mobile_path = tool_dir / "page_mobile.png"
        try:
            page.screenshot(path=str(mobile_path), full_page=True)
            log_step(f"Saved full-page mobile screenshot: {mobile_path.name}")
        except Exception as e:
            log_step(f"Warning: could not save page_mobile.png — {e}")

        log_step(f"Scroll complete: {scroll_steps} steps, {promoted} lazy items promoted, {scroll_duration}s")

        # ---- Scroll back to top ----
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(400)

        # Extract all media items from the DOM
        print("Extracting media items from DOM...")
        dom_items = page.evaluate(EXTRACT_MEDIA_DOM_JS)
        items_to_process.extend(dom_items)

        # Include network image responses that might not have matched standard DOM tags
        seen_urls = {it.get("url") for it in items_to_process if "url" in it}
        for net_url, net_info in network_responses.items():
            if net_url not in seen_urls and not net_url.startswith("data:"):
                # Exclude analytics/beacon/pixel scripts
                if any(x in net_url.lower() for x in ("analytics", "pixel", "telemetry", "log", "beacon", "doubleclick")):
                    continue
                ct = net_info.get("content_type", "")
                t = "image"
                if "gif" in ct or net_url.lower().endswith(".gif"):
                    t = "gif"
                elif "svg" in ct or net_url.lower().endswith(".svg"):
                    t = "svg"
                elif "video" in ct or any(net_url.lower().endswith(x) for x in (".mp4", ".webm")):
                    t = "video"
                items_to_process.append({
                    "url": net_url,
                    "type": t,
                    "section": "Page (Loaded Assets)",
                    "dimensions": {"width": 0, "height": 0},
                })
                seen_urls.add(net_url)

        # Extract text sections and description for Step 2 (Auto-build script)
        page_meta_desc = ""
        page_sections = []
        try:
            page_meta_desc = page.evaluate("() => document.querySelector('meta[name=\"description\"]')?.content || ''") or ""
            page_sections = page.evaluate("""() => {
                const list = [];
                document.querySelectorAll('h1, h2, h3').forEach((h) => {
                    const title = (h.innerText || '').trim();
                    if (!title || title.length < 2) return;
                    let desc = '';
                    let next = h.nextElementSibling;
                    while (next && !['H1','H2','H3'].includes(next.tagName) && desc.length < 300) {
                        const t = (next.innerText || '').trim();
                        if (t) desc += (desc ? ' ' : '') + t;
                        next = next.nextElementSibling;
                    }
                    list.push({ heading: title, text: desc || title });
                });
                return list;
            }""") or []
        except Exception:
            pass

        browser.close()
        log_step(f"Browser closed. Found {len(items_to_process)} raw candidate media items to download.")

    print(f"Found {len(items_to_process)} raw candidate media items to download.")

    # Prepare requests session for downloading
    session = requests.Session()
    session.headers.update({
        "User-Agent": MOBILE_UA,
        "Referer": url,
        "Accept": "*/*",
    })

    saved_assets = []
    failed_downloads = []
    skipped_count = 0
    failed_count = 0
    counts = {"image": 0, "gif": 0, "video": 0, "svg": 0, "embed": 0, "background_image": 0}
    total_items = len(items_to_process)
    print(f"[PROGRESS] Found {total_items} media items to process")

    for idx, item in enumerate(items_to_process, start=1):
        if idx % 2 == 1 or idx == total_items:
            print(f"[PROGRESS] Downloaded {len(saved_assets)}/{total_items} files")
        raw_url = item.get("url", "")
        item_type = item.get("type", "image")
        section = item.get("section", "Hero")
        dimensions = item.get("dimensions", {"width": 0, "height": 0})
        inline_svg = item.get("inline_svg_content")

        # --- A. Inline SVGs ---
        if inline_svg:
            content_bytes = inline_svg.encode("utf-8")
            if len(content_bytes) < min_size_bytes:
                print(f"  [SKIP] Tiny inline SVG (< {format_bytes(min_size_bytes)}, {len(content_bytes)} B) in section '{section}'")
                skipped_count += 1
                continue

            target_name = sanitize_filename(f"inline_svg_{idx}.svg")
            out_file = pick_unique_filepath(img_dir, target_name)
            out_file.write_bytes(content_bytes)
            dims = get_image_dimensions(out_file, dimensions)
            saved_assets.append({
                "file_name": out_file.name,
                "file_path": f"assets/images/{out_file.name}",
                "type": "svg",
                "source_url": raw_url,
                "size_bytes": len(content_bytes),
                "size_human": format_bytes(len(content_bytes)),
                "dimensions": dims,
                "section": section,
            })
            counts["svg"] += 1
            counts["image"] += 1
            if item.get("is_background"):
                counts["background_image"] += 1
            print(f"  [SAVED: SVG] {out_file.name} ({format_bytes(len(content_bytes))}) - section: '{section}'")
            continue

        # --- B. Data URLs (base64) ---
        if raw_url.startswith("data:"):
            try:
                header, encoded = raw_url.split(",", 1)
                data_bytes = base64.b64decode(encoded)
                if len(data_bytes) < min_size_bytes:
                    print(f"  [SKIP] Tiny data URL (< {format_bytes(min_size_bytes)}, {len(data_bytes)} B) in section '{section}'")
                    skipped_count += 1
                    continue
                ext = ".png"
                if "image/jpeg" in header:
                    ext = ".jpg"
                elif "image/webp" in header:
                    ext = ".webp"
                elif "image/gif" in header:
                    ext = ".gif"
                elif "image/svg" in header:
                    ext = ".svg"

                t_dir = gif_dir if ext == ".gif" else img_dir
                out_file = pick_unique_filepath(t_dir, f"data_asset_{idx}{ext}")
                out_file.write_bytes(data_bytes)
                dims = get_image_dimensions(out_file, dimensions)
                saved_assets.append({
                    "file_name": out_file.name,
                    "file_path": f"assets/{'gifs' if ext == '.gif' else 'images'}/{out_file.name}",
                    "type": "gif" if ext == ".gif" else ("svg" if ext == ".svg" else "image"),
                    "source_url": raw_url[:60] + "...",
                    "size_bytes": len(data_bytes),
                    "size_human": format_bytes(len(data_bytes)),
                    "dimensions": dims,
                    "section": section,
                })
                if ext == ".gif":
                    counts["gif"] += 1
                else:
                    counts["image"] += 1
                print(f"  [SAVED: DATA] {out_file.name} ({format_bytes(len(data_bytes))})")
            except Exception as e:
                print(f"  [FAIL] Failed to decode data URL: {e}")
                failed_count += 1
            continue

        # --- C. Video Embeds (YouTube, Vimeo, Loom, Wistia) ---
        if item_type == "embed" or item.get("is_embed"):
            print(f"  [EMBED] Found video embed: {raw_url} (section: '{section}')")
            ok, downloaded_file, err = download_embed_ytdlp(raw_url, vid_dir)
            if ok and downloaded_file and downloaded_file.exists():
                sz = downloaded_file.stat().st_size
                dims = get_video_dimensions(downloaded_file, dimensions)
                saved_assets.append({
                    "file_name": downloaded_file.name,
                    "file_path": f"assets/videos/{downloaded_file.name}",
                    "type": "embed",
                    "source_url": raw_url,
                    "size_bytes": sz,
                    "size_human": format_bytes(sz),
                    "dimensions": dims,
                    "section": section,
                })
                counts["embed"] += 1
                counts["video"] += 1
                print(f"  [SAVED: EMBED VIDEO] {downloaded_file.name} ({format_bytes(sz)})")
            else:
                # Still record the embed in assets.json and gallery
                log.warning("yt-dlp could not download embed %s: %s", raw_url, err)
                saved_assets.append({
                    "file_name": None,
                    "file_path": None,
                    "type": "embed",
                    "source_url": raw_url,
                    "size_bytes": 0,
                    "size_human": "0 B (Stream)",
                    "dimensions": dimensions if dimensions["width"] else {"width": 1280, "height": 720},
                    "section": section,
                })
                counts["embed"] += 1
                print(f"  [RECORDED: EMBED] {raw_url} (not downloaded directly, viewable in gallery)")
            continue

        # --- D. Direct HTTP/HTTPS Media Files ---
        parsed = urlparse(raw_url)
        path_name = unquote(Path(parsed.path).name)
        if not path_name or "." not in path_name:
            # Generate a name based on item type and url hash
            h_suffix = abs(hash(raw_url)) % 100000
            ext = ".mp4" if item_type == "video" else (".gif" if item_type == "gif" else (".svg" if item_type == "svg" else ".png"))
            clean_name = f"asset_{idx}_{h_suffix}{ext}"
        else:
            clean_name = sanitize_filename(path_name)

        # Decide destination folder based on type or extension
        ext_lower = Path(clean_name).suffix.lower()
        if item_type == "video" or ext_lower in (".mp4", ".webm", ".mov", ".m4v", ".ogv"):
            dest_dir = vid_dir
            final_type = "video"
            rel_folder = "assets/videos"
        elif item_type == "gif" or ext_lower == ".gif":
            dest_dir = gif_dir
            final_type = "gif"
            rel_folder = "assets/gifs"
        elif item_type == "svg" or ext_lower == ".svg":
            dest_dir = img_dir
            final_type = "svg"
            rel_folder = "assets/images"
        else:
            dest_dir = img_dir
            final_type = "image"
            rel_folder = "assets/images"

        target_file = pick_unique_filepath(dest_dir, clean_name)

        try:
            with session.get(raw_url, stream=True, timeout=25) as resp:
                if resp.status_code != 200:
                    print(f"  [FAIL] HTTP {resp.status_code} for {raw_url}")
                    failed_downloads.append({"url": raw_url, "section": section, "reason": f"HTTP {resp.status_code}"})
                    failed_count += 1
                    continue

                # Check Content-Length header first if available
                cl_header = resp.headers.get("content-length")
                if cl_header and cl_header.isdigit():
                    cl_val = int(cl_header)
                    if cl_val < min_size_bytes:
                        print(f"  [SKIP] Tiny file (< {format_bytes(min_size_bytes)}, {cl_val} B): {raw_url}")
                        skipped_count += 1
                        continue

                # Stream to disk
                with open(target_file, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=32768):
                        if chunk:
                            f.write(chunk)

            file_sz = target_file.stat().st_size
            if file_sz < min_size_bytes:
                print(f"  [SKIP] Tiny file (< {format_bytes(min_size_bytes)}, {file_sz} B): {raw_url}")
                target_file.unlink(missing_ok=True)
                skipped_count += 1
                continue

            # Determine dimensions
            if final_type == "video":
                dims = get_video_dimensions(target_file, dimensions)
                counts["video"] += 1
            elif final_type == "gif":
                dims = get_image_dimensions(target_file, dimensions)
                counts["gif"] += 1
            else:
                dims = get_image_dimensions(target_file, dimensions)
                counts["image"] += 1
                if final_type == "svg":
                    counts["svg"] += 1
                if item.get("is_background"):
                    counts["background_image"] += 1

            saved_assets.append({
                "file_name": target_file.name,
                "file_path": f"{rel_folder}/{target_file.name}",
                "type": final_type,
                "source_url": raw_url,
                "size_bytes": file_sz,
                "size_human": format_bytes(file_sz),
                "dimensions": dims,
                "section": section,
            })
            print(f"  [SAVED: {final_type.upper()}] {target_file.name} ({format_bytes(file_sz)}, {dims.get('width', 0)}x{dims.get('height', 0)}) - section: '{section}'")

        except Exception as e:
            print(f"  [FAIL] Could not download {raw_url}: {e}")
            failed_downloads.append({"url": raw_url, "section": section, "reason": str(e)})
            if target_file.exists():
                target_file.unlink(missing_ok=True)
            failed_count += 1

    # ---- Playwright report ----
    log_step(f"Download phase complete: {len(saved_assets)} saved, {skipped_count} skipped, {failed_count} failed")
    pw_report = {
        "setup": {
            "browser_name": browser_name,
            "browser_version": browser_version,
            "device_profile": "iPhone 14",
            "viewport": f"{VIEWPORT_W}x{VIEWPORT_H}",
            "user_agent": MOBILE_UA,
            "is_mobile": True,
            "has_touch": True,
        },
        "page": {
            "final_url": final_url,
            "title": page_title,
            "http_status": http_status,
            "page_load_time_seconds": page_load_time,
            "total_page_height_px": total_page_height,
        },
        "screenshots": {
            "above_the_fold": "above_the_fold.png" if (tool_dir / "above_the_fold.png").exists() else None,
            "page_mobile": "page_mobile.png" if (tool_dir / "page_mobile.png").exists() else None,
        },
        "scroll_log": {
            "scroll_steps": scroll_steps,
            "lazy_items_promoted": promoted if isinstance(promoted, int) else 0,
            "scroll_duration_seconds": scroll_duration,
        },
        "findings": {
            "found": {
                "images": counts["image"],
                "background_images": counts["background_image"],
                "gifs": counts["gif"],
                "svgs": counts["svg"],
                "videos": counts["video"],
                "embeds": counts["embed"],
            },
            "downloaded": len(saved_assets),
            "skipped_too_small": skipped_count,
            "failed": failed_count,
            "failed_items": failed_downloads,
        },
        "errors": {
            "console_errors": console_errors,
            "failed_network_requests": failed_requests,
            "cookie_banner_dismissed": cookie_dismissed,
        },
        "run_log": run_log,
    }
    pw_report_path = tool_dir / "playwright_report.json"
    with open(pw_report_path, "w", encoding="utf-8") as pf:
        json.dump(pw_report, pf, indent=2, ensure_ascii=False)
    print(f"Playwright report saved to: {pw_report_path}")

    # Save site_data.json for UI & auto-script generation
    site_data = {
        "tool": tool,
        "url": url,
        "final_url": final_url,
        "title": page_title,
        "description": page_meta_desc,
        "hero_png": "above_the_fold.png" if (tool_dir / "above_the_fold.png").exists() else None,
        "sections": page_sections,
        "images": [a["source_url"] for a in saved_assets if a["type"] == "image"],
        "videos": [a["source_url"] for a in saved_assets if a["type"] == "video"],
        "embeds": [a["source_url"] for a in saved_assets if a["type"] == "embed"],
    }
    with open(tool_dir / "site_data.json", "w", encoding="utf-8") as sf:
        json.dump(site_data, sf, indent=2, ensure_ascii=False)

    # Save/update manifest.json so shot matcher & assembler have library clips
    video_lib = []
    for a in saved_assets:
        if a.get("type") in ("video", "embed") and a.get("file_path"):
            video_lib.append({
                "file": a["file_path"],
                "section": a.get("section", ""),
                "text": a.get("section", ""),
                "source": a.get("source_url", ""),
                "qa": "pass",
            })
    mpath = tool_dir / "manifest.json"
    existing_m = {}
    if mpath.exists():
        try:
            existing_m = json.loads(mpath.read_text(encoding="utf-8"))
        except Exception:
            pass
    manifest = {
        "tool": tool,
        "url": url,
        "status": "ok",
        "library": video_lib or existing_m.get("library", []),
        "shots": existing_m.get("shots", []),
    }
    with open(mpath, "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, indent=2, ensure_ascii=False)

    # Save assets.json and failed_downloads.json
    assets_json_path = tool_dir / "assets.json"
    with open(assets_json_path, "w", encoding="utf-8") as jf:
        json.dump(saved_assets, jf, indent=2, ensure_ascii=False)
    print(f"\nSaved {len(saved_assets)} asset records to: {assets_json_path}")

    failed_json_path = tool_dir / "failed_downloads.json"
    with open(failed_json_path, "w", encoding="utf-8") as ff:
        json.dump(failed_downloads, ff, indent=2, ensure_ascii=False)

    # Generate gallery.html
    gallery_html_path = tool_dir / "gallery.html"
    generate_gallery_html(
        tool_name=tool,
        website_url=url,
        assets=saved_assets,
        output_file=gallery_html_path,
        counts=counts,
    )
    print(f"Generated gallery view at: {gallery_html_path}")

    # Print summary
    total_saved = len(saved_assets)
    print("\n" + "=" * 60)
    print(f"  ASSET EXTRACTION SUMMARY FOR: {tool}")
    print("=" * 60)
    print(f"  Images saved:      {counts['image']}")
    print(f"  GIFs saved:        {counts['gif']}")
    print(f"  Videos saved:      {counts['video']}")
    print(f"  Embeds found:      {counts['embed']}")
    print(f"  Tiny skipped:      {skipped_count} (< {format_bytes(min_size_bytes)})")
    print(f"  Failed downloads:  {failed_count}")
    print(f"  Total saved:       {total_saved}")
    print("=" * 60 + "\n")

    return {
        "tool": tool,
        "url": url,
        "counts": counts,
        "skipped": skipped_count,
        "failed": failed_count,
        "total_saved": total_saved,
        "assets_json": str(assets_json_path),
        "gallery_html": str(gallery_html_path),
        "playwright_report": str(pw_report_path),
    }


def generate_gallery_html(
    tool_name: str,
    website_url: str,
    assets: list,
    output_file: Path,
    counts: dict,
):
    """Generate a responsive gallery HTML page to review all downloaded assets."""
    total_bytes = sum(a.get("size_bytes", 0) for a in assets)
    total_size_human = format_bytes(total_bytes)

    # Build asset cards HTML
    cards_html = []
    for idx, asset in enumerate(assets):
        t = asset.get("type", "image")
        fn = asset.get("file_name") or "(Embed / Stream)"
        fp = asset.get("file_path") or ""
        src_url = asset.get("source_url", "")
        sz = asset.get("size_human", "")
        dims = asset.get("dimensions", {})
        w = dims.get("width", 0)
        h = dims.get("height", 0)
        dim_str = f"{w} × {h} px" if (w and h) else "auto"
        section = asset.get("section") or "General"

        # Media preview element
        if t == "video":
            media_elem = (
                f'<video src="{html.escape(fp)}" controls preload="metadata" playsinline '
                f'style="max-width:100%; max-height:220px; object-fit:contain; border-radius:8px; background:#000;"></video>'
            )
        elif t == "embed":
            if fp and Path(output_file.parent / fp).exists():
                media_elem = (
                    f'<video src="{html.escape(fp)}" controls preload="metadata" playsinline '
                    f'style="max-width:100%; max-height:220px; object-fit:contain; border-radius:8px; background:#000;"></video>'
                )
            else:
                media_elem = (
                    f'<div style="width:100%; height:200px; display:flex; align-items:center; justify-content:center; background:#1e1e24; border-radius:8px; padding:12px; text-align:center;">'
                    f'  <div><div style="font-size:2rem; margin-bottom:6px;">▶️</div>'
                    f'  <div style="font-size:0.85rem; color:#a1a1aa; word-break:break-all;">{html.escape(src_url)}</div>'
                    f'  <a href="{html.escape(src_url)}" target="_blank" style="display:inline-block; margin-top:8px; font-size:0.8rem; color:#60a5fa;">Open Embed ↗</a></div>'
                    f'</div>'
                )
        else:
            # image, gif, svg
            media_elem = (
                f'<img src="{html.escape(fp)}" alt="{html.escape(fn)}" loading="lazy" '
                f'onclick="openLightbox(\'{html.escape(fp)}\', \'{html.escape(fn)}\')" '
                f'style="max-width:100%; max-height:220px; object-fit:contain; border-radius:8px; cursor:zoom-in;">'
            )

        badge_color = {
            "image": "#3b82f6",
            "gif": "#ec4899",
            "video": "#8b5cf6",
            "svg": "#10b981",
            "embed": "#f59e0b",
        }.get(t, "#6b7280")

        card = f"""
        <div class="asset-card" data-type="{html.escape(t)}" data-section="{html.escape(section.lower())}">
          <div class="card-preview">
            {media_elem}
          </div>
          <div class="card-body">
            <div class="card-meta">
              <span class="type-pill" style="background:{badge_color}22; color:{badge_color}; border:1px solid {badge_color}55;">
                {t.upper()}
              </span>
              <span class="dim-pill">{html.escape(dim_str)}</span>
              <span class="size-pill">{html.escape(sz)}</span>
            </div>
            <div class="section-label" title="{html.escape(section)}">
              📌 {html.escape(section)}
            </div>
            <div class="file-name" title="{html.escape(fn)}">
              {f'<a href="{html.escape(fp)}" target="_blank">{html.escape(fn)}</a>' if fp else html.escape(fn)}
            </div>
            <div class="source-link">
              <a href="{html.escape(src_url)}" target="_blank" rel="noopener">↗ Source Link</a>
            </div>
          </div>
        </div>
        """
        cards_html.append(card)

    rendered_cards = "\n".join(cards_html)

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{html.escape(tool_name)} - Asset Gallery</title>
  <style>
    :root {{
      --bg: #0b0f19;
      --card-bg: #131a29;
      --card-border: #1f293d;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #6366f1;
    }}
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.5;
    }}
    .header {{
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
    }}
    .header h1 {{
      font-size: 1.75rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }}
    .header-link {{
      font-size: 0.9rem;
      color: #60a5fa;
      text-decoration: none;
    }}
    .header-link:hover {{ text-decoration: underline; }}
    .stats-bar {{
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }}
    .stat-badge {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 500;
    }}
    .stat-badge strong {{ color: #fff; }}
    .controls {{
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin-bottom: 24px;
    }}
    .filter-btn {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 0.875rem;
      cursor: pointer;
      transition: all 0.2s;
    }}
    .filter-btn:hover, .filter-btn.active {{
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }}
    .search-input {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: #fff;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 0.875rem;
      margin-left: auto;
      min-width: 220px;
    }}
    .search-input:focus {{
      outline: none;
      border-color: var(--accent);
    }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 20px;
    }}
    .asset-card {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: transform 0.2s, border-color 0.2s;
    }}
    .asset-card:hover {{
      transform: translateY(-2px);
      border-color: #3b82f6;
    }}
    .card-preview {{
      height: 220px;
      background: #090d16;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
      overflow: hidden;
    }}
    .card-body {{
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-grow: 1;
    }}
    .card-meta {{
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.75rem;
    }}
    .type-pill {{
      padding: 2px 8px;
      border-radius: 6px;
      font-weight: 700;
      letter-spacing: 0.05em;
    }}
    .dim-pill, .size-pill {{
      background: #1f293d;
      color: var(--text-muted);
      padding: 2px 6px;
      border-radius: 4px;
    }}
    .section-label {{
      font-size: 0.8rem;
      color: #a78bfa;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }}
    .file-name {{
      font-size: 0.85rem;
      font-weight: 600;
      color: #e5e7eb;
      word-break: break-all;
    }}
    .file-name a {{
      color: inherit;
      text-decoration: none;
    }}
    .file-name a:hover {{ text-decoration: underline; color: #60a5fa; }}
    .source-link {{
      margin-top: auto;
      padding-top: 6px;
      font-size: 0.75rem;
    }}
    .source-link a {{
      color: #6b7280;
      text-decoration: none;
      word-break: break-all;
    }}
    .source-link a:hover {{ color: #9ca3af; text-decoration: underline; }}
    /* Lightbox modal */
    #lightbox {{
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.9);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      padding: 20px;
    }}
    #lightbox img {{
      max-width: 90vw;
      max-height: 85vh;
      object-fit: contain;
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }}
    #lightbox-caption {{
      margin-top: 12px;
      color: #e5e7eb;
      font-size: 0.95rem;
    }}
  </style>
</head>
<body>

  <div class="header">
    <div>
      <h1>📁 {html.escape(tool_name)} Media Assets</h1>
      <a class="header-link" href="{html.escape(website_url)}" target="_blank">🌐 {html.escape(website_url)}</a>
    </div>
    <div class="stats-bar">
      <div class="stat-badge">Total: <strong>{len(assets)}</strong></div>
      <div class="stat-badge">Images: <strong>{counts.get('image', 0)}</strong></div>
      <div class="stat-badge">GIFs: <strong>{counts.get('gif', 0)}</strong></div>
      <div class="stat-badge">Videos: <strong>{counts.get('video', 0)}</strong></div>
      <div class="stat-badge">Embeds: <strong>{counts.get('embed', 0)}</strong></div>
      <div class="stat-badge">Size: <strong>{total_size_human}</strong></div>
    </div>
  </div>

  <div class="controls">
    <button class="filter-btn active" onclick="filterType('all')">All ({len(assets)})</button>
    <button class="filter-btn" onclick="filterType('image')">Images ({counts.get('image', 0)})</button>
    <button class="filter-btn" onclick="filterType('gif')">GIFs ({counts.get('gif', 0)})</button>
    <button class="filter-btn" onclick="filterType('video')">Videos ({counts.get('video', 0)})</button>
    <button class="filter-btn" onclick="filterType('embed')">Embeds ({counts.get('embed', 0)})</button>
    <input type="text" class="search-input" id="searchInput" placeholder="Search section or filename..." oninput="handleSearch()">
  </div>

  <div class="grid" id="assetGrid">
    {rendered_cards}
  </div>

  <div id="lightbox" onclick="closeLightbox()">
    <img id="lightbox-img" src="" alt="">
    <div id="lightbox-caption"></div>
  </div>

  <script>
    let currentFilter = 'all';

    function filterType(type) {{
      currentFilter = type;
      document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
      event.target.classList.add('active');
      applyFilters();
    }}

    function handleSearch() {{
      applyFilters();
    }}

    function applyFilters() {{
      const query = document.getElementById('searchInput').value.toLowerCase();
      document.querySelectorAll('.asset-card').forEach(card => {{
        const cardType = card.getAttribute('data-type');
        const cardSection = card.getAttribute('data-section');
        const cardText = card.innerText.toLowerCase();

        const matchesType = (currentFilter === 'all') || (cardType === currentFilter) || (currentFilter === 'image' && cardType === 'svg');
        const matchesQuery = !query || cardText.includes(query) || cardSection.includes(query);

        if (matchesType && matchesQuery) {{
          card.style.display = 'flex';
        }} else {{
          card.style.display = 'none';
        }}
      }});
    }}

    function openLightbox(src, name) {{
      const lb = document.getElementById('lightbox');
      const img = document.getElementById('lightbox-img');
      const cap = document.getElementById('lightbox-caption');
      img.src = src;
      cap.innerText = name;
      lb.style.display = 'flex';
    }}

    function closeLightbox() {{
      document.getElementById('lightbox').style.display = 'none';
    }}
  </script>
</body>
</html>
"""
    output_file.write_text(html_content, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(
        description="Extract all media untouched from a website using a mobile Playwright context."
    )
    parser.add_argument("tool", nargs="?", default="", help="Tool name, e.g. gamma or pomelli")
    parser.add_argument("url", nargs="?", default="", help="Website URL, e.g. https://gamma.app")
    parser.add_argument("--tool", dest="tool_opt", default="", help="Tool name option")
    parser.add_argument("--url", dest="url_opt", default="", help="Website URL option")
    parser.add_argument("--out", default="out", help="Output directory (default: out)")
    parser.add_argument("--headed", action="store_true", help="Launch browser in headed mode")
    parser.add_argument(
        "--min-size",
        type=int,
        default=MIN_SIZE_BYTES_DEFAULT,
        help=f"Minimum file size in bytes to keep (default: {MIN_SIZE_BYTES_DEFAULT})",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=60000,
        help="Navigation timeout in milliseconds (default: 60000)",
    )

    args = parser.parse_args()

    tool = (args.tool_opt or args.tool).strip()
    url = (args.url_opt or args.url).strip()
    if not tool and url:
        tool = tool_name(url)
    elif not url and tool:
        url = tool
        tool = tool_name(url)

    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url

    res = extract_assets(
        tool=tool,
        url=url,
        out_root=args.out,
        headed=args.headed,
        min_size_bytes=args.min_size,
        timeout_ms=args.timeout,
    )
    return 0 if (res.get("total_saved", 0) > 0 or res.get("blocked")) else 1


if __name__ == "__main__":
    sys.exit(main())

