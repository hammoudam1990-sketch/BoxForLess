// Customer catalogue entry point. The app lives in ./catalog/.
//
// Routing: /catalog (list) and /catalog/product/:id (detail). Both URLs are served
// the same shell by the server; ./catalog/router.js reads location.pathname.
window.__bflBooted = true; // tells boot-guard.js the page started
import { mount } from './lib/react.js';
import { App } from './catalog/App.js';

mount(App);
