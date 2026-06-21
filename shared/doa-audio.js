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

  // Stage 388 (extension) — playAudio() pakai HTML5 <audio> untuk MP3
  // file pre-rendered (rekaman qori asli). Lebih baik dari TTS untuk
  // pronunciation tartil yang benar. Falls back to TTS via callback
  // kalau MP3 fetch gagal (404 / network error).
  let currentAudio = null;
  function playAudio(url, { onEnd, onError, fallback } = {}) {
    return new Promise((resolve) => {
      if (!url) {
        if (typeof fallback === 'function') { fallback(); resolve({ ok: false, error: 'no url' }); return; }
        resolve({ ok: false, error: 'no url' });
        return;
      }
      // Cancel TTS + existing audio before starting new playback.
      try { synth.cancel(); } catch (_e) {}
      if (currentAudio) {
        try { currentAudio.pause(); currentAudio.src = ''; } catch (_e) {}
        currentAudio = null;
      }
      const audio = new Audio(url);
      audio.preload = 'auto';
      currentAudio = audio;
      audio.addEventListener('ended', () => {
        if (typeof onEnd === 'function') { try { onEnd(); } catch (_e) {} }
        if (currentAudio === audio) currentAudio = null;
        resolve({ ok: true, source: 'mp3' });
      });
      audio.addEventListener('error', () => {
        const reason = audio.error ? `code ${audio.error.code}` : 'unknown';
        if (currentAudio === audio) currentAudio = null;
        // MP3 fetch failed (404 / decode error) — invoke TTS fallback
        // if caller wired one. Common during dev when MP3 files not yet
        // dropped into shared/audio/doa/.
        if (typeof fallback === 'function') {
          try { fallback(); } catch (_e) {}
          resolve({ ok: false, error: reason, fellBack: true });
          return;
        }
        if (typeof onError === 'function') { try { onError(reason); } catch (_e) {} }
        resolve({ ok: false, error: reason });
      });
      audio.play().catch((err) => {
        // Autoplay policy block etc. — surface as error, optional fallback.
        if (currentAudio === audio) currentAudio = null;
        if (typeof fallback === 'function') {
          try { fallback(); } catch (_e) {}
          resolve({ ok: false, error: err.message, fellBack: true });
          return;
        }
        if (typeof onError === 'function') { try { onError(err.message); } catch (_e) {} }
        resolve({ ok: false, error: err.message });
      });
    });
  }

  // Probe whether an audio URL is reachable. Lightweight HEAD request
  // so UI can show "🎵 MP3" badge vs "🔊 TTS" badge before user taps.
  // Cached per-URL since result doesn't change within session.
  const probeCache = new Map();
  async function probeAudio(url) {
    if (!url) return false;
    if (probeCache.has(url)) return probeCache.get(url);
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const ok = res.ok;
      probeCache.set(url, ok);
      return ok;
    } catch (_err) {
      probeCache.set(url, false);
      return false;
    }
  }

  // Wrap original stop() to also cancel audio playback.
  const stopBoth = () => {
    try { synth.cancel(); } catch (_e) {}
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.src = ''; } catch (_e) {}
      currentAudio = null;
    }
  };

  global.DoaAudio = {
    supported: true,
    play, playAudio, probeAudio,
    stop: stopBoth,
    voices, hasArabic,
  };
})(window);
