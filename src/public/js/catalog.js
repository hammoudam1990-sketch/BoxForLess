// Customer catalogue entry point: plain HTML, CSS and JavaScript, no framework.
//
// Routing: /catalog (list) and /catalog/product/:id (detail). Both URLs are served the same
// page by the server; ./catalog/router.js reads location.pathname.
window.__bflBooted = true; // tells boot-guard.js the page started
import { startCatalog } from './catalog/app.js';

startCatalog(document.getElementById('root'));
