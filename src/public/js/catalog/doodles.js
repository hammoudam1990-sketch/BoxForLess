// Small line drawings for the products, in the spirit of the doodle wallpaper behind the
// site. Almost no product has a photograph, so each card shows a drawing of what KIND of
// thing it is — a sack for rice and flour, a bottle for a drink, a jar for spices — chosen
// from the product's Odoo category. Nothing here changes any data: it is picked at display
// time from the category the API already sends.
//
// One stroke weight, round caps, drawn on a 48-unit grid, coloured by `currentColor`.
import { svg } from '../lib/dom.js';
import { doodleFor, doodleForTop } from './doodle-map.js';

export { doodleFor, doodleForTop };

const DRAWINGS = {
  // a tied sack: rice, flour, grains, cereals
  sack: `<path d="M17 8c2 2 5 3 7 3s5-1 7-3l-2-3H19z"/><path d="M17 8C12 14 8 20 8 29c0 7 4 12 10 12h12c6 0 10-5 10-12 0-9-4-15-9-21"/><path d="M24 22c-3 3-3 8 0 11 3-3 3-8 0-11z"/><path d="M24 22v13"/>`,
  // a bottle with a label: juice, soft drinks, water, syrup
  bottle: `<path d="M20 5h8v6l3 5v24a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3V16l3-5z"/><path d="M17 22h14M17 33h14"/><path d="M22 27.5h4"/>`,
  // a can: tinned and preserved food
  can: `<ellipse cx="24" cy="12" rx="11" ry="4"/><path d="M13 12v24c0 2.2 4.9 4 11 4s11-1.8 11-4V12"/><path d="M13 21c0 2.2 4.9 4 11 4s11-1.8 11-4M13 29c0 2.2 4.9 4 11 4s11-1.8 11-4"/>`,
  // a jar: spices, pickles, sauces and condiments
  jar: `<rect x="14" y="6" width="20" height="7" rx="2"/><path d="M16 13c-3 2-4 5-4 8v17a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3V21c0-3-1-6-4-8"/><rect x="17" y="22" width="14" height="12" rx="2"/><path d="M20 28h8"/>`,
  // a wrapped sweet: snacks and confectionery
  candy: `<ellipse cx="24" cy="24" rx="9" ry="7"/><path d="M15 24l-9-6v12zM33 24l9-6v12z"/><path d="M20 20c2 2 2 6 0 8"/>`,
  // a steaming cup: coffee, tea, hot drinks
  cup: `<path d="M10 20h24v10a10 10 0 0 1-10 10h-4a10 10 0 0 1-10-10z"/><path d="M34 23h3a4 4 0 0 1 0 8h-4"/><path d="M17 8c-2 2 2 4 0 7M24 8c-2 2 2 4 0 7M31 8c-2 2 2 4 0 7"/>`,
  // an oil bottle with a drop: cooking oils and fats
  oil: `<path d="M21 4h6v5l5 6v22a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3V15l5-6z"/><path d="M24 21c-3 4-4 6-4 8a4 4 0 0 0 8 0c0-2-1-4-4-8z"/>`,
  // a cupcake: baking and dessert
  cake: `<path d="M12 26h24l-3 14H15z"/><path d="M14 26c-3-1-4-4-2-7 1-3 5-4 7-2 1-4 8-4 10 0 3-1 6 2 5 5-1 3-3 4-5 4"/><circle cx="25" cy="9" r="2.5"/><path d="M20 30l1 6M28 30l-1 6"/>`,
  // a milk carton: dairy and chilled
  carton: `<path d="M14 18l5-8h16l-5 8z"/><path d="M14 18h16v24H14z"/><path d="M30 18l5-8v24l-5 8"/><path d="M18 26h8M18 32h8"/>`,
  // a drumstick: meat and poultry
  meat: `<ellipse cx="29" cy="17" rx="11" ry="9" transform="rotate(-30 29 17)"/><path d="M22 24L12 34"/><circle cx="9" cy="35" r="3.5"/><circle cx="14" cy="40" r="3.5"/>`,
  // a wine glass: alcoholic drinks
  glass: `<path d="M14 6h20c0 12-4 18-10 18S14 18 14 6z"/><path d="M15 14h18M24 24v15M16 42h16"/>`,
  // a spray bottle: cleaning, laundry, household
  spray: `<path d="M18 22h12v18a3 3 0 0 1-3 3h-6a3 3 0 0 1-3-3z"/><path d="M20 22v-5h9v5M20 17l-7-3h-3v6h4"/><path d="M12 11l-3-2M11 15l-4 0M12 19l-3 2"/><path d="M24 28v8"/>`,
  // a pump bottle: personal care, cosmetics, fragrance, baby
  pump: `<path d="M17 20h14v20a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3z"/><path d="M24 20v-8M24 12h7v3"/><path d="M17 29h14"/>`,
  // a toilet roll: paper and hygiene
  roll: `<ellipse cx="24" cy="14" rx="14" ry="6"/><path d="M10 14v20c0 3.3 6.3 6 14 6s14-2.7 14-6V14"/><ellipse cx="24" cy="14" rx="5" ry="2"/>`,
  // a carton box: packaging, disposables, anything else that is not food
  box: `<path d="M6 15l18 8 18-8M24 23v20"/><path d="M6 15l18-8 18 8v19l-18 9-18-9z"/><path d="M15 11l18 8"/>`,
  // a paw: pets
  paw: `<ellipse cx="24" cy="31" rx="9" ry="7"/><ellipse cx="11" cy="22" rx="3.5" ry="5" transform="rotate(-20 11 22)"/><ellipse cx="19" cy="13" rx="3.5" ry="5"/><ellipse cx="29" cy="13" rx="3.5" ry="5"/><ellipse cx="37" cy="22" rx="3.5" ry="5" transform="rotate(20 37 22)"/>`,
  // a bowl: food, when nothing more specific is known
  bowl: `<path d="M6 22h36c0 10-7 18-18 18S6 32 6 22z"/><path d="M15 22c0-5 4-9 9-9s9 4 9 9"/><path d="M20 9c-1-2 1-3 0-5M28 9c-1-2 1-3 0-5"/>`,
};

const SIZES = { sm: 28, md: 44, lg: 96 };

/**
 * A drawing as an <svg> element. Decorative: hidden from assistive technology (the name sits
 * beside it). The markup is one of the constants above, never anything from the server.
 */
export function doodle(name, { size = 'md', className = '' } = {}) {
  const px = SIZES[size] || SIZES.md;
  return svg(`<svg class="c-doodle ${className}" width="${px}" height="${px}" viewBox="0 0 48 48" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${DRAWINGS[name] || DRAWINGS.box}</svg>`);
}
