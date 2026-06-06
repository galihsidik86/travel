# Screenshot Guide — Religio Pro Deck

The deck generator (`scripts/build-presentation.js`) reserves a placeholder
box on slides that should display a UI screenshot. Drop the PNGs below
into `presentation/screenshots/` (this folder) and re-run:

```bash
node scripts/build-presentation.js
```

The placeholders auto-replace with your images. Until then, the deck shows
a dashed box with the expected filename.

## Automated capture (recommended)

Run the Playwright capture script — it logs in per-role, navigates each URL,
takes full-page screenshots, and writes PNGs straight into this folder:

```bash
npm run dev                              # in one terminal
node scripts/capture-screenshots.js      # in another
node scripts/build-presentation.js       # regenerate the .pptx with embedded shots
```

The script auto-resolves dynamic IDs (paket slug, booking id, payout id)
from the running DB. If no payout exists, it creates a `PO-DEMO-...` row
so the slip screenshot still renders.

## Manual capture (alternative)

The cleanest workflow:

1. Start the dev server: `npm run dev`
2. Login as the appropriate role (see seed creds below).
3. Navigate to each URL listed.
4. Take a **full-page screenshot** — Chrome DevTools:
   - `F12` → `Ctrl+Shift+P` → "Capture full size screenshot"
   - or "Capture node screenshot" if you want just one panel.
5. Save the PNG into this folder with the **exact filename** listed.
6. Re-run the generator.

Seed credentials (from `prisma/seed.js`):

- `owner@religio.pro` / `owner12345` — OWNER (full /admin access)
- `kasir@religio.pro` / `kasir12345` — KASIR
- `ahmad@religio.pro` / `ahmad12345` — AGEN (slug `ahmad-w`)

For the JEMAAH and MUTHAWWIF portals, use any fixture user the seed
script created (or create one via `/register` for jemaah).

## Filenames + URLs

| Filename | Capture | Role |
|----------|---------|------|
| `01-public-landing.png` | `http://localhost:3001/p/ramadhan-aqsa-2026?a=ahmad-w` | (logged out) |
| `02-jemaah-portal.png` | `http://localhost:3001/saya` | JEMAAH |
| `03-agen-crm.png` | `http://localhost:3001/agen?tab=leads` | AGEN |
| `04-crew-portal.png` | `http://localhost:3001/crew` | MUTHAWWIF |
| `05-admin-overview.png` | `http://localhost:3001/admin?tab=overview` | OWNER |
| `06-mobile-pwa.png` | DevTools → device toolbar → iPhone → `/saya` | JEMAAH |
| `07-print-manifest.png` | `http://localhost:3001/admin/manifest/<slug>/print` | OWNER |
| `08-print-voucher.png` | `http://localhost:3001/admin/bookings/<id>/print` | OWNER |
| `09-print-slip.png` | `http://localhost:3001/admin/payouts/<id>/print` | OWNER |
| `10-leaderboard.png` | `http://localhost:3001/admin` (scroll to "Leaderboard paket") | OWNER |

## Aspect ratio hint

Each placeholder is roughly 5.4" × 3.8" at the 16:9 slide aspect — capture
in landscape (1280×900 or wider) so the image doesn't get stretched. Mobile
screen (`06-mobile-pwa.png`) is OK as portrait — pptxgenjs preserves the
embedded ratio when you fit-to-box.

## Already have HTML mockups?

The static design package under `screens/` already has full HTML mockups
(`screens/admin-dashboard.html`, `screens/agen-crm.html`, `screens/crew-app.html`,
`screens/jemaah-app.html`, `screens/paket-detail.html`). You can screenshot
those directly while served by the dev server — they're at `/screens/<name>.html`
and don't require login.
