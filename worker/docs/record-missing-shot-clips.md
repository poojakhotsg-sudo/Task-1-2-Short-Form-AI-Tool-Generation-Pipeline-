# Per-shot mobile recording fallback (PIPE-05)

`/tasks/record_missing_shot_clips`'s real implementation, ported from
`pipeline/grabber.py`'s `record_missing_shot_clips()` (lines 1471-1535),
called by `web-next/src/inngest/stages/match.ts` for any website-sourced
shot that Rules 1/1b/2 couldn't match to an existing clip.

## What this does

For each shot the caller passes in (web-next sends only genuinely
still-unmatched shots, mirroring `matcher.py`'s `pending` list):

1. Opens one mobile-viewport (390x844, iPhone 14 emulation) Playwright
   session with context-wide video recording — the same device/session
   shape `capture_site` uses.
2. Reads every visible heading on the page (`HEADINGS_JS`) and picks the
   one each shot's `visual_needed` text is talking about
   (`headingMatch.ts`'s `matchHeading()`): a quoted phrase wins if a
   heading contains it, otherwise the heading sharing the longest run of
   3+ consecutive words.
3. For each matched heading, scrolls to it, hovers, and drifts
   (`recordShot()` — the same choreography `capture_site` uses for its
   generic sections) for 6 seconds (`grabber.py`'s default for this
   function, shorter than `capture_site`'s 9s).
4. Cuts each recorded segment into its own 1080x1920 clip, named
   `shot<NN>_<slug>.mp4` (`shotClipName()` — the exact deterministic name
   `match.ts`'s Rule 1b already checks for), and runs it through the same
   QA check `capture_site`'s clips get.
5. Uploads successful clips to `<storagePrefix>clips/<name>.mp4` and
   returns, per shot, whether it got a file and why not if it didn't.

## A real bug this does NOT carry forward

`grabber.py`'s `_find_shot_sections()` only attempts heading-matching for
a shot whose dict has `"status": "pending"` — a field only
`_shot_entries()` (used by `grab()`'s own shot-list path) ever sets.
`matcher.py`'s `build_shots()`, the only thing that actually constructs
the shot dicts passed into `record_missing_shot_clips()` in production,
never sets that field. So in the source, every call from `match()` finds
headings for zero shots and this function silently degrades to "mark
everything missing" — identical to not calling it at all, just with a
wasted browser session first. Confirmed by reading both files together,
not assumed from either one alone.

That's a latent bug in how these two files are paired, not a deliberate
design choice — the whole point of this function is to find real
footage for a shot nothing else matched. This port fixes it by always
attempting heading-matching for every shot the caller sends (the same
set `matcher.py`'s `pending` list would have contained), restoring the
function's documented behavior instead of faithfully reproducing a bug
that makes the capability the user asked to port never do anything.

## Test coverage

- `headingMatch.test.ts` — pure unit tests of `matchHeading()`: quoted-
  phrase priority, the 3+-consecutive-word run requirement (and the
  shorter-heading exception), no-match honesty, and the
  higher-on-the-page tiebreaker.
- `pageSections.test.ts` — extended with `shotClipName()` tests: the
  `shot<NN>_<slug>.mp4` naming, the `"clip"` fallback for an unusable or
  empty `visualNeeded`, and the 32-character slug truncation.
- `recordMissingShotClips.route.test.ts` — the HTTP layer with the
  service mocked: request validation, uploading a recorded clip under
  `storagePrefix/clips/`, leaving a missing shot's `file` null without
  uploading anything, the "no pending shots" honesty message, and
  error-path status codes.

`recordMissingShotClips.ts` itself has no dedicated unit test in this
pass — same as `captureSite.ts` and `siteText.ts`, it's real Playwright
browser automation with no local fixture site to drive it against; its
HTTP contract and the pure heading-matching/naming logic it calls into
are what's tested.
