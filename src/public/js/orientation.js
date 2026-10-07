// Deterministic capture-orientation logic (pure, DOM-free, unit-tested).
//
// ROOT CAUSE (confirmed on a real iPhone, 2026-10-02)
// ---------------------------------------------------
// On iOS Safari the rear-camera MediaStream reports the dimensions of the
// CURRENT UI ORIENTATION, while drawImage(video,…) copies the pixels in the
// camera SENSOR's own fixed frame. Device diagnostic from the failing capture:
//
//     frame 480x640   screen 0deg   rotation 0deg   saved 480x640  -> sideways
//
// The frame was reported PORTRAIT (480x640) and the device WAS portrait, so the
// previous "frame shape vs device shape mismatch" rule saw no mismatch and
// returned 0. The shape comparison is structurally blind to this device: the
// reported shape is already corrected, only the pixels are not.
//
// THE MODEL
// ---------
// The iPhone rear sensor's frame is FIXED relative to the phone body, and its
// "up" sits a quarter turn counter-clockwise from upright when the phone is held
// portrait. So a portrait capture needs +90deg CLOCKWISE. Rotating the device by
// `screen.orientation.angle` rotates the UI but not the sensor, so the required
// correction is simply:
//
//     rotation = (90 - screenAngle) mod 360
//
// The +90 at angle 0 is the device-measured fact; the subtraction is the fixed
// sensor following the device. Verified against the bad photo two ways: its text
// reads bottom-to-top, and the package's sun logo sits at the image bottom where
// the real package has it on the left - both restored by a 90deg CW turn.
//
// EVERYTHING ELSE IS LEFT ALONE
// -----------------------------
// Desktop, Android and any non-iOS browser deliver frames whose pixels already
// match what was on screen, so they get 0. (The previous shape-mismatch rule
// would have rotated a normal 1280x720 desktop webcam by 90deg at angle 0 - the
// desktop case was never actually safe. It is now.)
// The iOS FRONT camera is also excluded: it is mirrored and was never reported
// broken, so it stays on the no-rotation path.

/** Normalize any angle (negative, >360, fractional) to one of 0/90/180/270. */
function normalizeAngle(angle) {
  const a = (((Math.round(Number(angle) || 0)) % 360) + 360) % 360;
  // snap to the nearest quarter turn so odd readings can't produce odd rotations
  return (Math.round(a / 90) * 90) % 360;
}

/**
 * Is this an iOS device? All iOS browsers are WebKit and share the camera
 * behaviour above, so the OS - not the browser brand - is the right gate.
 * iPadOS 13+ masquerades as "Macintosh", hence the touch-point check.
 * @param {{userAgent?:string, platform?:string, maxTouchPoints?:number}} nav
 */
export function isIOSDevice(nav = {}) {
  const ua = String(nav.userAgent || '');
  const platform = String(nav.platform || '');
  const touch = Number(nav.maxTouchPoints || 0);
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;
  // iPadOS 13+ desktop-class UA: "Macintosh" + a touchscreen
  if (/Macintosh/.test(ua) && touch > 1) return true;
  if (platform === 'MacIntel' && touch > 1) return true;
  return false;
}

/**
 * Clockwise degrees to rotate a captured frame so its PIXELS are upright.
 * @param {object} info
 * @param {number} info.videoWidth
 * @param {number} info.videoHeight
 * @param {number} [info.screenAngle]  screen.orientation.angle (or window.orientation)
 * @param {boolean} [info.isIOS]       from isIOSDevice(navigator)
 * @param {string} [info.facingMode]   track facingMode; 'user' = front camera
 * @returns {0|90|180|270}
 */
export function computeCaptureRotation({
  videoWidth,
  videoHeight,
  screenAngle = 0,
  isIOS = false,
  facingMode = 'environment',
} = {}) {
  // Guard against a frame that isn't ready; never rotate what we can't measure.
  if (!Number(videoWidth) || !Number(videoHeight)) return 0;

  const isFrontCamera = String(facingMode) === 'user';
  if (isIOS && !isFrontCamera) {
    return /** @type {0|90|180|270} */ (normalizeAngle(90 - normalizeAngle(screenAngle)));
  }

  // Non-iOS (and the iOS front camera): the browser already hands over pixels
  // matching what the user saw. Rotating here is what breaks correct devices.
  return 0;
}

/** Output dimensions after rotating a (w x h) frame by the given rotation. */
export function rotatedDimensions(width, height, rotation) {
  return (rotation === 90 || rotation === 270)
    ? { width: height, height: width }
    : { width, height };
}

export default computeCaptureRotation;
