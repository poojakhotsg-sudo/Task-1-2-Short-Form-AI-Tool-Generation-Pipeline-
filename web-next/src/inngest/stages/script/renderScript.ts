import type { Reel } from './schema';

// Ported from script_gen.py's render_script() (lines 319-341).
export function renderScript(tool: string, url: string, reel: Reel): string {
  const angle = reel.angle === 'use_case' ? '1 full use case' : '3 core features';
  const total = reel.shots.reduce((sum, s) => sum + s.duration_seconds, 0);
  const lines = [
    `${tool.toUpperCase()} - ${total}s reel script`,
    `Tool: ${tool} - ${url}`,
    `Angle: ${angle} - ${reel.angle_summary}`,
    '',
  ];

  let t = 0;
  let step = 0;
  const last = reel.shots.length - 1;
  reel.shots.forEach((s, i) => {
    let label: string;
    if (i === 0) {
      label = 'HOOK';
    } else if (i === last) {
      label = 'CTA';
    } else if (s.source === 'trial') {
      label = 'PROOF';
    } else {
      step += 1;
      label = `STEP ${step}`;
    }
    const clipTag = s.clip_file ? ` (${s.clip_file})` : ` (${s.source})`;
    const vis = s.visual_needed || s.clip_file || '';
    lines.push(`[${t}-${t + s.duration_seconds}s]  ${label} - ${vis.slice(0, 60)}${clipTag}`);
    lines.push(s.script_line);
    lines.push('');
    t += s.duration_seconds;
  });

  return lines.join('\n');
}
