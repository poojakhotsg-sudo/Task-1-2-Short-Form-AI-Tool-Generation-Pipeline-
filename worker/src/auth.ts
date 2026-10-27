import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';

// Matches web-next's src/lib/workerClient.ts exactly: it sends
// `Authorization: Bearer ${WORKER_AUTH_TOKEN}`. Required — refuses to
// start serving requests if this isn't configured at all, rather than
// silently accepting unauthenticated dispatch (Section 9: worker dispatch
// must be authenticated).
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || '';

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // keep timing uniform; still reject below
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function requireWorkerAuth(req: Request, res: Response, next: NextFunction): void {
  if (!WORKER_AUTH_TOKEN) {
    res.status(500).json({ status: 'error', message: 'WORKER_AUTH_TOKEN is not configured' });
    return;
  }

  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  if (!token || !constantTimeEquals(token, WORKER_AUTH_TOKEN)) {
    res.status(401).json({ status: 'error', message: 'Invalid or missing Authorization header' });
    return;
  }

  next();
}
