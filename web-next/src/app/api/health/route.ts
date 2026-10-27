export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

// GET /health — health check for Render / Docker (PLAT-05).
export async function GET() {
  return NextResponse.json({ status: 'ok', ts: new Date().toISOString() });
}
