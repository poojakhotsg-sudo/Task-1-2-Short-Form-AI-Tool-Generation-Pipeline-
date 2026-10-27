import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { describeClipsMock } = vi.hoisted(() => ({ describeClipsMock: vi.fn() }));

vi.mock('../services/describeClips.js', () => ({ describeClips: describeClipsMock }));

import { handleDescribeClips } from '../routes/tasks/describeClips.js';

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
  grabStoragePrefix: 'private/tools/demo/jobs/job1/grab/',
  storagePrefix: 'private/tools/demo/jobs/job1/describe/',
};

beforeEach(() => {
  describeClipsMock.mockReset();
});

describe('handleDescribeClips', () => {
  it('rejects an invalid request body with 400 before calling the service', async () => {
    const { req, res, status, json } = fakeReqRes({ jobId: 'job1' }); // missing fields

    await handleDescribeClips(req, res);

    expect(describeClipsMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('calls the service with the two storage prefixes and returns ok with counts', async () => {
    describeClipsMock.mockResolvedValue({
      catalog: { 'clip01.mp4': { caption: 'x', tags: ['a'], has_ui: true, clip_type: 'ui' } },
      clipsDescribed: 1,
      clipsReused: 0,
    });

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleDescribeClips(req, res);

    expect(describeClipsMock).toHaveBeenCalledWith(
      'private/tools/demo/jobs/job1/grab/',
      'private/tools/demo/jobs/job1/describe/'
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        data: expect.objectContaining({ clipsDescribed: 1, clipsReused: 0, totalClips: 1 }),
      })
    );
  });

  it('is honest when no clips were found, rather than implying a normal empty success', async () => {
    describeClipsMock.mockResolvedValue({ catalog: {}, clipsDescribed: 0, clipsReused: 0 });

    const { req, res, json } = fakeReqRes(VALID_BODY);
    await handleDescribeClips(req, res);

    const [response] = json.mock.calls[0];
    expect(response.status).toBe('ok');
    expect(response.message).toMatch(/No clips found/);
  });

  it('returns 502 with status "error" when the service throws', async () => {
    describeClipsMock.mockRejectedValue(new Error('vision model call failed'));

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleDescribeClips(req, res);

    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({ status: 'error', message: 'vision model call failed' });
  });
});
