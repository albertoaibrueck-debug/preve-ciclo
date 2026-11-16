/* Mon Quotidien — lógica do ciclo (usada pela página e pelo service worker) */
(function (root) {
  'use strict';
  var DAY = 86400000;

  // Dias são tratados como números inteiros (dias desde 1970) para evitar problemas de fuso.
  function num(k) { var p = k.split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY); }
  function key(n) { return new Date(n * DAY).toISOString().slice(0, 10); }
  function today(now) {
    now = now || new Date();
    return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY);
  }
  function avg(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  /* Analisa os registros e devolve médias + previsões.
     As médias se ajustam sozinhas a cada nova menstruação registrada. */
  function analyze(entries, t) {
    entries = entries || {};
    if (t == null) t = today();
    var days = Object.keys(entries)
      .filter(function (k) { return entries[k] && entries[k].period; })
      .map(num).filter(function (d) { return d <= t; })
      .sort(function (a, b) { return a - b; });

    // Agrupa dias seguidos (tolerando 1 dia sem registro) em menstruações
    var periods = [];
    days.forEach(function (d) {
      var p = periods[periods.length - 1];
      if (p && d - p.end <= 2) p.end = d; else periods.push({ start: d, end: d });
    });

    var last = periods[periods.length - 1] || null;
    var ongoing = !!last && t - last.end <= 1;

    // Duração média: só menstruações já encerradas, as 6 mais recentes
    var done = periods.filter(function (p, i) { return !(ongoing && i === periods.length - 1); });
    var durs = done.slice(-6).map(function (p) { return p.end - p.start + 1; });
    var periodLen = durs.length ? clamp(Math.round(avg(durs)), 2, 10) : 5;
    if (ongoing) periodLen = Math.max(periodLen, last.end - last.start + 1);

    // Tamanho do ciclo: intervalo entre inícios; descarta intervalos improváveis
    // (menos de 15 ou mais de 60 dias costumam ser falha de registro).
    var gaps = [];
    for (var i = 1; i < periods.length; i++) gaps.push(periods[i].start - periods[i - 1].start);
    var valid = gaps.filter(function (g) { return g >= 15 && g <= 60; }).slice(-6);
    var cycleLen = 28, spread = null;
    if (valid.length) {
      // média ponderada: ciclos mais recentes pesam mais
      var sw = 0, sx = 0;
      valid.forEach(function (g, j) { sw += j + 1; sx += g * (j + 1); });
      cycleLen = Math.round(sx / sw);
      if (valid.length >= 2) {
        var m = avg(valid);
        spread = Math.round(Math.sqrt(avg(valid.map(function (g) { return (g - m) * (g - m); }))));
      }
    }

    var res = {
      periods: periods, last: last, ongoing: ongoing,
      periodLen: periodLen, durationsUsed: durs.length,
      cycleLen: cycleLen, cyclesUsed: valid.length, spread: spread,
      cycleDay: last ? t - last.start + 1 : null,
      next: null, rawNext: null, late: 0, predicted: [], windows: []
    };
    if (!last) return res;

    var raw = last.start + cycleLen;
    res.rawNext = raw;
    res.late = (!ongoing && t > raw) ? t - raw : 0;
    var base = res.late ? t : raw;          // se atrasou, pode vir a qualquer momento
    res.next = base;
    for (var c = 0; c < 6; c++) {
      var s = base + c * cycleLen;
      res.predicted.push({ start: s, end: s + periodLen - 1 });
      var ov = (c === 0 ? raw : s) - 14;    // ovulação ~14 dias antes da menstruação
      res.windows.push({ start: ov - 5, end: ov + 1, ov: ov });
    }
    return res;
  }

  function inPredicted(a, d) {
    return a.predicted.some(function (p) { return d >= p.start && d <= p.end; });
  }
  function windowOf(a, d) {
    for (var i = 0; i < a.windows.length; i++) {
      if (d >= a.windows[i].start && d <= a.windows[i].end) return a.windows[i];
    }
    return null;
  }

  // Fase do dia: 'menstruacao' | 'tpm' | 'fertil' | 'normal'
  function phase(a, entries, t) {
    var e = entries && entries[key(t)];
    if ((e && e.period) || a.ongoing) return 'menstruacao';
    if (!a.last) return 'normal';
    if (a.late > 0) return 'tpm';
    var d = a.next - t;
    if (d === 0) return 'menstruacao';
    if (d >= 1 && d <= 5) return 'tpm';
    if (windowOf(a, t)) return 'fertil';
    return 'normal';
  }

  function fertileInfo(a, t) {
    for (var i = 0; i < a.windows.length; i++) {
      var w = a.windows[i];
      if (w.end < t) continue;
      if (w.start <= t) return { now: true, isOv: w.ov === t, left: w.end - t };
      return { now: false, days: w.start - t };
    }
    return null;
  }

  function cycleMessage(entries, t) {
    if (t == null) t = today();
    var a = analyze(entries, t);
    if (!a.last) {
      return { title: 'Mon Quotidien 💕', body: 'Registre a última menstruação para começar as previsões.' };
    }
    var p, d = a.next - t;
    if (a.ongoing) p = '🩸 Dia ' + a.cycleDay + ' da menstruação · próxima em ' + plural(d, 'dia', 'dias');
    else if (a.late > 0) p = '🩸 Menstruação atrasada ' + plural(a.late, 'dia', 'dias') + ' — pode vir a qualquer momento';
    else if (d === 0) p = '🩸 Menstruação prevista para hoje';
    else p = '🩸 ' + (d === 1 ? 'Falta 1 dia' : 'Faltam ' + d + ' dias') + ' para a menstruação';

    var f = fertileInfo(a, t), q = '';
    if (f) {
      if (f.now) q = f.isOv ? '🌸 Ovulação prevista para hoje' : '🌸 Período fértil agora (mais ' + plural(f.left, 'dia', 'dias') + ')';
      else q = '🌸 ' + (f.days === 1 ? 'Falta 1 dia' : 'Faltam ' + f.days + ' dias') + ' para o período fértil';
    }
    return { title: 'Mon Quotidien 💕', body: p + (q ? '\n' + q : '') };
  }

  function fetchWeather(lat, lon) {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1';
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.daily) return null;
      return {
        max: Math.round(d.daily.temperature_2m_max[0]),
        min: Math.round(d.daily.temperature_2m_min[0]),
        rain: d.daily.precipitation_probability_max[0]
      };
    });
  }

  function weatherMessage(w, city) {
    if (!w) return null;
    var icon = w.rain >= 60 ? '🌧️' : w.rain >= 30 ? '⛅' : '☀️';
    return {
      title: icon + ' ' + (city || 'Hoje') + ' hoje',
      body: 'Máx ' + w.max + '° · Mín ' + w.min + '° · ' + (w.rain == null ? '--' : w.rain) + '% de chance de chuva'
    };
  }

  root.Ciclo = {
    num: num, key: key, today: today, plural: plural,
    analyze: analyze, phase: phase, fertileInfo: fertileInfo,
    inPredicted: inPredicted, windowOf: windowOf,
    cycleMessage: cycleMessage, fetchWeather: fetchWeather, weatherMessage: weatherMessage
  };
})(typeof self !== 'undefined' ? self : this);
