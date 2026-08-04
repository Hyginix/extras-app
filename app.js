// =============================================================================
// Hyginix — Log Extra (phone app)
//
// One requirement drives all of this: under five seconds, and never waiting for
// the network.
//
//   • Service-worker cached, so it opens instantly and offline.
//   • Employees, reasons and amounts are cached locally and refreshed in the
//     background — the screen is usable before any network call finishes.
//   • Saving is OPTIMISTIC: the entry goes to a local queue, the OM is told
//     "Saved" immediately, and it sends in the background. No signal in a
//     stairwell just means it goes later. He never waits, nothing is lost.
//
// Every queued entry carries its own id, used server-side as an idempotency
// key — a retry after a dropped connection cannot pay anyone twice.
// =============================================================================

var LS = {
  url:    'hx_url',
  key:    'hx_key',
  boot:   'hx_boot',
  queue:  'hx_queue',
  hist:   'hx_hist'
};

var BOOT = { employees: [], reasons: [], amounts: [], hourReasons: [], maxHoursPerEntry: 12,
             me: { name: '', role: '', canHours: true, canExtras: true } };

// MONEY or HOURS (2026-08-04). The OM types a figure in forints because he
// knows what an incident is worth; a supervisor types HOURS, because they know
// the job took two more of them and the payroll rules decide the money. Which
// modes a phone offers comes from the server, keyed on that phone's own device
// key — a supervisor's app simply has no money form in it.
var MODE = 'money';
var HIST = [];
var SEL  = { name: '', reason: '', otherReason: false, sign: 1, when: 'today' };
var TAB  = 'log';

function $(id) { return document.getElementById(id); }
function get(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
function set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function attr(s) { return JSON.stringify(String(s)).replace(/"/g, '&quot;'); }
function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() { var d = new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function shiftDays(s, n) {
  var p = s.split('-'); var d = new Date(+p[0], +p[1]-1, +p[2]+n);
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
}
function fmt(n) {
  n = Number(n) || 0;
  return (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('hu-HU').replace(/,/g,' ');
}
function niceDate(iso) {
  if (iso === todayStr()) return 'Today';
  if (iso === shiftDays(todayStr(), -1)) return 'Yesterday';
  var p = String(iso).split('-');
  if (p.length !== 3) return iso;
  var M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return Number(p[2]) + ' ' + M[Number(p[1]) - 1];
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function start() {
  // A setup link (#u=…&k=…) configures the app without anything being typed.
  // This exists because on iOS a home-screen app gets its OWN storage, separate
  // from Safari — so settings entered in the browser are simply not there when
  // the icon is opened. Opening the LINK from the home screen fixes that.
  // The fragment is stripped immediately so the key does not sit in the bar.
  var h = location.hash || '';
  if (h.indexOf('u=') !== -1 && h.indexOf('k=') !== -1) {
    var m = { };
    h.replace(/^#/, '').split('&').forEach(function(kv) {
      var i = kv.indexOf('='); if (i > 0) m[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    if (m.u && m.k) { set(LS.url, m.u); set(LS.key, m.k); }
    history.replaceState(null, '', location.pathname + location.search);
  }

  if (!localStorage.getItem(LS.url) || !localStorage.getItem(LS.key)) {
    $('setup').classList.remove('hidden');
    return;
  }

  // Ask the browser to keep our storage — without it iOS may evict local data
  // for a site it considers idle, which would mean setting up again.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  $('app').classList.remove('hidden');
  BOOT = get(LS.boot, BOOT);
  HIST = get(LS.hist, []);
  $('whenDate').value = todayStr();
  renderAll();
  flushQueue();

  // A phone that has never connected has no employee list, so a failure here is
  // not something to hide — send it back to the setup screen with the reason.
  var neverLoaded = !(BOOT.employees && BOOT.employees.length);
  refreshBootstrap(neverLoaded ? function(msg) {
    $('app').classList.add('hidden');
    $('setup').classList.remove('hidden');
    $('s_url').value = get(LS.url, '');
    $('s_key').value = get(LS.key, '');
    setupError(msg + ' — nothing was loaded, so check the key for a capital letter or a stray space.');
  } : null);
  refreshHistory();
}

function setupError(msg) {
  var el = $('setupErr'); if (!el) return;
  el.classList.toggle('hidden', !msg);
  el.textContent = msg || '';
}

function saveSetup() {
  // Strip every kind of whitespace, not just the ends. A key copied on a phone
  // arrives with spaces, newlines and sometimes a non-breaking space in it, and
  // the server compares with === — so an invisible character is a rejected key.
  var url = $('s_url').value.replace(/[\s\u00A0\u200B]+/g, '');
  var key = $('s_key').value.replace(/[\s\u00A0\u200B]+/g, '');
  if (!url || !key) { setupError('Both fields are needed.'); return; }
  if (url.indexOf('/exec') === -1) {
    setupError('That URL should end in /exec. A /dev URL only works for the owner.');
    return;
  }
  setupError('');
  set(LS.url, url); set(LS.key, key);
  $('setup').classList.add('hidden');
  start();
}

// JSONP — a cross-origin fetch() to an Apps Script /exec URL redirects through
// googleusercontent and is unreliable; a script tag sidesteps CORS entirely.
// Silent on failure: the cached lists keep the app usable.
// onFail is used on FIRST SETUP only. Staying silent is right when there are
// cached lists to fall back on — the app keeps working offline and says nothing.
// But on a phone that has never connected there is nothing to fall back on, and
// silence produces a fully-drawn app with every list empty and no explanation.
// That is exactly what a mistyped key looked like on 2026-08-04.
function refreshBootstrap(onFail) {
  var url = get(LS.url, ''), key = get(LS.key, '');
  if (!url) return;
  var cb = 'hxcb' + Date.now(), s = document.createElement('script'), done = false;
  function fail(msg) { if (onFail) onFail(msg); }
  window[cb] = function(res) {
    done = true;
    if (res && res.ok) { BOOT = res; set(LS.boot, res); renderAll(); }
    else fail((res && res.message) || 'The app URL refused the request.');
    cleanup();
  };
  function cleanup() {
    try { delete window[cb]; } catch (e) { window[cb] = undefined; }
    if (s.parentNode) s.parentNode.removeChild(s);
  }
  s.onerror = function() { fail('Could not reach that URL. Check the address and the signal.'); cleanup(); };
  setTimeout(function(){ if (!done) { fail('No answer from the app URL after 12 seconds.'); cleanup(); } }, 12000);
  s.src = url + '?callback=' + cb + '&key=' + encodeURIComponent(key) + '&t=' + Date.now();
  document.body.appendChild(s);
}

function refreshHistory() {
  post({ action: 'history' }, function(res) {
    if (res && res.ok && res.entries) { HIST = res.entries; set(LS.hist, HIST); renderHistory(); }
  });
}

// text/plain keeps this a "simple request" so no preflight is sent — Apps
// Script cannot answer one. The body is still JSON.
function post(payload, onDone) {
  var url = get(LS.url, ''), key = get(LS.key, '');
  if (!url) { onDone && onDone(null); return; }
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ key: key }, payload))
  }).then(function(r) { return r.json(); })
    .then(function(res) { onDone && onDone(res); })
    .catch(function() { onDone && onDone(null); });
}

// ---------------------------------------------------------------------------
// Rendering — LOG
// ---------------------------------------------------------------------------
function defaultMode() { return (BOOT.me && BOOT.me.canExtras) ? 'money' : 'hours'; }
function isHours() { return MODE === 'hours'; }

function renderAll() {
  if (BOOT.me && !BOOT.me.canExtras) MODE = 'hours';   // no money form on this phone
  renderModes(); renderWho(); renderWhy(); renderAmounts(); renderWhen(); render(); renderHistory();
}

function renderModes() {
  var wrap = $('modeWrap'); if (!wrap) return;
  var canBoth = !!(BOOT.me && BOOT.me.canExtras);
  // One capability means no switch at all — a control with a single option is
  // just clutter on a phone.
  wrap.classList.toggle('hidden', !canBoth);
  $('modeGrid').innerHTML = [['money','\uD83D\uDCB0 Money'], ['hours','\u23F1 Hours']].map(function(o) {
    return '<button class="ctl' + (MODE === o[0] ? ' on' : '') +
           '" onclick="pickMode(\'' + o[0] + '\')">' + o[1] + '</button>';
  }).join('');
  var who = $('meLine');
  if (who) who.textContent = (BOOT.me && BOOT.me.name) ? ('Signed in as ' + BOOT.me.name) : '';
}

function pickMode(m) {
  if (MODE === m) return;
  MODE = m;
  // The reason lists differ, so a reason carried across would be meaningless.
  SEL.reason = ''; SEL.otherReason = false; SEL.sign = 1;
  $('whyOther').value = ''; $('amt').value = '';
  $('whyOtherWrap').classList.add('hidden');
  renderAll();
}

function renderWho() {
  var picked = !!SEL.name;
  $('whoPicked').classList.toggle('hidden', !picked);
  $('whoSearchWrap').classList.toggle('hidden', picked);
  if (picked) { $('whoName').textContent = SEL.name; return; }

  var q = ($('whoSearch').value || '').trim().toLowerCase();
  var box = $('whoResults');
  if (!q) { box.innerHTML = ''; return; }
  var hits = (BOOT.employees || []).filter(function(p) {
    return p.name.toLowerCase().indexOf(q) !== -1;
  }).slice(0, 12);
  box.innerHTML = hits.length
    ? hits.map(function(p) {
        return '<button class="ctl opt" onclick="pickWho(' + attr(p.name) + ')">' +
               '<span>' + esc(p.name) + '</span><span class="tick">✓</span></button>';
      }).join('')
    : '<div class="empty">Nobody matches “' + esc(q) + '”.</div>';
}

function renderWhy() {
  var sel = $('whySelect');
  var reasons = isHours() ? (BOOT.hourReasons || []) : (BOOT.reasons || []);
  var chosen = SEL.otherReason ? '__other__' : SEL.reason;

  sel.innerHTML =
    '<option value="">Choose a reason…</option>' +
    reasons.map(function(r) {
      return '<option value="' + esc(r) + '"' + (r === chosen ? ' selected' : '') + '>' + esc(r) + '</option>';
    }).join('') +
    '<option value="__other__"' + (chosen === '__other__' ? ' selected' : '') + '>Something else…</option>';

  sel.value = chosen || '';
  sel.classList.toggle('unset', !chosen);
  $('whyOtherWrap').classList.toggle('hidden', !SEL.otherReason);
}

function onWhyChange() {
  var v = $('whySelect').value;
  if (v === '__other__') {
    SEL.otherReason = true; SEL.reason = '';
    renderWhy(); render();
    $('whyOther').focus();
  } else {
    SEL.otherReason = false; SEL.reason = v;
    renderWhy(); render();
  }
}

// Quick picks. Hours are small whole numbers, so a fixed set beats the
// most-used-amounts list the money form derives from history.
var HOUR_PRESETS = [1, 2, 3, 4, 6, 8];

function renderAmounts() {
  var cur = Number($('amt').value) || 0;
  var opts = isHours() ? HOUR_PRESETS : (BOOT.amounts || []).slice(0, 6);
  $('amtGrid').innerHTML = opts.map(function(a) {
    return '<button class="ctl' + (Math.abs(cur) === a ? ' on' : '') + '" onclick="pickAmt(' + a + ')">' +
           (isHours() ? a + ' h' : fmt(a)) + '</button>';
  }).join('');
  var lbl = $('amtLbl');
  if (lbl) lbl.textContent = isHours() ? 'How many hours' : 'How much';
  // Hours are never negative — there is no such thing as taking hours away with
  // this form, and a minus sign only invites the question.
  var wrap = $('amtwrap');
  if (wrap) wrap.classList.toggle('nosign', isHours());
  $('amt').setAttribute('step', isHours() ? '0.5' : '1');
}

function renderWhen() {
  // Three options on one row: the two he uses constantly, plus a way OUT to any
  // other date. The two-button version had no third option at all, so an extra
  // for last week was simply unreachable.
  var opts = [['today','Today'], ['yesterday','Yesterday'], ['other','Other…']];
  $('whenGrid').innerHTML = opts.map(function(o) {
    return '<button class="ctl' + (SEL.when === o[0] ? ' on' : '') +
           '" onclick="pickWhen(\'' + o[0] + '\')">' + o[1] + '</button>';
  }).join('');
  // Once another day is chosen the date field STAYS open, so it is obvious at a
  // glance that this entry is not for today.
  $('whenPickWrap').classList.toggle('hidden', SEL.when !== 'other');
}

function render() {
  var why = currentReason();
  $('signBtn').textContent = SEL.sign > 0 ? '+' : '−';
  $('signBtn').className = 'ctl sign' + (SEL.sign < 0 ? ' minus' : '') + (isHours() ? ' hidden' : '');
  var amt = Math.abs(Number($('amt').value) || 0);
  var max = Number(BOOT.maxHoursPerEntry) || 12;
  // The same cap the server enforces, applied here so the refusal happens while
  // the supervisor is still looking at what they typed — these hours become pay
  // with nobody approving them, and 80 is a mistyped 8.
  var overCap = isHours() && amt > max;
  var ok = !!(SEL.name && why && amt > 0) && !overCap;
  $('saveBtn').disabled = !ok;
  $('saveBtn').textContent = overCap
    ? ('Too many — ' + max + ' h is the limit')
    : (ok ? (isHours() ? 'Save ' + amt + ' h' : 'Save ' + fmt(SEL.sign * amt) + ' Ft') : 'Save');
  var warn = $('capWarn');
  if (warn) {
    warn.classList.toggle('hidden', !overCap);
    warn.textContent = 'One entry cannot be more than ' + max +
      ' hours. If it really was that long, send it as separate entries for each day.';
  }
  renderQueueBadge();
}

function currentReason() { return SEL.otherReason ? $('whyOther').value.trim() : SEL.reason; }

function pickWho(n)  { SEL.name = n; $('whoSearch').value = ''; renderWho(); render(); }
function clearWho()  { SEL.name = ''; renderWho(); render(); setTimeout(function(){ $('whoSearch').focus(); }, 50); }
function pickAmt(a)  { $('amt').value = a; renderAmounts(); render(); }
function toggleSign(){ SEL.sign = -SEL.sign; render(); }
function pickWhen(w) {
  SEL.when = w;
  if (w === 'today')     $('whenDate').value = todayStr();
  if (w === 'yesterday') $('whenDate').value = shiftDays(todayStr(), -1);
  // 'other' deliberately keeps whatever is in the field and just reveals it,
  // so tapping Other after picking a date does not throw the date away.
  renderWhen(); render();
  if (w === 'other') {
    var el = $('whenDate');
    try { el.showPicker ? el.showPicker() : el.focus(); } catch (e) { el.focus(); }
  }
}
function onDateChange() {
  var v = $('whenDate').value;
  SEL.when = (v === todayStr()) ? 'today' : (v === shiftDays(todayStr(), -1) ? 'yesterday' : 'other');
  renderWhen(); render();
}

document.addEventListener('input', function(e) {
  if (!e.target) return;
  if (e.target.id === 'whoSearch') renderWho();
  if (e.target.id === 'whyOther') render();
});

// Tapping the date field itself counts as choosing another day.
document.addEventListener('DOMContentLoaded', function() {
  var g = $('whenGrid'); if (!g) return;
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function showTab(t) {
  TAB = t;
  $('tabLog').classList.toggle('on', t === 'log');
  $('tabHist').classList.toggle('on', t === 'hist');
  $('viewLog').classList.toggle('hidden', t !== 'log');
  $('viewHist').classList.toggle('hidden', t !== 'hist');
  $('saveBar').classList.toggle('hidden', t !== 'log');
  if (t === 'hist') { renderHistory(); refreshHistory(); }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
function renderHistory() {
  var box = $('histList'); if (!box) return;
  var q = ($('histSearch') && $('histSearch').value || '').trim().toLowerCase();
  var rows = HIST.filter(function(r) { return !q || r.name.toLowerCase().indexOf(q) !== -1; });

  if (!rows.length) {
    box.innerHTML = '<div class="empty">' +
      (HIST.length ? 'Nobody matches that name.' : 'Nothing logged in the last two months yet.') +
      '</div>';
    return;
  }

  box.innerHTML = rows.map(function(r) {
    return '<div class="row' + (r.voided ? ' void' : '') + '">' +
      '<div class="top"><span class="nm">' + esc(r.name) + '</span>' +
      '<span class="amt' + (r.amount < 0 ? ' neg' : '') + '">' +
        (r.unit === 'h' ? r.amount + ' h' : fmt(r.amount) + ' Ft') + '</span></div>' +
      '<div class="meta">' + esc(r.reason) + '</div>' +
      '<div class="meta">' + niceDate(r.date) + '</div>' +
      (r.voided
        ? '<span class="voidtag">Undone</span>'
        : '<div class="act"><button onclick="voidEntry(' + attr(r.id) + ',' + attr(r.name) + ')">Undo this entry</button></div>') +
      '</div>';
  }).join('');
}

function voidEntry(id, name) {
  if (!confirm('Undo this entry for ' + name + '?\n\nIt stays visible as undone and stops counting towards pay.')) return;
  post({ action: 'void', id: id }, function(res) {
    if (res && res.ok) {
      toast(true, 'Undone.');
      HIST = HIST.map(function(r) { return r.id === id ? Object.assign({}, r, { voided: true }) : r; });
      set(LS.hist, HIST);
      renderHistory();
      refreshHistory();
    } else {
      toast(false, (res && res.message) || 'No signal — try again when you are back online.');
    }
  });
}

// ---------------------------------------------------------------------------
// Save — optimistic, queued, retried
// ---------------------------------------------------------------------------
function save() {
  var amt = Math.abs(Number($('amt').value) || 0);
  var reason = currentReason();
  if (!SEL.name || !reason || !amt) return;
  if (isHours() && amt > (Number(BOOT.maxHoursPerEntry) || 12)) return;

  var when = $('whenDate').value || todayStr();
  var id = 'EXT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase();

  // Two shapes down one queue. The offline queue, the retry and the idempotency
  // all work the same either way; only `action` and the field names differ, and
  // the server routes on `action`.
  var entry = isHours()
    ? { clientId: id, action: 'hours', employeeName: SEL.name, date: when,
        hours: amt, reason: reason }
    : { clientId: id, employeeName: SEL.name, date: when,
        amount: SEL.sign * amt, description: reason };

  var q = get(LS.queue, []); q.push(entry); set(LS.queue, q);

  // Show it straight away — it is real to them the moment they tap.
  HIST.unshift({ id: id, date: when, name: SEL.name,
                 amount: isHours() ? amt : (SEL.sign * amt),
                 unit: isHours() ? 'h' : '',
                 reason: reason, by: (BOOT.me && BOOT.me.name) || 'PHONE APP', voided: false });
  set(LS.hist, HIST);

  toast(true, 'Saved · ' + SEL.name + ' · ' + (isHours() ? amt + ' h' : fmt(entry.amount) + ' Ft'));
  resetForm();
  flushQueue();
}

function resetForm() {
  // MODE deliberately survives — a supervisor logging hours logs several in a
  // row, and being dropped back to the money form after each one would be a
  // small betrayal every time.
  SEL = { name: '', reason: '', otherReason: false, sign: 1, when: 'today' };
  $('amt').value = ''; $('whyOther').value = ''; $('whoSearch').value = '';
  $('whyOtherWrap').classList.add('hidden');
  $('whenDate').value = todayStr();
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

var FLUSHING = false;
function flushQueue() {
  if (FLUSHING) return;
  var q = get(LS.queue, []);
  if (!q.length) { renderQueueBadge(); return; }
  FLUSHING = true;
  var entry = q[0];

  post(entry, function(res) {
    FLUSHING = false;
    if (res && res.ok) {
      var cur = get(LS.queue, []).filter(function(x) { return x.clientId !== entry.clientId; });
      set(LS.queue, cur);
      renderQueueBadge();
      if (cur.length) flushQueue(); else refreshHistory();
    } else if (res && res.ok === false) {
      // A rejection is permanent (bad key, unknown employee). Retrying for ever
      // would hide it, so drop it and say so rather than losing it silently.
      var cur2 = get(LS.queue, []).filter(function(x) { return x.clientId !== entry.clientId; });
      set(LS.queue, cur2);
      HIST = HIST.filter(function(r) { return r.id !== entry.clientId; });
      set(LS.hist, HIST); renderHistory();
      renderQueueBadge();
      toast(false, res.message || 'Rejected — not saved.');
    } else {
      renderQueueBadge(); // no signal — stays queued
    }
  });
}

function renderQueueBadge() {
  var n = get(LS.queue, []).length, b = $('qbadge');
  if (!b) return;
  b.className = 'qbadge' + (n ? ' on' : '');
  b.textContent = n ? n + ' to send' : '';
}

function toast(ok, msg) {
  var t = $('toast');
  t.className = 'toast on ' + (ok ? 'ok' : 'err');
  t.textContent = (ok ? '✓ ' : '⚠ ') + msg;
  clearTimeout(window._tt);
  window._tt = setTimeout(function(){ t.className = 'toast'; }, ok ? 2200 : 5000);
}

window.addEventListener('online', function(){ flushQueue(); refreshHistory(); });
document.addEventListener('visibilitychange', function() {
  if (!document.hidden) { flushQueue(); refreshHistory(); }
});

start();
