// Service worker — why the app opens instantly and survives no signal.
//
// STRATEGY: network-first, cache as fallback (changed 2026-07-29).
//
// The first version was cache-first, which is faster but wrong here: after an
// update the phone kept serving the OLD app indefinitely. That was caught in
// testing — a redesigned app.js was published and the browser carried on
// running the previous one. For a tool that will keep being improved, silently
// pinning the OM to a stale version is worse than a few hundred milliseconds.
//
// Now: with signal, a reload always gets the current app and refreshes the
// cache. With no signal, the cached copy is served and everything still works
// offline. The network request has a short timeout so a weak connection falls
// back to cache quickly instead of hanging on a white screen.
var CACHE = 'hyginix-extras-v3';
var SHELL = ['./', './index.html', './app.js', './manifest.json', './icon.svg'];
var NET_TIMEOUT_MS = 3500;

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function(c) { return c.addAll(SHELL); })
      .then(function() { return self.skipWaiting(); })   // take over immediately
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; })
                             .map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

function fromNetwork(request, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var settled = false;
    var timer = setTimeout(function() {
      if (!settled) { settled = true; reject(new Error('timeout')); }
    }, timeoutMs);
    fetch(request).then(function(res) {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(res);
    }).catch(function(err) {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(err);
    });
  });
}

self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);

  // Never touch Apps Script traffic — writes must reach the server, and the
  // bootstrap should be fresh whenever there is signal.
  if (url.hostname.indexOf('script.google.com') !== -1 ||
      url.hostname.indexOf('googleusercontent.com') !== -1) return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fromNetwork(e.request, NET_TIMEOUT_MS)
      .then(function(res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, copy); });
        }
        return res;
      })
      .catch(function() {
        // Offline or too slow — serve what we have. Falling back to the app
        // shell for navigations means a deep link still opens the app.
        return caches.match(e.request).then(function(hit) {
          return hit || caches.match('./index.html');
        });
      })
  );
});
