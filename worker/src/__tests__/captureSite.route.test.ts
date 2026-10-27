import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { captureSiteMock, uploadObjectMock } = vi.hoisted(() => ({
  captureSiteMock: vi.fn(),
  uploadObjectMock: vi.fn(),
}));

vi.mock('../services/captureSite.js', () => ({ captureSite: captureSiteMock }));
vi.mock('../lib/storage.js', () => ({ uploadObject: uploadObjectMock }));

import { handleCaptureSite } from '../routes/tasks/captureSite.js';

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
  storagePrefix: 'private/tools/demo/jobs/job1/grab/',
};

const SITE_DATA = {
  title: 'Demo',
  description: '',
  h1: ['Hello'],
  h2: [],
  features: [],
  videos: [],
  embeds: [],
  images: [],
};

function emptyCapture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    heroPng: Buffer.from('fake-png'),
    siteData: SITE_DATA,
    clips: [],
    clipErrors: [],
    clipsRecorded: 0,
    ...overrides,
  };
}

beforeEach(() => {
  captureSiteMock.mockReset();
  uploadObjectMock.mockReset();
  uploadObjectMock.mockResolvedValue(undefined);
});

describe('handleCaptureSite', () => {
  it('rejects an invalid request body with 400 before calling the capture service at all', async () => {
    const { req, res, status, json } = fakeReqRes({ jobId: 'job1' }); // missing url, toolSlug, storagePrefix

    await handleCaptureSite(req, res);

    expect(captureSiteMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('uploads the hero screenshot, site data, and an empty library.json when no clips were recorded', async () => {
    captureSiteMock.mockResolvedValue(emptyCapture());

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleCaptureSite(req, res);

    expect(captureSiteMock).toHaveBeenCalledWith('https://example.com', { headed: false });

    expect(uploadObjectMock).toHaveBeenCalledWith({
      key: 'private/tools/demo/jobs/job1/grab/hero.png',
      body: expect.any(Buffer),
      contentType: 'image/png',
    });
    expect(uploadObjectMock).toHaveBeenCalledWith({
      key: 'private/tools/demo/jobs/job1/grab/site_data.json',
      body: JSON.stringify(SITE_DATA, null, 2),
      contentType: 'application/json',
    });
    expect(uploadObjectMock).toHaveBeenCalledWith({
      key: 'private/tools/demo/jobs/job1/grab/library.json',
      body: '[]',
      contentType: 'application/json',
    });

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ok', data: expect.objectContaining({ clipsRecorded: 0 }) })
    );
  });

  it('uploads each recorded clip under clips/<file> and includes its QA result in library.json', async () => {
    captureSiteMock.mockResolvedValue(
      emptyCapture({
        clips: [
          {
            file: 'clip01_hero.mp4',
            content: Buffer.from('fake-mp4'),
            section: 'Hero',
            text: 'hero text',
            y: 0,
            h: 500,
            hasVideo: false,
            seconds: 8.5,
            qa: 'pass',
            qaReasons: [],
            qaMetrics: { seconds: 8.5, size: '1080x1920', sharpness: 1000, motion: 2 },
            retried: false,
          },
        ],
        clipsRecorded: 1,
      })
    );

    const { req, res, json } = fakeReqRes(VALID_BODY);
    await handleCaptureSite(req, res);

    expect(uploadObjectMock).toHaveBeenCalledWith({
      key: 'private/tools/demo/jobs/job1/grab/clips/clip01_hero.mp4',
      body: expect.any(Buffer),
      contentType: 'video/mp4',
    });

    const libraryCall = uploadObjectMock.mock.calls.find(
      (call) => call[0].key === 'private/tools/demo/jobs/job1/grab/library.json'
    );
    const library = JSON.parse(libraryCall![0].body);
    expect(library).toEqual([
      {
        file: 'clips/clip01_hero.mp4',
        section: 'Hero',
        text: 'hero text',
        y: 0,
        h: 500,
        hasVideo: false,
        seconds: 8.5,
        qa: 'pass',
        qaReasons: [],
        retried: false,
      },
    ]);

    const [response] = json.mock.calls[0];
    expect(response.data.qaPassCount).toBe(1);
  });

  it('reports a retried, still-failing clip accurately in library.json and qaPassCount', async () => {
    captureSiteMock.mockResolvedValue(
      emptyCapture({
        clips: [
          {
            file: 'clip02_pricing.mp4',
            content: Buffer.from('fake-mp4'),
            section: 'Pricing',
            text: 'pricing text',
            y: 500,
            h: 400,
            hasVideo: false,
            seconds: 9.0,
            qa: 'fail',
            qaReasons: ['mostly static (7/11 frame pairs unchanged)', 'still static after a retry'],
            qaMetrics: { seconds: 9.0, size: '1080x1920', sharpness: 1000, motion: 0.3 },
            retried: true,
          },
        ],
        clipsRecorded: 1,
      })
    );

    const { req, res, json } = fakeReqRes(VALID_BODY);
    await handleCaptureSite(req, res);

    const [response] = json.mock.calls[0];
    expect(response.data.qaPassCount).toBe(0);
    expect(response.message).toMatch(/0\/1 passed QA/);

    const libraryCall = uploadObjectMock.mock.calls.find(
      (call) => call[0].key === 'private/tools/demo/jobs/job1/grab/library.json'
    );
    const library = JSON.parse(libraryCall![0].body);
    expect(library[0].retried).toBe(true);
    expect(library[0].qaReasons).toContain('still static after a retry');
  });

  it('reports per-section recording failures in the response message without failing the whole request', async () => {
    captureSiteMock.mockResolvedValue(
      emptyCapture({ clipErrors: [{ section: 'Pricing', error: 'recording failed' }] })
    );

    const { req, res, json } = fakeReqRes(VALID_BODY);
    await handleCaptureSite(req, res);

    const [response] = json.mock.calls[0];
    expect(response.status).toBe('ok');
    expect(response.message).toMatch(/1 section\(s\) failed to record \(Pricing\)/);
    expect(response.data.clipErrors).toEqual([{ section: 'Pricing', error: 'recording failed' }]);
  });

  it('returns 502 with status "error" when the capture service throws', async () => {
    captureSiteMock.mockRejectedValue(new Error('navigation timeout'));

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleCaptureSite(req, res);

    expect(uploadObjectMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({ status: 'error', message: 'navigation timeout' });
  });

  it('passes headed:true through when the request asks for it', async () => {
    captureSiteMock.mockResolvedValue(emptyCapture());

    const { req, res } = fakeReqRes({ ...VALID_BODY, headed: true });
    await handleCaptureSite(req, res);

    expect(captureSiteMock).toHaveBeenCalledWith('https://example.com', { headed: true });
  });
});
