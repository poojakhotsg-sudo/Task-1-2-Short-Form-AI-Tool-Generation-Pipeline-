import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { normalizeMock, downloadObjectMock, uploadObjectMock } = vi.hoisted(() => ({
  normalizeMock: vi.fn(),
  downloadObjectMock: vi.fn(),
  uploadObjectMock: vi.fn(),
}));

vi.mock('../services/normalizeMedia.js', () => ({ normalizeVideoFile: normalizeMock }));
vi.mock('../lib/storage.js', () => ({ downloadObject: downloadObjectMock, uploadObject: uploadObjectMock }));

// The route reads the normalized output back off disk before uploading
// it — normalizeVideoFile is mocked above and never actually writes
// that file, so fs/promises is mocked too (mkdtemp/writeFile/rm are
// no-ops; readFile hands back a fixed buffer), matching this project's
// convention of mocking filesystem/ffmpeg entirely in route tests.
vi.mock('fs/promises', () => ({
  mkdtemp: vi.fn().mockResolvedValue('/tmp/normalize-media-test'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from('normalized-output-bytes')),
  rm: vi.fn().mockResolvedValue(undefined),
}));

import { handleNormalizeMedia } from '../routes/tasks/normalizeMedia.js';

function fakeReqRes(body: unknown) {
  const req = { body } as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  return { req, res, status, json };
}

beforeEach(() => {
  normalizeMock.mockReset();
  downloadObjectMock.mockReset();
  uploadObjectMock.mockReset();
  downloadObjectMock.mockResolvedValue(Buffer.from('fake-video-bytes'));
  uploadObjectMock.mockResolvedValue(undefined);
});

describe('handleNormalizeMedia', () => {
  it('rejects an invalid request body with 400 before touching storage', async () => {
    const { req, res, status, json } = fakeReqRes({ jobId: 'job1' }); // no keys

    await handleNormalizeMedia(req, res);

    expect(downloadObjectMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('uploads the normalized result to a sibling .mp4 key and reports its facts', async () => {
    normalizeMock.mockResolvedValue({
      kept: true,
      action: 'reencode',
      sizeBytes: 123456,
      facts: { width: 1080, height: 1920, codec: 'h264', pixFmt: 'yuv420p', durationSeconds: 5.2, hasAudio: false },
    });

    const { req, res, status, json } = fakeReqRes({
      jobId: 'job1',
      toolSlug: 'demo',
      keys: ['private/tools/demo/jobs/job1/extract/videos_gifs/demo.webm'],
    });
    await handleNormalizeMedia(req, res);

    expect(uploadObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'private/tools/demo/jobs/job1/extract/videos_gifs/demo.mp4', contentType: 'video/mp4' })
    );
    expect(status).toHaveBeenCalledWith(200);
    const [response] = json.mock.calls[0];
    expect(response.data.results[0]).toMatchObject({
      key: 'private/tools/demo/jobs/job1/extract/videos_gifs/demo.webm',
      mp4Key: 'private/tools/demo/jobs/job1/extract/videos_gifs/demo.mp4',
      kept: true,
      action: 'reencode',
      codec: 'h264',
    });
    expect(response.data.keptCount).toBe(1);
  });

  it('does not upload anything, and reports mp4Key null, for a clip discarded as too small/short', async () => {
    normalizeMock.mockResolvedValue({
      kept: false,
      action: 'reencode',
      sizeBytes: 1024,
      facts: { width: 10, height: 10, codec: 'h264', pixFmt: 'yuv420p', durationSeconds: 0.2, hasAudio: false },
    });

    const { req, res, json } = fakeReqRes({ jobId: 'job1', toolSlug: 'demo', keys: ['a/b/tiny.mp4'] });
    await handleNormalizeMedia(req, res);

    expect(uploadObjectMock).not.toHaveBeenCalled();
    const [response] = json.mock.calls[0];
    expect(response.data.results[0]).toMatchObject({ mp4Key: null, kept: false });
    expect(response.data.discardedCount).toBe(1);
  });

  it('reports a per-key error without aborting the rest of the batch when one key is missing', async () => {
    downloadObjectMock.mockResolvedValueOnce(null).mockResolvedValueOnce(Buffer.from('bytes'));
    normalizeMock.mockResolvedValue({
      kept: true,
      action: 'none',
      sizeBytes: 200000,
      facts: { width: 1080, height: 1920, codec: 'h264', pixFmt: 'yuv420p', durationSeconds: 5, hasAudio: false },
    });

    const { req, res, json } = fakeReqRes({ jobId: 'job1', toolSlug: 'demo', keys: ['missing.mp4', 'present.mp4'] });
    await handleNormalizeMedia(req, res);

    const [response] = json.mock.calls[0];
    expect(response.data.results[0]).toMatchObject({ key: 'missing.mp4', kept: false, error: 'object not found' });
    expect(response.data.results[1]).toMatchObject({ key: 'present.mp4', kept: true });
    expect(normalizeMock).toHaveBeenCalledTimes(1); // never called for the missing key
  });

  it('reports a per-key error when normalization itself throws, without aborting the batch', async () => {
    normalizeMock.mockRejectedValue(new Error('ffmpeg exploded'));

    const { req, res, json } = fakeReqRes({ jobId: 'job1', toolSlug: 'demo', keys: ['a.mp4'] });
    await handleNormalizeMedia(req, res);

    expect(uploadObjectMock).not.toHaveBeenCalled();
    const [response] = json.mock.calls[0];
    expect(response.status).toBe('ok'); // the task itself succeeded; this one key failed
    expect(response.data.results[0]).toMatchObject({ kept: false, error: 'ffmpeg exploded' });
  });
});
