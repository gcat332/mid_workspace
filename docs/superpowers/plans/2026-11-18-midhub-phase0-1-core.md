# MidHub Phase 0–1 (Spike + Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed MidHub at `/midhub` where the MFEC team logs in (local or the same SSO IdP as AgentHub), sees every MID on the host, starts/stops/restarts them within a 4-running quota, edits their config with backup/rollback, manages their files, and tails their logs — with MIDs that were installed by hand in the Phase 0 spike.

**Architecture:** One Next.js 16 app (`basePath: "/midhub"`, port 3100, user `bsmmidhub`) with its own SQLite DB and auth, copied and trimmed from AgentHub. Every root-level action goes through `midhub-helper`, a small root daemon on a Unix socket that accepts a fixed list of operations. MID files live in `/opt/midhub/mids/<name>/`, owned `midsvc:midhub` with group write so the app edits them without root.

**Tech Stack:** Next.js 16.4 / React 19.3 / TypeScript 5, Tailwind v4, Prisma 7 + `@prisma/adapter-better-sqlite3`, `jose`, `bcryptjs`, `@monaco-editor/react`, `fast-xml-parser` (XML validation only), Vitest 4, Node 22, systemd, Caddy.

**Spec:** `docs/superpowers/specs/2026-11-18-midhub-design.md`

**Out of scope here (separate plans, written after the spike):** Phase 2 (saved-instance UI, install/clone wizard, job engine, uninstall) and Phase 3 (upgrade/rollback).

**Reference app (read-only, copy from it):** `/Users/gcat332/Documents/Work/MFEC/bsm_agenthub/ai-workspace` — referred to below as `AH/`.

## Global Constraints

- OS: Linux only. Host is shared with AgentHub (8 GB RAM + 4 GB swap; AgentHub `MemoryMax=6G`).
- Max **4** MIDs running at once (`MIDHUB_MAX_RUNNING=4`), enforced in the UI/API **and** in the helper.
- MID name regex: `^[a-z0-9][a-z0-9-]{1,39}$`. systemd unit name: `midhub-mid-<name>.service`. MID root: `${MIDHUB_ROOT}/mids/<name>` with `MIDHUB_ROOT=/opt/midhub`.
- MID process user `midsvc`; app user `bsmmidhub`; shared group `midhub`. App never runs as root.
- Default heap 1024 MB; unit `MemoryMax = heapMb + 512` MB.
- Read-only inside the file manager: `agent/bin`, `agent/lib`, `agent/jre` (and everything under them).
- Upload cap 50 MB.
- Auth: own `JWT_SECRET`, issuer `bsm-midhub/session`, HS256, idle timeout 4 h sliding; cookie `midhub_session`, `Path=/midhub`, httpOnly, sameSite lax, secure in production.
- SSO login only for emails already present in MidHub's `User` table (no auto-create). Emails stored and compared lowercase.
- Roles: `admin` | `member`. Admin-only: users, IdP config, IP allowlist, audit page, deleting/editing saved instances, deleting MIDs.
- UI copy in Thai; ServiceNow terms transliterated/kept in English. Errors say cause + fix; details behind a toggle, never a raw stack trace.
- Destructive/stop actions need a confirm dialog.
- No arbitrary shell execution anywhere: `child_process.execFile` with argument arrays only, never `exec`/shell strings.

## Review Focus

1. **Path tricks in file APIs** (`../`, absolute paths, a symlink inside the MID folder pointing to `/etc`) → rejected with 400; nothing outside the MID root is read or written. Tests: Task 6, Task 13.
2. **Two people press Start at the same time when 3 are running** → exactly one succeeds; the other gets the "ครบ 4 ตัวแล้ว" error. Helper serializes requests. Test: Task 7.
3. **Stale config save**: MID rewrites `config.xml` on start (encrypts the password); a user who opened the editor before that and saves overwrites it → save is rejected with "ไฟล์ถูกแก้ไปแล้ว กรุณาโหลดใหม่" (hash check). Test: Task 12.
4. **Log rotated or truncated while tailing** → the stream continues with the new file contents, no crash, no duplicate replay. Test: Task 14.
5. **Helper not running / socket missing** → actions return a Thai error "ตัวช่วยระบบ (midhub-helper) ไม่ทำงาน" with HTTP 503, not a 500 stack. Test: Task 7.

---

## File Structure

```
bsm_midhub/
  package.json, tsconfig.json, next.config.ts, vitest.config.ts, prisma.config.ts, eslint.config.mjs, postcss.config.mjs
  .env.local.example, .gitignore
  proxy.ts                         # IP allowlist + session gate + sliding refresh
  prisma/schema.prisma
  lib/
    env.ts                         # typed env access
    db/client.ts, db/seed.ts
    auth/jwt.ts, session.ts, helpers.ts, secret.ts, oidc.ts, lockout.ts, auth-log.ts, login-next.ts, cookie.ts
    audit.ts                       # recordAudit()
    vault.ts                       # encryptSecret/decryptSecret (AES-256-GCM)
    helper/protocol.ts             # shared request/response types (also imported by helper/)
    helper/client.ts               # callHelper()
    mids/names.ts                  # validateMidName, unitName, midRoot
    mids/paths.ts                  # resolveMidPath, isReadOnlyPath
    mids/status.ts                 # parseSystemctlShow, readServiceStatus, readHostMemory
    mids/config-xml.ts             # readParams, setParams, validateXml
    mids/wrapper-conf.ts           # readHeapMb, setHeapMb
    mids/registry.ts               # listMids, getMid, importMid
    mids/config-service.ts         # loadConfigFiles, saveConfigFile, rollback
    mids/files.ts                  # list/read/write/upload/rename/delete/mkdir
    mids/log-tail.ts               # tailFile async iterator
  helper/
    main.ts                        # socket server entry
    handler.ts                     # handleRequest()
    unit-template.ts               # renderUnit()
    systemctl.ts                   # thin execFile wrapper
  app/
    layout.tsx, page.tsx (→ dashboard), login/page.tsx
    admin/users, admin/idp, admin/ip-allowlist, admin/audit
    api/auth/{login,logout,me,oidc/start,oidc/callback}
    api/admin/{users,idp,ip-allowlist,audit}
    api/mids/route.ts, api/mids/import/route.ts
    api/mids/[name]/{route.ts,actions,config,config/backups,files,files/download,logs}
    api/host/route.ts
  components/ MidList.tsx, MidPanel.tsx, TopBar.tsx, OverviewTab.tsx, ConfigTab.tsx, FilesTab.tsx, LogTab.tsx, ConfirmDialog.tsx, ErrorNotice.tsx
  deploy/ bsm-midhub.service, bsm-midhub-helper.service, midhub-mid.service.example, Caddyfile.midhub, install.sh, README.md
  docs/spike-mid-linux.md
```

---

### Task 0: Spike — install one MID by hand on the host (no code)

**Files:**
- Create: `docs/spike-mid-linux.md`

**Interfaces:**
- Produces (values later tasks read from this doc): `EXEC_START` (unit ExecStart line), `LOG_FILES` (paths relative to MID root), `CONNECTED_LOG_PATTERN`, `CARRY_OVER_FILES`, `PACKAGE_URL_RECIPE`, `PROGRAM_DIRS` (confirm `agent/bin`, `agent/lib`, `agent/jre`).

- [ ] **Step 1:** On the host, create users/groups/dirs exactly as `deploy/install.sh` will (Task 16): `groupadd midhub; useradd -r -g midhub midsvc; useradd -m -G midhub bsmmidhub; mkdir -p /opt/midhub/{mids,packages,archive}; chown -R midsvc:midhub /opt/midhub/mids; chmod 2775 /opt/midhub/mids`.
- [ ] **Step 2:** Find how to get the Linux MID zip for a demo instance's build (instance UI → MID Server → Downloads, and any URL/property that yields it). Record `PACKAGE_URL_RECIPE` and whether the host reaches `install.service-now.com`.
- [ ] **Step 3:** Unzip into `/opt/midhub/mids/spike1/`, write `agent/config.xml` (`url`, `mid.instance.username`, `mid.instance.password`, `name`) and `agent/conf/wrapper-override.conf` (`wrapper.java.maxmemory=1024`) by hand — **no interactive installer**. Record whether anything else is required.
- [ ] **Step 4:** Write `/etc/systemd/system/midhub-mid-spike1.service` with `User=midsvc`, `MemoryMax=1536M`, `Restart=on-failure`, foreground wrapper ExecStart. Find the working `EXEC_START` (try `agent/bin/mid.sh console`). `systemctl start` and confirm the MID shows **Up** in the instance after validation.
- [ ] **Step 5:** Record `LOG_FILES` (main log + wrapper log) and the exact log line meaning "connected to instance" (`CONNECTED_LOG_PATTERN`). Confirm `config.xml` password gets rewritten encrypted after start.
- [ ] **Step 6:** Check auto-upgrade behaviour under systemd (trigger or read docs + inspect `agent/` after an upgrade if possible). Record `CARRY_OVER_FILES` (config.xml, wrapper-override.conf, extlib/, keystore path, anything else).
- [ ] **Step 7:** Save all findings with exact values in `docs/spike-mid-linux.md`; copy the working unit to `deploy/midhub-mid.service.example`. Keep `spike1` installed — Task 9 imports it.

---

### Task 1: Scaffold the app

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `prisma.config.ts`, `prisma/schema.prisma`, `lib/env.ts`, `lib/db/client.ts`, `.env.local.example`, `.gitignore`, `app/layout.tsx`, `app/page.tsx`
- Test: `lib/env.test.ts`

**Interfaces:**
- Produces: `env` object from `lib/env.ts`: `{ databaseUrl: string; jwtSecret: string; adminEmail: string; adminPassword: string; vaultKey: string; midhubRoot: string; maxRunning: number; helperSocket: string }` (`helperSocket` default `/run/midhub/helper.sock`, `maxRunning` default 4, `midhubRoot` default `/opt/midhub`). `prisma` singleton from `lib/db/client.ts`.
- Prisma models (all of them now, so later tasks only migrate data): `User {id, email @unique, passwordHash, role @default("member"), failedLoginCount, lockedAt?, lastLoginAt?, createdAt}`, `IdpConfig` (same fields as `AH/prisma/schema.prisma` `IdpConfig`), `IpAllowlist {id, cidr @unique, note, createdAt}`, `AuthLog` (same as AH's), `Instance {id, label, url @unique, midUser?, midPasswordEnc?, buildstamp?, createdBy, createdAt}`, `MidServer {id, name @unique, instanceId?, dir, serviceName, heapMb @default(1024), version?, state @default("installed"), createdBy, createdAt, removedAt?}`, `Job {id, midId, kind, stage, status, params, journalPath, error?, createdBy, startedAt?, finishedAt?}`, `ConfigBackup {id, midId, file, content, note, createdBy, createdAt}`, `AuditLog {id, at, userId?, email, action, midName?, detail}`.

- [ ] **Step 1:** `git init`; `.gitignore` = AH's plus `.superpowers/`, `data/`, `*.db`.
- [ ] **Step 2:** `package.json` with the Tech Stack versions copied from `AH/package.json` (drop node-pty, xterm, docx-preview, xlsx, qrcode, react-markdown, @servicenow/sdk); add `fast-xml-parser`. Scripts: `dev`, `build` (`next build`), `start`, `test`, `lint`, `helper:build` (`tsc -p helper/tsconfig.json`).
- [ ] **Step 3:** `next.config.ts` = AH's headers block + `basePath: "/midhub"`, `experimental.proxyClientMaxBodySize: "50mb"`.
- [ ] **Step 4: Write failing tests** in `lib/env.test.ts`: `loadEnv({})` throws listing `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `MIDHUB_VAULT_KEY`, `DATABASE_URL`; `loadEnv({...required})` returns `maxRunning === 4`, `midhubRoot === "/opt/midhub"`; `JWT_SECRET` shorter than 32 chars throws.
- [ ] **Step 5:** Run `npx vitest run lib/env.test.ts` → FAIL.
- [ ] **Step 6:** Implement `loadEnv(src: NodeJS.ProcessEnv): Env` and `export const env = loadEnv(process.env)` (lazy getter so tests can import).
- [ ] **Step 7:** `npx prisma migrate dev --name init` → migration created; `npx vitest run` → PASS; `npm run dev` → `http://localhost:3000/midhub` renders the placeholder page.
- [ ] **Step 8:** Commit `chore: scaffold midhub app`.

---

### Task 2: Local auth, sessions, admin seed

**Files:**
- Create: `lib/auth/{secret,jwt,session,helpers,cookie,lockout,auth-log,login-next}.ts`, `lib/db/seed.ts`, `app/api/auth/{login,logout,me}/route.ts`, `app/login/page.tsx`
- Test: `lib/auth/jwt.test.ts`, `app/api/auth/login/route.test.ts`

**Interfaces:**
- Consumes: `env`, `prisma`.
- Produces: `SESSION_COOKIE = "midhub_session"`, `SESSION_TOKEN_ISSUER = "bsm-midhub/session"`, `IDLE_TIMEOUT_SECONDS = 14400`; `signToken(p: SessionPayload): Promise<string>`; `verifyToken(t: string): Promise<SessionPayload | null>` where `SessionPayload = { userId: string; email: string; role: "admin" | "member" }`; `sessionCookieOptions(): {httpOnly, sameSite:"lax", secure, path:"/midhub", maxAge}`; `getSessionUser(): Promise<SessionPayload|null>`; `requireUser(): Promise<SessionPayload>` and `requireAdmin(): Promise<SessionPayload>` (throw `Response` 401/403); `seedAdmin(): Promise<void>` (upsert `ADMIN_EMAIL` lowercase as admin, idempotent, never overwrites an existing password).

- [ ] **Step 1: Write failing tests** `lib/auth/jwt.test.ts`: round-trip sign→verify returns payload; a token signed with the same secret but issuer `ai-workspace/session` → `null`; token with a `purpose` claim → `null`; token with `alg: none` → `null`; missing `userId` → `null`.
- [ ] **Step 2: Write failing tests** `app/api/auth/login/route.test.ts` (mock prisma like `AH/app/api/auth/login/route.test.ts`): correct password → 200 + `Set-Cookie` containing `midhub_session=` and `Path=/midhub`; `ADMIN@X.COM` matches stored `admin@x.com`; 3 wrong passwords → 4th attempt 423 locked even with right password; unknown email and wrong password return the same 401 body.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Copy AH's `secret.ts`, `jwt.ts`, `session.ts`, `helpers.ts`, `lockout.ts`, `auth-log.ts`, `login-next.ts`, `api/auth/{login,logout,me}`; change issuer, cookie name/path, role union, `validLoginNext` to accept only `^/midhub(/.*)?$`; drop task-access helpers. Call `seedAdmin()` from `instrumentation.ts` `register()`.
- [ ] **Step 5:** Login page: email/password form + "เข้าสู่ระบบด้วย SSO" button (shown only when `GET /api/auth/idp` says enabled — wired in Task 3).
- [ ] **Step 6:** Run `npx vitest run lib/auth app/api/auth` → PASS.
- [ ] **Step 7:** Commit `feat(auth): local login and sessions`.

---

### Task 3: SSO with the shared IdP

**Files:**
- Create: `lib/auth/oidc.ts`, `app/api/auth/idp/route.ts`, `app/api/auth/oidc/start/route.ts`, `app/api/auth/oidc/callback/route.ts`, `app/api/admin/idp/route.ts`, `app/admin/idp/page.tsx`, `components/IdpConfigManager.tsx`
- Test: `app/api/auth/oidc/callback/route.test.ts`

**Interfaces:**
- Consumes: `signToken`, `sessionCookieOptions`, `recordAuthEvent`, `requireAdmin`.
- Produces: `GET /api/auth/idp → { enabled: boolean; label: string }`; admin `GET/PUT /api/admin/idp` (secret never returned, `"••••"` placeholder means unchanged).

- [ ] **Step 1: Write failing tests** for the callback (mock `discover`/`verifyIdToken` like AH's tests): known email (any case) → session cookie + redirect to `login_next` or `/midhub`; email **not** in `User` → redirect `/midhub/login?error=not_registered`, no user row created; locked user → `?error=locked`; bad `state` → `?error=state`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Copy AH's `oidc.ts`, start/callback routes, `IdpConfigManager`; replace `findOrCreateSsoUser` with `findRegisteredUser(email: string): Promise<User | null>` (lowercase lookup). Redirect URI shown in the admin page: `${origin}/midhub/api/auth/oidc/callback`. Login page maps `error` codes to Thai messages (`not_registered` → "บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้ MidHub กรุณาติดต่อ Admin").
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(auth): SSO for registered users only`.

---

### Task 4: Proxy gate + IP allowlist

**Files:**
- Create: `proxy.ts`, `app/api/admin/ip-allowlist/route.ts`, `app/admin/ip-allowlist/page.tsx`, `components/IpAllowlistManager.tsx`
- Test: `proxy.test.ts`

**Interfaces:**
- Consumes: `verifyToken`, `signToken`, `prisma.ipAllowlist`.
- Produces: gate behaviour all later routes rely on: every path except `/login`, `/api/auth/login`, `/api/auth/idp`, `/api/auth/oidc/*` and static assets requires a valid session; pages redirect to `/midhub/login` (setting `login_next`), APIs return 401 JSON. Empty allowlist = allow all.

- [ ] **Step 1: Write failing tests** `proxy.test.ts` (pattern from `AH/proxy.test.ts`): allowlist `10.0.0.0/8` + XFF `10.1.2.3, 1.1.1.1` → passes; XFF `8.8.8.8` → 403 even with a valid cookie; empty allowlist → passes; no cookie on `/midhub/` → 307 to `/midhub/login`; no cookie on `/midhub/api/mids` → 401; valid cookie → response re-sets `midhub_session` (sliding); AgentHub `session` cookie alone → treated as logged out.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Port AH's `proxy.ts` minus maintenance mode, extension/ops/mobile bypasses. Port the allowlist API/page (admin only, CIDR validated).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: proxy gate with IP allowlist`.

---

### Task 5: User management (admin)

**Files:**
- Create: `app/api/admin/users/route.ts`, `app/api/admin/users/[id]/route.ts`, `app/admin/users/page.tsx`
- Test: `app/api/admin/users/route.test.ts`

**Interfaces:**
- Produces: `GET /api/admin/users → {id,email,role,lockedAt,lastLoginAt}[]` (never `passwordHash`); `POST {email, role, password?}` (no password = SSO-only: store a random unusable hash); `PATCH /[id] {role?, unlock?: true, password?}`; `DELETE /[id]`.

- [ ] **Step 1: Write failing tests:** member caller → 403; POST lowercases email and rejects duplicates with 409; response never contains `passwordHash`; admin cannot delete or demote themselves (400 "ไม่สามารถลดสิทธิ์/ลบบัญชีตัวเองได้"); deleting the last admin → 400.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(admin): user management`.

---

### Task 6: MID names and sandboxed paths

**Files:**
- Create: `lib/mids/names.ts`, `lib/mids/paths.ts`
- Test: `lib/mids/names.test.ts`, `lib/mids/paths.test.ts`

**Interfaces:**
- Produces: `MID_NAME_RE`; `validateMidName(n: string): string` (returns n or throws `MidError("invalid_name")`); `unitName(n) → "midhub-mid-<n>.service"`; `midRoot(n) → path.join(env.midhubRoot, "mids", n)`; `resolveMidPath(name: string, rel: string): Promise<string>` (realpath of the nearest existing ancestor must stay inside `realpath(midRoot)`, else `MidError("path_outside")`); `isReadOnlyPath(name: string, absPath: string): boolean`; `class MidError extends Error { constructor(code: string, status?: number, thai?: string) }` — `status`/`thai` default from a code table in the same file (`invalid_name` 400, `path_outside` 400, `not_found` 404, `read_only` 403, `stale` 409, `quota_full` 409, `helper_down` 503, …); route handlers turn it into `{ code, message: thai }` JSON with that status.
- `lib/helper/protocol.ts` imports `MID_NAME_RE` from here — keep this file free of Next/Prisma imports.

- [ ] **Step 1: Write failing tests** (use a temp dir as `midhubRoot`): names `a`, `-ab`, `Ab`, `a_b`, 41-char → invalid; `ab`, `poc-hr-mid` → valid. Paths: `""` → root; `agent/config.xml` → inside; `../other` → `path_outside`; `/etc/passwd` → `path_outside`; a symlink `agent/evil → /etc` then `agent/evil/passwd` → `path_outside`; not-yet-existing `agent/new/file.txt` → allowed. `isReadOnlyPath` true for `agent/bin`, `agent/bin/mid.sh`, `agent/jre/x`, `agent/lib/a.jar`; false for `agent/extlib/x.jar`, `agent/binary.txt`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(mids): name validation and path sandbox`.

---

### Task 7: midhub-helper daemon + client

**Files:**
- Create: `lib/helper/protocol.ts`, `lib/helper/client.ts`, `helper/main.ts`, `helper/handler.ts`, `helper/unit-template.ts`, `helper/systemctl.ts`, `helper/tsconfig.json`
- Test: `helper/handler.test.ts`, `helper/unit-template.test.ts`, `lib/helper/client.test.ts`

**Interfaces:**
- Produces:
  - `type HelperRequest = { op: "start"|"stop"|"restart"; name: string } | { op: "installUnit"; name: string; heapMb: number } | { op: "removeUnit"|"fixOwnership"; name: string }`
  - `type HelperResponse = { ok: true } | { ok: false; code: "invalid_name"|"invalid_request"|"quota_full"|"not_found"|"systemctl_failed"; message: string }`
  - Wire format: one JSON line per request, one JSON line response, then close.
  - `renderUnit({ name, heapMb, midRoot }): string` — uses `EXEC_START` from `docs/spike-mid-linux.md`; contains `User=midsvc`, `Group=midhub`, `MemoryMax=<heapMb+512>M`, `Restart=on-failure`, `WantedBy=multi-user.target`.
  - `handleRequest(req: unknown, deps: { systemctl: Systemctl; fs; maxRunning: number; midhubRoot: string }): Promise<HelperResponse>`; `Systemctl = { run(args: string[]): Promise<{code:number; stdout:string}>; activeMidUnits(): Promise<string[]> }`.
  - `callHelper(req: HelperRequest): Promise<HelperResponse>` (client side; 30 s timeout; socket errors `ENOENT`/`ECONNREFUSED` → throws `MidError("helper_down", 503, "ตัวช่วยระบบ (midhub-helper) ไม่ทำงาน กรุณาแจ้ง Admin")`).
- Behaviour: `start` = enable + start (so it comes back after reboot); `stop` = disable + stop. Quota checked for `start`, and for `restart` of an inactive unit: if `activeMidUnits().length >= maxRunning` → `quota_full`. Requests are processed **one at a time** (in-process queue) so the quota check and the start are atomic. `installUnit` writes `/etc/systemd/system/<unit>` then `daemon-reload`. `fixOwnership` = `chown -R midsvc:midhub` + `chmod -R g+rwX` on `midRoot(name)` only. Access control = socket file `0660 root:bsmmidhub` (Node has no SO_PEERCRED; the file mode is the gate — update spec §4.2 accordingly). All systemctl calls via `execFile("systemctl", args)`.

- [ ] **Step 1: Write failing tests** `helper/handler.test.ts` with a fake `Systemctl`: unknown op → `invalid_request`; name `../x` → `invalid_name`; 4 active + start → `quota_full` and no systemctl `start` call; 3 active + **two concurrent** starts → exactly one ok, one `quota_full`; restart of an active unit with 4 running → ok; `stop` calls `disable` then `stop`; `heapMb` 100 or 70000 → `invalid_request` (allowed 256–8192).
- [ ] **Step 2: Write failing tests** `helper/unit-template.test.ts`: heap 1024 → contains `MemoryMax=1536M` and `User=midsvc`; name injected only into paths under midRoot.
- [ ] **Step 3: Write failing test** `lib/helper/client.test.ts`: socket path that doesn't exist → `MidError` code `helper_down`, status 503.
- [ ] **Step 4:** Run → FAIL. **Step 5:** Implement. **Step 6:** Run → PASS.
- [ ] **Step 7:** Commit `feat(helper): root helper daemon with fixed operations`.

---

### Task 8: Service status and host memory

**Files:**
- Create: `lib/mids/status.ts`, `app/api/host/route.ts`
- Test: `lib/mids/status.test.ts`

**Interfaces:**
- Produces: `type ServiceStatus = { state: "running"|"stopped"|"failed"|"starting"|"unknown"; pid: number|null; memoryBytes: number|null; since: Date|null }`; `parseSystemctlShow(out: string): ServiceStatus`; `readServiceStatus(name): Promise<ServiceStatus>` (`execFile("systemctl", ["show", unitName(name), "--property=ActiveState,SubState,MainPID,MemoryCurrent,ActiveEnterTimestamp"])`, no root needed); `parseMeminfo(text): { totalBytes; availableBytes }`; `readHostMemory()`; `GET /api/host → { totalBytes, availableBytes, running: number, maxRunning: number }`.

- [ ] **Step 1: Write failing tests** with fixture strings: `ActiveState=active/SubState=running` → running; `inactive/dead` → stopped; `failed` → failed; `activating` → starting; `MemoryCurrent=[not set]` → null; `MainPID=0` → null; meminfo fixture → numbers in bytes.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(mids): service status and host memory`.

---

### Task 9: config.xml / wrapper parsing + MID registry and import

**Files:**
- Create: `lib/mids/config-xml.ts`, `lib/mids/wrapper-conf.ts`, `lib/mids/registry.ts`, `lib/audit.ts`, `lib/vault.ts`, `app/api/mids/route.ts`, `app/api/mids/import/route.ts`, `app/api/mids/[name]/route.ts`
- Test: `lib/mids/config-xml.test.ts`, `lib/mids/wrapper-conf.test.ts`, `lib/mids/registry.test.ts`, `lib/vault.test.ts`

**Interfaces:**
- Produces:
  - `readParams(xml: string): Record<string, string>`; `setParams(xml: string, changes: Record<string, string>): string` — edits only the `value` attribute of existing `<parameter name="…">` elements (add a new element before `</parameters>` if missing), XML-escapes values, leaves every other byte (comments, order, whitespace) unchanged; `validateXml(xml): { ok: true } | { ok: false; line: number; message: string }` via `fast-xml-parser` `XMLValidator`.
  - `readHeapMb(conf: string): number | null`; `setHeapMb(conf: string, mb: number): string` (`wrapper.java.maxmemory`).
  - `encryptSecret/decryptSecret` — copy of `AH/lib/services/instance-connection.ts` lines 22–47 keyed by `MIDHUB_VAULT_KEY`.
  - `recordAudit(user: SessionPayload, action: string, midName?: string, detail?: object): Promise<void>`.
  - `type MidSummary = { name; instanceUrl: string|null; midName: string|null; heapMb; version: string|null; state; status: ServiceStatus }`; `listMids(): Promise<MidSummary[]>`; `getMid(name): Promise<MidSummary>` (404 `MidError("not_found")`); `importMid(name, user): Promise<MidSummary>` — requires `midRoot(name)/agent/config.xml` and an existing unit; links/creates `Instance` by `url` (no credentials).
  - Routes: `GET /api/mids`, `GET /api/mids/[name]`, `POST /api/mids/import {name}` (member allowed; audited `mid.import`).

- [ ] **Step 1: Write failing tests** `config-xml.test.ts` with a realistic MID `config.xml` fixture (several `<parameter>` elements, a comment, a `secure="true"` password param): `readParams` returns url/name/username; `setParams({url:"https://a.service-now.com/"})` changes only that attribute — diff of input vs output is exactly one line; value `a&b"<` is escaped; unknown key is appended; `validateXml("<parameters>")` → `ok:false` with a line number.
- [ ] **Step 2: Write failing tests** `wrapper-conf.test.ts`: reads 1024; set 2048 replaces existing line; adds the line if absent.
- [ ] **Step 3: Write failing tests** `registry.test.ts` (temp root, fake status): import of a folder without `config.xml` → `MidError("not_a_mid")`; import twice → 409; `listMids` merges DB rows with status.
- [ ] **Step 4: Write failing test** `vault.test.ts`: round-trip; tampered ciphertext throws.
- [ ] **Step 5:** Run → FAIL. **Step 6:** Implement. **Step 7:** Run → PASS.
- [ ] **Step 8:** Commit `feat(mids): config parsing, registry, import`.

---

### Task 10: Start / Stop / Restart API

**Files:**
- Create: `app/api/mids/[name]/actions/route.ts`
- Test: `app/api/mids/[name]/actions/route.test.ts`

**Interfaces:**
- Consumes: `callHelper`, `readHostMemory`, `getMid`, `recordAudit`, `requireUser`.
- Produces: `POST /api/mids/[name]/actions { action: "start"|"stop"|"restart"; confirmLowMemory?: boolean }` → `200 {ok:true}` | `409 {code:"low_memory", availableBytes}` | `409 {code:"quota_full", message}` | `503 helper_down` | `404`.
- Low-memory rule: `start` (or restart of a stopped MID) when `availableBytes < 1 GiB` and `!confirmLowMemory` → 409 `low_memory`.

- [ ] **Step 1: Write failing tests:** start with 0.5 GiB free and no confirm → 409 `low_memory`, helper not called; same with `confirmLowMemory:true` → helper called; helper `quota_full` → 409 with Thai message "รันครบ 4 ตัวแล้ว ให้หยุดตัวอื่นก่อน"; success writes an `AuditLog` row `mid.start`; unknown MID → 404; invalid action → 400.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(mids): start/stop/restart`.

---

### Task 11: Dashboard UI (list + detail panel, overview tab)

**Files:**
- Create: `app/page.tsx`, `components/TopBar.tsx`, `components/MidList.tsx`, `components/MidPanel.tsx`, `components/OverviewTab.tsx`, `components/ConfirmDialog.tsx`, `components/ErrorNotice.tsx`, `components/ImportMidDialog.tsx`, `lib/ui/status-view.ts`
- Test: `lib/ui/status-view.test.ts`

**Interfaces:**
- Consumes: `GET /api/mids`, `GET /api/host`, `POST /api/mids/[name]/actions`, `POST /api/mids/import`.
- Produces: `statusView(s: MidSummary): { icon: "🟢"|"⚪"|"🟡"|"🔴"; label: string }` (Thai labels: กำลังรัน / หยุด / กำลังทำงาน / ล่ม); `quotaView(running, max): { text: string; full: boolean }`; `MidPanel` exposes tabs `overview | config | files | logs` (Tasks 12–14 fill the last three).

Layout matches the spec §5.1 (option B mockup): top bar "กำลังรัน x/4" + RAM used by MIDs / host total + "+ สร้าง MID ใหม่" (disabled in this phase with tooltip "เปิดใช้ใน Phase 2"; an "Import MID ที่มีอยู่" button next to it opens `ImportMidDialog`); left list; right panel with Restart, Stop/Start buttons; Stop/Restart open `ConfirmDialog`; `low_memory` opens a confirm that re-sends with `confirmLowMemory`. Poll `/api/mids` and `/api/host` every 5 s. Start button disabled with reason when quota full.

- [ ] **Step 1: Write failing tests** for `statusView` (each state) and `quotaView(4,4)` → `full:true`, text "กำลังรัน 4/4".
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement helpers + components. **Step 4:** Run → PASS.
- [ ] **Step 5: Verify in browser:** `npm run dev` with a seeded `MidServer` row and a stubbed status → list, panel, quota bar render; Stop shows confirm. Screenshot.
- [ ] **Step 6:** Commit `feat(ui): dashboard list and panel`.

---

### Task 12: Config tab (form + raw, backups, rollback)

**Files:**
- Create: `lib/mids/config-service.ts`, `app/api/mids/[name]/config/route.ts`, `app/api/mids/[name]/config/backups/route.ts`, `app/api/mids/[name]/config/backups/[id]/route.ts`, `components/ConfigTab.tsx`
- Test: `lib/mids/config-service.test.ts`

**Interfaces:**
- Produces:
  - `type ConfigFile = "config.xml" | "wrapper-override.conf"` (paths from spike doc).
  - `loadConfigFiles(name): Promise<{ files: Record<ConfigFile, { content: string; hash: string }>; form: { url; username; midName; proxyHost; proxyPort; proxyUser; useProxy; heapMb } }>` — **password and proxy password never returned**; raw `config.xml` content returned with password values replaced by `********`.
  - `saveConfigFile(name, file, content, baseHash, user, note?)` — rejects with `MidError("stale", 409, "ไฟล์ถูกแก้ไปแล้ว กรุณาโหลดใหม่")` if current hash ≠ `baseHash`; validates XML for `config.xml`; if raw content still contains `********` for a password param, keep the on-disk value; writes a `ConfigBackup` of the previous content first; if `wrapper.java.maxmemory` changed, calls `callHelper({op:"installUnit", name, heapMb})` and updates `MidServer.heapMb`.
  - `saveForm(name, form & { password?: string; proxyPassword?: string }, baseHash, user)` — builds new content with `setParams`/`setHeapMb`, then same path as `saveConfigFile`.
  - `rollback(name, backupId, user)` — saves the backup content via `saveConfigFile` (so rollback is itself backed up).
  - Routes: `GET/PUT /config` (`PUT {file, content, baseHash}` or `{form, baseHash}`), `GET /config/backups`, `GET /config/backups/[id]` (content for diff), `POST /config/backups/[id]` = rollback. All writes audited (`config.save`, `config.rollback`).
- UI: Form/Raw toggle; Monaco (`xml` / `ini`); diff view for a backup (Monaco diff editor); after save a dialog "Restart เลยไหม?" that calls the restart action.

- [ ] **Step 1: Write failing tests:** save with stale `baseHash` → 409 `stale`, file unchanged, no backup; invalid XML → 400 with line number, file unchanged; valid save → previous content is in `ConfigBackup`; `loadConfigFiles` output contains no real password; raw save containing `********` keeps the encrypted on-disk password; heap change triggers `installUnit` with new heap; rollback creates a backup of the content it replaces.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Browser check: edit URL in form, save, see backup, diff, rollback. Commit `feat(config): config editor with backup and rollback`.

---

### Task 13: Files tab

**Files:**
- Create: `lib/mids/files.ts`, `app/api/mids/[name]/files/route.ts`, `app/api/mids/[name]/files/download/route.ts`, `components/FilesTab.tsx` (adapted from `AH/components/FileBrowser.tsx`)
- Test: `lib/mids/files.test.ts`

**Interfaces:**
- Consumes: `resolveMidPath`, `isReadOnlyPath`, `recordAudit`.
- Produces: `listDir(name, rel): Promise<{ name; type: "file"|"dir"; size; mtime; readOnly: boolean }[]>`; `readText(name, rel): Promise<{ content; hash }>` (refuse binary/ > 2 MB with `MidError("not_text")`); `writeText(name, rel, content, baseHash)`; `upload(name, dirRel, filename, data: Buffer)` (≤ 50 MB, filename has no `/`); `rename(name, rel, newName)`; `remove(name, rel)` (dirs recursive); `mkdir(name, parentRel, dirName)`. Every write on a read-only path → `MidError("read_only", 403, "โฟลเดอร์นี้เป็นโปรแกรมของ MID แก้ไขไม่ได้")`. Deleting the MID root itself is refused. New files get group-writable mode (`0664`/`0775`).

- [ ] **Step 1: Write failing tests** (temp root): list root shows `agent` with `readOnly:false` and `agent/bin` with `readOnly:true`; upload into `agent/bin` → 403; write via `../../etc/x` → `path_outside`; upload filename `../x.jar` → 400; upload 51 MB → 413; remove `""` → refused; writeText with stale hash → 409; readText on a binary file → `not_text`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement API + UI (upload, download, rename, delete with confirm, new folder, open text in Monaco). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(files): sandboxed file manager`.

---

### Task 14: Log tab (live tail)

**Files:**
- Create: `lib/mids/log-tail.ts`, `app/api/mids/[name]/logs/route.ts`, `components/LogTab.tsx`
- Test: `lib/mids/log-tail.test.ts`

**Interfaces:**
- Produces: `tailFile(absPath: string, opts: { fromBytesBack: number; pollMs: number; signal: AbortSignal }): AsyncIterable<string[]>` — yields batches of complete lines; starts at `max(0, size - fromBytesBack)`; on inode change or size shrink, reopens from byte 0 of the new file; never re-yields lines already sent. `GET /api/mids/[name]/logs?file=main|wrapper` → SSE (`data: {"lines":[...]}`), initial window 256 KB, poll 1000 ms; `?download=1` → file download. File keys map to `LOG_FILES` from the spike doc.
- UI: file selector (main / wrapper), level filter (ทั้งหมด / ERROR / WARN), text search, pause/auto-scroll toggle, download button; keeps last 5,000 lines in memory.

- [ ] **Step 1: Write failing tests:** append 3 lines → yields them; partial line without `\n` is held until completed; truncate file to 0 then write → new lines yielded, old ones not repeated; rename file away and create a new one at the same path → continues with the new file; abort ends the iterator.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(logs): live log tail`.

---

### Task 15: Audit page

**Files:**
- Create: `app/api/admin/audit/route.ts`, `app/admin/audit/page.tsx`
- Test: `app/api/admin/audit/route.test.ts`

**Interfaces:**
- Produces: `GET /api/admin/audit?mid=&user=&cursor=` → newest first, 50 per page, `{ items, nextCursor }`. Admin only.

- [ ] **Step 1: Write failing tests:** member → 403; filter by `mid` returns only that MID's rows; pagination returns disjoint pages.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (table: เวลา, ผู้ใช้, การกระทำ, MID, รายละเอียด). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(admin): audit log page`.

---

### Task 16: Deploy to the host

**Files:**
- Create: `deploy/bsm-midhub.service`, `deploy/bsm-midhub-helper.service`, `deploy/Caddyfile.midhub`, `deploy/install.sh`, `deploy/README.md`

**Interfaces:**
- `bsm-midhub.service`: `User=bsmmidhub`, `WorkingDirectory=/home/bsmmidhub/midhub`, `EnvironmentFile=…/.env.local`, `HOSTNAME=127.0.0.1`, `PORT=3100`, `TZ=Asia/Bangkok`, `ExecStartPre=…/node_modules/.bin/prisma migrate deploy`, `ExecStart=/usr/bin/node …/node_modules/next/dist/bin/next start`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ReadWritePaths=/home/bsmmidhub/midhub /opt/midhub`, `MemoryMax=512M`.
- `bsm-midhub-helper.service`: root, `ExecStart=/usr/bin/node /home/bsmmidhub/midhub/helper/dist/main.js`, `RuntimeDirectory=midhub`, `RuntimeDirectoryMode=0750`, socket created `0660 root:bsmmidhub`, `Restart=always`.
- `Caddyfile.midhub`: a `handle /midhub/*` block to paste inside AgentHub's existing site block: `reverse_proxy 127.0.0.1:3100 { header_up X-Forwarded-For {remote_host} }`.
- `install.sh` (idempotent, run as root): create `midhub` group, `midsvc`, `bsmmidhub`; `/opt/midhub/{mids,packages,archive}` with `mids` = `midsvc:midhub 2775`; install both units; `systemctl enable --now`.

- [ ] **Step 1:** Write the files. Run `bash -n deploy/install.sh` → no output.
- [ ] **Step 2:** On the host: clone to `/home/bsmmidhub/midhub`, `npm ci`, `npm run build`, `npm run helper:build`, create `.env.local` (new `JWT_SECRET`, `MIDHUB_VAULT_KEY`, admin creds), `sudo deploy/install.sh`, paste the Caddy block, `sudo systemctl reload caddy`.
- [ ] **Step 3: Verify:** `systemctl is-active bsm-midhub bsm-midhub-helper` → `active active`; `https://<host>/midhub` → login page; AgentHub still works at `/` and its `session` cookie does not log you into MidHub; log in as admin; import `spike1`; Stop → Start → Restart works; starting a 5th MID is refused; config edit + rollback works; file upload into `agent/extlib` works and into `agent/bin` is refused; log tab streams.
- [ ] **Step 4:** Add the SSO redirect URI in the IdP, configure it in `/midhub/admin/idp`, add a team member email, verify SSO login; verify an unregistered SSO email gets the "ยังไม่ได้รับสิทธิ์" message.
- [ ] **Step 5:** Commit `chore(deploy): systemd units, caddy block, installer`.
