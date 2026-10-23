# Demo video

A narrated walkthrough of the whole workflow (customer, sales rep, Sales Manager, warehouse), made by driving the
**demo copy** of the platform in a headless browser. Nothing is faked: every picture is the real screen. The story is
seven numbered steps, shown on screen, and the video includes a quiet background piece of music.

Make it again (for example after the screens change):

1. `powershell -File demo-video/reset-demo.ps1`  rebuilds the demo data and starts the demo on port 3001
2. `node demo-video/record.mjs`    drives the demo and keeps a picture of each step (`work/raw`, `work/shots.json`)
3. `node demo-video/compose.mjs`   builds the 1920x1080 frames: step number, title, caption (`work/slides`)
4. `node demo-video/narrate.mjs`   speaks each caption with the Piper neural voice, offline (`work/audio`)
5. `node demo-video/music.mjs`     makes the background music from scratch (`work/music-loop.wav`; nothing to license)
6. `node demo-video/assemble.mjs`  joins everything, with the music far behind the voice, into `out/BoxForLess-demo.mp4`

Change what is said by editing the `say` text in `record.mjs`. How loud the music is: `volume=` in `assemble.mjs`.
Run step 1 again afterwards: recording places orders, so the demo is left used. `work/`, `out/` and `tools/` are not committed.

Needs Chrome or Edge, ffmpeg, and Piper. Piper is installed once into `demo-video/tools/piper` (not committed):
the engine `piper_windows_amd64.zip` from github.com/rhasspy/piper (release 2023.11.14-2), unzipped there, and the voice
`en_US-lessac-medium.onnx` plus its `.json` from huggingface.co/rhasspy/piper-voices (en/en_US/lessac/medium).
Another Piper voice can be used by setting `PIPER_VOICE` to its file name.
