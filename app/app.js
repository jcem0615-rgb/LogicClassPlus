/* ============================================================
   LogicClass+ — shell, router, auth, notifications, PWA
   ============================================================ */
(function () {
  var S = LC.store, F = LC.fmt, esc = LC.esc;
  var timers = [], installPrompt = null, bellOpen = false, lastRoute = '';

  var ICON = {
    home: 'M3 9.6 10 4l7 5.6V17a1 1 0 0 1-1 1h-3.5v-4.5h-5V18H4a1 1 0 0 1-1-1z',
    people: 'M7 9a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 7 9m6 0a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 13 9M2 16.4C2 13.6 4.2 11 7 11s5 2.6 5 5.4zm11.2 0c0-1.7-.5-3.2-1.4-4.3.6-.2 1.2-.3 1.8-.3 2.3 0 4.4 2 4.4 4.6z',
    video: 'M2.6 5.4h9.2a1.4 1.4 0 0 1 1.4 1.4v6.4a1.4 1.4 0 0 1-1.4 1.4H2.6a1.4 1.4 0 0 1-1.4-1.4V6.8a1.4 1.4 0 0 1 1.4-1.4M14.6 8.4 18.8 6v8l-4.2-2.4z',
    folder: 'M2.4 5.2A1.4 1.4 0 0 1 3.8 3.8h3.4l1.6 1.8h7.4a1.4 1.4 0 0 1 1.4 1.4v7.6a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4z',
    mega: 'M4 8.2v3.6H2.6A1.6 1.6 0 0 1 1 10.2V9.8a1.6 1.6 0 0 1 1.6-1.6zm1.4 0L15 4.2v11.6L5.4 11.8zm11 1.8a2.6 2.6 0 0 1-1.1 2.1V7.9A2.6 2.6 0 0 1 16.4 10',
    clock: 'M10 2.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2m.9 3.6v4l3 1.8-.8 1.3-3.7-2.2V6z',
    money: 'M3.4 4.6h13.2a1.2 1.2 0 0 1 1.2 1.2v8.4a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V5.8a1.2 1.2 0 0 1 1.2-1.2M10 7.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2',
    card: 'M2.4 6.2A1.4 1.4 0 0 1 3.8 4.8h12.4a1.4 1.4 0 0 1 1.4 1.4v.9H2.4zm0 2.9h15.2v5a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4zm2 3.1h4v1.4h-4z',
    gear: 'M8.7 2.2h2.6l.35 1.9 1.4.8 1.8-.7 1.3 2.2-1.45 1.25v1.6l1.45 1.25-1.3 2.25-1.8-.7-1.4.8-.35 1.9H8.7l-.35-1.9-1.4-.8-1.8.7L3.85 12.5 5.3 11.25v-1.6L3.85 8.4l1.3-2.2 1.8.7 1.4-.8zM10 7.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6',
    bell: 'M10 2.2c-2.7 0-4.6 2-4.6 4.6v3L4 12.4v1.1h12v-1.1l-1.4-2.6v-3c0-2.6-1.9-4.6-4.6-4.6M8.2 16.2a1.8 1.8 0 0 0 3.6 0z'
  };
  function icon(name) {
    return '<span class="ic"><svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true">' +
      '<path fill="currentColor" d="' + ICON[name] + '"/></svg></span>';
  }

  var NAV = [
    { id: 'dashboard', href: '#/dashboard', label: 'Dashboard', icon: 'home', roles: ['owner', 'teacher', 'student'] },
    { id: 'users', href: '#/users', label: 'People', icon: 'people', roles: ['owner'], group: 'Manage' },
    { id: 'classes', href: '#/classes', label: 'Classes', icon: 'video', roles: ['owner', 'teacher', 'student'], group: 'Teaching' },
    { id: 'library', href: '#/library', label: 'Library', icon: 'folder', roles: ['owner', 'teacher', 'student'] },
    { id: 'announcements', href: '#/announcements', label: 'Announcements', icon: 'mega', roles: ['owner', 'teacher', 'student'] },
    { id: 'attendance', href: '#/attendance', label: 'Attendance', icon: 'clock', roles: ['owner', 'teacher'], group: 'Money' },
    { id: 'payroll', href: '#/payroll', label: 'Payroll', icon: 'money', roles: ['owner', 'teacher'] },
    { id: 'billing', href: '#/billing', label: 'Billing', icon: 'card', roles: ['owner', 'student'] },
    { id: 'settings', href: '#/settings', label: 'Settings', icon: 'gear', roles: ['owner', 'teacher', 'student'], group: 'Account' }
  ];

  /* ============================ routing ============================ */
  function parseRoute() {
    var h = (location.hash || '#/dashboard').slice(1);
    var q = {};
    var qi = h.indexOf('?');
    if (qi > -1) {
      h.slice(qi + 1).split('&').forEach(function (kv) {
        var p = kv.split('=');
        q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
      h = h.slice(0, qi);
    }
    var parts = h.split('/').filter(Boolean);
    return { name: parts[0] || 'dashboard', params: Object.assign(q, { id: parts[1] }) };
  }

  function viewFor(route, user) {
    if (route.name === 'room') return LC.views.room;
    var v = LC.views[route.name];
    if (!v) return null;
    if (v.roles && v.roles.indexOf(user.role) === -1) return null;
    return v;
  }

  /* ============================ render ============================ */
  function render() {
    var root = document.getElementById('root');
    var user = S.currentUser();
    clearTimers();

    if (!user) { root.innerHTML = authScreen(); mountAuth(); return; }

    var route = parseRoute();
    if (lastRoute.indexOf('room') === 0 && route.name !== 'room' && LC.views.room.unmount) LC.views.room.unmount();
    lastRoute = route.name;

    var view = viewFor(route, user);
    if (!view) {
      root.innerHTML = shell(user, route, '<div class="wrap">' +
        LC.ui.empty('Not available for your role', 'Your account does not have access to that screen.') + '</div>', 'Not found', '');
      return;
    }

    var ctx = { user: user, params: route.params };
    var body = view.render(ctx);
    var sub = typeof view.sub === 'function' ? view.sub(user) : (view.sub || '');
    var title = typeof view.title === 'function' ? view.title(user) : view.title;
    root.innerHTML = shell(user, route, route.name === 'room' ? body : '<div class="wrap">' + body + '</div>', title, sub);
    if (view.mount) view.mount(ctx);
    var content = document.querySelector('.content');
    if (content) content.scrollTop = 0;
    var log = document.getElementById('chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function shell(user, route, body, title, sub) {
    var groups = {};
    var nav = NAV.filter(function (n) { return n.roles.indexOf(user.role) > -1; });
    var html = '<div class="shell"><aside class="rail">' +
      '<div class="brand"><span class="brand-mark">L</span><span class="brand-name">LogicClass<b>+</b></span></div>' +
      '<nav class="nav">';
    nav.forEach(function (n) {
      if (n.group && !groups[n.group]) { groups[n.group] = 1; html += '<div class="nav-group">' + esc(n.group) + '</div>'; }
      var count = navCount(n.id, user);
      html += '<a href="' + n.href + '" class="' + (route.name === n.id ? 'on' : '') + '">' + icon(n.icon) +
        '<span>' + esc(n.label) + '</span>' + (count ? '<span class="count mono">' + count + '</span>' : '') + '</a>';
    });
    html += '</nav><div class="rail-foot">' + LC.ui.avatar(user) +
      '<div class="who grow"><div class="n">' + esc(user.name) + '</div><div class="r">' + esc(user.role) + '</div></div>' +
      '<button class="iconbtn" data-act="logout" title="Sign out" aria-label="Sign out">' +
      '<svg width="17" height="17" viewBox="0 0 20 20"><path fill="currentColor" d="M11 3v2H5v10h6v2H3V3zm2.8 3.3 4.2 3.7-4.2 3.7-1.3-1.5 1.7-1.5H8V8.6h6.2l-1.7-1.5z"/></svg>' +
      '</button></div></aside>';

    var unread = S.unreadCount(user.id);
    html += '<main class="main">' +
      (S.isOffline() ? '<div class="offbar"><i class="dot"></i>Offline — ' + S.db.outbox.length +
        ' change' + (S.db.outbox.length === 1 ? '' : 's') + ' queued. They send as soon as you reconnect.</div>' : '') +
      '<header class="topbar"><div class="grow" style="min-width:0"><h1>' + esc(title) + '</h1>' +
      (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>' +
      '<button class="iconbtn" data-act="bell" aria-label="Notifications">' +
      '<svg width="18" height="18" viewBox="0 0 20 20"><path fill="currentColor" d="' + ICON.bell + '"/></svg>' +
      (unread ? '<span class="badge" id="bell-badge">' + unread + '</span>' : '') + '</button>' +
      '</header>' +
      (bellOpen ? bellPanel(user) : '') +
      '<div class="content">' + body + '</div></main></div>';
    return html;
  }

  function navCount(id, user) {
    if (id === 'users' && user.role === 'owner') return S.db.users.filter(function (u) { return u.status === 'pending'; }).length;
    if (id === 'classes' && user.role === 'teacher') return S.requestsFor(user).filter(function (r) { return r.status === 'pending'; }).length;
    if (id === 'billing' && user.role === 'student') return S.invoicesFor(user).filter(function (i) { return i.status === 'open'; }).length;
    return 0;
  }

  function bellPanel(user) {
    var list = S.inbox(user.id).slice(0, 12);
    return '<div class="drop" id="bell-drop"><div class="card-head" style="padding:12px 14px"><h3>Notifications</h3>' +
      '<button class="btn btn-sm btn-ghost" data-act="mark-read">Mark all read</button></div>' +
      '<div class="drop-list">' + (list.length ? list.map(function (n) {
        return '<div class="note ' + (n.read ? '' : 'unread') + '"><i class="bar"></i><div>' +
          '<div class="t">' + esc(n.title) + '</div><div class="b">' + esc(n.body) + '</div>' +
          '<div class="w">' + F.ago(n.createdAt) + ' · ' + esc(n.type) + '</div></div></div>';
      }).join('') : '<div class="empty"><p>No notifications yet.</p></div>') + '</div></div>';
  }

  /* ============================== auth ============================== */
  var authMode = 'login';
  function authScreen() {
    return '<div class="auth"><section class="auth-art"><canvas id="auth-canvas" aria-hidden="true"></canvas>' +
      '<div class="row"><span class="brand-mark" style="background:#fff;color:#0B6B62">L</span>' +
      '<span class="brand-name" style="color:#fff">LogicClass<b style="color:#8FD8CC">+</b></span></div>' +
      '<div><h2>English and Math, one student at a time.</h2>' +
      '<p class="lede">Live 1-on-1 classrooms with a shared whiteboard, PDF annotation, LaTeX and a pronunciation studio — ' +
      'plus the attendance, payroll and billing that keep a tutoring business running.</p></div>' +
      '<div class="auth-stats">' +
      '<div><div class="v mono">1:1</div><div class="k">Class format</div></div>' +
      '<div><div class="v mono">7</div><div class="k">Timezones</div></div>' +
      '<div><div class="v mono">2</div><div class="k">Subject suites</div></div>' +
      '</div></section>' +
      '<section class="auth-form"><div class="box">' +
      '<div class="tabs-line"><button data-act="auth-mode" data-mode="login" class="' + (authMode === 'login' ? 'on' : '') + '">Sign in</button>' +
      '<button data-act="auth-mode" data-mode="register" class="' + (authMode === 'register' ? 'on' : '') + '">Create account</button></div>' +
      (authMode === 'login' ? loginForm() : registerForm()) +
      '<div class="creds"><div class="eyebrow" style="margin-bottom:6px">Demo accounts — click to fill</div>' +
      [['Owner / Admin', 'owner@logicclass.plus', 'admin1234'],
       ['Teacher (Math)', 'daniel@logicclass.plus', 'teach1234'],
       ['Teacher (English)', 'hana@logicclass.plus', 'teach1234'],
       ['Student', 'amira@logicclass.plus', 'learn1234']].map(function (c) {
        return '<button data-act="fill-cred" data-email="' + c[1] + '" data-password="' + c[2] + '">' +
          '<span>' + esc(c[0]) + '</span><span>' + esc(c[1]) + '</span></button>';
      }).join('') + '</div>' +
      '</div></section></div>';
  }

  function loginForm() {
    return '<form class="stack" data-act="login">' +
      '<div><h1>Welcome back</h1><p class="small muted" style="margin-top:4px">Sign in to your classroom.</p></div>' +
      '<label class="field">Email<input type="email" id="login-email" autocomplete="username" required placeholder="you@school.com"></label>' +
      '<label class="field">Password<input type="password" id="login-password" autocomplete="current-password" required></label>' +
      '<div id="auth-error"></div>' +
      '<button class="btn btn-primary btn-block" type="submit">Sign in</button>' +
      '<button class="btn btn-ghost btn-block" type="button" data-act="forgot">Forgot your password?</button>' +
      '</form>';
  }

  function registerForm() {
    return '<form class="stack" data-act="register">' +
      '<div><h1>Create your account</h1><p class="small muted" style="margin-top:4px">Teachers and students register here. ' +
      'The administrator account is seeded and cannot be created from this form.</p></div>' +
      '<label class="field">Full name<input type="text" id="reg-name" required placeholder="Your name"></label>' +
      '<label class="field">Email<input type="email" id="reg-email" autocomplete="username" required placeholder="you@school.com"></label>' +
      '<label class="field">Password<input type="password" id="reg-password" autocomplete="new-password" required placeholder="At least 8 characters"></label>' +
      '<div class="form-grid">' +
      '<label class="field">I am a<select id="reg-role"><option value="student">Student</option><option value="teacher">Teacher</option></select></label>' +
      '<label class="field">Subject<select id="reg-subject"><option value="math">Math</option><option value="english">English</option></select></label>' +
      '</div>' +
      '<div id="auth-error"></div>' +
      '<button class="btn btn-primary btn-block" type="submit">Create account</button>' +
      '<p class="small dim">New accounts are reviewed by the administrator before the first sign-in.</p>' +
      '</form>';
  }

  /* the auth panel drawing: a parabola and a speech-like wave over a grid —
     the two subjects this platform teaches, drawn rather than decorated */
  function mountAuth() {
    var c = document.getElementById('auth-canvas');
    if (!c) return;
    var t = 0;
    function frame() {
      if (!document.getElementById('auth-canvas')) return;
      var box = c.parentElement.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(box.width * dpr)) {
        c.width = Math.round(box.width * dpr); c.height = Math.round(box.height * dpr);
      }
      var g = c.getContext('2d'), w = box.width, h = box.height;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.strokeStyle = 'rgba(255,255,255,.10)'; g.lineWidth = 1;
      for (var x = 0; x < w; x += 42) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (var y = 0; y < h; y += 42) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      // parabola
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 2;
      g.beginPath();
      for (var i = 0; i <= w; i += 4) {
        var nx = (i - w / 2) / (w / 4);
        var ny = h * 0.62 - nx * nx * h * 0.10;
        if (i === 0) g.moveTo(i, ny); else g.lineTo(i, ny);
      }
      g.stroke();
      // waveform
      g.strokeStyle = 'rgba(143,216,204,.85)'; g.lineWidth = 2;
      g.beginPath();
      for (var j = 0; j <= w; j += 3) {
        var a = Math.sin(j / 46 + t) * 16 * Math.sin(j / 190 + t / 2) + Math.sin(j / 13 + t * 1.7) * 5;
        var yy = h * 0.82 + a;
        if (j === 0) g.moveTo(j, yy); else g.lineTo(j, yy);
      }
      g.stroke();
      t += 0.02;
      requestAnimationFrame(frame);
    }
    frame();
  }

  /* ============================ helpers ============================ */
  function clearTimers() { timers.forEach(clearInterval); timers = []; }
  function interval(fn, ms) { timers.push(setInterval(fn, ms)); }

  function toast(kind, title, body) {
    var wrap = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : kind === 'err' ? 'err' : '');
    el.innerHTML = '<div class="t">' + esc(title) + '</div>' + (body ? '<div class="b">' + esc(body) + '</div>' : '');
    wrap.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 250); }, 4800);
  }

  function modal(title, bodyHtml, footHtml) {
    var host = document.getElementById('modal-host');
    host.innerHTML = '<div class="scrim" data-act="scrim"><div class="modal">' +
      '<div class="modal-head"><h2>' + esc(title) + '</h2>' +
      '<button class="iconbtn" data-act="close-modal" aria-label="Close">✕</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      (footHtml === '' ? '' : '<div class="modal-foot"><button class="btn" data-act="close-modal">Close</button>' + (footHtml || '') + '</div>') +
      '</div></div>';
  }
  function closeModal() { document.getElementById('modal-host').innerHTML = ''; }

  /* ============================== theme ============================== */
  function theme() { try { return localStorage.getItem('lc.theme') || 'system'; } catch (e) { return 'system'; } }
  function themeLabel() { var t = theme(); return t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'; }
  function applyTheme() {
    var t = theme();
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }

  /* ============================= actions ============================= */
  var actions = {
    /* --- auth --- */
    'auth-mode': function (el) { authMode = el.dataset.mode; render(); },
    'fill-cred': function (el) {
      authMode = 'login'; render();
      document.getElementById('login-email').value = el.dataset.email;
      document.getElementById('login-password').value = el.dataset.password;
    },
    'login': function (form, e) {
      e.preventDefault();
      var r = S.login(document.getElementById('login-email').value, document.getElementById('login-password').value);
      if (r.error) { authError(r.error); return; }
      location.hash = '#/dashboard';
      render();
      toast('ok', 'Signed in', 'Welcome back, ' + r.user.name.split(' ')[0] + '.');
    },
    'register': function (form, e) {
      e.preventDefault();
      var r = S.register({
        name: document.getElementById('reg-name').value,
        email: document.getElementById('reg-email').value,
        password: document.getElementById('reg-password').value,
        role: document.getElementById('reg-role').value,
        subjects: [document.getElementById('reg-subject').value]
      });
      if (r.error) { authError(r.error); return; }
      authMode = 'login';
      render();
      modal('Account created — waiting for approval',
        '<p>Thanks, ' + esc(r.user.name.split(' ')[0]) + '. Your ' + esc(r.user.role) + ' account was created and the administrator ' +
        'has been notified.</p><p class="muted">Registrations are reviewed before the first sign-in. To see the approval flow ' +
        'right now, sign in as the Owner (<span class="mono">owner@logicclass.plus / admin1234</span>) and approve yourself from ' +
        'the dashboard.</p>', '');
    },
    'forgot': function () {
      modal('Reset your password',
        '<label class="field">Email<input type="email" id="forgot-email" placeholder="you@school.com"></label>' +
        '<p class="small muted">The administrator approves reset requests, then a single-use link is emailed to you.</p>',
        '<button class="btn btn-primary" data-act="send-forgot">Send request</button>');
    },
    'send-forgot': function () {
      var v = document.getElementById('forgot-email').value;
      S.requestPasswordReset(v);
      closeModal();
      toast('ok', 'Request sent', 'If that address has an account, the administrator will review it.');
    },
    'logout': function () { S.logout(); bellOpen = false; location.hash = '#/dashboard'; render(); },

    /* --- notifications --- */
    'bell': function () { bellOpen = !bellOpen; render(); },
    'mark-read': function () { var u = S.currentUser(); S.markAllRead(u.id); render(); },

    /* --- admin --- */
    'approve-user': function (el) {
      var id = el.dataset.id;
      S.commit('user:approve:' + id, function (d) {
        var u = d.users.find(function (x) { return x.id === id; });
        if (u) { u.status = 'active'; S.notify(u.id, 'account', 'Your account is approved', 'You can sign in and start using LogicClass+.'); }
      });
      toast('ok', 'Approved', S.userById(id).name + ' can sign in now.');
      render();
    },
    'reject-user': function (el) {
      var id = el.dataset.id, name = S.userById(id).name;
      S.commit('user:reject:' + id, function (d) { d.users = d.users.filter(function (x) { return x.id !== id; }); });
      toast('warn', 'Registration rejected', name + ' was removed.');
      render();
    },
    'toggle-suspend': function (el) {
      var id = el.dataset.id;
      S.commit('user:suspend:' + id, function (d) {
        var u = d.users.find(function (x) { return x.id === id; });
        if (u) u.status = u.status === 'suspended' ? 'active' : 'suspended';
      });
      render();
    },
    'reset-approve': function (el) {
      var id = el.dataset.id;
      S.commit('reset:approve:' + id, function (d) {
        var r = d.resets.find(function (x) { return x.id === id; });
        if (r) { r.status = 'approved'; S.notify(r.userId, 'password', 'Reset link sent', 'Check your inbox — the link works once and expires in 30 minutes.'); }
      });
      toast('ok', 'Link sent', 'The account holder was notified.');
      render();
    },
    'reset-reject': function (el) {
      var id = el.dataset.id;
      S.commit('reset:reject:' + id, function (d) {
        var r = d.resets.find(function (x) { return x.id === id; });
        if (r) r.status = 'rejected';
      });
      render();
    },

    /* --- classes --- */
    'create-request': function (form, e) {
      e.preventDefault();
      var me = S.currentUser();
      var when = document.getElementById('req-when').value;
      var topic = document.getElementById('req-topic').value.trim();
      if (!when || !topic) { toast('err', 'Missing details', 'Pick a time and describe the topic.'); return; }
      if (new Date(when).getTime() < Date.now()) { toast('err', 'That time has passed', 'Choose a slot in the future.'); return; }
      var teacherId = document.getElementById('req-teacher').value;
      var req = {
        id: S.uid('req'), studentId: me.id, teacherId: teacherId,
        subject: document.getElementById('req-subject').value,
        topic: topic, requestedFor: new Date(when).toISOString(),
        minutes: +document.getElementById('req-minutes').value,
        status: 'pending', note: document.getElementById('req-note').value.trim(),
        createdAt: S.iso(Date.now())
      };
      S.commit('request:create', function (d) {
        d.requests.unshift(req);
        S.notify(teacherId, 'class_request', 'New class request',
          me.name + ' requested ' + req.subject + ' — ' + req.topic + '.');
      });
      form.reset();
      toast('ok', 'Request sent', S.userById(teacherId).name + ' has been notified.');
      render();
    },
    'accept-request': function (el) {
      var id = el.dataset.id;
      S.commit('request:accept:' + id, function (d) {
        var r = d.requests.find(function (x) { return x.id === id; });
        if (!r) return;
        r.status = 'accepted';
        var ses = {
          id: S.uid('ses'), requestId: r.id, teacherId: r.teacherId, studentId: r.studentId,
          subject: r.subject, topic: r.topic, startsAt: r.requestedFor, minutes: r.minutes,
          status: 'scheduled', recordingUrl: null
        };
        d.sessions.push(ses);
        S.notify(r.studentId, 'session', 'Class accepted',
          S.userById(r.teacherId).name + ' accepted “' + r.topic + '” for ' + F.dayTime(r.requestedFor) + '.');
      });
      toast('ok', 'Accepted', 'The session is on your schedule and the student was notified.');
      render();
    },
    'decline-request': function (el) {
      var id = el.dataset.id;
      S.commit('request:decline:' + id, function (d) {
        var r = d.requests.find(function (x) { return x.id === id; });
        if (!r) return;
        r.status = 'declined';
        S.notify(r.studentId, 'session', 'Class request declined',
          'Try another time slot, or a different teacher.');
      });
      toast('warn', 'Declined', 'The student was notified.');
      render();
    },

    /* --- library --- */
    'new-folder': function () {
      modal('New folder',
        '<label class="field">Folder name<input type="text" id="fld-name" placeholder="e.g. Trigonometry"></label>' +
        '<label class="field">Subject<select id="fld-subject"><option value="math">Math</option><option value="english">English</option></select></label>',
        '<button class="btn btn-primary" data-act="create-folder">Create folder</button>');
    },
    'create-folder': function () {
      var name = document.getElementById('fld-name').value.trim();
      if (!name) { toast('err', 'Name it first', 'A folder needs a name.'); return; }
      var me = S.currentUser();
      var id = S.uid('fld');
      S.commit('folder:create', function (d) {
        d.folders.push({ id: id, teacherId: me.id, name: name, subject: document.getElementById('fld-subject').value, createdAt: S.iso(Date.now()) });
      });
      closeModal();
      location.hash = '#/library?folder=' + id;
      render();
      toast('ok', 'Folder created', name + ' is ready for uploads.');
    },
    'upload': function (el) {
      var file = el.files && el.files[0];
      if (!file) return;
      var v = S.validateUpload(file);
      if (!v.ok) { toast('err', 'Upload rejected', v.message); el.value = ''; return; }
      var me = S.currentUser();
      S.commit('resource:upload', function (d) {
        d.resources.push({
          id: S.uid('res'), folderId: el.dataset.folder, teacherId: me.id,
          name: file.name, ext: v.ext, bytes: file.size, uploadedAt: S.iso(Date.now())
        });
      });
      el.value = '';
      toast('ok', 'Uploaded', file.name + ' · ' + F.bytes(file.size) + '. A presigned S3 PUT would carry the bytes.');
      render();
    },
    'delete-resource': function (el) {
      var id = el.dataset.id;
      S.commit('resource:delete:' + id, function (d) { d.resources = d.resources.filter(function (r) { return r.id !== id; }); });
      render();
    },
    'open-resource': function (el) {
      var r = S.db.resources.find(function (x) { return x.id === el.dataset.id; });
      var board = S.db.boards[Object.keys(S.db.boards)[0]];
      modal(r.name,
        (r.ext === 'jpg' && board ? '<img src="' + board + '" alt="' + esc(r.name) + '" style="width:100%;border-radius:8px">' : '') +
        '<div class="panel stack"><div class="row-between"><span class="muted">Type</span><span class="mono">.' + esc(r.ext) + '</span></div>' +
        '<div class="row-between"><span class="muted">Size</span><span class="mono">' + F.bytes(r.bytes) + '</span></div>' +
        '<div class="row-between"><span class="muted">Uploaded</span><span class="mono">' + F.dayTime(r.uploadedAt) + '</span></div>' +
        '<div class="row-between"><span class="muted">Teacher</span><span>' + esc(S.userById(r.teacherId).name) + '</span></div></div>' +
        '<p class="small dim">In production this opens through a short-lived presigned S3 URL scoped to your account.</p>', '');
    },

    /* --- announcements --- */
    'post-announcement': function (form, e) {
      e.preventDefault();
      var me = S.currentUser();
      var title = document.getElementById('ann-title').value.trim();
      var body = document.getElementById('ann-body').value.trim();
      if (!title || !body) { toast('err', 'Fill both fields', 'An announcement needs a title and a message.'); return; }
      S.commit('announcement:create', function (d) {
        d.announcements.unshift({
          id: S.uid('ann'), authorId: me.id, title: title, body: body,
          audience: document.getElementById('ann-audience').value,
          pinned: document.getElementById('ann-pinned').value === 'yes',
          createdAt: S.iso(Date.now())
        });
        var aud = document.getElementById('ann-audience').value;
        d.users.forEach(function (u) {
          if (u.id === me.id) return;
          if (aud === 'all' || (aud === 'teachers' && u.role === 'teacher') || (aud === 'students' && u.role === 'student')) {
            S.notify(u.id, 'announcement', title, body.slice(0, 90));
          }
        });
      });
      form.reset();
      toast('ok', 'Posted', 'Everyone in the audience was notified.');
      render();
    },
    'delete-announcement': function (el) {
      var id = el.dataset.id;
      S.commit('announcement:delete:' + id, function (d) { d.announcements = d.announcements.filter(function (a) { return a.id !== id; }); });
      render();
    },

    /* --- attendance & payroll --- */
    'clock-in': function (el) {
      var sesId = el.dataset.id;
      var me = S.currentUser();
      var ses = S.db.sessions.find(function (s) { return s.id === sesId; });
      var late = Math.max(0, Math.round((Date.now() - new Date(ses.startsAt).getTime()) / 60000));
      S.commit('attendance:in:' + sesId, function (d) {
        d.attendance.unshift({
          id: S.uid('att'), teacherId: me.id, sessionId: sesId, scheduledStart: ses.startsAt,
          clockIn: S.iso(Date.now()), clockOut: null, minutesLate: late
        });
      });
      toast(late > S.PAYROLL.graceMinutes ? 'warn' : 'ok', 'Clocked in',
        late > S.PAYROLL.graceMinutes
          ? late + ' minutes late — a deduction of ' + F.money(Math.max(0, late - S.PAYROLL.graceMinutes) * S.minuteRate(me) * S.PAYROLL.latePenalty) + ' applies.'
          : 'On time, inside the ' + S.PAYROLL.graceMinutes + '-minute grace window.');
      render();
    },
    'clock-out': function (el) {
      var id = el.dataset.id;
      S.commit('attendance:out:' + id, function (d) {
        var a = d.attendance.find(function (x) { return x.id === id; });
        if (a) a.clockOut = S.iso(Date.now());
      });
      toast('ok', 'Clocked out', 'This session is closed for payroll.');
      render();
    },
    'run-payroll': function () {
      var to = Date.now(), from = to - 30 * 864e5;
      var lines = S.payrollRun(from, to);
      S.commit('payroll:run', function (d) {
        d.payroll.push({
          id: S.uid('pay'), periodStart: S.iso(from), periodEnd: S.iso(to),
          status: 'approved', approvedBy: S.currentUser().id, createdAt: S.iso(Date.now()), lines: lines
        });
        lines.forEach(function (l) {
          S.notify(l.teacherId, 'payroll', 'Payroll approved',
            F.money(l.net) + ' for ' + (l.minutes / 60).toFixed(1) + ' hours' +
            (l.deductions > 0 ? ', after ' + F.money(l.deductions) + ' in deductions' : '') + '.');
        });
      });
      toast('ok', 'Batch generated', lines.length + ' teachers notified.');
      render();
    },

    /* --- billing --- */
    'pay-invoice': function (el) {
      var id = el.dataset.id;
      var inv = S.db.invoices.find(function (i) { return i.id === id; });
      modal('Pay ' + inv.number,
        '<div class="panel stack">' + inv.lines.map(function (l) {
          return '<div class="row-between"><span class="muted">' + esc(l.label) + '</span><span class="mono">' + F.money(l.amount, inv.currency) + '</span></div>';
        }).join('') + '<div class="row-between" style="border-top:1px solid var(--line);padding-top:10px">' +
        '<b>Total</b><b class="mono">' + F.money(inv.amount, inv.currency) + '</b></div></div>' +
        '<div class="flag"><b>Test mode</b><div>No card is collected here. In production this hands off to Stripe Checkout, ' +
        'and the invoice flips to paid when the <span class="mono">payment_intent.succeeded</span> webhook arrives.</div></div>',
        '<button class="btn btn-primary" data-act="confirm-pay" data-id="' + id + '">Mark as paid</button>');
    },
    'confirm-pay': function (el) {
      var id = el.dataset.id;
      S.commit('invoice:pay:' + id, function (d) {
        var i = d.invoices.find(function (x) { return x.id === id; });
        if (i) { i.status = 'paid'; i.paidAt = S.iso(Date.now()); }
        S.notify('usr_owner', 'billing', 'Invoice paid', i.number + ' · ' + F.money(i.amount, i.currency));
      });
      closeModal();
      toast('ok', 'Payment recorded', 'The invoice is settled.');
      render();
    },
    'remind-invoice': function (el) {
      var inv = S.db.invoices.find(function (i) { return i.id === el.dataset.id; });
      S.notify(inv.studentId, 'billing', 'Payment reminder',
        inv.number + ' · ' + F.money(inv.amount, inv.currency) + ' is due ' + F.day(inv.dueAt) + '.');
      toast('ok', 'Reminder sent', S.userById(inv.studentId).name + ' was notified.');
      render();
    },

    /* --- settings --- */
    'save-profile': function (form, e) {
      e.preventDefault();
      var me = S.currentUser();
      var rate = document.getElementById('set-rate');
      S.commit('profile:save', function (d) {
        var u = d.users.find(function (x) { return x.id === me.id; });
        u.name = document.getElementById('set-name').value.trim() || u.name;
        u.locale = document.getElementById('set-locale').value;
        u.tz = document.getElementById('set-tz').value.trim() || u.tz;
        if (rate) u.hourlyRate = Math.max(0, +rate.value || 0);
      });
      toast('ok', 'Profile saved', 'Your changes are live.');
      render();
    },
    'enable-push': function () {
      if (typeof Notification === 'undefined') { toast('err', 'Not supported', 'This browser has no Notification API.'); return; }
      Notification.requestPermission().then(function (p) {
        if (p === 'granted') {
          S.db.pushEnabled = true; S.save();
          try { new Notification('LogicClass+', { body: 'Push is on. Class requests and reminders will reach you here.' }); } catch (e) {}
          toast('ok', 'Push enabled', 'Production subscribes this browser with your VAPID public key.');
        } else {
          toast('warn', 'Push not enabled', 'You can turn notifications on later from your browser settings.');
        }
        render();
      });
    },
    'install-pwa': function () {
      if (installPrompt) {
        installPrompt.prompt();
        installPrompt.userChoice.then(function (c) {
          toast(c.outcome === 'accepted' ? 'ok' : 'warn',
            c.outcome === 'accepted' ? 'Installing' : 'Install dismissed',
            c.outcome === 'accepted' ? 'LogicClass+ is being added to your device.' : 'You can install any time from this screen.');
          installPrompt = null;
        });
      } else {
        modal('Install LogicClass+',
          '<p>Your browser has not offered an install prompt for this page yet.</p>' +
          '<ul class="muted"><li><b>iOS Safari</b> — Share, then “Add to Home Screen”.</li>' +
          '<li><b>Chrome / Edge</b> — the install icon at the right of the address bar.</li>' +
          '<li><b>In an embedded preview</b> — open the page in its own tab first; installation is blocked inside a frame.</li></ul>', '');
      }
    },
    'toggle-offline': function () {
      var goingOffline = !S.isOffline();
      S.setForcedOffline(goingOffline);
      if (!goingOffline) {
        var n = S.flush();
        toast('ok', 'Back online', n ? n + ' queued change' + (n === 1 ? '' : 's') + ' sent.' : 'Nothing was queued.');
      } else {
        toast('warn', 'Offline mode', 'Changes are queued in the outbox until you reconnect.');
      }
      render();
    },
    'cycle-theme': function () {
      var order = ['system', 'light', 'dark'];
      var next = order[(order.indexOf(theme()) + 1) % 3];
      try { localStorage.setItem('lc.theme', next); } catch (e) {}
      applyTheme();
      render();
    },
    'reset-data': function () {
      modal('Reset demo data?',
        '<p>This restores the seeded accounts, folders, sessions and invoices, and signs you out. Anything you changed in this ' +
        'browser is discarded.</p>',
        '<button class="btn btn-danger" data-act="confirm-reset">Reset everything</button>');
    },
    'confirm-reset': function () {
      S.reset();
      closeModal();
      location.hash = '#/dashboard';
      render();
      toast('ok', 'Demo data restored', 'Sign in again with any of the demo accounts.');
    },

    /* --- modal --- */
    'close-modal': function () { closeModal(); },
    'scrim': function (el, e) { if (e.target === el) closeModal(); }
  };

  function authError(msg) {
    var box = document.getElementById('auth-error');
    if (box) box.innerHTML = '<div class="flag"><b>Cannot continue</b><div>' + esc(msg) + '</div></div>';
  }

  function dispatch(e, type) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.dataset.act;
    var fn = actions[act] || (LC.roomActions && LC.roomActions[act]);
    if (!fn) return;
    var isForm = el.tagName === 'FORM';
    if (type === 'submit' && !isForm) return;
    if (type === 'click' && (isForm || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
    if (type === 'change' && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') return;
    fn(el, e);
  }

  /* ============================== boot ============================== */
  function boot() {
    S.load();
    applyTheme();
    document.addEventListener('click', function (e) {
      // close the bell when clicking outside it
      if (bellOpen && !e.target.closest('#bell-drop') && !e.target.closest('[data-act="bell"]')) {
        bellOpen = false; render(); return;
      }
      dispatch(e, 'click');
    });
    document.addEventListener('submit', function (e) { dispatch(e, 'submit'); });
    document.addEventListener('change', function (e) { dispatch(e, 'change'); });
    document.addEventListener('input', function (e) {
      var el = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el) return;
      if (el.dataset.act === 'eq-input' || el.dataset.act === 'board-width') dispatch(e, 'change');
    });
    window.addEventListener('hashchange', function () { bellOpen = false; render(); });
    window.addEventListener('resize', function () { if (LC.roomRepaintPeer) LC.roomRepaintPeer(); });
    window.addEventListener('online', function () {
      var n = S.flush();
      toast('ok', 'Back online', n ? n + ' queued change' + (n === 1 ? '' : 's') + ' sent.' : 'Connection restored.');
      render();
    });
    window.addEventListener('offline', function () { toast('warn', 'You are offline', 'Changes will be queued until you reconnect.'); render(); });
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installPrompt = e; });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then(function () {
        LC.app.swState = 'registered';
      }).catch(function (err) {
        LC.app.swState = 'unavailable in this preview (' + (err && err.name || 'error') + ')';
      });
    } else {
      LC.app.swState = 'not supported by this browser';
    }

    render();
  }

  LC.app = {
    render: render, toast: toast, modal: modal, closeModal: closeModal,
    interval: interval, themeLabel: themeLabel, swState: 'checking…',
    paintBell: function () { render(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
