// Stage 377 — pure-JS prayer time calculator.
//
// Method: Muslim World League (MWL) — most widely-used outside Saudi.
//   Fajr:  sun at -18° altitude before sunrise
//   Isha:  sun at -17° altitude after sunset
//   Asr:   shadow = object length + initial shadow (Shafi'i — used in Indonesia)
//   Dhuhr: solar noon
//   Maghrib: sunset
//   Sunrise: documented for reference
//
// Algorithm sources: Astronomical Algorithms by Jean Meeus + the standard
// prayer time math used by adhan-js (BSD license, formulas public domain).
//
// Accuracy: within 1 minute for most locations. For Mecca specifically
// Saudi Arabia uses Umm al-Qura which has empirical adjustments not
// included here; for use in Saudi, jemaah should verify with the masjid
// schedule. We surface a disclaimer in the view.

(function (global) {
  function deg2rad(d) { return d * Math.PI / 180; }
  function rad2deg(r) { return r * 180 / Math.PI; }

  // Julian day from Gregorian date (year, month, day)
  function julianDay(y, m, d) {
    if (m <= 2) { y -= 1; m += 12; }
    const A = Math.floor(y / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (y + 4716))
      + Math.floor(30.6001 * (m + 1))
      + d + B - 1524.5;
  }

  // Sun position: returns { declination (deg), equationOfTime (hours) }
  function sunPosition(jd) {
    const D = jd - 2451545.0;
    const g = (357.529 + 0.98560028 * D) % 360;
    const q = (280.459 + 0.98564736 * D) % 360;
    const L = (q + 1.915 * Math.sin(deg2rad(g)) + 0.020 * Math.sin(deg2rad(2 * g))) % 360;
    const e = 23.439 - 0.00000036 * D;
    const RA = rad2deg(Math.atan2(Math.cos(deg2rad(e)) * Math.sin(deg2rad(L)), Math.cos(deg2rad(L)))) / 15;
    const decl = rad2deg(Math.asin(Math.sin(deg2rad(e)) * Math.sin(deg2rad(L))));
    let EqT = q / 15 - ((RA + 24) % 24);
    if (EqT > 12) EqT -= 24;
    if (EqT < -12) EqT += 24;
    return { decl, EqT };
  }

  // Time at which sun reaches given altitude (degrees). Returns hours from
  // midnight local solar time. For fajr/isha pass negative altitude (sun
  // below horizon).
  function computeTime(altDeg, lat, decl, dhuhrHours, direction = -1) {
    // direction: -1 for before noon (fajr/sunrise), +1 for after (asr/maghrib/isha)
    const cosT = (Math.sin(deg2rad(altDeg)) - Math.sin(deg2rad(decl)) * Math.sin(deg2rad(lat)))
      / (Math.cos(deg2rad(decl)) * Math.cos(deg2rad(lat)));
    if (cosT < -1 || cosT > 1) return null; // sun doesn't reach this altitude (polar)
    const T = (1 / 15) * rad2deg(Math.acos(cosT));
    return dhuhrHours + direction * T;
  }

  // Asr time using Shafi'i (factor=1; majority Indonesia) or Hanafi (factor=2).
  // The sun's altitude at Asr is POSITIVE (still well above horizon) — the
  // angle computed here is the altitude at which shadow_length = object_height
  // + initial_shadow_at_noon.
  function asrTime(factor, lat, decl, dhuhrHours) {
    const angle = rad2deg(Math.atan(1 / (factor + Math.tan(Math.abs(deg2rad(lat - decl))))));
    return computeTime(angle, lat, decl, dhuhrHours, +1);
  }

  // hours → "HH:MM"
  function fmtHM(h) {
    if (h == null || !isFinite(h)) return '—';
    let hh = Math.floor(h);
    let mm = Math.round((h - hh) * 60);
    if (mm === 60) { mm = 0; hh += 1; }
    hh = ((hh % 24) + 24) % 24;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  /**
   * Compute prayer times for the given date + location + timezone offset
   * (hours from UTC, e.g. +3 for Saudi, +7 for WIB). Returns
   * { fajr, sunrise, dhuhr, asr, maghrib, isha } as "HH:MM" strings AND
   * raw decimal hours for downstream countdown math.
   */
  function computeTimes({ date, lat, lng, tzOffsetHours, method = 'MWL', madhab = 'shafi' }) {
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const jd = julianDay(y, m, d) - lng / (15 * 24);
    const { decl, EqT } = sunPosition(jd);
    const dhuhr = 12 + tzOffsetHours - lng / 15 - EqT;

    // Method-specific fajr/isha angles
    const angles = {
      MWL:    { fajr: 18, isha: 17 },
      ISNA:   { fajr: 15, isha: 15 },
      EGYPT:  { fajr: 19.5, isha: 17.5 },
      MAKKAH: { fajr: 18.5, isha: 0 }, // isha = maghrib + 90min
      KARACHI:{ fajr: 18, isha: 18 },
    };
    const ang = angles[method] || angles.MWL;
    const factor = madhab === 'hanafi' ? 2 : 1;

    const fajr = computeTime(-ang.fajr, lat, decl, dhuhr, -1);
    const sunrise = computeTime(-0.833, lat, decl, dhuhr, -1); // standard refraction
    const asr = asrTime(factor, lat, decl, dhuhr);
    const maghrib = computeTime(-0.833, lat, decl, dhuhr, +1);
    let isha;
    if (method === 'MAKKAH') {
      // Umm al-Qura: isha = maghrib + 90 min (Ramadhan: +120, ignored here)
      isha = maghrib != null ? maghrib + 1.5 : null;
    } else {
      isha = computeTime(-ang.isha, lat, decl, dhuhr, +1);
    }

    return {
      hours: { fajr, sunrise, dhuhr, asr, maghrib, isha },
      hm: {
        fajr: fmtHM(fajr),
        sunrise: fmtHM(sunrise),
        dhuhr: fmtHM(dhuhr),
        asr: fmtHM(asr),
        maghrib: fmtHM(maghrib),
        isha: fmtHM(isha),
      },
      meta: { method, madhab, lat, lng, tzOffsetHours, date: date.toISOString().slice(0, 10) },
    };
  }

  /**
   * Given the times object + current Date, return the next prayer:
   * { name, label, hm, deltaMinutes }
   * If past isha, returns next-day fajr (deltaMinutes includes overnight wait).
   */
  function nextPrayer(times, now = new Date()) {
    const order = [
      { name: 'fajr', label: 'Subuh' },
      { name: 'sunrise', label: 'Syuruq' }, // informational, not a prayer
      { name: 'dhuhr', label: 'Zhuhur' },
      { name: 'asr', label: 'Ashar' },
      { name: 'maghrib', label: 'Maghrib' },
      { name: 'isha', label: 'Isya' },
    ];
    const nowH = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
    for (const p of order) {
      const t = times.hours[p.name];
      if (t == null) continue;
      if (t > nowH) {
        return {
          name: p.name, label: p.label, hm: times.hm[p.name],
          deltaMinutes: Math.round((t - nowH) * 60),
        };
      }
    }
    // Past isha → next-day fajr (~24h - hoursSinceFajr)
    const fajrTomorrow = times.hours.fajr != null ? times.hours.fajr + 24 : null;
    if (fajrTomorrow == null) return null;
    return {
      name: 'fajr', label: 'Subuh (besok)', hm: times.hm.fajr,
      deltaMinutes: Math.round((fajrTomorrow - nowH) * 60),
    };
  }

  global.PrayerTimes = { computeTimes, nextPrayer, fmtHM };
})(typeof window !== 'undefined' ? window : globalThis);
