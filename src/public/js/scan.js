// Mobile barcode-camera workflow.
//
// Decoding engine (requirement): native BarcodeDetector is PREFERRED; ZXing
// (vendored at /vendor/zxing.min.js, no CDN) is the automatic fallback for
// browsers without BarcodeDetector (e.g. iPhone Safari). Both decode the SAME
// live camera; the camera stays on. Pure logic lives in scan-core.js.
//
//   Scan (native | ZXing) -> normalize -> debounce -> Find -> Show product
//     -> Take photo (rear camera) -> Capture -> Preview -> Retake/Save
//     -> Save persists against products.id (see photo.js + /api/products/:id/image)
//
// getUserMedia needs a SECURE CONTEXT: https:// or http://localhost. Over
// http://<lan-ip> the camera is blocked; we detect that and point to the https URL.
import { api, esc, num, toast, stockPill } from './api.js';
import { chooseDecoder, normalizeBarcode, pickExactProduct, createDebouncer } from './scan-core.js';
import { mountPhoto } from './photo.js';

const els = {
  stage: document.getElementById('stage'),
  video: document.getElementById('video'),
  reticle: document.getElementById('reticle'),
  status: document.getElementById('status'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  result: document.getElementById('result'),
  unsupported: document.getElementById('unsupported'),
};

const FORMATS_NATIVE = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];

let stream = null;
let engine = null;        // 'native' | 'zxing'
let detector = null;      // native BarcodeDetector
let zxReader = null;      // ZXing MultiFormatReader
let frameCanvas = null;   // reused canvas for ZXing frame grabs
let scanning = false;
let rafId = null;
let frameTick = 0;
const debouncer = createDebouncer({ windowMs: 2500 });

function setStatus(msg) { els.status.textContent = msg; }

function httpsHint() {
  const httpsUrl = `https://${location.hostname}:3443/scan.html`;
  return `The camera needs a secure connection. Open <b>${esc(httpsUrl)}</b> on this phone
    (run <code>npm run gen-cert</code> on the computer first, then accept the one-time security warning).`;
}

function checkSupport() {
  const problems = [];
  if (!window.isSecureContext) problems.push('insecure-context');
  if (!navigator.mediaDevices?.getUserMedia) problems.push('no-getusermedia');
  return { ok: problems.length === 0, problems, hasBarcodeDetector: 'BarcodeDetector' in window };
}

function setupEngine(hasBarcodeDetector) {
  engine = chooseDecoder({ hasBarcodeDetector });
  if (engine === 'native') {
    detector = new window.BarcodeDetector({ formats: FORMATS_NATIVE });
    return true;
  }
  // ZXing fallback
  const ZX = window.ZXing;
  if (!ZX) return false; // vendored bundle failed to load
  zxReader = new ZX.MultiFormatReader();
  const hints = new Map();
  hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
    ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8,
    ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E,
    ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.CODE_39, ZX.BarcodeFormat.ITF,
  ]);
  hints.set(ZX.DecodeHintType.TRY_HARDER, true);
  zxReader.setHints(hints);
  frameCanvas = document.createElement('canvas');
  return true;
}

/** Decode one frame with the active engine. Returns a raw string or null. */
async function detectOnce() {
  if (engine === 'native') {
    const codes = await detector.detect(els.video);
    return codes && codes.length ? codes[0].rawValue : null;
  }
  // ZXing: grab a frame to canvas, decode the luminance bitmap
  const v = els.video;
  if (!v.videoWidth) return null;
  frameCanvas.width = v.videoWidth;
  frameCanvas.height = v.videoHeight;
  frameCanvas.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, 0);
  const ZX = window.ZXing;
  try {
    const lum = new ZX.HTMLCanvasElementLuminanceSource(frameCanvas);
    const bmp = new ZX.BinaryBitmap(new ZX.HybridBinarizer(lum));
    const result = zxReader.decode(bmp);
    return result ? result.getText() : null;
  } catch {
    return null; // NotFoundException etc. = no code in this frame
  } finally {
    zxReader.reset();
  }
}

async function startCamera() {
  els.unsupported.classList.add('hidden');
  const sup = checkSupport();
  if (!sup.ok) {
    els.unsupported.classList.remove('hidden');
    els.unsupported.innerHTML = sup.problems.includes('insecure-context')
      ? httpsHint()
      : 'This browser does not expose camera access (getUserMedia).';
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false,
    });
  } catch (e) {
    els.unsupported.classList.remove('hidden');
    els.unsupported.textContent = `Could not open camera: ${e.message}. Check the browser's camera permission.`;
    return;
  }

  els.video.srcObject = stream;
  await els.video.play();
  els.reticle.classList.remove('hidden');
  els.startBtn.classList.add('hidden');
  els.stopBtn.classList.remove('hidden');

  if (!setupEngine(sup.hasBarcodeDetector)) {
    els.unsupported.classList.remove('hidden');
    els.unsupported.textContent = 'Barcode decoder failed to load (vendor/zxing.min.js). Reload the page.';
    return;
  }

  debouncer.reset();
  scanning = true;
  setStatus(engine === 'native' ? 'Scanning (native detector)…' : 'Scanning (ZXing decoder)…');
  frameTick = 0;
  scanLoop();
}

async function scanLoop() {
  if (!scanning) return;
  let value = null;
  // Native is cheap per frame; ZXing is heavier, so decode ~every 3rd frame.
  const doDecode = engine === 'native' || (++frameTick % 3 === 0);
  if (doDecode) {
    try { value = await detectOnce(); } catch { value = null; }
  }
  if (value) {
    const code = normalizeBarcode(value);
    if (code && debouncer.shouldAccept(code)) { onDetected(code); return; }
  }
  rafId = requestAnimationFrame(scanLoop);
}

/** Pause scanning but KEEP the camera live (requirement 6/8). */
function pauseScanning() {
  scanning = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function stopCamera() {
  pauseScanning();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  els.reticle.classList.add('hidden');
  els.startBtn.classList.remove('hidden');
  els.stopBtn.classList.add('hidden');
  setStatus('Camera stopped.');
}

async function onDetected(barcode) {
  pauseScanning();
  debouncer.lock();                 // suppress further detections while result shows
  setStatus(`Detected: ${barcode}`);
  if (navigator.vibrate) navigator.vibrate(80);

  els.result.innerHTML = '<div class="card muted">Looking up product…</div>';
  let foundProduct = null;
  try {
    const data = await api.products({ search: barcode, limit: 10 });
    foundProduct = pickExactProduct(data.items, barcode);
    els.result.innerHTML = foundProduct ? productCard(foundProduct) : notFoundCard(barcode);
  } catch (e) {
    els.result.innerHTML = `<div class="card errbox">Lookup failed: ${esc(e.message)}</div>${rescanBtn()}`;
  }
  wireResultButtons();
  if (foundProduct) {
    const host = els.result.querySelector('#photoHost');
    if (host) mountPhoto(host, foundProduct, { onBeforeCamera: releaseScannerForPhoto });
  }
}

function rescanBtn() { return '<div class="scan-actions"><button id="rescan">Scan again</button></div>'; }

function notFoundCard(barcode) {
  return `<div class="card">
    <div class="notice"><b>Barcode not found</b><br>Scanned: <b>${esc(barcode)}</b></div>
    ${rescanBtn()}
  </div>`;
}

function productCard(p) {
  return `<div class="card">
    <h2 style="margin-bottom:6px">${esc(p.name)}</h2>
    <div class="kv">
      <div class="k">Barcode</div><div>${esc(p.barcode)}</div>
      <div class="k">UoM</div><div>${esc(p.box_uom || '')}</div>
      <div class="k">Availability</div><div>${p.is_active ? stockPill(p.stock_status) : '<span class="pill muted">Inactive</span>'}</div>
      <div class="k">Free To Use</div><div>${num(p.free_to_use)}</div>
      <div class="k">On Hand</div><div>${num(p.on_hand)}</div>
    </div>
    <div id="photoHost"></div>
    <div class="scan-actions"><button id="rescan" class="ghost">Scan another</button></div>
    <a class="back" style="margin-top:10px" href="index.html#/products/${p.id}">Open full product page →</a>
  </div>`;
}

/** Release the barcode scanner camera so the product-photo camera can open.
 *  (Mobile devices typically allow only one active camera at a time.) */
async function releaseScannerForPhoto() {
  pauseScanning();
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  els.video.srcObject = null;
  els.stage.classList.add('hidden');   // do not keep the scanning camera visible
  els.stopBtn.classList.add('hidden');
  setStatus('Taking product photo…');
}

function wireResultButtons() {
  els.result.querySelector('#rescan')?.addEventListener('click', () => {
    els.result.innerHTML = '';
    debouncer.unlock();
    els.stage.classList.remove('hidden'); // show the scanner camera again
    if (stream && els.video.srcObject) {
      // camera still live — just resume the decode loop
      scanning = true;
      setStatus(engine === 'native' ? 'Scanning (native detector)…' : 'Scanning (ZXing decoder)…');
      frameTick = 0;
      scanLoop();
    } else {
      startCamera(); // scanner camera was released for a photo — re-acquire
    }
  });
}

els.startBtn.addEventListener('click', startCamera);
els.stopBtn.addEventListener('click', stopCamera);
window.addEventListener('pagehide', stopCamera);

// Proactively warn about an insecure context (camera will be blocked).
const sup0 = checkSupport();
if (!sup0.ok && sup0.problems.includes('insecure-context')) {
  els.unsupported.classList.remove('hidden');
  els.unsupported.innerHTML = httpsHint();
}
