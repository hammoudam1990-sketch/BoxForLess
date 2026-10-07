// Copy text to the clipboard.
//
// `navigator.clipboard` only exists in a SECURE CONTEXT. The staff shell is
// normally opened over plain http on the LAN (http://192.168.x.x:3000), where it
// is undefined — which is why Copy once silently did nothing. The hidden-textarea
// + execCommand route still works there, so it is the fallback rather than the
// other way round.
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the http-safe path */ }

  const ta = document.createElement('textarea');
  ta.value = text;
  // off-screen but still focusable; `display:none` cannot be selected
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
