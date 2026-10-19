"""
browser_utils.py - Memory-optimized Playwright browser launch and resource control.

Optimized for 512 MB RAM environments (e.g. Render Free Tier):
- Enforces lightweight launch flags: --no-sandbox, --disable-dev-shm-usage,
  --disable-gpu, --disable-extensions, --disable-background-networking.
- Supports remote CDP browser via BROWSER_WS_URL environment variable.
- Provides page.route hooks to abort heavy image/media/font requests.
- Closes pages, contexts, and browsers safely in try/finally blocks.
"""

import logging
import os

log = logging.getLogger("browser_utils")

CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
]


def launch_or_connect(playwright, headed=False, extra_args=None):
    """
    Launch Chromium with memory-saving flags, or connect to a remote CDP browser
    if BROWSER_WS_URL is set in environment.
    """
    ws_url = os.environ.get("BROWSER_WS_URL", "").strip()
    if ws_url:
        log.info("Connecting to remote Playwright browser over CDP: %s", ws_url)
        return playwright.chromium.connect_over_cdp(ws_url)

    args = list(CHROMIUM_ARGS)
    if extra_args:
        for a in extra_args:
            if a not in args:
                args.append(a)

    return playwright.chromium.launch(headless=not headed, args=args)


def block_resources(page, block_types=("image", "media", "font")):
    """
    Block non-essential resource types (image, media, font) to prevent OOM
    crashes on constrained 512 MB RAM environments.
    """
    def _handler(route):
        try:
            if route.request.resource_type in block_types:
                route.abort()
            else:
                route.continue_()
        except Exception:
            pass

    try:
        page.route("**/*", _handler)
    except Exception as e:
        log.warning("Could not attach route blocker: %s", e)


def safe_close(page=None, context=None, browser=None):
    """Safely close page, context, or browser without raising exceptions."""
    if page is not None:
        try:
            page.close()
        except Exception:
            pass
    if context is not None:
        try:
            context.close()
        except Exception:
            pass
    if browser is not None:
        try:
            browser.close()
        except Exception:
            pass
