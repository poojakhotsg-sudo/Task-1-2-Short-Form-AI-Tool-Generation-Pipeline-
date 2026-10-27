import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = { messages: { create: createMock } };
  },
}));

import { generateReel } from '../generateReel';

function validReelJson() {
  return JSON.stringify({
    angle: 'use_case',
    angle_summary: 'shows the export flow',
    shots: [
      { shot: 1, script_line: 'Hook', source: 'website', duration_seconds: 10, clip_file: 'hook.mp4' },
      { shot: 2, script_line: 'Body', source: 'website', duration_seconds: 15, clip_file: 'body.mp4' },
      { shot: 3, script_line: 'CTA', source: 'website', duration_seconds: 10, clip_file: 'cta.mp4' },
    ],
  });
}

function claudeResponse(text: string, stop_reason: string = 'end_turn') {
  return { content: [{ type: 'text', text }], stop_reason, stop_details: null };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  createMock.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.GROQ_API_KEY;
  delete process.env.GROK_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('generateReel', () => {
  it('returns the parsed, validated reel on a valid first response', async () => {
    createMock.mockResolvedValue(claudeResponse(validReelJson()));

    const reel = await generateReel('demo', 'https://example.com', 'site text', []);

    expect(reel.angle).toBe('use_case');
    expect(reel.shots).toHaveLength(3);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('passes the beta fallback params and json_schema output_config', async () => {
    createMock.mockResolvedValue(claudeResponse(validReelJson()));

    await generateReel('demo', 'https://example.com', 'site text', []);

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(callArgs.fallbacks).toBe('default');
    expect(callArgs.output_config.format.type).toBe('json_schema');
    expect(callArgs.model).toBe('claude-opus-5-5');
  });

  it('retries with an append-only message after a validation failure, then succeeds', async () => {
    createMock
      .mockResolvedValueOnce(claudeResponse(JSON.stringify({ angle: 'use_case', angle_summary: 'x', shots: [] })))
      .mockResolvedValueOnce(claudeResponse(validReelJson()));

    const reel = await generateReel('demo', 'https://example.com', 'site text', []);

    expect(reel.shots).toHaveLength(3);
    expect(createMock).toHaveBeenCalledTimes(2);

    const secondCallMessages = createMock.mock.calls[1][0].messages;
    expect(secondCallMessages).toHaveLength(3); // original user + assistant echo + new user turn
    expect(secondCallMessages[1].role).toBe('assistant');
    expect(secondCallMessages[2].content).toMatch(/has problems/);
  });

  it('throws after exhausting retries on persistent invalid JSON', async () => {
    createMock.mockResolvedValue(claudeResponse('not json at all'));

    await expect(generateReel('demo', 'https://example.com', 'site text', [])).rejects.toThrow(
      /still invalid after retries/
    );
    expect(createMock).toHaveBeenCalledTimes(2); // default attempts = 2
  });

  it('throws when Claude refuses the request', async () => {
    createMock.mockResolvedValue(claudeResponse('', 'refusal'));

    await expect(generateReel('demo', 'https://example.com', 'site text', [])).rejects.toThrow(
      /declined the request/
    );
  });

  it('throws when the response hits max_tokens before completing', async () => {
    createMock.mockResolvedValue(claudeResponse('{"incomplete', 'max_tokens'));

    await expect(generateReel('demo', 'https://example.com', 'site text', [])).rejects.toThrow(
      /hit max_tokens/
    );
  });

  it('throws immediately when no API key is configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(generateReel('demo', 'https://example.com', 'site text', [])).rejects.toThrow(
      /No LLM API key set/
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('falls back to Groq when only a Groq key is configured, cascading through models on failure', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GROQ_API_KEY = 'groq-key';

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: validReelJson() } }] }),
      });

    const reel = await generateReel('demo', 'https://example.com', 'site text', []);

    expect(reel.shots).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toMatch(/openai\/gpt-oss-120b/);
    expect(fetchMock.mock.calls[1][1].body).toMatch(/qwen\/qwen3\.8-27b/);
    expect(createMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
