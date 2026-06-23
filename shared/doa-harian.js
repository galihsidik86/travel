// Stage 333 — small static asset cycling through commonly-needed doa
// during umroh. Pure client-side: no backend, no fetch.
//
// Stage 389 — admin CMS — doa now fetched from /api/doa (admin-managed
// via /admin/doa). Static FALLBACK_DOA below retained sebagai initial
// shape + offline rescue kalau API fetch gagal AND localStorage cache
// kosong (mis. first-ever visit while offline).
//
// API response cached di localStorage["rp_doa_cache"] supaya:
// - PWA boot instant (no API roundtrip needed pada subsequent visits)
// - Offline mode work (last successful fetch survives)
// - API down → fall back to cache (still functional)
// - Cache stale → background refresh (next page load gets fresh data)
//
// Cycled by day-of-year so the same jemaah sees a different doa
// each day of trip.

(function (global) {
  // Fallback library — used kalau API fail AND no cache. Identical shape
  // dengan API response (audioCredit + audioUrl optional).
  const FALLBACK_DOA = [
    {
      title: 'Doa masuk Masjidil Haram',
      arabic: 'اللَّهُمَّ افْتَحْ لِي أَبْوَابَ رَحْمَتِكَ',
      latin: "Allāhummaftaḥ lī abwāba raḥmatik",
      translation: 'Ya Allah, bukakanlah untukku pintu-pintu rahmat-Mu.',
    },
    {
      title: 'Doa melihat Ka\'bah',
      arabic: 'اللَّهُمَّ زِدْ هَذَا الْبَيْتَ تَشْرِيفًا وَتَعْظِيمًا وَتَكْرِيمًا وَمَهَابَةً',
      latin: 'Allāhumma zid hādzal-baita tasyrīfan wa ta\'dhīman wa takrīman wa mahābah',
      translation: 'Ya Allah, tambahkanlah kemuliaan, keagungan, kehormatan, dan kewibawaan pada rumah-Mu ini.',
    },
    {
      title: 'Doa sebelum minum air Zamzam',
      arabic: 'اللَّهُمَّ إِنِّي أَسْأَلُكَ عِلْمًا نَافِعًا وَرِزْقًا وَاسِعًا وَشِفَاءً مِنْ كُلِّ دَاءٍ',
      latin: "Allāhumma innī as'aluka 'ilman nāfi'an wa rizqan wāsi'an wa syifā'an min kulli dā'",
      translation: 'Ya Allah, aku mohon kepada-Mu ilmu yang bermanfaat, rezeki yang luas, dan kesembuhan dari segala penyakit.',
    },
    {
      title: 'Doa keluar Masjidil Haram',
      arabic: 'اللَّهُمَّ إِنِّي أَسْأَلُكَ مِنْ فَضْلِكَ',
      latin: "Allāhumma innī as'aluka min faḍlik",
      translation: 'Ya Allah, aku mohon kepada-Mu dari karunia-Mu.',
    },
    {
      title: 'Doa sapu jagat (di Multazam atau setelah thawaf)',
      arabic: 'رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً وَفِي الْآخِرَةِ حَسَنَةً وَقِنَا عَذَابَ النَّارِ',
      latin: "Rabbanā ātinā fid-dunyā ḥasanah, wa fil-ākhirati ḥasanah, wa qinā 'adzāban-nār",
      translation: 'Ya Tuhan kami, berikanlah kami kebaikan di dunia, kebaikan di akhirat, dan jauhkanlah kami dari azab neraka.',
    },
    {
      title: 'Doa masuk Masjid Nabawi',
      arabic: 'بِسْمِ اللَّهِ وَالصَّلَاةُ وَالسَّلَامُ عَلَى رَسُولِ اللَّهِ، اللَّهُمَّ افْتَحْ لِي أَبْوَابَ رَحْمَتِكَ',
      latin: 'Bismillāhi wash-shalātu was-salāmu \'alā rasūlillāh, Allāhummaftaḥ lī abwāba raḥmatik',
      translation: 'Dengan nama Allah, semoga shalawat dan salam tercurah kepada Rasulullah. Ya Allah, bukakanlah untukku pintu-pintu rahmat-Mu.',
    },
    {
      title: 'Doa ziarah ke makam Rasulullah',
      arabic: 'السَّلَامُ عَلَيْكَ يَا رَسُولَ اللَّهِ، السَّلَامُ عَلَيْكَ يَا نَبِيَّ اللَّهِ',
      latin: "As-salāmu 'alaika yā rasūlallāh, as-salāmu 'alaika yā nabiyyallāh",
      translation: 'Semoga salam tercurah atasmu wahai Rasulullah, semoga salam tercurah atasmu wahai Nabi Allah.',
    },
    {
      title: 'Doa di antara Rukun Yamani &amp; Hajar Aswad',
      arabic: 'رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً وَفِي الْآخِرَةِ حَسَنَةً وَقِنَا عَذَابَ النَّارِ',
      latin: "Rabbanā ātinā fid-dunyā ḥasanah, wa fil-ākhirati ḥasanah, wa qinā 'adzāban-nār",
      translation: 'Ya Tuhan kami, berikanlah kami kebaikan di dunia dan akhirat, jauhkan kami dari azab neraka.',
    },
    {
      title: 'Doa selesai sai',
      arabic: 'رَبِّ اغْفِرْ وَارْحَمْ وَأَنْتَ الْأَعَزُّ الْأَكْرَمُ',
      latin: 'Rabbighfir warḥam wa antal-a\'azzul-akram',
      translation: 'Ya Tuhan, ampunilah, sayangilah, Engkaulah Yang Maha Mulia dan Maha Pemurah.',
    },
    {
      title: 'Doa keselamatan dalam perjalanan',
      arabic: 'سُبْحَانَ الَّذِي سَخَّرَ لَنَا هَذَا وَمَا كُنَّا لَهُ مُقْرِنِينَ وَإِنَّا إِلَى رَبِّنَا لَمُنْقَلِبُونَ',
      latin: "Subḥānal-ladzī sakhkhara lanā hādzā wa mā kunnā lahū muqrinīn, wa innā ilā rabbinā lamunqalibūn",
      translation: 'Maha Suci Tuhan yang menundukkan ini untuk kami, padahal kami sebelumnya tidak mampu menguasainya. Sesungguhnya kami akan kembali kepada Tuhan kami.',
    },
  ];

  const CACHE_KEY = 'rp_doa_cache';
  const CACHE_TTL_MS = 60 * 60 * 1000; // 1 jam — admin edits bisa di-pickup cepat

  // Initial DOA = cache hit jika fresh, else fallback. Async fetch will
  // replace this in-place + emit rp:doa-updated event for views to repaint.
  let DOA = loadFromCache() || FALLBACK_DOA.slice();

  function loadFromCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.doa) || parsed.doa.length === 0) return null;
      // Cache older than TTL → still use it (offline rescue), but trigger
      // a background refresh. Cache fresher than TTL → use as-is, skip refresh.
      return parsed.doa;
    } catch (_e) { return null; }
  }

  function saveToCache(doa) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ doa, ts: Date.now() }));
    } catch (_e) { /* localStorage may be full / disabled — fine */ }
  }

  function cacheAgeMs() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return Infinity;
      const parsed = JSON.parse(raw);
      return Date.now() - (parsed.ts || 0);
    } catch (_e) { return Infinity; }
  }

  async function refreshFromApi() {
    try {
      const res = await fetch('/api/doa', { credentials: 'same-origin' });
      if (!res.ok) return false;
      const body = await res.json();
      if (!body.ok || !Array.isArray(body.doa) || body.doa.length === 0) return false;
      DOA = body.doa;
      saveToCache(body.doa);
      // Notify listeners so /saya/ibadah view can re-render with new data.
      try { window.dispatchEvent(new CustomEvent('rp:doa-updated', { detail: { count: body.doa.length } })); } catch (_e) {}
      return true;
    } catch (_err) {
      // Network fail → keep using existing DOA (cache or fallback).
      return false;
    }
  }

  function dayOfYear(d = new Date()) {
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    const diff = d.getTime() - start;
    return Math.floor(diff / 86_400_000);
  }

  function getTodayDoa(now = new Date()) {
    const idx = dayOfYear(now) % DOA.length;
    return DOA[idx];
  }

  // Refresh on load — non-blocking, fire-and-forget. View renders with
  // initial DOA (cache or fallback), then re-renders if API returns
  // different data via the rp:doa-updated event.
  if (cacheAgeMs() > CACHE_TTL_MS) {
    refreshFromApi();
  } else {
    // Fresh cache — still refresh in background so next visit has latest.
    setTimeout(refreshFromApi, 100);
  }

  global.DoaHarian = {
    get all() { return DOA; },  // getter — always returns latest after async refresh
    getTodayDoa,
    dayOfYear,
    refresh: refreshFromApi,
  };
})(window);
