# MuseThings

Lets Muse (Meta's personal AI agent) read and manage Things 3 through a custom connector.
A small API runs on an always-on Mac next to Things and is published with Tailscale Funnel.
Design: `docs/superpowers/specs/2026-10-15-muse-things-bridge-design.md`.

## Set up the spare Mac

1. **macOS and Things.** Update macOS as far as it goes. Install Things 3 from the App Store, sign in to
   Things Cloud with your account, and check a to-do syncs from your phone. Add Things to
   System Settings → General → Login Items.
2. **Things URLs.** Things → Settings → General → turn on *Enable Things URLs* → *Manage* → copy the token.
3. **Power.** Keep it plugged in with the lid open (a closed MacBook sleeps without an external display).
   Run `sudo pmset -c sleep 0 disksleep 0 displaysleep 5 womp 1`. In System Settings → Battery, keep battery
   health management / optimized charging on. In Software Update, turn off automatic macOS installs so
   restarts happen when you choose. FileVault stays on: after any restart, log in once at the Mac.
4. **Code.** Install Node 24 (`brew install node@24` or nvm). Copy this folder to the Mac, then:
   ```bash
   npm ci
   node src/cli.ts config set thingsAuthToken <token from step 2>
   node src/cli.ts keygen          # save the printed key somewhere safe
   node src/cli.ts doctor          # click Allow when macOS asks about Terminal controlling Things
   ```
5. **Run at login.** `scripts/install-agent.sh`, then at the Mac: `MUSETHINGS_KEY=<key> scripts/smoke.sh`.
   macOS asks whether *node* may control Things and access its data. Click Allow for both.
6. **Tailscale Funnel.** Install Tailscale from tailscale.com, sign in, turn on its CLI, then
   `tailscale funnel --bg 8787`. The first time, it prints a link to enable Funnel for your tailnet.
   `tailscale funnel status` shows the public URL; save it:
   `node src/cli.ts config set publicUrl https://<mac>.<tailnet>.ts.net` and restart the agent:
   `launchctl kickstart -k gui/$(id -u)/app.musethings`.
7. **Check.** `node src/cli.ts doctor` should be all ✔. From another device:
   `MUSETHINGS_KEY=<key> scripts/smoke.sh https://<mac>.<tailnet>.ts.net`.
8. **Muse.** Follow `docs/muse-connector.md`.

## Day to day

- Logs: `~/.musethings/server.log`. Every change Muse made: `~/.musethings/audit.jsonl`.
- Restart: `launchctl kickstart -k gui/$(id -u)/app.musethings`. Stop: `launchctl bootout gui/$(id -u)/app.musethings`.
- New key: `node src/cli.ts keygen`, restart, update Muse.

## Development

`npm test` (unit + route tests, no Things needed) · `npm run typecheck` ·
`npm run test:live` (spare Mac only: writes into a temporary "MuseThings Test" area in your real Things,
then trashes it; delete the `musethings-test` tag afterwards).
