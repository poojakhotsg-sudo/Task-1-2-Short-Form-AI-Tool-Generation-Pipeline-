"""
grab_visuals.py - pull short vertical clips from an AI tool's website.

Usage:
    python grab_visuals.py https://tool.com pomelli [--headed] [--clips 5] [--seconds 9]

Output:
    out/<toolname>/clips/clip01.mp4 ...        recorded 1080x1920 clips
    out/<toolname>/clips/site_video01.mp4 ...  <video> files found on the page
    out/<toolname>/clips/embed_video01.mp4 ... embedded YouTube/Vimeo videos (needs yt-dlp)

Needs: pip install playwright && playwright install chromium, plus ffmpeg on PATH.
"""

import argparse
import mimetypes
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.sync_api import sync_playwright
from pipeline.browser_utils import launch_or_connect, safe_close

W, H = 1080, 1920
VIEWPORT_W, VIEWPORT_H = 390, 844


def mobile_device(p):
    """Return an iPhone 14 phone device profile configured for 390x844 mobile layout."""
    dev = dict(p.devices["iPhone 14"])
    dev["viewport"] = {"width": VIEWPORT_W, "height": VIEWPORT_H}
    dev["is_mobile"] = True
    dev["has_touch"] = True
    return dev

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

# Returns page-y of the main content sections, top to bottom, de-duplicated.
FIND_SECTIONS_JS = """
() => {
  const vh = innerHeight;
  const els = [...document.querySelectorAll(
    'main section, section, main > div, [class*="section" i], [id*="section" i], article, footer')];
  const tops = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.height < 250 || r.width < innerWidth * 0.5) continue;
    if (st.display === 'none' || st.visibility === 'hidden' || st.position === 'fixed') continue;
    tops.push(Math.round(r.top + scrollY));
  }
  tops.sort((a, b) => a - b);
  const out = [];
  for (const t of tops) if (!out.length || t - out[out.length - 1] > vh * 0.45) out.push(t);
  return {sections: out, height: document.documentElement.scrollHeight, vh};
}
"""

# Hover targets currently in the viewport: buttons, cards, images, links.
HOVER_TARGETS_JS = """
() => {
  const vh = innerHeight, vw = innerWidth;
  const els = [...document.querySelectorAll(
    'button, a[class*="btn" i], a[class*="button" i], [role="button"], [class*="card" i], img, video, picture, h2, h3')];
  const pts = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) continue;
    if (r.top < vh * 0.1 || r.bottom > vh * 0.92 || r.left < 0 || r.right > vw) continue;
    pts.push([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
  }
  const out = [];
  for (const p of pts) if (!out.some(q => Math.hypot(p[0]-q[0], p[1]-q[1]) < 200)) out.push(p);
  return out.slice(0, 6);
}
"""

VIDEO_SRCS_JS = """
() => {
  const urls = new Set();
  document.querySelectorAll('video, video source').forEach(v => {
    for (const u of [v.currentSrc, v.src, v.getAttribute('src'), v.getAttribute('data-src')])
      if (u && !u.startsWith('blob:') && !u.startsWith('data:')) urls.add(u);
  });
  return [...urls];
}
"""


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
    # Anything fixed-position still mentioning cookies/consent gets hidden.
    page.evaluate("""
    () => document.querySelectorAll('body *').forEach(el => {
      const st = getComputedStyle(el);
      if ((st.position === 'fixed' || st.position === 'sticky') &&
          /cookie|consent|gdpr|privacy/i.test(el.id + ' ' + el.className + ' ' + (el.innerText || '').slice(0, 400)) &&
          el.getBoundingClientRect().height < innerHeight * 0.9)
        el.style.setProperty('display', 'none', 'important');
    })
    """)
    return clicked


def download_videos(page, network_videos, dest, base_url):
    urls = []
    for u in page.evaluate(VIDEO_SRCS_JS) + sorted(network_videos):
        full = urljoin(base_url, u)
        if full not in urls:
            urls.append(full)
    saved = []
    for u in urls:
        try:
            resp = page.request.get(u, timeout=60000)
            if not resp.ok:
                continue
            body = resp.body()
            if len(body) < 20_000:  # skip tracking pixels / tiny placeholders
                continue
            ctype = resp.headers.get("content-type", "").split(";")[0]
            ext = Path(urlparse(u).path).suffix.lower()
            if ext not in {".mp4", ".webm", ".mov", ".m4v"}:
                ext = mimetypes.guess_extension(ctype) or ".mp4"
            out = dest / f"site_video{len(saved) + 1:02d}{ext}"
            out.write_bytes(body)
            saved.append((out, u, len(body)))
        except Exception as e:
            print(f"  ! could not download {u}: {e}")
    return saved


EMBED_RE = re.compile(r"(youtube\.com/embed/|youtube-nocookie\.com/embed/|player\.vimeo\.com/video/|wistia|loom\.com/embed/)")


def download_embeds(page, dest):
    """Fetch embedded YouTube/Vimeo/Loom/Wistia players with yt-dlp, if installed."""
    srcs = []
    for f in page.evaluate("[...document.querySelectorAll('iframe')].map(f => f.src)"):
        if f and EMBED_RE.search(f) and f not in srcs:
            srcs.append(f.split("?")[0])
    if not srcs:
        return [], []
    ytdlp = shutil.which("yt-dlp")
    if not ytdlp:
        return [], srcs
    saved = []
    for src in srcs:
        out = dest / f"embed_video{len(saved) + 1:02d}.mp4"
        cmd = [ytdlp, "-q", "--no-warnings", "--no-playlist",
               "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
               "--merge-output-format", "mp4", "-o", str(out), src]
        if subprocess.run(cmd).returncode == 0 and out.exists():
            saved.append((out, src, out.stat().st_size))
        else:
            print(f"  ! yt-dlp could not fetch {src}")
    return saved, [s for s in srcs if s not in {x[1] for x in saved}]


def hover_around(page, seconds):
    """Glide the mouse across visible interactive elements for roughly `seconds`."""
    end = time.monotonic() + seconds
    targets = page.evaluate(HOVER_TARGETS_JS) or [[VIEWPORT_W // 2, VIEWPORT_H // 2]]
    i = 0
    while time.monotonic() < end:
        x, y = targets[i % len(targets)]
        page.mouse.move(x, y, steps=25)
        page.wait_for_timeout(700)
        i += 1


def record_session(url, n_clips, seconds, headed, workdir, network_videos, tool_name=None):
    """Run one browser session with video on; return (webm_path, [(start, end), ...], final_url)."""
    segments = []
    with sync_playwright() as p:
        browser = launch_or_connect(p, headed=headed)
        dev = mobile_device(p)
        ctx = browser.new_context(
            **dev,
            record_video_dir=str(workdir),
            record_video_size={"width": VIEWPORT_W, "height": VIEWPORT_H},
        )
        page = ctx.new_page()
        vp = page.viewport_size
        ua = page.evaluate("navigator.userAgent")
        print(f"Playwright mobile layout check: viewport={vp}, user_agent={ua}")
        t0 = time.monotonic()

        def on_response(resp):
            ctype = resp.headers.get("content-type", "")
            if ctype.startswith("video/") and not resp.url.startswith("blob:"):
                network_videos.add(resp.url)

        page.on("response", on_response)

        print(f"> loading {url}")
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass
        page.wait_for_timeout(1500)

        n = close_cookie_popups(page)
        print(f"> cookie popups: clicked {n} button(s)")

        if tool_name:
            test_png = Path("out") / tool_name / "test_screenshot.png"
            test_png.parent.mkdir(parents=True, exist_ok=True)
            try:
                page.screenshot(path=str(test_png))
                print(f"Saved mobile test screenshot: {test_png}")
            except Exception as e:
                print(f"Could not save mobile test screenshot: {e}")

        # Warm-up pass: scroll the whole page so lazy images/videos load, then back to top.
        info = page.evaluate(FIND_SECTIONS_JS)
        y = 0
        while y < info["height"]:
            page.evaluate(f"scrollTo(0, {y})")
            page.wait_for_timeout(250)
            y += info["vh"] // 2
        close_cookie_popups(page)  # some banners appear only after scrolling
        page.evaluate("scrollTo(0, 0)")
        page.evaluate(CURSOR_JS)
        page.mouse.move(VIEWPORT_W // 2, VIEWPORT_H // 3)
        page.wait_for_timeout(1500)

        info = page.evaluate(FIND_SECTIONS_JS)
        max_y = max(0, info["height"] - info["vh"])
        # Sections after the hero; fall back to evenly spaced positions if markup is flat.
        sections = [s for s in info["sections"] if s > info["vh"] * 0.5]
        need = n_clips - 1
        if len(sections) < need:
            sections = [int(max_y * (i + 1) / (need + 1)) for i in range(need)]
        elif len(sections) > need:
            idx = [round(i * (len(sections) - 1) / max(need - 1, 1)) for i in range(need)]
            sections = [sections[i] for i in idx]
        # On short pages, positions collapse onto each other - drop clips that would be repeats.
        deduped, last = [], 0
        for s in sorted(min(max(s - 40, 0), max_y) for s in sections):
            if s - last >= info["vh"] * 0.35:
                deduped.append(s)
                last = s
        if len(deduped) < len(sections):
            print(f"> page is short ({info['height']}px): recording {len(deduped) + 1} clip(s), "
                  f"not {n_clips}, to avoid duplicates")
        sections = deduped

        # Clip 1: hero - hover the CTAs, then a gentle drift down.
        start = time.monotonic() - t0
        hover_around(page, seconds * 0.6)
        page.evaluate(SMOOTH_SCROLL_JS, [min(int(info["vh"] * 0.25), max_y), int(seconds * 400)])
        page.wait_for_timeout(int(seconds * 0.4 * 1000 - seconds * 400) + 200)
        segments.append((start, time.monotonic() - t0))

        # Clips 2..n: smooth scroll into each section, hover, keep drifting.
        for top in sections:
            target = min(max(top - 40, 0), max_y)
            page.evaluate(SMOOTH_SCROLL_JS, [max(target - info["vh"] // 3, 0), 600])  # off-camera lead-in
            page.wait_for_timeout(300)
            start = time.monotonic() - t0
            page.evaluate(SMOOTH_SCROLL_JS, [target, 1800])
            hover_around(page, seconds * 0.55)
            page.evaluate(SMOOTH_SCROLL_JS, [min(target + info["vh"] // 3, max_y), int(seconds * 300)])
            elapsed = time.monotonic() - t0 - start
            if elapsed < seconds:
                page.wait_for_timeout(int((seconds - elapsed) * 1000))
            segments.append((start, time.monotonic() - t0))

        final_url = page.url
        video = page.video
        ctx.close()  # flushes the recording
        webm = Path(video.path())
        browser.close()
    return webm, segments, final_url


def cut_clip(webm, start, end, out, seconds):
    dur = min(end - start, seconds + 1)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{start:.2f}", "-i", str(webm), "-t", f"{dur:.2f}",
        "-vf", f"scale={W}:{H}:flags=lanczos,fps=30",
        "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-an", str(out),
    ]
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser(description="Grab vertical video clips from an AI tool's website.")
    ap.add_argument("url")
    ap.add_argument("tool")
    ap.add_argument("--clips", type=int, default=5)
    ap.add_argument("--seconds", type=float, default=9.0, help="target length per clip (8-10 recommended)")
    ap.add_argument("--headed", action="store_true", help="show the browser while recording")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found on PATH")

    url = args.url if args.url.startswith("http") else "https://" + args.url
    tool = re.sub(r"[^a-z0-9_-]+", "-", args.tool.lower()).strip("-")
    clips_dir = Path("out") / tool / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    network_videos = set()
    with tempfile.TemporaryDirectory() as tmp:
        webm, segments, final_url = record_session(
            url, args.clips, args.seconds, args.headed, Path(tmp), network_videos, tool_name=tool)

        recorded = []
        for i, (s, e) in enumerate(segments, 1):
            out = clips_dir / f"clip{i:02d}.mp4"
            cut_clip(webm, s, e, out, args.seconds)
            recorded.append((out, e - s))

    # Download page videos in a fresh, unrecorded session.
    with sync_playwright() as p:
        browser = launch_or_connect(p)
        dev = mobile_device(p)
        page = browser.new_page(**dev)
        page.on("response", lambda r: network_videos.add(r.url)
                if r.headers.get("content-type", "").startswith("video/") else None)
        try:
            page.goto(final_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(4000)
            page.evaluate("async () => { for (let y = 0; y < document.body.scrollHeight; y += 800)"
                          " { scrollTo(0, y); await new Promise(r => setTimeout(r, 200)); } }")
            page.wait_for_timeout(1500)
        except Exception as e:
            print(f"  ! reload for video scan failed: {e}")
        site_videos = download_videos(page, network_videos, clips_dir, final_url)
        embed_videos, embed_missed = download_embeds(page, clips_dir)
        site_videos += embed_videos
        browser.close()

    print(f"\n=== {args.tool} : {url}")
    print(f"Saved to {clips_dir.resolve()}")
    labels = ["hero"] + [f"section {i}" for i in range(1, len(recorded))]
    for (path, dur), label in zip(recorded, labels):
        print(f"  {path.name:<18} {dur:4.1f}s  {label}")
    if site_videos:
        for path, src, size in site_videos:
            print(f"  {path.name:<18} {size / 1e6:5.1f} MB  from {src}")
    else:
        print("  (no downloadable <video> files found on the page)")
    for src in embed_missed:
        print(f"  embedded video not downloaded (install yt-dlp): {src}")
    print(f"Total: {len(recorded)} recorded clip(s), {len(site_videos)} site video(s)")


if __name__ == "__main__":
    main()
