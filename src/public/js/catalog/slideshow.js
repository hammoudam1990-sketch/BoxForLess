import { h, svg } from '../lib/dom.js';

const INTERVAL = 6500;
const IMAGES = [
  { src: '/img/shop-slide-warehouse.webp', alt: 'Box for Less cartons in a wholesale warehouse', label: 'Your wholesale partner', width: 1152, height: 768 },
  { src: '/img/shop-slide-sugar.webp', alt: 'Haytara Royal Crystal Sugar package', label: 'Everyday essentials', width: 736, height: 1104 },
  { src: '/img/shop-slide-biscuits.webp', alt: 'Box of chocolate biscuits', label: 'Products for your shop', width: 736, height: 1308 },
];
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

export function mountSlideshow(container) {
  let current = 0;
  let timer = null;
  let enabled = true;
  let hovered = false;
  let focused = false;
  let touchStart = null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const slides = IMAGES.map(({ src, alt, label, width, height }, index) => {
    const figure = h('figure', { class: `c-slide c-slide-${index + 1}`, hidden: index !== 0 },
      h('img', { src, alt, width, height, decoding: 'async', loading: index === 0 ? 'eager' : 'lazy' }),
      h('span', { class: 'c-slide-fallback', hidden: true }, 'This image is temporarily unavailable.'));
    figure.querySelector('img').addEventListener('error', () => {
      figure.classList.add('c-slide-failed');
      figure.querySelector('.c-slide-fallback').hidden = false;
    });
    return figure;
  });
  const dots = IMAGES.map(({ label }, index) => h('button', {
    type: 'button',
    class: 'c-slide-dot',
    'aria-label': `Show slide ${index + 1}: ${label}`,
    'aria-pressed': String(index === 0),
    onClick: () => select(index),
  }));
  const previous = h('button', {
    type: 'button', class: 'c-slide-arrow c-slide-previous', 'aria-label': 'Previous slide',
    onClick: () => select(current - 1),
  }, svg(ARROW));
  const next = h('button', {
    type: 'button', class: 'c-slide-arrow c-slide-next', 'aria-label': 'Next slide',
    onClick: () => select(current + 1),
  }, svg(ARROW));
  const indicators = h('div', { class: 'c-slide-indicators', 'aria-label': 'Choose a featured image' }, dots);
  const stage = h('div', {
    class: 'c-slideshow',
    role: 'region',
    'aria-roledescription': 'carousel',
    'aria-label': 'Featured products and wholesale',
    onPointerEnter: () => { hovered = true; stop(); },
    onPointerLeave: () => { hovered = false; schedule(); },
    onFocusin: () => { focused = true; stop(); },
    onFocusout: (event) => {
      if (container.contains(event.relatedTarget)) return;
      focused = false;
      schedule();
    },
    onPointerdown: (event) => {
      if (event.pointerType === 'touch') touchStart = event.clientX;
    },
    onPointerup: (event) => {
      if (event.pointerType !== 'touch' || touchStart === null) return;
      const delta = event.clientX - touchStart;
      touchStart = null;
      if (Math.abs(delta) > 44) select(current + (delta < 0 ? 1 : -1));
    },
    onKeydown: (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); select(current - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); select(current + 1); }
    },
  }, h('div', { class: 'c-slide-track' }, slides), previous, next, indicators);

  container.replaceChildren(stage);

  function stop() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  function schedule(delay = INTERVAL) {
    stop();
    if (!enabled || hovered || focused || reducedMotion.matches) return;
    timer = window.setTimeout(() => {
      select(current + 1, false);
    }, delay);
  }

  function select(index) {
    current = (index + IMAGES.length) % IMAGES.length;
    slides.forEach((slide, i) => { slide.hidden = i !== current; });
    dots.forEach((dot, i) => dot.setAttribute('aria-pressed', String(i === current)));
    schedule();
  }

  const onMotionChange = () => schedule();
  reducedMotion.addEventListener?.('change', onMotionChange);
  schedule();

  return {
    setActive(active) {
      enabled = Boolean(active);
      schedule();
    },
    destroy() {
      stop();
      reducedMotion.removeEventListener?.('change', onMotionChange);
      container.replaceChildren();
    },
  };
}
