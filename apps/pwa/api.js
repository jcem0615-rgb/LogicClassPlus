/* ============================================================
   LogicClass+ — API client
   Talks to apps/server over REST for state and Socket.io for
   realtime. With no server configured the app stays in demo
   mode and this module is never called.
   ============================================================ */
window.LC = window.LC || {};

(function () {
  var SERVER_KEY = 'logicclass.plus.server';
  var TOKEN_KEY = 'logicclass.plus.token';

  var state = { base: '', token: '', socket: null, handlers: {} };

  function read(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function write(key, value) {
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch (e) {}
  }

  state.base = read(SERVER_KEY);
  state.token = read(TOKEN_KEY);

  function baseUrl() { return state.base; }
  function token() { return state.token; }
  function isConfigured() { return Boolean(state.base); }

  function setServer(url) {
    state.base = String(url || '').trim().replace(/\/+$/, '');
    write(SERVER_KEY, state.base);
  }
  function setToken(value) {
    state.token = value || '';
    write(TOKEN_KEY, state.token);
  }

  /** Every request carries the bearer token and unwraps the server's error shape. */
  function request(path, options) {
    options = options || {};
    if (!state.base) return Promise.reject(new Error('No server configured.'));
    var headers = { 'content-type': 'application/json' };
    if (state.token) headers.authorization = 'Bearer ' + state.token;

    return fetch(state.base + '/api' + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var err = new Error((json.error && json.error.message) || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          err.code = json.error && json.error.code;
          throw err;
        }
        return json;
      });
    });
  }

  var get = function (p) { return request(p); };
  var post = function (p, body) { return request(p, { method: 'POST', body: body }); };
  var patch = function (p, body) { return request(p, { method: 'PATCH', body: body }); };
  var put = function (p, body) { return request(p, { method: 'PUT', body: body }); };
  var del = function (p) { return request(p, { method: 'DELETE' }); };

  /** Reachability + capability probe. Runs before the app commits to remote mode. */
  function health(url) {
    var target = (url || state.base).replace(/\/+$/, '');
    return fetch(target + '/api/health')
      .then(function (r) { if (!r.ok) throw new Error('Server replied ' + r.status); return r.json(); });
  }

  /* ---------------------------- realtime ----------------------------
     The Socket.io client is loaded from the server we are connecting to, so a
     self-hosted install needs no CDN. The <script> tag in index.html is only a
     head start for the hosted preview. */
  function loadSocketLib() {
    if (window.io) return Promise.resolve(window.io);
    if (!state.base) return Promise.reject(new Error('No server configured.'));
    return new Promise(function (resolveLib, reject) {
      var tag = document.createElement('script');
      tag.src = state.base + '/socket.io/socket.io.js';
      tag.onload = function () {
        window.io ? resolveLib(window.io) : reject(new Error('Socket.io client did not initialise.'));
      };
      tag.onerror = function () { reject(new Error('Could not load the realtime client from the server.')); };
      document.head.appendChild(tag);
    });
  }

  function connectSocket() {
    if (!state.base || !state.token) return Promise.resolve(null);
    return loadSocketLib().then(function (io) {
      if (state.socket) { try { state.socket.close(); } catch (e) {} }
      var socket = io(state.base, {
        auth: { token: state.token },
        transports: ['websocket', 'polling']
      });
      state.socket = socket;

      Object.keys(state.handlers).forEach(function (event) {
        socket.on(event, function (payload) {
          state.handlers[event].forEach(function (fn) { fn(payload); });
        });
      });
      return socket;
    }).catch(function (err) {
      // Realtime is an enhancement: REST still works without it.
      if (window.console) console.warn('[LogicClass+] realtime unavailable:', err.message);
      return null;
    });
  }

  /** Handlers survive reconnects — they are registered against the module, not the socket. */
  function on(event, fn) {
    if (!state.handlers[event]) {
      state.handlers[event] = [];
      if (state.socket) {
        state.socket.on(event, function (payload) {
          state.handlers[event].forEach(function (h) { h(payload); });
        });
      }
    }
    state.handlers[event].push(fn);
  }

  /** Detaches one handler. The socket-level listener stays; it dispatches to
      whatever is left in the list, so other features keep working. */
  function off(event, fn) {
    var list = state.handlers[event];
    if (!list) return;
    var index = list.indexOf(fn);
    if (index > -1) list.splice(index, 1);
  }

  function emit(event, payload, ack) {
    if (state.socket) state.socket.emit(event, payload, ack);
  }

  function disconnect() {
    if (state.socket) { try { state.socket.close(); } catch (e) {} }
    state.socket = null;
  }

  function socket() { return state.socket; }

  LC.api = {
    baseUrl: baseUrl, isConfigured: isConfigured, setServer: setServer,
    token: token, setToken: setToken, health: health,
    get: get, post: post, patch: patch, put: put, del: del,
    connectSocket: connectSocket, on: on, off: off, emit: emit, disconnect: disconnect, socket: socket
  };
})();
