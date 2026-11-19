# MidHub agent API (for the AgentHub patch author)

Server-to-server API that BSM AgentHub calls on behalf of a session's user, over loopback only.
Base URL on the host: `http://127.0.0.1:3100/midhub/api/agent/` (AgentHub's `MIDHUB_URL` + `/api/agent/`).
Spec: `docs/superpowers/specs/2026-11-18-midhub-agenthub-integration-design.md` (section 5). The AgentHub
side is described in `docs/superpowers/plans/2026-11-18-agenthub-midhub-patch.md`.

MidHub's own errors are JSON `{ "code": "...", "message": "<Thai cause + fix>", "detail"?: "...", "checks"?: [...] }`
(`checks` only on `agent_check_failed`). Pass the `message` to the user unchanged; it is written for them.

Calls made through AgentHub's route can also fail inside AgentHub itself, before MidHub is reached. Those errors are
`{ "error": "..." }` (no `code`). Java must tell the two apart by the presence of `code`: `code` = MidHub answered;
only `error` = AgentHub's proxy answered.

| HTTP | Body from AgentHub's proxy route | Meaning |
|---|---|---|
| 401 | `{ "error": ... }` | bearer token missing, invalid, expired, or issued for a different taskId |
| 403 | `{ "error": ... }` | the actor no longer has access to the task |
| 404 | `{ "error": ... }` | path not on the allowlist (`mids`, `mids/<name>/files|logs|restart`), or the feature is off in AgentHub |
| 502 | `{ "error": "MidHub is not running" }` | connection to MidHub refused |
| 504 | `{ "error": "MidHub did not respond" }` | no answer within 120 s |

Note a 404 can come from either side: `{ "error" }` = AgentHub, `{ "code": "not_found" }` = MidHub.

## 1. Authentication headers

Every request must carry all of these (missing or invalid = rejected before anything else happens):

| Header | Value |
|---|---|
| `X-MidHub-Agent-Secret` | `MIDHUB_AGENT_SECRET` (same value in both systems, >= 32 chars) |
| `X-MidHub-Actor-Email` | email of the AgentHub user who started the run (lowercase). Must be a MidHub user and not locked |
| `X-MidHub-Session-Id` | AgentHub `taskId` (parent taskId for a sub-task). Required, non-empty after trimming, <= 128 chars, printable ASCII without spaces (characters 0x21-0x7e only); recorded in the audit log |
| `X-MidHub-Session-Instances` | optional, comma-separated `https://<x>.service-now.com/` URLs the session works with (server-side computed by AgentHub, never from the agent). Invalid entries are dropped. Empty = `session_instance` check fails |

Rules:

- Call `http://127.0.0.1:3100/midhub` so `Host` is loopback (`127.x`, `[::1]`, `localhost`, any port). Do not rewrite Host to loopback behind a proxy to get around this check, and do not send `X-Forwarded-For`, `X-Real-IP` or `Forwarded` unless every address is loopback.
- Content-Type `application/json` for JSON bodies.
- The secret must never reach `agentEnv()`, a prompt or a log line.

### Authentication failures (checked in this order)

| Condition | HTTP | `code` |
|---|---|---|
| `MIDHUB_AGENT_SECRET` not set in MidHub (feature off) | 404 | `not_found` |
| Secret header missing or wrong | 401 | `agent_auth` |
| Client IP not in the MidHub IP allowlist | 403 | `ip_blocked` (body also has `ip`) |
| `Host` or forwarding headers not loopback (call came via Caddy/proxy) | 403 | `agent_auth` |
| `X-MidHub-Session-Id` missing/empty/invalid | 400 | `agent_auth` |
| Actor email unknown, empty or account locked | 403 | `agent_user` |

Through Caddy `/midhub/api/agent/*` is answered 404 by design (see `deploy/README.md`).

## 2. Per-MID checklist

Every route with a `<name>` runs the five checks (spec 5.2) first. If any fails: HTTP 403,
`{ "code": "agent_check_failed", "message": "<first failed message>", "checks": [ ... ] }` and an `agent.check_failed`
audit entry. A check object is `{ "id", "ok", "message"? }` (`message` only when `ok` is false).

| id | Passes when | Message when failing (Thai) |
|---|---|---|
| `user_registered` | actor has an unlocked MidHub account (always ok once authenticated) | - |
| `session_instance` | the session instance set is non-empty | `session นี้ยังไม่มี instance: ตั้ง SN_INSTANCE_URL ใน .env หรือสร้างโปรเจกต์ด้วย snow-init` |
| `instance_match` | the MID's instance is in the session set | `session นี้ทำงานกับ <hosts> แต่ MID นี้ต่อ <host> เลือก MID ที่ต่อ instance ของ session หรือเพิ่ม instance นั้นใน .env` (variants when the MID's instance is unknown or its config.xml disagrees with MidHub's record) |
| `agent_access` | the per-MID "allow AgentHub" switch is on (default off) | `MID นี้ยังไม่เปิดให้ AgentHub แก้ ให้เปิดในหน้า MidHub แท็บภาพรวม` |
| `mid_ready` | no active job and state is installed | `MID นี้กำลังมีงานอยู่ (<stage>) รอให้เสร็จก่อน` or `MID นี้ยังไม่พร้อมใช้งาน (<state>) ...` or `MID นี้ถูกลบออกจาก MidHub แล้ว ...` |

Invalid `<name>` (must match `^[a-z0-9][a-z0-9-]{1,39}$`) -> 400 `invalid_name`; unknown MID -> 404 `not_found`.

## 3. Endpoints

All paths are relative to the base URL. In the curl examples:

```bash
# Through AgentHub (what the Java agent uses; taskId is the session's id):
curl -s -H "Authorization: Bearer $AGENT_MIDHUB_TOKEN" \
  "http://127.0.0.1:3000/api/tasks/<taskId>/midhub/<path>"
```

and the direct loopback form for debugging (not available to the agent; needs the secret):

```bash
curl -s \
  -H "X-MidHub-Agent-Secret: $MIDHUB_AGENT_SECRET" \
  -H "X-MidHub-Actor-Email: you@example.com" \
  -H "X-MidHub-Session-Id: debug-1" \
  -H "X-MidHub-Session-Instances: https://dev12345.service-now.com/" \
  "http://127.0.0.1:3100/midhub/api/agent/<path>"
```

Paths under `mids/<name>/files` take MID-relative paths (e.g. `agent/extlib/foo.jar`); a leading `/` is ignored.
`agent/bin`, `agent/lib`, `agent/jre` are read-only, and `agent/config.xml` / `agent/conf/wrapper-override.conf` are managed by MidHub (use its config tab): writes return 403 `read_only` / `use_config_tab`.

### GET mids

Lists all non-removed MIDs with their checks. Read-only, not audited. Always start here and use only MIDs with `usable: true`.

```bash
curl -s -H "Authorization: Bearer $AGENT_MIDHUB_TOKEN" http://127.0.0.1:3000/api/tasks/<taskId>/midhub/mids
```
```json
{ "mids": [ {
  "name": "poc-a", "snName": "poc-a-mid", "instanceUrl": "https://dev12345.service-now.com/",
  "status": "ทำงานอยู่", "usable": false,
  "checks": [
    { "id": "user_registered", "ok": true },
    { "id": "session_instance", "ok": true },
    { "id": "instance_match", "ok": true },
    { "id": "agent_access", "ok": false, "message": "MID นี้ยังไม่เปิดให้ AgentHub แก้ ให้เปิดในหน้า MidHub แท็บภาพรวม" },
    { "id": "mid_ready", "ok": true }
  ]
} ] }
```
`checks` always has all five entries in this fixed order. (`status` is the Thai status label shown in the MidHub UI; `instanceUrl` may be `null`.)

### GET mids/&lt;name&gt;/files?path=

List a directory (`path` empty = MID root). Not audited.

```bash
curl -s -H "Authorization: Bearer $AGENT_MIDHUB_TOKEN" \
  "http://127.0.0.1:3000/api/tasks/<taskId>/midhub/mids/poc-a/files?path=agent/extlib"
```
```json
{ "entries": [ { "name": "foo.jar", "type": "file", "size": 1234, "mtime": "2026-11-18T10:00:00.000Z",
  "readOnly": false, "symlink": false, "locked": false, "secret": false, "config": false } ], "readOnly": false }
```
`readOnly`, `symlink`, `locked`, `secret` and `config` are booleans: `locked` = rename/delete always refused; `secret` = contents never
served (config.xml); `config` = managed config file, edited in the MidHub config tab.
`readOnly` (top level) says the directory itself cannot be modified.

### GET mids/&lt;name&gt;/files?path=&content=1

Read a text file (<= 2 MiB, UTF-8 text). Returns the `hash` to pass as `baseHash` when writing. Errors: 415 `not_text`, 413 `too_large`.

```bash
curl -s -H "Authorization: Bearer $AGENT_MIDHUB_TOKEN" \
  "http://127.0.0.1:3000/api/tasks/<taskId>/midhub/mids/poc-a/files?path=agent/extlib/app.properties&content=1"
```
```json
{ "content": "a=1\n", "hash": "<sha256 hex>" }
```

### PUT mids/&lt;name&gt;/files

Write a text file (<= 2 MiB). Audit `agent.file.write`.

Request `{ "path": "...", "content": "...", "baseHash": "<hash from the read>" }`; `baseHash: ""` creates a new file
(409 `exists` if it is already there; 409 `stale` if the hash is out of date, so re-read and retry). Response `{ "hash": "<new hash>" }`.

```bash
curl -s -X PUT -H "Authorization: Bearer $AGENT_MIDHUB_TOKEN" -H "Content-Type: application/json" \
  -d '{"path":"agent/extlib/app.properties","content":"a=2\n","baseHash":"<hash>"}' \
  http://127.0.0.1:3000/api/tasks/<taskId>/midhub/mids/poc-a/files
```

### POST mids/&lt;name&gt;/files?dir=&filename= (raw upload)

Upload a binary file; the body is the raw bytes (not multipart) and `Content-Length` is required (curl sets it for
`--data-binary @file`; chunked uploads get 411).
**Java jars (`agent/extlib`):** on every MID start ServiceNow's `FileSync:ecc_agent_jar` deletes any jar in `agent/extlib` that is not
registered in the instance as a MID Server JAR File (`ecc_agent_jar`). Register the jar there, or expect it to vanish on the next MID start. Replaces an existing file of the same name atomically (keeps its mode).
Audit `agent.file.upload`. Response `{ "size": 1234, "path": "agent/extlib/foo.jar" }`.

```bash
curl -s -X POST -H "Authorization: Bearer $AGENT_MIDHUB_TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @foo.jar \
  "http://127.0.0.1:3000/api/tasks/<taskId>/midhub/mids/poc-a/files?dir=agent/extlib&filename=foo.jar"
```

### POST mids/&lt;name&gt;/files (JSON ops)

`{ "op": "mkdir", "parent": "agent/extlib", "name": "sub" }` -> `{}` (audit `agent.file.mkdir`).
`{ "op": "rename", "path": "agent/extlib/a.jar", "newName": "b.jar" }` -> `{ "to": "agent/extlib/b.jar" }` (audit `agent.file.rename`).
Anything else -> 400 `invalid_request`.

```bash
curl -s -X POST -H "Authorization: Bearer $AGENT_MIDHUB_TOKEN" -H "Content-Type: application/json" \
  -d '{"op":"mkdir","parent":"agent/extlib","name":"sub"}' \
  http://127.0.0.1:3000/api/tasks/<taskId>/midhub/mids/poc-a/files
```

### DELETE mids/&lt;name&gt;/files?path=

Delete a file or folder (as in the MidHub files tab). Response `{}`. Audit `agent.file.delete`.

```bash
curl -s -X DELETE -H "Authorization: Bearer $AGENT_MIDHUB_TOKEN" \
  "http://127.0.0.1:3000/api/tasks/<taskId>/midhub/mids/poc-a/files?path=agent/extlib/old.jar"
```

### GET mids/&lt;name&gt;/logs?file=main|wrapper&lines=

Last N lines of the MID log. `file` = `main` (default, agent0.log.0) or `wrapper`; `lines` default 200, clamped to 1..2000
(non-numeric = 200). Other `file` -> 400 `invalid_request`. A log file that does not exist yet returns
`{ "lines": [] }` (not an error). Not audited.

```bash
curl -s -H "Authorization: Bearer $AGENT_MIDHUB_TOKEN" \
  "http://127.0.0.1:3000/api/tasks/<taskId>/midhub/mids/poc-a/logs?file=wrapper&lines=100"
```
```json
{ "lines": ["2026-11-18 10:00:00 ...", "..."] }
```

### POST mids/&lt;name&gt;/restart

Restart through the root helper (also starts a stopped MID; same running-MID quota as the UI). No body needed (ignored).
Response `{ "ok": true }`. Audit `agent.restart` (also on failure, with `ok:false`). If the server is low on RAM and the MID is
not running, returns 409 `low_memory`; there is no confirm step for agents, so tell the user to start it in MidHub.

```bash
curl -s -X POST -H "Authorization: Bearer $AGENT_MIDHUB_TOKEN" \
  http://127.0.0.1:3000/api/tasks/<taskId>/midhub/mids/poc-a/restart
```

## 4. Error codes

`message` is Thai. HTTP status is part of the contract except where noted.

| code | HTTP | Meaning |
|---|---|---|
| `not_found` | 404 | feature off (secret unset), or unknown MID / file / path |
| `agent_auth` | 401 / 403 / 400 | bad secret (401); not loopback Host/forwarding headers (403); bad session id (400) |
| `ip_blocked` | 403 | client IP not in the MidHub IP allowlist |
| `agent_user` | 403 | actor email has no (or a locked) MidHub account |
| `agent_check_failed` | 403 | checklist failed; body has `checks` |
| `invalid_name` | 400 | MID name syntax |
| (405, no body code) | 405 | method not supported on the route (e.g. PUT on `mids`, GET on `restart`) |
| `invalid_request` | 400 | malformed JSON/params, unknown `op`, bad `file`, or upload body length != Content-Length |
| `invalid_filename` | 400 | bad file/folder name |
| `path_outside` | 400 | path escapes the MID folder |
| `read_only` | 403 | `agent/bin|lib|jre` or other protected path |
| `use_config_tab` | 403 | `config.xml` / wrapper override: edited in the MidHub config tab only |
| `no_permission` | 403 | file permissions wrong on the host (an Admin must run "fix permissions" in MidHub) |
| `not_text` | 415 | file is not text (cannot be read as content) |
| `too_large` | 413 | text > 2 MiB, or upload > 50 MiB (declared length) |
| `length_required` | 411 | upload without a valid `Content-Length` |
| `stale` | 409 | `baseHash` no longer matches; re-read and retry |
| `exists` | 409 | `baseHash:""` create but the file exists |
| `conflict` | 409 | target is a directory/symlink where a file is expected, or similar |
| `disk_full` | 409 | MID volume full |
| `quota_full` | 409 | restart would exceed the running-MID limit (`MIDHUB_MAX_RUNNING`) |
| `low_memory` | 409 | not enough free RAM to start the MID |
| `busy` | 429 (upload) / 503 (helper) | 2 agent uploads already running (429) / helper busy (503); retry later |
| `not_a_mid`, `invalid_xml` | 400 | not raised by agent routes in practice (MID folder/config validation used by other MidHub flows) |
| `helper_down` | 503 | root helper not responding |
| `systemctl_failed`, `internal` | 500 | helper/system failure; `detail` has more |

## 5. Limits

- Upload: 50 MiB (52,428,800 bytes) per file, `Content-Length` required, at most 2 concurrent agent uploads per MidHub process.
- Text read/write: 2 MiB.
- Logs: <= 2000 lines per call.
- These routes are not body-limited by Caddy (they never pass through it) and not buffered by Next (`/api/agent/*` is excluded from the proxy matcher), so streaming uploads work.
- Every mutating call is audited under the real user as `agent.*` with `{ via: "agenthub", taskId, sessionInstances, path? }`; the secret is never logged.
