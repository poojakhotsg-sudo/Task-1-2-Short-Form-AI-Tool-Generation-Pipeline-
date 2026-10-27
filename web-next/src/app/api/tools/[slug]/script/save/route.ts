import { NextRequest, NextResponse } from 'next/server';
import { scriptSaveSchema } from '@/lib/validation';

// POST /api/tool/:slug/script/save — save an edited script, parse it into
// shots by time-range headers (or 4s/paragraph fallback), rewrite the shot
// list, then rerun the matcher (UI-05).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await req.json().catch(() => null);
  const parsed = scriptSaveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  // TODO(Phase 2 completion): port the HOOK/STEP/PROOF/CTA time-range parser
  // from pipeline/script_gen.py's rendering convention, persist shots, and
  // trigger the matcher.
  void parsed.data.scriptText;
  return NextResponse.json(
    { error: `Script persistence not yet implemented for ${slug}` },
    { status: 501 }
  );
}
