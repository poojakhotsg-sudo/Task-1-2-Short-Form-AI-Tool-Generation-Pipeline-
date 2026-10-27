import express from 'express';
import { requireWorkerAuth } from './auth.js';
import { handleCaptureSite } from './routes/tasks/captureSite.js';
import { handleDescribeClips } from './routes/tasks/describeClips.js';
import { handleRunQa } from './routes/tasks/runQa.js';
import { handleAssembleRoughCut } from './routes/tasks/assembleRoughCut.js';
import { handleFetchSiteText } from './routes/tasks/fetchSiteText.js';
import { handleRecordMissingShotClips } from './routes/tasks/recordMissingShotClips.js';
import { handleNormalizeMedia } from './routes/tasks/normalizeMedia.js';
import { handleExtractMedia } from './routes/tasks/extractMedia.js';

const app = express();
app.use(express.json({ limit: '1mb' })); // task payloads are small — job IDs, URLs, storage prefixes, never media bytes (Section 2.1)

// GET /health — matches the source app's PLAT-05 health-check convention.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/tasks/capture_site', requireWorkerAuth, handleCaptureSite);
app.post('/tasks/describe_clips', requireWorkerAuth, handleDescribeClips);
app.post('/tasks/run_qa', requireWorkerAuth, handleRunQa);
app.post('/tasks/assemble_rough_cut', requireWorkerAuth, handleAssembleRoughCut);
app.post('/tasks/fetch_site_text', requireWorkerAuth, handleFetchSiteText);
app.post('/tasks/record_missing_shot_clips', requireWorkerAuth, handleRecordMissingShotClips);
app.post('/tasks/normalize_media', requireWorkerAuth, handleNormalizeMedia);
app.post('/tasks/extract_media', requireWorkerAuth, handleExtractMedia);

// Other Section 5 worker tasks (create_zip, upload_drive,
// record_trial_steps) are not yet implemented — deliberately not
// registering placeholder routes for them, so a request to one 404s
// honestly instead of returning a fake 200. extract_media is real as of
// this pass (first installment — see extractMedia.ts's file-level
// comment for what's covered and what's deliberately deferred), and it
// now gives normalize_media a real caller for the reencoded-video path;
// normalize_media's sibling-.mp4-key behavior for images/animated/raw
// files that extract_media uploads as-is is unaffected.
//
// 'record_section', also in that original list, is NOT one of these —
// it's already covered. grabber.py has no function literally named
// record_section; the actual per-section recording logic (record_shot()
// choreography, called once per page section inside _record_library()'s
// pass 1) is exactly what capture_site's own loop does (see
// captureSite.ts, which calls recordShot.ts's recordShot() once per
// picked section). There is no separate per-section HTTP task to add —
// confirmed by reading grabber.py, not assumed from the task's name.

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`reel-pipeline-worker listening on :${PORT}`);
});
