// Step 4a: a quiet, calm background piece, made from scratch here (so there is nothing to license): four soft chords
// played as slowly breathing pads with a little room echo. It is long enough to loop under the whole video.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'C:/Users/lenovo/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';
const WORK = new URL('./work/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.mkdirSync(WORK, { recursive: true });

const hz = (note) => 440 * 2 ** ((note - 69) / 12);          // MIDI note -> frequency
// Cmaj9 · Am9 · Fmaj9 · G6/9, each a few notes, spread low to high
const CHORDS = [[48, 55, 59, 62, 64], [45, 52, 55, 59, 64], [41, 48, 52, 55, 64], [43, 50, 55, 59, 64]];
const LEN = 12;        // seconds a chord is heard
const FADE = 4;        // seconds each chord takes to swell in and melt away (overlapping its neighbours)

const inputs = [];
const parts = [];
CHORDS.forEach((chord, ci) => {
  const labels = [];
  chord.forEach((note, ni) => {
    // two slightly detuned sines per note give a warm, slow shimmer
    for (const detune of [-0.15, 0.15]) {
      const idx = inputs.length / 4;   // each source adds four arguments
      inputs.push('-f', 'lavfi', '-i', `sine=frequency=${(hz(note) + detune).toFixed(3)}:sample_rate=48000:duration=${LEN + FADE}`);
      parts.push(`[${idx}:a]volume=${(0.5 / (1 + ni * 0.25)).toFixed(3)}[n${ci}_${ni}${detune < 0 ? 'a' : 'b'}]`);
      labels.push(`[n${ci}_${ni}${detune < 0 ? 'a' : 'b'}]`);
    }
  });
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0,afade=t=in:st=0:d=${FADE},afade=t=out:st=${LEN}:d=${FADE},adelay=${ci * LEN * 1000}|${ci * LEN * 1000}[c${ci}]`);
});
const total = CHORDS.length * LEN + FADE;
parts.push(`${CHORDS.map((_, i) => `[c${i}]`).join('')}amix=inputs=${CHORDS.length}:normalize=0,lowpass=f=1500,tremolo=f=0.2:d=0.25,aecho=0.8:0.7:420|760:0.35|0.22,volume=0.9,aformat=channel_layouts=mono[out]`);

const out = path.join(WORK, 'music-loop.wav');
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', parts.join(';'), '-map', '[out]', '-t', String(total), out]);
console.log(`${out} (${total}s loop)`);
