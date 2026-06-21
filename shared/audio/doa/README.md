# Doa MP3 recordings

Drop MP3 files here untuk playback "▶ Arab" yang real (bukan TTS).

## Naming convention

File name harus match `audioUrl` di `shared/doa-harian.js`:

```
masuk-masjidil-haram.mp3
melihat-kabah.mp3
minum-zamzam.mp3
keluar-masjidil-haram.mp3
sapu-jagat.mp3
masuk-masjid-nabawi.mp3
ziarah-makam-rasul.mp3
antara-rukun-yamani.mp3
selesai-sai.mp3
keselamatan-perjalanan.mp3
```

(daftar lengkap kosong file → fallback ke TTS otomatis)

## Specifications

- Format: MP3
- Bitrate: 96-128 kbps mono sufficient (~20-40 KB per doa pendek)
- Length: 5-30 detik per doa
- Source: rekaman qori dengan tartil yang benar (PERHATIKAN COPYRIGHT)

## Public access

Folder `shared/` di-serve via `express.static` → file MP3 di sini accessible
publicly di `https://religio.sosmartpro.com/shared/audio/doa/<filename>.mp3`.

Tidak perlu auth — jemaah anonymous bisa preview audio dari `/p/<slug>`
sebelum booking (future use).
