/* ============================================================
   LogicClass+ — audio conversion
   MediaRecorder gives us WebM/Opus. Azure's short-audio endpoint
   takes 16 kHz 16-bit mono PCM WAV and nothing else, so the
   conversion happens here, in the browser, rather than putting
   ffmpeg on the API host.
   ============================================================ */
(function () {
  var TARGET_RATE = 16000;

  function decode(arrayBuffer) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return Promise.reject(new Error('This browser cannot decode audio.'));
    var ctx = new Ctx();
    return ctx.decodeAudioData(arrayBuffer).then(function (buffer) {
      ctx.close();
      return buffer;
    }, function () {
      ctx.close();
      throw new Error('That recording could not be decoded.');
    });
  }

  /** Resample to 16 kHz mono. OfflineAudioContext does the rate conversion. */
  function resample(buffer) {
    var frames = Math.ceil(buffer.duration * TARGET_RATE);
    if (!frames) return Promise.reject(new Error('That recording is empty.'));

    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return Promise.reject(new Error('This browser cannot resample audio.'));

    var offline = new Offline(1, frames, TARGET_RATE);
    var source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(0);
    return offline.startRendering();
  }

  /** Float samples to a 16-bit PCM WAV, header and all. */
  function encodeWav(samples, sampleRate) {
    var bytesPerSample = 2;
    var blockAlign = bytesPerSample;          // mono
    var dataBytes = samples.length * bytesPerSample;
    var view = new DataView(new ArrayBuffer(44 + dataBytes));

    var writeString = function (offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);             // PCM chunk size
    view.setUint16(20, 1, true);              // format: PCM
    view.setUint16(22, 1, true);              // channels: mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);             // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataBytes, true);

    var offset = 44;
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
    return view.buffer;
  }

  /** Chunked, because String.fromCharCode.apply blows the stack on long audio. */
  function toBase64(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  /**
   * Recorded blob in, Azure-ready WAV out.
   * Resolves with { base64, bytes, seconds, blob }.
   */
  function toWav16k(blob) {
    return blob.arrayBuffer()
      .then(decode)
      .then(function (buffer) {
        if (buffer.duration < 0.3) throw new Error('That recording is too short to score.');
        return resample(buffer);
      })
      .then(function (rendered) {
        var wav = encodeWav(rendered.getChannelData(0), TARGET_RATE);
        return {
          base64: toBase64(wav),
          bytes: wav.byteLength,
          seconds: rendered.length / TARGET_RATE,
          blob: new Blob([wav], { type: 'audio/wav' })
        };
      });
  }

  LC.audio = { toWav16k: toWav16k, TARGET_RATE: TARGET_RATE };
})();
