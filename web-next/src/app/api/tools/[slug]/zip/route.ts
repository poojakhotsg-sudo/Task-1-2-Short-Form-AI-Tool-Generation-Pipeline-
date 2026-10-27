import { NextRequest, NextResponse } from 'next/server';

// GET /api/tool/:slug/zip — whole-tool download as ZIP (PLAT-04). Must
// return a signed URL to a pre-built/streamed ZIP from object storage, not
// build the archive inline in this Route Handler.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  // TODO(Phase 2 completion): either stream from object storage or return a
  // signed URL; building the ZIP itself is worker/Phase 4 work.
  return NextResponse.json(
    { error: `ZIP download not yet implemented for ${slug}` },
    { status: 501 }
  );
}
