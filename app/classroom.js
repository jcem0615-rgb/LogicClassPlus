/* ============================================================
   LogicClass+ — 1-on-1 classroom
   Pre-call hardware check → room shell → Math suite
   (whiteboard, annotator, equation editor) and English suite
   (collaborative document, pronunciation recorder).
   Camera, microphone, MediaRecorder and audio analysis are real
   browser APIs. The peer is simulated: a second participant
   needs the Socket.io signalling server from the handoff.
   ============================================================ */
(function () {
  var S = LC.store, F = LC.fmt, esc = LC.esc;

  var R = {
    session: null, stream: null, audioCtx: null, analyser: null, raf: null,
    devices: { cams: [], mics: [], outs: [] },
    picked: { cam: '', mic: '' },
    joined: false, tab: 'whiteboard', camOn: true, micOn: true,
    startedAt: null, recorder: null, chunks: [], recording: false,
    board: { strokes: [], tool: 'pen', color: '#13222B', width: 3, undo: [], bg: null },
    ann: { strokes: [], tool: 'pen', color: '#A02B2B', width: 3, bg: null },
    voice: { rec: null, chunks: [], url: null, peaks: null, phrase: 0 }
  };

  var PHRASES = [
    { text: 'I\'d like a ship, not a sheep.', focus: '/ɪ/ vs /iː/',
      phonemes: [['ɪ', 'ship'], ['iː', 'sheep'], ['l', 'like'], ['d', 'would'], ['n', 'not']] },
    { text: 'She sells sea shells by the sea shore.', focus: '/ʃ/ vs /s/',
      phonemes: [['ʃ', 'she'], ['s', 'sells'], ['iː', 'sea'], ['l', 'shells'], ['ɔː', 'shore']] },
    { text: 'The thirty-three thieves thought they thrilled the throne.', focus: '/θ/ vs /ð/',
      phonemes: [['θ', 'thirty'], ['ð', 'the'], ['iː', 'thieves'], ['ɔː', 'thought'], ['r', 'thrilled']] }
  ];

  /* ============================ view ============================ */
  var room = {
    title: 'Classroom',
    sub: function () { return R.session ? R.session.topic : ''; },
    render: function (ctx) {
      var ses = S.db.sessions.find(function (s) { return s.id === ctx.params.id; });
      if (!ses) return LC.ui.empty('Session not found', 'That classroom does not exist or you do not have access to it.');
      var u = ctx.user;
      if (u.role !== 'owner' && ses.teacherId !== u.id && ses.studentId !== u.id) {
        return LC.ui.empty('Not your classroom', 'Only the teacher and student in this session can enter it.');
      }
      R.session = ses;
      var other = S.userById(u.id === ses.teacherId ? ses.studentId : ses.teacherId);
      var suite = ses.subject;

      var html = '<div class="room">';

      /* --- side: video + controls + chat --- */
      html += '<div class="room-side">';
      html += '<div class="vid" id="vid-remote"><canvas id="peer-canvas"></canvas>' +
        '<span class="tag">' + esc(other.name) + ' · simulated peer</span></div>';
      html += '<div class="vid" id="vid-local" style="aspect-ratio:16/11">' +
        '<video id="local-video" autoplay playsinline muted></video>' +
        '<div class="off hide" id="local-off">Camera off</div>' +
        '<span class="tag">You · ' + esc(u.name.split(' ')[0]) + '</span>' +
        '<div class="state" id="local-state"></div></div>';
      html += '<div class="panel stack" style="gap:10px">' +
        '<div class="row-between"><span class="eyebrow">Microphone</span>' +
        '<span class="mono small dim" id="room-timer">00:00</span></div>' +
        '<div class="meter"><i id="mic-meter"></i></div>' +
        '<div class="row" style="flex-wrap:wrap;gap:6px">' +
        '<button class="btn btn-sm" data-act="toggle-mic">Mute</button>' +
        '<button class="btn btn-sm" data-act="toggle-cam">Camera off</button>' +
        '<button class="btn btn-sm" data-act="open-devices">Devices</button>' +
        '<button class="btn btn-sm" data-act="toggle-record">Record</button>' +
        '<button class="btn btn-sm btn-danger" data-act="leave-room">Leave</button>' +
        '</div></div>';

      var msgs = S.db.chats[ses.id] || [];
      html += '<section class="card chat" style="flex:1"><div class="card-head" style="padding:10px 14px"><h3>Chat</h3>' +
        '<span class="small dim">' + msgs.length + ' messages</span></div>' +
        '<div class="chat-log" id="chat-log">' + msgs.map(chatBubble).join('') + '</div>' +
        '<form class="chat-form" data-act="send-chat"><input type="text" id="chat-input" placeholder="Message ' +
        esc(other.name.split(' ')[0]) + '" autocomplete="off"><button class="btn btn-primary btn-sm" type="submit">Send</button></form>' +
        '</section>';
      html += '</div>';

      /* --- stage: tools --- */
      html += '<section class="card tools">';
      html += '<div class="tabs">' +
        tabBtn('whiteboard', 'Whiteboard', 'math') +
        tabBtn('annotate', 'PDF / image', 'math') +
        tabBtn('equations', 'Equations', 'math') +
        tabBtn('document', 'Shared document', 'english') +
        tabBtn('speech', 'Pronunciation', 'english') +
        tabBtn('notes', 'Session', '') +
        '</div><div class="tab-body" id="tab-body"></div></section>';
      html += '</div>';

      /* --- hardware check gate --- */
      if (!R.joined) html += hardwareCheck(ses, other, suite);
      return html;
    },
    mount: function (ctx) {
      if (!R.session) return;
      paintPeer();
      renderTab();
      if (!R.joined) { startPreview(); }
      else { attachStream(); startTimer(); }
    },
    unmount: function () { teardown(); }
  };

  function tabBtn(id, label, suite) {
    return '<button data-act="tab" data-tab="' + id + '"' + (suite ? ' data-suite="' + suite + '"' : '') +
      ' class="' + (R.tab === id ? 'on' : '') + '">' + esc(label) + '</button>';
  }
  function chatBubble(m) {
    var me = S.currentUser();
    var mine = me && m.from === me.id;
    return '<div class="msg ' + (mine ? 'me' : 'them') + '">' +
      (mine ? '' : '<div class="who">' + esc(S.userById(m.from).name.split(' ')[0]) + '</div>') +
      esc(m.text) + '</div>';
  }

  /* ====================== hardware check ====================== */
  function hardwareCheck(ses, other, suite) {
    return '<div class="scrim" id="hw-scrim"><div class="modal">' +
      '<div class="modal-head"><div><span class="eyebrow">Before you join</span>' +
      '<h2 style="margin-top:5px">Check your camera and microphone</h2>' +
      '<p class="small muted" style="margin-top:4px">' + esc(ses.topic) + ' · with ' + esc(other.name) +
      ' · ' + ses.minutes + ' minutes</p></div>' +
      (suite === 'math' ? '<span class="pill pill-math">Math suite</span>' : '<span class="pill pill-english">English suite</span>') +
      '</div><div class="modal-body">' +
      '<div class="vid" style="aspect-ratio:16/9"><video id="hw-video" autoplay playsinline muted></video>' +
      '<div class="off hide" id="hw-off"></div></div>' +
      '<div class="stack" style="gap:8px"><div class="row-between"><span class="eyebrow">Mic level — say something</span>' +
      '<span class="small dim" id="hw-mic-label">waiting</span></div>' +
      '<div class="meter"><i id="hw-meter"></i></div></div>' +
      '<div class="form-grid">' +
      '<label class="field">Camera<select id="hw-cam"><option>Checking…</option></select></label>' +
      '<label class="field">Microphone<select id="hw-mic"><option>Checking…</option></select></label>' +
      '</div>' +
      '<div id="hw-error"></div>' +
      '</div><div class="modal-foot">' +
      '<a class="btn" href="#/classes">Cancel</a>' +
      '<button class="btn btn-primary" data-act="join-room" id="hw-join">Join classroom</button>' +
      '</div></div></div>';
  }

  function startPreview() {
    var video = document.getElementById('hw-video');
    getStream().then(function () {
      if (video && R.stream) video.srcObject = R.stream;
      listDevices();
      meter('hw-meter', 'hw-mic-label');
    }).catch(function (err) {
      var box = document.getElementById('hw-error');
      var off = document.getElementById('hw-off');
      if (off) { off.classList.remove('hide'); off.textContent = 'No camera preview'; }
      if (box) {
        box.innerHTML = '<div class="flag"><b>Camera and microphone are blocked</b><div>' + esc(describeMediaError(err)) +
          '<br>You can still join — the whiteboard, document, equation editor and chat all work without them.</div></div>';
      }
    });
  }

  function describeMediaError(err) {
    var n = err && err.name;
    if (n === 'NotAllowedError') return 'The browser denied access. Allow camera and microphone for this page, then reload. In an embedded preview, open the page in its own tab first.';
    if (n === 'NotFoundError') return 'No camera or microphone was found on this device.';
    if (n === 'NotReadableError') return 'Another application is already using the camera.';
    return 'Media devices are unavailable here (' + (n || 'unknown error') + ').';
  }

  function getStream() {
    var c = {
      video: R.picked.cam ? { deviceId: { exact: R.picked.cam } } : true,
      audio: R.picked.mic ? { deviceId: { exact: R.picked.mic } } : true
    };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('unsupported'));
    }
    stopStream();
    return navigator.mediaDevices.getUserMedia(c).then(function (s) { R.stream = s; return s; });
  }
  function stopStream() {
    if (R.stream) { R.stream.getTracks().forEach(function (t) { t.stop(); }); R.stream = null; }
  }

  function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (list) {
      R.devices.cams = list.filter(function (d) { return d.kind === 'videoinput'; });
      R.devices.mics = list.filter(function (d) { return d.kind === 'audioinput'; });
      fill('hw-cam', R.devices.cams, R.picked.cam);
      fill('hw-mic', R.devices.mics, R.picked.mic);
    });
  }
  function fill(id, devices, selected) {
    var sel = document.getElementById(id);
    if (!sel) return;
    if (!devices.length) { sel.innerHTML = '<option>None detected</option>'; sel.disabled = true; return; }
    sel.disabled = false;
    sel.innerHTML = devices.map(function (d, i) {
      return '<option value="' + esc(d.deviceId) + '"' + (d.deviceId === selected ? ' selected' : '') + '>' +
        esc(d.label || (id === 'hw-cam' ? 'Camera ' : 'Microphone ') + (i + 1)) + '</option>';
    }).join('');
  }

  /* live mic level from a real AnalyserNode */
  function meter(barId, labelId) {
    if (!R.stream || !R.stream.getAudioTracks().length) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      R.audioCtx = R.audioCtx || new Ctx();
      var src = R.audioCtx.createMediaStreamSource(R.stream);
      var an = R.audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      R.analyser = an;
      var buf = new Uint8Array(an.fftSize);
      var bar = document.getElementById(barId);
      var label = labelId ? document.getElementById(labelId) : null;
      var peak = 0;
      (function loop() {
        if (!document.getElementById(barId)) { return; }
        an.getByteTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
        var rms = Math.sqrt(sum / buf.length);
        var pct = Math.min(100, Math.round(rms * 320));
        if (bar) bar.style.width = pct + '%';
        peak = Math.max(peak, pct);
        if (label) label.textContent = peak > 8 ? 'sounds good' : 'waiting';
        R.raf = requestAnimationFrame(loop);
      })();
    } catch (e) { /* audio graph unavailable */ }
  }

  /* ====================== room lifecycle ====================== */
  function join() {
    R.joined = true;
    R.startedAt = Date.now();
    var ses = R.session;
    S.commit('session:join:' + ses.id, function (d) {
      var s = d.sessions.find(function (x) { return x.id === ses.id; });
      if (s) { s.status = 'live'; s.joinedAt = S.iso(Date.now()); }
    });
    LC.app.toast('ok', 'You are in', 'Signalling would now run over Socket.io — the peer here is simulated.');
    LC.app.render();
  }

  function attachStream() {
    var v = document.getElementById('local-video');
    var off = document.getElementById('local-off');
    if (R.stream && v) {
      v.srcObject = R.stream;
      meter('mic-meter');
      if (off) off.classList.add('hide');
    } else if (off) {
      off.classList.remove('hide');
      off.textContent = 'Camera unavailable';
    }
    paintState();
  }

  function paintState() {
    var el = document.getElementById('local-state');
    if (!el) return;
    var s = '';
    if (!R.micOn) s += '<span class="pill pill-crit">Muted</span>';
    if (!R.camOn) s += '<span class="pill pill-crit">No video</span>';
    if (R.recording) s += '<span class="pill pill-crit"><i class="dot"></i>REC</span>';
    el.innerHTML = s;
  }

  function startTimer() {
    LC.app.interval(function () {
      var t = document.getElementById('room-timer');
      if (t && R.startedAt) t.textContent = F.duration(Date.now() - R.startedAt);
      paintPeerFrame();
    }, 1000);
  }

  function teardown() {
    stopStream();
    if (R.raf) cancelAnimationFrame(R.raf);
    if (R.audioCtx && R.audioCtx.state !== 'closed') { try { R.audioCtx.close(); } catch (e) {} }
    R.audioCtx = null; R.analyser = null;
    if (R.recorder && R.recorder.state === 'recording') { try { R.recorder.stop(); } catch (e) {} }
    if (R.voice.rec && R.voice.rec.state === 'recording') { try { R.voice.rec.stop(); } catch (e) {} }
    R.joined = false; R.startedAt = null; R.recording = false;
  }

  /* simulated peer tile — a rendered stand-in, never presented as a real feed */
  var peerPhase = 0;
  function paintPeer() {
    var c = document.getElementById('peer-canvas');
    if (!c) return;
    var box = c.parentElement.getBoundingClientRect();
    c.width = Math.max(320, Math.round(box.width));
    c.height = Math.max(200, Math.round(box.height));
    paintPeerFrame();
  }
  function paintPeerFrame() {
    var c = document.getElementById('peer-canvas');
    if (!c || !c.getContext) return;
    var g = c.getContext('2d'), w = c.width, h = c.height;
    peerPhase += 0.06;
    var grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, '#0E2B2A'); grd.addColorStop(1, '#0A1618');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    var ses = R.session;
    var me = S.currentUser();
    var other = ses ? S.userById(me && me.id === ses.teacherId ? ses.studentId : ses.teacherId) : { name: '· ·' };
    // soft ring
    g.strokeStyle = 'rgba(79,191,175,.28)';
    for (var i = 0; i < 3; i++) {
      g.beginPath();
      g.lineWidth = 1.5;
      g.arc(w / 2, h / 2, 54 + i * 16 + Math.sin(peerPhase + i) * 4, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = '#0B6B62';
    g.beginPath(); g.arc(w / 2, h / 2, 40, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#EAF6F3';
    g.font = '600 26px "IBM Plex Sans", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(F.initials(other.name), w / 2, h / 2 + 1);
    g.font = '400 12px "IBM Plex Mono", monospace';
    g.fillStyle = 'rgba(201,231,225,.75)';
    g.fillText('waiting for signalling server', w / 2, h / 2 + 68);
  }

  /* ========================= tab bodies ========================= */
  function renderTab() {
    var body = document.getElementById('tab-body');
    if (!body) return;
    var map = { whiteboard: tabWhiteboard, annotate: tabAnnotate, equations: tabEquations, document: tabDocument, speech: tabSpeech, notes: tabNotes };
    body.innerHTML = (map[R.tab] || tabNotes)();
    if (R.tab === 'whiteboard') initBoard('board', R.board);
    if (R.tab === 'annotate') initBoard('ann', R.ann);
    if (R.tab === 'equations') renderMath();
    if (R.tab === 'document') initDoc();
    if (R.tab === 'speech') drawWave();
  }

  function palette(prefix, cur) {
    return ['#13222B', '#A02B2B', '#2E5AAC', '#1C7A4B', '#845F00', '#7A3BAF'].map(function (c) {
      return '<button class="swatch ' + (c === cur ? 'on' : '') + '" style="background:' + c + '" data-act="' + prefix + '-color" data-color="' + c + '" aria-label="colour ' + c + '"></button>';
    }).join('');
  }

  function tabWhiteboard() {
    return '<div class="stack" style="gap:10px">' +
      '<div class="toolbar">' +
      '<button class="btn btn-sm' + (R.board.tool === 'pen' ? ' btn-primary' : '') + '" data-act="board-tool" data-tool="pen">Pen</button>' +
      '<button class="btn btn-sm' + (R.board.tool === 'marker' ? ' btn-primary' : '') + '" data-act="board-tool" data-tool="marker">Highlighter</button>' +
      '<button class="btn btn-sm' + (R.board.tool === 'line' ? ' btn-primary' : '') + '" data-act="board-tool" data-tool="line">Line</button>' +
      '<button class="btn btn-sm' + (R.board.tool === 'rect' ? ' btn-primary' : '') + '" data-act="board-tool" data-tool="rect">Box</button>' +
      '<button class="btn btn-sm' + (R.board.tool === 'eraser' ? ' btn-primary' : '') + '" data-act="board-tool" data-tool="eraser">Eraser</button>' +
      '<span class="sep"></span>' + palette('board', R.board.color) +
      '<span class="sep"></span>' +
      '<input type="range" min="1" max="18" value="' + R.board.width + '" data-act="board-width" style="width:90px" aria-label="Stroke width">' +
      '<span class="sep"></span>' +
      '<button class="btn btn-sm" data-act="board-undo">Undo</button>' +
      '<button class="btn btn-sm" data-act="board-clear">Clear</button>' +
      '<button class="btn btn-sm btn-primary" data-act="board-save">Save to library</button>' +
      '</div>' +
      '<div class="board-wrap" id="board-wrap"><canvas id="board-canvas"></canvas></div>' +
      '<p class="small dim">Strokes are kept as vectors, so undo and resize stay sharp. In production each stroke is broadcast on ' +
      '<span class="mono">classroom:board:stroke</span> over the room\'s socket channel.</p>' +
      '</div>';
  }

  function tabAnnotate() {
    return '<div class="stack" style="gap:10px">' +
      '<div class="toolbar">' +
      '<label class="btn btn-sm" for="ann-file">Open PDF or image</label>' +
      '<input id="ann-file" type="file" accept=".pdf,image/*" class="hide" data-act="ann-open">' +
      '<span class="sep"></span>' + palette('ann', R.ann.color) +
      '<span class="sep"></span>' +
      '<button class="btn btn-sm' + (R.ann.tool === 'pen' ? ' btn-primary' : '') + '" data-act="ann-tool" data-tool="pen">Pen</button>' +
      '<button class="btn btn-sm' + (R.ann.tool === 'marker' ? ' btn-primary' : '') + '" data-act="ann-tool" data-tool="marker">Highlighter</button>' +
      '<button class="btn btn-sm" data-act="ann-undo">Undo</button>' +
      '<button class="btn btn-sm" data-act="ann-clear">Clear ink</button>' +
      '<button class="btn btn-sm btn-primary" data-act="ann-save">Save to library</button>' +
      '</div>' +
      '<div class="board-wrap" id="ann-wrap"><canvas id="ann-canvas"></canvas></div>' +
      '<div id="ann-msg"></div>' +
      '<p class="small dim">Uploads are checked against the same rules as the library: 20 MB per file, allowed extensions only.</p>' +
      '</div>';
  }

  function tabEquations() {
    var saved = (S.db.docs['eq_' + R.session.id]) || '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}';
    return '<div class="stack" style="gap:12px">' +
      '<div class="row-between"><span class="eyebrow">LaTeX equation editor</span>' +
      '<span class="small dim">rendered with KaTeX → MathML</span></div>' +
      '<div class="katex-out" id="eq-out"></div>' +
      '<textarea id="eq-src" data-act="eq-input" spellcheck="false" style="font-family:var(--font-mono);min-height:90px">' + esc(saved) + '</textarea>' +
      '<div class="toolbar">' +
      ['\\frac{a}{b}', 'x^{2}', '\\sqrt{x}', '\\int_{0}^{1}', '\\sum_{i=1}^{n}', '\\lim_{x \\to 0}', '\\theta', '\\pi', '\\Delta', '\\approx'].map(function (t) {
        return '<button class="btn btn-sm mono" data-act="eq-insert" data-tex="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('') +
      '</div>' +
      '<div class="row" style="justify-content:flex-end;gap:8px">' +
      '<button class="btn btn-sm" data-act="eq-to-board">Send to whiteboard</button>' +
      '<button class="btn btn-sm btn-primary" data-act="eq-save">Save to session notes</button></div>' +
      '</div>';
  }

  function tabDocument() {
    var key = 'doc_' + R.session.id;
    var html = S.db.docs[key] || '<h2>Essay plan — describing a place</h2>' +
      '<p>Choose <b>one</b> place you know well. Write four sentences: where it is, what you do there, who you go with, and why it matters to you.</p>' +
      '<ul><li>Where: <i>the night market two streets from my grandmother\'s flat</i></li>' +
      '<li>What: …</li><li>Who: …</li><li>Why: …</li></ul>';
    var other = S.userById(S.currentUser().id === R.session.teacherId ? R.session.studentId : R.session.teacherId);
    return '<div class="stack" style="gap:10px">' +
      '<div class="row-between"><div class="row"><span class="presence"><i class="dot"></i>' + esc(other.name.split(' ')[0]) + ' · joined</span>' +
      '<span class="small dim mono" id="doc-count">0 words</span></div>' +
      '<button class="btn btn-sm btn-primary" data-act="doc-save">Save document</button></div>' +
      '<div class="toolbar" style="border-radius:var(--r-sm) var(--r-sm) 0 0;border-bottom:0">' +
      '<button class="btn btn-sm" data-act="doc-cmd" data-cmd="bold"><b>B</b></button>' +
      '<button class="btn btn-sm" data-act="doc-cmd" data-cmd="italic"><i>I</i></button>' +
      '<button class="btn btn-sm" data-act="doc-cmd" data-cmd="underline"><u>U</u></button>' +
      '<span class="sep"></span>' +
      '<button class="btn btn-sm" data-act="doc-cmd" data-cmd="formatBlock" data-val="h2">Heading</button>' +
      '<button class="btn btn-sm" data-act="doc-cmd" data-cmd="insertUnorderedList">List</button>' +
      '<button class="btn btn-sm" data-act="doc-cmd" data-cmd="insertOrderedList">Numbered</button>' +
      '<span class="sep"></span>' +
      '<button class="btn btn-sm" data-act="doc-correct">Mark a correction</button>' +
      '</div>' +
      '<div class="editor" id="doc-editor" contenteditable="true" spellcheck="true">' + html + '</div>' +
      '<p class="small dim">Production uses Tiptap with a Yjs document shared over <span class="mono">y-socket.io</span>, so both cursors and ' +
      'offline edits merge without conflicts. Here the text is local to your browser.</p>' +
      '</div>';
  }

  function tabSpeech() {
    var p = PHRASES[R.voice.phrase];
    return '<div class="stack" style="gap:12px">' +
      '<div class="row-between"><span class="eyebrow">Pronunciation drill · ' + esc(p.focus) + '</span>' +
      '<button class="btn btn-sm" data-act="next-phrase">Next phrase</button></div>' +
      '<div class="panel"><p style="font-size:19px;font-family:var(--font-display);line-height:1.4">' + esc(p.text) + '</p></div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<button class="btn ' + (R.voice.rec && R.voice.rec.state === 'recording' ? 'btn-danger' : 'btn-primary') + '" data-act="voice-record">' +
      (R.voice.rec && R.voice.rec.state === 'recording' ? 'Stop recording' : 'Record your attempt') + '</button>' +
      (R.voice.url ? '<button class="btn" data-act="voice-analyse">Analyse</button>' : '') +
      '</div>' +
      (R.voice.url ? '<audio controls src="' + R.voice.url + '" style="width:100%"></audio>' : '') +
      '<div class="panel"><div class="eyebrow" style="margin-bottom:8px">Waveform</div>' +
      '<div class="wave" id="wave">' + (R.voice.peaks ? '' : '<span class="small dim">Record to see your envelope.</span>') + '</div></div>' +
      '<div id="score-out"></div>' +
      '<div class="flag"><b>Scoring provider not chosen yet</b><div>The waveform above is measured from your real recording. ' +
      'Per-phoneme accuracy needs a speech API — Azure Speech pronunciation assessment, Google STT, or a self-hosted model. ' +
      'The handoff flags this as an open decision, so the scores below are a labelled placeholder, not a measurement.</div></div>' +
      '</div>';
  }

  function tabNotes() {
    var ses = R.session;
    var me = S.currentUser();
    var other = S.userById(me.id === ses.teacherId ? ses.studentId : ses.teacherId);
    return '<div class="stack">' +
      LC.ui.summary([
        { k: 'Subject', v: ses.subject === 'math' ? 'Math' : 'English' },
        { k: 'Planned', v: ses.minutes + ' min', s: F.dayTime(ses.startsAt) },
        { k: 'Status', v: ses.status === 'live' ? 'Live' : ses.status },
        { k: 'Recording', v: ses.recordingUrl ? 'Saved' : 'None' }
      ]) +
      '<div class="panel stack"><div class="row-between"><div><div style="font-weight:600">' + esc(ses.topic) + '</div>' +
      '<div class="small dim">' + esc(other.name) + ' · ' + esc(other.tz || '') + '</div></div>' +
      LC.ui.subjectPill(ses.subject) + '</div></div>' +
      (me.role === 'teacher'
        ? '<div class="row" style="gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-primary" data-act="end-session">End and mark complete</button>' +
          '<button class="btn" data-act="mark-noshow">Student did not show</button></div>'
        : '') +
      '<div class="flag"><b>Recording needs a media server</b><div>Browser-to-browser WebRTC gives the server no stream to record. ' +
      'The Record button here captures <i>your own</i> tracks with <span class="mono">MediaRecorder</span> and keeps the clip in the tab. ' +
      'Server-side recording into <span class="mono">ClassSession.recordingUrl</span> needs an SFU — LiveKit, mediasoup, or a managed service — ' +
      'which the handoff lists as a decision for you to make.</div></div>' +
      '</div>';
  }

  /* ========================= canvas board ========================= */
  function initBoard(kind, state) {
    var wrap = document.getElementById(kind === 'board' ? 'board-wrap' : 'ann-wrap');
    var c = document.getElementById(kind === 'board' ? 'board-canvas' : 'ann-canvas');
    if (!wrap || !c) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = wrap.clientWidth || 640;
    var h = Math.round(w * 0.62);
    c.width = w * dpr; c.height = h * dpr;
    c.style.height = h + 'px';
    var g = c.getContext('2d');
    g.scale(dpr, dpr);
    state.ctx = g; state.cssW = w; state.cssH = h;
    redraw(state);

    var drawing = false, cur = null;
    function pos(e) {
      var r = c.getBoundingClientRect();
      var p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left), y: (p.clientY - r.top) };
    }
    function down(e) {
      e.preventDefault();
      drawing = true;
      var p = pos(e);
      cur = { tool: state.tool, color: state.tool === 'eraser' ? '#FFFFFF' : state.color,
              width: state.tool === 'marker' ? state.width * 4 : state.tool === 'eraser' ? state.width * 5 : state.width,
              alpha: state.tool === 'marker' ? 0.28 : 1, points: [p] };
      state.strokes.push(cur);
    }
    function move(e) {
      if (!drawing) return;
      e.preventDefault();
      var p = pos(e);
      if (cur.tool === 'line' || cur.tool === 'rect') { cur.points[1] = p; }
      else { cur.points.push(p); }
      redraw(state);
    }
    function up() { drawing = false; cur = null; state.undo = []; }
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    c.addEventListener('pointerleave', up);
  }

  function redraw(state) {
    var g = state.ctx;
    if (!g) return;
    g.save();
    g.clearRect(0, 0, state.cssW, state.cssH);
    g.fillStyle = '#FFFFFF';
    g.fillRect(0, 0, state.cssW, state.cssH);
    if (state.bg) {
      var img = state.bg;
      var scale = Math.min(state.cssW / img.width, state.cssH / img.height);
      var w = img.width * scale, h = img.height * scale;
      g.drawImage(img, (state.cssW - w) / 2, (state.cssH - h) / 2, w, h);
    } else {
      // faint ruled grid, so an empty board still reads as a board
      g.strokeStyle = 'rgba(19,34,43,.07)';
      g.lineWidth = 1;
      for (var x = 32; x < state.cssW; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, state.cssH); g.stroke(); }
      for (var y = 32; y < state.cssH; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(state.cssW, y); g.stroke(); }
    }
    state.strokes.forEach(function (s) {
      g.globalAlpha = s.alpha == null ? 1 : s.alpha;
      g.strokeStyle = s.color; g.fillStyle = s.color;
      g.lineWidth = s.width; g.lineCap = 'round'; g.lineJoin = 'round';
      var p = s.points;
      if (!p.length) return;
      if (s.tool === 'rect' && p[1]) {
        g.strokeRect(p[0].x, p[0].y, p[1].x - p[0].x, p[1].y - p[0].y);
      } else if (s.tool === 'line' && p[1]) {
        g.beginPath(); g.moveTo(p[0].x, p[0].y); g.lineTo(p[1].x, p[1].y); g.stroke();
      } else if (s.tool === 'text') {
        g.font = '600 ' + (s.width * 6) + 'px "IBM Plex Sans", sans-serif';
        g.fillText(s.text, p[0].x, p[0].y);
      } else {
        g.beginPath(); g.moveTo(p[0].x, p[0].y);
        for (var i = 1; i < p.length; i++) g.lineTo(p[i].x, p[i].y);
        if (p.length === 1) { g.lineTo(p[0].x + .1, p[0].y + .1); }
        g.stroke();
      }
    });
    g.globalAlpha = 1;
    g.restore();
  }

  function saveBoardToLibrary(state, name) {
    var me = S.currentUser();
    var canvas = state.ctx && state.ctx.canvas;
    if (!canvas) return;
    var data;
    try { data = canvas.toDataURL('image/jpeg', 0.7); } catch (e) { data = null; }
    var teacherId = R.session.teacherId;
    if (me.role !== 'teacher') { LC.app.toast('warn', 'Teacher only', 'Only the teacher can file material into the library.'); return; }
    var folder = S.db.folders.filter(function (f) { return f.teacherId === teacherId; })[0];
    if (!folder) {
      folder = { id: S.uid('fld'), teacherId: teacherId, name: 'Session boards', subject: R.session.subject, createdAt: S.iso(Date.now()) };
      S.db.folders.push(folder);
    }
    var bytes = data ? Math.round(data.length * 0.75) : 0;
    S.commit('board:save', function (d) {
      d.resources.push({
        id: S.uid('res'), folderId: folder.id, teacherId: teacherId,
        name: name + '-' + new Date().toISOString().slice(0, 10) + '.jpg',
        ext: 'jpg', bytes: bytes, uploadedAt: S.iso(Date.now())
      });
      if (data && data.length < 900000) d.boards[R.session.id] = data;
      S.notify(R.session.studentId, 'resource', 'New material from your class',
        'Saved to ' + folder.name + ' · ' + name + '.jpg');
    });
    LC.app.toast('ok', 'Saved to library', F.bytes(bytes) + ' filed under “' + folder.name + '”.');
    LC.app.paintBell();
  }

  /* ========================= equations ========================= */
  function renderMath() {
    var src = document.getElementById('eq-src');
    var out = document.getElementById('eq-out');
    if (!src || !out) return;
    var tex = src.value;
    if (window.katex) {
      try {
        out.innerHTML = window.katex.renderToString(tex, { output: 'mathml', displayMode: true, throwOnError: true });
      } catch (err) {
        out.innerHTML = '<span class="small" style="color:var(--crit)">' + esc(String(err.message || err).slice(0, 160)) + '</span>';
      }
    } else {
      out.innerHTML = '<span class="mono small dim">' + esc(tex) + '</span>' +
        '<div class="small dim" style="margin-top:6px">KaTeX did not load — showing the source.</div>';
    }
  }

  /* ========================= document ========================= */
  function initDoc() {
    var ed = document.getElementById('doc-editor');
    if (!ed) return;
    var count = function () {
      var el = document.getElementById('doc-count');
      if (el) {
        var words = (ed.innerText || '').trim().split(/\s+/).filter(Boolean).length;
        el.textContent = words + ' word' + (words === 1 ? '' : 's');
      }
    };
    ed.addEventListener('input', count);
    count();
  }

  /* ========================= pronunciation ========================= */
  function voiceRecord() {
    if (R.voice.rec && R.voice.rec.state === 'recording') {
      R.voice.rec.stop();
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      LC.app.toast('err', 'Recording unavailable', 'This browser does not expose MediaRecorder.');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var rec = new MediaRecorder(stream);
      R.voice.rec = rec; R.voice.chunks = [];
      rec.ondataavailable = function (e) { if (e.data.size) R.voice.chunks.push(e.data); };
      rec.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(R.voice.chunks, { type: rec.mimeType || 'audio/webm' });
        if (R.voice.url) URL.revokeObjectURL(R.voice.url);
        R.voice.url = URL.createObjectURL(blob);
        analysePeaks(blob);
      };
      rec.start();
      renderTab();
      LC.app.toast('ok', 'Recording', 'Read the phrase out loud, then stop.');
    }).catch(function (err) {
      LC.app.toast('err', 'Microphone blocked', describeMediaError(err));
    });
  }

  /* real amplitude envelope from the recorded blob */
  function analysePeaks(blob) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { renderTab(); return; }
    blob.arrayBuffer().then(function (buf) {
      var ctx = new Ctx();
      return ctx.decodeAudioData(buf).then(function (audio) {
        var data = audio.getChannelData(0);
        var bars = 64, block = Math.floor(data.length / bars), peaks = [];
        for (var i = 0; i < bars; i++) {
          var sum = 0;
          for (var j = 0; j < block; j++) { var v = data[i * block + j] || 0; sum += v * v; }
          peaks.push(Math.sqrt(sum / block));
        }
        var max = Math.max.apply(null, peaks) || 1;
        R.voice.peaks = peaks.map(function (p) { return p / max; });
        R.voice.seconds = audio.duration;
        ctx.close();
        renderTab();
      });
    }).catch(function () { renderTab(); });
  }

  function drawWave() {
    var el = document.getElementById('wave');
    if (!el || !R.voice.peaks) return;
    el.innerHTML = R.voice.peaks.map(function (p) {
      return '<i style="height:' + Math.max(2, Math.round(p * 44)) + 'px"></i>';
    }).join('');
  }

  function analyseSpeech() {
    var p = PHRASES[R.voice.phrase];
    var peaks = R.voice.peaks || [];
    var energy = peaks.reduce(function (a, b) { return a + b; }, 0) / (peaks.length || 1);
    var base = Math.min(96, Math.max(58, Math.round(62 + energy * 46)));
    var out = document.getElementById('score-out');
    if (!out) return;
    var rows = p.phonemes.map(function (ph, i) {
      var score = Math.max(41, Math.min(99, base + ((i * 37) % 23) - 11));
      var tone = score >= 85 ? 'var(--ok)' : score >= 70 ? 'var(--warn)' : 'var(--crit)';
      return '<div class="ph"><span class="s mono" style="color:' + tone + '">' + score + '</span>' +
        '<span class="p mono">/' + esc(ph[0]) + '/</span><span class="small dim">' + esc(ph[1]) + '</span></div>';
    }).join('');
    out.innerHTML = '<div class="panel stack" style="gap:10px">' +
      '<div class="row-between"><span class="eyebrow">Placeholder score · not a measurement</span>' +
      '<span class="mono small">' + (R.voice.seconds ? R.voice.seconds.toFixed(1) + 's' : '') + '</span></div>' +
      '<div class="phonemes">' + rows + '</div>' +
      '<div class="row-between"><span class="small muted">Overall</span>' +
      '<div class="row" style="flex:1;max-width:260px"><div class="bar-track grow"><i style="width:' + base + '%"></i></div>' +
      '<span class="mono small">' + base + '/100</span></div></div></div>';
  }

  /* ========================= file open ========================= */
  function openAnnotationFile(file) {
    var msg = document.getElementById('ann-msg');
    var v = S.validateUpload(file);
    if (!v.ok) { if (msg) msg.innerHTML = '<div class="flag"><b>Not accepted</b><div>' + esc(v.message) + '</div></div>'; return; }
    if (msg) msg.innerHTML = '';
    if (v.ext === 'pdf') {
      if (!window.pdfjsLib) {
        if (msg) msg.innerHTML = '<div class="flag"><b>PDF viewer unavailable</b><div>pdf.js did not load in this preview. Open a PNG or JPG to annotate instead.</div></div>';
        return;
      }
      file.arrayBuffer().then(function (buf) {
        return window.pdfjsLib.getDocument({ data: buf }).promise;
      }).then(function (pdf) {
        return pdf.getPage(1);
      }).then(function (page) {
        var vp = page.getViewport({ scale: 2 });
        var tmp = document.createElement('canvas');
        tmp.width = vp.width; tmp.height = vp.height;
        return page.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise.then(function () {
          var img = new Image();
          img.onload = function () { R.ann.bg = img; R.ann.strokes = []; redraw(R.ann); };
          img.src = tmp.toDataURL('image/jpeg', 0.85);
        });
      }).catch(function (err) {
        if (msg) msg.innerHTML = '<div class="flag"><b>Could not open that PDF</b><div>' + esc(String(err.message || err).slice(0, 140)) + '</div></div>';
      });
    } else {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { R.ann.bg = img; R.ann.strokes = []; redraw(R.ann); URL.revokeObjectURL(url); };
      img.onerror = function () { if (msg) msg.innerHTML = '<div class="flag"><b>Could not read that image</b><div>Try a PNG or JPG.</div></div>'; };
      img.src = url;
    }
  }

  /* ========================= actions ========================= */
  var actions = {
    'join-room': function () { join(); },
    'leave-room': function () {
      var ses = R.session;
      teardown();
      if (ses) {
        S.commit('session:leave:' + ses.id, function (d) {
          var s = d.sessions.find(function (x) { return x.id === ses.id; });
          if (s && s.status === 'live') s.status = 'scheduled';
        });
      }
      location.hash = '#/classes';
    },
    'toggle-mic': function (el) {
      R.micOn = !R.micOn;
      if (R.stream) R.stream.getAudioTracks().forEach(function (t) { t.enabled = R.micOn; });
      el.textContent = R.micOn ? 'Mute' : 'Unmute';
      el.classList.toggle('btn-danger', !R.micOn);
      paintState();
    },
    'toggle-cam': function (el) {
      R.camOn = !R.camOn;
      if (R.stream) R.stream.getVideoTracks().forEach(function (t) { t.enabled = R.camOn; });
      var off = document.getElementById('local-off');
      if (off) off.classList.toggle('hide', R.camOn);
      el.textContent = R.camOn ? 'Camera off' : 'Camera on';
      el.classList.toggle('btn-danger', !R.camOn);
      paintState();
    },
    'open-devices': function () {
      listDevices();
      LC.app.modal('Devices',
        '<div class="form-grid">' +
        '<label class="field">Camera<select id="hw-cam"></select></label>' +
        '<label class="field">Microphone<select id="hw-mic"></select></label></div>' +
        '<p class="small dim">Switching restarts your local tracks. In a live call the new track is replaced on the peer ' +
        'connection with <span class="mono">RTCRtpSender.replaceTrack()</span>, so the other side never sees a reconnect.</p>',
        '<button class="btn btn-primary" data-act="apply-devices">Apply</button>');
      setTimeout(listDevices, 30);
    },
    'apply-devices': function () {
      var cam = document.getElementById('hw-cam'), mic = document.getElementById('hw-mic');
      R.picked.cam = cam && cam.value || '';
      R.picked.mic = mic && mic.value || '';
      LC.app.closeModal();
      getStream().then(function () {
        attachStream();
        LC.app.toast('ok', 'Devices switched', 'Now using your selected camera and microphone.');
      }).catch(function (err) { LC.app.toast('err', 'Could not switch', describeMediaError(err)); });
    },
    'toggle-record': function (el) {
      if (R.recording) {
        if (R.recorder && R.recorder.state === 'recording') R.recorder.stop();
        return;
      }
      if (!R.stream || !window.MediaRecorder) {
        LC.app.toast('err', 'Nothing to record', 'Recording needs an active camera or microphone in this tab.');
        return;
      }
      try {
        R.recorder = new MediaRecorder(R.stream);
        R.chunks = [];
        R.recorder.ondataavailable = function (e) { if (e.data.size) R.chunks.push(e.data); };
        R.recorder.onstop = function () {
          R.recording = false;
          var blob = new Blob(R.chunks, { type: R.recorder.mimeType || 'video/webm' });
          var url = URL.createObjectURL(blob);
          S.commit('session:recording:' + R.session.id, function (d) {
            var s = d.sessions.find(function (x) { return x.id === R.session.id; });
            if (s) s.recordingUrl = 'blob (local only) · ' + F.bytes(blob.size);
          });
          LC.app.modal('Local recording ready',
            '<video controls src="' + url + '" style="width:100%;border-radius:8px;background:#000"></video>' +
            '<div class="flag"><b>This clip is only your own tracks</b><div>It lives in this tab and is gone on reload. ' +
            'A real class recording — both participants, mixed — has to be produced by an SFU or a managed media service.</div></div>', '');
          paintState();
          var b = document.querySelector('[data-act="toggle-record"]');
          if (b) { b.textContent = 'Record'; b.classList.remove('btn-danger'); }
        };
        R.recorder.start();
        R.recording = true;
        el.textContent = 'Stop';
        el.classList.add('btn-danger');
        paintState();
      } catch (e) {
        LC.app.toast('err', 'Recorder failed to start', String(e.message || e));
      }
    },
    'tab': function (el) {
      R.tab = el.dataset.tab;
      document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === R.tab); });
      renderTab();
    },
    'send-chat': function (form, e) {
      e.preventDefault();
      var input = document.getElementById('chat-input');
      var text = input.value.trim();
      if (!text) return;
      var me = S.currentUser();
      S.commit('chat:send', function (d) {
        d.chats[R.session.id] = d.chats[R.session.id] || [];
        d.chats[R.session.id].push({ id: S.uid('msg'), from: me.id, text: text, at: S.iso(Date.now()) });
      });
      input.value = '';
      var log = document.getElementById('chat-log');
      if (log) {
        log.insertAdjacentHTML('beforeend', chatBubble({ from: me.id, text: text }));
        log.scrollTop = log.scrollHeight;
      }
    },
    'board-tool': function (el) { R.board.tool = el.dataset.tool; renderTab(); },
    'ann-tool': function (el) { R.ann.tool = el.dataset.tool; renderTab(); },
    'board-color': function (el) { R.board.color = el.dataset.color; renderTab(); },
    'ann-color': function (el) { R.ann.color = el.dataset.color; renderTab(); },
    'board-width': function (el) { R.board.width = +el.value; },
    'board-undo': function () { if (R.board.strokes.length) { R.board.undo.push(R.board.strokes.pop()); redraw(R.board); } },
    'ann-undo': function () { if (R.ann.strokes.length) { R.ann.strokes.pop(); redraw(R.ann); } },
    'board-clear': function () { R.board.strokes = []; redraw(R.board); },
    'ann-clear': function () { R.ann.strokes = []; redraw(R.ann); },
    'board-save': function () { saveBoardToLibrary(R.board, 'whiteboard'); },
    'ann-save': function () { saveBoardToLibrary(R.ann, 'annotated'); },
    'ann-open': function (el) { if (el.files && el.files[0]) openAnnotationFile(el.files[0]); },
    'eq-input': function () { renderMath(); },
    'eq-insert': function (el) {
      var src = document.getElementById('eq-src');
      var t = el.dataset.tex;
      var at = src.selectionStart || src.value.length;
      src.value = src.value.slice(0, at) + t + src.value.slice(at);
      src.focus();
      renderMath();
    },
    'eq-save': function () {
      var src = document.getElementById('eq-src');
      S.commit('equation:save', function (d) { d.docs['eq_' + R.session.id] = src.value; });
      LC.app.toast('ok', 'Equation saved', 'Stored with this session\'s notes.');
    },
    'eq-to-board': function () {
      var src = document.getElementById('eq-src');
      R.board.strokes.push({ tool: 'text', color: R.board.color, width: 3, text: src.value.slice(0, 60), points: [{ x: 28, y: 44 }] });
      R.tab = 'whiteboard';
      renderTab();
      document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === 'whiteboard'); });
      LC.app.toast('ok', 'Sent to the whiteboard', 'The LaTeX source is written on the board — drag your pen to work through it.');
    },
    'doc-cmd': function (el) {
      var ed = document.getElementById('doc-editor');
      ed.focus();
      document.execCommand(el.dataset.cmd, false, el.dataset.val || null);
    },
    'doc-correct': function () {
      var ed = document.getElementById('doc-editor');
      ed.focus();
      document.execCommand('hiliteColor', false, '#F8E7E1');
    },
    'doc-save': function () {
      var ed = document.getElementById('doc-editor');
      S.commit('document:save', function (d) { d.docs['doc_' + R.session.id] = ed.innerHTML; });
      LC.app.toast('ok', 'Document saved', 'Kept with this session. Yjs would sync it to your student live.');
    },
    'voice-record': function () { voiceRecord(); },
    'voice-analyse': function () { analyseSpeech(); },
    'next-phrase': function () { R.voice.phrase = (R.voice.phrase + 1) % PHRASES.length; R.voice.peaks = null; R.voice.url = null; renderTab(); },
    'end-session': function () {
      var ses = R.session;
      S.commit('session:complete:' + ses.id, function (d) {
        var s = d.sessions.find(function (x) { return x.id === ses.id; });
        if (s) { s.status = 'completed'; s.endedAt = S.iso(Date.now()); }
        var att = d.attendance.find(function (a) { return a.sessionId === ses.id; });
        if (att && !att.clockOut) att.clockOut = S.iso(Date.now());
        S.notify(ses.studentId, 'session', 'Class finished', esc(ses.topic) + ' — your teacher marked it complete.');
      });
      teardown();
      LC.app.toast('ok', 'Session complete', 'Attendance closed and the student was notified.');
      location.hash = '#/classes';
    },
    'mark-noshow': function () {
      var ses = R.session;
      S.commit('session:noshow:' + ses.id, function (d) {
        var s = d.sessions.find(function (x) { return x.id === ses.id; });
        if (s) s.status = 'no_show';
      });
      teardown();
      LC.app.toast('warn', 'Marked as a no-show', 'The admin can review this on the attendance screen.');
      location.hash = '#/classes';
    }
  };

  LC.views.room = room;
  LC.roomActions = actions;
  LC.roomRepaintPeer = paintPeer;
})();
