// Classic script, loaded in <head> BEFORE anything is drawn, so two things happen early:
//
// 1. The colour theme is chosen (the saved choice, else the device's light / dark setting) and
//    put on <html data-theme>, so a dark-mode visitor never sees a white flash.
// 2. fetch() is wrapped so the page can show a thin loading bar while any request is in flight
//    (js/ui-extras.js draws it). The wrapper changes nothing else about fetch.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('bfl.theme'); } catch (e) { /* storage blocked */ }
  var dark = saved ? saved === 'dark'
    : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');

  var inFlight = 0;
  var realFetch = window.fetch;
  if (typeof realFetch !== 'function') return;
  var settle = function () {
    inFlight = Math.max(0, inFlight - 1);
    if (!inFlight) document.documentElement.classList.remove('bfl-loading');
  };
  window.fetch = function () {
    inFlight += 1;
    document.documentElement.classList.add('bfl-loading');
    var p = realFetch.apply(this, arguments);
    p.then(settle, settle);
    return p;
  };
}());
