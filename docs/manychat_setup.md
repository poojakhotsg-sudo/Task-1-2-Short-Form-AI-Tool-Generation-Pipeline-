# ManyChat setup: comment keyword -> DM

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

<!-- tools-table:start -->
| Tool | tool_id | Keyword | Flow A link | Price | Flow A sends to | Flow B lead magnet PDF |
|---|---|---|---|---|---|---|
| Genspark | `genspark.assets` | `GUIDE` | https://YOUR-APP-URL/go/GUIDE | Free | lead magnet page | https://YOUR-APP-URL/out/genspark.assets/lead_magnet.pdf |
| Gamma | `gamma.assets` | `GAMMA` | https://YOUR-APP-URL/go/GAMMA | Paid | checkout: https://example.com/checkout/gamma-kit | https://YOUR-APP-URL/out/gamma.assets/lead_magnet.pdf |
<!-- tools-table:end -->
