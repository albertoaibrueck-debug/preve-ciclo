/* Préve Ciclo — service worker: funcionamento offline + notificações */
importScripts('core.js');

var SHELL = 'ciclo-shell-v1';
var FILES = ['./', 'index.html', 'core.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-180.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('ciclo-shell-') === 0 && k !== SHELL; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Rede primeiro; se estiver offline, usa a cópia guardada.
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(function (r) {
      if (r.ok) { var copy = r.clone(); caches.open(SHELL).then(function (c) { c.put(e.request, copy); }); }
      return r;
    }).catch(function () {
      return caches.open(SHELL).then(function (c) { return c.match(e.request, { ignoreSearch: true }); }).then(function (r) { return r || caches.open(SHELL).then(function (c) { return c.match('index.html'); }); });
    })
  );
});

function readState() {
  return caches.open('ciclo-state').then(function (c) { return c.match('state.json'); })
    .then(function (r) { return r ? r.json() : {}; }).catch(function () { return {}; });
}
function withTimeout(p, ms) {
  return Promise.race([p, new Promise(function (res) { setTimeout(function () { res(null); }, ms); })]).catch(function () { return null; });
}

/* O servidor (Apps Script) manda um "toque" sem conteúdo às 7h e às 20h.
   O texto é montado aqui: de manhã a previsão do tempo, à noite o ciclo. */
self.addEventListener('push', function (e) {
  e.waitUntil(readState().then(function (st) {
    var loc = st.loc || { lat: -25.43, lon: -49.27, name: 'Curitiba' };
    var fresh = st.cfg ? withTimeout(fetch(st.cfg.url + '?k=' + encodeURIComponent(st.cfg.key) + '&a=all&t=' + Date.now()).then(function (r) { return r.json(); }), 9000) : Promise.resolve(null);
    var wx = withTimeout(Ciclo.fetchWeather(loc.lat, loc.lon), 9000);
    return Promise.all([fresh, wx]).then(function (res) {
      var data = res[0], entries = (data && data.ok && data.entries) || st.entries || {};
      var isTest = data && data.testAt && Date.now() - data.testAt < 180000;
      var ciclo = Ciclo.cycleMessage(entries), tempo = Ciclo.weatherMessage(res[1], loc.name);
      var manha = new Date().getHours() < 14, msg;
      if (isTest) msg = { title: 'Préve Ciclo 💕 (teste)', body: ciclo.body + (tempo ? '\n' + tempo.title + ': ' + tempo.body : '') };
      else if (manha) msg = tempo || { title: 'Préve Ciclo 💕', body: 'Bom dia! Não consegui buscar a previsão do tempo agora.' };
      else msg = ciclo;
      return self.registration.showNotification(msg.title, { body: msg.body, icon: 'icon-192.png', badge: 'icon-192.png', tag: isTest ? 'teste' : manha ? 'tempo' : 'ciclo' });
    });
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) if ('focus' in cs[i]) return cs[i].focus();
    return self.clients.openWindow('./');
  }));
});
