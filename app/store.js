/* ============================================================
   LogicClass+ — client data layer
   Mirrors apps/server/prisma/schema.prisma from the handoff:
   User, Folder, Resource, Announcement, ClassRequest,
   ClassSession, Attendance, PayrollBatch, Invoice,
   Notification, PasswordResetRequest.
   Persisted per-browser in localStorage. Every mutation goes
   through commit(), which honours the offline outbox so the
   PWA keeps working with no network.
   ============================================================ */
window.LC = window.LC || {};

(function () {
  var KEY = 'logicclass.plus.v1';
  var SESSION_KEY = 'logicclass.plus.session';

  /* ---------- upload policy (spec: 20MB + extension allowlist) ---------- */
  var UPLOAD = {
    maxBytes: 20 * 1024 * 1024,
    allow: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt',
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
            'mp3', 'wav', 'm4a', 'mp4', 'webm']
  };

  /* ---------- payroll policy ---------- */
  var PAYROLL = {
    graceMinutes: 5,      // no deduction inside the grace window
    latePenalty: 1.5,     // late minutes billed back at 1.5x the minute rate
    noShowDeduction: 1.0, // a missed session forfeits the whole fee
    currency: 'USD'
  };

  function uid(p) { return p + '_' + Math.random().toString(36).slice(2, 10); }
  function iso(d) { return new Date(d).toISOString(); }
  function hoursFromNow(h) { return new Date(Date.now() + h * 3600e3); }
  function daysFromNow(d) { return new Date(Date.now() + d * 864e5); }

  /* ============================ seed ============================ */
  function seed() {
    var now = Date.now();
    var users = [
      { id: 'usr_owner', name: 'Marisol Vega', email: 'owner@logicclass.plus', password: 'admin1234',
        role: 'owner', status: 'active', locale: 'en-US', tz: 'America/New_York',
        subjects: [], hourlyRate: 0, joinedAt: iso(now - 420 * 864e5), seeded: true },

      { id: 'usr_t1', name: 'Daniel Okafor', email: 'daniel@logicclass.plus', password: 'teach1234',
        role: 'teacher', status: 'active', locale: 'en-GB', tz: 'Europe/London',
        subjects: ['math'], hourlyRate: 26, joinedAt: iso(now - 310 * 864e5),
        bio: 'Algebra & calculus. 8 years, IB and A-Level.' },
      { id: 'usr_t2', name: 'Hana Sato', email: 'hana@logicclass.plus', password: 'teach1234',
        role: 'teacher', status: 'active', locale: 'en-US', tz: 'Asia/Tokyo',
        subjects: ['english'], hourlyRate: 24, joinedAt: iso(now - 240 * 864e5),
        bio: 'Pronunciation, IELTS speaking, business English.' },
      { id: 'usr_t3', name: 'Paolo Mendes', email: 'paolo@logicclass.plus', password: 'teach1234',
        role: 'teacher', status: 'pending', locale: 'pt-BR', tz: 'America/Sao_Paulo',
        subjects: ['math', 'english'], hourlyRate: 22, joinedAt: iso(now - 2 * 864e5),
        bio: 'Bilingual tutor, primary and lower secondary.' },

      { id: 'usr_s1', name: 'Amira Haddad', email: 'amira@logicclass.plus', password: 'learn1234',
        role: 'student', status: 'active', locale: 'ar-AE', tz: 'Asia/Dubai',
        subjects: ['math'], joinedAt: iso(now - 150 * 864e5), gradeLevel: 'Year 10' },
      { id: 'usr_s2', name: 'Kenji Watanabe', email: 'kenji@logicclass.plus', password: 'learn1234',
        role: 'student', status: 'active', locale: 'ja-JP', tz: 'Asia/Tokyo',
        subjects: ['english'], joinedAt: iso(now - 95 * 864e5), gradeLevel: 'Adult / B2' },
      { id: 'usr_s3', name: 'Lucia Ferrari', email: 'lucia@logicclass.plus', password: 'learn1234',
        role: 'student', status: 'active', locale: 'it-IT', tz: 'Europe/Rome',
        subjects: ['math', 'english'], joinedAt: iso(now - 61 * 864e5), gradeLevel: 'Year 12' },
      { id: 'usr_s4', name: 'Tomás Rivas', email: 'tomas@logicclass.plus', password: 'learn1234',
        role: 'student', status: 'pending', locale: 'es-CL', tz: 'America/Santiago',
        subjects: ['math'], joinedAt: iso(now - 1 * 864e5), gradeLevel: 'Year 8' }
    ];

    var folders = [
      { id: 'fld_1', teacherId: 'usr_t1', name: 'Quadratics', subject: 'math', createdAt: iso(now - 120 * 864e5) },
      { id: 'fld_2', teacherId: 'usr_t1', name: 'Differentiation', subject: 'math', createdAt: iso(now - 70 * 864e5) },
      { id: 'fld_3', teacherId: 'usr_t2', name: 'IELTS Speaking Part 2', subject: 'english', createdAt: iso(now - 88 * 864e5) },
      { id: 'fld_4', teacherId: 'usr_t2', name: 'Minimal Pairs Drills', subject: 'english', createdAt: iso(now - 30 * 864e5) }
    ];

    var resources = [
      { id: 'res_1', folderId: 'fld_1', teacherId: 'usr_t1', name: 'completing-the-square.pdf', ext: 'pdf', bytes: 842_115, uploadedAt: iso(now - 41 * 864e5) },
      { id: 'res_2', folderId: 'fld_1', teacherId: 'usr_t1', name: 'discriminant-worksheet.pdf', ext: 'pdf', bytes: 311_402, uploadedAt: iso(now - 24 * 864e5) },
      { id: 'res_3', folderId: 'fld_2', teacherId: 'usr_t1', name: 'chain-rule-board.png', ext: 'png', bytes: 1_204_880, uploadedAt: iso(now - 9 * 864e5) },
      { id: 'res_4', folderId: 'fld_3', teacherId: 'usr_t2', name: 'cue-cards-band7.docx', ext: 'docx', bytes: 96_640, uploadedAt: iso(now - 33 * 864e5) },
      { id: 'res_5', folderId: 'fld_4', teacherId: 'usr_t2', name: 'ship-sheep-model.mp3', ext: 'mp3', bytes: 2_998_144, uploadedAt: iso(now - 12 * 864e5) },
      { id: 'res_6', folderId: 'fld_4', teacherId: 'usr_t2', name: 'th-sounds-drill.mp3', ext: 'mp3', bytes: 3_410_222, uploadedAt: iso(now - 4 * 864e5) }
    ];

    var announcements = [
      { id: 'ann_1', authorId: 'usr_owner', title: 'October payroll closes Friday 18:00 UTC',
        body: 'Clock-out on every session before the cutoff. Anything logged after Friday rolls into the November batch.',
        audience: 'teachers', pinned: true, createdAt: iso(now - 2 * 864e5) },
      { id: 'ann_2', authorId: 'usr_owner', title: 'New: pronunciation scoring in the English suite',
        body: 'Recordings made in class now return a per-phoneme score. Teachers, please review the report with the student before ending the session.',
        audience: 'all', pinned: false, createdAt: iso(now - 6 * 864e5) },
      { id: 'ann_3', authorId: 'usr_owner', title: 'Scheduled maintenance — Sunday 02:00–03:00 UTC',
        body: 'Classrooms will be unavailable for roughly one hour. No sessions are scheduled in that window.',
        audience: 'all', pinned: false, createdAt: iso(now - 11 * 864e5) }
    ];

    var requests = [
      { id: 'req_1', studentId: 'usr_s1', teacherId: 'usr_t1', subject: 'math', topic: 'Completing the square — homework 4',
        requestedFor: iso(hoursFromNow(1.5)), minutes: 60, status: 'accepted', note: 'I get lost when the coefficient of x² is not 1.', createdAt: iso(now - 2 * 3600e3) },
      { id: 'req_2', studentId: 'usr_s2', teacherId: 'usr_t2', subject: 'english', topic: 'IELTS Part 2 — describing a place',
        requestedFor: iso(hoursFromNow(4)), minutes: 45, status: 'pending', note: 'Exam is in three weeks.', createdAt: iso(now - 40 * 60e3) },
      { id: 'req_3', studentId: 'usr_s3', teacherId: 'usr_t1', subject: 'math', topic: 'Chain rule practice',
        requestedFor: iso(hoursFromNow(26)), minutes: 60, status: 'pending', note: '', createdAt: iso(now - 5 * 3600e3) },
      { id: 'req_4', studentId: 'usr_s3', teacherId: 'usr_t2', subject: 'english', topic: 'Essay structure review',
        requestedFor: iso(hoursFromNow(-20)), minutes: 45, status: 'completed', note: '', createdAt: iso(now - 3 * 864e5) }
    ];

    var sessions = [
      { id: 'ses_1', requestId: 'req_1', teacherId: 'usr_t1', studentId: 'usr_s1', subject: 'math',
        topic: 'Completing the square — homework 4', startsAt: iso(hoursFromNow(1.5)), minutes: 60,
        status: 'scheduled', recordingUrl: null },
      { id: 'ses_2', requestId: 'req_4', teacherId: 'usr_t2', studentId: 'usr_s3', subject: 'english',
        topic: 'Essay structure review', startsAt: iso(hoursFromNow(-20)), minutes: 45,
        status: 'completed', joinedAt: iso(now - 20 * 3600e3 + 2 * 60e3), endedAt: iso(now - 19.2 * 3600e3), recordingUrl: null },
      { id: 'ses_3', requestId: null, teacherId: 'usr_t1', studentId: 'usr_s3', subject: 'math',
        topic: 'Differentiation from first principles', startsAt: iso(hoursFromNow(-44)), minutes: 60,
        status: 'completed', joinedAt: iso(now - 44 * 3600e3 + 11 * 60e3), endedAt: iso(now - 43 * 3600e3), recordingUrl: null },
      { id: 'ses_4', requestId: null, teacherId: 'usr_t2', studentId: 'usr_s2', subject: 'english',
        topic: 'Minimal pairs: /ɪ/ vs /iː/', startsAt: iso(hoursFromNow(-68)), minutes: 45,
        status: 'completed', joinedAt: iso(now - 68 * 3600e3), endedAt: iso(now - 67.25 * 3600e3), recordingUrl: null },
      { id: 'ses_5', requestId: null, teacherId: 'usr_t1', studentId: 'usr_s1', subject: 'math',
        topic: 'Simultaneous equations', startsAt: iso(hoursFromNow(-92)), minutes: 60,
        status: 'no_show', recordingUrl: null }
    ];

    var attendance = [
      { id: 'att_1', teacherId: 'usr_t2', sessionId: 'ses_2', scheduledStart: iso(hoursFromNow(-20)),
        clockIn: iso(now - 20 * 3600e3 + 2 * 60e3), clockOut: iso(now - 19.2 * 3600e3), minutesLate: 2 },
      { id: 'att_2', teacherId: 'usr_t1', sessionId: 'ses_3', scheduledStart: iso(hoursFromNow(-44)),
        clockIn: iso(now - 44 * 3600e3 + 11 * 60e3), clockOut: iso(now - 43 * 3600e3), minutesLate: 11 },
      { id: 'att_3', teacherId: 'usr_t2', sessionId: 'ses_4', scheduledStart: iso(hoursFromNow(-68)),
        clockIn: iso(now - 68 * 3600e3), clockOut: iso(now - 67.25 * 3600e3), minutesLate: 0 },
      { id: 'att_4', teacherId: 'usr_t1', sessionId: 'ses_5', scheduledStart: iso(hoursFromNow(-92)),
        clockIn: null, clockOut: null, minutesLate: null, noShow: true }
    ];

    var invoices = [
      { id: 'inv_1', studentId: 'usr_s1', number: 'LC-2041', amount: 156, currency: 'USD', status: 'paid',
        issuedAt: iso(now - 26 * 864e5), dueAt: iso(now - 12 * 864e5), paidAt: iso(now - 14 * 864e5),
        stripeId: 'in_3Qk2demoA1', lines: [{ label: '6 × Math, 60 min', amount: 156 }] },
      { id: 'inv_2', studentId: 'usr_s2', number: 'LC-2042', amount: 90, currency: 'USD', status: 'open',
        issuedAt: iso(now - 5 * 864e5), dueAt: iso(daysFromNow(9)), stripeId: 'in_3Qk2demoB7',
        lines: [{ label: '4 × English, 45 min', amount: 90 }] },
      { id: 'inv_3', studentId: 'usr_s3', number: 'LC-2043', amount: 204, currency: 'USD', status: 'open',
        issuedAt: iso(now - 1 * 864e5), dueAt: iso(daysFromNow(13)), stripeId: 'in_3Qk2demoC2',
        lines: [{ label: '5 × Math, 60 min', amount: 130 }, { label: '3 × English, 45 min', amount: 74 }] },
      { id: 'inv_4', studentId: 'usr_s1', number: 'LC-2038', amount: 26, currency: 'USD', status: 'void',
        issuedAt: iso(now - 48 * 864e5), dueAt: iso(now - 34 * 864e5), stripeId: 'in_3Qk2demoD9',
        lines: [{ label: '1 × Math, 60 min (cancelled in time)', amount: 26 }] }
    ];

    var payroll = [
      { id: 'pay_1', periodStart: iso(now - 44 * 864e5), periodEnd: iso(now - 14 * 864e5),
        status: 'paid', approvedBy: 'usr_owner', createdAt: iso(now - 13 * 864e5),
        lines: [
          { teacherId: 'usr_t1', sessions: 9, minutes: 540, lateMinutes: 14, noShows: 0, gross: 234, deductions: 5.85, net: 228.15 },
          { teacherId: 'usr_t2', sessions: 8, minutes: 375, lateMinutes: 6, noShows: 0, gross: 150, deductions: 0.6, net: 149.4 }
        ] }
    ];

    var resets = [
      { id: 'prr_1', userId: 'usr_s4', email: 'tomas@logicclass.plus', requestedAt: iso(now - 9 * 3600e3), status: 'pending' }
    ];

    var notifications = [
      { id: uid('ntf'), userId: 'usr_t1', type: 'class_request', title: 'New class request',
        body: 'Lucia Ferrari requested Math — Chain rule practice.', createdAt: iso(now - 5 * 3600e3), read: false },
      { id: uid('ntf'), userId: 'usr_t1', type: 'session', title: 'Session starts in 90 minutes',
        body: 'Amira Haddad — Completing the square.', createdAt: iso(now - 20 * 60e3), read: false },
      { id: uid('ntf'), userId: 'usr_t2', type: 'class_request', title: 'New class request',
        body: 'Kenji Watanabe requested English — IELTS Part 2.', createdAt: iso(now - 40 * 60e3), read: false },
      { id: uid('ntf'), userId: 'usr_owner', type: 'account', title: 'Teacher awaiting approval',
        body: 'Paolo Mendes registered 2 days ago and is still pending.', createdAt: iso(now - 2 * 864e5), read: false },
      { id: uid('ntf'), userId: 'usr_owner', type: 'password', title: 'Password reset requested',
        body: 'Tomás Rivas asked for a reset link.', createdAt: iso(now - 9 * 3600e3), read: false },
      { id: uid('ntf'), userId: 'usr_s1', type: 'session', title: 'Class accepted',
        body: 'Daniel Okafor accepted your request for today.', createdAt: iso(now - 100 * 60e3), read: false },
      { id: uid('ntf'), userId: 'usr_s2', type: 'billing', title: 'Invoice LC-2042 is open',
        body: '$90.00 due in 9 days.', createdAt: iso(now - 5 * 864e5), read: true }
    ];

    var chats = {
      ses_1: [
        { id: uid('msg'), from: 'usr_s1', text: 'Hi! I uploaded my homework to the folder.', at: iso(now - 30 * 60e3) },
        { id: uid('msg'), from: 'usr_t1', text: 'Got it — we will start with question 4.', at: iso(now - 28 * 60e3) }
      ]
    };

    /* A month of delivered teaching, so hours, on-time rate and payroll
       read like a running business rather than a fresh install. */
    var histTopics = {
      math: ['Factorising quadratics', 'Simultaneous equations', 'Circle theorems', 'Indices and surds',
             'Differentiation practice', 'Word problems — rates', 'Probability trees'],
      english: ['Past perfect vs past simple', 'Linking words in Part 3', 'Word stress in long nouns',
                'Describing trends', 'Phrasal verbs at work', 'Reading for gist', 'Connected speech']
    };
    var pairs = [
      { t: 'usr_t1', subject: 'math', students: ['usr_s1', 'usr_s3', 'usr_s1'], minutes: 60 },
      { t: 'usr_t2', subject: 'english', students: ['usr_s2', 'usr_s3', 'usr_s2'], minutes: 45 }
    ];
    var lateCycle = [0, 0, 3, 0, 9, 1, 0];
    pairs.forEach(function (p) {
      for (var i = 1; i <= 7; i++) {
        var start = new Date(now - (i * 3 + 1.5) * 864e5);
        start.setHours(i % 2 ? 15 : 10, i % 2 ? 15 : 30, 0, 0);
        var late = lateCycle[(i + (p.t === 'usr_t2' ? 3 : 0)) % lateCycle.length];
        var sid = 'ses_h' + (p.t === 'usr_t1' ? 'a' : 'b') + i;
        sessions.push({
          id: sid, requestId: null, teacherId: p.t, studentId: p.students[i % p.students.length],
          subject: p.subject, topic: histTopics[p.subject][i % 7],
          startsAt: iso(start), minutes: p.minutes, status: 'completed',
          joinedAt: iso(start.getTime() + late * 60e3),
          endedAt: iso(start.getTime() + (p.minutes + late) * 60e3), recordingUrl: null
        });
        attendance.push({
          id: 'att_h' + (p.t === 'usr_t1' ? 'a' : 'b') + i, teacherId: p.t, sessionId: sid,
          scheduledStart: iso(start), clockIn: iso(start.getTime() + late * 60e3),
          clockOut: iso(start.getTime() + (p.minutes + late) * 60e3), minutesLate: late
        });
      }
    });

    return {
      version: 1, users: users, folders: folders, resources: resources,
      announcements: announcements, requests: requests, sessions: sessions,
      attendance: attendance, invoices: invoices, payroll: payroll,
      resets: resets, notifications: notifications, chats: chats,
      docs: {}, boards: {}, outbox: [], pushEnabled: false
    };
  }

  /* ========================= persistence ========================= */
  var db = null;

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) { db = JSON.parse(raw); }
    } catch (e) { /* private window or blocked storage — run from memory */ }
    if (!db || db.version !== 1) { db = seed(); save(); }
    if (!db.outbox) db.outbox = [];
    return db;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* non-fatal */ }
  }
  function reset() {
    db = seed();
    try { localStorage.setItem(KEY, JSON.stringify(db)); localStorage.removeItem(SESSION_KEY); } catch (e) {}
    return db;
  }

  /* Offline-first write path. When the browser is offline (or the demo
     offline switch is on) the mutation is applied locally and queued;
     flush() replays the queue label-by-label once back online. */
  var forcedOffline = false;
  function isOffline() { return forcedOffline || navigator.onLine === false; }
  function setForcedOffline(v) { forcedOffline = v; }

  function commit(label, fn) {
    var result = fn(db);
    if (isOffline()) {
      db.outbox.push({ id: uid('out'), label: label, queuedAt: iso(Date.now()) });
    }
    save();
    return result;
  }
  function flush() {
    var n = db.outbox.length;
    db.outbox = [];
    save();
    return n;
  }

  /* =========================== auth =========================== */
  function currentUser() {
    var id = null;
    try { id = localStorage.getItem(SESSION_KEY); } catch (e) {}
    if (!id) return null;
    return db.users.find(function (u) { return u.id === id; }) || null;
  }
  function login(email, password) {
    var u = db.users.find(function (x) { return x.email.toLowerCase() === String(email).trim().toLowerCase(); });
    if (!u) return { error: 'No account uses that email address.' };
    if (u.password !== password) return { error: 'That password does not match.' };
    if (u.status === 'pending' && u.role !== 'owner') {
      return { error: 'Your account is waiting for admin approval. You will get an email when it is active.' };
    }
    if (u.status === 'suspended') return { error: 'This account is suspended. Contact the administrator.' };
    try { localStorage.setItem(SESSION_KEY, u.id); } catch (e) {}
    return { user: u };
  }
  function logout() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} }

  /* Registration is Teacher/Student only — the Owner/Admin is seeded and
     can never be created from the public form. */
  function register(input) {
    var name = String(input.name || '').trim();
    var email = String(input.email || '').trim().toLowerCase();
    var role = input.role;
    if (name.length < 2) return { error: 'Enter your full name.' };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return { error: 'Enter a valid email address.' };
    if (String(input.password || '').length < 8) return { error: 'Use at least 8 characters for your password.' };
    if (role !== 'teacher' && role !== 'student') return { error: 'Choose Teacher or Student.' };
    if (db.users.some(function (u) { return u.email === email; })) {
      return { error: 'That email already has an account. Sign in instead.' };
    }
    var user = {
      id: uid('usr'), name: name, email: email, password: input.password, role: role,
      status: 'pending', locale: input.locale || 'en-US',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      subjects: input.subjects && input.subjects.length ? input.subjects : ['math'],
      hourlyRate: role === 'teacher' ? 22 : undefined,
      gradeLevel: role === 'student' ? (input.gradeLevel || '') : undefined,
      joinedAt: iso(Date.now())
    };
    commit('register:' + email, function (d) {
      d.users.push(user);
      d.notifications.unshift({
        id: uid('ntf'), userId: 'usr_owner', type: 'account',
        title: 'New ' + role + ' registration',
        body: name + ' (' + email + ') is waiting for approval.',
        createdAt: iso(Date.now()), read: false
      });
    });
    return { user: user, pending: true };
  }

  function requestPasswordReset(email) {
    var u = db.users.find(function (x) { return x.email.toLowerCase() === String(email).trim().toLowerCase(); });
    // Never reveal whether an address exists.
    if (u) {
      commit('password-reset:' + email, function (d) {
        d.resets.unshift({ id: uid('prr'), userId: u.id, email: u.email, requestedAt: iso(Date.now()), status: 'pending' });
        d.notifications.unshift({
          id: uid('ntf'), userId: 'usr_owner', type: 'password', title: 'Password reset requested',
          body: u.name + ' asked for a reset link.', createdAt: iso(Date.now()), read: false
        });
      });
    }
    return true;
  }

  /* ======================== notifications ======================== */
  function notify(userId, type, title, body) {
    var n = { id: uid('ntf'), userId: userId, type: type, title: title, body: body, createdAt: iso(Date.now()), read: false };
    db.notifications.unshift(n);
    save();
    return n;
  }
  function inbox(userId) {
    return db.notifications.filter(function (n) { return n.userId === userId; });
  }
  function unreadCount(userId) {
    return db.notifications.filter(function (n) { return n.userId === userId && !n.read; }).length;
  }
  function markAllRead(userId) {
    commit('notifications:read-all', function (d) {
      d.notifications.forEach(function (n) { if (n.userId === userId) n.read = true; });
    });
  }

  /* ===================== scoped queries =====================
     Multi-tenant isolation: a teacher only ever sees their own
     folders and resources. Admin sees everything; a student sees
     material from teachers they have had a session with. */
  function foldersFor(user) {
    if (user.role === 'owner') return db.folders.slice();
    if (user.role === 'teacher') return db.folders.filter(function (f) { return f.teacherId === user.id; });
    var teacherIds = db.sessions
      .filter(function (s) { return s.studentId === user.id; })
      .map(function (s) { return s.teacherId; });
    return db.folders.filter(function (f) { return teacherIds.indexOf(f.teacherId) > -1; });
  }
  function resourcesIn(folderId, user) {
    var folder = db.folders.find(function (f) { return f.id === folderId; });
    if (!folder) return [];
    if (user.role === 'teacher' && folder.teacherId !== user.id) return []; // hard isolation
    return db.resources.filter(function (r) { return r.folderId === folderId; });
  }
  function sessionsFor(user) {
    if (user.role === 'owner') return db.sessions.slice();
    var key = user.role === 'teacher' ? 'teacherId' : 'studentId';
    return db.sessions.filter(function (s) { return s[key] === user.id; });
  }
  function requestsFor(user) {
    if (user.role === 'owner') return db.requests.slice();
    var key = user.role === 'teacher' ? 'teacherId' : 'studentId';
    return db.requests.filter(function (r) { return r[key] === user.id; });
  }
  function invoicesFor(user) {
    if (user.role === 'owner') return db.invoices.slice();
    if (user.role === 'student') return db.invoices.filter(function (i) { return i.studentId === user.id; });
    return [];
  }
  function userById(id) { return db.users.find(function (u) { return u.id === id; }) || { name: 'Unknown', id: id, role: 'student' }; }

  /* ======================= upload validation ======================= */
  function validateUpload(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (UPLOAD.allow.indexOf(ext) === -1) {
      return { ok: false, message: '.' + ext + ' files are not allowed. Accepted: ' + UPLOAD.allow.join(', ') + '.' };
    }
    if (file.size > UPLOAD.maxBytes) {
      return { ok: false, message: fmt.bytes(file.size) + ' is over the 20 MB limit. Compress it or split it up.' };
    }
    if (file.size === 0) return { ok: false, message: 'That file is empty.' };
    return { ok: true, ext: ext };
  }

  /* ===================== attendance & payroll ===================== */
  function minuteRate(teacher) { return (teacher.hourlyRate || 0) / 60; }

  function payrollLine(teacher, from, to) {
    var rows = db.attendance.filter(function (a) {
      var t = new Date(a.scheduledStart).getTime();
      return a.teacherId === teacher.id && t >= from && t <= to;
    });
    var minutes = 0, lateMinutes = 0, deduction = 0, noShows = 0, count = 0;
    rows.forEach(function (a) {
      var ses = db.sessions.find(function (s) { return s.id === a.sessionId; });
      var planned = ses ? ses.minutes : 60;
      count++;
      if (a.noShow) {
        noShows++;
        deduction += planned * minuteRate(teacher) * PAYROLL.noShowDeduction;
        return;
      }
      minutes += planned;
      var late = Math.max(0, (a.minutesLate || 0) - PAYROLL.graceMinutes);
      lateMinutes += a.minutesLate || 0;
      deduction += late * minuteRate(teacher) * PAYROLL.latePenalty;
    });
    var gross = minutes * minuteRate(teacher);
    return {
      teacherId: teacher.id, sessions: count, minutes: minutes, lateMinutes: lateMinutes,
      noShows: noShows, gross: gross, deductions: deduction, net: Math.max(0, gross - deduction)
    };
  }

  function payrollRun(from, to) {
    return db.users
      .filter(function (u) { return u.role === 'teacher' && u.status === 'active'; })
      .map(function (t) { return payrollLine(t, from, to); });
  }

  /* =========================== format =========================== */
  var fmt = {
    bytes: function (n) {
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    },
    money: function (n, cur) {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n || 0);
    },
    time: function (d, tz) {
      var o = { hour: '2-digit', minute: '2-digit', hour12: false };
      if (tz) o.timeZone = tz;
      return new Intl.DateTimeFormat('en-GB', o).format(new Date(d));
    },
    day: function (d) {
      return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d));
    },
    dayTime: function (d) {
      return fmt.day(d) + ' · ' + fmt.time(d);
    },
    ago: function (d) {
      var s = (Date.now() - new Date(d).getTime()) / 1000;
      var f = s < 0;
      s = Math.abs(s);
      var v;
      if (s < 60) v = 'just now';
      else if (s < 3600) v = Math.round(s / 60) + 'm';
      else if (s < 86400) v = Math.round(s / 3600) + 'h';
      else if (s < 2592000) v = Math.round(s / 86400) + 'd';
      else v = Math.round(s / 2592000) + 'mo';
      if (v === 'just now') return v;
      return f ? 'in ' + v : v + ' ago';
    },
    duration: function (ms) {
      var s = Math.max(0, Math.floor(ms / 1000));
      var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(ss);
    },
    initials: function (name) {
      return String(name).split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
    }
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  LC.store = {
    UPLOAD: UPLOAD, PAYROLL: PAYROLL,
    load: load, save: save, reset: reset, commit: commit, flush: flush,
    isOffline: isOffline, setForcedOffline: setForcedOffline,
    get db() { return db; },
    uid: uid, iso: iso,
    currentUser: currentUser, login: login, logout: logout, register: register,
    requestPasswordReset: requestPasswordReset,
    notify: notify, inbox: inbox, unreadCount: unreadCount, markAllRead: markAllRead,
    foldersFor: foldersFor, resourcesIn: resourcesIn, sessionsFor: sessionsFor,
    requestsFor: requestsFor, invoicesFor: invoicesFor, userById: userById,
    validateUpload: validateUpload, payrollLine: payrollLine, payrollRun: payrollRun,
    minuteRate: minuteRate
  };
  LC.fmt = fmt;
  LC.esc = esc;
})();
