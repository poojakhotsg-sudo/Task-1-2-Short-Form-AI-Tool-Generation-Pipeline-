import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { recordMock, uploadObjectMock } = vi.hoisted(() => ({
  recordMock: vi.fn(),
  uploadObjectMock: vi.fn(),
}));

vi.mock('../services/recordMissingShotClips.js', () => ({ recordMissingShotClips: recordMock }));
vi.mock('../lib/storage.js', () => ({ uploadObject: uploadObjectMock }));

import { handleRecordMissingShotClips } from '../routes/tasks/recordMissingShotClips.js';

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
  shots: [{ shot: 2, visualNeeded: 'Dashboard Overview', scriptLine: 'then the dashboard', durationSeconds: 5 }],
};

beforeEach(() => {
  recordMock.mockReset();
  uploadObjectMock.mockReset();
  uploadObjectMock.mockResolvedValue(undefined);
});

describe('handleRecordMissingShotClips', () => {
  it('rejects an invalid request body with 400 before calling the service', async () => {
    const { req, res, status, json } = fakeReqRes({ jobId: 'job1' });

    await handleRecordMissingShotClips(req, res);

    expect(recordMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('uploads a recorded clip under storagePrefix/clips/ and reports it in the shots array', async () => {
    recordMock.mockResolvedValue([
      {
        shot: 2,
        file: 'shot02_dashboard-overview.mp4',
        content: Buffer.from('fake-video'),
        status: 'ok',
        error: null,
        seconds: 5.2,
        qa: 'pass',
        qaReasons: [],
        matchedHeading: 'Dashboard Overview',
      },
    ]);

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleRecordMissingShotClips(req, res);

    expect(recordMock).toHaveBeenCalledWith(
      'https://example.com',
      [{ shot: 2, visualNeeded: 'Dashboard Overview', scriptLine: 'then the dashboard', durationSeconds: 5 }],
      { headed: false }
    );
    expect(uploadObjectMock).toHaveBeenCalledWith({
      key: 'private/tools/demo/jobs/job1/grab/clips/shot02_dashboard-overview.mp4',
      body: Buffer.from('fake-video'),
      contentType: 'video/mp4',
    });

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        message: 'Recorded 1/1 mobile clip(s)',
        data: expect.objectContaining({
          recordedCount: 1,
          totalPending: 1,
          shots: [
            expect.objectContaining({
              shot: 2,
              file: 'private/tools/demo/jobs/job1/grab/clips/shot02_dashboard-overview.mp4',
              status: 'ok',
            }),
          ],
        }),
      })
    );
  });

  it('does not upload anything for a shot the service could not record, and reports it missing', async () => {
    recordMock.mockResolvedValue([
      {
        shot: 2,
        file: null,
        content: null,
        status: 'missing',
        error: "insufficient website assets for visual: 'Dashboard Overview' (no matching heading)",
        seconds: null,
        qa: null,
        qaReasons: [],
        matchedHeading: null,
      },
    ]);

    const { req, res, json } = fakeReqRes(VALID_BODY);
    await handleRecordMissingShotClips(req, res);

    expect(uploadObjectMock).not.toHaveBeenCalled();
    const [response] = json.mock.calls[0];
    expect(response.data.shots[0]).toMatchObject({ file: null, status: 'missing' });
    expect(response.data.recordedCount).toBe(0);
  });

  it('is honest when there are no pending shots to record', async () => {
    recordMock.mockResolvedValue([]);

    const { req, res, json } = fakeReqRes({ ...VALID_BODY, shots: [] });
    await handleRecordMissingShotClips(req, res);

    const [response] = json.mock.calls[0];
    expect(response.status).toBe('ok');
    expect(response.message).toMatch(/No pending shots/);
  });

  it('returns 502 with status "error" when the service throws', async () => {
    recordMock.mockRejectedValue(new Error('browser crashed'));

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleRecordMissingShotClips(req, res);

    expect(uploadObjectMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({ status: 'error', message: 'browser crashed' });
  });
});
