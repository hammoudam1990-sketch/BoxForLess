# Mobile / LAN Access (development)

Phase 1 requirement: the Product Master must be reachable from a phone on the
**same Wi-Fi/LAN** as the development computer. This never exposes anything to
the public internet — access is limited to the local subnet (and your router's
NAT already blocks inbound internet traffic).

## Why the phone couldn't connect (diagnosis)
- The server was **already bound to `0.0.0.0`** (all interfaces) — binding was
  *not* the problem.
- **Windows Firewall** had no inbound rule for the port, so it silently dropped
  connections from the phone.
- The Wi-Fi was classified **Public** by Windows (stricter firewall).

## 1. Start the server
```bash
npm start
```
It binds to `0.0.0.0` and prints the exact URLs, e.g.:
```
HTTP  (catalog):  http://192.168.100.8:3000     ← open on phone
HTTPS (camera) :  https://192.168.100.8:3443    ← open on phone for scanning
```
Your LAN IP can change; trust what the server prints. Set `BFL_HOST=127.0.0.1`
to restrict back to local-only.

## 2. Open the firewall (one-time, requires Administrator)
Open **PowerShell as Administrator** and run. This is scoped to the local subnet
only, so it is **not** an internet exposure:

```powershell
# (recommended) mark this trusted Wi-Fi as Private
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi 3" -NetworkCategory Private

# allow the two dev ports, LAN-only
New-NetFirewallRule -DisplayName "Box for Less Product Master (LAN)" `
  -Direction Inbound -Action Allow -Protocol TCP `
  -LocalPort 3000,3443 -Profile Any -RemoteAddress LocalSubnet
```

Remove it later with:
```powershell
Remove-NetFirewallRule -DisplayName "Box for Less Product Master (LAN)"
```

## 3. On the phone
- Same Wi-Fi as the computer.
- **Browsing the catalog:** open the `http://<ip>:3000` URL.
- **Camera / barcode scanning:** open the `https://<ip>:3443` URL and accept the
  one-time "not secure" warning (self-signed dev certificate).

## HTTPS / camera — why it's required
Browser camera access (`getUserMedia`) and the native `BarcodeDetector` only run
in a **secure context**: `https://` or `http://localhost`. Over `http://<lan-ip>`
the camera is blocked by the browser. Generate a local dev certificate once:
```bash
npm run gen-cert   # writes certs/key.pem + certs/cert.pem (SAN includes your LAN IP)
```
Then restart the server; HTTPS starts automatically on port 3443.

## Barcode-camera workflow (architecture — scaffolded, not Phase 2)
`scan.html` + `js/scan.js` implement the real pipeline:
```
Scan (camera + BarcodeDetector) → Find (GET /api/products) → Show product
   → Take photo (capture still) → Preview        ┐ Phase 2 (Image Library):
   → Save                                         ┘ persistence is DISABLED now
```
- Uses the real device camera — **no fake barcode text input**.
- **Decoder:** native `BarcodeDetector` is preferred; **ZXing** (vendored locally
  at `src/public/vendor/zxing.min.js`, no CDN) is the automatic fallback for
  browsers without it (e.g. iPhone Safari). Both decode the same live camera.
  Refresh the vendored bundle after upgrades with `node scripts/vendor-zxing.js`.
- Detections are normalized and **debounced** (same barcode suppressed within a
  2.5s window; further scans paused while a result is shown). Unknown barcodes
  show "Barcode not found" with a Scan-again action.
- **Product photo save is implemented.** A dedicated rear-camera capture (the
  barcode camera is released first) → capture still → Retake/Save → the image is
  resized (≤1280px) and JPEG-compressed client-side, validated server-side
  (type + magic bytes + ≤5MB), stored on disk under `data/product-images/`, and
  linked to the stable `products.id` via `product_images` + `primary_image_id`.
  Replacing an existing photo requires explicit confirmation. Saved images are
  reloaded from the backend and survive refresh.
