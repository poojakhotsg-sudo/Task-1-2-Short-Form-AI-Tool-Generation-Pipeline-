# Site-text fetching (PIPE-04 prerequisite)

`/tasks/fetch_site_text`'s real implementation, ported from
`pipeline/script_gen.py`'s `fetch_site_text()`/`_load()`/`_embed_info()`
(`worker/src/services/siteText.ts`).

## Why this is a worker task at all

PIPE-04 ("script generation") reads in `requirement.md` as a pure
LLM-prompt stage, and `web-next/src/inngest/stages/script.ts` was
originally stubbed on that assumption. Reading `script_gen.py` in full
showed it first does its own Playwright browser pass — separate from
`capture_site`'s — to collect the site text and embedded-demo-video
description that get fed into the prompt. That's real browser
automation, not something safe to run inside the Next.js app (Section
2.1), so it needed the same kind of worker delegation `match.ts` needed
for `record_missing_shot_clips`.

## What this does

1. Loads the home page (`domcontentloaded`, then up to 10s of
   `networkidle`, then a fixed 1.5s settle), dismisses cookie popups,
   and does a scroll pass so lazy-loaded sections render their text.
2. If the page looks like a bot-check page (title/meta/body text
   matching "just a moment" / "verify you are human" / "checking your
   browser"), waits 8s and re-reads the text — giving the check a chance
   to clear, matching the source exactly.
3. Pulls the title + description of any embedded YouTube/Vimeo/Wistia/
   Loom iframe via `yt-dlp`, gracefully degrading to `''` if `yt-dlp`
   is missing, times out, or fails — a missing embed description never
   fails the whole fetch.
4. Follows up to 2 same-host subpages whose URL matches
   `feature|product|how-it-works|use-case|solutions|examples|showcase`,
   loading each the same way as the home page. A subpage that throws is
   skipped, not fatal.
5. Joins everything with `=== <url>` headers, collapses blank lines, and
   truncates to 40,000 characters.

Uploads the result to `<storagePrefix>site_text.txt` and returns its key
and length — `web-next/src/inngest/stages/script.ts` downloads it from
there rather than carrying the text through the HTTP response body.

## Test coverage

- `fetchSiteText.route.test.ts` — the HTTP layer with the service mocked:
  request validation, the `siteTextKey`/`length` response shape, the
  honest "No site text could be extracted" message on an empty result,
  and error-path status codes.

`siteText.ts` itself has no dedicated unit test in this pass — like
`captureSite.ts`, it's real Playwright browser automation with no local
fixture site to drive it against; its HTTP contract is what's tested.
