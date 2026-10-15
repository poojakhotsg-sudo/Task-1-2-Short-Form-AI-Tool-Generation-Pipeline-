"""
login_once.py - sign in to a tool's free trial yourself, once, and save the session.

    python login_once.py gamma https://gamma.app/signup

Opens a visible browser on the signup URL. You do everything by hand: sign up,
log in, and enter card details only if the site asks. This script does not
read, fill or record any field. When you're signed in, press Enter in this
terminal and the session (cookies + storage) is saved to auth_<tool>.json,
which pipeline/trial_recorder.py loads. Treat that file like a password:
it's gitignored, don't share it.
"""

import argparse
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from pipeline.grabber import slugify

ROOT = Path(__file__).resolve().parent


def auth_paths(tool):
    slug = slugify(tool)
    return ROOT / f"auth_{slug}.json", ROOT / f"auth_{slug}.meta.json"


def main():
    ap = argparse.ArgumentParser(description="Sign in by hand once and save the browser session")
    ap.add_argument("tool", help="tool name, e.g. gamma")
    ap.add_argument("signup_url", help="the tool's signup or login page")
    ap.add_argument("--channel", default=None,
                    help="use an installed browser, e.g. 'chrome' (helps with Google sign-in)")
    a = ap.parse_args()
    url = a.signup_url if a.signup_url.startswith("http") else "https://" + a.signup_url
    auth_file, meta_file = auth_paths(a.tool)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, channel=a.channel)
        ctx = browser.new_context(no_viewport=True)
        page = ctx.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=60000)

        print(f"\nA browser window is open on {url}")
        print("Sign up / log in yourself. Enter card details yourself only if the site asks.")
        print("When you can see the tool's dashboard, come back here.")
        try:
            input("\nPress Enter to save the session (Ctrl+C to cancel)... ")
        except (KeyboardInterrupt, EOFError):
            browser.close()
            sys.exit("\nCancelled, nothing saved.")

        ua = ctx.pages[0].evaluate("navigator.userAgent") if ctx.pages else None
        ctx.storage_state(path=str(auth_file), indexed_db=True)
        browser.close()

    meta_file.write_text(json.dumps({"tool": slugify(a.tool), "signup_url": url, "user_agent": ua}, indent=2))
    try:
        os.chmod(auth_file, 0o600)
    except OSError:
        pass
    print(f"Saved session to {auth_file.name}")


if __name__ == "__main__":
    main()
