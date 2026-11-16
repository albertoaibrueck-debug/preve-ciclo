/* Mon Quotidien — service worker: funcionamento offline + notificações */
importScripts('core.js');

var SHELL = 'ciclo-shell-v3';
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

function readShown() {
  return caches.open('ciclo-state').then(function (c) { return c.match('shown.json'); })
    .then(function (r) { return r ? r.json() : []; }).catch(function () { return []; });
}
function saveShown(ids) {
  return caches.open('ciclo-state').then(function (c) { return c.put('shown.json', new Response(JSON.stringify(ids))); }).catch(function () {});
}

/* O servidor (Apps Script) manda um "toque" sem conteúdo e guarda numa fila o motivo
   (tempo às 7h, ciclo às 20h, lembrete no horário marcado ou teste).
   Aqui o app lê a fila e monta cada notificação ainda não mostrada. */
self.addEventListener('push', function (e) {
  e.waitUntil(readState().then(function (st) {
    var loc = st.loc || { lat: -25.43, lon: -49.27, name: 'Curitiba' };
    var fresh = st.cfg ? withTimeout(fetch(st.cfg.url + '?k=' + encodeURIComponent(st.cfg.key) + '&a=all&t=' + Date.now()).then(function (r) { return r.json(); }), 9000) : Promise.resolve(null);
    return Promise.all([fresh, readShown()]).then(function (res) {
      var data = res[0] && res[0].ok ? res[0] : null, shown = res[1] || [];
      var entries = (data && data.entries) || st.entries || {}, now = Date.now(), items = [];
      if (data && data.pushes) items = data.pushes.filter(function (p) { return now - p.at < 3600000 && shown.indexOf(p.id) < 0; });
      if (!items.length) items = [{ kind: new Date().getHours() < 14 ? 'tempo' : 'ciclo', id: null }];
      var needWx = items.some(function (p) { return p.kind === 'tempo' || p.kind === 'teste'; });
      return (needWx ? withTimeout(Ciclo.fetchWeather(loc.lat, loc.lon), 9000) : Promise.resolve(null)).then(function (w) {
        var tempo = Ciclo.weatherMessage(w, loc.name), ciclo = Ciclo.cycleMessage(entries);
        return Promise.all(items.map(function (p) {
          var msg;
          if (p.kind === 'lembrete') msg = { title: p.title || '🔔 Lembrete', body: p.body || '' };
          else if (p.kind === 'teste') msg = { title: 'Mon Quotidien 💕 (teste)', body: ciclo.body + (tempo ? '\n' + tempo.title + ': ' + tempo.body : '') };
          else if (p.kind === 'tempo') msg = tempo || { title: 'Mon Quotidien 💕', body: 'Bom dia! Não consegui buscar a previsão do tempo agora.' };
          else msg = ciclo;
          return self.registration.showNotification(msg.title, { body: msg.body, icon: 'icon-192.png', badge: 'icon-192.png', tag: p.kind + (p.id || '') });
        })).then(function () {
          return saveShown(shown.concat(items.map(function (p) { return p.id; }).filter(Boolean)).slice(-30));
        });
      });
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
