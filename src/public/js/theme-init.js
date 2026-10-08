// Classic script, loaded in <head> BEFORE anything is drawn: it chooses the colour theme (the saved
// choice, else the device's light / dark setting) and puts it on <html data-theme>, so a dark-mode
// visitor never sees a white flash.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('bfl.theme'); } catch (e) { /* storage blocked */ }
  var dark = saved ? saved === 'dark'
    : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}());
