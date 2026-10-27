import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storageMocks, ffmpegMocks, captionMock } = vi.hoisted(() => ({
  storageMocks: {
    listObjectsUnderPrefix: vi.fn(),
    downloadObject: vi.fn(),
    uploadObject: vi.fn(),
  },
  ffmpegMocks: {
    getClipDurationSeconds: vi.fn(),
    extractFramePng: vi.fn(),
  },
  captionMock: vi.fn(),
}));

vi.mock('../lib/storage.js', () => storageMocks);
vi.mock('../lib/ffmpeg.js', () => ffmpegMocks);
vi.mock('../services/visionCaption.js', () => ({ captionClipFrames: captionMock }));
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    mkdtemp: vi.fn().mockResolvedValue('/tmp/fake-dir'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('fake-frame')),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

import { describeClips } from '../services/describeClips.js';

const GRAB_PREFIX = 'private/tools/demo/jobs/job1/grab/';
const DESCRIBE_PREFIX = 'private/tools/demo/jobs/job1/describe/';

beforeEach(() => {
  Object.values(storageMocks).forEach((m) => m.mockReset());
  Object.values(ffmpegMocks).forEach((m) => m.mockReset());
  captionMock.mockReset();

  ffmpegMocks.getClipDurationSeconds.mockResolvedValue(10);
  ffmpegMocks.extractFramePng.mockResolvedValue(undefined);
  storageMocks.uploadObject.mockResolvedValue(undefined);
  storageMocks.downloadObject.mockImplementation((key: string) => {
    // Clip bytes download (not the catalog) — any non-empty buffer works,
    // ffmpeg/readFile are mocked anyway.
    if (key.endsWith('.mp4')) return Promise.resolve(Buffer.from('fake-clip-bytes'));
    return Promise.resolve(null); // no existing catalog by default
  });
});

describe('describeClips', () => {
  it('describes every clip found under grabStoragePrefix/clips when there is no existing catalog', async () => {
    storageMocks.listObjectsUnderPrefix.mockResolvedValue([
      { key: `${GRAB_PREFIX}clips/clip01_hero.mp4` },
      { key: `${GRAB_PREFIX}clips/clip02_features.mp4` },
    ]);
    captionMock.mockResolvedValue({ caption: 'x', tags: ['a'], has_ui: true, clip_type: 'ui' });

    const result = await describeClips(GRAB_PREFIX, DESCRIBE_PREFIX);

    expect(result.clipsDescribed).toBe(2);
    expect(result.clipsReused).toBe(0);
    expect(Object.keys(result.catalog)).toEqual(['clip01_hero.mp4', 'clip02_features.mp4']);
    expect(captionMock).toHaveBeenCalledTimes(2);

    expect(storageMocks.uploadObject).toHaveBeenCalledWith({
      key: `${DESCRIBE_PREFIX}clip_catalog.json`,
      body: JSON.stringify(result.catalog, null, 2),
      contentType: 'application/json',
    });
  });

  it('reuses an existing catalog entry instead of re-describing that clip', async () => {
    storageMocks.listObjectsUnderPrefix.mockResolvedValue([
      { key: `${GRAB_PREFIX}clips/clip01_hero.mp4` },
      { key: `${GRAB_PREFIX}clips/clip02_features.mp4` },
    ]);
    const existingEntry = { caption: 'already described', tags: ['old'], has_ui: false, clip_type: 'example_output' };
    storageMocks.downloadObject.mockImplementation((key: string) => {
      if (key.endsWith('clip_catalog.json')) {
        return Promise.resolve(Buffer.from(JSON.stringify({ 'clip01_hero.mp4': existingEntry })));
      }
      if (key.endsWith('.mp4')) return Promise.resolve(Buffer.from('fake-clip-bytes'));
      return Promise.resolve(null);
    });
    captionMock.mockResolvedValue({ caption: 'new', tags: ['b'], has_ui: true, clip_type: 'ui' });

    const result = await describeClips(GRAB_PREFIX, DESCRIBE_PREFIX);

    expect(result.clipsReused).toBe(1);
    expect(result.clipsDescribed).toBe(1);
    // The reused entry is untouched — not re-captioned.
    expect(result.catalog['clip01_hero.mp4']).toEqual(existingEntry);
    expect(result.catalog['clip02_features.mp4']).toEqual({ caption: 'new', tags: ['b'], has_ui: true, clip_type: 'ui' });
    // Only the one new clip triggered a vision call.
    expect(captionMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty catalog without error when no clips exist yet (grab has not recorded any)', async () => {
    storageMocks.listObjectsUnderPrefix.mockResolvedValue([]);

    const result = await describeClips(GRAB_PREFIX, DESCRIBE_PREFIX);

    expect(result).toEqual({ catalog: {}, clipsDescribed: 0, clipsReused: 0 });
    expect(captionMock).not.toHaveBeenCalled();
    // Still writes an (empty) catalog — idempotent, not skipped.
    expect(storageMocks.uploadObject).toHaveBeenCalledWith({
      key: `${DESCRIBE_PREFIX}clip_catalog.json`,
      body: '{}',
      contentType: 'application/json',
    });
  });

  it('treats a corrupt existing catalog as empty rather than crashing the stage', async () => {
    storageMocks.listObjectsUnderPrefix.mockResolvedValue([{ key: `${GRAB_PREFIX}clips/clip01_hero.mp4` }]);
    storageMocks.downloadObject.mockImplementation((key: string) => {
      if (key.endsWith('clip_catalog.json')) return Promise.resolve(Buffer.from('{not valid json'));
      if (key.endsWith('.mp4')) return Promise.resolve(Buffer.from('fake-clip-bytes'));
      return Promise.resolve(null);
    });
    captionMock.mockResolvedValue({ caption: 'x', tags: ['a'], has_ui: true, clip_type: 'ui' });

    const result = await describeClips(GRAB_PREFIX, DESCRIBE_PREFIX);

    expect(result.clipsDescribed).toBe(1);
    expect(result.clipsReused).toBe(0);
  });
});
