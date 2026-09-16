/* ============================================================
   LogicClass+ — operations layer
   Every mutation the UI performs goes through here, so the same
   screens work against two backends:
     local  — seeded demo data in localStorage, no server
     remote — the Node/Express + Prisma API in apps/server
   Views stay synchronous: remote operations write the result
   back into the same in-memory shape the local mode uses.
   ============================================================ */
(function () {
  var S = LC.store;
  var api = LC.api;
  var mode = 'local';
  var resolved = Promise.resolve();

  function isRemote() { return mode === 'remote'; }
  function setMode(next) { mode = next; }

  /* ===================== hydration from the API ===================== */
  function hydrate() {
    var db = S.db;
    return api.get('/auth/me').then(function (me) {
      db.me = me.user;
      var jobs = [
        api.get('/users').then(function (r) { db.users = r.users; }),
        api.get('/library/folders').then(function (r) {
          db.folders = r.folders;
          return Promise.all(r.folders.map(function (f) {
            return api.get('/library/folders/' + f.id + '/resources')
              .then(function (x) { return x.resources; })
              .catch(function () { return []; });
          })).then(function (lists) {
            db.resources = lists.reduce(function (all, list) { return all.concat(list); }, []);
          });
        }),
        api.get('/announcements').then(function (r) { db.announcements = r.announcements; }),
        api.get('/classes/requests').then(function (r) { db.requests = r.requests; }),
        api.get('/classes/sessions').then(function (r) { db.sessions = r.sessions; }),
        api.get('/notifications').then(function (r) { db.notifications = r.notifications; })
      ];

      if (me.user.role === 'teacher' || me.user.role === 'owner') {
        jobs.push(api.get('/attendance').then(function (r) {
          db.attendance = r.attendance;
          if (r.policy) {
            S.PAYROLL.graceMinutes = r.policy.graceMinutes;
            S.PAYROLL.latePenalty = r.policy.latePenalty;
            S.PAYROLL.currency = r.policy.currency;
          }
        }));
        jobs.push(api.get('/payroll/batches').then(function (r) { db.payroll = r.batches; }));
      } else {
        db.attendance = [];
        db.payroll = [];
      }

      if (me.user.role === 'owner' || me.user.role === 'student') {
        jobs.push(api.get('/billing/invoices').then(function (r) { db.invoices = r.invoices; }));
      } else {
        db.invoices = [];
      }

      if (me.user.role === 'owner') {
        jobs.push(api.get('/users/reset-requests').then(function (r) { db.resets = r.resets; })
          .catch(function () { db.resets = []; }));
      } else {
        db.resets = [];
      }

      return Promise.all(jobs);
    }).then(function () { return S.db; });
  }

  function refresh() { return isRemote() ? hydrate() : resolved; }

  /* ===================== connection lifecycle ===================== */
  function connect(url) {
    return api.health(url).then(function (info) {
      api.setServer(url);
      setMode('remote');
      return info;
    });
  }

  function disconnect() {
    api.disconnect();
    api.setToken('');
    api.setServer('');
    setMode('local');
    S.load();
  }

  /**
   * Called once at boot. If a server is configured and the stored token still
   * works we come up in remote mode; anything else falls back to demo data
   * rather than showing an error the user cannot act on.
   */
  function bootstrap() {
    S.load();
    if (!api.isConfigured()) { setMode('local'); return resolved; }
    return api.health().then(function () {
      setMode('remote');
      if (!api.token()) return null;
      return hydrate().then(function () { api.connectSocket(); });
    }).catch(function () {
      setMode('local');
      api.setToken('');
    });
  }

  function currentUser() {
    if (isRemote()) return S.db.me || null;
    return S.currentUser();
  }

  /* ========================== auth ========================== */
  function login(email, password) {
    if (!isRemote()) {
      var r = S.login(email, password);
      if (r.error) return Promise.reject(new Error(r.error));
      return Promise.resolve(r.user);
    }
    return api.post('/auth/login', { email: email, password: password }).then(function (r) {
      api.setToken(r.token);
      return hydrate().then(function () {
        api.connectSocket();
        return r.user;
      });
    });
  }

  function register(input) {
    if (!isRemote()) {
      var r = S.register(input);
      if (r.error) return Promise.reject(new Error(r.error));
      return Promise.resolve(r.user);
    }
    return api.post('/auth/register', {
      name: input.name, email: input.email, password: input.password,
      role: input.role, subjects: input.subjects,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    }).then(function (r) { return r.user; });
  }

  function logout() {
    if (!isRemote()) { S.logout(); return resolved; }
    return api.post('/auth/logout', {}).catch(function () { return null; }).then(function () {
      api.setToken('');
      api.disconnect();
      S.db.me = null;
    });
  }

  function requestPasswordReset(email) {
    if (!isRemote()) { S.requestPasswordReset(email); return resolved; }
    return api.post('/auth/password-reset', { email: email });
  }

  /* ========================== admin ========================== */
  function approveUser(id) {
    if (!isRemote()) {
      S.commit('user:approve:' + id, function (d) {
        var u = d.users.find(function (x) { return x.id === id; });
        if (u) { u.status = 'active'; S.notify(u.id, 'account', 'Your account is approved', 'You can sign in and start using LogicClass+.'); }
      });
      return resolved;
    }
    return api.patch('/users/' + id + '/approve', {}).then(refresh);
  }

  function rejectUser(id) {
    if (!isRemote()) {
      S.commit('user:reject:' + id, function (d) {
        d.users = d.users.filter(function (x) { return x.id !== id; });
      });
      return resolved;
    }
    // A pending account is suspended first, then removed — the server refuses
    // to delete an active account outright.
    return api.patch('/users/' + id + '/status', { status: 'suspended' })
      .then(function () { return api.del('/users/' + id); })
      .then(refresh);
  }

  function toggleSuspend(id) {
    var user = S.userById(id);
    var next = user.status === 'suspended' ? 'active' : 'suspended';
    if (!isRemote()) {
      S.commit('user:suspend:' + id, function (d) {
        var u = d.users.find(function (x) { return x.id === id; });
        if (u) u.status = next;
      });
      return resolved;
    }
    return api.patch('/users/' + id + '/status', { status: next }).then(refresh);
  }

  function resolveReset(id, decision) {
    if (!isRemote()) {
      S.commit('reset:' + decision + ':' + id, function (d) {
        var r = d.resets.find(function (x) { return x.id === id; });
        if (!r) return;
        r.status = decision === 'approve' ? 'approved' : 'rejected';
        if (decision === 'approve') {
          S.notify(r.userId, 'password', 'Reset link sent',
            'Check your inbox — the link works once and expires in 30 minutes.');
        }
      });
      return resolved;
    }
    return api.patch('/users/reset-requests/' + id, { decision: decision }).then(function (r) {
      return refresh().then(function () { return r; });
    });
  }

  function saveProfile(input) {
    if (!isRemote()) {
      var me = S.currentUser();
      S.commit('profile:save', function (d) {
        var u = d.users.find(function (x) { return x.id === me.id; });
        if (input.name) u.name = input.name;
        if (input.locale) u.locale = input.locale;
        if (input.timezone) u.tz = input.timezone;
        if (input.hourlyRate != null) u.hourlyRate = input.hourlyRate;
      });
      return resolved;
    }
    return api.patch('/users/me', input).then(refresh);
  }

  /* ========================== library ========================== */
  function createFolder(name, subject) {
    if (!isRemote()) {
      var me = S.currentUser();
      var id = S.uid('fld');
      S.commit('folder:create', function (d) {
        d.folders.push({ id: id, teacherId: me.id, name: name, subject: subject, createdAt: S.iso(Date.now()) });
      });
      return Promise.resolve({ id: id });
    }
    return api.post('/library/folders', { name: name, subject: subject }).then(function (r) {
      return refresh().then(function () { return r.folder; });
    });
  }

  /**
   * Two-step upload: the server validates and issues a ticket, then the bytes
   * go to S3 with the presigned PUT (or to the API when no bucket is set), and
   * only then is the resource row created.
   */
  function uploadFile(folderId, file) {
    var check = S.validateUpload(file);
    if (!check.ok) return Promise.reject(new Error(check.message));

    if (!isRemote()) {
      var me = S.currentUser();
      S.commit('resource:upload', function (d) {
        d.resources.push({
          id: S.uid('res'), folderId: folderId, teacherId: me.id, name: file.name,
          ext: check.ext, bytes: file.size, uploadedAt: S.iso(Date.now())
        });
      });
      return resolved;
    }

    return api.post('/library/uploads', {
      folderId: folderId, filename: file.name, bytes: file.size, mimeType: file.type || undefined
    }).then(function (r) {
      var ticket = r.ticket;
      if (ticket.driver === 's3' && ticket.uploadUrl) {
        return fetch(ticket.uploadUrl, {
          method: 'PUT', body: file,
          headers: file.type ? { 'content-type': file.type } : {}
        }).then(function (res) {
          if (!res.ok) throw new Error('The storage service rejected the upload (' + res.status + ').');
          return ticket;
        });
      }
      return fileToBase64(file).then(function (b64) {
        return api.post('/library/uploads/local', { storageKey: ticket.storageKey, dataBase64: b64 })
          .then(function () { return ticket; });
      });
    }).then(function (ticket) {
      return api.post('/library/resources', {
        folderId: folderId, filename: file.name, bytes: file.size,
        storageKey: ticket.storageKey, mimeType: file.type || undefined
      });
    }).then(refresh);
  }

  function fileToBase64(file) {
    return new Promise(function (resolveB64, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        resolveB64(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = function () { reject(new Error('Could not read that file.')); };
      reader.readAsDataURL(file);
    });
  }

  function deleteResource(id) {
    if (!isRemote()) {
      S.commit('resource:delete:' + id, function (d) {
        d.resources = d.resources.filter(function (r) { return r.id !== id; });
      });
      return resolved;
    }
    return api.del('/library/resources/' + id).then(refresh);
  }

  function resourceUrl(id) {
    if (!isRemote()) return Promise.resolve({ url: null });
    return api.get('/library/resources/' + id + '/url');
  }

  /* ========================== announcements ========================== */
  function postAnnouncement(input) {
    if (!isRemote()) {
      var me = S.currentUser();
      S.commit('announcement:create', function (d) {
        d.announcements.unshift({
          id: S.uid('ann'), authorId: me.id, title: input.title, body: input.body,
          audience: input.audience, pinned: input.pinned, createdAt: S.iso(Date.now())
        });
        d.users.forEach(function (u) {
          if (u.id === me.id) return;
          var hit = input.audience === 'all'
            || (input.audience === 'teachers' && u.role === 'teacher')
            || (input.audience === 'students' && u.role === 'student');
          if (hit) S.notify(u.id, 'announcement', input.title, input.body.slice(0, 90));
        });
      });
      return resolved;
    }
    return api.post('/announcements', input).then(refresh);
  }

  function deleteAnnouncement(id) {
    if (!isRemote()) {
      S.commit('announcement:delete:' + id, function (d) {
        d.announcements = d.announcements.filter(function (a) { return a.id !== id; });
      });
      return resolved;
    }
    return api.del('/announcements/' + id).then(refresh);
  }

  /* ========================== classes ========================== */
  function createRequest(input) {
    if (!isRemote()) {
      var me = S.currentUser();
      S.commit('request:create', function (d) {
        d.requests.unshift({
          id: S.uid('req'), studentId: me.id, teacherId: input.teacherId, subject: input.subject,
          topic: input.topic, requestedFor: input.requestedFor, minutes: input.minutes,
          status: 'pending', note: input.note, createdAt: S.iso(Date.now())
        });
        S.notify(input.teacherId, 'class_request', 'New class request',
          me.name + ' requested ' + input.subject + ' — ' + input.topic + '.');
      });
      return resolved;
    }
    return api.post('/classes/requests', input).then(refresh);
  }

  function decideRequest(id, decision) {
    if (!isRemote()) {
      S.commit('request:' + decision + ':' + id, function (d) {
        var r = d.requests.find(function (x) { return x.id === id; });
        if (!r) return;
        if (decision === 'decline') {
          r.status = 'declined';
          S.notify(r.studentId, 'session', 'Class request declined', 'Try another time slot, or a different teacher.');
          return;
        }
        r.status = 'accepted';
        d.sessions.push({
          id: S.uid('ses'), requestId: r.id, teacherId: r.teacherId, studentId: r.studentId,
          subject: r.subject, topic: r.topic, startsAt: r.requestedFor, minutes: r.minutes,
          status: 'scheduled', recordingUrl: null
        });
        S.notify(r.studentId, 'session', 'Class accepted',
          S.userById(r.teacherId).name + ' accepted “' + r.topic + '”.');
      });
      return resolved;
    }
    return api.patch('/classes/requests/' + id, { decision: decision }).then(refresh);
  }

  function joinSession(id) {
    if (!isRemote()) {
      S.commit('session:join:' + id, function (d) {
        var s = d.sessions.find(function (x) { return x.id === id; });
        if (s) { s.status = 'live'; s.joinedAt = S.iso(Date.now()); }
      });
      return Promise.resolve({ peers: [] });
    }
    return api.post('/classes/sessions/' + id + '/join', {}).then(function (r) {
      var s = S.db.sessions.find(function (x) { return x.id === id; });
      if (s) Object.assign(s, r.session);
      // Joining the socket room answers with whoever is already in it.
      return new Promise(function (done) {
        var settled = false;
        var finish = function (peers) {
          if (settled) return;
          settled = true;
          done({ session: r.session, peers: peers || [] });
        };
        if (!api.socket()) { finish([]); return; }
        api.emit('classroom:join', id, function (ack) { finish(ack && ack.peers); });
        setTimeout(function () { finish([]); }, 2500);
      });
    });
  }

  function leaveSession(id) {
    if (!isRemote()) {
      S.commit('session:leave:' + id, function (d) {
        var s = d.sessions.find(function (x) { return x.id === id; });
        if (s && s.status === 'live') s.status = 'scheduled';
      });
      return resolved;
    }
    api.emit('classroom:leave', id);
    return api.post('/classes/sessions/' + id + '/leave', {}).then(refresh);
  }

  function completeSession(id, outcome) {
    if (!isRemote()) {
      S.commit('session:' + outcome + ':' + id, function (d) {
        var s = d.sessions.find(function (x) { return x.id === id; });
        if (!s) return;
        s.status = outcome === 'completed' ? 'completed' : 'no_show';
        s.endedAt = S.iso(Date.now());
        var att = d.attendance.find(function (a) { return a.sessionId === id; });
        if (att && !att.clockOut) att.clockOut = S.iso(Date.now());
        if (outcome === 'completed') {
          S.notify(s.studentId, 'session', 'Class finished', s.topic + ' — your teacher marked it complete.');
        }
      });
      return resolved;
    }
    return api.post('/classes/sessions/' + id + '/complete', { outcome: outcome }).then(refresh);
  }

  function loadSession(id) {
    if (!isRemote()) {
      return Promise.resolve({
        messages: S.db.chats[id] || [],
        documents: {
          board: S.db.docs['board_' + id],
          document: S.db.docs['doc_' + id],
          equation: S.db.docs['eq_' + id]
        }
      });
    }
    return api.get('/classes/sessions/' + id);
  }

  function saveDocument(sessionId, kind, content) {
    if (!isRemote()) {
      var key = kind === 'document' ? 'doc_' : kind === 'equation' ? 'eq_' : 'board_';
      S.commit('document:save', function (d) { d.docs[key + sessionId] = content; });
      return resolved;
    }
    return api.put('/classes/sessions/' + sessionId + '/documents', { kind: kind, content: content });
  }

  function sendChat(sessionId, text) {
    var me = currentUser();
    if (!isRemote()) {
      S.commit('chat:send', function (d) {
        d.chats[sessionId] = d.chats[sessionId] || [];
        d.chats[sessionId].push({ id: S.uid('msg'), from: me.id, text: text, at: S.iso(Date.now()) });
      });
      return Promise.resolve({ from: me.id, text: text, local: true });
    }
    if (api.socket()) {
      api.emit('chat:send', { sessionId: sessionId, text: text });
      return Promise.resolve({ from: me.id, text: text, viaSocket: true });
    }
    return api.post('/classes/sessions/' + sessionId + '/messages', { text: text })
      .then(function (r) { return r.message; });
  }

  /* ========================== attendance ========================== */
  function clockIn(sessionId) {
    if (!isRemote()) {
      var me = S.currentUser();
      var ses = S.db.sessions.find(function (s) { return s.id === sessionId; });
      var late = Math.max(0, Math.round((Date.now() - new Date(ses.startsAt).getTime()) / 60000));
      S.commit('attendance:in:' + sessionId, function (d) {
        d.attendance.unshift({
          id: S.uid('att'), teacherId: me.id, sessionId: sessionId, scheduledStart: ses.startsAt,
          clockIn: S.iso(Date.now()), clockOut: null, minutesLate: late
        });
      });
      return Promise.resolve({ minutesLate: late });
    }
    return api.post('/attendance/clock-in', { sessionId: sessionId }).then(function (r) {
      return refresh().then(function () { return r.attendance; });
    });
  }

  function clockOut(attendanceId) {
    if (!isRemote()) {
      S.commit('attendance:out:' + attendanceId, function (d) {
        var a = d.attendance.find(function (x) { return x.id === attendanceId; });
        if (a) a.clockOut = S.iso(Date.now());
      });
      return resolved;
    }
    return api.post('/attendance/' + attendanceId + '/clock-out', {}).then(refresh);
  }

  function markNoShow(sessionId) {
    if (!isRemote()) return completeSession(sessionId, 'no_show');
    return api.post('/attendance/no-show', { sessionId: sessionId }).then(refresh);
  }

  /* ========================== payroll & billing ========================== */
  function runPayrollBatch() {
    if (!isRemote()) {
      var lines = S.payrollRun(Date.now() - 30 * 864e5, Date.now());
      S.commit('payroll:run', function (d) {
        d.payroll.push({
          id: S.uid('pay'), periodStart: S.iso(Date.now() - 30 * 864e5), periodEnd: S.iso(Date.now()),
          status: 'approved', createdAt: S.iso(Date.now()), lines: lines
        });
        lines.forEach(function (l) {
          S.notify(l.teacherId, 'payroll', 'Payroll approved',
            LC.fmt.money(l.net) + ' for ' + (l.minutes / 60).toFixed(1) + ' hours.');
        });
      });
      return Promise.resolve({ count: lines.length });
    }
    return api.post('/payroll/batches', {}).then(function (r) {
      return refresh().then(function () { return { count: r.batch.lines.length }; });
    });
  }

  function payInvoice(id) {
    if (!isRemote()) {
      S.commit('invoice:pay:' + id, function (d) {
        var i = d.invoices.find(function (x) { return x.id === id; });
        if (i) { i.status = 'paid'; i.paidAt = S.iso(Date.now()); }
      });
      return Promise.resolve({ mode: 'demo' });
    }
    return api.post('/billing/invoices/' + id + '/pay', {}).then(function (r) {
      return refresh().then(function () { return r; });
    });
  }

  function remindInvoice(id) {
    if (!isRemote()) {
      var inv = S.db.invoices.find(function (i) { return i.id === id; });
      S.notify(inv.studentId, 'billing', 'Payment reminder',
        inv.number + ' · ' + LC.fmt.money(inv.amount, inv.currency) + ' is due ' + LC.fmt.day(inv.dueAt) + '.');
      return resolved;
    }
    return api.post('/billing/invoices/' + id + '/remind', {}).then(refresh);
  }

  /* ========================== recording ========================== */
  /**
   * What a recording of this session would occupy. Available in demo mode too,
   * because the arithmetic is the same whether or not a media server exists.
   */
  var PRESET_BPS = {
    audio: 48e3, '360p': 448e3, '480p': 748e3, '720p': 1548e3, '1080p': 4064e3
  };

  function estimateRecording(minutes, preset) {
    var local = {
      minutes: minutes, preset: preset || '720p', configured: false,
      bytes: Math.round(PRESET_BPS[preset || '720p'] * minutes * 60 / 8 * 1.03),
      presets: Object.keys(PRESET_BPS).reduce(function (all, key) {
        all[key] = { label: key, bytes: Math.round(PRESET_BPS[key] * minutes * 60 / 8 * 1.03) };
        return all;
      }, {}),
      reason: 'No server is connected, so nothing can be recorded — this is the size it would be.'
    };
    if (!isRemote()) return Promise.resolve(local);
    return api.get('/recordings/estimate?minutes=' + minutes + (preset ? '&preset=' + preset : ''))
      .catch(function () { return local; });
  }

  function startRecording(sessionId) {
    if (!isRemote()) {
      return Promise.reject(new Error(
        'Recording happens on the media server, and no server is connected.'));
    }
    return api.post('/recordings/' + sessionId + '/start', {});
  }

  function stopRecording(sessionId) {
    if (!isRemote()) return Promise.reject(new Error('No server is connected.'));
    return api.post('/recordings/' + sessionId + '/stop', {});
  }

  /* ========================== notifications ========================== */
  function markNotificationsRead() {
    if (!isRemote()) { S.markAllRead(S.currentUser().id); return resolved; }
    return api.post('/notifications/read', {}).then(refresh);
  }

  /** Subscribes this browser to Web Push using the server's VAPID public key. */
  function subscribePush() {
    if (!isRemote()) return Promise.resolve({ configured: false, reason: 'demo' });
    return api.get('/notifications/push-key').then(function (r) {
      if (!r.configured) return { configured: false, reason: 'no-vapid' };
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(r.publicKey)
        });
      }).then(function (sub) {
        var json = sub.toJSON();
        return api.post('/notifications/subscribe', { endpoint: json.endpoint, keys: json.keys })
          .then(function () { return { configured: true }; });
      });
    });
  }

  function urlBase64ToUint8Array(base64) {
    var padding = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  LC.data = {
    isRemote: isRemote, setMode: setMode, bootstrap: bootstrap, refresh: refresh,
    connect: connect, disconnect: disconnect, currentUser: currentUser,
    login: login, register: register, logout: logout, requestPasswordReset: requestPasswordReset,
    approveUser: approveUser, rejectUser: rejectUser, toggleSuspend: toggleSuspend,
    resolveReset: resolveReset, saveProfile: saveProfile,
    createFolder: createFolder, uploadFile: uploadFile, deleteResource: deleteResource, resourceUrl: resourceUrl,
    postAnnouncement: postAnnouncement, deleteAnnouncement: deleteAnnouncement,
    createRequest: createRequest, decideRequest: decideRequest,
    joinSession: joinSession, leaveSession: leaveSession, completeSession: completeSession,
    loadSession: loadSession, saveDocument: saveDocument, sendChat: sendChat,
    clockIn: clockIn, clockOut: clockOut, markNoShow: markNoShow,
    runPayrollBatch: runPayrollBatch, payInvoice: payInvoice, remindInvoice: remindInvoice,
    markNotificationsRead: markNotificationsRead, subscribePush: subscribePush,
    estimateRecording: estimateRecording, startRecording: startRecording, stopRecording: stopRecording
  };
})();
