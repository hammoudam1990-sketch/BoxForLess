// Step 3: speak each caption with the Piper neural voice (offline, on this computer) and save one WAV per picture
// (demo-video/work/audio/NN.wav). Piper and its voice live in demo-video/tools/piper (downloaded once, not committed).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = new URL('./', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PIPER_DIR = path.join(HERE, 'tools', 'piper');
const EXE = path.join(PIPER_DIR, 'piper', 'piper.exe');
const MODEL = path.join(PIPER_DIR, process.env.PIPER_VOICE || 'en_US-lessac-medium.onnx');
const WORK = path.join(HERE, 'work');
const AUDIO = path.join(WORK, 'audio');
fs.rmSync(AUDIO, { recursive: true, force: true });
fs.mkdirSync(AUDIO, { recursive: true });
if (!fs.existsSync(EXE) || !fs.existsSync(MODEL)) throw new Error('Piper is not installed in demo-video/tools/piper (see demo-video/README.md).');

// how a name is SAID: the screen keeps the real spelling
const spoken = (t) => t.replace(/Odoo/g, 'Oo-doo').replace(/\bI D\b/g, 'I.D.').replace(/\bCEO\b/g, 'C.E.O.').replace(/\bGHS\b/g, 'cedis');

const shots = JSON.parse(fs.readFileSync(path.join(WORK, 'shots.json'), 'utf8'));
for (const s of shots) {
  const out = path.join(AUDIO, `${String(s.id).padStart(2, '0')}.wav`);
  const r = spawnSync(EXE, ['--model', MODEL, '--output_file', out, '--length_scale', '1.12', '--sentence_silence', '0.45', '--noise_scale', '0.5', '--noise_w', '0.6'], {
    input: spoken(s.say), cwd: path.dirname(EXE), encoding: 'utf8',
  });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`Piper failed on scene ${s.id}: ${r.stderr}`);
  process.stdout.write(`${s.id} `);
}
console.log(`\n${shots.length} narration files`);
