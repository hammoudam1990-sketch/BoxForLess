// Product-photo workflow: a dedicated rear-camera capture/save flow rendered into
// the product card. Manages its OWN camera stream (the barcode scanner must be
// released first — see onBeforeCamera). Persists via the real image API.
//
// Phases: idle -> live -> captured -> (saving) -> saved   (Retake / Cancel loop back)
import { html, useState, useEffect, useRef } from '../lib/react.js';
import { api } from '../api.js';
import { useToast } from '../staff/ui.js';
import { computeCaptureRotation, rotatedDimensions, isIOSDevice } from '../orientation.js';

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

/** Downscale so the longest edge is <= maxDim. */
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

/** Current screen orientation angle, with the pre-iOS-16.4 fallback. */
function readScreenAngle() {
  const so = window.screen && window.screen.orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

/** What the camera track actually gave us (iOS may omit fields). */
function readTrackSettings(stream) {
  try {
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    return (track && track.getSettings) ? track.getSettings() : {};
  } catch { return {}; }
}

/** The live camera preview: attaches the stream once, then plays it. */
function LiveVideo({ stream, videoRef }) {
  const ref = videoRef;
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    v.play().catch(() => { /* autoplay refusal is not fatal; the user can still Capture */ });
  }, [stream]);
  return html`<video ref=${ref} playsInline=${true} muted=${true}></video>`;
}

/**
 * @param {{id:number, primary_image_id?:number|null}} product
 * @param {() => Promise<void>} [onBeforeCamera] called before opening the camera —
 *        the scanner uses it to release the barcode camera so only one is active.
 */
export function PhotoCapture({ product, onBeforeCamera }) {
  const toast = useToast();
  const pid = product.id;
  const videoRef = useRef(null);

  const [phase, setPhase] = useState('idle');       // idle | live | captured | saved
  const [replacing, setReplacing] = useState(!!product.primary_image_id);
  const [stream, setStream] = useState(null);       // only while phase === 'live'
  const [preview, setPreview] = useState(null);     // { url, diag } while captured
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  // a fresh timestamp each time the saved photo is shown, so a replaced photo is
  // re-fetched instead of served from the browser cache
  const [bust, setBust] = useState(() => Date.now());

  // Mutable capture state that never drives rendering.
  const work = useRef({
    stream: null,
    blob: null,
    baseCanvas: null,   // oriented + downscaled pixels, kept pre-compression so a
                        // manual rotate never re-compresses an already-JPEG image
    manualRotation: 0,  // the user's extra quarter turns from the preview control
    url: null,
    diag: '',           // capture diagnostics for on-device verification
  }).current;

  const stopStream = () => {
    if (work.stream) { work.stream.getTracks().forEach((t) => t.stop()); work.stream = null; }
    setStream(null);
  };
  const revoke = () => { if (work.url) { URL.revokeObjectURL(work.url); work.url = null; } };

  // teardown when leaving the page or the product
  useEffect(() => {
    const release = () => { if (work.stream) work.stream.getTracks().forEach((t) => t.stop()); };
    window.addEventListener('pagehide', release);
    return () => { window.removeEventListener('pagehide', release); release(); revoke(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toIdle = () => { stopStream(); setBust(Date.now()); setPhase('idle'); };

  const startCamera = async () => {
    try { await onBeforeCamera?.(); } catch { /* ignore */ }
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (e) {
      toast(`Camera error: ${e.message}`, 'err');
      toIdle();
      return;
    }
    work.stream = s;
    setStream(s);
    setPhase('live');
  };

  /** Re-encode the preview from the pre-compression canvas + any manual turns. */
  const refreshPreview = async () => {
    if (!work.baseCanvas) return false;
    const out = rotateCanvas(work.baseCanvas, work.manualRotation);
    const blob = await new Promise((res) => { out.toBlob(res, 'image/jpeg', JPEG_QUALITY); }); // compress
    if (!blob) return false;
    work.blob = blob;
    revoke();
    work.url = URL.createObjectURL(blob);
    setPreview({
      url: work.url,
      diag: work.diag ? `${work.diag}, manual ${work.manualRotation}°, saved ${out.width}×${out.height}` : '',
    });
    return true;
  };

  const capture = async (video) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw) { toast('Camera not ready yet', 'err'); return; }

    // 1) normalize orientation: physically rotate the raw frame so the STORED
    //    PIXELS are upright, with no reliance on EXIF metadata. On iOS Safari the
    //    reported frame shape is already UI-corrected while the pixels are not, so
    //    the decision comes from the platform + screen angle, never the shape.
    const screenAngle = readScreenAngle();
    const settings = readTrackSettings(work.stream);
    const isIOS = isIOSDevice(navigator);
    const facingMode = settings.facingMode || 'environment';
    const rotation = computeCaptureRotation({ videoWidth: vw, videoHeight: vh, screenAngle, isIOS, facingMode });

    const raw = document.createElement('canvas');
    raw.width = vw; raw.height = vh;
    raw.getContext('2d').drawImage(video, 0, 0, vw, vh);

    // 2) downscale to MAX_DIM longest edge
    work.baseCanvas = downscaleCanvas(rotateCanvas(raw, rotation), MAX_DIM);
    work.manualRotation = 0;

    stopStream(); // release the photo camera after capturing the still

    // everything needed to diagnose a wrong result on a real device without another round trip
    work.diag = `diag: frame ${vw}×${vh}, track ${settings.width || '?'}×${settings.height || '?'}, `
      + `screen ${screenAngle}°, ${isIOS ? 'iOS' : 'non-iOS'}/${facingMode}, auto ${rotation}°`;

    setSaveMsg('');
    if (await refreshPreview()) setPhase('captured');
    else { toast('Capture failed', 'err'); toIdle(); }
  };

  const rotate = async () => {
    work.manualRotation = (work.manualRotation + 90) % 360;
    await refreshPreview();
  };

  const finishSave = () => {
    setReplacing(true);
    work.blob = null; work.baseCanvas = null; work.manualRotation = 0;
    revoke();
    setPreview(null);
    setBust(Date.now());
    toast('Photo saved', 'ok');
    setPhase('saved');
  };

  const save = async () => {
    if (!work.blob) { toast('No captured image to save', 'err'); return; }
    // explicit replacement confirmation
    if (replacing && !window.confirm('Replace the existing product photo?')) return;

    setSaving(true);
    setSaveMsg('Uploading and saving…');
    try {
      await api.saveProductImage(pid, work.blob, { replace: replacing });
      finishSave();
    } catch (e) {
      if (e.code === 'REPLACE_CONFIRM_REQUIRED') {
        // server-side guard; retry once with explicit confirmation
        if (window.confirm('This product already has a photo. Replace it?')) {
          try {
            await api.saveProductImage(pid, work.blob, { replace: true });
            finishSave();
            setSaving(false);
            return;
          } catch (e2) { setSaveMsg(`Save failed: ${e2.message}`); }
        } else {
          setSaveMsg('Save cancelled.');
        }
      } else {
        setSaveMsg(`Save failed: ${e.message}`);
      }
    }
    setSaving(false);
  };

  const savedImage = html`<img class="saved-photo" src=${`${api.productImageUrl(pid)}?t=${bust}`} alt="Saved product photo" />`;
  const replaceButton = html`<div class="scan-actions"><button class="secondary" onClick=${startCamera}>Replace photo</button></div>`;

  return html`
    <div class="section-title">Product photo</div>
    <div>
      ${phase === 'idle' ? html`
        ${replacing ? savedImage : html`<div class="img-ph">No photo yet</div>`}
        <div class="scan-actions">
          <button class="secondary" onClick=${startCamera}>${replacing ? 'Replace photo' : 'Take product photo'}</button>
        </div>` : null}

      ${phase === 'live' ? html`
        <div class="scan-stage"><${LiveVideo} stream=${stream} videoRef=${videoRef} /></div>
        <div class="scan-actions">
          <button onClick=${() => capture(videoRef.current)}>Capture</button>
          <button class="ghost" onClick=${toIdle}>Cancel</button>
        </div>` : null}

      ${phase === 'captured' && preview ? html`
        <img class="saved-photo" src=${preview.url} alt="Captured preview" />
        <div class="scan-actions">
          <button disabled=${saving} onClick=${save}>${saving ? 'Saving…' : 'Save photo'}</button>
          <button class="secondary" disabled=${saving} onClick=${rotate}>Rotate ↻</button>
          <button class="ghost" disabled=${saving} onClick=${startCamera}>Retake</button>
        </div>
        <div class="scan-status">${saveMsg}</div>
        ${preview.diag ? html`<div class="scan-status" style=${{ fontSize: 11, opacity: 0.7 }}>${preview.diag}</div>` : null}` : null}

      ${phase === 'saved' ? html`
        <div class="okbox">✓ Photo saved to the Product Master.</div>
        ${savedImage}
        ${replaceButton}` : null}
    </div>`;
}

export default PhotoCapture;
