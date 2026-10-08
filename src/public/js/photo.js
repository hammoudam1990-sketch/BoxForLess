// Product-photo workflow: a dedicated rear-camera capture/save flow rendered
// into the product card. Manages its OWN camera stream (the barcode scanner
// must be released first — see onBeforeCamera). Persists via the real image API.
//
// States: IDLE -> LIVE -> CAPTURED -> (SAVING) -> SAVED  (Retake/Cancel loop back)
import { api, esc, toast } from './api.js';
import { computeCaptureRotation, rotatedDimensions, isIOSDevice } from './orientation.js';

const MAX_DIM = 1280;     // downscale longest edge
const JPEG_QUALITY = 0.7; // compress mobile photos so storage stays small

/** Physically rotate a canvas's pixels. Returns the source unchanged for 0. */
function rotateCanvas(src, rotation) {
  if (!rotation) return src;
  const d = rotatedDimensions(src.width, src.height, rotation);
  const c = document.createElement('canvas');
  c.width = d.width; c.height = d.height;
  const ctx = c.getContext('2d');
  switch (rotation) {
    case 90: ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); break;
    case 180: ctx.translate(c.width, c.height); ctx.rotate(Math.PI); break;
    case 270: ctx.translate(0, c.height); ctx.rotate(-Math.PI / 2); break;
    default: break;
  }
  ctx.drawImage(src, 0, 0);
  return c;
}

/** Downscale so the longest edge is <= maxDim (unchanged requirement). */
function downscaleCanvas(src, maxDim) {
  const longest = Math.max(src.width, src.height);
  if (longest <= maxDim) return src;
  const s = maxDim / longest;
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * s);
  c.height = Math.round(src.height * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * @param {HTMLElement} host - element to render the photo section into
 * @param {object} product - must include id and primary_image_id
 * @param {{onBeforeCamera?:Function}} hooks - called before opening the camera
 *        (scan.js uses it to release the barcode camera so only one is active)
 */
export function mountPhoto(host, product, hooks = {}) {
  const pid = product.id;
  const hadImage = !!product.primary_image_id;
  let stream = null;
  let capturedBlob = null;
  let capturedUrl = null;
  let replacing = hadImage;
  let lastDiag = ''; // temporary capture diagnostics for on-device verification
  let baseCanvas = null;  // oriented + downscaled pixels, kept pre-compression so
                          // a manual rotate never re-compresses an already-JPEG image
  let manualRotation = 0; // user's extra quarter turns from the preview control

  host.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = 'Product photo';
  const area = document.createElement('div');
  area.id = 'photoArea';
  host.append(title, area);

  function cleanupStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }
  function revoke() { if (capturedUrl) { URL.revokeObjectURL(capturedUrl); capturedUrl = null; } }

  function renderIdle() {
    cleanupStream();
    const imgTag = replacing
      ? `<img class="saved-photo" src="${api.productImageUrl(pid)}?t=${Date.now()}" alt="Saved product photo" />`
      : '<div class="img-ph">No photo yet</div>';
    area.innerHTML = `${imgTag}
      <div class="scan-actions">
        <button id="takePhoto" class="secondary">${replacing ? 'Replace photo' : 'Take product photo'}</button>
      </div>`;
    area.querySelector('#takePhoto').addEventListener('click', startPhotoCamera);
  }

  async function startPhotoCamera() {
    try { await hooks.onBeforeCamera?.(); } catch { /* ignore */ }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false,
      });
    } catch (e) {
      toast(`Camera error: ${e.message}`, 'err');
      renderIdle();
      return;
    }
    area.innerHTML = `
      <div class="scan-stage"><video id="photoVideo" playsinline muted></video></div>
      <div class="scan-actions">
        <button id="capture">Capture</button>
        <button id="cancelPhoto" class="ghost">Cancel</button>
      </div>`;
    const v = area.querySelector('#photoVideo');
    v.srcObject = stream;
    await v.play();
    area.querySelector('#capture').addEventListener('click', () => capture(v));
    area.querySelector('#cancelPhoto').addEventListener('click', renderIdle);
  }

  /** Current screen orientation angle, with the pre-iOS-16.4 fallback. */
  function readScreenAngle() {
    const so = window.screen && window.screen.orientation;
    if (so && typeof so.angle === 'number') return so.angle;
    return typeof window.orientation === 'number' ? window.orientation : 0;
  }

  /** What the camera track actually gave us (iOS may omit fields). */
  function readTrackSettings() {
    try {
      const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
      return (track && track.getSettings) ? track.getSettings() : {};
    } catch { return {}; }
  }

  async function capture(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw) { toast('Camera not ready yet', 'err'); return; }

    // 1) normalize orientation: physically rotate the raw frame so the STORED
    //    PIXELS are upright, with no reliance on EXIF metadata. On iOS Safari the
    //    reported frame shape is already UI-corrected while the pixels are not,
    //    so the decision comes from the platform + screen angle, never the shape.
    const screenAngle = readScreenAngle();
    const settings = readTrackSettings();
    const isIOS = isIOSDevice(navigator);
    const facingMode = settings.facingMode || 'environment';
    const rotation = computeCaptureRotation({
      videoWidth: vw, videoHeight: vh, screenAngle, isIOS, facingMode,
    });

    const raw = document.createElement('canvas');
    raw.width = vw; raw.height = vh;
    raw.getContext('2d').drawImage(video, 0, 0, vw, vh);

    // 2) downscale to MAX_DIM longest edge (preserved requirement)
    baseCanvas = downscaleCanvas(rotateCanvas(raw, rotation), MAX_DIM);
    manualRotation = 0;

    cleanupStream(); // release the photo camera after capturing the still

    // Capture diagnostics: everything needed to diagnose a wrong result on a real
    // device without another round trip (removable once confirmed upright).
    lastDiag = `diag: frame ${vw}×${vh}, track ${settings.width || '?'}×${settings.height || '?'}, `
      + `screen ${screenAngle}°, ${isIOS ? 'iOS' : 'non-iOS'}/${facingMode}, auto ${rotation}°`;

    if (!await refreshPreview()) { toast('Capture failed', 'err'); renderIdle(); }
  }

  /** Re-encode the preview from the pre-compression canvas + any manual turns. */
  async function refreshPreview() {
    if (!baseCanvas) return false;
    const out = rotateCanvas(baseCanvas, manualRotation);
    // 3) compress (preserved JPEG compression)
    const blob = await new Promise((res) => out.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    if (!blob) return false;
    capturedBlob = blob;
    revoke();
    capturedUrl = URL.createObjectURL(blob);
    renderCaptured(out.width, out.height);
    return true;
  }

  /** Manual safety net: the user can turn the photo upright before saving. */
  async function rotatePreview() {
    manualRotation = (manualRotation + 90) % 360;
    await refreshPreview();
  }

  function renderCaptured(outW, outH) {
    const diag = lastDiag
      ? `${lastDiag}, manual ${manualRotation}°, saved ${outW}×${outH}`
      : '';
    area.innerHTML = `
      <img class="saved-photo" src="${capturedUrl}" alt="Captured preview" />
      <div class="scan-actions">
        <button id="savePhoto">Save photo</button>
        <button id="rotatePhoto" class="secondary">Rotate ↻</button>
        <button id="retake" class="ghost">Retake</button>
      </div>
      <div id="saveMsg" class="scan-status"></div>
      ${diag ? `<div class="scan-status" style="font-size:11px;opacity:.7">${esc(diag)}</div>` : ''}`;
    const saveBtn = area.querySelector('#savePhoto');
    saveBtn.disabled = !capturedBlob; // enabled only when a valid capture exists
    saveBtn.addEventListener('click', save);
    area.querySelector('#rotatePhoto').addEventListener('click', rotatePreview);
    area.querySelector('#retake').addEventListener('click', startPhotoCamera);
  }

  async function save() {
    if (!capturedBlob) { toast('No captured image to save', 'err'); return; }
    // explicit replacement confirmation (requirement 6)
    if (replacing && !window.confirm('Replace the existing product photo?')) return;

    const saveBtn = area.querySelector('#savePhoto');
    const retakeBtn = area.querySelector('#retake');
    const msg = area.querySelector('#saveMsg');
    saveBtn.disabled = true; retakeBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    msg.textContent = 'Uploading and saving…';

    try {
      await api.saveProductImage(pid, capturedBlob, { replace: replacing });
      // reload from backend rather than trusting the local preview (req 11/12)
      replacing = true;
      capturedBlob = null; baseCanvas = null; manualRotation = 0; revoke();
      toast('Photo saved', 'ok');
      renderSaved();
    } catch (e) {
      if (e.code === 'REPLACE_CONFIRM_REQUIRED') {
        // server-side guard; retry once with explicit confirmation
        if (window.confirm('This product already has a photo. Replace it?')) {
          try {
            await api.saveProductImage(pid, capturedBlob, { replace: true });
            replacing = true; capturedBlob = null; baseCanvas = null; manualRotation = 0; revoke();
            toast('Photo saved', 'ok');
            renderSaved();
            return;
          } catch (e2) { msg.textContent = `Save failed: ${esc(e2.message)}`; }
        } else {
          msg.textContent = 'Save cancelled.';
        }
      } else {
        msg.textContent = `Save failed: ${esc(e.message)}`;
      }
      saveBtn.disabled = false; retakeBtn.disabled = false; saveBtn.textContent = 'Save photo';
    }
  }

  function renderSaved() {
    area.innerHTML = `
      <div class="okbox">✓ Photo saved to the Product Master.</div>
      <img class="saved-photo" src="${api.productImageUrl(pid)}?t=${Date.now()}" alt="Saved product photo" />
      <div class="scan-actions">
        <button id="takePhoto" class="secondary">Replace photo</button>
      </div>`;
    area.querySelector('#takePhoto').addEventListener('click', startPhotoCamera);
  }

  // teardown when leaving
  window.addEventListener('pagehide', cleanupStream, { once: true });

  renderIdle();
  return { destroy() { cleanupStream(); revoke(); } };
}

export default mountPhoto;
