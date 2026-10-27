import Anthropic from '@anthropic-ai/sdk';

// Port of matcher.py's score_catalog_with_llm() (lines 137-185). Text-only
// — scores clip captions/tags against a script line, no images involved,
// unlike the worker's describe_clips vision call. That's why this lives
// in web-next (a plain API call) rather than the worker (Section 2.1's
// worker is for browser automation/native media work specifically).
//
// Model choice: claude-opus-5-5, not the source's hardcoded
// claude-3-5-sonnet-20241022 — same rationale as describe_clips's vision
// call (AUDIT.md flagged that pin as stale; not carrying it forward).
// Groq fallback model: 'openai/gpt-oss-120b' is NOT a fresh guess here —
// it's this same project's own established choice, already used
// successfully for GROQ_MODEL in the earlier Content Creation app's
// outline/assets-breakdown endpoints, so reusing it is precedent, not
// fabrication (contrast with the worker's GROQ_VISION_MODEL, which has
// no such precedent and is deliberately left unset by default).
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GROK_API_KEY || '';
const GROQ_MATCH_MODEL = process.env.GROQ_MATCH_MODEL || 'openai/gpt-oss-120b';

export interface CatalogEntryForScoring {
  file: string;
  caption: string;
  tags: string[];
}

function buildPrompt(scriptLine: string, catalog: CatalogEntryForScoring[]): string {
  return (
    `Voiceover line: "${scriptLine}"\n\n` +
    `Rate how well each clip's visual content illustrates this voiceover line on a scale from 0.0 to 1.0 (1.0 = perfect match, 0.0 = completely irrelevant):\n` +
    JSON.stringify(catalog.map((c) => ({ file: c.file, caption: c.caption, tags: c.tags })), null, 2) +
    `\n\nReturn ONLY a JSON object: {"matches": [{"file": "...", "score": 0.85}, ...]}`
  );
}

function parseScores(text: string): Record<string, number> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const scores: Record<string, number> = {};
  try {
    const data = JSON.parse(cleaned) as { matches?: { file?: string; score?: number }[] };
    for (const m of data.matches ?? []) {
      if (typeof m.file === 'string' && typeof m.score === 'number') {
        scores[m.file] = m.score;
      }
    }
  } catch {
    // Matches the source's bare `except Exception: pass` — an
    // unparseable response means "no scores," not a thrown error, so
    // match.ts's caller falls through to the next rule rather than
    // failing the whole stage over one bad model response.
  }
  return scores;
}

async function scoreWithClaude(scriptLine: string, catalog: CatalogEntryForScoring[]): Promise<Record<string, number>> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 1000,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: buildPrompt(scriptLine, catalog) }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return {};
  return parseScores(textBlock.text);
}

async function scoreWithGroq(scriptLine: string, catalog: CatalogEntryForScoring[]): Promise<Record<string, number>> {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MATCH_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: buildPrompt(scriptLine, catalog) }],
    }),
  });
  if (!resp.ok) return {}; // matches the source's try/except around the whole call
  const json = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) return {};
  return parseScores(content);
}

// Returns {} (not an error) if neither key is configured, if the catalog
// is empty, or if the call/parse fails — matches the source's "scoring
// failure degrades to no match for this rule, try the next one" behavior
// exactly, rather than failing the whole match stage over one bad call.
export async function scoreCatalogAgainstLine(
  scriptLine: string,
  catalog: CatalogEntryForScoring[]
): Promise<Record<string, number>> {
  if (catalog.length === 0) return {};
  try {
    if (ANTHROPIC_API_KEY) return await scoreWithClaude(scriptLine, catalog);
    if (GROQ_API_KEY) return await scoreWithGroq(scriptLine, catalog);
  } catch {
    return {};
  }
  return {};
}
