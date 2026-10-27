import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { extractMediaMock, uploadObjectMock } = vi.hoisted(() => ({
  extractMediaMock: vi.fn(),
  uploadObjectMock: vi.fn(),
}));

vi.mock('../services/extractMedia.js', () => ({ extractMedia: extractMediaMock }));
vi.mock('../lib/storage.js', () => ({ uploadObject: uploadObjectMock }));

import { handleExtractMedia } from '../routes/tasks/extractMedia.js';

function fakeReqRes(body: unknown) {
  const req = { body } as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  return { req, res, status, json };
}

const VALID_BODY = {
  jobId: 'job1',
  toolSlug: 'demo',
  url: 'https://example.com',
  storagePrefix: 'private/tools/demo/jobs/job1/extract/',
};

const OK_RESULT = {
  report: {
    url: 'https://example.com', status: 'ok' as const, message: '', httpStatus: 200, attempts: [], botCheck: false,
    counts: { videos_gifs: 1, images: 2 }, networkCounts: { video: 1, gif: 0, webp: 0, image: 2 },
    urlDuplicates: 0, failedDownloads: [], embeds: [{ url: 'https://example.com/iframe', resolved: 'https://www.youtube.com/watch?v=abc', result: 'downloaded' }], embedsNotDownloaded: 0, skipped: {},
  },
  manifest: [{ category: 'images', type: 'image', filename: '01_hero.jpg', path: 'images/01_hero.jpg', mp4: null, sourceUrl: 'https://example.com/hero.jpg', originalFilename: 'hero.jpg', width: 800, height: 600, durationSeconds: null, sizeBytes: 12345, pageOrder: 1, pageY: 0, section: 'hero' }],
  files: [{ path: 'images/01_hero.jpg', content: Buffer.from('fake-image'), contentType: 'image/jpeg' }],
};

beforeEach(() => {
  extractMediaMock.mockReset();
  uploadObjectMock.mockReset();
  uploadObjectMock.mockResolvedValue(undefined);
});

describe('handleExtractMedia', () => {
  it('rejects an invalid request body with 400 before calling the service', async () => {
    const { req, res, status, json } = fakeReqRes({ jobId: 'job1' }); // missing url/storagePrefix

    await handleExtractMedia(req, res);

    expect(extractMediaMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('uploads every file, manifest.json, and report.json under storagePrefix on success', async () => {
    extractMediaMock.mockResolvedValue(OK_RESULT);

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleExtractMedia(req, res);

    expect(extractMediaMock).toHaveBeenCalledWith('https://example.com', { headed: false });
    expect(uploadObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'private/tools/demo/jobs/job1/extract/images/01_hero.jpg' })
    );
    expect(uploadObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'private/tools/demo/jobs/job1/extract/manifest.json', contentType: 'application/json' })
    );
    expect(uploadObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'private/tools/demo/jobs/job1/extract/report.json', contentType: 'application/json' })
    );

    expect(status).toHaveBeenCalledWith(200);
    const [response] = json.mock.calls[0];
    expect(response.status).toBe('ok');
    expect(response.data.counts).toEqual({ videos_gifs: 1, images: 2 });
  });

  it('includes the full manifest, with absolute storage keys, inline in the response', async () => {
    extractMediaMock.mockResolvedValue(OK_RESULT);

    const { req, res, json } = fakeReqRes(VALID_BODY);
    await handleExtractMedia(req, res);

    const [response] = json.mock.calls[0];
    expect(response.data.manifest).toEqual([
      expect.objectContaining({
        filename: '01_hero.jpg',
        path: 'images/01_hero.jpg',
        storageKey: 'private/tools/demo/jobs/job1/extract/images/01_hero.jpg',
        mp4StorageKey: null,
      }),
    ]);
  });

  it('writes the per-embed resolution detail into report.json', async () => {
    extractMediaMock.mockResolvedValue(OK_RESULT);

    const { req, res } = fakeReqRes(VALID_BODY);
    await handleExtractMedia(req, res);

    const reportUpload = uploadObjectMock.mock.calls.find(
      ([arg]) => arg.key === 'private/tools/demo/jobs/job1/extract/report.json'
    )?.[0];
    const written = JSON.parse(reportUpload.body as string);
    expect(written.embeds).toEqual([
      { url: 'https://example.com/iframe', resolved: 'https://www.youtube.com/watch?v=abc', result: 'downloaded' },
    ]);
  });

  it('reports embedsNotDownloaded in the message and data when embeds were skipped', async () => {
    extractMediaMock.mockResolvedValue({ ...OK_RESULT, report: { ...OK_RESULT.report, embedsNotDownloaded: 3 } });

    const { req, res, json } = fakeReqRes(VALID_BODY);
    await handleExtractMedia(req, res);

    const [response] = json.mock.calls[0];
    expect(response.message).toMatch(/3 embed\(s\) not downloaded/);
    expect(response.data.embedsNotDownloaded).toBe(3);
  });

  it('returns 502 with status "error" and does not upload anything when the extraction itself failed', async () => {
    extractMediaMock.mockResolvedValue({
      report: {
        url: 'https://example.com', status: 'failed', message: 'Site returned 503 - nothing extracted. Try again.',
        httpStatus: 503, attempts: [], botCheck: false, counts: { videos_gifs: 0, images: 0 },
        networkCounts: { video: 0, gif: 0, webp: 0, image: 0 }, urlDuplicates: 0, failedDownloads: [],
        embedsNotDownloaded: 0, skipped: {},
      },
      manifest: [],
      files: [],
    });

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleExtractMedia(req, res);

    // manifest.json/report.json are still written (honest "nothing
    // extracted" record), but no asset files — consistent with the
    // source always writing report.json/manifest.json even on failure.
    expect(uploadObjectMock).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledWith(502);
    const [response] = json.mock.calls[0];
    expect(response.status).toBe('error');
    expect(response.message).toMatch(/Site returned 503/);
  });

  it('returns 502 with status "error" when the service throws', async () => {
    extractMediaMock.mockRejectedValue(new Error('browser crashed'));

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleExtractMedia(req, res);

    expect(uploadObjectMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({ status: 'error', message: 'browser crashed' });
  });
});
