// Classic script (not a module), loaded before React on every page.
//
// If the app cannot start — a script blocked or cached stale, a browser too old for
// ES modules, a certificate problem on the phone — the page would otherwise stay
// blank with nothing to read. After a few seconds with nothing rendered, this says so
// on screen and shows what went wrong, so it can be reported without developer tools.
(function bootGuard() {
  var problems = [];
  var note = function (text) { if (problems.indexOf(text) < 0) problems.push(text); };

  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) { note('Could not load ' + (t.src || t.href)); return; }
    note((e.message || 'Script error')
      + (e.filename ? ' (' + String(e.filename).split('/').slice(-2).join('/') + ':' + e.lineno + ')' : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    note('Promise: ' + ((e.reason && e.reason.message) || e.reason));
  });

  setTimeout(function () {
    var root = document.getElementById('root');
    if (!root || root.firstChild) return;
    var box = document.createElement('div');
    box.style.cssText = 'font:16px system-ui,sans-serif;max-width:520px;margin:32px auto;padding:16px;'
      + 'border:1px solid #d33;border-radius:8px;background:#fff5f5;color:#222';
    var head = document.createElement('b');
    head.textContent = 'This page did not start.';
    var help = document.createElement('p');
    help.textContent = 'Reload it. If it still fails, clear this site’s data (or use a private tab) and tell Box for Less what is written below.';
    var detail = document.createElement('pre');
    detail.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:13px';
    detail.textContent = (problems.length ? problems.join('\n') : 'No error was reported.')
      + '\n\n' + navigator.userAgent;
    box.appendChild(head); box.appendChild(help); box.appendChild(detail);
    root.appendChild(box);
  }, 4000);
}());
