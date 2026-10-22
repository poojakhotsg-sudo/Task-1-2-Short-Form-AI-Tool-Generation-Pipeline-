"""
manychat_doc.py - write docs/manychat_setup.md, with the per-tool table filled from data/tools.json.

    python -m pipeline.manychat_doc

The first run writes the whole guide. Later runs only replace the table between the
"tools-table" markers, so edits to the rest of the guide are kept. Links use
PUBLIC_BASE_URL from .env (the app's public address); without it they show YOUR-APP-URL.
"""

import json
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "manychat_setup.md"
TOOLS_DB = ROOT / "data" / "tools.json"
OUT = Path(os.environ.get("REEL_OUT_DIR") or ROOT / "out")
START, END = "<!-- tools-table:start -->", "<!-- tools-table:end -->"

GUIDE = """# ManyChat setup: comment keyword -> DM

The comment-reply flows are built in ManyChat. This app is the backend they link to and call:

- `GET /go/<KEYWORD>` sends people to the tool's checkout page (paid tools), or to its lead magnet page.
  Every click is logged to `data/clicks.csv`; the Library's **Keywords** tab shows the counts.
- `POST /api/subscribe` saves an email to `data/subscribers.csv` (one row per email) and returns the
  tool's lead magnet PDF link.

## Before you start

1. **Make the app reachable from the internet.** ManyChat and Instagram can't open `127.0.0.1`.
   Deploy it (this repo has `render.yaml`) or run a free tunnel, then put the public address in
   `.env` as `PUBLIC_BASE_URL=https://...` and restart the app.
2. **Give each tool a unique comment keyword** in the Reel Kit form on the Pipeline page. The form
   warns you, and refuses to start, if another tool already uses the keyword.
3. **Optional, recommended for Flow B:** set `SUBSCRIBE_TOKEN=<any long random string>` in `.env`.
   `/api/subscribe` then only accepts requests that send it in an `X-Subscribe-Token` header.
4. Re-run `python -m pipeline.manychat_doc` whenever keywords change, to refresh the table below.

## Flow A: comment keyword -> DM with the /go link

1. In ManyChat, go to **Automation -> New Automation -> Start from scratch**.
2. Add the trigger **Instagram: User comments on your Post or Reel**. Pick the reel, and under
   **Comment contains** enter the tool's keyword from the table (e.g. `GUIDE`).
3. Optional: turn on the public reply to the comment (e.g. "Sent you a DM!").
4. Add a **Send Message** step: a short text plus a button. Set the button to **Open website** with
   the tool's **/go link** from the table.
5. Set the automation live, then comment the keyword from a second account to test it.
   The click should appear in **Library -> Keywords**.

## Flow B: comment keyword -> ask for email -> webhook -> PDF link

1. Start the automation with the same comment trigger as Flow A.
2. **Send Message** asking for their email, with a **User Input** of type **Email**. Save the
   answer to the contact's **Email** field.
3. Add **Actions -> External Request**. Note: as far as I know, External Request needs a ManyChat
   Pro plan. If you're on the free plan, use Flow A.
   - Method `POST`, URL `<PUBLIC_BASE_URL>/api/subscribe`
   - Headers: `Content-Type: application/json` and, if you set one, `X-Subscribe-Token: <your token>`
   - Body (insert the Email and First Name fields with ManyChat's field picker):
     ```json
     {"email": "<Email field>", "name": "<First Name field>", "keyword": "GUIDE", "tool_id": "genspark.assets"}
     ```
     Use the tool's keyword and tool_id from the table.
   - **Response mapping:** `$.pdf_url` -> a custom text field, e.g. `lead_magnet_url`.
4. **Send Message**: "Here's your guide" with a button that opens `lead_magnet_url`.
5. Use **Test the request** in the External Request step, then test the whole flow from a second account.

What `/api/subscribe` returns:

| Status | When | Body |
|---|---|---|
| 200 | saved, or the email was already on the list | `{"ok": true, "duplicate": false, "tool_id": "...", "pdf_url": "https://.../lead_magnet.pdf?v=...", "message": "Subscribed"}` |
| 400 | email missing or invalid, or neither tool_id nor keyword sent | `{"error": "..."}` |
| 401 | `SUBSCRIBE_TOKEN` is set and the header is missing or wrong | `{"error": "..."}` |
| 404 | unknown tool_id or keyword | `{"error": "..."}` |

`pdf_url` is `null` if the tool has no lead magnet PDF yet (the email is still saved).

## Tools

"""


def table(base):
    try:
        db = json.loads(TOOLS_DB.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        db = {}
    rows = ["| Tool | tool_id | Keyword | Flow A link | Price | Flow A sends to | Flow B lead magnet PDF |",
            "|---|---|---|---|---|---|---|"]
    for tool_id, meta in (db.items() if isinstance(db, dict) else []):
        meta = meta if isinstance(meta, dict) else {}
        kw = re.sub(r"[^A-Za-z0-9_-]", "", str(meta.get("comment_keyword") or ""))[:30].upper()
        hooks = _read(OUT / tool_id / "hooks.json")
        name = hooks.get("tool") or tool_id
        has_html = (OUT / tool_id / "lead_magnet.html").is_file()
        dest = ("checkout: " + meta["checkout_url"]) if meta.get("checkout_url") else (
            "lead magnet page" if has_html else "Library (no lead magnet yet)")
        pdf = f"{base}/out/{tool_id}/lead_magnet.pdf" if (OUT / tool_id / "lead_magnet.pdf").is_file() else "not generated yet"
        rows.append(f"| {name} | `{tool_id}` | {('`' + kw + '`') if kw else 'none set'} | "
                    f"{(base + '/go/' + kw) if kw else 'set a keyword first'} | "
                    f"{'Paid' if meta.get('price_tier') == 'paid' else 'Free'} | {dest} | {pdf} |")
    if len(rows) == 2:
        rows.append("| (no tools in data/tools.json yet) | | | | | | |")
    return "\n".join(rows)


def _read(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write():
    load_dotenv(ROOT / ".env")
    base = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/") or "https://YOUR-APP-URL"
    block = f"{START}\n{table(base)}\n{END}"
    if DOC.is_file() and START in (text := DOC.read_text(encoding="utf-8")) and END in text:
        text = text[:text.index(START)] + block + text[text.index(END) + len(END):]
    else:
        text = GUIDE + block + "\n"
    DOC.parent.mkdir(parents=True, exist_ok=True)
    DOC.write_bytes(text.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8"))  # CRLF like the rest of the repo
    return DOC


if __name__ == "__main__":
    print(f"wrote {write()}")
    sys.exit(0)
