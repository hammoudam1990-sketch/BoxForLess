// The customer catalogue's own, deliberately tiny fetch helper.
//
// It is NOT the staff client (../api.js): that file knows about customer access
// codes and other internal endpoints, and none of it may reach a customer's phone.
// The catalogue talks only to /api/catalog, whose payloads are customer-safe.

/**
 * GET/POST JSON. On failure throws an Error carrying `.status` and `.body` (the
 * parsed error response), so callers can react to the server's error `code`.
 */
export async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const postJSON = (url, data) => getJSON(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});
