/*! BarChata Web Insights tracker — first-party, ~3 KB. Usage on any BarChata site:
 *  <script src="https://www.barchata.com/a.js" data-site="biz" defer></script>
 *  Custom events: window.bcTrack('claim_pick', { venue_id: '...' })
 *  Mark a button: <a data-track="pricing_start_pro">...</a>
 */
(function () {
  if (window.bcTrack) return;
  var d = document, w = window, nav = navigator;
  var me = d.currentScript;
  var SITE = (me && me.getAttribute('data-site')) || 'web';
  // The collector lives next to this script: www.barchata.com/api/t in production,
  // the same site on a Vercel preview or locally.
  var EP = (me && me.getAttribute('data-endpoint')) || 'https://www.barchata.com/api/t';
  try { if (me && me.src) EP = new URL('/api/t', me.src).toString(); } catch (e) {}

  var host = location.hostname, shared = /(^|\.)barchata\.com$/.test(host) ? '; domain=.barchata.com' : '';
  var secure = location.protocol === 'https:' ? '; secure' : '';
  function getC(n) { try { var m = d.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; } }
  function setC(n, v, sec) { try { d.cookie = n + '=' + encodeURIComponent(v) + '; path=/; max-age=' + sec + '; samesite=lax' + shared + secure; } catch (e) {} }
  function uid() {
    if (w.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }

  var dnt = nav.globalPrivacyControl === true || nav.doNotTrack === '1' || w.doNotTrack === '1';
  var consent = getC('bc_consent'); // '1' accepted, '0' declined, null not asked
  var vid = getC('bc_vid'), sid = getC('bc_sid');
  if (!dnt && consent !== '0') {
    if (!vid) vid = uid();
    if (!sid) sid = uid();
    setC('bc_vid', vid, 31536000);
    setC('bc_sid', sid, 1800); // a visit ends after 30 minutes of nothing
  }
  var internal = getC('bc_internal') === '1';

  var utm = null;
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('utm_source') || q.get('utm_campaign') || q.get('ref')) {
      utm = { source: q.get('utm_source') || q.get('ref'), medium: q.get('utm_medium'), campaign: q.get('utm_campaign') };
    }
  } catch (e) {}

  var queue = [], timer = null, sentFirst = false;
  function base() {
    return {
      site: SITE, vid: vid, sid: sid, dnt: dnt, consent: consent, internal: internal,
      webdriver: !!nav.webdriver,
      referrer: sentFirst ? null : (d.referrer || null),
      landing: sentFirst ? null : location.pathname + location.search,
      utm: sentFirst ? null : utm,
      screen: (w.screen && screen.width + 'x' + screen.height) || null,
      lang: nav.language || null,
      events: []
    };
  }
  function flush(useBeacon) {
    if (!queue.length) return;
    var body = base(); body.events = queue.splice(0, 50);
    var first = !sentFirst; sentFirst = true;
    var json = JSON.stringify(body);
    if (!dnt && consent !== '0') setC('bc_sid', sid, 1800);
    if (useBeacon && nav.sendBeacon) {
      try { nav.sendBeacon(EP, new Blob([json], { type: 'text/plain' })); return; } catch (e) {}
    }
    try {
      fetch(EP, { method: 'POST', body: json, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } })
        .then(function (r) { return r.json(); })
        .then(function (res) { if (first && res && res.consent === 'required' && consent === null && !dnt) banner(); })
        .catch(function () {});
    } catch (e) {}
  }
  function push(ev) {
    ev.path = ev.path || location.pathname;
    queue.push(ev);
    clearTimeout(timer);
    timer = setTimeout(flush, ev.type === 'pageview' ? 300 : 2000);
  }

  var pageStart = Date.now(), lastPath = null;
  function pageview() {
    var p = location.pathname + location.search;
    if (p === lastPath) return;
    lastPath = p; pageStart = Date.now();
    push({ type: 'pageview', name: 'page', path: location.pathname, label: d.title ? d.title.slice(0, 120) : null });
  }
  w.bcTrack = function (name, props) { push({ type: 'event', name: String(name).slice(0, 80), props: props || null }); };

  // Clicks on links and buttons. Labels only — never form values.
  d.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('[data-track],a,button');
    if (!el) return;
    var label = el.getAttribute('data-track-label') || el.getAttribute('aria-label') || (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    var props = {};
    if (el.tagName === 'A' && el.href) props.href = el.href.split('#')[0].slice(0, 300) + (el.hash || '');
    push({ type: 'click', name: el.getAttribute('data-track') || (el.tagName === 'A' ? 'link' : 'button'), label: label || null, props: props });
  }, true);

  // Single-page apps (Biz, Marketplace): count route changes as page views.
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    if (!orig) return;
    history[k] = function () { var r = orig.apply(this, arguments); setTimeout(pageview, 0); return r; };
  });
  w.addEventListener('popstate', pageview);

  d.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'hidden') {
      push({ type: 'event', name: 'page_leave', props: { seconds: Math.round((Date.now() - pageStart) / 1000) } });
      flush(true);
    }
  });

  // Consent banner — only shown where the law asks for opt-in (the server decides).
  function banner() {
    if (d.getElementById('bc-consent')) return;
    var b = d.createElement('div');
    b.id = 'bc-consent';
    b.setAttribute('role', 'dialog');
    b.setAttribute('aria-label', 'Analytics consent');
    b.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;max-width:460px;margin:0 auto;z-index:2147483000;background:#16150F;color:#F0EFE9;border-radius:16px;padding:18px 18px 16px;box-shadow:0 20px 60px rgba(0,0,0,.35);font:14px/1.5 Inter,-apple-system,Segoe UI,Roboto,sans-serif';
    b.innerHTML = '<div style="margin-bottom:12px">We use privacy-friendly analytics to understand how visitors use BarChata. No advertising cookies. <a href="https://www.barchata.com/privacy#analytics" style="color:#F27D26">Learn more</a></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-v="0" style="font:inherit;font-weight:600;padding:9px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#F0EFE9;cursor:pointer">Decline</button>' +
      '<button type="button" data-v="1" style="font:inherit;font-weight:700;padding:9px 16px;border-radius:10px;border:0;background:#F27D26;color:#16150F;cursor:pointer">Accept</button></div>';
    b.addEventListener('click', function (e) {
      var v = e.target && e.target.getAttribute && e.target.getAttribute('data-v');
      if (v !== '0' && v !== '1') return;
      e.stopPropagation();
      consent = v;
      setC('bc_consent', v, 31536000);
      b.remove();
      if (v === '1') { sentFirst = false; lastPath = null; pageview(); }
    }, true);
    d.body.appendChild(b);
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', pageview); else pageview();
})();
