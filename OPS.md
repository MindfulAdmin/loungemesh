# Mindful Design office stack — ops notes

## URLs
- Spatial lounge: https://office.mindfuldesign.me  (LoungeMesh)
- Classic meetings: https://meet.mindfuldesign.me  (Jitsi Meet + lobby)

## Server
- SSH: `ssh office-md` (deploy@91.99.230.113)
- App dir: `/opt/loungemesh`
- Host account password: `/opt/loungemesh/.jitsi-host-matt` (chmod 600)

## Common commands
```bash
cd /opt/loungemesh
docker compose ps
docker compose logs -f jvb jitsi-web loungemesh
./scripts/loungemesh.sh deploy
./scripts/loungemesh.sh fix-jvb --public-ip=91.99.230.113
```

## Create another Jitsi host user
```bash
cd /opt/loungemesh
PASS=$(openssl rand -base64 18 | tr -d "/+=" | head -c 20)
docker compose exec -T prosody prosodyctl --config /config/prosody.cfg.lua register USERNAME auth.meet.jitsi "$PASS"
echo "$PASS"
```

## Meeting flow
1. Host opens https://meet.mindfuldesign.me/SomeRoomName
2. Log in as authenticated host (matt / see .jitsi-host-matt)
3. Enable Lobby in meeting security settings if not already prompting
4. Share the room URL; guests wait until admitted

## DNS
Both `office` and `meet` A records must point to 91.99.230.113 with Cloudflare **proxy OFF** (DNS only).

## Mindful Design branding

- Logos live in `branding/` and are bind-mounted into `jitsi-web` (`docker-compose.yml`).
- Meet overrides: `docker/jitsi-config/web/custom-config.js` + `custom-interface_config.js` (APP_NAME **Mindful Meet**, Jitsi watermark/footer/mobile promo off).
- Office (LoungeMesh fork): favicon/logo/meta/header strings → **Mindful Office**; theme accent `#A68E65`.
- After logo changes: `docker compose up -d jitsi-web` and/or `docker compose build loungemesh && docker compose up -d loungemesh`.

## Recording

- **Office:** browser-local Rec toolbar (MediaRecorder) — host downloads the file. No server component.
- **Meet:** `config.localRecording` enabled (browser local recording).
- **Jibri / cloud recording:** enabled — see section below.


## Jibri / cloud recording

Enabled (`ENABLE_RECORDING=1`, service `jibri` pinned to `jitsi/jibri:stable-10888`).

- **Start:** In a Meet room as moderator → overflow menu → **Start recording**
- **Files:** `/opt/loungemesh/docker/jitsi-config/jibri/recordings/` (MP4). Fetch with `scp office-md:...`
- **Limits:** One concurrent recording on this ~8 GB host. Watch `docker stats` / `free -h` during use.
- **Caps:** Jibri needs `SYS_ADMIN` + `seccomp:unconfined` + `shm_size: 2gb` + `DISPLAY=:0` (see `docker-compose.yml`).
- **Bring-up:** `docker compose up -d jibri` (included in normal compose). Logs: `docker compose logs -f jibri`

Local browser recording on Meet and LoungeMesh Rec remain available as fallbacks.

## Meet host login (internal auth)

- `ENABLE_AUTH=1`, `ENABLE_GUESTS=1`, `AUTH_TYPE=internal`
- **Host login:** username `matt` (not the email), password in `branding/.matt-meet-password` on the server (`chmod 600`)
- Creating/starting meetings requires host login; invitees join as guests without that password
- Reset password:
  ```bash
  cd /opt/loungemesh
  NEW=$(openssl rand -base64 18 | tr -d "/+=" | head -c 20)
  echo -n "$NEW" > branding/.matt-meet-password && chmod 600 branding/.matt-meet-password
  docker compose exec prosody prosodyctl --config /config/prosody.cfg.lua register matt meet.jitsi "$NEW"
  # host accounts live on meet.jitsi
  ```

## Office XMPP service account (ENABLE_AUTH)

With Meet host auth enabled, LoungeMesh must authenticate to Prosody to create/join conferences.

- Prosody user: `office@meet.jitsi` (login username `office`)
- Password file: `branding/.office-xmpp-password` (mode 600)
- Env (baked into SPA at build): `VITE_JITSI_XMPP_USER` / `VITE_JITSI_XMPP_PASSWORD`
- Mirror: `LOUNGEMESH_XMPP_USER` / `LOUNGEMESH_XMPP_PASSWORD`

Rebuild after rotating: `docker compose build loungemesh && docker compose up -d loungemesh`


## Backups

- Script: `~/bin/backup-mindfulmeet.sh` (cron **03:30 UTC**)
- Check: `~/bin/check-mindfulmeet-backup.sh`
- Local: `~/backups/mindfulmeet/` (db + app + recordings archives; 14-day prune)
- Offsite: Google Drive via rclone remote `gdrive:` → folder **MindfulMeet-Backups**
- Restore notes: `~/backups/mindfulmeet/RESTORE.md`

## Recordings UI

- **Primary:** https://office.mindfuldesign.me/recordings/
- Alias: https://recordings.mindfuldesign.me → redirects to primary
- App: custom Mindful Recordings (Express) via `docker-compose.recordings.yml` — not File Browser
- Login: username `admin` — password in `branding/.recordings-password` (+ 1Password)
- Titles: room name + date/time from Jibri `metadata.json` (Europe/London)
- Finalize rename: `docker/jitsi-config/jibri/finalize_recording.sh` + `JIBRI_FINALIZE_RECORDING_SCRIPT_PATH`
- Font: Lato (shared with office/meet branding)

## Meet branding CSS (do not break)

- **Never** add `<!DOCTYPE html>` to `branding/index.html` without keeping `html, body, #react { height: 100% }` (see `mindful-welcome.css`). Upstream Jitsi index has no DOCTYPE; standards mode collapses prejoin to top-left.
- Keep Mindful/Lato overrides in `branding/mindful-welcome.css` only. Restore stock `branding/all.css` from the jitsi-web image if it drifts (only allowed tweak: `welcome-background.jpg`).
- Logos: `mindful-logo-dark.png` (gold), `mindful-logo-white.png` (white). Meet welcome mounts white as `mindful-logo.png` / watermark.

