import { callWorkerTask } from '@/lib/workerClient';
import { downloadObjectText, uploadObjectJson, uploadObjectText } from '@/lib/objectStorage';
import type { StageExecutor } from './types';
import { stageStoragePrefix } from './types';
import { generateReel } from './script/generateReel';
import { renderScript } from './script/renderScript';

// PIPE-04, ported from pipeline/script_gen.py's generate() (lines
// 344-381). Two parts: fetch_site_text() is real Playwright browser
// automation, delegated to the worker (same discovery pattern as
// match.ts's record_missing_shot_clips); the rest — the Claude/Groq
// prompt, validation, and retry logic — is pure LLM orchestration that
// belongs here, ported into generateReel.ts/validateReel.ts/
// renderScript.ts.
export const runScriptStage: StageExecutor = async (ctx) => {
  const describePrefix = stageStoragePrefix(ctx, 'describe');
  const scriptPrefix = stageStoragePrefix(ctx, 'script');

  const catalogText = await downloadObjectText(`${describePrefix}clip_catalog.json`);
  let clipCatalog: unknown[] = [];
  if (catalogText) {
    try {
      const parsed = JSON.parse(catalogText);
      clipCatalog = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([file, entry]) => ({ file, ...(entry as object) }));
    } catch {
      clipCatalog = []; // matches generate()'s bare except around a corrupt catalog read
    }
  }

  const fetchResult = await callWorkerTask('fetch_site_text', {
    jobId: ctx.jobId,
    toolSlug: ctx.toolSlug,
    url: ctx.url,
    storagePrefix: scriptPrefix,
  });
  if (fetchResult.status === 'error') {
    throw new Error(fetchResult.message || 'fetch_site_text failed');
  }

  const siteText = (await downloadObjectText(`${scriptPrefix}site_text.txt`)) || '';
  if (siteText.length < 200) {
    throw new Error(
      `only got ${siteText.length} characters of text from ${ctx.url}; the site may be blocking bots`
    );
  }

  const reel = await generateReel(ctx.toolName, ctx.url, siteText, clipCatalog);

  await uploadObjectText(`${scriptPrefix}script.txt`, renderScript(ctx.toolName, ctx.url, reel), 'text/plain');
  await uploadObjectJson(`${scriptPrefix}shot_list.json`, reel.shots);

  const trial = reel.shots.filter((s) => s.source === 'trial').map((s) => s.shot);
  const total = reel.shots.reduce((sum, s) => sum + s.duration_seconds, 0);

  return {
    message: `angle: ${reel.angle} | ${reel.shots.length} shots | ${total}s | trial shots: ${trial.length ? trial.join(', ') : 'none'}`,
    data: { angle: reel.angle, shotCount: reel.shots.length, totalSeconds: total, trialShots: trial },
  };
};
