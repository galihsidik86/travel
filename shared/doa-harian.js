// Stage 333 — small static asset cycling through commonly-needed doa
// during umroh. Pure client-side: no backend, no fetch.
//
// Cycled by day-of-year so the same jemaah sees a different doa
// each day of trip (and rotates through the full set across longer
// trips). Index resets to 0 each year — fine since the set is short.

(function (global) {
  const DOA = [
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

  function dayOfYear(d = new Date()) {
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    const diff = d.getTime() - start;
    return Math.floor(diff / 86_400_000);
  }

  function getTodayDoa(now = new Date()) {
    const idx = dayOfYear(now) % DOA.length;
    return DOA[idx];
  }

  global.DoaHarian = { all: DOA, getTodayDoa, dayOfYear };
})(window);
