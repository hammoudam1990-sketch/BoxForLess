// A few helpers for building the page with plain DOM calls. No framework, no templates:
// `h('button', { class: 'c-btn', onClick: save }, 'Save')` makes a real <button>.

/**
 * Create an element.
 *   - `class` sets className; `style` may be an object; `onClick` etc. add listeners
 *   - `true` makes a boolean attribute, `false` / null / undefined leave the attribute off
 *   - everything else becomes an attribute (so aria-*, data-*, inputmode, … all just work)
 *   - `value` is set as a property so it survives typing
 * Children may be strings, numbers, nodes, arrays of those, or null/false (ignored).
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'value') el.value = value;
      else if (key.length > 2 && key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

/** Append children (strings, numbers, nodes, nested arrays) to `el`. */
export function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replace everything inside `el` with `children`. */
export function setChildren(el, ...children) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return append(el, children);
}

/** Turn a small piece of trusted SVG markup (one of our own constants) into an element. */
export function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

/** Show or hide an element with the shared `.hidden` class. */
export const toggleHidden = (el, hidden) => el.classList.toggle('hidden', Boolean(hidden));
