# GitHub Actions — auto-deploy ke VPS

## Setup sekali (5 menit)

### 1. Generate SSH keypair khusus deploy

Di laptop Anda:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/religio_deploy -N ""
```

Output 2 file:
- `~/.ssh/religio_deploy` — private key (akan jadi GitHub secret)
- `~/.ssh/religio_deploy.pub` — public key (di-install di VPS)

### 2. Install public key di VPS

```bash
ssh root@202.134.242.202

# Append public key ke authorized_keys
mkdir -p ~/.ssh
cat >> ~/.ssh/authorized_keys <<'EOF'
PASTE-ISI-religio_deploy.pub-DI-SINI
EOF
chmod 600 ~/.ssh/authorized_keys

# Verify
tail -1 ~/.ssh/authorized_keys
```

Test login dari laptop pakai key baru:
```bash
ssh -i ~/.ssh/religio_deploy root@202.134.242.202 "echo 'connected'"
```

### 3. Set GitHub repo secrets

Buka https://github.com/galihsidik86/travel/settings/secrets/actions

Klik **New repository secret**, tambah 3-4 secret:

| Name | Value |
|------|-------|
| `SSH_HOST` | `202.134.242.202` |
| `SSH_USER` | `root` |
| `SSH_PRIVATE_KEY` | (isi seluruh isi file `~/.ssh/religio_deploy`, termasuk `-----BEGIN OPENSSH PRIVATE KEY-----` dan footer) |
| `SSH_PORT` | `22` (opsional, default 22) |

### 4. Test pertama kali

Push commit kecil ke `main` (mis. edit README), atau trigger manual:

1. Buka https://github.com/galihsidik86/travel/actions
2. Klik workflow "Deploy to VPS" → "Run workflow"
3. Lihat log realtime

Kalau hijau, deploy sukses. Kalau merah, baca error message — biasanya: SSH auth fail (key salah), atau path `/opt/religio-pro` tidak ada di server tertentu, atau permission.

## Cara pakai sehari-hari

**Push ke main = auto-deploy:**

```bash
git push origin main
# Buka https://github.com/galihsidik86/travel/actions untuk lihat progress
# ~30 detik kemudian: site sudah di-update di religio.sosmartpro.com
```

**Skip auto-deploy untuk commit tertentu:**

```bash
git commit -m "docs: update README [skip deploy]"
git push origin main
# Workflow skipped — server tidak di-update
```

**Path-ignore otomatis** (sudah configured di workflow):
- Push hanya yang ubah `*.md`, `memory/`, `docs/`, `tests/`, `screens/`, `android-app/`, atau workflow file sendiri → tidak trigger deploy

**Manual trigger dengan opsi:**

Actions tab → "Deploy to VPS" → "Run workflow" → pilih:
- `run_migration: yes/no/auto` (default auto-detect dari migration dir change)
- `run_seed: yes/no` (default no, opt-in only)

## Apa yang workflow lakukan

1. Detect changes dari `git diff HEAD~1 HEAD`
2. SSH ke VPS
3. `git pull --ff-only origin main`
4. Kalau `package.json` / `package-lock.json` / `schema.prisma` berubah → `npm ci --omit=dev` + `npx prisma generate`
5. Kalau ada migration file baru → `npx prisma migrate deploy`
6. `systemctl restart religio-pro-web`
7. Verify `/api/health` respond ok
8. Exit success / fail

## Security notes

- **Dedicated key** (bukan personal SSH key Anda) — kalau bocor, tinggal hapus dari `authorized_keys` server tanpa affect login pribadi Anda
- **SSH_USER=root** is OK untuk single-deploy convenience, tapi production-grade lebih baik bikin user `deploy` dengan sudoers limit:
  ```
  deploy ALL=(religio) NOPASSWD: ALL
  deploy ALL=(root) NOPASSWD: /bin/systemctl restart religio-pro-web
  ```
- **Rotate key** kalau curiga bocor: generate ulang + update GitHub secret + replace di server `authorized_keys`

## Rollback / recovery

Kalau deploy bikin production crash:

```bash
# Di laptop: revert + push
git revert HEAD
git push origin main
# Workflow auto-deploy lagi dengan revert

# Atau cherry-pick balik ke commit sebelumnya
git reset --hard HEAD~1
git push --force origin main   # ⚠ destructive, hanya kalau yakin
```

Atau manual SSH ke server + `git reset --hard <prev-sha> && systemctl restart religio-pro-web`.
