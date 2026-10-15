# MuseThings: a Things 3 bridge for Meta's Muse — design

Date: 2026-10-15
Status: approved 2026-10-15

## Goal

Let Muse (Meta's personal AI agent, iPhone/iPad) fully manage Nicolas's to-dos in Things 3:
read every list, and add, edit, complete, reschedule, move, tag and trash to-dos and projects.

Muse has no Things connector, and Things has no cloud API. Muse can, however, build a
**custom connector** from a service's API description and an API key. MuseThings is that
service: a small HTTPS API that runs next to Things on an always-on Mac.

### What the user said

- Muse = "Muse from Meta", the personal agent app.
- Wants **full control** of Things, not just adding to-dos.
- Has a **spare MacBook Pro (2021 or earlier)** to run it on; no Raspberry Pi needed.
- Approved the architecture: plain HTTPS API + API key, reads from the Things database,
  writes through Things' AppleScript.

### Assumptions (correct these in review)

- The spare MacBook can install current Things 3 from the Mac App Store. If it can't, this
  design doesn't change, but the bridge would need a different always-on Mac.
- One user (Nicolas), one Things account. No sharing.
- Muse custom connectors work as reported in October 2026: API-key connectors persist;
  OAuth ones drop after about an hour. That's why there is no OAuth here.

### Success criteria

1. From Muse on the phone, "what's on my Today?" returns exactly what Things shows.
2. "Add *call the dentist* to my Errands project for tomorrow, deadline Friday, tag *phone*"
   creates that to-do; it appears on the phone through Things Cloud within a minute.
3. Complete, reopen, reschedule (incl. This Evening and a reminder time), move, retag,
   edit notes and checklists, and trash all work. Muse asks before trashing.
4. It keeps working with the main laptop closed; only the spare Mac needs to be on.
5. A request without the right key gets 401 and changes nothing.
6. If Things is quit or the Mac restarts (and is logged in), the bridge recovers on its own.

## Architecture

```
Muse (phone) ──HTTPS + API key──▶ Tailscale Funnel ──▶ Spare MacBook Pro
                                                       ├─ musethings (Node 24, LaunchAgent)
                                                       │   ├─ reads  → Things SQLite DB (read-only)
                                                       │   └─ writes → AppleScript + Things URL scheme
                                                       └─ Things 3 ⇅ Things Cloud ⇅ phone, main Mac
```

**Tunnel: Tailscale Funnel.** (Changed from the Cloudflare Tunnel floated in chat.) Funnel
gives a fixed `https://<mac-name>.<tailnet>.ts.net` address for free with no domain to own
or manage, which is all Muse needs. Cloudflare's fixed-hostname tunnels require a domain on
Cloudflare. Funnel terminates TLS and forwards to `127.0.0.1:8787`; the server listens on
localhost only and is never exposed to the LAN.

**Why reads and writes take different paths.** Reading Things' SQLite database directly is
fast and returns everything (checklists, headings, reminder times) in one query. It is the
approach used by the widely used things.py library. The database is Things' private format,
so we only ever open it read-only. All changes go through Things itself, using its two
documented automation interfaces, so Things stays the only writer and syncs every change
normally. AppleScript creates and trashes items, moves them to the Inbox and sets tags
(it creates tags that don't exist yet, which the URL scheme doesn't), and returns the id
of what it created. The `things:///update` URL scheme (with Things' auth token) sets every
other field, because it takes ISO dates, This Evening, reminder times, deadlines,
checklists and headings directly.

## Components

Each unit is small, has one job, and is tested on its own.

| Unit | Job | Depends on |
|---|---|---|
| `config` | Loads `~/.musethings/config.json` (port, Things auth token, timezone), and the API key hash. File mode 0600. | — |
| `auth` | Checks `Authorization: Bearer <key>` against a stored SHA-256 hash in constant time. After 10 bad-key requests in a minute, further bad-key requests get 429 for 15 minutes; a correct key is never blocked. | `config` |
| `things/dates` | Converts Things' packed date integers (`year<<16 \| month<<12 \| day<<7`) and Unix-second timestamps to and from ISO dates in the Mac's timezone. | — |
| `things/db` | Finds the database under `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/`, opens it read-only with `node:sqlite`, runs the list/search queries, and maps rows to API objects. Only file that knows table and column names (`TMTask`, `TMArea`, `TMTag`, `TMTaskTag`, `TMChecklistItem`). | `things/dates` |
| `things/applescript` | Runs fixed AppleScript templates via `osascript`. **User text is never put into script source**; it's passed as `argv` to an `on run argv` handler, which rules out script injection. Returns the Things id of what it created or changed. | — |
| `things/urlscheme` | Builds `things:///update` / `things:///update-project` URLs with the auth token and opens them with `open -g` (Things stays in the background). | `config` |
| `things/writer` | The write operations (create, update, complete, …). Validates and plans each write, chooses AppleScript or URL scheme per field, runs one write at a time through a queue, then re-reads the item from the database until it matches what was asked (up to 5 s) and returns it. | `applescript`, `urlscheme`, `db` |
| `audit` | Appends every write to `~/.musethings/audit.jsonl`: time, endpoint, item id, the item before and after. | — |
| `server` | Fastify HTTP server: routes, JSON-schema validation, error mapping. Serves `/openapi.json` generated from the same schemas, which is what Muse reads to build its connector. | everything above |
| `cli` | `musethings keygen` (prints a new key once, stores its hash), `musethings doctor` (checks DB access, Automation permission, Things running, URL auth token, Funnel status), `musethings serve`. | everything above |

Things' state lives only in Things. MuseThings stores nothing but its config, the key hash,
and the audit log.

## API

All endpoints except `/health` and `/openapi.json` (the API description, no data) require the bearer key. JSON in and out. Ids are Things' own
ids, so a to-do's id never changes and `things:///show?id=<id>` opens it.

Each operation is labelled through its OpenAPI `tags` as
**read**, **write**, or **sensitive**, so the connector Muse builds treats them that way.
Muse already asks before important actions by default; sensitive ones are the ones that
should always need a yes.

### Objects

```jsonc
// To-do
{
  "id": "Abc123…", "title": "Call the dentist", "notes": "…",
  "status": "open",                     // open | completed | canceled
  "list": "upcoming",                   // inbox | today | evening | upcoming | anytime | someday | logbook | trash
  "when": "2026-10-16",                 // start date, or null
  "reminder": "09:30",                  // or null
  "deadline": "2026-10-17",             // or null
  "tags": ["phone"],
  "project": {"id": "…", "title": "Errands"},  // or null
  "area": null,                         // {id,title} or null
  "heading": null,                      // {id,title} or null
  "checklist": [{"id": "…", "title": "Find insurance card", "done": false}],
  "repeating": false,
  "created_at": "…", "modified_at": "…", "completed_at": null
}
// Project: same fields minus checklist/heading/project, plus
//   "todos_open": 4, "headings": [{"id","title"}]
// Area: {"id","title","tags"}   Tag: {"id","title","parent"}
```

### Read (label: read)

| Endpoint | Returns |
|---|---|
| `GET /health` (no key) | `{ok, things_running, db_readable}`, nothing about your data |
| `GET /lists/{list}` | To-dos in `inbox`, `today` (incl. evening), `upcoming`, `anytime`, `someday`, `logbook`, in Things' order. `?limit=` (default 100, max 500), logbook `?since=` |
| `GET /todos` | Search: `?q=` (title + notes), `?tag=`, `?project_id=`, `?area_id=`, `?deadline_before=`, `?status=` (default open) |
| `GET /todos/{id}` | One to-do |
| `GET /projects`, `GET /projects/{id}` | Open projects; one project with its to-dos grouped by heading |
| `GET /areas`, `GET /areas/{id}` | Areas; one area with its projects and loose to-dos |
| `GET /tags` | All tags |

### Write (label: write unless marked sensitive)

| Endpoint | Does |
|---|---|
| `POST /todos` | Create. `title` required; optional `notes`, `when` (`today` \| `evening` \| `tomorrow` \| `anytime` \| `someday` \| `YYYY-MM-DD`), `reminder` (`HH:MM`, needs a `when` date), `deadline`, `tags`, `project_id` or `area_id`, `heading_id` (implies its project), `checklist` (titles). Defaults to the Inbox. Tags that don't exist yet are created. |
| `PATCH /todos/{id}` | Change any of the fields above. `null` clears `when`/`deadline`/`reminder`/`notes`; moving to Inbox is `"list": "inbox"`. `tags` replaces the set; `add_tags`/`remove_tags` edit it. `checklist` replaces; `add_checklist` appends. |
| `POST /todos/{id}/complete` · `/cancel` · `/reopen` | Status changes |
| `DELETE /todos/{id}` — **sensitive** | Moves to Things' Trash (recoverable in Things). Never empties the Trash. |
| `POST /projects` | Create a project: `title`, optional `notes`, `area_id`, `when`, `deadline`, `tags`, `todos` (titles). |
| `PATCH /projects/{id}` | Change title, notes, area, when, deadline, tags |
| `POST /projects/{id}/complete` · `/cancel` — **sensitive** | Things completes/cancels every open to-do in it too |
| `DELETE /projects/{id}` — **sensitive** | Moves the project and its to-dos to Trash |

There is no bulk endpoint; Muse makes one call per item, so each change is checked and
logged on its own.

### Errors

Every error is `{error: {code, message}}` with a message written for Muse to relay.

| Situation | Status / code |
|---|---|
| Missing or wrong key | 401 `unauthorized` (429 once bad keys are being throttled) |
| Bad input (unknown list, bad date, reminder without date, both `project_id` and `area_id`) | 400 `invalid_request` naming the field |
| Id not found, or a project id given where a to-do is expected | 404 `not_found` |
| Writing to a repeating to-do's template | 409 `repeating_not_supported` |
| Things not running | Bridge launches it in the background (`open -gja Things3`) before each write; if it still can't be reached, 503 `things_unavailable` |
| Things doesn't apply a change within 5 s (wrong auth token, Things stuck on a dialog) | 503 `write_not_confirmed`, naming the fields that didn't change |
| AppleScript Automation permission missing, or Things URL auth token wrong | 503 `setup_required`, plus what to fix (`musethings doctor` gives the same) |
| Database busy | Retried for up to 1 s, then 503 |
| Mac asleep/off or tunnel down | Muse gets a connection error; nothing the bridge can do. Setup prevents it. |

## Running on the spare Mac

These go in the README as a numbered checklist; `musethings doctor` checks each one it can.

1. Update macOS as far as it goes. Install Things 3, sign in to Things Cloud, check it syncs.
2. In Things → Settings → General, enable Things URLs; copy the auth token into the config.
3. Power: always plugged in; Battery → never sleep on power adapter; screen may turn off.
   Lid **open** (closing it sleeps a MacBook without an external display). Turn on battery
   health management so it doesn't sit at 100%.
4. Install Node 24 and Tailscale; `musethings keygen`; enable Funnel on port 443 → 8787.
5. Install the LaunchAgent (`~/Library/LaunchAgents/app.musethings.plist`, `KeepAlive`). It
   must be a *user* agent, not a system daemon: AppleScript and the Things database belong
   to the logged-in user's session. Add Things to Login Items.
6. Grant permissions when macOS asks: Automation (node → Things) and access to Things'
   data. `doctor` triggers both prompts so this happens once, at setup.
7. In Muse: ask it to create a custom connector, give it
   `https://<mac>.<tailnet>.ts.net/openapi.json` and the key.

### Decision: login after a restart — FileVault stays on (decided 2026-10-15)

The bridge only runs while a user is logged in.

- **Chosen: keep FileVault on.** After a restart (macOS updates, power cut) someone
  has to log in once at the Mac before Muse can reach Things. Restarts are rare, and
  `/health` going unreachable makes it obvious. If the laptop is lost or stolen, the disk,
  your Things data and the API key hash stay encrypted.
- *Rejected: FileVault off + automatic login.* Fully hands-off after restarts, but anyone holding
  the laptop can read the disk.

## Security

- Exposed surface: one HTTPS hostname, bearer key required for everything but `/health` and `/openapi.json`.
  The key is 32 random bytes (base64url); only its SHA-256 hash is stored. Rotating it =
  `keygen` again and updating Muse.
- Server binds to `127.0.0.1`; only Funnel reaches it.
- No user text in AppleScript source (argv only); URL scheme values are URL-encoded.
- Request bodies capped at 64 KB; titles at 4,000 characters, notes at 10,000.
- Muse sees your Things data while you use the connector. Meta's handling of connector data
  is outside this project; the audit log shows exactly what Muse changed.

## Testing

- **Unit (vitest):** `dates` round-trips, including timezone and year edges; `auth`
  (constant-time compare, throttling); request validation per endpoint; `applescript`
  passes text with quotes, newlines and `"; do shell script …` safely through argv; the
  writer chooses the right path per field.
- **Database reads:** tests run against a fixture SQLite built from the real Things schema
  (copied as DDL only, no data) plus synthetic rows, one per list and edge case (evening,
  heading, checklist, repeating, trashed, logbook). A test fails if the live schema on the
  Mac drifts from the fixture's columns.
- **Live (`npm run test:live`, on the spare Mac only):** runs every write endpoint against
  real Things inside a dedicated area "MuseThings Test", checks each result by reading
  back, then trashes everything it created.
- **End to end:** curl through the Funnel URL (401 without key, create/read/complete with
  it), then the success-criteria phrases in Muse itself.

## Out of scope

- Creating or editing repeating to-dos (neither AppleScript nor the URL scheme supports it;
  they're readable and completable via their instances).
- Emptying the Trash, deleting areas or tags, editing the Logbook.
- MCP / OAuth, other AI clients, a Raspberry Pi front door, multiple users.
- A web UI. Muse is the UI; the audit log is the history.
