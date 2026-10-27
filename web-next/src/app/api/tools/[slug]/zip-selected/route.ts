import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

// POST /api/tool/:slug/zip-selected — selected-file ZIP (UI-02). The source
// app accepts only paths inside the tool's own folder (PLAT-04) — that path
// check must be re-applied here against object-storage keys, not local
// paths, to prevent cross-tool access.
const bodySchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const unsafe = parsed.data.paths.find(
    (p) => p.includes('..') || !p.startsWith(`${slug}/`)
  );
  if (unsafe) {
    return NextResponse.json({ error: `Path not permitted: ${unsafe}` }, { status: 400 });
  }

  // TODO(Phase 2 completion): build the ZIP from the referenced object-store
  // keys and return a signed URL.
  return NextResponse.json(
    { error: 'Selected-file ZIP not yet implemented' },
    { status: 501 }
  );
}
