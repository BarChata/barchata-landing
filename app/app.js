/* BarChata web app - for guests who scan a venue QR code or get a /join link.
 * Same accounts, Hearts and check-ins as the BarChata Social app (one Supabase project).
 * Plain JavaScript on purpose: the landing site is static, so there is no build step.
 *
 * Join our rewards (Oct 31, 2026): when a business has a welcome offer ("15% off your next visit"), the scan page shows
 * a "Join <business> rewards" card. Signed-in members join in one tap; anyone else gives their name and email or mobile
 * (no account needed) and gets a code to show the business. Bonus Hearts need a free account: they are added on the
 * Home screen once the person has one (same confirmed email). Server: arena-play join_offer / join_rewards / claim.
 *
 * Coaster (Nov 23, 2026): barchata.com/s is the QR on the generic coaster every business gets. It finds the business
 * from the phone's location (or a name search) and opens that business's /scan/<code> page.
 */
(function () {
  const cfg = window.BC_CONFIG || {};
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'bc-web-auth' },
  });
  const $app = document.getElementById('app');
  const MIN_AGE = 18;
  const PENDING = 'bc_pending_scan';
  const APP_STORE_LIVE = true; // flip when the App Store listing is approved
  const PLAY_STORE_LIVE = true; // flip when the Google Play listing is live

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3200); };
  const render = (html) => { $app.innerHTML = html; window.scrollTo(0, 0); };
  const go = (path) => { history.pushState({}, '', path); route(); };
  const loading = () => render('<div class="center"><div class="spinner"></div></div>');
  const initial = (name) => esc((name || '?').trim().charAt(0).toUpperCase());

  function header(right) {
    return '<div class="top"><a class="logo" href="/app" data-link><img src="/assets/barchata-icon.png" alt=""><span>Bar<b>Chata</b></span></a>' + (right || '') + '</div>';
  }

  function scanCodeFromPath() {
    const m = location.pathname.match(/^\/scan\/([^/?#]+)/i);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }
  const codeForms = (code) => (code.startsWith('@') ? [code, code.slice(1)] : [code, '@' + code]);

  function rememberScan(code) { try { sessionStorage.setItem(PENDING, JSON.stringify({ code, at: Date.now() })); } catch (e) {} }
  function takeScan() {
    try {
      const raw = sessionStorage.getItem(PENDING); if (!raw) return null;
      sessionStorage.removeItem(PENDING);
      const v = JSON.parse(raw); return Date.now() - v.at < 30 * 60 * 1000 ? v.code : null;
    } catch (e) { return null; }
  }

  // Arena (barchata.com/play) sends players here to sign in, then back to their game.
  const RETURN = 'bc_return_to';
  function takeReturn() {
    try {
      const v = JSON.parse(localStorage.getItem(RETURN) || 'null');
      if (!v) return null;
      localStorage.removeItem(RETURN);
      return Date.now() - v.at < 30 * 60 * 1000 && /^\/play(\/[A-Za-z0-9]{6})?$/.test(v.path) ? v.path : null;
    } catch (e) { return null; }
  }

  function formatDob(v) {
    const d = (v || '').replace(/\D/g, '').slice(0, 8);
    if (d.length <= 4) return d;
    if (d.length <= 6) return d.slice(0, 4) + '-' + d.slice(4);
    return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6);
  }
  function checkDob(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return 'Enter your date of birth as YYYY-MM-DD.';
    const [y, m, d] = v.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return 'That date does not exist.';
    const now = new Date();
    let age = now.getFullYear() - y;
    if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
    if (age > 120) return 'Please check the year.';
    if (age < MIN_AGE) return 'BarChata is for people of legal drinking age.';
    return null;
  }

  const cleanHandle = (v) => (v || '').toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9_]/g, '').slice(0, 30);
  async function checkHandle(h) {
    if (!/^[a-z0-9_]{3,30}$/.test(h)) return 'Your BarCode needs 3 to 30 letters, numbers or underscores.';
    const { data } = await sb.rpc('resolve_handle', { p_handle: h }).then((x) => x, () => ({ data: null }));
    if (data && data.found) return '@' + h + ' is taken. Try another.';
    return null;
  }
  async function saveHandle(uid, h) {
    return sb.from('profiles').update({ username: h, full_name: h }).eq('id', uid);
  }

  const SCAN_COLS = 'id, name, address, city, cover_image, logo_url, is_active, primary_barcode, owner_id, wifi_ssid, country';
  async function findVenue(code) {
    for (const form of codeForms(code)) {
      const { data, error } = await sb.from('venues').select(SCAN_COLS).eq('primary_barcode', form).limit(1).maybeSingle();
      if (error) throw error;
      if (data) return data;
    }
    // Printed before the owner renamed their handle.
    const { data: r } = await sb.rpc('resolve_handle', { p_handle: code }).then((x) => x, () => ({ data: null }));
    if (r && r.venue_id) {
      const { data } = await sb.from('venues').select(SCAN_COLS).eq('id', r.venue_id).maybeSingle();
      return data;
    }
    return null;
  }

  // Where the phone is (Nov 10, 2026): a venue's printed code is its public BarCode, so the server only pays
  // Hearts for it when the phone is near the venue. Null if location is refused or slow (the check-in is still saved).
  // Nov 23, 2026: Wi-Fi/cell location first (answers in a second or two indoors, accurate to about 20-100 m, which
  // is plenty for the 300 m rule), GPS only if that fails. One fix is shared by the coaster page and the check-in.
  let lastFix = null;
  function locate() {
    if (lastFix && Date.now() - lastFix.at < 120000) return Promise.resolve(lastFix);
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve({ error: 'unsupported' }); return; }
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const ok = (p) => {
        const acc = typeof p.coords.accuracy === 'number' && p.coords.accuracy > 0 ? p.coords.accuracy : 50;
        lastFix = { lat: p.coords.latitude, lng: p.coords.longitude, acc, at: Date.now() };
        finish(lastFix);
      };
      const fail = (e) => finish({ error: e && e.code === 1 ? 'denied' : 'unavailable' });
      navigator.geolocation.getCurrentPosition(ok, (e) => {
        if (e && e.code === 1) { fail(e); return; }
        navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
      }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
      setTimeout(() => finish({ error: 'unavailable' }), 60000); // the permission prompt was left open
    });
  }
  function scanPosition() {
    const fix = locate().then((p) => (p && p.lat != null ? { lat: p.lat, lng: p.lng } : null));
    return Promise.race([fix, new Promise((r) => setTimeout(() => r(null), 15000))]);
  }

  async function checkIn(code) {
    const pos = await scanPosition();
    for (const form of codeForms(code)) {
      const { data, error } = await sb.rpc('verify_checkin_qr', { p_qr: form, p_lat: pos ? pos.lat : null, p_lng: pos ? pos.lng : null });
      if (error) throw error;
      if ((data && data.ok) || (data && data.error !== 'qr_not_recognised')) return data;
    }
    return { ok: false, error: 'qr_not_recognised' };
  }

  // ------------------------------------------------------------------ join our rewards (arena-play edge function)
  async function callPlay(action, body) {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(cfg.url + '/functions/v1/arena-play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: 'Bearer ' + (session ? session.access_token : cfg.anonKey) },
      body: JSON.stringify(Object.assign({ action }, body || {})),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty */ }
    return { status: res.status, data: data || {} };
  }
  const fmt = (n) => Number(n || 0).toLocaleString();
  const joinState = { code: null, st: null, signedIn: false, busy: false, draft: { name: '', contact: '', marketing: false } };

  async function loadScanJoin(code, signedIn) {
    joinState.code = code; joinState.signedIn = signedIn; joinState.st = null;
    try {
      const r = await callPlay('join_offer', { source: 'checkin', scan_code: code });
      if (r.status === 200 && joinState.code === code) {
        joinState.st = r.data;
        // A quick join on this phone (no account): show the code again after a reload.
        const v = r.data && r.data.venue;
        if (v && !r.data.joined && !signedIn) {
          try { const saved = JSON.parse(localStorage.getItem('bc_join_' + v.id) || 'null'); if (saved && saved.code) { joinState.st = Object.assign({}, r.data, { joined: saved, eligible: false }); } } catch (e) { /* none saved */ }
        }
        fillScanJoin();
      }
    } catch (e) { /* no offer card when offline */ }
  }

  function scanJoinHtml() {
    const j = joinState.st, o = j && j.offer, v = (j && j.venue) || {};
    const vname = esc(v.name || 'this business');
    if (j && j.joined) {
      const jn = j.joined;
      const until = jn.expires_at ? new Date(jn.expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      const state = jn.status === 'redeemed' ? '<p class="join-state">✓ Used. Thanks for joining!</p>'
        : jn.status === 'expired' ? '<p class="join-state">This code has expired.</p>'
        : '<p class="muted">Show us this code</p><div class="join-code">' + esc(jn.code || '') + '</div><p class="muted">Valid until ' + esc(until) + '. Take a screenshot to keep it.</p>';
      let hearts = '';
      if (jn.hearts_bonus > 0 && !jn.account) hearts = '<p class="sub">+' + fmt(jn.hearts_bonus) + ' Hearts are waiting. Join BarChata free with the same email to collect them.</p>';
      else if (jn.hearts_paid > 0) hearts = '<p class="sub">+' + fmt(jn.hearts_paid) + ' Hearts were added to your Hearts at ' + vname + '.</p>';
      return '<div class="card join-card join-done"><p class="join-eyebrow">Welcome to ' + vname + ' rewards</p><div class="join-offer">' + esc(jn.offer || '') + '</div>' + state + hearts + '</div>';
    }
    if (!o || !j.eligible) return '';
    const head = '<p class="join-eyebrow">Join ' + vname + ' rewards</p><div class="join-offer">' + esc(o.offer) + '</div>' +
      (o.bonus_hearts > 0 ? '<span class="join-hearts">+' + fmt(o.bonus_hearts) + ' Hearts' + (joinState.signedIn ? '' : ' with a free account') + '</span>' : '');
    const consent = '<p class="muted">Joining shares your name and ' + (joinState.signedIn ? 'contact' : 'email or number') + ' with ' + vname + '.' + (o.fine_print ? ' ' + esc(o.fine_print) : '') + '</p>';
    const mk = '<label class="check"><input type="checkbox" id="joinMk"' + (joinState.draft.marketing ? ' checked' : '') + '><span>Send me offers from ' + vname + ' (optional)</span></label>';
    if (joinState.signedIn) {
      return '<div class="card join-card">' + head + mk + '<button class="btn" type="button" id="joinGo"' + (joinState.busy ? ' disabled' : '') + '>Join free</button>' + consent + '</div>';
    }
    return '<div class="card join-card">' + head +
      '<form id="joinForm" class="stack" novalidate>' +
      '<div class="field"><label for="joinName">Your name</label><input id="joinName" maxlength="60" autocomplete="name" placeholder="First and last name"></div>' +
      '<div class="field"><label for="joinContact">Email or mobile number</label><input id="joinContact" maxlength="254" autocomplete="email" inputmode="email" placeholder="you@email.com or 416 555 0199"></div>' +
      mk + '<button class="btn" id="joinGo"' + (joinState.busy ? ' disabled' : '') + '>Join and get my code</button>' + consent +
      '<p class="muted">No app needed. Have a BarChata account? Sign in below instead' + (o.bonus_hearts > 0 ? ' to also get your Hearts' : '') + '.</p></form></div>';
  }

  function fillScanJoin() {
    const slot = document.getElementById('joinSlot');
    if (!slot) return;
    slot.innerHTML = scanJoinHtml();
    const d = joinState.draft;
    const nm = document.getElementById('joinName'), ct = document.getElementById('joinContact'), mk = document.getElementById('joinMk');
    if (nm) { nm.value = d.name; nm.oninput = () => { d.name = nm.value; }; }
    if (ct) { ct.value = d.contact; ct.oninput = () => { d.contact = ct.value; }; }
    if (mk) mk.onchange = () => { d.marketing = mk.checked; };
    const form = document.getElementById('joinForm');
    if (form) form.onsubmit = (e) => { e.preventDefault(); scanJoinNow(); };
    else { const go = document.getElementById('joinGo'); if (go) go.onclick = scanJoinNow; }
  }

  async function scanJoinNow() {
    if (joinState.busy || !joinState.code) return;
    const d = joinState.draft;
    if (!joinState.signedIn) {
      if (d.name.trim().length < 2) { toast('Type your name.'); return; }
      if (d.contact.trim().length < 5) { toast('Add your email or mobile number.'); return; }
    }
    joinState.busy = true; fillScanJoin();
    try {
      const body = { source: 'checkin', scan_code: joinState.code, marketing: d.marketing };
      if (!joinState.signedIn) { body.name = d.name.trim(); body.contact = d.contact.trim(); }
      const r = await callPlay('join_rewards', body);
      if (r.status === 200 && r.data && (r.data.joined || r.data.already_member)) {
        joinState.st = r.data;
        if (r.data.joined && r.data.venue && !joinState.signedIn) { try { localStorage.setItem('bc_join_' + r.data.venue.id, JSON.stringify(r.data.joined)); } catch (e) { /* private mode */ } }
        if (r.data.already_member) toast('You’re already a member here.');
      } else {
        toast((r.data && r.data.error) || 'Could not join. Try again.');
      }
    } catch (e) { toast('No internet connection. Try again.'); }
    joinState.busy = false; fillScanJoin();
  }

  // Signed in: link any quick joins made with this (confirmed) email and add their bonus Hearts. Once per visit.
  async function claimJoins() {
    try {
      if (sessionStorage.getItem('bc_join_claimed')) return;
      sessionStorage.setItem('bc_join_claimed', '1');
    } catch (e) { /* private mode: try anyway */ }
    try {
      const r = await callPlay('claim', {});
      if (r.status === 200 && Number(r.data.join_hearts || 0) > 0) toast('+' + fmt(r.data.join_hearts) + ' welcome Hearts were added to your account!');
    } catch (e) { /* try again next visit */ }
  }

  // ------------------------------------------------------------------ what the business offers (Nov 23, 2026)
  // On the check-in page: Rewards (with the member's Hearts there), Wi-Fi and Menu, each only when the business has it
  // and has it switched on (venue_features: hearts_loyalty, wifi_access, menu; no row = on). Every part loads on its own
  // and just stays hidden if it can't load, so the check-in never waits for these or breaks because of them.
  // rewards.venue_id is the OWNER's profile id; place_ids (null = all the owner's places) says where a reward shows.
  // The Wi-Fi password comes only from get_venue_wifi: staff, or a member who checked in here in the last 8 hours.
  const CURRENCY = { canada: ['CAD', 'en-CA'], ca: ['CAD', 'en-CA'], 'united states': ['USD', 'en-US'], usa: ['USD', 'en-US'], us: ['USD', 'en-US'],
    brazil: ['BRL', 'pt-BR'], brasil: ['BRL', 'pt-BR'], br: ['BRL', 'pt-BR'], 'united kingdom': ['GBP', 'en-GB'], uk: ['GBP', 'en-GB'],
    mexico: ['MXN', 'es-MX'], philippines: ['PHP', 'en-PH'] };
  function money(n, country) {
    const x = Number(n);
    if (n == null || n === '' || !isFinite(x)) return '';
    const c = CURRENCY[String(country || '').trim().toLowerCase()];
    try { if (c) return new Intl.NumberFormat(c[1], { style: 'currency', currency: c[0] }).format(x); } catch (e) { /* old browser */ }
    return '$' + x.toFixed(2);
  }
  const shortDate = (d) => { try { return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; } };
  const ext = { v: null, opts: {}, feat: null, menu: null, rewards: null, loyalty: false, wifi: null, hearts: null, busy: false };

  async function loadExtras(v, opts) {
    Object.assign(ext, { v, opts: opts || {}, feat: null, menu: null, rewards: null, loyalty: false, wifi: null, hearts: null, busy: false });
    const mine = v.id;
    const get = (q) => Promise.resolve(q).then((r) => (r && !r.error ? r.data : null), () => null);
    const o = ext.opts;
    const [feat, cats, items, rewards, wifi, member] = await Promise.all([
      get(sb.from('venue_features').select('feature, is_enabled').eq('venue_id', v.id).in('feature', ['menu', 'wifi_access', 'hearts_loyalty'])),
      get(sb.from('menu_categories').select('id, name, sort_order, is_active').eq('venue_id', v.id).order('sort_order').limit(100)),
      get(sb.from('menu_items').select('id, category_id, name, description, price, image_url, is_available, is_featured, sort_order').eq('venue_id', v.id).order('sort_order').limit(400)),
      v.owner_id ? get(sb.from('rewards').select('id, title, description, hearts_cost, quantity_available, quantity_redeemed, expires_at, place_ids').eq('venue_id', v.owner_id).eq('active', true).order('hearts_cost').limit(60)) : null,
      o.signedIn ? get(sb.rpc('get_venue_wifi', { p_venue_id: v.id })) : null,
      o.uid ? get(sb.from('members').select('hearts').eq('venue_id', v.id).eq('profile_id', o.uid).maybeSingle()) : null,
    ]);
    if (!ext.v || ext.v.id !== mine) return; // moved to another place meanwhile
    ext.feat = feat || [];
    const on = (f) => !ext.feat.some((r) => r.feature === f && r.is_enabled === false);
    // Menu: active categories in order, available items; items without a (live) category go under "More".
    if (on('menu') && items && items.length) {
      const live = (cats || []).filter((c) => c.is_active !== false);
      const byCat = {};
      const offCats = (cats || []).filter((c) => c.is_active === false).map((c) => c.id); // the business hid these
      items.filter((i) => i.is_available !== false && i.name && offCats.indexOf(i.category_id) < 0).forEach((i) => {
        const k = live.some((c) => c.id === i.category_id) ? i.category_id : '_more';
        (byCat[k] = byCat[k] || []).push(i);
      });
      const groups = live.filter((c) => byCat[c.id]).map((c) => ({ name: c.name, items: byCat[c.id] }));
      if (byCat._more) groups.push({ name: groups.length ? 'More' : 'Menu', items: byCat._more });
      ext.menu = groups.length ? groups : null;
    }
    // Rewards: still running, shown at this place, not sold out; identical copies shown once.
    if (on('hearts_loyalty') && rewards) {
      const now = Date.now(), seen = {};
      ext.rewards = rewards.filter((r) => (!r.expires_at || new Date(r.expires_at).getTime() > now)
          && (!r.place_ids || !r.place_ids.length || r.place_ids.indexOf(v.id) >= 0)
          && (r.quantity_available == null || Number(r.quantity_redeemed || 0) < Number(r.quantity_available)))
        .filter((r) => { const k = [r.title, r.hearts_cost, r.description || ''].join('|').toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
      ext.loyalty = true;
    }
    if (on('wifi_access')) ext.wifi = wifi || (v.wifi_ssid ? { ssid: v.wifi_ssid, unknown: true } : null);
    ext.hearts = member ? Number(member.hearts || 0) : (o.uid ? 0 : null);
    paintExtras();
  }

  function paintExtras() {
    const slot = document.getElementById('extras');
    if (!slot || !ext.v) return;
    const v = ext.v, o = ext.opts, out = [];
    // Rewards + Hearts
    if (ext.loyalty) {
      const mine = ext.hearts;
      const head = '<div class="xhead"><h2>Rewards</h2>' + (mine != null ? '<span class="pill">' + fmt(mine) + ' Hearts here</span>' : '') + '</div>' +
        '<p class="muted">Earn Hearts every time you check in at ' + esc(v.name) + ', then trade them for rewards.</p>';
      const rows = (ext.rewards || []).map((r) => {
        const cost = Number(r.hearts_cost || 0);
        const left = r.quantity_available != null ? Math.max(0, Number(r.quantity_available) - Number(r.quantity_redeemed || 0)) : null;
        const meta = [left != null ? left + ' left' : '', r.expires_at ? 'until ' + shortDate(r.expires_at) : ''].filter(Boolean).join(' · ');
        let act = '';
        if (o.signedIn && mine != null) {
          act = mine >= cost
            ? '<button class="btn sm" type="button" data-redeem="' + esc(r.id) + '"' + (ext.busy ? ' disabled' : '') + '>Redeem</button>'
            : '<span class="muted xneed">' + fmt(cost - mine) + ' more</span>';
        }
        return '<div class="xrow"><div class="xmain"><div class="t">' + esc(r.title) + '</div>' +
          (r.description ? '<div class="muted">' + esc(r.description) + '</div>' : '') + (meta ? '<div class="muted">' + esc(meta) + '</div>' : '') +
          '</div><div class="xside"><span class="pill">' + fmt(cost) + ' Hearts</span>' + act + '</div></div>';
      }).join('');
      const foot = !o.signedIn ? '<p class="muted xfoot">Join free to start earning Hearts here.</p>' : '';
      out.push('<div class="card xcard" id="xRewards">' + head + (rows ? '<div class="xlist">' + rows + '</div>' : '') + foot + '</div>');
    }
    // Wi-Fi
    const w = ext.wifi;
    if (w && (w.ssid || w.password)) {
      let body;
      if (w.password) {
        body = '<div class="xrow"><div class="xmain"><div class="muted">Password</div><div class="wifi-pw">' + esc(w.password) + '</div></div>' +
          '<div class="xside"><button class="btn sm secondary" type="button" data-copy="' + esc(w.password) + '">Copy</button></div></div>';
      } else if (w.unknown) {
        body = '<p class="muted">Join free and check in to get the password.</p>';
      } else if (w.has_password === false) {
        body = '<p class="muted">No password needed.</p>';
      } else {
        body = '<p class="muted">' + (o.checkedIn ? 'The password shows here once your check-in is confirmed at ' + esc(v.name) + '.' : 'Check in to see the password.') + '</p>';
      }
      out.push('<div class="card xcard"><div class="xhead"><h2>Wi-Fi</h2></div>' +
        (w.ssid ? '<div class="xrow"><div class="xmain"><div class="muted">Network</div><div class="t">' + esc(w.ssid) + '</div></div></div>' : '') + body + '</div>');
    }
    // Menu
    if (ext.menu) {
      const groups = ext.menu.map((g, i) => '<details class="mgroup"' + (i === 0 ? ' open' : '') + '><summary>' + esc(g.name) + '<span class="muted">' + g.items.length + '</span></summary>' +
        g.items.map((it) => '<div class="mitem">' + (it.image_url ? '<img src="' + esc(it.image_url) + '" alt="" loading="lazy">' : '') +
          '<div class="xmain"><div class="t">' + esc(it.name) + (it.is_featured ? ' <span class="pill">Popular</span>' : '') + '</div>' +
          (it.description ? '<div class="muted">' + esc(it.description) + '</div>' : '') + '</div>' +
          (money(it.price, v.country) ? '<div class="price">' + esc(money(it.price, v.country)) + '</div>' : '') + '</div>').join('') + '</details>').join('');
      out.push('<div class="card xcard"><div class="xhead"><h2>Menu</h2></div>' + groups + '</div>');
    }
    slot.innerHTML = out.join('');
    slot.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch (e) { toast('Press and hold the password to copy it.'); }
    }; });
    slot.querySelectorAll('[data-redeem]').forEach((b) => { b.onclick = () => askRedeem(b.dataset.redeem); });
  }

  function askRedeem(id) {
    const r = (ext.rewards || []).find((x) => x.id === id);
    if (!r || ext.busy) return;
    const wrap = document.createElement('div');
    wrap.className = 'sheetwrap';
    wrap.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-label="Redeem reward"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2>Redeem this reward?</h2><button class="iconbtn" data-close aria-label="Close">✕</button></div>' +
      '<div class="join-offer">' + esc(r.title) + '</div><p class="sub">' + fmt(r.hearts_cost) + ' Hearts from your Hearts at ' + esc(ext.v.name) + '. Show the next screen to the staff.</p><div class="gap"></div>' +
      '<div class="stack"><button class="btn" type="button" id="xGo">Redeem for ' + fmt(r.hearts_cost) + ' Hearts</button><button class="btn secondary" type="button" data-close>Not now</button></div></div>';
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove(); });
    document.body.appendChild(wrap);
    document.getElementById('xGo').onclick = async (e) => {
      e.target.disabled = true; e.target.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px"></div>';
      ext.busy = true;
      let res = null;
      try { const { data, error } = await sb.rpc('redeem_reward', { p_venue_id: ext.v.id, p_reward_id: r.id }); res = error ? { ok: false, error: error.message } : data; }
      catch (err) { res = { ok: false, error: 'offline' }; }
      ext.busy = false;
      const sheet = wrap.querySelector('.sheet');
      if (res && res.ok) {
        if (res.new_balance != null) ext.hearts = Number(res.new_balance);
        sheet.innerHTML = '<div class="center" style="min-height:0;padding:8px 0"><div class="success">✓</div><h2>Show this to the staff</h2>' +
          '<div class="join-offer">' + esc(res.reward_title || r.title) + '</div><p class="muted">' + esc(ext.v.name) + ' · ' + new Date().toLocaleString() + '</p>' +
          '<p class="sub">' + fmt(res.hearts_spent || r.hearts_cost) + ' Hearts used. You have ' + fmt(ext.hearts) + ' Hearts here now.</p>' +
          '<button class="btn" type="button" data-close>Done</button></div>';
      } else {
        const why = { not_authenticated: 'Please sign in again.', not_a_member: 'Check in here first to start collecting Hearts at ' + ext.v.name + '.',
          insufficient_hearts: 'You don’t have enough Hearts here yet.', reward_sold_out: 'This reward has run out.',
          reward_unavailable: 'This reward isn’t available any more.', offline: 'No internet connection. Try again.' }[res && res.error] || 'Could not redeem. Try again.';
        toast(why);
        wrap.remove();
      }
      paintExtras();
    };
  }

  function venueCard(v) {
    const img = v.cover_image || v.logo_url;
    return '<div class="card venue"><div class="img"' + (img ? ' style="background-image:url(' + esc(img) + ')"' : '') + '>' + (img ? '' : initial(v.name)) + '</div>' +
      '<div><div class="name">' + esc(v.name) + '</div><div class="muted">' + esc(placeLine(v)) + '</div></div></div>';
  }

  // ------------------------------------------------------------------ views
  async function viewScan(code) {
    loading();
    let v = null;
    try { v = await findVenue(code); }
    catch (err) {
      render(header() + '<div class="center"><h1>Connection problem</h1><p class="sub">We could not reach BarChata. Check your connection and try again.</p><button class="btn" onclick="location.reload()">Try again</button></div>');
      return;
    }
    if (!v) {
      render(header() + '<div class="center"><h1>Code not found</h1><p class="sub">This check-in code is not linked to a venue. Ask the staff for their current QR code.</p><a class="btn secondary" href="/app" data-link>Go to BarChata</a></div>');
      return;
    }
    const { data: { session } } = await sb.auth.getSession();
    const closed = v.is_active === false ? '<p class="err">This place is no longer listed on BarChata.</p>' : '';
    if (!session) {
      rememberScan(code);
      render(header() + '<h1>Check in and earn Hearts</h1><p class="sub">Join BarChata free to check in here, collect Hearts and unlock rewards.</p><div class="gap"></div>' +
        venueCard(v) + notHere() + closed + '<div id="joinSlot"></div><div class="gap"></div><div class="stack">' +
        '<button class="btn" data-go="/join">Join BarChata free</button><button class="btn secondary" data-go="/app?mode=signin">I have an account</button></div><div id="extras"></div>' + legal());
      if (v.is_active !== false) { loadScanJoin(code, false); loadExtras(v, { signedIn: false }); }
      return;
    }
    render(header() + '<h1>You are at</h1><div class="gap"></div>' + venueCard(v) + notHere() + closed + '<div class="gap"></div>' +
      '<button class="btn" id="doCheckin"' + (v.is_active === false ? ' disabled' : '') + '>Check in</button><p class="muted" style="text-align:center;margin-top:10px">One tap. Hearts go straight to your account.</p><div id="joinSlot"></div><div id="extras"></div>');
    const uid = session.user && session.user.id;
    if (v.is_active !== false) { loadScanJoin(code, true); loadExtras(v, { signedIn: true, uid }); }
    document.getElementById('doCheckin').onclick = async (e) => {
      e.target.disabled = true; e.target.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px"></div>';
      try {
        const res = await checkIn(code);
        if (res && res.ok) {
          // Say what really happened (Nov 5, 2026): a repeat scan saves nothing, and a
          // venue with no Hearts left gives none - neither is "limited per visit".
          const award = (res && res.award) || {};
          const pts = Number(award.points_awarded || res.points_awarded || res.points || 0);
          const again = res.status === 'already_checked_in';
          // Saved, but the phone wasn't shown to be at the venue: Hearts wait for a scan there.
          const held = res.status === 'pending_verification';
          let line;
          if (held) line = esc(res.message || 'Your check-in is saved. Scan again at the venue to collect your Hearts.');
          else if (again) line = esc(res.message || 'You already checked in here today. You can check in again tomorrow.');
          else if (pts > 0) line = '<b style="color:var(--brand)">+' + pts + ' Hearts</b>';
          else if (award.source === 'pool_empty' || award.points_enabled === false) line = 'Check-in saved. ' + esc(v.name) + ' isn\u2019t giving Hearts right now.';
          else if (award.already_awarded_today) line = 'Check-in saved. Hearts here are once a day.';
          else line = 'Check-in saved.';
          render(header() + '<div class="center"><div class="success">✓</div><h1>' + (held ? 'Check-in saved' : again ? 'Already checked in today' : 'You are checked in') + '</h1><p class="sub">' + esc(v.name) +
            '<br>' + line +
            '</p><div class="stack" style="width:100%"><a class="btn" href="/app" data-link>See my Hearts</a></div></div><div id="joinSlot"></div><div id="extras"></div>');
          fillScanJoin();
          loadExtras(v, { signedIn: true, uid, checkedIn: true }); // after a check-in the Wi-Fi password can unlock
        } else {
          const msg = { not_authenticated: 'Please sign in again.', qr_not_recognised: 'This code is not recognised.' }[res && res.error] || (res && (res.message || res.error)) || 'Could not check in.';
          toast(msg); e.target.disabled = false; e.target.textContent = 'Check in';
        }
      } catch (err) { toast(err.message || 'Could not check in.'); e.target.disabled = false; e.target.textContent = 'Check in'; }
    };
  }

  // ------------------------------------------------------------------ coaster (barchata.com/s), Nov 23, 2026
  // Every BarChata business gets the same printed coaster, so its QR has no business code in it. /s finds the business
  // the guest is sitting in as soon as it opens: one BarChata place close by opens its check-in page straight away;
  // several show as a list, closest first; with no location, every BarChata place is listed and the search box filters
  // it as you type. Only businesses on BarChata (claimed, with a BarCode, active) are listed.
  const COASTER_HERE_M = 400;    // "you are here" candidates (QR Hearts are paid within 300 m of the business)
  const COASTER_SURE_M = 120;    // nearest this close and the next 3x farther: open it straight away
  const COASTER_SURE_ACC = 250;  // only open straight away when the phone's own accuracy is this good
  const COASTER_NEAR_M = 3000;
  const COASTER_LIST_MAX = 500;  // more places than this: search on the server instead of in the page
  const COASTER_FLAG = 'bc_from_coaster';
  const VENUE_COLS = 'id, name, address, city, category, cover_image, logo_url, is_active, primary_barcode, lat, lng';
  const cst = { all: null, capped: false, loadErr: false, pos: null, near: null, loc: 'locating', noAuto: false, q: '', touched: false, remote: null, refused: 0 };

  function metres(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const distLabel = (m) => (m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + ' m' : m < 100000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m / 1000) + ' km');
  const scanPath = (v) => '/scan/' + encodeURIComponent(String(v.primary_barcode || '').replace(/^@/, ''));
  const onBarChata = (v) => !!(v && v.primary_barcode && v.is_active !== false);
  const onCoasterPage = () => /^\/s\/?$/i.test(location.pathname);
  const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^@+/, '').trim();
  function fromCoaster() {
    try { const at = Number(sessionStorage.getItem(COASTER_FLAG) || 0); return Date.now() - at < 30 * 60 * 1000; } catch (e) { return false; }
  }
  function withDist(arr) {
    if (!cst.pos) return arr;
    return arr.map((v) => Object.assign({}, v, { dist: v.lat != null && v.lng != null ? metres(cst.pos, { lat: Number(v.lat), lng: Number(v.lng) }) : null }))
      .sort((a, b) => (a.dist == null) - (b.dist == null) || (a.dist || 0) - (b.dist || 0));
  }

  async function coasterLoadAll() {
    const { data, error } = await sb.from('venues').select(VENUE_COLS)
      .eq('is_claimed', true).not('primary_barcode', 'is', null).order('name').limit(COASTER_LIST_MAX + 1);
    if (error) throw error;
    cst.capped = (data || []).length > COASTER_LIST_MAX;
    cst.all = (data || []).slice(0, COASTER_LIST_MAX).filter(onBarChata);
  }

  async function coasterNearby(pos) {
    const dLat = COASTER_NEAR_M / 111320;
    const dLng = dLat / Math.max(0.2, Math.cos(pos.lat * Math.PI / 180));
    const { data, error } = await sb.from('venues').select(VENUE_COLS)
      .eq('is_claimed', true).not('primary_barcode', 'is', null)
      .gte('lat', pos.lat - dLat).lte('lat', pos.lat + dLat)
      .gte('lng', pos.lng - dLng).lte('lng', pos.lng + dLng)
      .limit(60);
    if (error) throw error;
    return withDist((data || []).filter(onBarChata)).filter((v) => v.dist != null && v.dist <= COASTER_NEAR_M);
  }

  // Only used when there are too many places to keep in the page.
  async function coasterSearch(q) {
    q = (q || '').trim();
    const out = [];
    if (/^@?[a-z0-9_.-]{3,40}$/i.test(q)) {
      try { const v = await findVenue(q.replace(/^@/, '')); if (onBarChata(v)) out.push(v); } catch (e) { /* keep searching by name */ }
    }
    const safe = q.replace(/[%_\\]/g, ' ').trim();
    if (safe.length >= 2) {
      const { data, error } = await sb.from('venues').select(VENUE_COLS)
        .eq('is_claimed', true).not('primary_barcode', 'is', null)
        .ilike('name', '%' + safe + '%').order('name').limit(12);
      if (error) throw error;
      (data || []).filter(onBarChata).forEach((v) => { if (!out.some((o) => o.id === v.id)) out.push(v); });
    }
    return withDist(out);
  }

  const pinIcon = () => '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.6"/></svg>';
  const searchIcon = () => '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

  function placeLine(v) {
    const a = String(v.address || '').trim(), c = String(v.city || '').trim();
    return a && c && a.toLowerCase().includes(c.toLowerCase()) ? a : [a, c].filter(Boolean).join(', ');
  }

  function pickCard(v) {
    const img = v.cover_image || v.logo_url;
    return '<a class="card venue pick" href="' + esc(scanPath(v)) + '" data-link>' +
      '<div class="img"' + (img ? ' style="background-image:url(' + esc(img) + ')"' : '') + '>' + (img ? '' : initial(v.name)) + '</div>' +
      '<div class="pick-body"><div class="name">' + esc(v.name) + '</div><div class="muted">' + esc(placeLine(v)) + '</div></div>' +
      (v.dist != null ? '<span class="pill">' + distLabel(v.dist) + '</span>' : '<span class="chev" aria-hidden="true">›</span>') + '</a>';
  }

  function coasterView(noAuto) {
    Object.assign(cst, { pos: null, near: null, loc: 'locating', noAuto: !!noAuto, q: '', touched: false, remote: null, refused: 0 });
    watchLocationTurnedOn();
    render(header() + '<div class="coaster">' +
      '<h1 class="shout sm">Earn rewards<br><span>here.</span></h1>' +
      '<p class="sub">Pick the place you’re in to join free or check in. No app needed.</p><div class="gap"></div>' +
      '<form id="cs" class="searchbar" role="search" novalidate>' + searchIcon() +
      '<input id="csq" type="search" name="bc-place-search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search BarChata places" placeholder="Search places or @BarCode"></form>' +
      '<div id="cStatus" class="cstatus" aria-live="polite"></div><div id="cList" class="stack"></div></div>' + legal());
    const q = document.getElementById('csq');
    let t = null, seq = 0;
    q.onfocus = () => { cst.touched = true; };
    q.oninput = () => {
      cst.touched = true; cst.q = q.value;
      clearTimeout(t);
      if (cst.capped && cst.q.trim().length >= 2) {
        t = setTimeout(async () => {
          const mine = ++seq;
          try { const r = await coasterSearch(cst.q); if (mine === seq) { cst.remote = r; coasterPaint(); } } catch (e) { if (mine === seq) { cst.remote = []; coasterPaint(); } }
        }, 300);
      } else { t = setTimeout(coasterPaint, 60); }
    };
    document.getElementById('cs').onsubmit = (e) => { e.preventDefault(); q.blur(); };
    coasterPaint();
    coasterLoadAll().then(coasterPaint).catch(() => { cst.loadErr = true; coasterPaint(); });
    coasterFind();
  }

  async function coasterFind() {
    cst.loc = 'locating'; coasterPaint();
    const p = await locate();
    if (!onCoasterPage()) return;
    if (p.error) {
      cst.loc = p.error === 'denied' ? 'denied' : 'unavailable';
      if (p.error === 'denied') cst.refused++;
      coasterPaint();
      return;
    }
    cst.refused = 0;
    cst.pos = p;
    try { cst.near = await coasterNearby(p); } catch (e) { cst.near = []; }
    if (!onCoasterPage()) return;
    const here = cst.near.filter((v) => v.dist <= COASTER_HERE_M);
    cst.loc = here.length ? 'here' : 'far';
    const sure = here.length > 0 && p.acc <= COASTER_SURE_ACC &&
      (here.length === 1 || (here[0].dist <= COASTER_SURE_M && here[1].dist > 3 * here[0].dist));
    if (sure && !cst.noAuto && !cst.touched && !cst.q.trim()) { history.replaceState({}, '', scanPath(here[0])); route(); return; }
    coasterPaint();
  }

  function coasterPaint() {
    const st = document.getElementById('cStatus'), box = document.getElementById('cList');
    if (!st || !box) return;
    const q = cst.q.trim();
    let s;
    if (cst.loc === 'locating') s = '<div class="spinner sm"></div><span>Finding the place you’re in…</span>';
    else if (cst.loc === 'here') s = pinIcon() + '<span><b>Which place are you at?</b> Closest first.</span>';
    else if (cst.loc === 'far') s = pinIcon() + '<span>No BarChata place right here. Closest first.</span>';
    else if (cst.loc === 'denied' && cst.refused >= 2) s = '<span>Location is still off. If you just turned it on, refresh this page. <button type="button" class="linkbtn" id="cReload">Refresh</button> \u00b7 <button type="button" class="linkbtn" id="cHow">How to turn it on</button></span>';
    else if (cst.loc === 'denied') s = '<span>Location is off for this browser, so pick your place below. <button type="button" class="linkbtn" id="cHow">Turn location on</button> \u00b7 <button type="button" class="linkbtn" id="cAgain">Try again</button></span>';
    else s = '<span>We couldn’t get your location. Pick your place below. <button type="button" class="linkbtn" id="cAgain">Try again</button></span>';
    if (q) s = '<span>Results for “' + esc(q) + '”</span>';
    st.innerHTML = s;
    const how = document.getElementById('cHow'); if (how) how.onclick = showLocationHelp;
    const again = document.getElementById('cAgain'); if (again) again.onclick = () => { lastFix = null; coasterFind(); };
    const reload = document.getElementById('cReload'); if (reload) reload.onclick = () => location.reload();

    let list = null, empty = '';
    if (q) {
      if (cst.capped) list = q.length >= 2 ? cst.remote : null;
      else if (cst.all) {
        const n = norm(q);
        list = withDist(cst.all.filter((v) => [v.name, v.city, v.address, v.primary_barcode].some((x) => norm(x).includes(n))));
      }
      empty = 'No BarChata place matches “' + esc(q) + '”. Check the spelling, or ask the staff for their @BarCode.';
    } else if (cst.pos) {
      const here = (cst.near || []).filter((v) => v.dist <= COASTER_HERE_M);
      list = here.length ? here : (cst.near && cst.near.length ? cst.near.slice(0, 6) : (cst.all ? withDist(cst.all).slice(0, 6) : null));
    } else if (cst.loc !== 'locating') {
      list = cst.capped ? [] : cst.all;
      empty = cst.capped ? 'Type the name of the place above.' : '';
    } else {
      list = [];
    }
    if (cst.loadErr && !list) {
      box.innerHTML = '<p class="err">We could not load BarChata places. Check your connection.</p><button class="btn secondary" type="button" onclick="location.reload()">Try again</button>';
      return;
    }
    if (list == null) { box.innerHTML = '<div class="spinner" style="margin:12px auto"></div>'; return; }
    box.innerHTML = list.length ? list.map(pickCard).join('') : (empty ? '<p class="muted">' + empty + '</p>' : '');
  }

  function showLocationHelp() {
    const steps = isIOS()
      ? '<ol class="steps"><li>Open the <b>Settings</b> app › <b>Privacy & Security</b> › <b>Location Services</b>. Make sure it is <b>On</b>.</li><li>In the same list, tap <b>Safari Websites</b> and choose <b>While Using the App</b>.</li><li>Back in Safari, tap the page menu next to the address (<b>≡</b>, <b>aA</b> or <b>⋯</b>) › <b>Website Settings</b> › <b>Location</b> › <b>Allow</b>.</li><li>Come back to this page. It finds your place by itself.</li></ol>'
      : isAndroid()
        ? '<ol class="steps"><li>Tap the icon to the left of the address.</li><li>Tap <b>Permissions</b> (or <b>Site settings</b>) and set <b>Location</b> to <b>Allow</b>.</li><li>Make sure <b>Location</b> is on in your quick settings.</li><li>Come back to this page. It finds your place by itself.</li></ol>'
        : '<ol class="steps"><li>Click the icon to the left of the address.</li><li>Set <b>Location</b> to <b>Allow</b>.</li><li>Come back to this page. It finds your place by itself.</li></ol>';
    const wrap = document.createElement('div');
    wrap.className = 'sheetwrap';
    wrap.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-label="Turn location on"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2>Turn location on</h2><button class="iconbtn" data-close aria-label="Close">✕</button></div>' +
      steps + '<div class="gap"></div><button class="btn" type="button" id="cRetry">' + pinIcon() + 'Try again</button></div>';
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove(); });
    document.body.appendChild(wrap);
    document.getElementById('cRetry').onclick = () => { wrap.remove(); lastFix = null; coasterFind(); };
  }

  // Safari does not tell an open page that location was turned on. Ask again whenever the guest comes back to the
  // page (from the Settings app or the site menu) or the browser reports the permission changed. Set up once.
  let watchingLocation = false;
  function watchLocationTurnedOn() {
    if (watchingLocation) return;
    watchingLocation = true;
    const retry = () => {
      if (!onCoasterPage() || (cst.loc !== 'denied' && cst.loc !== 'unavailable') || cst.touched && cst.q.trim()) return;
      lastFix = null;
      coasterFind();
    };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retry(); });
    window.addEventListener('pageshow', (e) => { if (e.persisted) retry(); });
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' }).then((ps) => { ps.onchange = () => { if (ps.state !== 'denied') retry(); }; }).catch(() => {});
      }
    } catch (e) { /* older browsers: the Try again button still works */ }
  }

  function viewCoaster(params) {
    try { sessionStorage.setItem(COASTER_FLAG, String(Date.now())); } catch (e) { /* private mode */ }
    coasterView(!!params.get('list'));
  }

  const notHere = () => (fromCoaster() ? '<p class="muted not-here"><a href="/s?list=1" data-link>Not this place? Pick the right one</a></p>' : '');

  function legal() {
    return '<p class="legal">By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>. BarChata is for people of legal drinking age.</p>';
  }

  function viewAuth(mode) {
    const ref = new URLSearchParams(location.search).get('ref') || '';
    const isUp = mode === 'signup';
    render(header() +
      '<h1>' + (isUp ? 'Join BarChata' : 'Welcome back') + '</h1>' +
      '<p class="sub">' + (isUp ? 'Check in at venues, earn Hearts and get rewarded. Free.' : 'Sign in with the same account you use in the BarChata app.') + '</p>' +
      '<div class="gap"></div><div class="tabs"><button data-mode="signup" class="' + (isUp ? 'on' : '') + '">Join</button><button data-mode="signin" class="' + (isUp ? '' : 'on') + '">Sign in</button></div>' +
      '<form id="authForm" class="stack" novalidate>' +
      '<div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" inputmode="email" required></div>' +
      '<div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="' + (isUp ? 'new-password' : 'current-password') + '" minlength="6" required></div>' +
      (isUp ? '<div class="field"><label for="handle">Choose your BarCode</label><div class="prefix"><span>@</span><input id="handle" autocapitalize="off" autocomplete="username" placeholder="yourname"></div></div>' +
        '<div class="field"><label for="dob">Date of birth</label><input id="dob" inputmode="numeric" placeholder="YYYY-MM-DD" autocomplete="bday"></div>' +
        '<div class="field"><label for="ref">Referral code (optional)</label><div class="prefix"><span>@</span><input id="ref" value="' + esc(ref.replace(/^@/, '')) + '" autocapitalize="off"></div></div>' +
        '<label class="check"><input type="checkbox" id="tips"><span>Send me BarChata tips and offers by email. You can unsubscribe any time.</span></label>' : '') +
      '<p class="err" id="authErr"></p>' +
      '<button class="btn" type="submit" id="authBtn">' + (isUp ? 'Create account' : 'Sign in') + '</button>' +
      (isUp ? '' : '<button class="btn ghost" type="button" id="forgot">Forgot password?</button>') +
      '</form>' + legal());
    document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => viewAuth(b.dataset.mode)));
    const dob = document.getElementById('dob');
    const handleEl = document.getElementById('handle');
    if (handleEl) handleEl.oninput = () => { handleEl.value = cleanHandle(handleEl.value); };
    if (dob) dob.oninput = () => { dob.value = formatDob(dob.value); };
    const forgot = document.getElementById('forgot');
    if (forgot) forgot.onclick = async () => {
      const email = document.getElementById('email').value.trim().toLowerCase();
      if (!email) { document.getElementById('authErr').textContent = 'Type your email first.'; return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/app?reset=1' });
      toast(error ? error.message : 'Check your email for a reset link.');
    };
    document.getElementById('authForm').onsubmit = async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('authErr'); errEl.textContent = '';
      const email = document.getElementById('email').value.trim().toLowerCase();
      const pw = document.getElementById('pw').value;
      if (!/^\S+@\S+\.\S+$/.test(email)) { errEl.textContent = 'Enter a valid email.'; return; }
      if (pw.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
      const btn = document.getElementById('authBtn'); btn.disabled = true;
      try {
        if (isUp) {
          const handle = cleanHandle(handleEl.value);
          const hErr = await checkHandle(handle);
          if (hErr) { errEl.textContent = hErr; btn.disabled = false; return; }
          const dobErr = checkDob(dob.value); // age gate BEFORE creating the account, same rule as the app
          if (dobErr) { errEl.textContent = dobErr; btn.disabled = false; return; }
          const { data, error } = await sb.auth.signUp({ email, password: pw });
          if (error) throw error;
          if (!data.session) { render(header() + '<div class="center"><h1>Check your email</h1><p class="sub">Tap the link we sent to ' + esc(email) + ' to finish joining.</p></div>'); return; }
          const uid = data.user.id;
          // The profile row is created by the database when the account is made; set the handle on it.
          const { error: pErr } = await saveHandle(uid, handle);
          if (pErr) toast('Account created. Set your BarCode on the next screen.');
          const tips = !!(document.getElementById('tips') || {}).checked;
          await sb.from('profile_private').upsert({ profile_id: uid, date_of_birth: dob.value, email_tips_opt_in: tips, email_tips_opt_in_at: tips ? new Date().toISOString() : null }, { onConflict: 'profile_id' });
          const refCode = (document.getElementById('ref').value || '').trim().replace(/^@/, '').toLowerCase();
          if (refCode) { try { localStorage.setItem('pending_referral_code', refCode); } catch (x) {} }
          const refMsg = await claimPendingReferral();
          toast(refMsg || 'Welcome to BarChata!');
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password: pw });
          if (error) throw error;
        }
        const back = takeReturn();
        if (back) { location.href = back; return; }
        const pending = takeScan();
        go(pending ? '/scan/' + encodeURIComponent(pending) : '/app');
      } catch (err) {
        errEl.textContent = (err && err.message) || 'Something went wrong.';
        btn.disabled = false;
      }
    };
  }

  function viewReset() {
    render(header() + '<h1>Set a new password</h1><div class="gap"></div><form id="rf" class="stack"><div class="field"><label for="np">New password</label><input id="np" type="password" autocomplete="new-password" minlength="6"></div><p class="err" id="re"></p><button class="btn">Save password</button></form>');
    document.getElementById('rf').onsubmit = async (e) => {
      e.preventDefault();
      const pw = document.getElementById('np').value;
      if (pw.length < 6) { document.getElementById('re').textContent = 'At least 6 characters.'; return; }
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) { document.getElementById('re').textContent = error.message; return; }
      toast('Password updated.'); go('/app');
    };
  }

  function qrSvg(text) {
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
  }

  // Referral Hearts are checked and paid on the server (claim_member_referral).
  // The code is kept until the server gives a final answer, so someone who
  // had to confirm their email first still gets it on their first visit.
  async function claimPendingReferral() {
    let code = '';
    try { code = localStorage.getItem('pending_referral_code') || ''; } catch (x) {}
    if (!code) return '';
    const { data, error } = await sb.rpc('claim_member_referral', { p_code: code });
    if (error) return ''; // server not ready or offline: try again next visit
    try { localStorage.removeItem('pending_referral_code'); } catch (x) {}
    if (data && data.success) return 'Welcome! You and @' + code + ' each got ' + (data.hearts || 100) + ' Hearts.';
    return '';
  }

  async function viewHome(session) {
    claimPendingReferral().then((m) => { if (m) toast(m); });
    claimJoins();
    loading();
    const uid = session.user.id;
    const [{ data: p }, { data: cks }] = await Promise.all([
      sb.from('profiles').select('username, full_name, bar_points, barcode, avatar_url').eq('id', uid).maybeSingle(),
      sb.from('checkins').select('venue_id, created_at, points_earned').eq('user_id', uid).order('created_at', { ascending: false }).limit(8),
    ]);
    const ids = Array.from(new Set((cks || []).map((c) => c.venue_id).filter(Boolean)));
    let names = {};
    if (ids.length) { // venues fetched separately - FK joins fail silently
      const { data: vs } = await sb.from('venues').select('id, name, city').in('id', ids);
      (vs || []).forEach((v) => { names[v.id] = v; });
    }
    const handle = p && p.username ? '@' + p.username : '';
    const hearts = (p && p.bar_points) || 0;
    const code = (p && (p.barcode || (p.username ? '@' + p.username : ''))) || '';
    const history = (cks || []).map((c) => {
      const v = names[c.venue_id] || {};
      return '<div class="row"><div><div class="t">' + esc(v.name || 'Venue') + '</div><div class="muted">' + esc(v.city || '') + ' · ' + new Date(c.created_at).toLocaleDateString() + '</div></div>' +
        (c.points_earned ? '<span class="pill">+' + c.points_earned + '</span>' : '') + '</div>';
    }).join('') || '<p class="muted">No check-ins yet. Scan a venue QR code to check in.</p>';

    render(header('<button class="iconbtn" id="out" title="Sign out" aria-label="Sign out">⎋</button>') +
      '<h1>Hi ' + esc(handle || 'there') + '</h1><p class="sub">Scan a venue\'s BarChata QR code to check in and earn Hearts.</p><div class="gap"></div>' +
      installBanner() +
      '<div class="card"><div class="muted">YOUR HEARTS</div><div class="hearts"><span class="n">' + hearts.toLocaleString() + '</span><span class="muted">Hearts</span></div></div><div class="gap"></div>' +
      (code
        ? '<div class="card"><h2>My BarCode</h2><p class="muted" style="margin:4px 0 12px">' + esc(code) + ' · friends scan this to find you on BarChata</p><div class="qr">' + qrSvg('https://barchata.com/u/' + encodeURIComponent(code.replace(/^@/, ''))) + '</div></div><div class="gap"></div>'
        : '<div class="card"><h2>Choose your BarCode</h2><p class="muted" style="margin:4px 0 12px">Your BarCode is your @name. Friends use it to find you, and it shows on every check-in.</p>' +
          '<form id="hf" class="stack"><div class="prefix"><span>@</span><input id="h2" class="hinput" autocapitalize="off" placeholder="yourname" style="height:52px;border-radius:12px;background:var(--card);border:1px solid var(--line);font-size:16px;outline:none"></div>' +
          '<p class="err" id="h2e"></p><button class="btn">Save my BarCode</button></form></div><div class="gap"></div>') +
      '<div class="card"><h2 style="margin-bottom:6px">Recent check-ins</h2>' + history + '</div><div class="gap"></div>' +
      '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2>Near me</h2><button class="btn secondary" style="width:auto;height:36px;padding:0 14px;font-size:14px" id="near">Show</button></div><div id="nearList" style="margin-top:8px"></div></div>' +
      appBanner());
    document.getElementById('out').onclick = async () => { await sb.auth.signOut({ scope: 'local' }); go('/app'); };
    document.getElementById('near').onclick = nearMe;
    const hf = document.getElementById('hf');
    if (hf) {
      const h2 = document.getElementById('h2');
      h2.oninput = () => { h2.value = cleanHandle(h2.value); };
      hf.onsubmit = async (e) => {
        e.preventDefault();
        const h = cleanHandle(h2.value);
        const err = await checkHandle(h);
        if (err) { document.getElementById('h2e').textContent = err; return; }
        const { error } = await saveHandle(uid, h);
        if (error) { document.getElementById('h2e').textContent = error.message; return; }
        toast('Saved. Your BarCode is @' + h);
        viewHome(session);
      };
    }
    wireInstall();
  }

  function nearMe() {
    const box = document.getElementById('nearList');
    if (!navigator.geolocation) { box.innerHTML = '<p class="muted">Location is not available on this device.</p>'; return; }
    box.innerHTML = '<div class="spinner" style="margin:10px auto"></div>';
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { data, error } = await sb.rpc('search_venues_nearby', { p_query: '', p_lat: pos.coords.latitude, p_lng: pos.coords.longitude, p_limit: 12 });
      if (error) { box.innerHTML = '<p class="err">' + esc(error.message) + '</p>'; return; }
      box.innerHTML = (data || []).map((v) => '<div class="row"><div><div class="t">' + esc(v.name) + '</div><div class="muted">' + esc(v.category || '') + (v.city ? ' · ' + esc(v.city) : '') + '</div></div><span class="muted">' +
        (v.distance_m != null ? (v.distance_m < 1000 ? Math.round(v.distance_m) + ' m' : (v.distance_m / 1000).toFixed(1) + ' km') : '') + '</span></div>').join('') || '<p class="muted">No venues found nearby.</p>';
      // Owners browsing their own neighbourhood: point them at the claim flow on Biz.
      box.innerHTML += '<p class="muted" style="margin-top:14px">Own one of these places? <a href="https://biz.barchata.com/directory" target="_blank" rel="noopener">Claim it free on BarChata Biz</a></p>';
    }, () => { box.innerHTML = '<p class="muted">Allow location to see places near you.</p>'; }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  // ------------------------------------------------------------------ install / app store
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  // The banner is always tappable. Chrome/Edge/Android get the real install
  // prompt when the browser offers one; everyone else gets clear steps.
  const isAndroid = () => /android/i.test(navigator.userAgent);
  const isMobile = () => isIOS() || isAndroid();
  function installBanner() {
    if (standalone()) return '';
    const text = isMobile() ? 'Add BarChata to your home screen for one-tap check-ins.' : 'Open BarChata on your phone and add it to your home screen.';
    return '<button type="button" class="banner" id="installBanner" style="width:100%;text-align:left;cursor:pointer;color:inherit;font:inherit">' +
      '<img src="/assets/barchata-icon.png" width="40" height="40" style="border-radius:10px" alt="">' +
      '<div style="flex:1"><div class="t">Install BarChata</div><div class="d">' + text + '</div></div>' +
      '<span class="btn" style="width:auto;height:36px;padding:0 14px;font-size:14px;display:inline-flex;align-items:center">' + (isMobile() ? 'Install' : 'Show me') + '</span></button><div class="gap"></div>';
  }
  function installSteps() {
    if (isIOS()) {
      const safari = /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);
      return (safari ? '' : '<p class="muted" style="margin-bottom:10px">First open this page in <b>Safari</b>.</p>') +
        '<ol class="steps"><li>Tap the <b>Share</b> button (square with an arrow) at the bottom of Safari.</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. BarChata now opens like an app.</li></ol>';
    }
    if (isAndroid()) {
      return '<ol class="steps"><li>Tap the <b>⋮</b> menu at the top right of Chrome.</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li><li>Tap <b>Install</b>. BarChata now opens like an app.</li></ol>';
    }
    return '<p class="muted" style="margin-bottom:12px">Scan this with your phone camera to open BarChata there, then add it to your home screen.</p>' +
      '<div class="qr" style="max-width:220px;margin:0 auto">' + qrSvg(location.origin + '/app') + '</div>';
  }
  function showInstallSheet() {
    const wrap = document.createElement('div');
    wrap.className = 'sheetwrap';
    wrap.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-label="Install BarChata"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2>Install BarChata</h2><button class="iconbtn" data-close aria-label="Close">✕</button></div>' + installSteps() + '</div>';
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove(); });
    document.body.appendChild(wrap);
  }
  function wireInstall() {
    const b = document.getElementById('installBanner'); if (!b) return;
    b.onclick = async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const r = await deferredPrompt.userChoice; deferredPrompt = null;
        if (r && r.outcome === 'accepted') { if (b.nextElementSibling) b.nextElementSibling.remove(); b.remove(); }
        return;
      }
      showInstallSheet();
    };
  }
  function appBanner() {
    if (!APP_STORE_LIVE && !PLAY_STORE_LIVE) return '<p class="legal">The BarChata app for iPhone and Android is coming soon. Your account, Hearts and check-ins carry over.</p>';
    return '<p class="legal">Get the full app: ' + (APP_STORE_LIVE ? '<a href="https://apps.apple.com/app/id6769344926">App Store</a>' : '') + (PLAY_STORE_LIVE ? ' · <a href="https://play.google.com/store/apps/details?id=com.barchata.social">Google Play</a>' : '') + '</p>';
  }

  // ------------------------------------------------------------------ router
  // Email unsubscribe (link in the footer of BarChata tips emails). Works signed in or out.
  async function viewUnsub(token) {
    loading();
    let ok = false;
    try {
      const r = await fetch(cfg.url + '/functions/v1/member-emails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unsubscribe', t: token }) });
      ok = !!(await r.json()).ok;
    } catch (x) {}
    render(header() + '<div class="center"><h1>' + (ok ? 'You\'re unsubscribed' : 'Link expired') + '</h1><p class="sub">' +
      (ok ? 'You won\'t get BarChata tips and offers by email any more. Account emails (like password resets) still arrive.' : 'This unsubscribe link is not valid any more. If you keep getting emails, reply to one and we\'ll sort it out.') +
      '</p><div class="stack" style="width:100%"><a class="btn secondary" href="/app" data-link>Go to BarChata</a></div></div>');
  }

  // One-click unsubscribe for BarChata news, venue campaign and BarStock follow-up emails
  // (link in those email footers: /app?stop=<token>). Works signed in or out.
  async function viewStop(token) {
    const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const call = async (action) => {
      try {
        const r = await fetch(cfg.url + '/functions/v1/email-unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action, t: token }) });
        return await r.json();
      } catch (x) { return { ok: false }; }
    };
    const show = (res) => {
      if (!res || !res.ok) {
        render(header() + '<div class="center"><h1>Link expired</h1><p class="sub">This unsubscribe link is not valid any more. If you keep getting emails, reply to one and we\'ll sort it out.</p><div class="stack" style="width:100%"><a class="btn secondary" href="/app" data-link>Go to BarChata</a></div></div>');
        return;
      }
      const what = esc(res.label || 'These emails');
      if (res.unsubscribed) {
        render(header() + '<div class="center"><h1>You\'re unsubscribed</h1><p class="sub">You won\'t get any more of these: <b>' + what + '</b>. Account emails (like password resets and receipts) still arrive.</p>' +
          '<div class="stack" style="width:100%"><button class="btn secondary" id="resub">Oops, keep sending them</button><a class="btn secondary" href="/app" data-link>Go to BarChata</a></div></div>');
        const b = document.getElementById('resub');
        if (b) b.onclick = async () => { b.disabled = true; b.textContent = 'One moment…'; show(await call('resubscribe')); };
      } else {
        render(header() + '<div class="center"><h1>Stop these emails?</h1><p class="sub"><b>' + what + '</b></p>' +
          '<div class="stack" style="width:100%"><button class="btn" id="unsub">Unsubscribe</button><a class="btn secondary" href="/app" data-link>Keep getting them</a></div></div>');
        const b = document.getElementById('unsub');
        if (b) b.onclick = async () => { b.disabled = true; b.textContent = 'One moment…'; show(await call('unsubscribe')); };
      }
    };
    loading();
    show(await call('info'));
  }

  async function route() {
    const params = new URLSearchParams(location.search);
    if (params.get('unsub')) return viewUnsub(params.get('unsub'));
    if (params.get('stop')) return viewStop(params.get('stop'));
    if (/^\/s\/?$/i.test(location.pathname)) return viewCoaster(params); // printed coaster QR
    const code = scanCodeFromPath();
    if (code) return viewScan(code);
    const { data: { session } } = await sb.auth.getSession();
    if (params.get('reset') && session) return viewReset();
    if (session) { const back = takeReturn(); if (back) { location.href = back; return; } }
    if (location.pathname.startsWith('/join')) return session ? viewHome(session) : viewAuth('signup');
    if (!session) return viewAuth(params.get('mode') === 'signin' ? 'signin' : 'signup');
    const pending = takeScan();
    if (pending) return viewScan(pending);
    return viewHome(session);
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-link]');
    if (a) { e.preventDefault(); go(a.getAttribute('href')); return; }
    const g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); go(g.dataset.go); }
  });
  window.addEventListener('popstate', route);
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') viewReset();
    // Web Insights: link this browser's earlier anonymous visits to the account.
    try {
      const m = session && session.user && document.cookie.match(/(?:^|; )bc_vid=([0-9a-f-]{36})/i);
      if (!m) return;
      const key = 'bc_vid_linked:' + session.user.id + ':' + m[1];
      if (localStorage.getItem(key)) return;
      sb.rpc('analytics_link_visitor', { p_visitor: m[1] }).then(({ error }) => { if (!error) { try { localStorage.setItem(key, '1'); } catch (e) {} } });
    } catch (e) { /* analytics must never break the app */ }
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
  route();
})();
