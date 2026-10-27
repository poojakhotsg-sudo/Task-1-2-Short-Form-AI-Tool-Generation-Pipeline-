# Media normalization (EXTRACT-05)

`/tasks/normalize_media`'s real implementation, ported from
`extract_assets.py`'s `normalize_video()` (lines 458-507).

## No caller yet — flagged, not hidden

Unlike every other worker task in this project, nothing calls this one
yet. `extract_media` — the Section 5 task that would actually produce
the raw video assets this normalizes — isn't implemented either (see
`server.ts`'s comment), and no reel-pipeline stage (`grab` through
`upload`) needs it: EXTRACT-05 belongs to the older `extract_assets.py`
asset-extraction tool, a different product from the 8-stage reel
pipeline this worker otherwise serves. The HTTP contract and the ffmpeg
work behind it are real and tested regardless, so whatever calls it next
gets faithful behavior instead of a placeholder.

## What this does

Given a list of object storage keys (independent of each other, no
shared storage prefix assumed):

1. Downloads each key and probes it with `ffprobe` (codec, pixel format,
   audio presence, duration — `probeVideoFull()` in `lib/ffmpeg.ts`).
2. Decides one of three actions (`decideNormalizeAction()`, pure and
   directly unit-tested):
   - **re-encode** — codec isn't `h264` or pixel format isn't
     `yuv420p`: full `ffmpeg -c:v libx264 -pix_fmt yuv420p -movflags
     +faststart` re-encode, audio dropped (`-an`) unless the key looks
     like an embedded-video download (`"embed"` in the key, or an
     `embedded` path segment — `extract_assets.py`'s own detection,
     ported against the storage key in place of a filesystem path).
   - **strip audio** — already compliant but a non-embed clip still has
     an audio track: a cheap `-c:v copy -an` stream copy, no re-encode.
   - **none** — already compliant and (embed, or no audio to begin
     with): a plain `-c copy` stream copy, so the sibling `.mp4` output
     still gets written.
3. Discards the result (`shouldDiscard()`, also pure) if it ends up
   under 50KB or shorter than 1 second — matching the source's "removed
   empty clip" behavior exactly.
4. Uploads whatever survives to a **sibling** `.mp4` key in the same
   "folder" (e.g. `.../demo.webm` -> `.../demo.mp4`) — never overwriting
   the original key, and returns that key as `mp4Key`, or `null` if the
   result was discarded.

## A real behavior difference from the source — not silent

`normalize_video()` re-encodes in place: its temp `.mp4` output gets
renamed *over the original path*, so a source `.webm` ends up holding
h264/mp4 container bytes under a `.webm` extension. That's not carried
forward. `web-next/docs/object-storage-layout.md` had already decided,
before this task existed, that `assets.mp4_storage_key` is "the sibling
key in the same folder with a `.mp4` extension" — i.e. a separate,
correctly-named copy, not an overwrite. This port follows that: the
original key is never touched, and the normalized result always lands
at its own `.mp4` key.

One minor inefficiency that follows from always writing a sibling
output, even on the `'none'` action: a clip that was already fully
compliant still gets one wasted `-c copy` ffmpeg invocation (cheap, but
not free) instead of the route recognizing "nothing to do, point
`mp4Key` at the same key" and skipping ffmpeg entirely. Not fixed in
this pass — there's no real caller yet to make that optimization worth
the added branching, and it doesn't change correctness.

`extract_assets.py`'s `normalize_folder()` (the batch/manifest-rewriting
wrapper around `normalize_video()`) is NOT ported — it walks a
filesystem folder and rewrites a `manifest.json`'s `items`/`library`
list in place, a convention this storage-based architecture doesn't
have (object-storage-layout.md already routes "update
`assets.mp4_storage_key`" through the web-next DB layer, not a shared
manifest file). This task's response gives the caller everything
`normalize_folder()` would have needed to do that DB update itself.

## Test coverage

- `normalizeMedia.pure.test.ts` — `decideNormalizeAction()`/
  `shouldDiscard()` against synthetic facts: the codec/pix_fmt check
  (case-insensitively), the embed-vs-non-embed audio branching, and the
  50KB/1s discard boundaries.
- `normalizeMedia.ffmpeg.test.ts` — `normalizeVideoFile()` against real
  `ffmpeg`: a non-h264 source actually ends up h264/yuv420p, an
  already-compliant clip with audio actually loses it (non-embed) or
  keeps it (embed), and a sub-1-second clip is correctly reported
  `kept: false`. Skips cleanly if `ffmpeg` isn't on `PATH`.
- `normalizeMedia.route.test.ts` — the HTTP layer with the service and
  storage mocked: request validation, the sibling-`.mp4`-key naming,
  skipping the upload for a discarded clip, and that one key's download
  failure or normalization error doesn't abort the rest of the batch.
