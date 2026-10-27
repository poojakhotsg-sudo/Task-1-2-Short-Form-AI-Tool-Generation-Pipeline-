import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { fetchSiteTextMock, uploadObjectMock } = vi.hoisted(() => ({
  fetchSiteTextMock: vi.fn(),
  uploadObjectMock: vi.fn(),
}));

vi.mock('../services/siteText.js', () => ({ fetchSiteText: fetchSiteTextMock }));
vi.mock('../lib/storage.js', () => ({ uploadObject: uploadObjectMock }));

import { handleFetchSiteText } from '../routes/tasks/fetchSiteText.js';

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
  storagePrefix: 'private/tools/demo/jobs/job1/script/',
};

beforeEach(() => {
  fetchSiteTextMock.mockReset();
  uploadObjectMock.mockReset();
  uploadObjectMock.mockResolvedValue(undefined);
});

describe('handleFetchSiteText', () => {
  it('rejects an invalid request body with 400 before calling the service', async () => {
    const { req, res, status, json } = fakeReqRes({ jobId: 'job1' }); // missing fields

    await handleFetchSiteText(req, res);

    expect(fetchSiteTextMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('calls the service with the url and uploads site_text.txt to storagePrefix', async () => {
    fetchSiteTextMock.mockResolvedValue('=== https://example.com\nSome text');

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleFetchSiteText(req, res);

    expect(fetchSiteTextMock).toHaveBeenCalledWith('https://example.com');
    expect(uploadObjectMock).toHaveBeenCalledWith({
      key: 'private/tools/demo/jobs/job1/script/site_text.txt',
      body: '=== https://example.com\nSome text',
      contentType: 'text/plain',
    });

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        data: expect.objectContaining({ siteTextKey: 'private/tools/demo/jobs/job1/script/site_text.txt' }),
      })
    );
  });

  it('is honest when no site text could be extracted, rather than implying a normal success', async () => {
    fetchSiteTextMock.mockResolvedValue('');

    const { req, res, json } = fakeReqRes(VALID_BODY);
    await handleFetchSiteText(req, res);

    const [response] = json.mock.calls[0];
    expect(response.status).toBe('ok');
    expect(response.message).toMatch(/No site text/);
  });

  it('returns 502 with status "error" when the service throws', async () => {
    fetchSiteTextMock.mockRejectedValue(new Error('browser crashed'));

    const { req, res, status, json } = fakeReqRes(VALID_BODY);
    await handleFetchSiteText(req, res);

    expect(uploadObjectMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({ status: 'error', message: 'browser crashed' });
  });
});
