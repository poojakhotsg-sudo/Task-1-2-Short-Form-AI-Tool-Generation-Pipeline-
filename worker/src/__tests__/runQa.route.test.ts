import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { runQaMock, uploadObjectMock } = vi.hoisted(() => ({
  runQaMock: vi.fn(),
  uploadObjectMock: vi.fn(),
}));

vi.mock('../services/runQa.js', () => ({ runQa: runQaMock }));
vi.mock('../lib/storage.js', () => ({ uploadObject: uploadObjectMock }));

import { handleRunQa } from '../routes/tasks/runQa.js';

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
  storagePrefix: 'private/tools/demo/jobs/job1/qa/',
};

beforeEach(() => {
  runQaMock.mockReset();
  uploadObjectMock.mockReset();
  uploadObjectMock.mockResolvedValue(undefined);
});

describe('handleRunQa', () => {
  it('rejects an invalid request body with 400 before calling the service', async () => {
    const { req, res, status, json } = fakeReqRes({ jobId: 'job1' }); // missing fields

    await handleRunQa(req, res);

    expect(runQaMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('calls the service with grabStoragePrefix and uploads qa_report.json to storagePrefix', async () => {
    runQaMock.mockResolvedValue({
      report: [{ file: 'clip01.mp4', seconds: 9, size: '1080x1920', sharpness: 1000, motion: 2, ok: true, issues: [] }],
      passCount: 1,
      failCount: 0,
    });

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleRunQa(req, res);

    expect(runQaMock).toHaveBeenCalledWith('private/tools/demo/jobs/job1/grab/');
    expect(uploadObjectMock).toHaveBeenCalledWith({
      key: 'private/tools/demo/jobs/job1/qa/qa_report.json',
      body: expect.stringContaining('clip01.mp4'),
      contentType: 'application/json',
    });

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        message: '1/1 clip(s) passed QA',
        data: expect.objectContaining({ passCount: 1, failCount: 0, totalClips: 1 }),
      })
    );
  });

  it('is honest when no clips exist yet, rather than implying a normal empty success', async () => {
    runQaMock.mockResolvedValue({ report: [], passCount: 0, failCount: 0 });

    const { req, res, json } = fakeReqRes(VALID_BODY);
    await handleRunQa(req, res);

    const [response] = json.mock.calls[0];
    expect(response.status).toBe('ok');
    expect(response.message).toMatch(/No clips found/);
  });

  it('returns 502 with status "error" when the service throws', async () => {
    runQaMock.mockRejectedValue(new Error('ffprobe exploded'));

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleRunQa(req, res);

    expect(uploadObjectMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({ status: 'error', message: 'ffprobe exploded' });
  });
});
