/* BarChata Arena - play on your phone (barchata.com/play and barchata.com/play/<CODE>).
 * The QR code on the TV opens this page. Members play with their BarChata account; anyone else can
 * play as a guest with a nickname. Everything goes through the arena-play edge function.
 * Plain JavaScript on purpose: the landing site is static, so there is no build step. (Oct 24, 2026)
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

  // ------------------------------------------------------------------ helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg) { var t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 3200); }
  function getJSON(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function setJSON(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function serverNow() { return Date.now() + skew; }
  function stopTimers() { clearTimeout(pollTimer); clearInterval(tickTimer); pollTimer = null; tickTimer = null; }

  function header() {
    var v = game && game.session;
    return '<div class="top"><a class="logo" href="/app"><img src="/assets/barchata-icon.png" alt=""><span>Bar<b>Chata</b></span><em class="arena-tag">ARENA</em></a>' +
      (v && v.venue_name ? '<span class="muted arena-venue">' + esc(v.venue_name) + '</span>' : '') + '</div>';
  }
  function render(html) { $app.innerHTML = header() + html; }
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
    if (r.status !== 200 || !r.data.session) { viewCode(r.data.error || 'That code doesn’t match a game right now.'); return; }
    game = { session: r.data.session, pass: r.data.pass, code: code.toUpperCase() };
    setJSON(GAME_KEY, { session_id: game.session.id, pass: game.pass, code: game.code, session: game.session, at: Date.now() });
    if (location.pathname !== '/play/' + game.code) history.replaceState({}, '', '/play/' + game.code);
    await afterFind();
  }

  async function afterFind() {
    var me = await call('me', {});
    player = me.data.player || null;
    if (!player) { viewWho(); return; }
    var s = await call('state', { session_id: game.session.id });
    if (s.status === 200 && s.data.me) { applyState(s.data); return; }
    if (s.status === 200 && s.data.session && !/^(lobby|live)$/.test(s.data.session.status)) { viewClosed(); return; }
    viewTeam();
  }

  // ------------------------------------------------------------------ who is playing
  function gameCard() {
    var v = game.session;
    var live = v.status === 'live';
    return '<div class="card arena-game"><div class="venue"><div class="img"' + (v.venue_logo ? ' style="background-image:url(\'' + esc(v.venue_logo) + '\')"' : '') + '>' + (v.venue_logo ? '' : esc((v.venue_name || 'B').charAt(0))) + '</div>' +
      '<div><div class="name">' + esc(v.title) + '</div><div class="muted">' + esc(v.venue_name || '') + ' · ' + (live ? '<b class="live-dot">Live now</b>' : 'Starting soon') + '</div></div></div></div>';
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
    render(gameCard() + '<div class="gap"></div><h1>Pick a nickname</h1><p class="sub">It shows on the TV if you play solo.</p><div class="gap"></div>' +
      '<form id="gf" class="stack" novalidate><div class="field"><label for="nick">Nickname</label>' +
      '<input id="nick" maxlength="24" autocomplete="nickname" value="' + esc(guest && guest.nickname || '') + '" placeholder="e.g. Trivia Queen"></div>' +
      '<label class="check"><input type="checkbox" id="adult"><span>I am of legal drinking age where I live.</span></label>' +
      '<p class="err" id="ge"></p><button class="btn" id="gb">Continue</button>' +
      '<button class="btn ghost" type="button" id="back">Back</button></form>' + legal());
    document.getElementById('back').onclick = viewWho;
    document.getElementById('gf').onsubmit = async function (e) {
      e.preventDefault();
      var err = document.getElementById('ge'); err.textContent = '';
      var nick = document.getElementById('nick').value.trim();
      if (nick.length < 2) { err.textContent = 'Nicknames are 2 to 24 characters.'; return; }
      if (!document.getElementById('adult').checked) { err.textContent = 'Please confirm you are of legal drinking age.'; return; }
      var btn = document.getElementById('gb'); btn.disabled = true;
      try {
        var r = await call('guest', { nickname: nick, adult: true });
        if (r.status !== 200) { err.textContent = r.data.error || 'Could not continue. Try again.'; btn.disabled = false; return; }
        setJSON(GUEST_KEY, { token: r.data.guest_token, nickname: r.data.nickname });
        player = { kind: 'guest', name: r.data.nickname };
        viewTeam();
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
      '<p class="sub">Playing as <b>' + esc(who) + '</b> · <a href="#" id="switch">' + (player && player.kind === 'member' ? 'Sign out' : 'Change') + '</a></p><div class="gap"></div>' +
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
      if (player && player.kind === 'member') { await sb.auth.signOut(); }
      player = null; viewWho();
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
    var q = s.question;
    var key = [s.session.status, s.session.current_index, q ? q.revealed : '', s.me.answer, s.teams, s.me.rank, s.me.team_points].join('|');
    if (key !== lastKey) { lastKey = key; draw(); }
    clearInterval(tickTimer);
    tickTimer = setInterval(updateClock, 250);
    updateClock();
    var delay = nextPollDelay(s);
    if (delay > 0) pollTimer = setTimeout(poll, delay);
  }

  function teamLine() {
    var m = st.me;
    var rank = m.rank && st.leaderboard.length > 1 ? ordinal(m.rank) + ' · ' : '';
    return '<div class="arena-team"><span>' + esc(m.team_name) + '</span><span>' + rank + fmt(m.team_points) + ' pts</span></div>';
  }

  function draw() {
    var s = st, q = s.question, status = s.session.status;
    if (status === 'lobby') {
      render(gameCard() + '<div class="gap"></div><div class="center small">' +
        '<div class="success">✓</div><h1>You’re in!</h1><p class="sub">Playing as <b>' + esc(s.me.team_name) + '</b></p></div>' +
        (teamCode && s.me.kind !== 'solo' ? '<div class="card team-code"><p class="muted">Your team code</p><div class="code">' + esc(teamCode) + '</div>' +
          '<p class="muted">Friends at your table pick <b>' + esc(s.me.team_name) + '</b> and enter this code to join you.</p></div>' : '') +
        '<div class="gap"></div><p class="muted center-text">Waiting for the host to start · ' + s.teams + (s.teams === 1 ? ' team' : ' teams') + ' joined</p>');
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
        html += '</div>' + (picked != null ? '<p class="muted center-text">Locked in. Waiting for the answer...</p>' : '') + teamLine();
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

  function updateClock() {
    if (!st || !st.question || st.session.status !== 'live') return;
    var q = st.question, now = serverNow();
    var opens = new Date(q.opens_at).getTime(), closes = new Date(q.closes_at).getTime();
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
    st.me.answer = i; lastKey = ''; draw();
    try {
      var r = await call('answer', { question_id: st.question.id, choice: i });
      if (r.status !== 200) { toast(r.data.error || 'Too late for that one.'); }
      else if (r.data.locked_in != null && r.data.locked_in !== i) { st.me.answer = r.data.locked_in; lastKey = ''; draw(); }
    } catch (e) { toast('No connection. Your answer may not have been sent.'); }
    sending = false;
  }

  function viewEnded() {
    stopTimers();
    var m = st.me, s = st.session;
    var top = st.leaderboard[0];
    var won = m.rank === 1;
    render('<div class="center small"><p class="muted">' + esc(s.title) + '</p><h1>' + (won ? 'You won!' : 'Game over') + '</h1>' +
      '<div class="final-rank">' + ordinal(m.rank || st.teams) + '</div><p class="sub">' + esc(m.team_name) + ' · ' + fmt(m.team_points) + ' points' + (m.rank ? ' · ' + ordinal(m.rank) + ' of ' + st.teams : '') + '</p></div>' +
      (top && !won ? '<p class="muted center-text">Winner: <b>' + esc(top.name) + '</b> with ' + fmt(top.points) + ' points</p>' : '') +
      '<div class="gap"></div>' +
      (m.is_guest
        ? '<div class="card cta"><h2>Win Hearts next time</h2><p class="sub">Create your free BarChata account to keep your scores, win Hearts at ' + esc(s.venue_name || 'this venue') + ' and get rewards.</p><div class="gap"></div><a class="btn" href="/join">Join BarChata free</a></div>'
        : '<div class="card cta"><h2>Thanks for playing</h2><p class="sub">Check in at ' + esc(s.venue_name || 'the venue') + ' in the BarChata app to earn Hearts on every visit.</p><div class="gap"></div><a class="btn secondary" href="/app">Open BarChata</a></div>') +
      '<button class="btn ghost" id="again">Join another game</button>');
    document.getElementById('again').onclick = function () { setJSON(GAME_KEY, null); history.replaceState({}, '', '/play'); viewCode(); };
  }

  function viewClosed() {
    stopTimers();
    render('<div class="center"><h1>This game has ended</h1><p class="sub">Ask staff when the next one starts, then scan the new code on the TV.</p></div>' +
      '<button class="btn" id="again">Enter a game code</button>');
    document.getElementById('again').onclick = function () { setJSON(GAME_KEY, null); history.replaceState({}, '', '/play'); viewCode(); };
  }

  // ------------------------------------------------------------------ start
  async function boot() {
    var code = codeFromUrl();
    var saved = getJSON(GAME_KEY);
    if (code && saved && saved.code === code && Date.now() - saved.at < 15 * 60000) {
      game = { session: saved.session, pass: saved.pass, code: saved.code };
      loading();
      await afterFind();
      return;
    }
    if (code) { start(code); return; }
    if (saved && Date.now() - saved.at < 3 * 3600000) {
      game = { session: saved.session, pass: saved.pass, code: saved.code };
      loading();
      var me = await call('me', {});
      player = me.data.player || null;
      var s = await call('state', { session_id: game.session.id });
      if (s.status === 200 && s.data.me && /^(lobby|live|ended)$/.test(s.data.session.status)) { applyState(s.data); return; }
    }
    viewCode();
  }

  document.addEventListener('visibilitychange', function () {
    // Phones pause timers in the background: catch up as soon as the page is visible again.
    if (document.visibilityState === 'visible' && st && st.me && /^(lobby|live)$/.test(st.session.status)) poll();
  });
  boot();
})();
