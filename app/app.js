/* BarChata web app - for guests who scan a venue QR code or get a /join link.
 * Same accounts, Hearts and check-ins as the BarChata Social app (one Supabase project).
 * Plain JavaScript on purpose: the landing site is static, so there is no build step.
 */
(function () {
  const cfg = window.BC_CONFIG || {};
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'bc-web-auth' },
  });
  const $app = document.getElementById('app');
  const MIN_AGE = 18;
  const PENDING = 'bc_pending_scan';
  const APP_STORE_LIVE = false; // flip when the App Store listing is approved
  const PLAY_STORE_LIVE = false; // flip when the Google Play listing is live

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

  async function findVenue(code) {
    for (const form of codeForms(code)) {
      const { data, error } = await sb.from('venues').select('id, name, address, city, cover_image, logo_url, is_active, primary_barcode').eq('primary_barcode', form).limit(1).maybeSingle();
      if (error) throw error;
      if (data) return data;
    }
    // Printed before the owner renamed their handle.
    const { data: r } = await sb.rpc('resolve_handle', { p_handle: code }).then((x) => x, () => ({ data: null }));
    if (r && r.venue_id) {
      const { data } = await sb.from('venues').select('id, name, address, city, cover_image, logo_url, is_active, primary_barcode').eq('id', r.venue_id).maybeSingle();
      return data;
    }
    return null;
  }

  async function checkIn(code) {
    for (const form of codeForms(code)) {
      const { data, error } = await sb.rpc('verify_checkin_qr', { p_qr: form });
      if (error) throw error;
      if ((data && data.ok) || (data && data.error !== 'qr_not_recognised')) return data;
    }
    return { ok: false, error: 'qr_not_recognised' };
  }

  function venueCard(v) {
    const img = v.cover_image || v.logo_url;
    return '<div class="card venue"><div class="img"' + (img ? ' style="background-image:url(' + esc(img) + ')"' : '') + '>' + (img ? '' : initial(v.name)) + '</div>' +
      '<div><div class="name">' + esc(v.name) + '</div><div class="muted">' + esc([v.address, v.city].filter(Boolean).join(', ')) + '</div></div></div>';
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
        venueCard(v) + closed + '<div class="gap"></div><div class="stack">' +
        '<button class="btn" data-go="/join">Join free</button><button class="btn secondary" data-go="/app?mode=signin">I have an account</button></div>' + legal());
      return;
    }
    render(header() + '<h1>You are at</h1><div class="gap"></div>' + venueCard(v) + closed + '<div class="gap"></div>' +
      '<button class="btn" id="doCheckin"' + (v.is_active === false ? ' disabled' : '') + '>Check in</button><p class="muted" style="text-align:center;margin-top:10px">One tap. Hearts go straight to your account.</p>');
    document.getElementById('doCheckin').onclick = async (e) => {
      e.target.disabled = true; e.target.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px"></div>';
      try {
        const res = await checkIn(code);
        if (res && res.ok) {
          const pts = Number((res.award && res.award.points_awarded) || res.points_awarded || res.points || 0);
          render(header() + '<div class="center"><div class="success">✓</div><h1>You are checked in</h1><p class="sub">' + esc(v.name) +
            (pts > 0 ? '<br><b style="color:var(--brand)">+' + pts + ' Hearts</b>' : '<br>Check-in saved. Hearts are limited per visit, so this one did not add more.') +
            '</p><div class="stack" style="width:100%"><a class="btn" href="/app" data-link>See my Hearts</a></div></div>');
        } else {
          const msg = { not_authenticated: 'Please sign in again.', qr_not_recognised: 'This code is not recognised.' }[res && res.error] || (res && (res.message || res.error)) || 'Could not check in.';
          toast(msg); e.target.disabled = false; e.target.textContent = 'Check in';
        }
      } catch (err) { toast(err.message || 'Could not check in.'); e.target.disabled = false; e.target.textContent = 'Check in'; }
    };
  }

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
        '<div class="field"><label for="ref">Referral code (optional)</label><div class="prefix"><span>@</span><input id="ref" value="' + esc(ref.replace(/^@/, '')) + '" autocapitalize="off"></div></div>' : '') +
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
          await sb.from('profile_private').upsert({ profile_id: uid, date_of_birth: dob.value }, { onConflict: 'profile_id' });
          const refCode = (document.getElementById('ref').value || '').trim().replace(/^@/, '').toLowerCase();
          if (refCode) { try { localStorage.setItem('pending_referral_code', refCode); } catch (x) {} }
          toast('Welcome to BarChata!');
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password: pw });
          if (error) throw error;
        }
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

  async function viewHome(session) {
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
      '<h1>Hi ' + esc(handle || 'there') + '</h1><p class="sub">Show your code at the bar, or scan the venue QR code to check in.</p><div class="gap"></div>' +
      installBanner() +
      '<div class="card"><div class="muted">YOUR HEARTS</div><div class="hearts"><span class="n">' + hearts.toLocaleString() + '</span><span class="muted">Hearts</span></div></div><div class="gap"></div>' +
      (code
        ? '<div class="card"><h2>My BarCode</h2><p class="muted" style="margin:4px 0 12px">' + esc(code) + '</p><div class="qr">' + qrSvg(code) + '</div></div><div class="gap"></div>'
        : '<div class="card"><h2>Choose your BarCode</h2><p class="muted" style="margin:4px 0 12px">Your BarCode is your @name. Venues scan it to add Hearts.</p>' +
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
    }, () => { box.innerHTML = '<p class="muted">Allow location to see places near you.</p>'; }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  // ------------------------------------------------------------------ install / app store
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; const b = document.getElementById('installBtn'); if (b) b.style.display = ''; });
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  function installBanner() {
    if (standalone()) return '';
    const text = isIOS() ? 'Tap Share, then "Add to Home Screen".' : 'Add BarChata to your home screen for one-tap check-ins.';
    return '<div class="banner"><img src="/assets/barchata-icon.png" width="40" height="40" style="border-radius:10px" alt=""><div style="flex:1"><div class="t">Install BarChata</div><div class="d">' + text + '</div></div>' +
      (isIOS() ? '' : '<button class="btn" id="installBtn" style="width:auto;height:36px;padding:0 14px;font-size:14px;display:none">Install</button>') + '</div><div class="gap"></div>';
  }
  function wireInstall() {
    const b = document.getElementById('installBtn'); if (!b) return;
    if (deferredPrompt) b.style.display = '';
    b.onclick = async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; b.style.display = 'none'; };
  }
  function appBanner() {
    if (!APP_STORE_LIVE && !PLAY_STORE_LIVE) return '<p class="legal">The BarChata app for iPhone and Android is coming soon. Your account, Hearts and check-ins carry over.</p>';
    return '<p class="legal">Get the full app: ' + (APP_STORE_LIVE ? '<a href="https://apps.apple.com/app/id6769344926">App Store</a>' : '') + (PLAY_STORE_LIVE ? ' · <a href="https://play.google.com/store/apps/details?id=com.barchata.social">Google Play</a>' : '') + '</p>';
  }

  // ------------------------------------------------------------------ router
  async function route() {
    const params = new URLSearchParams(location.search);
    const code = scanCodeFromPath();
    if (code) return viewScan(code);
    const { data: { session } } = await sb.auth.getSession();
    if (params.get('reset') && session) return viewReset();
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
  sb.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') viewReset(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
  route();
})();
