import { describe, it, expect } from 'vitest';
import { decideNormalizeAction, shouldDiscard } from '../services/normalizeMedia.js';

describe('decideNormalizeAction', () => {
  it('re-encodes when the codec is not h264', () => {
    expect(decideNormalizeAction({ codec: 'vp9', pixFmt: 'yuv420p', hasAudio: false }, false)).toBe('reencode');
  });

  it('re-encodes when the pixel format is not yuv420p', () => {
    expect(decideNormalizeAction({ codec: 'h264', pixFmt: 'yuv444p', hasAudio: false }, false)).toBe('reencode');
  });

  it('is case-insensitive about codec/pix_fmt', () => {
    expect(decideNormalizeAction({ codec: 'H264', pixFmt: 'YUV420P', hasAudio: false }, false)).toBe('none');
  });

  it('strips audio from an already-compliant non-embed clip that has it', () => {
    expect(decideNormalizeAction({ codec: 'h264', pixFmt: 'yuv420p', hasAudio: true }, false)).toBe('strip_audio');
  });

  it('keeps audio on an embed clip even when already h264/yuv420p', () => {
    expect(decideNormalizeAction({ codec: 'h264', pixFmt: 'yuv420p', hasAudio: true }, true)).toBe('none');
  });

  it('does nothing for an already-compliant, audio-free clip', () => {
    expect(decideNormalizeAction({ codec: 'h264', pixFmt: 'yuv420p', hasAudio: false }, false)).toBe('none');
  });

  it('treats missing codec/pix_fmt info (ffprobe failure) as needing re-encode', () => {
    expect(decideNormalizeAction({ codec: null, pixFmt: null, hasAudio: false }, false)).toBe('reencode');
  });
});

describe('shouldDiscard', () => {
  it('discards a clip under 50KB', () => {
    expect(shouldDiscard(49 * 1024, 5)).toBe(true);
  });

  it('keeps a clip at or above 50KB with a long enough duration', () => {
    expect(shouldDiscard(50 * 1024, 5)).toBe(false);
  });

  it('discards a clip shorter than 1 second even if it is large', () => {
    expect(shouldDiscard(10 * 1024 * 1024, 0.5)).toBe(true);
  });

  it('treats a null duration as 0 seconds (discard)', () => {
    expect(shouldDiscard(1024 * 1024, null)).toBe(true);
  });

  it('keeps a clip exactly at the 1 second boundary', () => {
    expect(shouldDiscard(1024 * 1024, 1.0)).toBe(false);
  });
});
