import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { assembleRoughCutMock } = vi.hoisted(() => ({ assembleRoughCutMock: vi.fn() }));
vi.mock('../services/assembleRoughCut.js', () => ({ assembleRoughCut: assembleRoughCutMock }));

import { handleAssembleRoughCut } from '../routes/tasks/assembleRoughCut.js';

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
  toolName: 'Demo',
  matchStoragePrefix: 'private/tools/demo/jobs/job1/match/',
  storagePrefix: 'private/tools/demo/jobs/job1/assemble/',
};

beforeEach(() => {
  assembleRoughCutMock.mockReset();
});

describe('handleAssembleRoughCut', () => {
  it('rejects an invalid request body with 400 before calling the service', async () => {
    const { req, res, status, json } = fakeReqRes({ jobId: 'job1' }); // missing fields

    await handleAssembleRoughCut(req, res);

    expect(assembleRoughCutMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('calls the service with toolName/matchStoragePrefix/storagePrefix/placeholders(default true)', async () => {
    assembleRoughCutMock.mockResolvedValue({
      roughCutUploaded: true,
      shotsTotal: 3,
      shotsCovered: 2,
      shotsMissing: 1,
      shotsNeedTrial: 0,
    });

    const { req, res } = fakeReqRes(VALID_BODY);
    await handleAssembleRoughCut(req, res);

    expect(assembleRoughCutMock).toHaveBeenCalledWith(
      'Demo',
      'private/tools/demo/jobs/job1/match/',
      'private/tools/demo/jobs/job1/assemble/',
      true
    );
  });

  it('respects an explicit placeholders:false override', async () => {
    assembleRoughCutMock.mockResolvedValue({
      roughCutUploaded: false,
      shotsTotal: 1,
      shotsCovered: 0,
      shotsMissing: 1,
      shotsNeedTrial: 0,
    });

    const { req, res } = fakeReqRes({ ...VALID_BODY, placeholders: false });
    await handleAssembleRoughCut(req, res);

    expect(assembleRoughCutMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), false);
  });

  it('returns ok with a roughCutKey when a rough cut was produced', async () => {
    assembleRoughCutMock.mockResolvedValue({
      roughCutUploaded: true,
      shotsTotal: 3,
      shotsCovered: 2,
      shotsMissing: 1,
      shotsNeedTrial: 0,
    });

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleAssembleRoughCut(req, res);

    expect(status).toHaveBeenCalledWith(200);
    const [response] = json.mock.calls[0];
    expect(response.status).toBe('ok');
    expect(response.message).toMatch(/2\/3 shots covered, 1 missing, 0 needs trial/);
    expect(response.data.roughCutKey).toBe('private/tools/demo/jobs/job1/assemble/rough_cut.mp4');
    expect(response.data.summaryKey).toBe('private/tools/demo/jobs/job1/assemble/summary.md');
  });

  it('is honest with a null roughCutKey and a different message when nothing was cut', async () => {
    assembleRoughCutMock.mockResolvedValue({
      roughCutUploaded: false,
      shotsTotal: 2,
      shotsCovered: 0,
      shotsMissing: 2,
      shotsNeedTrial: 0,
    });

    const { req, res, json } = fakeReqRes(VALID_BODY);
    await handleAssembleRoughCut(req, res);

    const [response] = json.mock.calls[0];
    expect(response.status).toBe('ok');
    expect(response.message).toMatch(/Nothing to cut/);
    expect(response.data.roughCutKey).toBeNull();
  });

  it('returns 502 with status "error" when the service throws', async () => {
    assembleRoughCutMock.mockRejectedValue(new Error('match_result.json not found'));

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleAssembleRoughCut(req, res);

    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({ status: 'error', message: 'match_result.json not found' });
  });
});
