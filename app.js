// =============================================================================
// Hyginix — Log Extra (phone app)
//
// The whole design follows from one requirement: under five seconds, and never
// waiting for the network.
//
//   • The app is service-worker cached, so it opens instantly and offline.
//   • Employees and presets are cached in localStorage and refreshed in the
//     background — the screen is usable before any network call finishes.
//   • Saving is OPTIMISTIC: the entry goes into a local queue, the OM is told
//     "Saved" immediately, and the queue is flushed in the background. If he is
//     in a stairwell with no signal it stays queued and goes when signal
//     returns. He never waits, and nothing is lost.
//
// Every queued entry carries its own id, which the server uses as an
// idempotency key — retries after a dropped connection cannot double-pay
// anyone. See EXTRAS_API.gs.
// =============================================================================

var LS = {
  url:    'hx_url',
  key:    'hx_key',
  boot:   'hx_boot',
  queue:  'hx_queue',
  recent: 'hx_recent'   // people used on THIS phone, most recent first
};

var BOOT = { employees: [], recent: [], reasons: [], amounts: [] };
var SEL = { name: '', reason: '', otherReason: false, sign: 1, when: 'today' };

function $(id) { return document.getElementById(id); }
function get(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
function set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function shiftDays(str, n) {
  var p = str.split('-');
  var d = new Date(Number(p[0]), Number(p[1])-1, Number(p[2]) + n);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function fmt(n) {
  n = Number(n) || 0;
  return (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('hu-HU').replace(/,/g,' ');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function start() {
  if (!localStorage.getItem(LS.url) || !localStorage.getItem(LS.key)) {
    $('setup').classList.remove('hidden');
    return;
  }
  $('app').classList.remove('hidden');
  BOOT = get(LS.boot, BOOT);
  $('whenDate').value = todayStr();
  renderChips();
  render();
  flushQueue();          // anything stranded from last time goes first
  refreshBootstrap();    // then quietly freshen the lists
}

function saveSetup() {
  var url = $('s_url').value.trim();
  var key = $('s_key').value.trim();
  if (!url || !key) { toast(false, 'Both fields are needed.'); return; }
  localStorage.setItem(LS.url, JSON.stringify(url));
  localStorage.setItem(LS.key, JSON.stringify(key));
  $('setup').classList.add('hidden');
  start();
}

// JSONP — a cross-origin fetch() to an Apps Script /exec URL goes through a
// googleusercontent redirect and is unreliable; a script tag sidesteps CORS
// completely. Failure is silent on purpose: the app already has cached lists
// and must stay usable.
function refreshBootstrap() {
  var url = get(LS.url, ''), key = get(LS.key, '');
  if (!url) return;
  var cbName = 'hxcb' + Date.now();
  var s = document.createElement('script');
  var done = false;
  window[cbName] = function(res) {
    done = true;
    if (res && res.ok) {
      BOOT = res;
      set(LS.boot, res);
      renderChips();
    }
    cleanup();
  };
  function cleanup() {
    try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
    if (s.parentNode) s.parentNode.removeChild(s);
  }
  s.onerror = cleanup;
  setTimeout(function(){ if (!done) cleanup(); }, 12000);
  s.src = url + '?callback=' + cbName + '&key=' + encodeURIComponent(key) + '&t=' + Date.now();
  document.body.appendChild(s);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderChips() {
  // WHO — this phone's own recent people first (they repeat constantly), then
  // whatever the server reports, then everyone else via search.
  var mine = get(LS.recent, []);
  var people = mine.concat((BOOT.recent || []).filter(function(n){ return mine.indexOf(n) === -1; })).slice(0, 8);
  $('whoChips').innerHTML = people.map(function(n) {
    return '<button class="chip' + (SEL.name === n ? ' on' : '') + '" onclick="pickWho(' + JSON.stringify(n).replace(/"/g,'&quot;') + ')">' + esc(n) + '</button>';
  }).join('') || '<span class="hint">Search for someone below.</span>';

  // WHY
  var reasons = BOOT.reasons || [];
  $('whyChips').innerHTML = reasons.map(function(r) {
    return '<button class="chip wide' + (SEL.reason === r && !SEL.otherReason ? ' on' : '') + '" onclick="pickWhy(' + JSON.stringify(r).replace(/"/g,'&quot;') + ')">' + esc(r) + '</button>';
  }).join('') +
    '<button class="chip ghost wide' + (SEL.otherReason ? ' on' : '') + '" onclick="pickOther()">✎ Other reason…</button>';

  // HOW MUCH
  $('amtChips').innerHTML = (BOOT.amounts || []).map(function(a) {
    return '<button class="chip" onclick="pickAmt(' + a + ')">' + fmt(a) + '</button>';
  }).join('');

  // WHEN
  var opts = [['today','Today'], ['yesterday','Yesterday'], ['pick','Another day…']];
  $('whenChips').innerHTML = opts.map(function(o) {
    return '<button class="chip' + (SEL.when === o[0] ? ' on' : '') + '" onclick="pickWhen(\'' + o[0] + '\')">' + o[1] + '</button>';
  }).join('');
}

function render() {
  $('whoPick').textContent = SEL.name ? '· ' + SEL.name : '';
  var why = currentReason();
  $('whyPick').textContent = why ? '· ' + (why.length > 26 ? why.slice(0,26) + '…' : why) : '';
  $('signBtn').textContent = SEL.sign > 0 ? '+' : '−';
  $('signBtn').className = 'sign' + (SEL.sign < 0 ? ' minus' : '');

  var amt = Math.abs(Number($('amt').value) || 0);
  $('saveBtn').disabled = !(SEL.name && why && amt > 0);
  $('saveBtn').textContent = amt > 0 && SEL.name
    ? 'Save ' + fmt(SEL.sign * amt) + ' Ft'
    : 'Save';
  renderQueueBadge();
}

function currentReason() {
  return SEL.otherReason ? $('whyOther').value.trim() : SEL.reason;
}

function pickWho(n) { SEL.name = n; $('whoSearch').value = ''; renderChips(); render(); }
function pickWhy(r) { SEL.reason = r; SEL.otherReason = false; $('whyOtherWrap').classList.add('hidden'); renderChips(); render(); }
function pickOther() {
  SEL.otherReason = true; SEL.reason = '';
  $('whyOtherWrap').classList.remove('hidden');
  renderChips(); render(); $('whyOther').focus();
}
function pickAmt(a) { $('amt').value = a; render(); }
function toggleSign() { SEL.sign = -SEL.sign; render(); }
function pickWhen(w) {
  SEL.when = w;
  $('whenPickWrap').classList.toggle('hidden', w !== 'pick');
  if (w === 'today') $('whenDate').value = todayStr();
  if (w === 'yesterday') $('whenDate').value = shiftDays(todayStr(), -1);
  renderChips(); render();
}

// Search across everyone — only needed for the long tail, so it renders into
// the same chip row rather than opening another screen.
document.addEventListener('input', function(e) {
  if (e.target && e.target.id === 'whoSearch') {
    var q = e.target.value.trim().toLowerCase();
    if (!q) { renderChips(); return; }
    var hits = (BOOT.employees || []).filter(function(p) {
      return p.name.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 10);
    $('whoChips').innerHTML = hits.length
      ? hits.map(function(p) {
          return '<button class="chip wide" onclick="pickWho(' + JSON.stringify(p.name).replace(/"/g,'&quot;') + ')">' + esc(p.name) + '</button>';
        }).join('')
      : '<span class="hint">Nobody matches.</span>';
  }
  if (e.target && e.target.id === 'whyOther') render();
});

// ---------------------------------------------------------------------------
// Save — optimistic, queued, retried
// ---------------------------------------------------------------------------
function save() {
  var amt = Math.abs(Number($('amt').value) || 0);
  var reason = currentReason();
  if (!SEL.name || !reason || !amt) return;

  var entry = {
    clientId: 'EXT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase(),
    employeeName: SEL.name,
    date: $('whenDate').value || todayStr(),
    amount: SEL.sign * amt,
    description: reason
  };

  var q = get(LS.queue, []);
  q.push(entry);
  set(LS.queue, q);

  // Remember this person on THIS phone — the same few come up over and over.
  var mine = get(LS.recent, []).filter(function(n) { return n !== SEL.name; });
  mine.unshift(SEL.name);
  set(LS.recent, mine.slice(0, 8));

  toast(true, 'Saved · ' + SEL.name + ' · ' + fmt(entry.amount) + ' Ft');
  resetForm();
  flushQueue();
}

function resetForm() {
  SEL.name = ''; SEL.reason = ''; SEL.otherReason = false; SEL.sign = 1; SEL.when = 'today';
  $('amt').value = ''; $('whyOther').value = ''; $('whoSearch').value = '';
  $('whyOtherWrap').classList.add('hidden');
  $('whenPickWrap').classList.add('hidden');
  $('whenDate').value = todayStr();
  renderChips(); render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

var FLUSHING = false;
function flushQueue() {
  if (FLUSHING) return;
  var q = get(LS.queue, []);
  if (!q.length) { renderQueueBadge(); return; }
  var url = get(LS.url, ''), key = get(LS.key, '');
  if (!url) return;

  FLUSHING = true;
  var entry = q[0];

  // text/plain keeps this a "simple request" so the browser sends no preflight,
  // which Apps Script cannot answer. The body is still JSON.
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ key: key }, entry))
  })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      FLUSHING = false;
      if (res && res.ok) {
        var cur = get(LS.queue, []).filter(function(x) { return x.clientId !== entry.clientId; });
        set(LS.queue, cur);
        renderQueueBadge();
        if (cur.length) flushQueue();   // keep going
      } else {
        // A rejection is permanent (bad key, unknown employee) — retrying for
        // ever would hide it. Drop it and say so, rather than silently losing
        // the entry or spinning on it.
        var cur2 = get(LS.queue, []).filter(function(x) { return x.clientId !== entry.clientId; });
        set(LS.queue, cur2);
        renderQueueBadge();
        toast(false, (res && res.message) || 'Rejected — not saved.');
      }
    })
    .catch(function() {
      // Network failure — keep it queued and try again later.
      FLUSHING = false;
      renderQueueBadge();
    });
}

function renderQueueBadge() {
  var n = get(LS.queue, []).length;
  var b = $('qbadge');
  if (!b) return;
  b.className = 'qbadge' + (n ? ' on' : '');
  b.textContent = n ? n + ' waiting to send' : '';
}

function toast(ok, msg) {
  var t = $('toast');
  t.className = 'toast on ' + (ok ? 'ok' : 'err');
  t.textContent = (ok ? '✓ ' : '⚠ ') + msg;
  clearTimeout(window._tt);
  window._tt = setTimeout(function() { t.className = 'toast'; }, ok ? 2200 : 5000);
}

window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', function() {
  if (!document.hidden) flushQueue();
});

start();
