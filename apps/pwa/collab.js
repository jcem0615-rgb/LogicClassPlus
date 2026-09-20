/* ============================================================
   LogicClass+ — Yjs provider over Socket.io
   Speaks the standard y-protocols sync and awareness frames on
   the room's existing authenticated channel, against the
   authoritative document the server holds.
   ============================================================ */
(function () {
  var MESSAGE_SYNC = 0;
  var MESSAGE_AWARENESS = 1;

  function open(sessionId, user, callbacks) {
    var E = window.LCEditor;
    if (!E) return null;

    var doc = new E.Y.Doc();
    var awareness = new E.Awareness(doc);
    var synced = false;
    var destroyed = false;
    var handlers = callbacks || {};

    function send(bytes) {
      LC.api.emit('classroom:doc:message', { sessionId: sessionId, data: bytes });
    }

    function sendSyncStep1() {
      var encoder = E.encoding.createEncoder();
      E.encoding.writeVarUint(encoder, MESSAGE_SYNC);
      E.sync.writeSyncStep1(encoder, doc);
      send(E.encoding.toUint8Array(encoder));
    }

    /* ---- inbound ---- */
    function onMessage(payload) {
      if (destroyed || !payload || !payload.data) return;

      var bytes = payload.data instanceof Uint8Array
        ? payload.data
        : new Uint8Array(payload.data);
      var decoder = E.decoding.createDecoder(bytes);
      var encoder = E.encoding.createEncoder();
      var type = E.decoding.readVarUint(decoder);

      if (type === MESSAGE_SYNC) {
        E.encoding.writeVarUint(encoder, MESSAGE_SYNC);
        // `provider` as the origin stops the update handler below from
        // echoing the server's own changes straight back at it.
        E.sync.readSyncMessage(decoder, encoder, doc, provider);
        if (E.encoding.length(encoder) > 1) send(E.encoding.toUint8Array(encoder));
        if (!synced) {
          synced = true;
          if (handlers.onSynced) handlers.onSynced(doc);
        }
      } else if (type === MESSAGE_AWARENESS) {
        E.awareness.applyAwarenessUpdate(awareness, E.decoding.readVarUint8Array(decoder), 'remote');
      }
    }

    /* ---- outbound ---- */
    function onDocUpdate(update, origin) {
      if (destroyed || origin === provider) return;
      var encoder = E.encoding.createEncoder();
      E.encoding.writeVarUint(encoder, MESSAGE_SYNC);
      E.sync.writeUpdate(encoder, update);
      send(E.encoding.toUint8Array(encoder));
    }

    function onAwarenessUpdate(changes, origin) {
      if (destroyed || origin === 'remote') return;
      var changed = changes.added.concat(changes.updated, changes.removed);
      if (!changed.length) return;
      var encoder = E.encoding.createEncoder();
      E.encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      E.encoding.writeVarUint8Array(encoder, E.awareness.encodeAwarenessUpdate(awareness, changed));
      send(E.encoding.toUint8Array(encoder));
    }

    doc.on('update', onDocUpdate);
    awareness.on('update', onAwarenessUpdate);
    LC.api.on('classroom:doc:message', onMessage);

    // Tell the server we are here; it answers with the document and any cursors.
    LC.api.emit('classroom:doc:open', sessionId, function (ack) {
      if (destroyed) return;
      if (ack && ack.error) {
        if (handlers.onError) handlers.onError(new Error(ack.error));
        return;
      }
      sendSyncStep1();
    });

    var provider = {
      doc: doc,
      awareness: awareness,
      sessionId: sessionId,
      isSynced: function () { return synced; },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        try {
          E.awareness.removeAwarenessStates(awareness, [doc.clientID], 'local');
        } catch (e) { /* nothing to clear */ }
        LC.api.emit('classroom:doc:close', sessionId);
        doc.off('update', onDocUpdate);
        awareness.off('update', onAwarenessUpdate);
        LC.api.off('classroom:doc:message', onMessage);
        awareness.destroy();
        doc.destroy();
      }
    };

    if (user) {
      awareness.setLocalStateField('user', {
        name: user.name,
        color: user.color || colorFor(user.id)
      });
    }

    return provider;
  }

  /** A stable colour per person, so a cursor keeps its identity across reloads. */
  function colorFor(id) {
    var palette = ['#0B6B62', '#A8452B', '#2E5AAC', '#7A3BAF', '#1C7A4B', '#845F00'];
    var sum = 0;
    for (var i = 0; i < String(id).length; i++) sum += String(id).charCodeAt(i);
    return palette[sum % palette.length];
  }

  /**
   * Loads the editor bundle on first use. Demo mode never opens a shared
   * document, so it never pays for 400 KB of Tiptap and Yjs.
   */
  var loading = null;
  function load() {
    if (window.LCEditor) return Promise.resolve(window.LCEditor);
    if (loading) return loading;
    loading = new Promise(function (resolveLoad, reject) {
      var tag = document.createElement('script');
      tag.src = 'vendor/editor.bundle.js';
      tag.onload = function () {
        window.LCEditor ? resolveLoad(window.LCEditor)
          : reject(new Error('The editor bundle loaded but did not initialise.'));
      };
      tag.onerror = function () {
        loading = null;
        reject(new Error('Could not load the editor. Run npm run -w apps/pwa build.'));
      };
      document.head.appendChild(tag);
    });
    return loading;
  }

  LC.collab = { open: open, colorFor: colorFor, load: load };
})();
