/* ============================================================
   LogicClass+ — screens
   Every view returns an HTML string; interactive elements carry
   data-act and are dispatched by the delegate in app.js.
   ============================================================ */
(function () {
  var S = LC.store, F = LC.fmt, esc = LC.esc;

  /* ------------------------- shared bits ------------------------- */
  function avatar(user, cls) {
    return '<span class="avatar ' + (cls || '') + '">' + esc(F.initials(user.name)) + '</span>';
  }
  function subjectPill(subject) {
    return subject === 'math'
      ? '<span class="pill pill-math">Math</span>'
      : '<span class="pill pill-english">English</span>';
  }
  function statusPill(status) {
    var map = {
      active: ['ok', 'Active'], pending: ['warn', 'Pending'], suspended: ['crit', 'Suspended'],
      scheduled: ['neutral', 'Scheduled'], live: ['ok', 'Live'], completed: ['neutral', 'Completed'],
      no_show: ['crit', 'No-show'], accepted: ['ok', 'Accepted'], declined: ['crit', 'Declined'],
      paid: ['ok', 'Paid'], open: ['warn', 'Open'], void: ['neutral', 'Void'], draft: ['neutral', 'Draft'],
      approved: ['ok', 'Approved'], rejected: ['crit', 'Rejected']
    };
    var m = map[status] || ['neutral', status];
    return '<span class="pill pill-' + m[0] + '"><i class="dot"></i>' + m[1] + '</span>';
  }
  function summary(items) {
    return '<div class="summary">' + items.map(function (i) {
      return '<div><span class="k">' + esc(i.k) + '</span><span class="v">' + i.v + '</span>' +
             (i.s ? '<span class="s">' + i.s + '</span>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function empty(title, body) {
    return '<div class="empty"><h3>' + esc(title) + '</h3><p>' + esc(body) + '</p></div>';
  }
  function card(title, bodyHtml, actionsHtml) {
    return '<section class="card"><div class="card-head"><h2>' + esc(title) + '</h2>' +
      (actionsHtml ? '<div class="row">' + actionsHtml + '</div>' : '') + '</div>' + bodyHtml + '</section>';
  }

  function sessionsToday(user) {
    var start = new Date(); start.setHours(0, 0, 0, 0);
    var end = new Date(start.getTime() + 864e5);
    return S.sessionsFor(user).filter(function (s) {
      var t = new Date(s.startsAt);
      return t >= start && t < end;
    });
  }
  function nextSession(user) {
    return S.sessionsFor(user)
      .filter(function (s) { return s.status === 'scheduled' && new Date(s.startsAt).getTime() > Date.now() - 15 * 60e3; })
      .sort(function (a, b) { return new Date(a.startsAt) - new Date(b.startsAt); })[0];
  }
  function joinable(ses) {
    var diff = new Date(ses.startsAt).getTime() - Date.now();
    return ses.status === 'live' || (ses.status === 'scheduled' && diff < 6 * 3600e3);
  }

  /* ============================ DASHBOARD ============================ */
  var dashboard = {
    title: 'Dashboard',
    sub: function (u) { return 'Signed in as ' + u.role + ' · ' + (u.tz || 'UTC'); },
    render: function (ctx) {
      var u = ctx.user;
      if (u.role === 'owner') return ownerHome();
      if (u.role === 'teacher') return teacherHome(u);
      return studentHome(u);
    }
  };

  function ownerHome() {
    var d = S.db;
    var pendingUsers = d.users.filter(function (x) { return x.status === 'pending'; });
    var openInv = d.invoices.filter(function (i) { return i.status === 'open'; });
    var openTotal = openInv.reduce(function (a, i) { return a + i.amount; }, 0);
    var paidMonth = d.invoices.filter(function (i) { return i.status === 'paid'; })
      .reduce(function (a, i) { return a + i.amount; }, 0);
    var todays = d.sessions.filter(function (s) {
      var t = new Date(s.startsAt); var n = new Date();
      return t.toDateString() === n.toDateString();
    });
    var resets = d.resets.filter(function (r) { return r.status === 'pending'; });

    var out = summary([
      { k: 'Active users', v: d.users.filter(function (x) { return x.status === 'active'; }).length,
        s: d.users.filter(function (x) { return x.role === 'teacher' && x.status === 'active'; }).length + ' teachers · ' +
           d.users.filter(function (x) { return x.role === 'student' && x.status === 'active'; }).length + ' students' },
      { k: 'Awaiting approval', v: pendingUsers.length, s: pendingUsers.length ? 'Needs your decision' : 'Queue clear' },
      { k: 'Sessions today', v: todays.length, s: 'across all teachers' },
      { k: 'Open invoices', v: F.money(openTotal), s: openInv.length + ' unpaid' },
      { k: 'Collected', v: F.money(paidMonth), s: 'lifetime, paid' }
    ]);

    out += '<div class="split-3">';
    out += card('Registrations awaiting approval',
      pendingUsers.length
        ? '<div class="list-rows">' + pendingUsers.map(function (p) {
            return '<div class="row-between"><div class="row">' + avatar(p, 'avatar-lg') +
              '<div><div style="font-weight:600">' + esc(p.name) + '</div>' +
              '<div class="small dim">' + esc(p.email) + ' · ' + esc(p.role) + ' · joined ' + F.ago(p.joinedAt) + '</div></div></div>' +
              '<div class="row"><button class="btn btn-sm" data-act="reject-user" data-id="' + p.id + '">Reject</button>' +
              '<button class="btn btn-sm btn-primary" data-act="approve-user" data-id="' + p.id + '">Approve</button></div></div>';
          }).join('') + '</div>'
        : empty('Nothing waiting', 'Every registration has been reviewed.'),
      '<a class="btn btn-sm" href="#/users">All users</a>');

    out += card('Password reset queue',
      resets.length
        ? '<div class="list-rows">' + resets.map(function (r) {
            return '<div class="row-between"><div><div style="font-weight:600">' + esc(S.userById(r.userId).name) + '</div>' +
              '<div class="small dim">' + esc(r.email) + ' · ' + F.ago(r.requestedAt) + '</div></div>' +
              '<div class="row"><button class="btn btn-sm" data-act="reset-reject" data-id="' + r.id + '">Reject</button>' +
              '<button class="btn btn-sm btn-primary" data-act="reset-approve" data-id="' + r.id + '">Send link</button></div></div>';
          }).join('') + '</div>'
        : empty('No requests', 'Reset requests appear here for approval.'));
    out += '</div>';

    out += card('Every session today',
      todays.length
        ? '<div class="card-body"><div class="tl">' + todays.sort(function (a, b) { return new Date(a.startsAt) - new Date(b.startsAt); })
            .map(function (s) { return timelineItem(s, 'owner'); }).join('') + '</div></div>'
        : empty('No classes today', 'The schedule is clear.'));
    return out;
  }

  function teacherHome(u) {
    var today = sessionsToday(u);
    var mine = S.sessionsFor(u);
    var pending = S.requestsFor(u).filter(function (r) { return r.status === 'pending'; });
    var weekAgo = Date.now() - 7 * 864e5;
    var weekSessions = mine.filter(function (s) { return s.status === 'completed' && new Date(s.startsAt).getTime() > weekAgo; });
    var weekMinutes = weekSessions.reduce(function (a, s) { return a + s.minutes; }, 0);
    var att = S.db.attendance.filter(function (a) { return a.teacherId === u.id; });
    var onTime = att.filter(function (a) { return !a.noShow && (a.minutesLate || 0) <= S.PAYROLL.graceMinutes; }).length;
    var rate = att.length ? Math.round(onTime / att.length * 100) : 100;
    var line = S.payrollLine(u, Date.now() - 30 * 864e5, Date.now());

    var out = summary([
      { k: 'Classes today', v: today.length, s: today.length ? 'next ' + (nextSession(u) ? F.time(nextSession(u).startsAt) : '—') : 'nothing scheduled' },
      { k: 'Taught this week', v: (weekMinutes / 60).toFixed(1) + 'h', s: weekSessions.length + ' sessions' },
      { k: 'On-time rate', v: rate + '%', s: S.PAYROLL.graceMinutes + ' min grace window' },
      { k: 'Earned, 30 days', v: F.money(line.net), s: line.deductions > 0 ? F.money(line.deductions) + ' deducted' : 'no deductions' },
      { k: 'Requests waiting', v: pending.length, s: pending.length ? 'reply today' : 'all answered' }
    ]);

    out += '<div class="split-3">';
    out += card('Your teaching day',
      today.length
        ? '<div class="card-body"><div class="tl">' + today.sort(function (a, b) { return new Date(a.startsAt) - new Date(b.startsAt); })
            .map(function (s) { return timelineItem(s, 'teacher'); }).join('') + '</div></div>'
        : empty('No classes today', 'Accepted requests land here automatically.'),
      '<a class="btn btn-sm" href="#/classes">All classes</a>');

    out += card('Class requests',
      pending.length
        ? '<div class="list-rows">' + pending.map(function (r) { return requestRow(r, 'teacher'); }).join('') + '</div>'
        : empty('Inbox clear', 'New requests notify you instantly.'));
    out += '</div>';

    out += announcementsCard(u, 2);
    return out;
  }

  function studentHome(u) {
    var next = nextSession(u);
    var mine = S.sessionsFor(u);
    var done = mine.filter(function (s) { return s.status === 'completed'; });
    var minutes = done.reduce(function (a, s) { return a + s.minutes; }, 0);
    var open = S.invoicesFor(u).filter(function (i) { return i.status === 'open'; });
    var due = open.reduce(function (a, i) { return a + i.amount; }, 0);
    var pending = S.requestsFor(u).filter(function (r) { return r.status === 'pending'; });

    var out = summary([
      { k: 'Next class', v: next ? F.time(next.startsAt) : '—', s: next ? F.day(next.startsAt) + ' · ' + esc(S.userById(next.teacherId).name) : 'none booked' },
      { k: 'Hours studied', v: (minutes / 60).toFixed(1) + 'h', s: done.length + ' classes finished' },
      { k: 'Balance due', v: F.money(due), s: open.length ? open.length + ' open invoice' + (open.length > 1 ? 's' : '') : 'nothing owing' },
      { k: 'Requests pending', v: pending.length, s: pending.length ? 'waiting on a teacher' : 'all answered' }
    ]);

    if (next) {
      out += '<section class="card"><div class="card-head"><div>' +
        '<span class="eyebrow">Your next class</span><h2 style="margin-top:4px">' + esc(next.topic) + '</h2></div>' +
        subjectPill(next.subject) + '</div><div class="card-body row-between">' +
        '<div class="row">' + avatar(S.userById(next.teacherId), 'avatar-lg') +
        '<div><div style="font-weight:600">' + esc(S.userById(next.teacherId).name) + '</div>' +
        '<div class="small dim mono">' + F.dayTime(next.startsAt) + ' · ' + next.minutes + ' min · ' + F.ago(next.startsAt) + '</div></div></div>' +
        '<a class="btn btn-primary" href="#/room/' + next.id + '">Enter classroom</a>' +
        '</div></section>';
    }

    out += '<div class="split-3">';
    out += card('Your requests',
      S.requestsFor(u).length
        ? '<div class="list-rows">' + S.requestsFor(u).slice(0, 5).map(function (r) { return requestRow(r, 'student'); }).join('') + '</div>'
        : empty('No requests yet', 'Ask a teacher for a class from the Classes screen.'),
      '<a class="btn btn-sm btn-primary" href="#/classes">Request a class</a>');
    out += announcementsCard(u, 3);
    out += '</div>';
    return out;
  }

  function timelineItem(s, as) {
    var other = as === 'teacher' ? S.userById(s.studentId) : S.userById(s.teacherId);
    var who = as === 'owner'
      ? esc(S.userById(s.teacherId).name) + ' → ' + esc(S.userById(s.studentId).name)
      : esc(other.name);
    return '<div class="tl-item" data-subject="' + s.subject + '">' +
      '<div class="tl-time mono">' + F.time(s.startsAt) + '<span>' + s.minutes + ' min</span></div>' +
      '<div class="tl-body"><div class="row-between"><div>' +
      '<div style="font-weight:600">' + esc(s.topic) + '</div>' +
      '<div class="small dim">' + who + ' · ' + esc(other.tz || '') + '</div></div>' +
      '<div class="row">' + statusPill(s.status) +
      (joinable(s) && as !== 'owner' ? '<a class="btn btn-sm btn-primary" href="#/room/' + s.id + '">Join</a>' : '') +
      '</div></div></div></div>';
  }

  function requestRow(r, as) {
    var who = as === 'teacher' ? S.userById(r.studentId) : S.userById(r.teacherId);
    var actions = '';
    if (as === 'teacher' && r.status === 'pending') {
      actions = '<button class="btn btn-sm" data-act="decline-request" data-id="' + r.id + '">Decline</button>' +
                '<button class="btn btn-sm btn-primary" data-act="accept-request" data-id="' + r.id + '">Accept</button>';
    } else {
      actions = statusPill(r.status);
    }
    return '<div class="row-between"><div class="row" style="min-width:0">' + avatar(who) +
      '<div style="min-width:0"><div style="font-weight:600">' + esc(r.topic) + '</div>' +
      '<div class="small dim">' + esc(who.name) + ' · ' + F.dayTime(r.requestedFor) + ' · ' + r.minutes + ' min</div>' +
      (r.note ? '<div class="small muted" style="margin-top:3px">“' + esc(r.note) + '”</div>' : '') +
      '</div></div><div class="row">' + subjectPill(r.subject) + actions + '</div></div>';
  }

  function announcementsCard(u, limit) {
    var list = S.db.announcements.filter(function (a) {
      return a.audience === 'all' || (a.audience === 'teachers' && u.role !== 'student') || (a.audience === 'students' && u.role !== 'teacher');
    }).sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.createdAt) - new Date(a.createdAt); })
      .slice(0, limit);
    return card('Announcements',
      list.length
        ? '<div class="list-rows">' + list.map(function (a) {
            return '<div><div class="row-between"><div style="font-weight:600">' +
              (a.pinned ? '<span class="pill pill-warn" style="margin-right:6px">Pinned</span>' : '') + esc(a.title) + '</div>' +
              '<span class="small dim mono">' + F.ago(a.createdAt) + '</span></div>' +
              '<p class="small muted" style="margin-top:4px">' + esc(a.body) + '</p></div>';
          }).join('') + '</div>'
        : empty('Nothing posted', 'Announcements from the admin show up here.'),
      '<a class="btn btn-sm" href="#/announcements">All</a>');
  }

  /* ============================== USERS ============================== */
  var users = {
    title: 'People',
    sub: function () { return 'Owner-only. Approve registrations, manage roles, handle reset requests.'; },
    roles: ['owner'],
    render: function () {
      var d = S.db;
      var resets = d.resets.filter(function (r) { return r.status === 'pending'; });
      var out = summary([
        { k: 'Teachers', v: d.users.filter(function (u) { return u.role === 'teacher'; }).length },
        { k: 'Students', v: d.users.filter(function (u) { return u.role === 'student'; }).length },
        { k: 'Pending', v: d.users.filter(function (u) { return u.status === 'pending'; }).length, s: 'awaiting approval' },
        { k: 'Reset requests', v: resets.length, s: 'awaiting a link' }
      ]);

      out += card('All accounts',
        '<div class="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Subjects</th>' +
        '<th>Timezone</th><th class="num">Rate</th><th>Status</th><th></th></tr></thead><tbody>' +
        d.users.map(function (u) {
          return '<tr><td><div class="row">' + avatar(u) + '<div><div style="font-weight:600">' + esc(u.name) +
            (u.seeded ? ' <span class="pill pill-neutral" style="margin-left:4px">seeded</span>' : '') + '</div>' +
            '<div class="small dim">' + esc(u.email) + '</div></div></div></td>' +
            '<td style="text-transform:capitalize">' + esc(u.role) + '</td>' +
            '<td>' + (u.subjects || []).map(subjectPill).join(' ') + '</td>' +
            '<td class="small mono">' + esc(u.tz || '—') + '</td>' +
            '<td class="num">' + (u.role === 'teacher' ? F.money(u.hourlyRate) + '/h' : '—') + '</td>' +
            '<td>' + statusPill(u.status) + '</td>' +
            '<td class="right">' + (u.seeded ? '<span class="small dim">—</span>' :
              (u.status === 'pending'
                ? '<button class="btn btn-sm btn-primary" data-act="approve-user" data-id="' + u.id + '">Approve</button>'
                : '<button class="btn btn-sm" data-act="toggle-suspend" data-id="' + u.id + '">' +
                  (u.status === 'suspended' ? 'Reinstate' : 'Suspend') + '</button>')) + '</td></tr>';
        }).join('') + '</tbody></table></div>');

      out += card('Password reset requests',
        d.resets.length
          ? '<div class="table-wrap"><table><thead><tr><th>Person</th><th>Requested</th><th>Status</th><th></th></tr></thead><tbody>' +
            d.resets.map(function (r) {
              return '<tr><td>' + esc(S.userById(r.userId).name) + '<div class="small dim">' + esc(r.email) + '</div></td>' +
                '<td class="small mono">' + F.ago(r.requestedAt) + '</td><td>' + statusPill(r.status) + '</td>' +
                '<td class="right">' + (r.status === 'pending'
                  ? '<button class="btn btn-sm" data-act="reset-reject" data-id="' + r.id + '">Reject</button> ' +
                    '<button class="btn btn-sm btn-primary" data-act="reset-approve" data-id="' + r.id + '">Send link</button>'
                  : '<span class="small dim">handled</span>') + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : empty('No requests', 'Approving one emails a single-use reset link.'));

      out += '<div class="flag"><b>Note</b><div>Approving a reset sends the email through the server\'s mailer. ' +
        'In this preview it marks the request approved and notifies the account holder in-app instead.</div></div>';
      return out;
    }
  };

  /* ============================= LIBRARY ============================= */
  var library = {
    title: 'Library',
    sub: function (u) {
      return u.role === 'teacher' ? 'Your folders and materials — visible only to you and your students.'
           : u.role === 'owner' ? 'Every teacher\'s materials, listed with their owner.'
           : 'Material shared by teachers you study with.';
    },
    render: function (ctx) {
      var u = ctx.user;
      var folders = S.foldersFor(u);
      var open = ctx.params.folder || (folders[0] && folders[0].id);
      var res = open ? S.resourcesIn(open, u) : [];
      var totalBytes = S.db.resources.filter(function (r) { return u.role === 'teacher' ? r.teacherId === u.id : true; })
        .reduce(function (a, r) { return a + r.bytes; }, 0);

      var out = summary([
        { k: 'Folders', v: folders.length },
        { k: 'Files', v: folders.reduce(function (a, f) { return a + S.resourcesIn(f.id, u).length; }, 0) },
        { k: 'Storage used', v: F.bytes(totalBytes), s: 'S3 presigned uploads' },
        { k: 'Per-file limit', v: '20 MB', s: S.UPLOAD.allow.length + ' allowed types' }
      ]);

      out += '<div class="split-3">';
      out += '<section class="card"><div class="card-head"><h2>' +
        (open ? esc((folders.find(function (f) { return f.id === open; }) || {}).name || 'Files') : 'Files') + '</h2>' +
        (u.role === 'teacher' && open
          ? '<div class="row"><label class="btn btn-sm btn-primary" for="upload-input">Upload file</label>' +
            '<input id="upload-input" type="file" class="hide" data-act="upload" data-folder="' + open + '"></div>'
          : '') + '</div>' +
        (res.length
          ? '<div class="table-wrap"><table><thead><tr><th>File</th><th>Type</th><th class="num">Size</th><th>Added</th>' +
            (u.role === 'owner' ? '<th>Owner</th>' : '') + '<th></th></tr></thead><tbody>' +
            res.map(function (r) {
              return '<tr><td style="font-weight:500">' + esc(r.name) + '</td>' +
                '<td><span class="pill pill-neutral mono">.' + esc(r.ext) + '</span></td>' +
                '<td class="num">' + F.bytes(r.bytes) + '</td>' +
                '<td class="small dim mono">' + F.ago(r.uploadedAt) + '</td>' +
                (u.role === 'owner' ? '<td class="small">' + esc(S.userById(r.teacherId).name) + '</td>' : '') +
                '<td class="right">' + (u.role === 'teacher'
                  ? '<button class="btn btn-sm btn-ghost" data-act="delete-resource" data-id="' + r.id + '">Delete</button>'
                  : '<button class="btn btn-sm btn-ghost" data-act="open-resource" data-id="' + r.id + '">Open</button>') + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : empty('This folder is empty', u.role === 'teacher' ? 'Upload a PDF, image or audio file to get started.' : 'Your teacher has not added anything here yet.')) +
        '</section>';

      out += '<section class="card"><div class="card-head"><h2>Folders</h2>' +
        (u.role === 'teacher' ? '<button class="btn btn-sm" data-act="new-folder">New</button>' : '') + '</div>' +
        (folders.length
          ? '<div class="list-rows">' + folders.map(function (f) {
              var n = S.resourcesIn(f.id, u).length;
              return '<a href="#/library?folder=' + f.id + '" class="row-between" style="text-decoration:none;color:inherit;' +
                (f.id === open ? 'background:var(--brand-soft)' : '') + '">' +
                '<div><div style="font-weight:600">' + esc(f.name) + '</div>' +
                '<div class="small dim">' + n + ' file' + (n === 1 ? '' : 's') +
                (u.role !== 'teacher' ? ' · ' + esc(S.userById(f.teacherId).name) : '') + '</div></div>' +
                subjectPill(f.subject) + '</a>';
            }).join('') + '</div>'
          : empty('No folders', 'Create one to organise your materials.')) + '</section>';
      out += '</div>';

      if (u.role === 'teacher') {
        out += '<div class="flag info"><b>Isolation</b><div>Every query filters by your teacher ID. ' +
          (LC.data.isRemote()
            ? 'The server enforces it: another teacher requesting this folder by ID gets the same 404 as one that does not exist.'
            : 'Connect the server to see it enforced server-side rather than in the browser.') +
          '</div></div>';
      }
      return out;
    }
  };

  /* =========================== ANNOUNCEMENTS =========================== */
  var announcements = {
    title: 'Announcements',
    sub: function (u) { return u.role === 'owner' ? 'Post to everyone, teachers only, or students only.' : 'Notices from the platform admin.'; },
    render: function (ctx) {
      var u = ctx.user;
      var list = S.db.announcements.filter(function (a) {
        if (u.role === 'owner') return true;
        return a.audience === 'all' || (a.audience === 'teachers' && u.role === 'teacher') || (a.audience === 'students' && u.role === 'student');
      }).sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.createdAt) - new Date(a.createdAt); });

      var out = '';
      if (u.role === 'owner') {
        out += '<section class="card"><div class="card-head"><h2>New announcement</h2></div>' +
          '<form class="card-body stack" data-act="post-announcement">' +
          '<label class="field">Title<input type="text" id="ann-title" name="title" required placeholder="What do people need to know?"></label>' +
          '<label class="field">Message<textarea id="ann-body" name="body" required placeholder="Keep it short and specific."></textarea></label>' +
          '<div class="form-grid">' +
          '<label class="field">Audience<select id="ann-audience" name="audience"><option value="all">Everyone</option>' +
          '<option value="teachers">Teachers only</option><option value="students">Students only</option></select></label>' +
          '<label class="field">Pin to top<select id="ann-pinned" name="pinned"><option value="no">No</option><option value="yes">Yes</option></select></label>' +
          '</div><div class="row" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">Post announcement</button></div>' +
          '</form></section>';
      }

      out += list.length ? '<div class="stack">' + list.map(function (a) {
        return '<article class="card card-pad"><div class="row-between">' +
          '<div class="row">' + (a.pinned ? '<span class="pill pill-warn">Pinned</span>' : '') +
          '<span class="pill pill-neutral">' + (a.audience === 'all' ? 'Everyone' : a.audience === 'teachers' ? 'Teachers' : 'Students') + '</span></div>' +
          '<span class="small dim mono">' + F.day(a.createdAt) + ' · ' + F.ago(a.createdAt) + '</span></div>' +
          '<h2 style="margin:10px 0 6px">' + esc(a.title) + '</h2>' +
          '<p class="muted">' + esc(a.body) + '</p>' +
          '<div class="row" style="margin-top:12px;justify-content:space-between">' +
          '<span class="small dim">' + esc(S.userById(a.authorId).name) + '</span>' +
          (u.role === 'owner' ? '<button class="btn btn-sm btn-ghost" data-act="delete-announcement" data-id="' + a.id + '">Delete</button>' : '') +
          '</div></article>';
      }).join('') + '</div>' : empty('No announcements', 'Nothing has been posted yet.');
      return out;
    }
  };

  /* ============================== CLASSES ============================== */
  var classes = {
    title: 'Classes',
    sub: function (u) {
      return u.role === 'student' ? 'Request a class, then join when your teacher accepts.'
           : u.role === 'teacher' ? 'Answer requests and enter your classrooms.'
           : 'Every request and session on the platform.';
    },
    render: function (ctx) {
      var u = ctx.user;
      var reqs = S.requestsFor(u);
      var sess = S.sessionsFor(u).sort(function (a, b) { return new Date(a.startsAt) - new Date(b.startsAt); });
      var upcoming = sess.filter(function (s) { return s.status === 'scheduled' || s.status === 'live'; });
      var past = sess.filter(function (s) { return s.status === 'completed' || s.status === 'no_show'; }).reverse();

      var out = summary([
        { k: 'Upcoming', v: upcoming.length },
        { k: 'Pending requests', v: reqs.filter(function (r) { return r.status === 'pending'; }).length },
        { k: 'Completed', v: past.filter(function (s) { return s.status === 'completed'; }).length },
        { k: 'Total hours', v: (sess.filter(function (s) { return s.status === 'completed'; })
            .reduce(function (a, s) { return a + s.minutes; }, 0) / 60).toFixed(1) + 'h' }
      ]);

      if (u.role === 'student') {
        var teachers = S.db.users.filter(function (t) { return t.role === 'teacher' && t.status === 'active'; });
        out += '<section class="card"><div class="card-head"><h2>Request a class</h2>' +
          '<span class="small dim">Your teacher gets a push notification immediately</span></div>' +
          '<form class="card-body stack" data-act="create-request">' +
          '<div class="form-grid">' +
          '<label class="field">Teacher<select id="req-teacher" name="teacherId">' +
          teachers.map(function (t) {
            return '<option value="' + t.id + '">' + esc(t.name) + ' — ' + (t.subjects || []).join(', ') + '</option>';
          }).join('') + '</select></label>' +
          '<label class="field">Subject<select id="req-subject" name="subject"><option value="math">Math</option><option value="english">English</option></select></label>' +
          '<label class="field">Length<select id="req-minutes" name="minutes"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60" selected>60 minutes</option><option value="90">90 minutes</option><option value="120">2 hours</option><option value="180">3 hours</option><option value="240">4 hours</option></select></label>' +
          '<label class="field">Date &amp; time<input type="datetime-local" id="req-when" name="when" required></label>' +
          '</div>' +
          '<label class="field">Topic<input type="text" id="req-topic" name="topic" required placeholder="e.g. Completing the square — homework 4"></label>' +
          '<label class="field">Anything your teacher should prepare?<textarea id="req-note" name="note" placeholder="Optional"></textarea></label>' +
          '<div class="row" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">Send request</button></div>' +
          '</form></section>';
      }

      out += card(u.role === 'teacher' ? 'Requests from students' : 'Requests',
        reqs.length
          ? '<div class="list-rows">' + reqs.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); })
              .map(function (r) { return requestRow(r, u.role === 'teacher' ? 'teacher' : 'student'); }).join('') + '</div>'
          : empty('No requests', u.role === 'student' ? 'Use the form above to ask for your first class.' : 'Students have not requested anything yet.'));

      out += '<div class="split">';
      out += card('Upcoming sessions',
        upcoming.length
          ? '<div class="card-body"><div class="tl">' + upcoming.map(function (s) {
              return timelineItem(s, u.role === 'teacher' ? 'teacher' : u.role === 'owner' ? 'owner' : 'student');
            }).join('') + '</div></div>'
          : empty('Nothing scheduled', 'Accepted requests become sessions.'));
      out += card('History',
        past.length
          ? '<div class="table-wrap"><table><thead><tr><th>Topic</th><th>With</th><th>When</th><th>Status</th></tr></thead><tbody>' +
            past.slice(0, 12).map(function (s) {
              var other = u.role === 'teacher' ? S.userById(s.studentId) : S.userById(s.teacherId);
              return '<tr><td style="font-weight:500">' + esc(s.topic) + '</td>' +
                '<td class="small">' + esc(other.name) + '</td>' +
                '<td class="small mono">' + F.day(s.startsAt) + '</td>' +
                '<td>' + statusPill(s.status) + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : empty('No history yet', 'Finished classes are listed here.'));
      out += '</div>';
      return out;
    },
    mount: function () {
      var when = document.getElementById('req-when');
      if (when && !when.value) {
        var d = new Date(Date.now() + 864e5);
        d.setMinutes(0, 0, 0);
        d.setHours(16);
        when.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      }
    }
  };

  /* ============================ ATTENDANCE ============================ */
  var attendance = {
    title: 'Attendance',
    sub: function (u) { return u.role === 'owner' ? 'Clock-in records for every teacher.' : 'Your clock-in record. ' + S.PAYROLL.graceMinutes + '-minute grace, then a deduction applies.'; },
    roles: ['owner', 'teacher'],
    render: function (ctx) {
      var u = ctx.user;
      var rows = S.db.attendance.filter(function (a) { return u.role === 'owner' ? true : a.teacherId === u.id; })
        .sort(function (a, b) { return new Date(b.scheduledStart) - new Date(a.scheduledStart); });
      var late = rows.filter(function (a) { return !a.noShow && (a.minutesLate || 0) > S.PAYROLL.graceMinutes; }).length;
      var noShows = rows.filter(function (a) { return a.noShow; }).length;
      var onTimePct = rows.length ? Math.round((rows.length - late - noShows) / rows.length * 100) : 100;

      var out = summary([
        { k: 'Records', v: rows.length },
        { k: 'On time', v: onTimePct + '%', s: 'within the grace window' },
        { k: 'Late arrivals', v: late, s: 'deduction applied' },
        { k: 'No-shows', v: noShows, s: 'full fee forfeited' }
      ]);

      // live clock-in panel for a teacher with a session near now
      if (u.role === 'teacher') {
        var next = nextSession(u);
        var open = S.db.attendance.find(function (a) { return a.teacherId === u.id && a.clockIn && !a.clockOut; });
        out += '<section class="card"><div class="card-head"><h2>Clock in / out</h2>' +
          '<span class="small dim mono" id="att-clock">' + F.time(Date.now()) + '</span></div><div class="card-body">' +
          (open
            ? '<div class="row-between"><div><div style="font-weight:600">Clocked in at ' + F.time(open.clockIn) + '</div>' +
              '<div class="small dim">Running for <span class="mono" data-since="' + open.clockIn + '">' + F.duration(Date.now() - new Date(open.clockIn)) + '</span></div></div>' +
              '<button class="btn btn-primary" data-act="clock-out" data-id="' + open.id + '">Clock out</button></div>'
            : next
              ? '<div class="row-between"><div><div style="font-weight:600">' + esc(next.topic) + '</div>' +
                '<div class="small dim">Scheduled ' + F.dayTime(next.startsAt) + ' · with ' + esc(S.userById(next.studentId).name) + '</div></div>' +
                '<button class="btn btn-primary" data-act="clock-in" data-id="' + next.id + '">Clock in now</button></div>'
              : empty('Nothing to clock into', 'Clock-in unlocks when you have a scheduled session.')) +
          '</div></section>';
      }

      out += card('Record',
        rows.length
          ? '<div class="table-wrap"><table><thead><tr>' + (u.role === 'owner' ? '<th>Teacher</th>' : '') +
            '<th>Session</th><th>Scheduled</th><th>Clock in</th><th>Clock out</th><th class="num">Late</th><th class="num">Deduction</th></tr></thead><tbody>' +
            rows.map(function (a) {
              var t = S.userById(a.teacherId);
              var ses = S.db.sessions.find(function (s) { return s.id === a.sessionId; }) || { topic: '—', minutes: 60 };
              var ded = a.noShow
                ? ses.minutes * S.minuteRate(t) * S.PAYROLL.noShowDeduction
                : Math.max(0, (a.minutesLate || 0) - S.PAYROLL.graceMinutes) * S.minuteRate(t) * S.PAYROLL.latePenalty;
              return '<tr>' + (u.role === 'owner' ? '<td class="small">' + esc(t.name) + '</td>' : '') +
                '<td style="font-weight:500">' + esc(ses.topic) + '</td>' +
                '<td class="small mono">' + F.dayTime(a.scheduledStart) + '</td>' +
                '<td class="mono small">' + (a.clockIn ? F.time(a.clockIn) : '<span class="pill pill-crit">missed</span>') + '</td>' +
                '<td class="mono small">' + (a.clockOut ? F.time(a.clockOut) : '—') + '</td>' +
                '<td class="num">' + (a.noShow ? '—' : (a.minutesLate || 0) + ' min') + '</td>' +
                '<td class="num" style="color:' + (ded > 0 ? 'var(--crit)' : 'var(--ink-3)') + '">' + (ded > 0 ? '−' + F.money(ded) : '—') + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : empty('No records', 'Clock-in records appear here after your first session.'));

      out += '<div class="flag info"><b>How a deduction is worked out</b><div class="mono small" style="margin-top:6px">' +
        'late_minutes = clock_in − scheduled_start<br>' +
        'billable_late = max(0, late_minutes − ' + S.PAYROLL.graceMinutes + ')<br>' +
        'deduction = billable_late × (hourly_rate ÷ 60) × ' + S.PAYROLL.latePenalty + '<br>' +
        'no_show → deduction = session_minutes × (hourly_rate ÷ 60)</div></div>';
      return out;
    },
    mount: function () {
      var el = document.querySelector('[data-since]');
      var clock = document.getElementById('att-clock');
      if (!el && !clock) return;
      LC.app.interval(function () {
        if (clock) clock.textContent = F.time(Date.now());
        if (el) el.textContent = F.duration(Date.now() - new Date(el.dataset.since));
      }, 1000);
    }
  };

  /* ============================== PAYROLL ============================== */
  var payroll = {
    title: 'Payroll',
    sub: function (u) { return u.role === 'owner' ? 'Generate a batch from clock-in records.' : 'What you have earned, and why.'; },
    roles: ['owner', 'teacher'],
    render: function (ctx) {
      var u = ctx.user;
      var to = Date.now(), from = to - 30 * 864e5;
      var lines = u.role === 'owner' ? S.payrollRun(from, to) : [S.payrollLine(u, from, to)];
      var gross = lines.reduce(function (a, l) { return a + l.gross; }, 0);
      var ded = lines.reduce(function (a, l) { return a + l.deductions; }, 0);
      var net = lines.reduce(function (a, l) { return a + l.net; }, 0);
      var minutes = lines.reduce(function (a, l) { return a + l.minutes; }, 0);

      var out = summary([
        { k: 'Period', v: '30d', s: F.day(from) + ' → ' + F.day(to) },
        { k: 'Taught', v: (minutes / 60).toFixed(1) + 'h', s: lines.reduce(function (a, l) { return a + l.sessions; }, 0) + ' sessions' },
        { k: 'Gross', v: F.money(gross) },
        { k: 'Deductions', v: ded > 0 ? '−' + F.money(ded) : F.money(0), s: 'lateness + no-shows' },
        { k: 'Net payable', v: F.money(net) }
      ]);

      out += card(u.role === 'owner' ? 'Batch preview — all active teachers' : 'Your earnings',
        '<div class="table-wrap"><table><thead><tr><th>Teacher</th><th class="num">Sessions</th><th class="num">Minutes</th>' +
        '<th class="num">Late</th><th class="num">No-shows</th><th class="num">Gross</th><th class="num">Deductions</th><th class="num">Net</th></tr></thead><tbody>' +
        lines.map(function (l) {
          var t = S.userById(l.teacherId);
          return '<tr><td><div class="row">' + avatar(t) + '<div><div style="font-weight:600">' + esc(t.name) + '</div>' +
            '<div class="small dim mono">' + F.money(t.hourlyRate) + '/h</div></div></div></td>' +
            '<td class="num">' + l.sessions + '</td><td class="num">' + l.minutes + '</td>' +
            '<td class="num">' + l.lateMinutes + ' min</td><td class="num">' + l.noShows + '</td>' +
            '<td class="num">' + F.money(l.gross) + '</td>' +
            '<td class="num" style="color:' + (l.deductions > 0 ? 'var(--crit)' : 'var(--ink-3)') + '">' + (l.deductions > 0 ? '−' + F.money(l.deductions) : '—') + '</td>' +
            '<td class="num" style="font-weight:600">' + F.money(l.net) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (u.role === 'owner'
          ? '<div class="card-foot row-between"><span class="small dim">Generating a batch locks these figures and notifies each teacher.</span>' +
            '<button class="btn btn-primary" data-act="run-payroll">Generate batch</button></div>'
          : ''));

      out += card('Batch history',
        S.db.payroll.length
          ? '<div class="table-wrap"><table><thead><tr><th>Period</th><th>Created</th><th class="num">Teachers</th><th class="num">Net</th><th>Status</th></tr></thead><tbody>' +
            S.db.payroll.slice().reverse().map(function (b) {
              var bl = b.lines || S.payrollRun(new Date(b.periodStart).getTime(), new Date(b.periodEnd).getTime());
              return '<tr><td class="mono small">' + F.day(b.periodStart) + ' → ' + F.day(b.periodEnd) + '</td>' +
                '<td class="small dim mono">' + F.ago(b.createdAt) + '</td>' +
                '<td class="num">' + bl.length + '</td>' +
                '<td class="num">' + F.money(bl.reduce(function (a, l) { return a + l.net; }, 0)) + '</td>' +
                '<td>' + statusPill(b.status) + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : empty('No batches yet', 'Generate the first one above.'));
      return out;
    }
  };

  /* ============================== BILLING ============================== */
  var billing = {
    title: 'Billing',
    sub: function (u) { return u.role === 'student' ? 'Invoices for your classes, paid through Stripe.' : 'Invoices across all students.'; },
    roles: ['owner', 'student'],
    render: function (ctx) {
      var u = ctx.user;
      var list = S.invoicesFor(u).sort(function (a, b) { return new Date(b.issuedAt) - new Date(a.issuedAt); });
      var open = list.filter(function (i) { return i.status === 'open'; });
      var paid = list.filter(function (i) { return i.status === 'paid'; });

      var out = summary([
        { k: 'Open', v: F.money(open.reduce(function (a, i) { return a + i.amount; }, 0)), s: open.length + ' invoice' + (open.length === 1 ? '' : 's') },
        { k: 'Paid', v: F.money(paid.reduce(function (a, i) { return a + i.amount; }, 0)), s: paid.length + ' settled' },
        { k: 'Next due', v: open.length ? F.day(open.sort(function (a, b) { return new Date(a.dueAt) - new Date(b.dueAt); })[0].dueAt) : '—' },
        { k: 'Currency', v: 'USD', s: 'Stripe, card + wallets' }
      ]);

      out += card('Invoices',
        list.length
          ? '<div class="table-wrap"><table><thead><tr><th>Invoice</th>' + (u.role === 'owner' ? '<th>Student</th>' : '') +
            '<th>Lines</th><th>Issued</th><th>Due</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>' +
            list.map(function (i) {
              return '<tr><td class="mono" style="font-weight:600">' + esc(i.number) + '<div class="small dim">' + esc(i.stripeId) + '</div></td>' +
                (u.role === 'owner' ? '<td class="small">' + esc(S.userById(i.studentId).name) + '</td>' : '') +
                '<td class="small muted">' + i.lines.map(function (l) { return esc(l.label); }).join('<br>') + '</td>' +
                '<td class="small mono">' + F.day(i.issuedAt) + '</td>' +
                '<td class="small mono">' + F.day(i.dueAt) + '</td>' +
                '<td class="num" style="font-weight:600">' + F.money(i.amount, i.currency) + '</td>' +
                '<td>' + statusPill(i.status) + '</td>' +
                '<td class="right">' + (i.status === 'open' && u.role === 'student'
                  ? '<button class="btn btn-sm btn-primary" data-act="pay-invoice" data-id="' + i.id + '">Pay</button>'
                  : i.status === 'open' && u.role === 'owner'
                    ? '<button class="btn btn-sm" data-act="remind-invoice" data-id="' + i.id + '">Remind</button>'
                    : '<span class="small dim">—</span>') + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : empty('No invoices', 'Invoices are raised after your classes are delivered.'));

      out += '<div class="flag"><b>Stripe keys are not wired up here</b><div>Paying marks the invoice settled locally so you can ' +
        'see the flow. The production path is Stripe Invoices + a <span class="mono">payment_intent.succeeded</span> webhook that flips the ' +
        'same <span class="mono">Invoice</span> record server-side.</div></div>';
      return out;
    }
  };

  /* ============================== SETTINGS ============================== */
  var settings = {
    title: 'Settings',
    sub: function () { return 'Profile, notifications, install and app data.'; },
    render: function (ctx) {
      var u = ctx.user;
      var sw = LC.app.swState || 'checking…';
      var perm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';

      var out = '<div class="split">';
      out += '<section class="card"><div class="card-head"><h2>Profile</h2></div>' +
        '<form class="card-body stack" data-act="save-profile">' +
        '<div class="row">' + avatar(u, 'avatar-lg') + '<div><div style="font-weight:600">' + esc(u.name) + '</div>' +
        '<div class="small dim">' + esc(u.email) + ' · ' + esc(u.role) + '</div></div></div>' +
        '<div class="form-grid">' +
        '<label class="field">Display name<input type="text" id="set-name" value="' + esc(u.name) + '"></label>' +
        '<label class="field">Locale<select id="set-locale">' +
        ['en-US', 'en-GB', 'es-CL', 'pt-BR', 'it-IT', 'ja-JP', 'ar-AE'].map(function (l) {
          return '<option value="' + l + '"' + (u.locale === l ? ' selected' : '') + '>' + l + '</option>';
        }).join('') + '</select></label>' +
        '<label class="field">Timezone<input type="text" id="set-tz" value="' + esc(u.tz || 'UTC') + '"></label>' +
        (u.role === 'teacher' ? '<label class="field">Hourly rate (USD)<input type="number" id="set-rate" min="0" step="1" value="' + (u.hourlyRate || 0) + '"></label>' : '') +
        '</div>' +
        '<div class="row" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">Save profile</button></div>' +
        '</form></section>';

      var remote = LC.data.isRemote();
      out += '<section class="card"><div class="card-head"><h2>Server</h2>' +
        (remote ? '<span class="pill pill-ok"><i class="dot"></i>Connected</span>'
                : '<span class="pill pill-warn"><i class="dot"></i>Demo data</span>') +
        '</div><div class="card-body stack">' +
        (remote
          ? '<div class="row-between"><div><div style="font-weight:600">PostgreSQL via the API</div>' +
            '<div class="small dim mono">' + esc(LC.api.baseUrl()) + '</div></div>' +
            '<button class="btn" data-act="disconnect-server">Disconnect</button></div>' +
            '<p class="small muted">Accounts, classes, attendance and invoices are read and written on the server. ' +
            'Realtime runs over Socket.io, so a second browser signed in as the other participant shares your classroom.</p>'
          : '<div class="row-between"><div><div style="font-weight:600">Running on demo data</div>' +
            '<div class="small dim">Everything is in this browser\'s localStorage. Nothing is shared between devices.</div></div>' +
            '<button class="btn btn-primary" data-act="connect-server">Connect a server</button></div>' +
            '<p class="small muted">Start the API with <span class="mono">npm run dev</span> from the repository root, then ' +
            'point this at <span class="mono">http://localhost:4001</span>.</p>') +
        '</div></section>';

      out += '<section class="card"><div class="card-head"><h2>Notifications &amp; install</h2></div><div class="card-body stack">' +
        '<div class="row-between"><div><div style="font-weight:600">Browser push</div>' +
        '<div class="small dim">Permission: <span class="mono">' + esc(perm) + '</span></div></div>' +
        '<button class="btn" data-act="enable-push"' + (perm === 'granted' ? ' disabled' : '') + '>' +
        (perm === 'granted' ? 'Enabled' : 'Enable push') + '</button></div>' +
        '<div class="row-between"><div><div style="font-weight:600">Install as an app</div>' +
        '<div class="small dim" id="install-hint">Adds LogicClass+ to your home screen or dock.</div></div>' +
        '<button class="btn btn-primary" data-act="install-pwa">Install</button></div>' +
        '<div class="row-between"><div><div style="font-weight:600">Service worker</div>' +
        '<div class="small dim">Offline shell and background sync · <span class="mono">' + esc(sw) + '</span></div></div></div>' +
        '<div class="row-between"><div><div style="font-weight:600">Simulate offline</div>' +
        '<div class="small dim">Queue writes in the outbox instead of sending them.</div></div>' +
        '<button class="btn" data-act="toggle-offline">' + (S.isOffline() ? 'Go back online' : 'Go offline') + '</button></div>' +
        '<div class="row-between"><div><div style="font-weight:600">Appearance</div>' +
        '<div class="small dim">Follows your system theme by default.</div></div>' +
        '<button class="btn" data-act="cycle-theme">' + esc(LC.app.themeLabel()) + '</button></div>' +
        '</div></section>';
      out += '</div>';

      out += card('Outbox',
        S.db.outbox.length
          ? '<div class="list-rows">' + S.db.outbox.map(function (o) {
              return '<div class="row-between"><span class="mono small">' + esc(o.label) + '</span>' +
                '<span class="small dim">queued ' + F.ago(o.queuedAt) + '</span></div>';
            }).join('') + '</div>'
          : empty('Outbox empty', 'Writes made while offline wait here and replay when you reconnect.'));

      out += '<section class="card"><div class="card-head"><h2>Demo data</h2></div><div class="card-body row-between">' +
        '<div><div style="font-weight:600">Reset everything</div>' +
        '<div class="small dim">Restores the seeded accounts, folders, sessions and invoices. Anything you changed is lost.</div></div>' +
        '<button class="btn btn-danger" data-act="reset-data">Reset demo data</button></div></section>';

      out += remote
        ? '<div class="flag info"><b>Connected to the API</b><div>Reads and writes go to PostgreSQL through ' +
          '<span class="mono">apps/server</span>. Stripe, S3 and Web Push each switch on when their keys are present in ' +
          '<span class="mono">apps/server/.env</span> — the server reports which are configured on ' +
          '<span class="mono">/api/health</span> and says so plainly rather than faking a result.</div></div>'
        : '<div class="flag"><b>Demo mode</b><div>The front end is running entirely in your browser: data lives in ' +
          '<span class="mono">localStorage</span> and there is no Socket.io server behind it, so the classroom peer is ' +
          'simulated. Your camera, microphone and recorder are real. Connect the server above for the full stack.</div></div>';
      return out;
    }
  };

  LC.views = {
    dashboard: dashboard, users: users, library: library, announcements: announcements,
    classes: classes, attendance: attendance, payroll: payroll, billing: billing, settings: settings
  };
  LC.ui = { avatar: avatar, subjectPill: subjectPill, statusPill: statusPill, summary: summary, empty: empty, card: card, joinable: joinable, nextSession: nextSession };
})();
