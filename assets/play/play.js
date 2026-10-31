/* BarChata Arena - play on your phone (barchata.com/play and barchata.com/play/<CODE>).
 * The QR code on the TV opens this page. Members play with their BarChata account; anyone else can
 * play as a guest with a nickname. Everything goes through the arena-play edge function.
 * Plain JavaScript on purpose: the landing site is static, so there is no build step. (Oct 24, 2026)
 *
 * Giveaways and free draws (Oct 25, 2026): the same TV code can open an instant giveaway ("first 10 to scan
 * win free wings": claim one, get a prize code) or a free draw (enter free; if you're drawn, answer the
 * skill-testing question within a few minutes to get your prize code). The rules are on the page.
 *
 * Call It (Oct 25, 2026): live predictions during a game on TV. Staff make calls ("Who scores next?",
 * "Closest guess: total goals tonight?"); each one shows here with its answers or a number box until it locks.
 * One answer per table or team: the first teammate to answer locks it in (trivia works the same way now).
 * When staff settle a call, this page shows whether your team called it and the points.
 *
 * Join our rewards (Oct 25, 2026): if the business has a welcome offer ("15% off your next visit"), players and
 * entrants see a "Join <business> rewards" card. Members join in one tap; guests give their name and email or mobile.
 * They get a code to show the business; bonus Hearts are added when they make a free BarChata account.
 */
(function () {
  var cfg = window.BC_CONFIG || {};
  var sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'bc-web-auth' },
  });
  var FN = cfg.url + '/functions/v1/arena-play';
  var GUEST_KEY = 'bc_arena_guest';
  var GAME_KEY = 'bc_arena_game';
  var RETURN_KEY = 'bc_return_to';
  var COLORS = ['#F27D26', '#5B9BF8', '#22C55E', '#E85D9A'];
  var LETTERS = ['A', 'B', 'C', 'D'];
  var $app = document.getElementById('app');

  var game = null;      // { session: {...}, pass, code }
  var player = null;    // { kind: 'member' | 'guest', name }
  var st = null;        // last game state
  var skew = 0;         // server clock minus phone clock (ms)
  var pollTimer = null;
  var tickTimer = null;
  var teamCode = null;  // shown to whoever created the team
  var sending = false;
  var lastKey = '';

  // ------------------------------------------------------------------ sound (made in the browser, no files)
  var SOUND_KEY = 'bc_arena_sound';
  var soundOn = (function () { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch (e) { return true; } })();
  var actx = null;
  var played = {};
  function unlockAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { /* no sound on this phone */ }
  }
  function tone(freq, start, dur, type, vol) {
    if (!soundOn || !actx || actx.state !== 'running') return;
    var t0 = actx.currentTime + start, o = actx.createOscillator(), g = actx.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + dur + 0.03);
  }
  var sfx = {
    count: function () { tone(660, 0, 0.2, 'sine', 0.25); },
    go: function () { tone(880, 0, 0.09, 'square', 0.08); tone(1320, 0.08, 0.35, 'sine', 0.25); },
    tick: function () { tone(1250, 0, 0.05, 'square', 0.05); },
    tap: function () { tone(520, 0, 0.06, 'triangle', 0.15); },
    right: function () { tone(784, 0, 0.12, 'triangle', 0.25); tone(988, 0.1, 0.12, 'triangle', 0.25); tone(1319, 0.2, 0.35, 'triangle', 0.25); },
    wrong: function () { tone(220, 0, 0.32, 'sawtooth', 0.12); tone(196, 0.05, 0.32, 'sawtooth', 0.1); },
    win: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.14, i === 3 ? 0.7 : 0.16, 'triangle', 0.25); }); },
    done: function () { tone(659, 0, 0.15, 'triangle', 0.2); tone(523, 0.14, 0.35, 'triangle', 0.2); },
  };
  function once(key, fn) { if (played[key]) return; played[key] = 1; fn(); }
  function buzz(ms) { try { if (soundOn && navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* not supported */ } }
  function speakerIcon() {
    return soundOn
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';
  }

  // ------------------------------------------------------------------ helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg) { var t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 3200); }
  function getJSON(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function setJSON(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function serverNow() { return Date.now() + skew; }
  function stopTimers() { clearTimeout(pollTimer); clearInterval(tickTimer); pollTimer = null; tickTimer = null; }
  function clockText(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0') : m + ':' + String(r).padStart(2, '0');
  }

  function header() {
    var v = game && game.session;
    return '<div class="top"><a class="logo" href="/app"><img src="/assets/barchata-icon.png" alt=""><span>Bar<b>Chata</b></span><em class="arena-tag">ARENA</em></a>' +
      '<div class="arena-right">' + (v && v.venue_name ? '<span class="muted arena-venue">' + esc(v.venue_name) + '</span>' : '') +
      '<button class="snd' + (soundOn ? ' on' : '') + '" id="snd" type="button" aria-label="' + (soundOn ? 'Turn sound off' : 'Turn sound on') + '">' + speakerIcon() + '</button></div></div>';
  }
  function render(html) {
    var had = document.activeElement && document.activeElement.id;
    $app.innerHTML = header() + html; fixPics(); fillJoin(had);
  }

  // ------------------------------------------------------------------ pictures
  // Members show their BarChata profile photo; guests the avatar they picked; anyone else their first letter.
  var AVATARS = window.BC_AVATARS || [];
  function avatarByKey(k) { for (var i = 0; i < AVATARS.length; i++) if (AVATARS[i].key === k) return AVATARS[i]; return null; }
  function letterHtml(n, px) {
    return '<span class="pic letter" style="width:' + px + 'px;height:' + px + 'px;font-size:' + Math.round(px * 0.46) + 'px">' + esc(String(n || '?').charAt(0).toUpperCase() || '?') + '</span>';
  }
  function avatarHtml(a, px) {
    return '<span class="pic" style="width:' + px + 'px;height:' + px + 'px;background:' + a.color + '"><svg viewBox="0 0 24 24" width="56%" height="56%" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' + a.svg + '</svg></span>';
  }
  function picHtml(pic, px) {
    if (pic && pic.u && /^https:\/\/[^\s"'<>]+$/.test(pic.u)) {
      return '<img class="pic" style="width:' + px + 'px;height:' + px + 'px" src="' + esc(pic.u) + '" alt="" referrerpolicy="no-referrer" data-n="' + esc(pic.n || '') + '" data-px="' + px + '">';
    }
    var a = pic && pic.a ? avatarByKey(pic.a) : null;
    return a ? avatarHtml(a, px) : letterHtml(pic && pic.n, px);
  }
  // A profile photo that fails to load falls back to the first letter.
  function fixPics() {
    $app.querySelectorAll('img.pic').forEach(function (img) {
      img.onerror = function () { img.outerHTML = letterHtml(img.getAttribute('data-n'), Number(img.getAttribute('data-px')) || 32); };
    });
  }
  function loading(text) { render('<div class="center"><div class="spinner"></div>' + (text ? '<p class="muted">' + esc(text) + '</p>' : '') + '</div>'); }

  async function call(action, body) {
    var s = (await sb.auth.getSession()).data.session;
    var guest = getJSON(GUEST_KEY);
    var payload = Object.assign({ action: action }, body || {});
    if (guest && guest.token) payload.guest_token = guest.token;
    var res = await fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: 'Bearer ' + (s ? s.access_token : cfg.anonKey) },
      body: JSON.stringify(payload),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* empty */ }
    return { status: res.status, data: data || {} };
  }

  function codeFromUrl() {
    var m = location.pathname.match(/^\/play\/([A-Za-z0-9]{6})\/?$/);
    if (m) return m[1].toUpperCase();
    var q = new URLSearchParams(location.search).get('c');
    return q && /^[A-Za-z0-9]{6}$/.test(q) ? q.toUpperCase() : null;
  }

  // ------------------------------------------------------------------ enter the code
  function viewCode(message) {
    stopTimers();
    render('<h1>Join the game</h1><p class="sub">Enter the 6-character code shown on the TV.</p><div class="gap"></div>' +
      '<form id="cf" class="stack" novalidate><div class="field"><label for="code">Game code</label>' +
      '<input id="code" class="code-input" maxlength="6" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABC123"></div>' +
      '<p class="err" id="ce">' + esc(message || '') + '</p><button class="btn" id="cb">Find the game</button></form>' + legal());
    var input = document.getElementById('code');
    input.oninput = function () { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); };
    input.focus();
    document.getElementById('cf').onsubmit = function (e) {
      e.preventDefault();
      if (input.value.length !== 6) { document.getElementById('ce').textContent = 'The code has 6 letters and numbers.'; return; }
      start(input.value);
    };
  }

  function legal() {
    return '<p class="legal">By playing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>. BarChata is for people of legal drinking age.</p>';
  }

  async function start(code) {
    stopTimers();
    loading('Finding the game...');
    var r;
    try { r = await call('find', { code: code }); } catch (e) { viewCode('No internet connection. Try again.'); return; }
    if (r.status !== 200 || !(r.data.session || r.data.contest)) { viewCode(r.data.error || 'That code doesn’t match a game right now.'); return; }
    if (r.data.contest) {
      var k = r.data.contest;
      game = { contest: true, session: { id: k.id, kind: k.kind, title: k.prize, status: k.status, venue_name: k.venue_name, venue_logo: k.venue_logo }, pass: r.data.pass, code: code.toUpperCase() };
    } else {
      game = { session: r.data.session, pass: r.data.pass, code: code.toUpperCase() };
    }
    setJSON(GAME_KEY, { session_id: game.session.id, pass: game.pass, code: game.code, session: game.session, contest: !!game.contest, at: Date.now() });
    if (location.pathname !== '/play/' + game.code) history.replaceState({}, '', '/play/' + game.code);
    await afterFind();
  }

  async function afterFind() {
    var me = await call('me', {});
    player = me.data.player || null;
    if (!player) { viewWho(); return; }
    if (game.contest) {
      if (player.kind === 'guest' && !(player.pic && player.pic.a) && AVATARS.length) { viewGuest(); return; }
      contestPoll();
      return;
    }
    var s = await call('state', { session_id: game.session.id });
    if (s.status === 200 && s.data.me) { applyState(s.data); return; }
    if (s.status === 200 && s.data.session && !/^(lobby|live)$/.test(s.data.session.status)) { viewClosed(); return; }
    // A guest from before avatars existed: pick one before joining (keeps the same guest and any prizes).
    if (player.kind === 'guest' && !(player.pic && player.pic.a) && AVATARS.length) { viewGuest(); return; }
    viewTeam();
  }

  // ------------------------------------------------------------------ who is playing
  function gameCard() {
    var v = game.session;
    var live = v.status === 'live' || (game.contest && v.status === 'open');
    if (game.contest) {
      return '<div class="card arena-game"><div class="venue"><div class="img"' + (v.venue_logo ? ' style="background-image:url(\'' + esc(v.venue_logo) + '\')"' : '') + '>' + (v.venue_logo ? '' : esc((v.venue_name || 'B').charAt(0))) + '</div>' +
        '<div><div class="name">' + esc(v.title) + '</div><div class="muted">' + esc(v.venue_name || '') + ' · ' + (v.kind === 'giveaway' ? 'Instant giveaway' : 'Free draw') + (live ? ' · <b class="live-dot">Open now</b>' : '') + '</div></div></div></div>';
    }
    return '<div class="card arena-game"><div class="venue"><div class="img"' + (v.venue_logo ? ' style="background-image:url(\'' + esc(v.venue_logo) + '\')"' : '') + '>' + (v.venue_logo ? '' : esc((v.venue_name || 'B').charAt(0))) + '</div>' +
      '<div><div class="name">' + esc(v.title) + '</div><div class="muted">' + esc(v.venue_name || '') + ' · ' + (v.kind === 'callit' ? 'Call It · ' : '') + (live ? '<b class="live-dot">Live now</b>' : 'Starting soon') + '</div></div></div></div>';
  }

  function viewWho() {
    stopTimers();
    render(gameCard() + '<div class="gap"></div><h1>How do you want to play?</h1><div class="gap"></div>' +
      '<div class="stack">' +
      '<button class="btn" id="guestBtn">Play as a guest</button>' +
      '<button class="btn secondary" id="signinBtn">Sign in with BarChata</button>' +
      '<p class="muted center-text">Members keep their scores and can win Hearts. No account? Play as a guest now and join later.</p>' +
      '</div>' + legal());
    document.getElementById('guestBtn').onclick = viewGuest;
    document.getElementById('signinBtn').onclick = function () {
      setJSON(RETURN_KEY, { path: '/play/' + game.code, at: Date.now() });
      location.href = '/app?mode=signin';
    };
  }

  function viewGuest() {
    var guest = getJSON(GUEST_KEY);
    var picked = guest && guest.avatar && avatarByKey(guest.avatar) ? guest.avatar
      : (AVATARS.length ? AVATARS[Math.floor(Math.random() * AVATARS.length)].key : null);
    var grid = AVATARS.map(function (a) {
      return '<button type="button" class="av-opt' + (a.key === picked ? ' on' : '') + '" data-k="' + esc(a.key) + '" aria-label="Avatar ' + esc(a.key.replace('-', ' ')) + '" aria-pressed="' + (a.key === picked) + '">' + avatarHtml(a, 40) + '</button>';
    }).join('');
    render(gameCard() + '<div class="gap"></div><h1>Pick a nickname</h1><p class="sub">Your nickname and avatar show on the TV.</p><div class="gap"></div>' +
      '<form id="gf" class="stack" novalidate><div class="field"><label for="nick">Nickname</label>' +
      '<input id="nick" maxlength="24" autocomplete="nickname" value="' + esc(guest && guest.nickname || '') + '" placeholder="e.g. Trivia Queen"></div>' +
      (AVATARS.length ? '<div class="field"><label>Your avatar</label><div class="av-grid" role="group" aria-label="Pick your avatar">' + grid + '</div></div>' : '') +
      '<label class="check"><input type="checkbox" id="adult"><span>I am of legal drinking age where I live.</span></label>' +
      '<p class="err" id="ge"></p><button class="btn" id="gb">Continue</button>' +
      '<button class="btn ghost" type="button" id="back">Back</button></form>' + legal());
    document.getElementById('back').onclick = viewWho;
    document.querySelectorAll('.av-opt').forEach(function (b) {
      b.onclick = function () {
        picked = b.getAttribute('data-k');
        document.querySelectorAll('.av-opt').forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
        sfx.tap();
      };
    });
    document.getElementById('gf').onsubmit = async function (e) {
      e.preventDefault();
      var err = document.getElementById('ge'); err.textContent = '';
      var nick = document.getElementById('nick').value.trim();
      if (nick.length < 2) { err.textContent = 'Nicknames are 2 to 24 characters.'; return; }
      if (!document.getElementById('adult').checked) { err.textContent = 'Please confirm you are of legal drinking age.'; return; }
      var btn = document.getElementById('gb'); btn.disabled = true;
      try {
        var r = await call('guest', { nickname: nick, avatar: picked, adult: true });
        if (r.status !== 200) { err.textContent = r.data.error || 'Could not continue. Try again.'; btn.disabled = false; return; }
        setJSON(GUEST_KEY, { token: r.data.guest_token, nickname: r.data.nickname, avatar: r.data.avatar || null });
        player = { kind: 'guest', name: r.data.nickname, pic: { a: r.data.avatar || null, n: r.data.nickname } };
        if (game && game.contest) contestPoll(); else viewTeam();
      } catch (x) { err.textContent = 'No internet connection. Try again.'; btn.disabled = false; }
    };
  }

  // ------------------------------------------------------------------ pick a team
  var teamForm = { mode: 'table', table: '', name: '', pin: '', taken: null };

  function viewTeam(message) {
    stopTimers();
    var f = teamForm;
    var who = player ? (player.kind === 'member' ? '@' + player.name : player.name + ' (guest)') : '';
    render(gameCard() + '<div class="gap"></div><h1>Who are you with?</h1>' +
      '<div class="playing-as">' + picHtml(player && player.pic, 36) + '<p class="sub">Playing as <b>' + esc(who) + '</b> · <a href="#" id="switch">' + (player && player.kind === 'member' ? 'Sign out' : 'Change') + '</a></p></div><div class="gap"></div>' +
      '<div class="tabs" role="tablist">' +
      '<button data-m="table" class="' + (f.mode === 'table' ? 'on' : '') + '">Table number</button>' +
      '<button data-m="name" class="' + (f.mode === 'name' ? 'on' : '') + '">Team name</button>' +
      '<button data-m="solo" class="' + (f.mode === 'solo' ? 'on' : '') + '">Solo</button></div>' +
      '<form id="tf" class="stack" novalidate>' +
      (f.mode === 'table' ? '<div class="field"><label for="tbl">Your table number</label><input id="tbl" inputmode="numeric" maxlength="3" value="' + esc(f.table) + '" placeholder="e.g. 8"></div>' +
        '<p class="muted">Everyone at your table plays as one team. Look for the number on your table, or ask your server.</p>' : '') +
      (f.mode === 'name' ? '<div class="field"><label for="tname">Team name</label><input id="tname" maxlength="24" value="' + esc(f.name) + '" placeholder="e.g. The Shot Callers"></div>' : '') +
      (f.mode === 'solo' ? '<p class="muted">You play on your own as <b>' + esc(player ? player.name : '') + '</b>.</p>' : '') +
      (f.taken ? '<div class="card taken"><b>' + esc(f.taken) + ' is already playing.</b><p class="muted">Ask them for their 4-digit team code to join them, or pick another.</p>' +
        '<div class="field"><label for="pin">Team code</label><input id="pin" inputmode="numeric" maxlength="4" value="' + esc(f.pin) + '" placeholder="1234"></div></div>' : '') +
      '<p class="err" id="te">' + esc(message || '') + '</p><button class="btn" id="tb">Join the game</button></form>');

    document.querySelectorAll('[data-m]').forEach(function (b) {
      b.onclick = function () { saveTeamForm(); teamForm.mode = b.dataset.m; teamForm.taken = null; teamForm.pin = ''; viewTeam(); };
    });
    document.getElementById('switch').onclick = async function (e) {
      e.preventDefault();
      if (player && player.kind === 'member') { await sb.auth.signOut(); player = null; viewWho(); return; }
      viewGuest();
    };
    var tbl = document.getElementById('tbl');
    if (tbl) tbl.oninput = function () { tbl.value = tbl.value.replace(/\D/g, '').slice(0, 3); };
    var pin = document.getElementById('pin');
    if (pin) pin.oninput = function () { pin.value = pin.value.replace(/\D/g, '').slice(0, 4); };
    document.getElementById('tf').onsubmit = function (e) { e.preventDefault(); saveTeamForm(); join(); };
  }

  function saveTeamForm() {
    var t = document.getElementById('tbl'), n = document.getElementById('tname'), p = document.getElementById('pin');
    if (t) teamForm.table = t.value;
    if (n) teamForm.name = n.value;
    if (p) teamForm.pin = p.value;
  }

  async function join() {
    var f = teamForm;
    if (f.mode === 'table' && !(Number(f.table) >= 1 && Number(f.table) <= 999)) { viewTeam('Enter your table number.'); return; }
    if (f.mode === 'name' && f.name.trim().length < 2) { viewTeam('Team names are 2 to 24 characters.'); return; }
    if (f.taken && f.pin.length !== 4) { viewTeam('Enter the 4-digit team code.'); return; }
    var btn = document.getElementById('tb'); if (btn) btn.disabled = true;
    var r;
    try {
      r = await call('join', {
        session_id: game.session.id, pass: game.pass, mode: f.mode,
        table: f.mode === 'table' ? Number(f.table) : null,
        name: f.mode === 'name' ? f.name.trim() : null,
        pin: f.taken ? f.pin : null,
      });
    } catch (e) { viewTeam('No internet connection. Try again.'); return; }
    var d = r.data;
    if (r.status === 401) { player = null; viewWho(); return; }
    if (r.status !== 200) { viewTeam(d.error || 'Could not join. Try again.'); return; }
    if (d.reason === 'team_taken') { teamForm.taken = d.team_name || (f.mode === 'table' ? 'Table ' + f.table : f.name); viewTeam(f.pin ? 'That team code is not right.' : ''); return; }
    if (d.reason === 'wrong_code') { viewCode('The code on the TV has changed. Enter the one showing now.'); return; }
    if (d.error) { viewTeam(d.error); return; }
    teamCode = d.team_code || null;
    if (teamCode) { try { sessionStorage.setItem('bc_arena_teamcode:' + game.session.id, teamCode); } catch (x) { /* ignore */ } }
    teamForm = { mode: 'table', table: '', name: '', pin: '', taken: null };
    poll();
  }

  // ------------------------------------------------------------------ the game
  async function poll() {
    clearTimeout(pollTimer);
    var sent = Date.now();
    var r;
    try { r = await call('state', { session_id: game.session.id }); } catch (e) { pollTimer = setTimeout(poll, 3000); return; }
    if (r.status !== 200) { pollTimer = setTimeout(poll, 4000); return; }
    var got = Date.now();
    var srv = new Date(r.data.server_time).getTime();
    if (isFinite(srv)) skew = srv - (sent + got) / 2;
    applyState(r.data);
  }

  function nextPollDelay(s) {
    var status = s.session.status;
    if (status === 'lobby') return 3500;
    if (status !== 'live' || !s.question) return 0;
    var q = s.question, now = serverNow();
    var opens = new Date(q.opens_at).getTime(), closes = new Date(q.closes_at).getTime();
    if (!q.revealed) {
      if (now < opens) return Math.min(8000, Math.max(500, opens - now + 150));
      if (now < closes) return Math.min(8000, Math.max(800, closes - now + 700));
      return 1200; // waiting for the reveal
    }
    var next = new Date(q.revealed_at).getTime() + (s.session.reveal_seconds || 8) * 1000;
    return now < next ? Math.min(8000, Math.max(800, next - now + 700)) : 1200;
  }

  function applyState(s) {
    st = s;
    if (!teamCode) { try { teamCode = sessionStorage.getItem('bc_arena_teamcode:' + s.session.id); } catch (x) { /* ignore */ } }
    if (!s.me) {
      if (/^(lobby|live)$/.test(s.session.status)) { viewTeam(); return; }
      viewClosed(); return;
    }
    if (s.session.kind === 'callit') { applyCallIt(s); return; }
    var q = s.question;
    var key = [s.session.status, s.session.current_index, q ? q.revealed : '', s.me.answer, s.teams, s.me.rank, s.me.team_points, s.me.prize ? s.me.prize.status : '', s.me.voucher ? s.me.voucher.status : ''].join('|');
    if (key !== lastKey) { lastKey = key; draw(); stateSounds(s); }
    clearInterval(tickTimer);
    tickTimer = setInterval(updateClock, 250);
    updateClock();
    var delay = nextPollDelay(s);
    if (delay > 0) pollTimer = setTimeout(poll, delay);
  }

  // "1st: Free appetizer + 50 Hearts" for each place that has a prize.
  function prizeLine(s, i) {
    var item = ((s.prize_items || [])[i] || '').trim();
    var hearts = Number((s.prizes || [])[i] || 0);
    var parts = [];
    if (item) parts.push(esc(item));
    if (hearts > 0) parts.push(fmt(hearts) + ' Hearts');
    return parts.join(' + ');
  }
  function prizesCard(s) {
    var rows = '';
    var hearts = false;
    for (var i = 0; i < 3; i++) {
      var line = prizeLine(s, i);
      if (Number((s.prizes || [])[i] || 0) > 0) hearts = true;
      if (line) rows += '<div class="prize-row"><b>' + ordinal(i + 1) + '</b><span>' + line + '</span></div>';
    }
    if (!rows) return '';
    return '<div class="card prizes-list"><p class="muted">Tonight’s prizes</p>' + rows +
      (hearts ? '<p class="muted small">Hearts go to BarChata members. Guests can join free after the game to collect them.</p>' : '') + '</div>';
  }

  function teamLine() {
    var m = st.me;
    var rank = m.rank && st.leaderboard.length > 1 ? ordinal(m.rank) + ' · ' : '';
    return '<div class="arena-team"><span class="arena-team-name">' + picHtml(m.pic, 26) + '<span>' + esc(m.team_name) + '</span></span><span>' + rank + fmt(m.team_points) + ' pts</span></div>';
  }

  function draw() {
    var s = st, q = s.question, status = s.session.status;
    if (status === 'lobby') {
      render(gameCard() + '<div class="gap"></div><div class="center small">' +
        '<div class="me-pic">' + picHtml(s.me.pic, 76) + '<span class="me-check">✓</span></div><h1>You’re in!</h1><p class="sub">Playing as <b>' + esc(s.me.team_name) + '</b></p></div>' +
        (teamCode && s.me.kind !== 'solo' ? '<div class="card team-code"><p class="muted">Your team code</p><div class="code">' + esc(teamCode) + '</div>' +
          '<p class="muted">Friends at your table pick <b>' + esc(s.me.team_name) + '</b> and enter this code to join you.</p></div>' : '') +
        prizesCard(s.session) + joinSlot() +
        '<div class="gap"></div><p class="muted center-text">' + (s.session.kind === 'callit' ? 'The calls start with the game. Keep this page open' : 'Waiting for the host to start') + ' · ' + s.teams + (s.teams === 1 ? ' team' : ' teams') + ' joined</p>');
      return;
    }
    if (status === 'live' && q) {
      var head = '<div class="arena-qhead"><span>Question ' + (q.idx + 1) + ' of ' + s.session.question_count + (q.category ? ' · ' + esc(q.category) : '') + '</span><span id="clock" class="clock"></span></div>' +
        '<div class="bar"><div id="barfill"></div></div>';
      if (!q.revealed && serverNow() < new Date(q.opens_at).getTime()) {
        render(head + '<div class="center"><p class="muted">Get ready</p><div id="lead" class="lead"></div></div>' + teamLine());
        return;
      }
      if (!q.revealed) {
        var picked = s.me.answer;
        var html = head + '<p class="prompt">' + esc(q.prompt) + '</p><div class="answers">';
        q.options.forEach(function (o, i) {
          var cls = picked == null ? '' : (picked === i ? ' picked' : ' dim');
          html += '<button class="answer' + cls + '" data-i="' + i + '" style="--c:' + COLORS[i] + '"' + (picked != null ? ' disabled' : '') + '><span class="l">' + LETTERS[i] + '</span><span class="t">' + esc(o) + '</span></button>';
        });
        html += '</div>' + (picked != null ? '<p class="muted center-text">Locked in for your team. Waiting for the answer...</p>' : '') + teamLine();
        render(html);
        document.querySelectorAll('.answer[data-i]').forEach(function (b) { b.onclick = function () { answer(Number(b.dataset.i)); }; });
        return;
      }
      var mine = s.me.answer, right = s.me.answer_correct === true;
      var verdict = mine == null
        ? '<div class="verdict none"><b>Time’s up</b><span>No answer this time</span></div>'
        : right ? '<div class="verdict ok"><b>Correct!</b><span>+' + fmt(s.me.answer_points) + ' points</span></div>'
          : '<div class="verdict no"><b>Not this time</b><span>You picked ' + LETTERS[mine] + '</span></div>';
      render(head.replace('<span id="clock" class="clock"></span>', '') + verdict +
        '<div class="card"><p class="muted">The answer</p><div class="right-answer" style="--c:' + COLORS[q.correct] + '"><span class="l">' + LETTERS[q.correct] + '</span>' + esc(q.options[q.correct]) + '</div></div>' +
        teamLine() + '<p class="muted center-text">' + (q.idx + 1 < s.session.question_count ? 'Next question coming up...' : 'Final scores coming up...') + '</p>');
      return;
    }
    if (status === 'ended') { viewEnded(); return; }
    viewClosed();
  }

  // Reveal and end-of-game sounds (once each, only if they just happened).
  function stateSounds(s) {
    var q = s.question, m = s.me;
    if (s.session.status === 'live' && q && q.revealed && m) {
      var at = q.revealed_at ? new Date(q.revealed_at).getTime() : serverNow();
      if (serverNow() - at < 6000) once(q.id + ':rev', function () { if (m.answer_correct === true) { sfx.right(); buzz(60); } else { sfx.wrong(); buzz([90, 60, 90]); } });
    }
    if (s.session.status === 'ended' && m) {
      var end = s.session.ended_at ? new Date(s.session.ended_at).getTime() : serverNow();
      if (serverNow() - end < 60000) once(s.session.id + ':end', m.rank === 1 ? sfx.win : sfx.done);
    }
  }

  // 3-2-1 before each question, a tone when it opens, ticks in the last 5 seconds.
  function clockSounds(q, now, opens, closes) {
    if (q.revealed) return;
    if (now < opens) { var c = Math.ceil((opens - now) / 1000); if (c >= 1 && c <= 3) once(q.id + ':c' + c, sfx.count); }
    else if (now - opens < 1200) once(q.id + ':go', sfx.go);
    var left = closes - now;
    if (left > 0 && left <= 5000) once(q.id + ':t' + Math.ceil(left / 1000), sfx.tick);
  }

  function updateClock() {
    if (st && st.session && st.session.kind === 'callit') { callItClock(); return; }
    if (!st || !st.question || st.session.status !== 'live') return;
    var q = st.question, now = serverNow();
    var opens = new Date(q.opens_at).getTime(), closes = new Date(q.closes_at).getTime();
    clockSounds(q, now, opens, closes);
    var lead = document.getElementById('lead');
    if (lead) {
      if (now >= opens) { lastKey = ''; draw(); return; }
      lead.textContent = Math.max(1, Math.ceil((opens - now) / 1000));
      return;
    }
    var clock = document.getElementById('clock'), fill = document.getElementById('barfill');
    if (q.revealed) { if (fill) fill.style.width = '0%'; return; }
    var left = Math.max(0, closes - now);
    if (clock) clock.textContent = Math.ceil(left / 1000) + 's';
    if (fill) { fill.style.width = (100 * left / Math.max(1, closes - opens)) + '%'; fill.classList.toggle('low', left < 5000); }
  }

  async function answer(i) {
    if (sending || !st || !st.question) return;
    sending = true;
    sfx.tap(); buzz(25);
    st.me.answer = i; lastKey = ''; draw();
    try {
      var r = await call('answer', { question_id: st.question.id, choice: i });
      if (r.status !== 200) { toast(r.data.error || 'Too late for that one.'); }
      else if (r.data.locked_in != null && r.data.locked_in !== i) { st.me.answer = r.data.locked_in; lastKey = ''; draw(); if (r.data.team) toast('A teammate already answered ' + LETTERS[r.data.locked_in] + ' for your team.'); }
    } catch (e) { toast('No connection. Your answer may not have been sent.'); }
    sending = false;
  }

  // ------------------------------------------------------------------ Call It (Oct 25, 2026)
  var guessDraft = {};   // guesses being typed, kept while the page redraws
  var ciLockSig = '';    // which calls were locked at the last redraw
  function fmtNum(n) { return n == null ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function callLocked(c) { return !!(c.resolved || (c.closes_at && new Date(c.closes_at).getTime() <= serverNow())); }
  function findCall(id) { return (st && st.calls || []).filter(function (c) { return c.id === id; })[0] || null; }

  function applyCallIt(s) {
    var calls = s.calls || [];
    var key = ['ci', s.session.status, s.teams, s.me.rank, s.me.team_points, s.me.prize ? s.me.prize.status : '', s.me.voucher ? s.me.voucher.status : '',
      calls.map(function (c) {
        return [c.id, c.resolved ? 1 : 0, c.voided ? 1 : 0, callLocked(c) ? 1 : 0, c.closes_at || '', c.mine ? [c.mine.choice, c.mine.guess, c.mine.points].join(':') : ''].join(',');
      }).join(';')].join('|');
    if (key !== lastKey) {
      lastKey = key;
      if (s.session.status === 'live') drawCallIt(); else draw();
      callItSounds(s);
    }
    if (s.session.status !== 'lobby' && s.session.status !== 'live') return;
    ciLockSig = calls.map(function (c) { return callLocked(c) ? 1 : 0; }).join('');
    clearInterval(tickTimer);
    tickTimer = setInterval(updateClock, 250);
    updateClock();
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, s.session.status === 'lobby' ? 3500 : 3000);
  }

  function ptsTag(c) { return c.points >= 300 ? 'Triple · ' + c.points + ' pts' : c.points >= 200 ? 'Double · ' + c.points + ' pts' : c.points + ' pts'; }

  function openCallHtml(c) {
    var locked = callLocked(c), m = c.mine, body;
    var head = '<div class="ci-top"><span class="ci-pts">' + ptsTag(c) + '</span><span class="ci-clock" data-clock="' + esc(c.id) + '"></span></div>' +
      '<p class="prompt ci-prompt">' + esc(c.prompt) + '</p>';
    if (m) {
      var pick = c.qtype === 'guess'
        ? '<b>' + fmtNum(m.guess) + (c.unit ? ' ' + esc(c.unit) : '') + '</b>'
        : '<b style="color:' + COLORS[m.choice] + '">' + LETTERS[m.choice] + '. ' + esc(c.options[m.choice]) + '</b>';
      body = '<div class="ci-mine">' + (m.by_me ? 'Your team called ' : 'Your teammate called ') + pick + '</div>' +
        '<p class="muted">' + (locked ? 'Locked. Waiting for the result...' : 'Locked in for your team. Waiting for the result...') + '</p>';
    } else if (locked) {
      body = '<p class="muted">Locked. Your team didn’t call this one.</p>';
    } else if (c.qtype === 'choice') {
      body = '<div class="answers">' + c.options.map(function (o, i) {
        return '<button class="answer" data-call="' + esc(c.id) + '" data-i="' + i + '" style="--c:' + COLORS[i] + '"><span class="l">' + LETTERS[i] + '</span><span class="t">' + esc(o) + '</span></button>';
      }).join('') + '</div>';
    } else {
      body = '<form class="ci-guess" data-gf="' + esc(c.id) + '" novalidate><div class="field"><label for="g-' + esc(c.id) + '">Your guess' + (c.unit ? ' (' + esc(c.unit) + ')' : '') + '</label>' +
        '<input id="g-' + esc(c.id) + '" data-guess="' + esc(c.id) + '" inputmode="decimal" autocomplete="off" maxlength="10" placeholder="e.g. 6"></div>' +
        '<button class="btn">Lock in my guess</button><p class="muted small">Closest team wins ' + (c.points * 2) + ' pts, an exact hit ' + (c.points * 3) + '.</p></form>';
    }
    return '<div class="card ci-call' + (m || locked ? '' : ' ci-live') + '">' + head + body + '</div>';
  }

  function doneCallHtml(c) {
    var m = c.mine, res, cls;
    if (c.voided) { res = 'Voided · no points'; cls = 'none'; }
    else if (c.qtype === 'choice') {
      var ans = c.correct != null ? LETTERS[c.correct] + '. ' + esc(c.options[c.correct]) : '';
      if (!m) { res = 'It was <b>' + ans + '</b>'; cls = 'none'; }
      else if (m.is_correct) { res = '✓ Called it! <b>+' + fmt(m.points) + '</b> · ' + ans; cls = 'ok'; }
      else { res = '✗ Missed · it was <b>' + ans + '</b>'; cls = 'no'; }
    } else {
      var val = fmtNum(c.answer_value) + (c.unit ? ' ' + esc(c.unit) : '');
      if (!m) { res = 'The answer: <b>' + val + '</b>'; cls = 'none'; }
      else if (m.is_correct) { res = (Number(m.guess) === Number(c.answer_value) ? '✓ Exact! ' : '✓ Closest! ') + '<b>+' + fmt(m.points) + '</b> · the answer: ' + val; cls = 'ok'; }
      else { res = '✗ Not the closest · you said ' + fmtNum(m.guess) + ', the answer: <b>' + val + '</b>'; cls = 'no'; }
    }
    return '<div class="ci-res ' + cls + '"><span class="ci-res-q">' + esc(c.prompt) + '</span><span>' + res + '</span></div>';
  }

  function drawCallIt() {
    var s = st, calls = s.calls || [];
    var meta = s.session.meta || {};
    var focusId = document.activeElement && document.activeElement.id;
    $app.querySelectorAll('input[data-guess]').forEach(function (el) { guessDraft[el.getAttribute('data-guess')] = el.value; });
    var open = calls.filter(function (c) { return !c.resolved; });
    var done = calls.filter(function (c) { return c.resolved; }).slice(0, 4);
    var html = '<div class="arena-qhead"><span>Call It · ' + esc(meta.home && meta.away ? meta.home + ' vs ' + meta.away : s.session.title) + '</span>' +
      '<span class="ci-count">' + (open.length ? open.length + ' open' : '') + '</span></div><div class="gap"></div>';
    if (!open.length) {
      html += '<div class="card ci-wait"><b>Next call coming up</b><p class="muted">Watch the TV. When staff make a call, it shows here: tap your answer before it locks.</p></div>';
    }
    open.forEach(function (c) { html += openCallHtml(c); });
    if (done.length) html += '<p class="muted ci-sec">Results</p>' + done.map(doneCallHtml).join('');
    html += teamLine() + '<p class="muted small center-text">One answer per table or team: the first one in counts. Fewer teams right = bigger bonus.</p>' + joinSlot();
    render(html);
    $app.querySelectorAll('input[data-guess]').forEach(function (el) {
      var id = el.getAttribute('data-guess');
      if (guessDraft[id] != null) el.value = guessDraft[id];
      el.oninput = function () { el.value = el.value.replace(/[^\d.\-]/g, '').slice(0, 10); guessDraft[id] = el.value; };
    });
    if (focusId) {
      var f = document.getElementById(focusId);
      if (f && f.tagName === 'INPUT') { f.focus(); try { var n = f.value.length; f.setSelectionRange(n, n); } catch (e) { /* not a text box */ } }
    }
    $app.querySelectorAll('.answer[data-call]').forEach(function (b) {
      b.onclick = function () { answerCall(b.getAttribute('data-call'), Number(b.getAttribute('data-i')), null); };
    });
    $app.querySelectorAll('form[data-gf]').forEach(function (f) {
      f.onsubmit = function (e) {
        e.preventDefault();
        var id = f.getAttribute('data-gf'), box = document.getElementById('g-' + id), v = box ? box.value.trim() : '';
        if (!/^-?\d{1,7}(\.\d{1,2})?$/.test(v)) { toast('Type your guess as a number.'); return; }
        answerCall(id, null, Number(v));
      };
    });
  }

  async function answerCall(id, choice, guess) {
    var c = findCall(id);
    if (sending || !c || c.mine || callLocked(c)) return;
    sending = true;
    sfx.tap(); buzz(25);
    c.mine = { choice: choice, guess: guess, by_me: true, is_correct: null, points: null };
    delete guessDraft[id];
    lastKey = ''; drawCallIt();
    try {
      var r = await call('callit_answer', choice != null ? { question_id: id, choice: choice } : { question_id: id, guess: guess });
      if (r.status !== 200) {
        c.mine = null;
        if (guess != null) guessDraft[id] = String(guess);
        lastKey = ''; drawCallIt();
        toast(r.data.error || 'Too late for that one.');
      } else if (r.data.team) {
        c.mine = { choice: r.data.choice, guess: r.data.guess, by_me: false, is_correct: null, points: null };
        lastKey = ''; drawCallIt();
        toast('A teammate already called this one for your team.');
      }
    } catch (e) { toast('No connection. Your answer may not have been sent.'); }
    sending = false;
  }

  // A new call (a ping and a buzz), and each result for your team.
  function callItSounds(s) {
    if (s.session.status !== 'live') { stateSounds(s); return; }
    (s.calls || []).forEach(function (c) {
      var opens = c.opens_at ? new Date(c.opens_at).getTime() : 0;
      if (!c.resolved && serverNow() - opens < 5000) once(c.id + ':new', function () { sfx.go(); buzz([40, 40, 40]); });
      if (c.resolved && !c.voided && c.mine && c.resolved_at && serverNow() - new Date(c.resolved_at).getTime() < 10000) {
        once(c.id + ':res', function () { if (c.mine.is_correct) { sfx.right(); buzz(60); } else { sfx.wrong(); buzz([90, 60, 90]); } });
      }
    });
  }

  // Countdowns on open calls; redraw the moment one locks.
  function callItClock() {
    if (!st || st.session.status !== 'live') return;
    var calls = st.calls || [], now = serverNow();
    var sig = calls.map(function (c) { return callLocked(c) ? 1 : 0; }).join('');
    if (sig !== ciLockSig) { ciLockSig = sig; applyCallIt(st); return; }
    calls.forEach(function (c) {
      var el = $app.querySelector('[data-clock="' + c.id + '"]');
      if (!el) return;
      if (callLocked(c)) { el.textContent = c.resolved ? '' : 'Locked'; el.classList.remove('low'); return; }
      if (!c.closes_at) { el.textContent = 'Open'; return; }
      var left = new Date(c.closes_at).getTime() - now;
      el.textContent = clockText(left);
      el.classList.toggle('low', left < 10000);
      if (!c.mine && left > 0 && left <= 5000) once(c.id + ':t' + Math.ceil(left / 1000), sfx.tick);
    });
  }

  // ------------------------------------------------------------------ Join our rewards (Oct 25, 2026)
  var joinSt = null;      // { venue, offer, member, eligible, joined } for the current game or giveaway
  var joinFor = '';       // which game or giveaway joinSt belongs to
  var joinLoading = '';
  var joinOpen = false;   // the quick-join form is showing
  var joinBusy = false;
  var joinDraft = { name: '', contact: '', marketing: false };

  function joinSlot() { return '<div id="joinSlot"></div>'; }
  function joinTarget() {
    if (!game || !game.session) return null;
    if (game.contest) return { source: (cst && cst.contest && cst.contest.kind) || game.session.kind || 'giveaway', source_id: game.session.id };
    return { source: st && st.session && st.session.kind === 'callit' ? 'callit' : 'trivia', source_id: game.session.id };
  }
  async function loadJoin(t, key) {
    if (joinLoading === key) return;
    joinLoading = key;
    try {
      var r = await call('join_offer', t);
      if (r.status === 200) { joinSt = r.data; joinFor = key; }
      else { joinSt = null; joinFor = key; }
    } catch (e) { joinLoading = ''; return; }
    joinLoading = '';
    fillJoin();
  }

  function joinCardHtml() {
    var j = joinSt, o = j && j.offer, v = (j && j.venue) || {};
    var vname = esc(v.name || 'this business');
    if (j && j.joined) {
      var jn = j.joined, until = jn.expires_at ? new Date(jn.expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      var state = jn.status === 'redeemed' ? '<div class="voucher-state">✓ Used. Thanks for joining!</div>'
        : jn.status === 'expired' ? '<div class="voucher-state">This code has expired.</div>'
        : '<p class="muted">Show us this code</p><div class="voucher-code">' + esc(jn.code || '') + '</div><p class="sub">Valid until ' + esc(until) + '. Take a screenshot to keep it.</p>';
      var hearts = '';
      if (jn.hearts_bonus > 0 && !jn.account) hearts = '<p class="sub">+' + fmt(jn.hearts_bonus) + ' Hearts are waiting for you. <a href="#" id="joinAcct">Make your free BarChata account</a> to collect them.</p>';
      else if (jn.hearts_paid > 0) hearts = '<p class="sub">+' + fmt(jn.hearts_paid) + ' Hearts were added to your Hearts at ' + vname + '.</p>';
      return '<div class="card voucher join-card' + (jn.status === 'issued' ? '' : ' done') + '"><p class="muted">Welcome to ' + vname + ' rewards</p><div class="voucher-item">' + esc(jn.offer || '') + '</div>' + state + hearts + '</div>';
    }
    if (!o || !j.eligible) return '';
    var isMember = player && player.kind === 'member';
    var head = '<p class="join-eyebrow">Join ' + vname + ' rewards</p><div class="join-offer">' + esc(o.offer) + '</div>' +
      (o.bonus_hearts > 0 ? '<span class="join-hearts">+' + fmt(o.bonus_hearts) + ' Hearts' + (isMember ? '' : ' with a free account') + '</span>' : '');
    var consent = '<p class="muted small">Joining shares your name and ' + (isMember ? 'contact' : 'email or number') + ' with ' + vname + '.' + (o.fine_print ? ' ' + esc(o.fine_print) : '') + '</p>';
    var mk = '<label class="check"><input type="checkbox" id="joinMk"' + (joinDraft.marketing ? ' checked' : '') + '><span>Send me offers from ' + vname + ' (optional)</span></label>';
    if (isMember) {
      return '<div class="card join-card">' + head + mk + '<button class="btn" id="joinGo" type="button"' + (joinBusy ? ' disabled' : '') + '>Join free</button>' + consent + '</div>';
    }
    if (!joinOpen) {
      return '<div class="card join-card">' + head + '<button class="btn" id="joinShow" type="button">Join free</button><p class="muted small">Just your name and email or mobile. No app needed.</p></div>';
    }
    return '<div class="card join-card">' + head +
      '<form id="joinForm" class="stack" novalidate>' +
      '<div class="field"><label for="joinName">Your name</label><input id="joinName" maxlength="60" autocomplete="name" placeholder="First and last name"></div>' +
      '<div class="field"><label for="joinContact">Email or mobile number</label><input id="joinContact" maxlength="254" autocomplete="email" inputmode="email" placeholder="you@email.com or 416 555 0199"></div>' +
      mk + '<button class="btn" id="joinGo"' + (joinBusy ? ' disabled' : '') + '>Join and get my code</button>' + consent + '</form></div>';
  }

  function fillJoin(hadFocus) {
    var slot = document.getElementById('joinSlot');
    if (!slot) return;
    var t = joinTarget();
    if (!t) { slot.innerHTML = ''; return; }
    var key = t.source + ':' + t.source_id;
    if (joinFor !== key) { slot.innerHTML = ''; loadJoin(t, key); return; }
    var focusId = hadFocus || (document.activeElement && document.activeElement.id);
    slot.innerHTML = joinCardHtml();
    var nm = document.getElementById('joinName'), ct = document.getElementById('joinContact'), mk = document.getElementById('joinMk');
    if (nm) { nm.value = joinDraft.name || (player && player.kind !== 'member' ? player.name : '') || ''; nm.oninput = function () { joinDraft.name = nm.value; }; }
    if (ct) { ct.value = joinDraft.contact; ct.oninput = function () { joinDraft.contact = ct.value; }; }
    if (mk) mk.onchange = function () { joinDraft.marketing = mk.checked; };
    if (focusId && (focusId === 'joinName' || focusId === 'joinContact')) {
      var f = document.getElementById(focusId);
      if (f) { f.focus(); try { var n = f.value.length; f.setSelectionRange(n, n); } catch (e) { /* not a text box */ } }
    }
    var show = document.getElementById('joinShow');
    if (show) show.onclick = function () { joinOpen = true; fillJoin(); var x = document.getElementById('joinName'); if (x) x.focus(); };
    var form = document.getElementById('joinForm');
    if (form) form.onsubmit = function (e) { e.preventDefault(); joinNow(); };
    else { var go = document.getElementById('joinGo'); if (go) go.onclick = joinNow; }
    var acct = document.getElementById('joinAcct');
    if (acct) acct.onclick = function (e) { e.preventDefault(); setJSON(RETURN_KEY, { path: game && game.code ? '/play/' + game.code : '/play', at: Date.now() }); location.href = '/join'; };
  }

  async function joinNow() {
    if (joinBusy) return;
    var t = joinTarget();
    if (!t) return;
    var isMember = player && player.kind === 'member';
    var nm = document.getElementById('joinName'), ct = document.getElementById('joinContact'), mk = document.getElementById('joinMk');
    if (nm) joinDraft.name = nm.value;
    if (ct) joinDraft.contact = ct.value;
    if (mk) joinDraft.marketing = mk.checked;
    if (!isMember) {
      if (joinDraft.name.trim().length < 2) { toast('Type your name.'); return; }
      if (joinDraft.contact.trim().length < 5) { toast('Add your email or mobile number.'); return; }
    }
    joinBusy = true; fillJoin();
    try {
      var r = await call('join_rewards', Object.assign({}, t, isMember ? { marketing: joinDraft.marketing } : { name: joinDraft.name.trim(), contact: joinDraft.contact.trim(), marketing: joinDraft.marketing }));
      if (r.status === 200 && r.data && (r.data.joined || r.data.already_member)) {
        joinSt = r.data;
        if (r.data.already_member) toast('You’re already a member here.');
        else { sfx.right(); buzz(60); }
      } else {
        toast((r.data && r.data.error) || 'Could not join. Try again.');
      }
    } catch (e) { toast('No internet connection. Try again.'); }
    joinBusy = false; fillJoin();
  }

  function viewEnded() {
    stopTimers();
    var m = st.me, s = st.session;
    var top = st.leaderboard[0];
    var won = m.rank === 1;
    render('<div class="center small"><div class="me-pic end">' + picHtml(m.pic, 64) + '</div><p class="muted">' + esc(s.title) + '</p><h1>' + (won ? 'You won!' : 'Game over') + '</h1>' +
      '<div class="final-rank">' + ordinal(m.rank || st.teams) + '</div><p class="sub">' + esc(m.team_name) + ' · ' + fmt(m.team_points) + ' points' + (m.rank ? ' · ' + ordinal(m.rank) + ' of ' + st.teams : '') + '</p></div>' +
      (top && !won ? '<p class="muted center-text">Winner: <b>' + esc(top.name) + '</b> with ' + fmt(top.points) + ' points</p>' : '') +
      '<div class="gap"></div>' +
      voucherCard(m.voucher) +
      joinSlot() +
      endCard(m, s) +
      '<button class="btn ghost" id="again">Join another game</button>');
    document.getElementById('again').onclick = function () { setJSON(GAME_KEY, null); history.replaceState({}, '', '/play'); viewCode(); };
    var collect = document.getElementById('collect');
    if (collect) collect.onclick = function () { setJSON(RETURN_KEY, { path: '/play', at: Date.now() }); location.href = '/join'; };
  }

  // A real prize the team won (free appetizer, $20 off...): one per team, the code is shown to staff.
  function voucherCard(v) {
    if (!v) return '';
    var until = new Date(v.expires_at);
    var expired = v.status === 'issued' && until.getTime() < Date.now();
    var head = '<p class="muted">Your prize · ' + ordinal(v.place) + ' place</p><div class="voucher-item">' + esc(v.item) + '</div>';
    if (v.status === 'redeemed') {
      return '<div class="card voucher done given">' + head + '<div class="voucher-state">✓ Given. Enjoy!</div></div>';
    }
    if (v.status === 'void' || expired) {
      return '<div class="card voucher done">' + head + '<div class="voucher-state">' + (expired ? 'This prize has expired.' : 'This prize was cancelled.') + '</div></div>';
    }
    var date = until.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return '<div class="card voucher">' + head +
      '<p class="muted">Show us this code</p><div class="voucher-code">' + esc(v.code) + '</div>' +
      '<p class="sub">One prize per team · valid until ' + esc(date) + '. Take a screenshot to keep it.</p></div>';
  }

  // What the player won, and the next step (members: it's in your balance; guests: join to collect).
  function endCard(m, s) {
    var pz = m.prize, venue = esc(s.venue_name || 'this venue');
    if (pz && pz.status === 'pending_claim') {
      var days = pz.expires_at ? Math.max(1, Math.ceil((new Date(pz.expires_at).getTime() - Date.now()) / 86400000)) : 7;
      return '<div class="card cta prize"><div class="prize-amt">+' + fmt(pz.hearts) + ' Hearts</div><h2>You won ' + fmt(pz.hearts) + ' Hearts!</h2>' +
        '<p class="sub">Create your free BarChata account in the next ' + days + (days === 1 ? ' day' : ' days') + ' to collect them. Use Hearts for rewards at ' + venue + '.</p>' +
        '<div class="gap"></div><button class="btn" id="collect">Collect my Hearts</button></div>';
    }
    if (pz && (pz.status === 'awarded' || pz.status === 'claimed')) {
      return '<div class="card cta prize"><div class="prize-amt">+' + fmt(pz.hearts) + ' Hearts</div><h2>Your Hearts are in!</h2>' +
        '<p class="sub">' + fmt(pz.hearts) + ' Hearts were added to your Hearts at ' + venue + '. Use them for rewards there.</p>' +
        '<div class="gap"></div><a class="btn secondary" href="/app">See my Hearts</a></div>';
    }
    // A winning place that should have paid Hearts but didn't (venue pool or budget ran out, or the daily limit).
    var paidPlaces = Math.min(3, Math.max(0, (st.teams || 0) - 1));
    var heartsForPlace = m.rank ? Number((s.prizes || [])[m.rank - 1] || 0) : 0;
    var missedHearts = m.rank && m.rank <= paidPlaces && m.team_points > 0 && heartsForPlace > 0 && !pz && /Hearts/.test(s.prizes_note || '');
    var note = missedHearts ? '<p class="muted">No Hearts this time: ' + venue + ' had none left to give tonight.</p><div class="gap"></div>' : '';
    if (m.is_guest) {
      return '<div class="card cta"><h2>Win Hearts next time</h2>' + note + '<p class="sub">Create your free BarChata account to keep your scores, win Hearts at ' + venue + ' and get rewards.</p><div class="gap"></div><a class="btn" href="/join">Join BarChata free</a></div>';
    }
    return '<div class="card cta"><h2>Thanks for playing</h2>' + note + '<p class="sub">Check in at ' + venue + ' in the BarChata app to earn Hearts on every visit.</p><div class="gap"></div><a class="btn secondary" href="/app">Open BarChata</a></div>';
  }

  // A guest who just created an account on this phone: move the Hearts they won into it.
  async function claimGuestHearts() {
    var guest = getJSON(GUEST_KEY);
    if (!guest || !guest.token) return;
    var s = (await sb.auth.getSession()).data.session;
    if (!s) return;
    try {
      var r = await call('claim', {});
      if (r.status === 200 && r.data.hearts > 0) toast(fmt(r.data.hearts) + ' Hearts were added to your account!');
      if (r.status === 200) setJSON(GUEST_KEY, null);
    } catch (e) { /* try again next visit */ }
  }

  function viewClosed() {
    stopTimers();
    render('<div class="center"><h1>This game has ended</h1><p class="sub">Ask staff when the next one starts, then scan the new code on the TV.</p></div>' +
      '<button class="btn" id="again">Enter a game code</button>');
    document.getElementById('again').onclick = function () { setJSON(GAME_KEY, null); history.replaceState({}, '', '/play'); viewCode(); };
  }

  // ------------------------------------------------------------------ giveaways and free draws
  var cst = null;        // last contest state
  var cKey = '';
  var cSending = false;
  var cRevealed = false; // the TV has shown this player's draw result

  async function contestPoll() {
    clearTimeout(pollTimer);
    var sent = Date.now(), r;
    try { r = await call('contest_state', { contest_id: game.session.id }); } catch (e) { pollTimer = setTimeout(contestPoll, 4000); return; }
    if (r.status !== 200 || !r.data.contest) { pollTimer = setTimeout(contestPoll, 5000); return; }
    var got = Date.now(), srv = new Date(r.data.server_time).getTime();
    if (isFinite(srv)) skew = srv - (sent + got) / 2;
    applyContest(r.data);
  }

  // When each drawn winner's name stops on the TV's reel (same timing as the TV).
  function revealTimes(drawn) {
    var groups = {};
    return (drawn || []).map(function (w) {
      var t = new Date(w.drawn_at).getTime(), k = String(Math.round(t / 1000)), i = groups[k] || 0;
      groups[k] = i + 1;
      return t + 4500 + i * 2500;
    });
  }
  function revealed(s) {
    // Has the TV shown this player's result yet? (Winners: their own name; everyone else: the last name.)
    var drawn = s.drawn || [], times = revealTimes(drawn), now = serverNow();
    if (!drawn.length) return false;
    if (s.me && s.me.won) {
      for (var i = 0; i < drawn.length; i++) if (drawn[i].order === s.me.order) return now >= times[i];
    }
    return now >= Math.max.apply(null, times);
  }

  function contestDelay(s) {
    var c = s.contest, m = s.me;
    if (c.status === 'open' || c.status === 'closed' || c.status === 'scheduled') return 3500;
    if (c.status === 'drawn') return m && m.outcome === 'pending' ? 3000 : 4000;
    if (m && m.voucher && m.voucher.status === 'issued') return 20000; // to show "Given" when staff mark it
    return 0;
  }

  function applyContest(s) {
    cst = s;
    var m = s.me, pending = m && m.outcome === 'pending';
    var key = JSON.stringify([s.contest.status, s.contest.kind === 'giveaway' ? s.left : '', m ? [m.won, m.outcome, m.voucher && m.voucher.status] : null,
      pending ? '' : (s.drawn || []).map(function (d) { return d.order + d.outcome; }).join(','), revealed(s)]);
    cRevealed = revealed(s);
    if (key !== cKey) { cKey = key; drawContest(); contestSounds(s); }
    clearInterval(tickTimer);
    tickTimer = setInterval(updateContestClock, 500);
    updateContestClock();
    var d = contestDelay(s);
    if (d > 0) pollTimer = setTimeout(contestPoll, d);
  }

  function rulesBox(c) {
    return '<details class="card rules"><summary>Contest rules</summary><p>' + esc(c.rules) + '</p></details>';
  }

  function contestHead(s) {
    var c = s.contest;
    return '<div class="card contest-head"><p class="contest-eyebrow">' + (c.kind === 'giveaway' ? 'Instant giveaway' : 'Free draw · no purchase necessary') + '</p>' +
      '<div class="contest-prize">' + esc(c.prize) + '</div><p class="muted">' + esc(c.venue_name || '') +
      (c.prize_value ? ' · approx. value $' + Number(c.prize_value).toFixed(2).replace(/\.00$/, '') + (c.winners > 1 ? ' each' : '') : '') + '</p></div>';
  }

  function contestVoucher(v, won) {
    var until = new Date(v.expires_at);
    var head = '<p class="muted">' + (won ? 'Your prize' : 'Your prize') + '</p><div class="voucher-item">' + esc(v.item) + '</div>';
    if (v.status === 'redeemed') return '<div class="card voucher done given">' + head + '<div class="voucher-state">✓ Given. Enjoy!</div></div>';
    if (v.status === 'void' || until.getTime() < Date.now()) return '<div class="card voucher done">' + head + '<div class="voucher-state">' + (v.status === 'void' ? 'This prize was cancelled.' : 'This prize has expired.') + '</div></div>';
    var when = until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return '<div class="card voucher">' + head + '<p class="muted">Show us this code</p><div class="voucher-code">' + esc(v.code) + '</div>' +
      '<p class="sub">Valid until ' + esc(when) + '. Take a screenshot to keep it.</p></div>';
  }

  function againButton() { return '<button class="btn ghost" id="again">Join another game</button>'; }
  function wireAgain() {
    var b = document.getElementById('again');
    if (b) b.onclick = function () { setJSON(GAME_KEY, null); history.replaceState({}, '', '/play'); cst = null; cKey = ''; viewCode(); };
  }

  function drawContest() {
    var s = cst, c = s.contest, m = s.me, give = c.kind === 'giveaway';
    var html = '';
    if (m && m.voucher) {
      html = '<div class="center small"><div class="me-pic">' + picHtml(m.pic, 72) + '<span class="me-check">✓</span></div>' +
        '<h1>' + (give ? 'It’s yours!' : 'You won!') + '</h1><p class="sub">' + (give ? 'You claimed one. ' : 'You answered correctly. ') + 'Show us your code.</p></div>' +
        contestVoucher(m.voucher, !give) + joinSlot() + rulesBox(c) + againButton();
      render(html); wireAgain(); return;
    }
    if (give) {
      if (!m && c.status === 'open' && (s.left || 0) > 0) {
        html = contestHead(s) +
          '<div class="contest-stats"><div><b>' + fmt(s.left) + '</b><span>left of ' + fmt(c.winners) + '</span></div><div><b id="cclock">–</b><span>ends in</span></div></div>' +
          '<button class="btn" id="enter">Claim mine</button><p class="muted center-text">Free. One per person. First come, first served.</p>' + rulesBox(c) + legal();
        render(html);
        document.getElementById('enter').onclick = contestEnter;
        return;
      }
      html = '<div class="center"><h1>' + (s.claimed >= c.winners ? 'All gone!' : 'This giveaway has ended') + '</h1><p class="sub">' + esc(c.prize) + ' · ' + fmt(s.claimed) + ' of ' + fmt(c.winners) + ' claimed. Watch the TV for the next one.</p></div>' + againButton();
      render(html); wireAgain(); return;
    }

    // Free draw
    if (!m) {
      if (c.status === 'open') {
        html = contestHead(s) +
          '<div class="contest-stats"><div><b>' + fmt(s.entries) + '</b><span>' + (s.entries === 1 ? 'entry' : 'entries') + '</span></div><div><b id="cclock">–</b><span>draw in · ' + c.winners + (c.winners === 1 ? ' winner' : ' winners') + '</span></div></div>' +
          '<button class="btn" id="enter">Enter the free draw</button><p class="muted center-text">Free. One entry per person. No purchase necessary.' + (c.skill_test ? ' Winners answer a skill-testing question.' : '') + '</p>' + rulesBox(c) + legal();
        render(html);
        document.getElementById('enter').onclick = contestEnter;
        return;
      }
      html = '<div class="center"><h1>Entries are closed</h1><p class="sub">' + esc(c.prize) + '. Watch the TV for the winners.</p></div>' + againButton();
      render(html); wireAgain(); return;
    }
    if (c.status === 'open' || c.status === 'closed' || c.status === 'scheduled' || (c.status === 'drawn' && !revealed(s))) {
      var drawing = c.status !== 'open';
      html = '<div class="center small"><div class="me-pic">' + picHtml(m.pic, 72) + '<span class="me-check">✓</span></div><h1>' + (drawing ? 'Drawing now...' : 'You’re in!') + '</h1>' +
        '<p class="sub">' + (drawing ? 'Watch the TV.' : 'Draw in <b id="cclock">–</b>') + '</p></div>' + contestHead(s) +
        '<p class="muted center-text">Keep this page open: if you win, you’ll answer ' + (c.skill_test ? 'a skill-testing question' : 'here') + ' to claim. ' + fmt(s.entries) + (s.entries === 1 ? ' entry' : ' entries') + ' so far.</p>' + joinSlot() + rulesBox(c);
      render(html); return;
    }
    if (m.won && m.outcome === 'pending' && m.skill_q) {
      html = '<div class="center small"><div class="me-pic">' + picHtml(m.pic, 72) + '</div><h1>You won!</h1><p class="sub">' + esc(c.prize) + '</p></div>' +
        '<div class="card skill"><p class="muted">Answer this skill-testing question to claim your prize. <b>You have one try.</b></p>' +
        '<div class="skill-q">' + esc(m.skill_q) + ' = ?</div>' +
        '<form id="sf" class="stack" novalidate><div class="field"><label for="sa">Your answer</label><input id="sa" class="code-input" inputmode="numeric" pattern="-?[0-9]*" maxlength="6" autocomplete="off" placeholder="?"></div>' +
        '<p class="err" id="se"></p><button class="btn" id="sb">Submit my answer</button></form>' +
        '<p class="muted center-text">Time left: <b id="cclock">–</b></p></div>' + rulesBox(c);
      render(html);
      var input = document.getElementById('sa');
      input.oninput = function () { input.value = input.value.replace(/[^0-9-]/g, '').slice(0, 6); };
      document.getElementById('sf').onsubmit = function (e) { e.preventDefault(); contestAnswer(); };
      return;
    }
    if (m.won && m.outcome === 'pending') {
      html = '<div class="center"><h1>You won!</h1><p class="sub">Claiming your prize...</p></div>';
      render(html); return;
    }
    var winners = (s.drawn || []).filter(function (d) { return d.outcome === 'claimed' || d.outcome === 'pending'; }).map(function (d) { return esc(d.name); });
    if (m.won && m.outcome === 'forfeit_wrong') {
      html = '<div class="verdict no"><b>Not quite</b><span>That answer wasn’t right, so the prize goes to another entrant. Thanks for playing!</span></div>';
    } else if (m.won && m.outcome === 'forfeit_time') {
      html = '<div class="verdict none"><b>Time ran out</b><span>The prize wasn’t claimed in time, so it goes to another entrant.</span></div>';
    } else {
      html = '<div class="verdict none"><b>Not this time</b><span>' + (winners.length ? 'Congrats to ' + winners.join(', ') + '!' : 'Thanks for entering!') + '</span></div>';
    }
    render(contestHead(s) + html + joinSlot() + againButton());
    wireAgain();
  }

  function updateContestClock() {
    if (!cst) return;
    var c = cst.contest, m = cst.me, now = serverNow();
    var el = document.getElementById('cclock');
    if (m && m.outcome === 'pending' && m.claim_by) {
      if (el) el.textContent = clockText(new Date(m.claim_by).getTime() - now);
    } else if (el) {
      el.textContent = clockText(new Date(c.closes_at).getTime() - now);
    }
    // The draw just reached this player's name on the TV: show the result.
    if (c.status === 'drawn' && !cRevealed && revealed(cst)) {
      cRevealed = true;
      cKey = '';
      drawContest();
      contestSounds(cst);
    }
  }

  function contestSounds(s) {
    var m = s.me, c = s.contest;
    if (!m) return;
    if (m.voucher) once(c.id + ':v', c.kind === 'giveaway' ? sfx.right : sfx.win);
    else if (m.won && m.outcome === 'pending' && revealed(s)) { once(c.id + ':won', sfx.win); buzz([80, 60, 80]); }
    else if (m.won && /^forfeit/.test(m.outcome || '')) once(c.id + ':lost', sfx.wrong);
    else if (c.status === 'drawn' && revealed(s) && !m.won) once(c.id + ':done', sfx.done);
  }

  async function contestEnter() {
    if (cSending || !cst) return;
    cSending = true;
    var btn = document.getElementById('enter'); if (btn) btn.disabled = true;
    sfx.tap(); buzz(25);
    try {
      var r = await call('contest_enter', { contest_id: game.session.id, pass: game.pass });
      if (r.status === 401) { cSending = false; player = null; viewWho(); return; }
      if (r.status !== 200) toast(r.data.error || 'Could not do that. Try again.');
      else if (r.data.reason === 'wrong_code') { cSending = false; viewCode('The code on the TV has changed. Enter the one showing now.'); return; }
      else if (r.data.error) toast(r.data.error);
    } catch (e) { toast('No internet connection. Try again.'); }
    cSending = false;
    cKey = '';
    contestPoll();
  }

  async function contestAnswer() {
    if (cSending) return;
    var input = document.getElementById('sa'), err = document.getElementById('se');
    var val = (input && input.value || '').trim();
    if (!/^-?\d{1,6}$/.test(val)) { if (err) err.textContent = 'Type your answer as a number.'; return; }
    cSending = true;
    var btn = document.getElementById('sb'); if (btn) btn.disabled = true;
    try {
      var r = await call('contest_answer', { contest_id: game.session.id, answer: val });
      if (r.status !== 200) { toast(r.data.error || 'Could not send your answer. Try again.'); if (btn) btn.disabled = false; cSending = false; return; }
    } catch (e) { toast('No internet connection. Try again.'); if (btn) btn.disabled = false; cSending = false; return; }
    cSending = false;
    cKey = '';
    contestPoll();
  }

  // ------------------------------------------------------------------ start
  async function boot() {
    await claimGuestHearts();
    var code = codeFromUrl();
    var saved = getJSON(GAME_KEY);
    if (code && saved && saved.code === code && Date.now() - saved.at < 15 * 60000) {
      game = { session: saved.session, pass: saved.pass, code: saved.code, contest: !!saved.contest };
      loading();
      await afterFind();
      return;
    }
    if (code) { start(code); return; }
    if (saved && Date.now() - saved.at < 3 * 3600000) {
      game = { session: saved.session, pass: saved.pass, code: saved.code, contest: !!saved.contest };
      loading();
      var me = await call('me', {});
      player = me.data.player || null;
      if (game.contest) {
        var cs = await call('contest_state', { contest_id: game.session.id });
        if (cs.status === 200 && cs.data.me) { applyContest(cs.data); return; }
        viewCode();
        return;
      }
      var s = await call('state', { session_id: game.session.id });
      if (s.status === 200 && s.data.me && /^(lobby|live|ended)$/.test(s.data.session.status)) { applyState(s.data); return; }
    }
    viewCode();
  }

  // Phones only allow sound after a tap: unlock on the first tap anywhere. The speaker button turns it on/off.
  ['pointerdown', 'touchend', 'click'].forEach(function (ev) { document.addEventListener(ev, unlockAudio, { passive: true }); });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#snd');
    if (!b) return;
    soundOn = !soundOn;
    try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch (x) { /* private mode */ }
    unlockAudio();
    b.classList.toggle('on', soundOn);
    b.setAttribute('aria-label', soundOn ? 'Turn sound off' : 'Turn sound on');
    b.innerHTML = speakerIcon();
    if (soundOn) setTimeout(sfx.tap, 60);
    toast(soundOn ? 'Sound on' : 'Sound off');
  });

  document.addEventListener('visibilitychange', function () {
    // Phones pause timers in the background: catch up as soon as the page is visible again.
    if (document.visibilityState === 'visible' && game && game.contest && cst) { contestPoll(); return; }
    if (document.visibilityState === 'visible' && st && st.me && /^(lobby|live)$/.test(st.session.status)) poll();
  });
  boot();
})();
