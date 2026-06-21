// Stage 388 — doa audio playback via Web Speech API (TTS).
//
// Zero-asset implementation: browser's built-in TTS engine synthesises
// speech from the doa text at request time. Works offline once the
// voice pack is installed (Android Chrome / iOS Safari ship Arabic +
// Indonesian voices by default; desktop varies).
//
// Why TTS over pre-recorded MP3:
// - Zero asset shipping (no licensing, no CDN, no GBs of audio)
// - Works offline (voices cached by OS)
// - Arabic + Indonesian + English coverage out-of-the-box
// - Tartil/tajwid pronunciation NOT guaranteed — TTS reads phonetically.
//   For Quran recitation this would be inadequate, but for short doa
//   with Latin transliteration backup it's an acceptable accessibility
//   aid, not a replacement for human recitation.

(function (global) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  if (!synth) {
    // Unsupported browser — expose no-op API so callers don't crash.
    global.DoaAudio = {
      supported: false,
      play() { return Promise.resolve({ skipped: true, reason: 'unsupported' }); },
      stop() {},
      voices() { return []; },
    };
    return;
  }

  // Voice list loads async on some browsers. Cache + refresh on `voiceschanged`.
  let voicesCache = [];
  function refreshVoices() {
    voicesCache = synth.getVoices() || [];
  }
  refreshVoices();
  if (typeof synth.onvoiceschanged !== 'undefined') {
    synth.onvoiceschanged = refreshVoices;
  }

  function pickVoice(langPrefix) {
    if (!voicesCache.length) refreshVoices();
    // Prefer exact lang match (ar-SA, id-ID), fallback to prefix (ar-*, id-*).
    const exact = voicesCache.find((v) => v.lang && v.lang.toLowerCase() === langPrefix.toLowerCase());
    if (exact) return exact;
    const prefix = langPrefix.split('-')[0].toLowerCase();
    return voicesCache.find((v) => v.lang && v.lang.toLowerCase().startsWith(prefix)) || null;
  }

  function play(text, { lang = 'id-ID', rate = 0.9, pitch = 1.0, onEnd, onError } = {}) {
    return new Promise((resolve) => {
      if (!text || !String(text).trim()) {
        resolve({ skipped: true, reason: 'empty text' });
        return;
      }
      // Always cancel any in-progress speech before starting new.
      try { synth.cancel(); } catch (_e) {}
      const utter = new SpeechSynthesisUtterance(String(text));
      utter.lang = lang;
      utter.rate = rate;
      utter.pitch = pitch;
      const voice = pickVoice(lang);
      if (voice) utter.voice = voice;
      utter.onend = () => {
        if (typeof onEnd === 'function') { try { onEnd(); } catch (_e) {} }
        resolve({ ok: true, voice: voice?.name || null });
      };
      utter.onerror = (ev) => {
        const reason = ev?.error || 'unknown';
        if (typeof onError === 'function') { try { onError(reason); } catch (_e) {} }
        resolve({ ok: false, error: reason });
      };
      try {
        synth.speak(utter);
      } catch (err) {
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  function stop() {
    try { synth.cancel(); } catch (_e) {}
  }

  function voices() { return voicesCache.slice(); }

  // Detect whether the device likely has an Arabic voice — used to flip
  // the UI hint when TTS can't actually voice the Arabic text.
  function hasArabic() {
    if (!voicesCache.length) refreshVoices();
    return voicesCache.some((v) => v.lang && v.lang.toLowerCase().startsWith('ar'));
  }

  global.DoaAudio = { supported: true, play, stop, voices, hasArabic };
})(window);
