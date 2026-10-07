// React without a build step.
//
// The pages load vendor/react.min.js, vendor/react-dom.min.js and vendor/htm.min.js
// with ordinary <script> tags BEFORE the module entry point, which leaves React,
// ReactDOM and htm on `window`. This module re-exports them so every component
// can write `import { html, useState } from '../lib/react.js'` and use tagged
// templates instead of JSX:
//
//     html`<button class="ghost" onClick=${save}>Save</button>`
//
// htm turns that template into React.createElement calls at runtime. Nothing is
// compiled, bundled or transpiled, and nothing is fetched from a CDN.
const { React, ReactDOM, htm } = window;

if (!React || !ReactDOM || !htm) {
  throw new Error('React did not load. Check that /vendor/react.min.js, react-dom.min.js and htm.min.js are served.');
}

// htm passes attribute names through untouched, so `class=` and `for=` would reach
// React as unknown props. Translate them once here, which lets templates read as
// plain HTML.
function h(type, props, ...children) {
  if (props && typeof type === 'string') {
    if ('class' in props) { props.className = props.class; delete props.class; }
    if ('for' in props) { props.htmlFor = props.for; delete props.for; }
  }
  return React.createElement(type, props, ...children);
}

const render = htm.bind(h);

// A template with several top-level elements makes htm return an ARRAY, which React
// treats as a keyed list and warns about. Those children are written out by hand,
// not generated, so wrap them in a Fragment instead.
export function html(...args) {
  const out = render(...args);
  return Array.isArray(out) ? React.createElement(React.Fragment, null, ...out) : out;
}

export const {
  Component, Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback,
  useContext, createContext, useReducer, useId,
} = React;

export const { createRoot } = ReactDOM;

/** Mount `Root` into the element with the given id. */
export function mount(Root, id = 'root') {
  const node = document.getElementById(id);
  if (!node) throw new Error(`No #${id} element to mount into.`);
  createRoot(node).render(html`<${Root} />`);
}
