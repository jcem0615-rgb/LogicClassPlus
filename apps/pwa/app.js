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
    var user = LC.data.currentUser();
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

  /* ============================= actions =============================
     Every mutation calls LC.data, which routes to the API when a server
     is connected and to the local demo store when it is not. */

  /** Runs an operation, re-renders, and turns a rejection into a readable toast. */
  function run(promise, ok, fail) {
    return Promise.resolve(promise).then(function (result) {
      render();
      if (ok) toast('ok', ok.title, typeof ok.body === 'function' ? ok.body(result) : ok.body);
      return result;
    }).catch(function (err) {
      render();
      toast('err', (fail && fail.title) || 'That did not work', err.message);
      throw err;
    }).catch(function () { /* already reported */ });
  }

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
      var button = form.querySelector('button[type=submit]');
      if (button) { button.disabled = true; button.textContent = 'Signing in…'; }
      LC.data.login(
        document.getElementById('login-email').value,
        document.getElementById('login-password').value
      ).then(function (user) {
        location.hash = '#/dashboard';
        render();
        toast('ok', 'Signed in', 'Welcome back, ' + user.name.split(' ')[0] + '.');
      }).catch(function (err) {
        if (button) { button.disabled = false; button.textContent = 'Sign in'; }
        authError(err.message);
      });
    },
    'register': function (form, e) {
      e.preventDefault();
      LC.data.register({
        name: document.getElementById('reg-name').value,
        email: document.getElementById('reg-email').value,
        password: document.getElementById('reg-password').value,
        role: document.getElementById('reg-role').value,
        subjects: [document.getElementById('reg-subject').value]
      }).then(function (user) {
        authMode = 'login';
        render();
        modal('Account created — waiting for approval',
          '<p>Thanks, ' + esc(user.name.split(' ')[0]) + '. Your ' + esc(user.role) + ' account was created and the ' +
          'administrator has been notified.</p><p class="muted">Registrations are reviewed before the first sign-in. ' +
          'To see the approval flow now, sign in as the Owner (<span class="mono">owner@logicclass.plus</span>) and ' +
          'approve the account from the dashboard.</p>', '');
      }).catch(function (err) { authError(err.message); });
    },
    'forgot': function () {
      modal('Reset your password',
        '<label class="field">Email<input type="email" id="forgot-email" placeholder="you@school.com"></label>' +
        '<p class="small muted">The administrator approves reset requests, then a single-use link is emailed to you.</p>',
        '<button class="btn btn-primary" data-act="send-forgot">Send request</button>');
    },
    'send-forgot': function () {
      var value = document.getElementById('forgot-email').value;
      LC.data.requestPasswordReset(value).then(function () {
        closeModal();
        toast('ok', 'Request sent', 'If that address has an account, the administrator will review it.');
      });
    },
    'logout': function () {
      LC.data.logout().then(function () {
        bellOpen = false;
        location.hash = '#/dashboard';
        render();
      });
    },

    /* --- notifications --- */
    'bell': function () { bellOpen = !bellOpen; render(); },
    'mark-read': function () { run(LC.data.markNotificationsRead()); },

    /* --- admin --- */
    'approve-user': function (el) {
      var name = S.userById(el.dataset.id).name;
      run(LC.data.approveUser(el.dataset.id), { title: 'Approved', body: name + ' can sign in now.' });
    },
    'reject-user': function (el) {
      var name = S.userById(el.dataset.id).name;
      run(LC.data.rejectUser(el.dataset.id), { title: 'Registration rejected', body: name + ' was removed.' });
    },
    'toggle-suspend': function (el) { run(LC.data.toggleSuspend(el.dataset.id)); },
    'reset-approve': function (el) {
      run(LC.data.resolveReset(el.dataset.id, 'approve'), {
        title: 'Link sent', body: 'The account holder was notified.'
      });
    },
    'reset-reject': function (el) { run(LC.data.resolveReset(el.dataset.id, 'reject')); },

    /* --- classes --- */
    'create-request': function (form, e) {
      e.preventDefault();
      var when = document.getElementById('req-when').value;
      var topic = document.getElementById('req-topic').value.trim();
      if (!when || !topic) { toast('err', 'Missing details', 'Pick a time and describe the topic.'); return; }
      if (new Date(when).getTime() < Date.now()) { toast('err', 'That time has passed', 'Choose a slot in the future.'); return; }
      var teacherId = document.getElementById('req-teacher').value;
      run(LC.data.createRequest({
        teacherId: teacherId,
        subject: document.getElementById('req-subject').value,
        topic: topic,
        requestedFor: new Date(when).toISOString(),
        minutes: +document.getElementById('req-minutes').value,
        note: document.getElementById('req-note').value.trim() || undefined
      }), { title: 'Request sent', body: S.userById(teacherId).name + ' has been notified.' })
        .then(function () { form.reset(); if (LC.views.classes.mount) LC.views.classes.mount(); });
    },
    'accept-request': function (el) {
      run(LC.data.decideRequest(el.dataset.id, 'accept'), {
        title: 'Accepted', body: 'The session is on your schedule and the student was notified.'
      });
    },
    'decline-request': function (el) {
      run(LC.data.decideRequest(el.dataset.id, 'decline'), {
        title: 'Declined', body: 'The student was notified.'
      });
    },

    /* --- library --- */
    'new-folder': function () {
      modal('New folder',
        '<label class="field">Folder name<input type="text" id="fld-name" placeholder="e.g. Trigonometry"></label>' +
        '<label class="field">Subject<select id="fld-subject"><option value="math">Math</option>' +
        '<option value="english">English</option></select></label>',
        '<button class="btn btn-primary" data-act="create-folder">Create folder</button>');
    },
    'create-folder': function () {
      var name = document.getElementById('fld-name').value.trim();
      if (!name) { toast('err', 'Name it first', 'A folder needs a name.'); return; }
      var subject = document.getElementById('fld-subject').value;
      LC.data.createFolder(name, subject).then(function (folder) {
        closeModal();
        location.hash = '#/library?folder=' + folder.id;
        render();
        toast('ok', 'Folder created', name + ' is ready for uploads.');
      }).catch(function (err) { toast('err', 'Could not create the folder', err.message); });
    },
    'upload': function (el) {
      var file = el.files && el.files[0];
      if (!file) return;
      var folderId = el.dataset.folder;
      el.value = '';
      toast('ok', 'Uploading', file.name + ' · ' + F.bytes(file.size));
      run(LC.data.uploadFile(folderId, file), {
        title: 'Uploaded',
        body: file.name + ' · ' + F.bytes(file.size) + (LC.data.isRemote() ? '' : ' (demo mode — nothing left this browser)')
      }, { title: 'Upload rejected' });
    },
    'delete-resource': function (el) { run(LC.data.deleteResource(el.dataset.id)); },
    'open-resource': function (el) {
      var r = S.db.resources.find(function (x) { return x.id === el.dataset.id; });
      if (!r) return;
      LC.data.resourceUrl(r.id).then(function (result) {
        var board = S.db.boards[Object.keys(S.db.boards)[0]];
        modal(r.name,
          (r.ext === 'jpg' && board ? '<img src="' + board + '" alt="' + esc(r.name) + '" style="width:100%;border-radius:8px">' : '') +
          '<div class="panel stack">' +
          '<div class="row-between"><span class="muted">Type</span><span class="mono">.' + esc(r.ext) + '</span></div>' +
          '<div class="row-between"><span class="muted">Size</span><span class="mono">' + F.bytes(r.bytes) + '</span></div>' +
          '<div class="row-between"><span class="muted">Uploaded</span><span class="mono">' + F.dayTime(r.uploadedAt) + '</span></div>' +
          '<div class="row-between"><span class="muted">Teacher</span><span>' + esc(S.userById(r.teacherId).name) + '</span></div>' +
          '</div>' +
          (result && result.url
            ? '<a class="btn btn-primary" href="' + esc(result.url) + '" target="_blank" rel="noopener">Open file</a>' +
              '<p class="small dim">Presigned link, valid for ' + (result.expiresIn || 300) + ' seconds.</p>'
            : '<p class="small dim">' + (LC.data.isRemote()
                ? 'No object storage is configured on the server, so the bytes are on its local disk.'
                : 'Demo mode — this record has no file behind it.') + '</p>'), '');
      });
    },

    /* --- announcements --- */
    'post-announcement': function (form, e) {
      e.preventDefault();
      var title = document.getElementById('ann-title').value.trim();
      var body = document.getElementById('ann-body').value.trim();
      if (!title || !body) { toast('err', 'Fill both fields', 'An announcement needs a title and a message.'); return; }
      run(LC.data.postAnnouncement({
        title: title, body: body,
        audience: document.getElementById('ann-audience').value,
        pinned: document.getElementById('ann-pinned').value === 'yes'
      }), { title: 'Posted', body: 'Everyone in the audience was notified.' })
        .then(function () { form.reset(); });
    },
    'delete-announcement': function (el) { run(LC.data.deleteAnnouncement(el.dataset.id)); },

    /* --- attendance & payroll --- */
    'clock-in': function (el) {
      var me = LC.data.currentUser();
      LC.data.clockIn(el.dataset.id).then(function (record) {
        render();
        var late = record && record.minutesLate ? record.minutesLate : 0;
        var over = Math.max(0, late - S.PAYROLL.graceMinutes);
        toast(over > 0 ? 'warn' : 'ok', 'Clocked in',
          over > 0
            ? late + ' minutes late — a deduction of ' +
              F.money(over * S.minuteRate(me) * S.PAYROLL.latePenalty) + ' applies.'
            : 'On time, inside the ' + S.PAYROLL.graceMinutes + '-minute grace window.');
      }).catch(function (err) { toast('err', 'Could not clock in', err.message); });
    },
    'clock-out': function (el) {
      run(LC.data.clockOut(el.dataset.id), { title: 'Clocked out', body: 'This session is closed for payroll.' });
    },
    'run-payroll': function () {
      run(LC.data.runPayrollBatch(), {
        title: 'Batch generated',
        body: function (r) { return (r && r.count ? r.count : 0) + ' teachers notified.'; }
      });
    },

    /* --- billing --- */
    'pay-invoice': function (el) {
      var inv = S.db.invoices.find(function (i) { return i.id === el.dataset.id; });
      modal('Pay ' + inv.number,
        '<div class="panel stack">' + inv.lines.map(function (l) {
          return '<div class="row-between"><span class="muted">' + esc(l.label) + '</span>' +
            '<span class="mono">' + F.money(l.amount, inv.currency) + '</span></div>';
        }).join('') +
        '<div class="row-between" style="border-top:1px solid var(--line);padding-top:10px">' +
        '<b>Total</b><b class="mono">' + F.money(inv.amount, inv.currency) + '</b></div></div>' +
        '<div class="flag"><b>' + (LC.data.isRemote() ? 'Stripe keys decide what happens next' : 'Demo mode') + '</b><div>' +
        (LC.data.isRemote()
          ? 'With STRIPE_SECRET_KEY set, this creates a real PaymentIntent and the invoice is only marked paid when the ' +
            '<span class="mono">payment_intent.succeeded</span> webhook arrives. Without it the server says so rather than pretending.'
          : 'No server is connected, so this settles the invoice in your browser only.') +
        '</div></div>',
        '<button class="btn btn-primary" data-act="confirm-pay" data-id="' + inv.id + '">' +
        (LC.data.isRemote() ? 'Start payment' : 'Mark as paid') + '</button>');
    },
    'confirm-pay': function (el) {
      LC.data.payInvoice(el.dataset.id).then(function (result) {
        closeModal();
        render();
        if (result && result.mode === 'unconfigured') {
          toast('warn', 'Stripe is not configured', result.message);
        } else if (result && result.mode === 'stripe') {
          toast('ok', 'Payment started', 'A PaymentIntent was created. Stripe Elements collects the card next.');
        } else {
          toast('ok', 'Payment recorded', 'The invoice is settled.');
        }
      }).catch(function (err) { toast('err', 'Payment could not start', err.message); });
    },
    'remind-invoice': function (el) {
      var inv = S.db.invoices.find(function (i) { return i.id === el.dataset.id; });
      run(LC.data.remindInvoice(el.dataset.id), {
        title: 'Reminder sent', body: S.userById(inv.studentId).name + ' was notified.'
      });
    },

    /* --- settings --- */
    'save-profile': function (form, e) {
      e.preventDefault();
      var rate = document.getElementById('set-rate');
      run(LC.data.saveProfile({
        name: document.getElementById('set-name').value.trim() || undefined,
        locale: document.getElementById('set-locale').value,
        timezone: document.getElementById('set-tz').value.trim() || undefined,
        hourlyRate: rate ? Math.max(0, +rate.value || 0) : undefined
      }), { title: 'Profile saved', body: 'Your changes are live.' });
    },
    'connect-server': function () {
      modal('Connect to your server',
        '<label class="field">API base URL<input type="text" id="server-url" placeholder="http://localhost:4001" ' +
        'value="' + esc(LC.api.baseUrl() || 'http://localhost:4001') + '"></label>' +
        '<p class="small muted">Run <span class="mono">npm run dev</span> in the repo, then point this at the server. ' +
        'The app switches from demo data to PostgreSQL, and realtime runs over Socket.io.</p>' +
        '<div id="connect-result"></div>',
        '<button class="btn btn-primary" data-act="do-connect">Connect</button>');
    },
    'do-connect': function (el) {
      var url = document.getElementById('server-url').value.trim();
      var box = document.getElementById('connect-result');
      el.disabled = true; el.textContent = 'Checking…';
      LC.data.connect(url).then(function (info) {
        closeModal();
        bellOpen = false;
        LC.data.logout();
        render();
        toast('ok', 'Connected', 'Talking to PostgreSQL now. Sign in with a server account.' +
          (info.integrations && !info.integrations.stripe ? ' Stripe and Web Push are not configured there.' : ''));
      }).catch(function (err) {
        el.disabled = false; el.textContent = 'Connect';
        if (box) {
          box.innerHTML = '<div class="flag"><b>Could not reach that server</b><div>' + esc(err.message) +
            '<br>Check it is running and that this page\'s origin is listed in <span class="mono">WEB_ORIGIN</span>.</div></div>';
        }
      });
    },
    'disconnect-server': function () {
      LC.data.disconnect();
      bellOpen = false;
      location.hash = '#/dashboard';
      render();
      toast('ok', 'Back to demo data', 'The app is running from your browser again.');
    },
    'enable-push': function () {
      if (typeof Notification === 'undefined') { toast('err', 'Not supported', 'This browser has no Notification API.'); return; }
      Notification.requestPermission().then(function (permission) {
        if (permission !== 'granted') {
          toast('warn', 'Push not enabled', 'You can turn notifications on later in your browser settings.');
          render();
          return;
        }
        LC.data.subscribePush().then(function (result) {
          if (result.configured) {
            toast('ok', 'Push enabled', 'This browser is subscribed with the server\'s VAPID key.');
          } else if (result.reason === 'no-vapid') {
            toast('warn', 'Server has no VAPID keys', 'Run npx web-push generate-vapid-keys and set them in apps/server/.env.');
          } else {
            try { new Notification('LogicClass+', { body: 'Notifications are on for this browser.' }); } catch (e) {}
            toast('ok', 'Notifications allowed', 'Connect a server to receive real push messages.');
          }
          render();
        }).catch(function (err) { toast('err', 'Could not subscribe', err.message); });
      });
    },
    'install-pwa': function () {
      if (installPrompt) {
        installPrompt.prompt();
        installPrompt.userChoice.then(function (choice) {
          toast(choice.outcome === 'accepted' ? 'ok' : 'warn',
            choice.outcome === 'accepted' ? 'Installing' : 'Install dismissed',
            choice.outcome === 'accepted' ? 'LogicClass+ is being added to your device.' : 'You can install any time from this screen.');
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
        '<p>This restores the seeded accounts, folders, sessions and invoices in this browser, and signs you out. ' +
        'It does not touch a connected server\'s database.</p>',
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

    wireRealtime();

    // Demo data first so the first paint is never empty, then swap in server
    // state if one is configured and the stored token still works.
    render();
    LC.data.bootstrap().then(render);
  }

  /* Socket events from the server. Registered once; they survive reconnects. */
  function wireRealtime() {
    LC.api.on('notification:new', function (note) {
      S.db.notifications.unshift(note);
      toast('ok', note.title, note.body);
      render();
    });
    LC.api.on('classroom:request', function () {
      LC.data.refresh().then(render);
    });
    LC.api.on('classroom:accepted', function (session) {
      LC.data.refresh().then(function () {
        render();
        toast('ok', 'Class accepted', session.topic + ' is on your schedule.');
      });
    });
    LC.api.on('disconnect', function () {
      if (LC.data.isRemote()) toast('warn', 'Lost the server', 'Reconnecting…');
    });
  }

  LC.app = {
    render: render, toast: toast, modal: modal, closeModal: closeModal,
    interval: interval, themeLabel: themeLabel, swState: 'checking…',
    paintBell: function () { render(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
