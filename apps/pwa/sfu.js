/* ============================================================
   LogicClass+ — SFU transport (LiveKit)
   The alternative to the peer-to-peer path in webrtc.js. Media
   flows through the media server, which is the only way there is
   anything for recording to capture: peer-to-peer gives the
   server no stream at all.
   ============================================================ */
(function () {
  var room = null;
  var listeners = {};
  var loading = null;
  var localTracks = [];

  function emit(name, payload) {
    if (listeners[name]) listeners[name].forEach(function (fn) { fn(payload); });
  }
  function on(name, fn) {
    listeners[name] = listeners[name] || [];
    listeners[name].push(fn);
  }

  /** Loaded on demand: a room on the peer-to-peer path never pays for it. */
  function load() {
    if (window.LCLiveKit) return Promise.resolve(window.LCLiveKit);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = 'vendor/livekit.bundle.js';
      tag.onload = function () {
        window.LCLiveKit ? resolve(window.LCLiveKit)
          : reject(new Error('The LiveKit bundle loaded but did not initialise.'));
      };
      tag.onerror = function () {
        loading = null;
        reject(new Error('Could not load the media client. Run npm run -w apps/pwa build.'));
      };
      document.head.appendChild(tag);
    });
    return loading;
  }

  /**
   * Joins the room and publishes the tracks we already captured for the
   * hardware check, so the camera is not opened twice.
   */
  function connect(options) {
    return load().then(function (LK) {
      if (room) return room;

      room = new LK.Room({
        adaptiveStream: true,
        dynacast: true,
        // A tutoring class is two people and a shared surface; 720p is the
        // ceiling worth paying for, and matches the recording preset.
        videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
      });

      room.on(LK.RoomEvent.TrackSubscribed, function (track, publication, participant) {
        emit('remote-track', { track: track, participant: participant, kind: track.kind });
      });
      room.on(LK.RoomEvent.TrackUnsubscribed, function (track) {
        emit('remote-track-gone', { track: track });
      });
      room.on(LK.RoomEvent.ParticipantConnected, function (participant) {
        emit('peer', { identity: participant.identity, present: true });
      });
      room.on(LK.RoomEvent.ParticipantDisconnected, function (participant) {
        emit('peer', { identity: participant.identity, present: false });
      });
      room.on(LK.RoomEvent.ConnectionStateChanged, function (state) {
        emit('state', { state: String(state) });
      });
      room.on(LK.RoomEvent.Disconnected, function (reason) {
        emit('state', { state: 'disconnected', reason: String(reason) });
      });
      // The server tells every participant when egress starts or stops.
      room.on(LK.RoomEvent.RecordingStatusChanged, function (recording) {
        emit('recording', { active: Boolean(recording) });
      });

      return room.connect(options.url, options.token).then(function () {
        emit('state', { state: 'connected' });
        return publish(options.stream).then(function () { return room; });
      });
    });
  }

  /** Publishes the MediaStreamTracks from the hardware check. */
  function publish(stream) {
    if (!room || !stream) return Promise.resolve([]);
    var tracks = stream.getTracks();
    return Promise.all(tracks.map(function (track) {
      return room.localParticipant.publishTrack(track, {
        name: track.kind === 'video' ? 'camera' : 'microphone',
        source: track.kind === 'video'
          ? window.LCLiveKit.Track.Source.Camera
          : window.LCLiveKit.Track.Source.Microphone,
      });
    })).then(function (published) {
      localTracks = published;
      return published;
    });
  }

  /** Device switch: replace what is published without a reconnect. */
  function replaceTracks(stream) {
    if (!room || !stream) return Promise.resolve(false);
    return Promise.all(stream.getTracks().map(function (track) {
      var publication = localTracks.find(function (p) {
        return p && p.track && p.track.kind === track.kind;
      });
      if (publication && publication.track && publication.track.replaceTrack) {
        return publication.track.replaceTrack(track);
      }
      return room.localParticipant.publishTrack(track);
    })).then(function () { return true; });
  }

  function setEnabled(kind, enabled) {
    if (!room) return;
    localTracks.forEach(function (publication) {
      if (publication && publication.track && publication.track.kind === kind) {
        enabled ? publication.track.unmute() : publication.track.mute();
      }
    });
  }

  function isRecording() {
    return Boolean(room && room.isRecording);
  }

  function disconnect() {
    if (!room) return Promise.resolve();
    var closing = room;
    room = null;
    localTracks = [];
    return Promise.resolve(closing.disconnect()).catch(function () { return null; });
  }

  function active() { return Boolean(room); }
  function current() { return room; }

  LC.sfu = {
    load: load, connect: connect, replaceTracks: replaceTracks, setEnabled: setEnabled,
    isRecording: isRecording, disconnect: disconnect, active: active, current: current, on: on
  };
})();
