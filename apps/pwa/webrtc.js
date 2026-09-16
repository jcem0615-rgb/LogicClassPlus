/* ============================================================
   LogicClass+ — the peer connection
   1-on-1 media over WebRTC, signalled through the room's socket
   channel. Uses perfect negotiation, so both sides may offer at
   once without deadlocking: the polite peer (the student) rolls
   back, the impolite one (the teacher) holds its offer.
   ============================================================ */
(function () {
  var pc = null;
  var sessionId = null;
  var polite = false;
  var peerSocket = null;
  var makingOffer = false;
  var ignoreOffer = false;
  var remoteStream = null;
  var localStream = null;
  var listeners = {};
  var iceConfig = null;
  var creating = null;
  var pendingCandidates = [];

  function emit(name, payload) {
    if (listeners[name]) listeners[name].forEach(function (fn) { fn(payload); });
  }
  function on(name, fn) {
    listeners[name] = listeners[name] || [];
    listeners[name].push(fn);
  }

  /** ICE servers come from the server so TURN credentials stay short-lived. */
  function loadIce() {
    if (iceConfig) return Promise.resolve(iceConfig);
    return LC.api.get('/realtime/ice').then(function (r) {
      iceConfig = r;
      return r;
    }).catch(function () {
      // A public STUN server still connects most pairs on the same network.
      iceConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], turnConfigured: false };
      return iceConfig;
    });
  }

  function addCandidate(candidate) {
    pc.addIceCandidate(candidate).catch(function (err) {
      if (!ignoreOffer) emit('error', err);
    });
  }

  /** Replays everything that arrived before the remote description did. */
  function flushCandidates() {
    if (!pc || !pendingCandidates.length) return;
    var queued = pendingCandidates;
    pendingCandidates = [];
    queued.forEach(addCandidate);
  }

  function signal(data) {
    LC.api.emit('classroom:signal', {
      sessionId: sessionId,
      to: peerSocket || undefined,
      data: data
    });
  }

  /**
   * Idempotent, and deliberately so: a peer connection is opened both by the
   * peer-joined broadcast and by an offer that arrives before it. Without the
   * in-flight promise the second caller builds a second RTCPeerConnection and
   * silently discards the first, which negotiates nothing.
   */
  function create(opts) {
    sessionId = opts.sessionId;
    polite = opts.polite;
    if (opts.stream) localStream = opts.stream;
    if (opts.peerSocket) peerSocket = opts.peerSocket;

    if (pc) return Promise.resolve(pc);
    if (creating) return creating;

    creating = loadIce().then(function (config) {
      if (pc) return pc;

      pc = new RTCPeerConnection({ iceServers: config.iceServers });
      remoteStream = new MediaStream();
      emit('state', { state: 'connecting', turn: config.turnConfigured });

      if (localStream) {
        localStream.getTracks().forEach(function (track) { pc.addTrack(track, localStream); });
      } else {
        // With no camera or mic we still negotiate, so we can receive the peer.
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }

      pc.ontrack = function (event) {
        event.streams[0].getTracks().forEach(function (track) {
          if (remoteStream.getTrackById(track.id)) return;
          remoteStream.addTrack(track);
        });
        emit('remote-stream', remoteStream);
      };

      pc.onicecandidate = function (event) {
        if (event.candidate) signal({ candidate: event.candidate });
      };

      pc.onnegotiationneeded = function () {
        // One side drives negotiation. The polite peer only ever answers, so a
        // simultaneous offer — and the rollback that follows it, which throws
        // away everything gathered so far — cannot happen.
        if (polite) return;
        makingOffer = true;
        pc.setLocalDescription()
          .then(function () { signal({ description: pc.localDescription }); })
          .catch(function (err) { emit('error', err); })
          .then(function () { makingOffer = false; });
      };

      pc.oniceconnectionstatechange = function () {
        if (pc.iceConnectionState === 'failed') {
          // One restart is worth trying before declaring the call dead.
          if (pc.restartIce) pc.restartIce();
          emit('state', { state: 'reconnecting', turn: iceConfig.turnConfigured });
        }
      };

      pc.onconnectionstatechange = function () {
        emit('state', { state: pc.connectionState, turn: iceConfig.turnConfigured });
      };

      return pc;
    }).then(function (connection) {
      creating = null;
      return connection;
    }).catch(function (err) {
      creating = null;
      emit('error', err);
      throw err;
    });

    return creating;
  }

  /** Signalling messages relayed by the server. */
  function handleSignal(message) {
    if (!message || !message.data) return;
    if (message.fromSocket) peerSocket = message.fromSocket;
    if (!pc) return;

    var data = message.data;

    if (data.description) {
      var description = data.description;
      var collision = description.type === 'offer'
        && (makingOffer || pc.signalingState !== 'stable');

      ignoreOffer = !polite && collision;
      if (ignoreOffer) return; // the impolite peer keeps its own offer

      Promise.resolve()
        .then(function () { return pc.setRemoteDescription(description); })
        .then(function () {
          flushCandidates();
          if (description.type !== 'offer') return null;
          return pc.setLocalDescription().then(function () {
            signal({ description: pc.localDescription });
          });
        })
        .catch(function (err) { emit('error', err); });
      return;
    }

    if (data.candidate) {
      // Candidates routinely arrive before the offer they belong to has been
      // applied. Added now they are rejected and lost, and the call never
      // finds a route, so they wait for the remote description.
      if (!pc.remoteDescription || !pc.remoteDescription.type) {
        pendingCandidates.push(data.candidate);
        return;
      }
      addCandidate(data.candidate);
    }
  }

  /**
   * Swapping camera or microphone mid-call. replaceTrack renegotiates nothing,
   * so the far side sees no interruption.
   */
  function replaceTracks(stream) {
    localStream = stream;
    if (!pc || !stream) return Promise.resolve(false);
    var senders = pc.getSenders();
    return Promise.all(stream.getTracks().map(function (track) {
      var sender = senders.find(function (s) { return s.track && s.track.kind === track.kind; });
      return sender ? sender.replaceTrack(track) : pc.addTrack(track, stream);
    })).then(function () { return true; });
  }

  function stop() {
    if (pc) {
      pc.getSenders().forEach(function (s) { if (s.track) s.track.stop = s.track.stop; });
      try { pc.close(); } catch (e) {}
    }
    pc = null;
    creating = null;
    pendingCandidates = [];
    remoteStream = null;
    peerSocket = null;
    makingOffer = false;
    ignoreOffer = false;
    emit('state', { state: 'closed' });
  }

  function active() { return Boolean(pc); }
  function connection() { return pc; }

  LC.webrtc = {
    create: create, handleSignal: handleSignal, replaceTracks: replaceTracks,
    stop: stop, on: on, active: active, connection: connection
  };
})();
