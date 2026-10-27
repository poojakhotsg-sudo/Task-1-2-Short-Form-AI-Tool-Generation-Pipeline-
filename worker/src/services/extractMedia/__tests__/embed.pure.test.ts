import { describe, it, expect } from 'vitest';
import { embedUrl } from '../embed.js';

describe('embedUrl', () => {
  it('normalizes a youtube.com/embed/<id> iframe src to a watch URL', () => {
    expect(embedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('normalizes a youtube-nocookie.com/embed/<id> iframe src the same way', () => {
    expect(embedUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
  });

  it('normalizes a player.vimeo.com/video/<id> iframe src to a vimeo.com URL', () => {
    expect(embedUrl('https://player.vimeo.com/video/123456789')).toBe('https://vimeo.com/123456789');
  });

  it('includes the private-video hash segment when a vimeo embed has an h= param', () => {
    expect(embedUrl('https://player.vimeo.com/video/123456789?h=abcdef1234')).toBe('https://vimeo.com/123456789/abcdef1234');
  });

  it('normalizes a loom.com/embed/<id> iframe src to a share URL', () => {
    expect(embedUrl('https://www.loom.com/embed/abc123')).toBe('https://www.loom.com/share/abc123');
  });

  it('passes through an unrecognized embed URL unchanged', () => {
    const url = 'https://fast.wistia.net/embed/iframe/xyz789';
    expect(embedUrl(url)).toBe(url);
  });
});
