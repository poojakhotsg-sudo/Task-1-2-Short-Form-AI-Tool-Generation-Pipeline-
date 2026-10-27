import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

function fakeReqRes(authHeader?: string) {
  const req = { header: (name: string) => (name.toLowerCase() === 'authorization' ? authHeader : undefined) } as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  const next = vi.fn();
  return { req, res, status, json, next };
}

describe('requireWorkerAuth', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.WORKER_AUTH_TOKEN = 'secret-token';
  });

  it('calls next() when the bearer token matches', async () => {
    const { requireWorkerAuth } = await import('../auth.js');
    const { req, res, next } = fakeReqRes('Bearer secret-token');

    requireWorkerAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects with 401 when the token is wrong', async () => {
    const { requireWorkerAuth } = await import('../auth.js');
    const { req, res, status, json, next } = fakeReqRes('Bearer wrong-token');

    requireWorkerAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('rejects with 401 when the Authorization header is missing entirely', async () => {
    const { requireWorkerAuth } = await import('../auth.js');
    const { req, res, status, next } = fakeReqRes(undefined);

    requireWorkerAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('rejects with 500 when WORKER_AUTH_TOKEN is not configured at all', async () => {
    delete process.env.WORKER_AUTH_TOKEN;
    const { requireWorkerAuth } = await import('../auth.js');
    const { req, res, status, next } = fakeReqRes('Bearer anything');

    requireWorkerAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(500);
  });
});
