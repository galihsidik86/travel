# Religio Crew — Android APK (Capacitor wrapper)

Membungkus PWA `/crew` (https://religio.sosmartpro.com/crew) menjadi APK Android
native via [Capacitor](https://capacitorjs.com/). Strategi: **remote URL** — WebView
load PWA dari server, semua fitur existing (SOS, attendance, manifest, push)
otomatis tersedia tanpa porting code.

## Prasyarat (sekali setup)

Di laptop Anda (Windows / macOS / Linux):

1. **Android Studio** (https://developer.android.com/studio) — install + open sekali
   supaya download Android SDK + build tools (~3-5 GB)
2. **JDK 17** (Android Studio biasanya bundle) — verify: `java -version`
3. **Node ≥ 20** — verify: `node --version`
4. **ANDROID_HOME env var** point ke Android SDK location
   (mis. Windows: `C:\Users\<you>\AppData\Local\Android\Sdk`)

## Build APK debug (untuk test sideload)

Run di folder `android-app/`:

```bash
# 1. Sync — copy capacitor.config.json + web assets ke android/ project
npx cap sync android

# 2. Build APK debug (auto-signed dengan debug keystore — tidak perlu config)
cd android
./gradlew assembleDebug    # macOS/Linux
# .\gradlew assembleDebug   # Windows PowerShell

# Output: android/app/build/outputs/apk/debug/app-debug.apk
```

## Sideload ke HP muthawwif

1. Transfer `app-debug.apk` ke HP (via USB, Bluetooth, atau upload ke
   cloud → download di HP)
2. Di HP Android: Settings → Security → enable "Install from unknown sources"
   untuk file manager / browser
3. Tap APK file → Install
4. Setelah install, buka app — splash gold + spinner muncul ~1 detik,
   lalu langsung load `religio.sosmartpro.com/crew` di WebView

## Build APK release (untuk Play Store atau official distribution)

Butuh signing key. Sekali setup:

```bash
# Generate keystore
keytool -genkey -v -keystore religio-crew-release.keystore \
  -alias religio-crew -keyalg RSA -keysize 2048 -validity 10000

# Simpan kredensial keystore aman — kalau hilang, tidak bisa update APK
# yang sudah dipublish ke Play Store
```

Tambah ke `android/key.properties`:
```
storeFile=../../religio-crew-release.keystore
storePassword=<your-store-password>
keyAlias=religio-crew
keyPassword=<your-key-password>
```

Build:
```bash
cd android
./gradlew assembleRelease   # macOS/Linux
# Output: android/app/build/outputs/apk/release/app-release.apk
```

## Update APK saat PWA berubah

Karena strategi remote URL, **APK tidak perlu rebuild saat content PWA berubah**.
PWA di-deploy ke server (existing workflow) langsung pickup ke APK saat user
buka app berikutnya.

Rebuild APK hanya perlu kalau:
- Capacitor config berubah (capacitor.config.json)
- Splash screen / app icon update
- Capacitor / Android SDK version bump

## Customize app icon + splash

Default Capacitor icon = green generic.

1. Siapkan icon 1024x1024 PNG + splash 2732x2732 PNG dengan logo center
2. Drop ke `android-app/resources/icon.png` + `android-app/resources/splash.png`
3. Generate semua densities + ukuran:
   ```bash
   npm install -g @capacitor/assets
   npx capacitor-assets generate --android
   ```
4. Rebuild APK

## Push notifications (opsional, kalau mau native FCM bukan web push)

Existing PWA sudah pakai Web Push via VAPID (S17/S93/S336) — work juga
di WebView Capacitor. Kalau mau native FCM (lebih reliable di Xiaomi/Vivo
yang aggressive kill background processes):

```bash
npm install @capacitor/push-notifications
npx cap sync android
```

Lalu butuh Firebase project + google-services.json. Document terpisah saat
implement.

## Troubleshooting

**APK install gagal "App not installed"**: probably mismatch architecture
atau corrupted download. Generate ulang + sideload.

**App buka tapi tidak load PWA (blank screen)**: check internet HP +
verify https://religio.sosmartpro.com/crew accessible dari browser HP.

**Splash terlalu lama**: edit `capacitor.config.json` → `SplashScreen.launchShowDuration`
ke value lebih kecil (default 1200ms).

**WebView old version** di Android lama (<10): user perlu update Chrome /
WebView via Play Store. Capacitor butuh modern WebView untuk PWA fitur.
