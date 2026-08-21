#!/usr/bin/env node
/** Joins the segments in storyboard order. Each segment is a recording of something real. */
import { execFileSync } from 'node:child_process';
import { writeFileSync, statSync } from 'node:fs';

const FF = '/tmp/node_modules/ffmpeg-static/ffmpeg';
const ORDER = [
  ['scene-s1',   'card: your app has users who cost you money'],
  ['scene-tool', 'the diagnostic, driven with real exports'],
  ['scene-s3',   'what billing can tell you, and when'],
  ['scene-s4',   'the authorization, and the refusal'],
  ['scene-app',  'the refusal is where the revenue happens'],
  ['scene-s678', 'the register, verified — then the close'],
];

/** ffmpeg exits non-zero when asked only to probe, so read stderr and ignore the status. */
const dur = (f) => {
  try {
    execFileSync(FF, ['-hide_banner', '-i', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return '';
  } catch (e) {
    return /Duration: ([0-9:.]+)/.exec(String(e.stderr))?.[1] ?? '?';
  }
};

const list = ORDER.map(([f]) => `file '${process.cwd()}/out/${f}.webm'`).join('\n');
writeFileSync('out/concat.txt', `${list}\n`);

// Re-encode rather than stream-copy: the segments were produced in separate sessions
// and their timestamps do not line up for a copy.
execFileSync(FF, [
  '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'out/concat.txt',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', '-r', '30', '-vsync', 'cfr', 'out/tegata-launch.mp4',
], { stdio: 'inherit' });

const d = dur('out/tegata-launch.mp4');
const size = (statSync('out/tegata-launch.mp4').size / 1_048_576).toFixed(2);

console.log('\nsegments, in order:');
for (const [f, what] of ORDER) {
  console.log(`  ${dur(`out/${f}.webm`)}  ${what}`);
}
console.log(`\nout/tegata-launch.mp4  ${d}  ${size} MB`);
