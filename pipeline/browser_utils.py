"""
browser_utils.py - Memory-optimized Playwright browser launch and resource control.

Optimized for 512 MB RAM environments (e.g. Render Free Tier):
- Enforces lightweight launch flags: --no-sandbox, --disable-dev-shm-usage,
  --disable-gpu, --disable-extensions, --disable-background-networking.
- Supports remote CDP browser via BROWSER_WS_URL environment variable.
- Strips whitespace/quotes and validates ws:// or wss:// without exposing tokens.
- Provides page.route hooks to abort heavy image/media/font requests.
- Closes pages, contexts, and browsers safely in try/finally blocks.
"""

import logging
import os
from urllib.parse import urlparse

log = logging.getLogger("browser_utils")

CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
]


def get_browser_ws_url():
    """
    Read and sanitize BROWSER_WS_URL.
    Strips whitespace and surrounding single/double quotes.
    Validates that the URL starts with 'ws://' or 'wss://'.
    If invalid or non-websocket, prints a clear error without exposing secret tokens.
    """
    raw = os.environ.get("BROWSER_WS_URL")
    if raw is None:
        return None

    # Strip whitespace and any surrounding quotes
    val = raw.strip().strip("'\"").strip()
    if not val:
        return None

    if not (val.startswith("wss://") or val.startswith("ws://")):
        error_msg = "BROWSER_WS_URL is missing or invalid (must start with wss://)"
        print(error_msg)
        log.error(error_msg)
        return None

    return val


def launch_or_connect(playwright, headed=False, extra_args=None):
    """
    Unified browser opening helper for all pipeline stages (grab, script, trial, extract).
    Connects to remote CDP browser if BROWSER_WS_URL is set, otherwise launches Chromium
    with memory-saving flags. Never prints secret tokens in logs or console.
    """
    ws_url = get_browser_ws_url()
    if ws_url:
        try:
            # Mask sensitive token/query parameters in logs
            parsed = urlparse(ws_url)
            safe_target = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
            log.info("Connecting to remote browser over CDP: %s", safe_target)
            print(f"Connecting to remote browser via CDP ({safe_target})")
        except Exception:
            print("Connecting to remote browser via CDP")
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
