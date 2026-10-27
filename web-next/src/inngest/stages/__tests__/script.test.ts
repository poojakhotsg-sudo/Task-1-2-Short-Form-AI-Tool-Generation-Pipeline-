import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeStorageBucket, createFakeSupabaseClient, createFakeDb, setFakeBucketObject, type FakeBucket } from '@/test/fakeSupabase';

let privateBucket: FakeBucket;

vi.mock('@/lib/supabase', () => ({
  getSupabaseServerClient: () => createFakeSupabaseClient(createFakeDb(), { 'reel-private': privateBucket }),
}));

const { callWorkerTaskMock, generateReelMock } = vi.hoisted(() => ({
  callWorkerTaskMock: vi.fn(),
  generateReelMock: vi.fn(),
}));

vi.mock('@/lib/workerClient', () => ({ callWorkerTask: callWorkerTaskMock }));
vi.mock('@/inngest/stages/script/generateReel', () => ({ generateReel: generateReelMock }));

import { runScriptStage } from '@/inngest/stages/script';

const CTX = { jobId: 'job1', toolSlug: 'demo', toolName: 'Demo', url: 'https://example.com' };
const DESCRIBE_PREFIX = 'private/tools/demo/jobs/job1/describe/';
const SCRIPT_PREFIX = 'private/tools/demo/jobs/job1/script/';

const VALID_REEL = {
  angle: 'use_case',
  angle_summary: 'shows the export flow',
  shots: [
    { shot: 1, time: '', duration_seconds: 10, script_line: 'Hook', clip_file: 'hook.mp4', source: 'website', visual_needed: 'hook', trial_steps: [] },
    { shot: 2, time: '', duration_seconds: 15, script_line: 'Body', clip_file: 'body.mp4', source: 'website', visual_needed: 'body', trial_steps: [] },
    { shot: 3, time: '', duration_seconds: 10, script_line: 'CTA', clip_file: 'cta.mp4', source: 'website', visual_needed: 'cta', trial_steps: [] },
  ],
};

function seedSiteText(text: string) {
  setFakeBucketObject(privateBucket, `${SCRIPT_PREFIX}site_text.txt`, {
    updatedAt: new Date().toISOString(),
    content: text,
  });
}

beforeEach(() => {
  process.env.OBJECT_STORAGE_PRIVATE_BUCKET = 'reel-private';
  privateBucket = createFakeStorageBucket();
  callWorkerTaskMock.mockReset();
  generateReelMock.mockReset();

  callWorkerTaskMock.mockImplementation(async () => {
    seedSiteText('a'.repeat(300));
    return { status: 'ok', message: 'fetched site text' };
  });
  generateReelMock.mockResolvedValue(VALID_REEL);
});

describe('runScriptStage', () => {
  it('calls fetch_site_text with the script storage prefix, then generates and writes the reel', async () => {
    const result = await runScriptStage(CTX);

    expect(callWorkerTaskMock).toHaveBeenCalledWith('fetch_site_text', {
      jobId: 'job1',
      toolSlug: 'demo',
      url: 'https://example.com',
      storagePrefix: SCRIPT_PREFIX,
    });

    expect(generateReelMock).toHaveBeenCalledWith('Demo', 'https://example.com', 'a'.repeat(300), []);

    const scriptTxt = privateBucket.get(`${SCRIPT_PREFIX}script.txt`)?.content;
    expect(scriptTxt).toMatch(/DEMO - 35s reel script/);

    const shotList = JSON.parse(privateBucket.get(`${SCRIPT_PREFIX}shot_list.json`)!.content!);
    expect(shotList).toHaveLength(3);

    expect(result.message).toMatch(/angle: use_case/);
    expect(result.data).toMatchObject({ angle: 'use_case', shotCount: 3, totalSeconds: 35 });
  });

  it('passes the clip catalog array form through to generateReel unchanged', async () => {
    setFakeBucketObject(privateBucket, `${DESCRIBE_PREFIX}clip_catalog.json`, {
      updatedAt: new Date().toISOString(),
      content: JSON.stringify({ 'hero.mp4': { caption: 'c', tags: [], has_ui: true, clip_type: 'ui' } }),
    });

    await runScriptStage(CTX);

    expect(generateReelMock).toHaveBeenCalledWith(
      'Demo',
      'https://example.com',
      expect.any(String),
      [{ file: 'hero.mp4', caption: 'c', tags: [], has_ui: true, clip_type: 'ui' }]
    );
  });

  it('treats a missing clip_catalog.json as an empty catalog rather than erroring', async () => {
    await runScriptStage(CTX);
    expect(generateReelMock).toHaveBeenCalledWith('Demo', 'https://example.com', expect.any(String), []);
  });

  it('throws when fetch_site_text fails', async () => {
    callWorkerTaskMock.mockResolvedValue({ status: 'error', message: 'browser crashed' });

    await expect(runScriptStage(CTX)).rejects.toThrow(/browser crashed/);
    expect(generateReelMock).not.toHaveBeenCalled();
  });

  it('throws when the fetched site text is too short, matching the bot-blocking heuristic', async () => {
    callWorkerTaskMock.mockImplementation(async () => {
      seedSiteText('too short');
      return { status: 'ok', message: 'fetched' };
    });

    await expect(runScriptStage(CTX)).rejects.toThrow(/may be blocking bots/);
    expect(generateReelMock).not.toHaveBeenCalled();
  });

  it('lists trial shot numbers in the summary message when present', async () => {
    generateReelMock.mockResolvedValue({
      ...VALID_REEL,
      shots: [
        VALID_REEL.shots[0],
        { ...VALID_REEL.shots[1], source: 'trial', clip_file: null },
        VALID_REEL.shots[2],
      ],
    });

    const result = await runScriptStage(CTX);
    expect(result.message).toMatch(/trial shots: 2/);
  });
});
