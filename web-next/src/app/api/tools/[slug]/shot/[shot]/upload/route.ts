import { NextRequest, NextResponse } from 'next/server';

// POST /api/tool/:slug/shot/:shot/upload — manual replacement clip upload
// (UI-01). The source app re-encodes to 1080x1920 and runs QA on upload;
// that work belongs to the Phase 4 worker, not this Route Handler. This
// endpoint's job is to validate the upload, store the raw file in object
// storage, and dispatch a worker task — never to run ffmpeg itself (Section
// 2.2: don't assume serverless functions can run long media jobs).
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // matches EXTRACT-01's 500MB/file limit

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; shot: string }> }
) {
  const { slug, shot } = await params;

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'File exceeds 500MB limit' }, { status: 413 });
  }

  // TODO(Phase 2 completion): stream the multipart file to object storage,
  // record it as an AssetRecord, and dispatch a `normalize_media` + `run_qa`
  // worker task (Section 5, Worker Task Contract) for this slug/shot.
  return NextResponse.json(
    { error: `Upload storage not yet implemented for ${slug}/shot ${shot}` },
    { status: 501 }
  );
}
