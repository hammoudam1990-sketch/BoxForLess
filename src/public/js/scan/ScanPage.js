// Mobile barcode-camera workflow.
//
// Decoding engine: native BarcodeDetector is PREFERRED; ZXing (vendored at
// /vendor/zxing.min.js, no CDN) is the automatic fallback for browsers without it
// (e.g. iPhone Safari). Both decode the SAME live camera; the camera stays on. Pure
// logic lives in ../scan-core.js, which the Node test suite covers.
//
//   Scan (native | ZXing) -> normalize -> debounce -> Find -> Show product
//     -> Take photo (rear camera) -> Capture -> Preview -> Retake/Save
//     -> Save persists against products.id (see PhotoCapture.js + /api/products/:id/image)
//
// getUserMedia needs a SECURE CONTEXT: https:// or http://localhost. Over
// http://<lan-ip> the camera is blocked; we detect that and point to the https URL.
//
// The decode loop and the camera stream are imperative by nature, so they live in a
// `scan` object held in a ref. React state holds only what the screen DISPLAYS.
import { html, useState, useEffect, useRef } from '../lib/react.js';
import { num } from '../lib/format.js';
import { api } from '../api.js';
import {
  chooseDecoder, normalizeBarcode, prepareManualBarcode, pickExactProduct, createDebouncer,
} from '../scan-core.js';
import { ToastProvider, ProductStatus, KV } from '../staff/ui.js';
import { PhotoCapture } from './PhotoCapture.js';

const FORMATS_NATIVE = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];

function checkSupport() {
  const problems = [];
  if (!window.isSecureContext) problems.push('insecure-context');
  if (!navigator.mediaDevices?.getUserMedia) problems.push('no-getusermedia');
  return { ok: problems.length === 0, problems, hasBarcodeDetector: 'BarcodeDetector' in window };
}

function HttpsHint() {
  const url = `https://${window.location.hostname}:3443/scan.html`;
  return html`The camera needs a secure connection. Open <b>${url}</b> on this phone
    (run <code>npm run gen-cert</code> on the computer first, then accept the one-time security warning).`;
}

function Header() {
  return html`
    <header class="topbar">
      <div class="brand">
        <span class="logo">BFL</span>
        <div>
          <div class="brand-title">Box for Less</div>
          <div class="brand-sub">Barcode Scan · Mobile</div>
        </div>
      </div>
      <nav class="mainnav"><a href="index.html">← Product Master</a></nav>
    </header>`;
}

function ProductCard({ product: p, onRescan, onBeforeCamera }) {
  return html`
    <div class="card">
      <h2 style=${{ marginBottom: 6 }}>${p.name}</h2>
      <${KV} rows=${[
    ['Barcode', p.barcode],
    ['UoM', p.box_uom || ''],
    ['Availability', html`<${ProductStatus} product=${p} />`],
    ['Free To Use', num(p.free_to_use)],
    ['On Hand', num(p.on_hand)],
  ]} />
      <div><${PhotoCapture} key=${p.id} product=${p} onBeforeCamera=${onBeforeCamera} /></div>
      <div class="scan-actions"><button class="ghost" onClick=${onRescan}>Scan another</button></div>
      <a class="back" style=${{ marginTop: 10 }} href=${`index.html#/products/${p.id}`}>Open full product page →</a>
    </div>`;
}

function Result({ result, onRescan, onBeforeCamera }) {
  if (!result) return null;
  const rescan = html`<div class="scan-actions"><button onClick=${onRescan}>Scan again</button></div>`;
  switch (result.kind) {
    case 'loading': return html`<div class="card muted">Looking up product…</div>`;
    case 'found': return html`<${ProductCard} product=${result.product} onRescan=${onRescan} onBeforeCamera=${onBeforeCamera} />`;
    case 'notfound': return html`
      <div class="card">
        <div class="notice"><b>Barcode not found</b><br />Scanned: <b>${result.barcode}</b></div>
        ${rescan}
      </div>`;
    default: return html`<div class="card errbox">Lookup failed: ${result.message}</div>${rescan}`;
  }
}

function ScanScreen() {
  const videoRef = useRef(null);
  const manualRef = useRef(null);

  // what the screen shows
  const [status, setStatus] = useState('Camera not started.');
  const [problem, setProblem] = useState(null);   // null | { https: true } | { text }
  const [camera, setCamera] = useState('off');    // off | on | released (given up for a photo)
  const [result, setResult] = useState(null);
  const [manual, setManual] = useState({ open: false, code: '', msg: '', busy: false });

  // the imperative scanner: stream, decoder, loop state. Never drives rendering.
  const scanRef = useRef(null);
  if (!scanRef.current) {
    scanRef.current = {
      stream: null, engine: null, detector: null, zxReader: null, frameCanvas: null,
      scanning: false, rafId: null, frameTick: 0,
      debouncer: createDebouncer({ windowMs: 2500 }),
    };
  }
  const scan = scanRef.current;
  // read by async code that must see the CURRENT camera / result, not a stale render's
  const live = useRef({});
  live.current = { camera, result };

  const setupEngine = (hasBarcodeDetector) => {
    scan.engine = chooseDecoder({ hasBarcodeDetector });
    if (scan.engine === 'native') {
      scan.detector = new window.BarcodeDetector({ formats: FORMATS_NATIVE });
      return true;
    }
    const ZX = window.ZXing;
    if (!ZX) return false; // vendored bundle failed to load
    scan.zxReader = new ZX.MultiFormatReader();
    const hints = new Map();
    hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
      ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8,
      ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E,
      ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.CODE_39, ZX.BarcodeFormat.ITF,
    ]);
    hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    scan.zxReader.setHints(hints);
    scan.frameCanvas = document.createElement('canvas');
    return true;
  };

  /** Decode one frame with the active engine. Returns a raw string or null. */
  const detectOnce = async () => {
    const video = videoRef.current;
    if (scan.engine === 'native') {
      const codes = await scan.detector.detect(video);
      return codes && codes.length ? codes[0].rawValue : null;
    }
    // ZXing: grab a frame to canvas, decode the luminance bitmap
    if (!video.videoWidth) return null;
    scan.frameCanvas.width = video.videoWidth;
    scan.frameCanvas.height = video.videoHeight;
    scan.frameCanvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
    const ZX = window.ZXing;
    try {
      const lum = new ZX.HTMLCanvasElementLuminanceSource(scan.frameCanvas);
      const bmp = new ZX.BinaryBitmap(new ZX.HybridBinarizer(lum));
      const res = scan.zxReader.decode(bmp);
      return res ? res.getText() : null;
    } catch {
      return null; // NotFoundException etc. = no code in this frame
    } finally {
      scan.zxReader.reset();
    }
  };

  const scanningLabel = () => (scan.engine === 'native' ? 'Scanning (native detector)…' : 'Scanning (ZXing decoder)…');

  const scanLoop = async () => {
    if (!scan.scanning) return;
    let value = null;
    // Native is cheap per frame; ZXing is heavier, so decode ~every 3rd frame.
    const doDecode = scan.engine === 'native' || (++scan.frameTick % 3 === 0);
    if (doDecode) {
      try { value = await detectOnce(); } catch { value = null; }
    }
    if (value) {
      const code = normalizeBarcode(value);
      if (code && scan.debouncer.shouldAccept(code)) { onDetected(code); return; }
    }
    scan.rafId = requestAnimationFrame(scanLoop);
  };

  /** Pause scanning but KEEP the camera live. */
  const pauseScanning = () => {
    scan.scanning = false;
    if (scan.rafId) cancelAnimationFrame(scan.rafId);
    scan.rafId = null;
  };

  const resumeScanning = () => {
    scan.scanning = true;
    scan.frameTick = 0;
    setStatus(scanningLabel());
    scanLoop();
  };

  const startCamera = async () => {
    setProblem(null);
    const sup = checkSupport();
    if (!sup.ok) {
      setProblem(sup.problems.includes('insecure-context')
        ? { https: true }
        : { text: 'This browser does not expose camera access (getUserMedia).' });
      return;
    }

    try {
      // Resolution matters for 1D decoding. An EAN-13 symbol is 95 modules wide and
      // needs roughly 2px per module to decode reliably; at iOS Safari's default
      // 640x480 a small barcode filling a fifth of the view yields about 1.3px per
      // module, which cannot be read however clear the print is. Asking for 1080p
      // gives the same physical barcode ~3x the pixels.
      //
      // `ideal` is a HINT, not a requirement: a device that cannot supply it falls
      // back to its own default rather than failing, so this can only help.
      scan.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (e) {
      setProblem({ text: `Could not open camera: ${e.message}. Check the browser's camera permission.` });
      return;
    }

    videoRef.current.srcObject = scan.stream;
    await videoRef.current.play();
    setCamera('on');

    if (!setupEngine(sup.hasBarcodeDetector)) {
      setProblem({ text: 'Barcode decoder failed to load (vendor/zxing.min.js). Reload the page.' });
      return;
    }

    scan.debouncer.reset();
    resumeScanning();
  };

  const stopCamera = () => {
    pauseScanning();
    if (scan.stream) scan.stream.getTracks().forEach((t) => t.stop());
    scan.stream = null;
    setCamera('off');
    setStatus('Camera stopped.');
  };

  async function onDetected(barcode) {
    pauseScanning();
    scan.debouncer.lock();                 // suppress further detections while a result shows
    setStatus(`Detected: ${barcode}`);
    if (navigator.vibrate) navigator.vibrate(80);

    setResult({ kind: 'loading' });
    try {
      const data = await api.products({ search: barcode, limit: 10 });
      const found = pickExactProduct(data.items, barcode);
      setResult(found ? { kind: 'found', product: found } : { kind: 'notfound', barcode });
    } catch (e) {
      setResult({ kind: 'error', message: e.message });
    }
  }

  /** Release the barcode camera so the product-photo camera can open.
   *  (Mobile devices typically allow only one active camera at a time.) */
  const releaseScannerForPhoto = async () => {
    pauseScanning();
    if (scan.stream) { scan.stream.getTracks().forEach((t) => t.stop()); scan.stream = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamera('released');
    setStatus('Taking product photo…');
  };

  const rescan = () => {
    setResult(null);
    scan.debouncer.unlock();
    if (scan.stream && videoRef.current?.srcObject) {
      resumeScanning();      // camera still live — just resume the decode loop
    } else {
      startCamera();         // scanner camera was released for a photo — re-acquire
    }
  };

  // -------------------------------------------------------------------------
  // Manual barcode entry — the fallback when the camera cannot read a label.
  //
  // It performs NO lookup of its own: it hands the typed value to onDetected(), the
  // exact function a successful camera scan calls. So the server-side lookup, the
  // exact-match rule, the product card and the photo workflow are literally the same
  // code path, and cannot drift from the scanner's behaviour.
  // -------------------------------------------------------------------------

  const openManual = () => {
    // Release the decoder: a live decode landing mid-typing would yank the screen
    // away from the user. (The camera itself stays on behind the form.)
    pauseScanning();
    setManual((m) => ({ ...m, open: true, msg: '' }));
  };

  const closeManual = () => {
    setManual({ open: false, code: '', msg: '', busy: false });
    // "Back to camera": pick the decoder up again if the camera is live and no
    // result is waiting to be dealt with.
    if (live.current.camera === 'on' && !live.current.result && scan.stream) resumeScanning();
  };

  const manualLookup = async () => {
    const { ok, code, error } = prepareManualBarcode(manual.code);
    if (!ok) {
      setManual((m) => ({ ...m, msg: error }));
      manualRef.current?.focus();
      return;
    }
    setManual((m) => ({ ...m, msg: 'Looking up…', busy: true }));
    scan.debouncer.unlock();      // a manual lookup is always deliberate, never a repeat
    await onDetected(code);       // identical path to a camera detection
    setManual((m) => ({ ...m, open: false, msg: '', busy: false }));
  };

  // focus the field when the panel opens
  useEffect(() => {
    if (manual.open) { manualRef.current?.focus(); manualRef.current?.select(); }
  }, [manual.open]);

  // Proactively warn about an insecure context (the camera will be blocked), and
  // always give the camera back when the page goes away.
  useEffect(() => {
    const sup = checkSupport();
    if (!sup.ok && sup.problems.includes('insecure-context')) setProblem({ https: true });
    window.addEventListener('pagehide', stopCamera);
    return () => {
      window.removeEventListener('pagehide', stopCamera);
      pauseScanning();
      if (scan.stream) scan.stream.getTracks().forEach((t) => t.stop());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The manual-entry block is the fallback for a barcode the camera cannot read:
  // damaged, tiny, or awkwardly placed. Camera scanning stays the primary method; the
  // panel is hidden until asked for and uses the SAME lookup as a successful scan.
  // Its field is inputMode text, not numeric: a few real barcodes contain letters and
  // symbols, and type=number would strip leading zeros.
  return html`
    <${Header} />
    <main class="scan-wrap">
      ${problem ? html`<div class="notice">${problem.https ? html`<${HttpsHint} />` : problem.text}</div>` : null}

      <div class=${`scan-stage${camera === 'released' ? ' hidden' : ''}`}>
        <video ref=${videoRef} playsInline=${true} muted=${true}></video>
        <div class=${`scan-reticle${camera === 'on' ? '' : ' hidden'}`}></div>
      </div>
      <div class="scan-status">${status}</div>

      <div class="scan-actions">
        <button class=${camera === 'off' ? '' : 'hidden'} onClick=${startCamera}>Start camera</button>
        <button class=${`ghost${camera === 'on' ? '' : ' hidden'}`} onClick=${stopCamera}>Stop</button>
      </div>

      <div class="manual-entry">
        <button class="linkbtn" type="button" aria-expanded=${manual.open} aria-controls="manualPanel"
          onClick=${() => (manual.open ? closeManual() : openManual())}>
          Can't scan the barcode? <b>Enter barcode manually</b>
        </button>

        <div id="manualPanel" class=${`manual-panel${manual.open ? '' : ' hidden'}`}>
          <label class="manual-label" for="manualBarcode">Enter barcode</label>
          <input id="manualBarcode" ref=${manualRef} type="text" inputMode="text" autoComplete="off"
            autoCapitalize="off" autoCorrect="off" spellCheck=${false}
            enterKeyHint="search" placeholder="e.g. 6281003101428"
            value=${manual.code}
            onChange=${(e) => setManual((m) => ({ ...m, code: e.target.value }))}
            onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); manualLookup(); } }} />
          <div class="scan-actions">
            <button type="button" disabled=${manual.busy} onClick=${manualLookup}>Find Product</button>
            <button class="ghost" type="button" onClick=${closeManual}>Back to camera</button>
          </div>
          <div class="scan-status">${manual.msg}</div>
        </div>
      </div>

      <div class="scan-result">
        <${Result} result=${result} onRescan=${rescan} onBeforeCamera=${releaseScannerForPhoto} />
      </div>
    </main>`;
}

export function ScanPage() {
  return html`<${ToastProvider}><${ScanScreen} /><//>`;
}
