// Step 4: one video segment per picture (its frame + its narration), then joined into the finished MP4.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'C:/Users/lenovo/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
const WORK = new URL('./work/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SEG = path.join(WORK, 'segments');
fs.rmSync(SEG, { recursive: true, force: true });
fs.mkdirSync(SEG, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const shots = JSON.parse(fs.readFileSync(path.join(WORK, 'shots.json'), 'utf8'));

const PAD = 1.0;       // a breath after each picture
const list = [];
let total = 0;
for (const s of shots) {
  const id = String(s.id).padStart(2, '0');
  const wav = path.join(WORK, 'audio', `${id}.wav`);
  const png = path.join(WORK, 'slides', `${id}.png`);
  const dur = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]).toString().trim()) + PAD;
  const seg = path.join(SEG, `${id}.mp4`);
  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-i', png, '-i', wav,
    '-af', `apad=pad_dur=${PAD},aresample=48000`, '-t', dur.toFixed(2),
    '-vf', `fade=t=in:st=0:d=0.3,fade=t=out:st=${(dur - 0.3).toFixed(2)}:d=0.3,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '1', seg,
  ]);
  list.push(`file '${seg.split(path.sep).join('/')}'`);
  total += dur;
  process.stdout.write(`${id} `);
}
fs.writeFileSync(path.join(SEG, 'list.txt'), list.join('\n'));
const joined = path.join(WORK, 'joined.mp4');
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(SEG, 'list.txt'), '-c', 'copy', joined]);

// the background music: far behind the voice, and lowered further whenever someone is speaking
const out = path.join(OUT, 'BoxForLess-demo.mp4');
const music = path.join(WORK, 'music-loop.wav');
if (fs.existsSync(music)) {
  const fadeOutAt = (total - 5).toFixed(1);
  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'error', '-i', joined, '-stream_loop', '-1', '-i', music,
    '-filter_complex',
    `[1:a]volume=1.15,afade=t=in:st=0:d=3,afade=t=out:st=${fadeOutAt}:d=5[m];[0:a]asplit=2[v0][side];[v0]volume=0.8[v];[m][side]sidechaincompress=threshold=0.05:ratio=2.5:attack=60:release=900[duck];[v][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(2), '-movflags', '+faststart', out,
  ]);
} else {
  fs.copyFileSync(joined, out);
}
console.log(`
${out}  (${Math.floor(total / 60)} min ${Math.round(total % 60)} s, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
