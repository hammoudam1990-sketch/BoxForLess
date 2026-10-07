import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCaptureRotation, rotatedDimensions, isIOSDevice } from '../src/public/js/orientation.js';

// Shorthands for the two platform families.
const ios = (o) => computeCaptureRotation({ isIOS: true, facingMode: 'environment', ...o });
const other = (o) => computeCaptureRotation({ isIOS: false, ...o });

// ---------------------------------------------------------------------------
// THE REAL DEVICE CASE. These exact numbers came off the iPhone diagnostic for
// the capture that saved sideways:  frame 480x640, screen 0deg, rotation 0deg.
// The old shape-mismatch rule returned 0 here; the correction is +90 CW.
// ---------------------------------------------------------------------------
test('REGRESSION (real iPhone): rear camera, frame 480x640, angle 0 -> 90 CW', () => {
  assert.equal(ios({ videoWidth: 480, videoHeight: 640, screenAngle: 0 }), 90);
});

test('the reported frame SHAPE does not change the iOS answer (shape is UI-corrected, pixels are not)', () => {
  // portrait-shaped and landscape-shaped frames at the same angle agree:
  // on iOS the shape carries no information about the pixels.
  assert.equal(
    ios({ videoWidth: 480, videoHeight: 640, screenAngle: 0 }),
    ios({ videoWidth: 1280, videoHeight: 720, screenAngle: 0 }),
  );
});

// iOS: the sensor frame is fixed to the phone body, so turning the device
// subtracts from the correction -> rotation = (90 - screenAngle) mod 360.
test('iOS rear camera: angle 90 -> 0', () => {
  assert.equal(ios({ videoWidth: 640, videoHeight: 480, screenAngle: 90 }), 0);
});
test('iOS rear camera: angle 180 (upside-down portrait) -> 270', () => {
  assert.equal(ios({ videoWidth: 480, videoHeight: 640, screenAngle: 180 }), 270);
});
test('iOS rear camera: angle 270 -> 180', () => {
  assert.equal(ios({ videoWidth: 640, videoHeight: 480, screenAngle: 270 }), 180);
});

test('iOS angles are normalized (360/-360/-90 and odd readings snap to quarter turns)', () => {
  assert.equal(ios({ videoWidth: 480, videoHeight: 640, screenAngle: 360 }), 90);
  assert.equal(ios({ videoWidth: 480, videoHeight: 640, screenAngle: -360 }), 90);
  assert.equal(ios({ videoWidth: 480, videoHeight: 640, screenAngle: -90 }), 180); // -90 == 270
  assert.equal(ios({ videoWidth: 480, videoHeight: 640, screenAngle: 2 }), 90);    // snaps to 0
});

// ---------------------------------------------------------------------------
// NON-iOS MUST NOT BE TOUCHED (requirements 9 + 10).
// ---------------------------------------------------------------------------
test('desktop webcam (1280x720, angle 0) -> 0, NOT rotated', () => {
  // The previous shape-mismatch rule returned 90 here, silently rotating every
  // desktop capture. This test locks that regression out.
  assert.equal(other({ videoWidth: 1280, videoHeight: 720, screenAngle: 0 }), 0);
});
test('Android portrait (720x1280, angle 0) -> 0', () => {
  assert.equal(other({ videoWidth: 720, videoHeight: 1280, screenAngle: 0 }), 0);
});
test('Android landscape (1280x720, angle 90) -> 0', () => {
  assert.equal(other({ videoWidth: 1280, videoHeight: 720, screenAngle: 90 }), 0);
});
test('non-iOS is never rotated at any angle', () => {
  for (const screenAngle of [0, 90, 180, 270, -90, 360]) {
    assert.equal(other({ videoWidth: 1280, videoHeight: 720, screenAngle }), 0);
    assert.equal(other({ videoWidth: 720, videoHeight: 1280, screenAngle }), 0);
  }
});

test('iOS FRONT camera is excluded from the correction (mirrored, never reported broken)', () => {
  assert.equal(
    computeCaptureRotation({ videoWidth: 480, videoHeight: 640, screenAngle: 0, isIOS: true, facingMode: 'user' }),
    0,
  );
});

test('an unmeasurable frame is never rotated', () => {
  assert.equal(ios({ videoWidth: 0, videoHeight: 0, screenAngle: 0 }), 0);
  assert.equal(computeCaptureRotation({}), 0);
});

// ---------------------------------------------------------------------------
// Platform gate.
// ---------------------------------------------------------------------------
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_OLD_UA = 'Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const IPADOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC_UA = IPADOS_UA;
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Mobile Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

test('isIOSDevice: iPhone and older iPad are detected', () => {
  assert.equal(isIOSDevice({ userAgent: IPHONE_UA, maxTouchPoints: 5 }), true);
  assert.equal(isIOSDevice({ userAgent: IPAD_OLD_UA, maxTouchPoints: 5 }), true);
});
test('isIOSDevice: iPadOS 13+ desktop-class UA is detected via touch points', () => {
  assert.equal(isIOSDevice({ userAgent: IPADOS_UA, platform: 'MacIntel', maxTouchPoints: 5 }), true);
});
test('isIOSDevice: a real Mac (same UA, no touch) is NOT iOS', () => {
  assert.equal(isIOSDevice({ userAgent: MAC_UA, platform: 'MacIntel', maxTouchPoints: 0 }), false);
});
test('isIOSDevice: Android and Windows are NOT iOS', () => {
  assert.equal(isIOSDevice({ userAgent: ANDROID_UA, maxTouchPoints: 5 }), false);
  assert.equal(isIOSDevice({ userAgent: WINDOWS_UA, maxTouchPoints: 0 }), false);
  assert.equal(isIOSDevice({}), false);
  assert.equal(isIOSDevice(), false);
});

// End-to-end through the real gate: an iPhone navigator must yield the 90 CW
// correction, a Windows one must yield none.
test('platform gate wired to the rotation: iPhone -> 90, Windows -> 0', () => {
  const frame = { videoWidth: 480, videoHeight: 640, screenAngle: 0, facingMode: 'environment' };
  const iphone = { userAgent: IPHONE_UA, maxTouchPoints: 5 };
  const windows = { userAgent: WINDOWS_UA, maxTouchPoints: 0 };
  assert.equal(computeCaptureRotation({ ...frame, isIOS: isIOSDevice(iphone) }), 90);
  assert.equal(computeCaptureRotation({ ...frame, isIOS: isIOSDevice(windows) }), 0);
});

// ---------------------------------------------------------------------------
// Dimensions.
// ---------------------------------------------------------------------------
test('rotatedDimensions swaps W/H only for quarter turns', () => {
  assert.deepEqual(rotatedDimensions(480, 640, 90), { width: 640, height: 480 });
  assert.deepEqual(rotatedDimensions(480, 640, 270), { width: 640, height: 480 });
  assert.deepEqual(rotatedDimensions(480, 640, 180), { width: 480, height: 640 });
  assert.deepEqual(rotatedDimensions(480, 640, 0), { width: 480, height: 640 });
});

test('the real iPhone capture ends up 640x480 after its 90 CW correction', () => {
  const rot = ios({ videoWidth: 480, videoHeight: 640, screenAngle: 0 });
  assert.deepEqual(rotatedDimensions(480, 640, rot), { width: 640, height: 480 });
});
