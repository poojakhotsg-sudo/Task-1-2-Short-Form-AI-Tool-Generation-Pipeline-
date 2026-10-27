import { NextRequest, NextResponse } from 'next/server';

// POST /api/tool/:slug/script/generate — AI script generation (PIPE-04 /
// UI-05). Requires ANTHROPIC_API_KEY or GROQ_API_KEY and real clip-catalog
// evidence (PIPE-03) to ground the script, neither of which exists until
// the describe/script Inngest workflows (Phase 3/4) are built. Returning
// 503 rather than calling a model with no grounding data, which would
// violate PIPE-04's "asset-first, grounded in evidence" requirement.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.GROQ_API_KEY);
  if (!hasKey) {
    return NextResponse.json({ error: 'No AI API key configured' }, { status: 503 });
  }

  return NextResponse.json(
    { error: `Clip catalog / site data not yet available for ${slug} — describe/script workflow is Phase 3/4` },
    { status: 501 }
  );
}
