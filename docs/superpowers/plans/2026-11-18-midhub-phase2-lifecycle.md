# MidHub Phase 2 (Lifecycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the MidHub web UI, the team saves demo instances, installs or clones a new MID through a 4-step wizard that runs as a resumable job (download → extract → configure → start → wait until connected), and an Admin uninstalls a MID, with the disk-saving rules of spec §8.1 items 1–4 built in.

**Architecture:** A small in-process job engine (`lib/jobs/`) runs named, idempotent stages, records the current stage in `Job` before each one, appends progress as JSONL to `/opt/midhub/jobs/<id>.jsonl`, and resumes `running` jobs at boot. Install/clone/uninstall are stage lists that reuse Phase 1 building blocks: safe-fs for every MID file access, `setParams`/`setHeapMb` for config, and the root helper's existing ops (`fixOwnership`, `installUnit`, `start`, `stop`, `removeUnit`) — **no new helper ops in Phase 2**. The app (bsmmidhub, group midhub) downloads and extracts packages itself; the helper then normalises ownership, exactly as the spike did.

**Tech Stack:** Existing MidHub stack (Next.js 16.4.6, React 19, TS, Tailwind v4, Prisma 7 + SQLite, Vitest 4, Node 22). Host tools via `execFile` only: `/usr/bin/unzip`, `/usr/bin/zipinfo`, `/usr/bin/tar`. Test fixtures build zips with `python3 -c` (`zipfile`), no new npm dependency.

**Spec:** `docs/superpowers/specs/2026-11-18-midhub-design.md` (§5.1, §5.2, §6 roles, §7, §8 incl. 8.1, §10 item 2). Spike results: `docs/spike-mid-linux.md`.

**Out of scope:** Phase 2b (shared releases via hardlink, spec §8.1 item 5), Phase 3 (upgrade/rollback), uploading a MID zip by hand (dropped from v1 by the spec).

## Global Constraints

- Every Phase 1 constraint still holds: `execFile` with argument arrays only, never a shell; Thai UI copy that states cause + fix; errors as `{code, message, detail?}` via `handleRouteError`/`MidError`; every mutating route audited with `recordAudit` (never secrets); destructive actions need ConfirmDialog; client calls through `apiFetch`.
- Every read/write of a file under `/opt/midhub/mids/` goes through `lib/mids/safe-fs.ts` (fd-verified). Files under `/opt/midhub/{packages,jobs,archive}` are app-owned (bsmmidhub 0750) and may use plain `fs`.
- MID name regex `^[a-z0-9][a-z0-9-]{1,39}$`; unit `midhub-mid-<name>.service`; MID root `${MIDHUB_ROOT}/mids/<name>`.
- Max running MIDs = `env.maxRunning` (4); quota is enforced by the helper at the `start` stage; the wizard only warns.
- Instance URLs: only `https://<sub>.service-now.com` (lowercase host, no path/query/port); stored normalised as `https://<sub>.service-now.com/`.
- MID password stored only as `Instance.midPasswordEnc` via `lib/vault.ts`; decrypted only inside the `configure` stage; never returned by any API, never in journal or audit.
- Package URL: `https://install.service-now.com/glide/distribution/builds/package/app-signed/mid/<YYYY>/<MM>/<DD>/mid.<buildstamp>.linux.x86-64.zip`, where `<MM>-<DD>-<YYYY>` is the **last** date in the buildstamp; buildstamp = `sys_properties.glide.war` without `glide-` and `.zip`.
- Connected marker: a line in `agent/logs/agent0.log.0` containing `MID Server is connected to instance host:` whose timestamp is ≥ the start-stage timestamp; timeout 5 minutes.
- Disk precheck: ≥ 2 GiB free on the filesystem of `MIDHUB_ROOT`.
- Log retention default 3 files (allowed 1–10): `wrapper.logfile.maxfiles` in `agent/conf/wrapper-override.conf`; `com.service_now.mid.logging.MIDLogFileHandler.count` and `com.service_now.mid.logging.SecurityLogFileHandler.count` in `agent/properties/glide.properties`.
- Archive (uninstall) contains only existing entries of: `agent/config.xml`, `agent/conf`, `agent/extlib`, `agent/security`, `agent/properties`, `agent/logs`; retention 30 days.
- Clone copies from the source MID: `agent/config.xml` (then overwrites `url`, `name`, `mid.instance.username`, `mid.instance.password`, and sets `mid_sys_id` to `""`), `agent/conf/wrapper-override.conf`, `agent/extlib/`. Never `agent/security/`.
- Roles: Member may add/test instances, create install/clone jobs, retry jobs, cancel a **failed install/clone** job they created. Admin only: edit/delete saved instances, uninstall a MID, cancel any job.
- One active job (`queued`|`running`) per MID; at most 2 jobs run concurrently in the process (others stay `queued`).

## Review Focus

1. A member types a non-ServiceNow URL (e.g. `http://127.0.0.1:3000/`, `https://evil.com/x.service-now.com`) when adding an instance → 400 `instance_url`, and no outbound request is made (SSRF). Test in Task 2.
2. MidHub restarts in the middle of `fetchPackage` or `extract` → on boot the job resumes at that stage, a half-downloaded `.part` is never used, and a half-extracted temp dir is discarded instead of producing a broken MID. Tests in Tasks 4, 5, 3.
3. Two people press "ติดตั้ง" with the same MID name at the same moment → exactly one job is created; the other gets 409 `job_active` / name taken. Test in Task 3 and Task 9.
4. Retrying a failed `start`/`waitConnected` must not be fooled by a "connected" line left in the log by an earlier run → only lines at/after the new start time count. Test in Task 7.
5. During uninstall, the MID tree contains a symlink planted by the MID process pointing outside (e.g. `agent/extlib/x -> /home/bsmmidhub`) → the archive stores the link, not the target, and deleteDir removes the link only. Test in Task 8.

---

## File Structure

```
prisma/schema.prisma                 Job gains attempt, updatedAt, midName; Instance unchanged
lib/mids/layout.ts                   + ARCHIVE_PATHS, GLIDE_PROPERTIES, CONNECTED_MARKER, LOG_COUNT_KEYS
lib/mids/buildstamp.ts               buildstamp parsing + package URL (pure)
lib/mids/java-props.ts               set/read keys in .properties / wrapper .conf text (pure)
lib/mids/names.ts                    + new MidError codes (each task adds the codes it uses)
lib/instances/service.ts             normalise URL, test connection, CRUD, encrypt password
lib/jobs/engine.ts                   createJob, runner, journal, retry, cancel, resumeJobs
lib/jobs/journal.ts                  appendJournal, journalPath, openJournal (for SSE)
lib/mids/packages.ts                 ensurePackage (download/cache), gcPackages, diskStatus
lib/mids/extract.ts                  validateZip, extractPackage
lib/mids/provision.ts                configureMid, cloneFiles
lib/mids/connected.ts                waitConnected
lib/jobs/install.ts                  install/clone stage list
lib/jobs/uninstall.ts                uninstall + cancel-install stage lists, archiveMid, deleteMidDir, sweepArchives
app/api/instances/route.ts, app/api/instances/[id]/route.ts, app/api/instances/test/route.ts
app/api/mids/route.ts                + POST (create install/clone job)
app/api/mids/[name]/route.ts         + DELETE (uninstall, admin)
app/api/mids/name-check/route.ts
app/api/jobs/[id]/route.ts, app/api/jobs/[id]/events/route.ts, app/api/jobs/[id]/retry/route.ts, app/api/jobs/[id]/cancel/route.ts
app/admin/instances/page.tsx, components/InstancesManager.tsx
components/CreateMidWizard.tsx (+ wizard step components), components/JobProgress.tsx, components/UninstallDialog.tsx
instrumentation.ts                   + resumeJobs, sweepArchives, gcPackages on boot
deploy/install.sh, deploy/README.md  + /opt/midhub/jobs, unzip/zipinfo/tar prechecks
```

---

### Task 1: Data model, layout constants, buildstamp helpers

**Files:**
- Modify: `prisma/schema.prisma` (+ migration `phase2_jobs`), `lib/mids/layout.ts`, `deploy/install.sh`, `deploy/README.md`
- Create: `lib/mids/buildstamp.ts`, `lib/mids/java-props.ts`
- Test: `lib/mids/buildstamp.test.ts`, `lib/mids/java-props.test.ts`

**Interfaces:**
- Produces:
  - `Job` model gains `midName String`, `attempt Int @default(0)`, `updatedAt DateTime @updatedAt`, `@@index([midName, status])`. `kind`: `"install" | "clone" | "uninstall" | "cancel_install"`; `status`: `"queued" | "running" | "succeeded" | "failed" | "cancelled"`.
  - `layout.ts`: `ARCHIVE_PATHS = ["agent/config.xml","agent/conf","agent/extlib","agent/security","agent/properties","agent/logs"] as const`, `GLIDE_PROPERTIES = "agent/properties/glide.properties"`, `CONNECTED_MARKER = "MID Server is connected to instance host:"`, `LOG_COUNT_KEYS = { wrapper: "wrapper.logfile.maxfiles", mid: "com.service_now.mid.logging.MIDLogFileHandler.count", security: "com.service_now.mid.logging.SecurityLogFileHandler.count" } as const`, `DEFAULT_LOG_FILES = 3`, `MIN_LOG_FILES = 1`, `MAX_LOG_FILES = 10`, `MIN_FREE_BYTES = 2 * 1024 ** 3`.
  - `buildstamp.ts`: `BUILDSTAMP_RE = /^[a-z]+-\d{2}-\d{2}-\d{4}__patch[0-9a-z]+-\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{4}_\d{4}$/`; `buildstampFromGlideWar(war: string): string | null`; `packageUrl(buildstamp: string): string` (throws `MidError("invalid_buildstamp")` if not matching).
  - `java-props.ts`: `readProp(text: string, key: string): string | null`; `setProp(text: string, key: string, value: string): string` — replaces the first non-comment `key=` line (keeps CRLF if the file uses it), otherwise appends `key=value` at the end; comment lines (`#`/`!`) untouched.
  - `install.sh` creates `/opt/midhub/jobs` (bsmmidhub 0750) and prechecks `/usr/bin/unzip`, `/usr/bin/zipinfo`, `/usr/bin/tar`.

- [ ] **Step 1: Write failing tests.** `buildstamp.test.ts`: `buildstampFromGlideWar("glide-australia-02-11-2026__patch7w42-10-08-2026_10-13-2026_1248.zip") === "australia-02-11-2026__patch7w42-10-08-2026_10-13-2026_1248"`; `buildstampFromGlideWar("foo.zip") === null`; `packageUrl(<that buildstamp>) === "https://install.service-now.com/glide/distribution/builds/package/app-signed/mid/2026/10/13/mid.australia-02-11-2026__patch7w42-10-08-2026_10-13-2026_1248.linux.x86-64.zip"`; `packageUrl("../x")` throws code `invalid_buildstamp`. `java-props.test.ts`: replace existing key keeps other bytes; commented `#wrapper.logfile.maxfiles=10` is not treated as the key (appends); CRLF file stays CRLF; `readProp` returns trimmed value or null.
- [ ] **Step 2:** `npx vitest run lib/mids/buildstamp.test.ts lib/mids/java-props.test.ts` → FAIL (modules missing).
- [ ] **Step 3:** Implement both modules, the layout constants, the `invalid_buildstamp` MidError code (400, "buildstamp ไม่ถูกต้อง ตรวจรูปแบบเช่น australia-02-11-2026__patch7…"), schema change + `npx prisma migrate dev --name phase2_jobs`, install.sh/README changes.
- [ ] **Step 4:** Focused tests → PASS; full suite, `npx tsc --noEmit`, `npx eslint .`, `bash -n deploy/install.sh` clean.
- [ ] **Step 5:** Commit `feat(phase2): job schema, layout constants, buildstamp and properties helpers`.

---

### Task 2: Saved instances (service, API, admin page)

**Files:**
- Create: `lib/instances/service.ts`, `app/api/instances/route.ts`, `app/api/instances/[id]/route.ts`, `app/api/instances/test/route.ts`, `app/admin/instances/page.tsx`, `components/InstancesManager.tsx`
- Modify: `components/AdminNav.tsx` (link "Instances"), `lib/mids/names.ts` (codes), `lib/ui/audit-format.ts` (labels)
- Test: `lib/instances/service.test.ts`, `app/api/instances/route.test.ts`

**Interfaces:**
- Consumes: `encryptSecret/decryptSecret` (`lib/vault.ts`), `buildstampFromGlideWar` (Task 1), `requireUser/requireAdmin`, `recordAudit`, `handleRouteError`.
- Produces:
  - `normalizeInstanceUrl(raw: string): string` → `https://<sub>.service-now.com/`; throws `MidError("instance_url")` otherwise. Host must match `^[a-z0-9][a-z0-9-]{0,62}\.service-now\.com$`; scheme https; no userinfo, port, path other than `/`, query or fragment.
  - `type InstanceView = { id: string; label: string; url: string; midUser: string | null; hasPassword: boolean; buildstamp: string | null; createdBy: string; createdAt: string }`.
  - `testConnection(input: { url: string; midUser: string; password: string }, fetchImpl = fetch): Promise<{ ok: true; buildstamp: string | null }>` — `GET <url>api/now/table/ecc_agent?sysparm_limit=1` with Basic auth, 15 s timeout, `redirect: "manual"`: 200 → ok; 401 → `MidError("instance_auth")`; 403 → `MidError("instance_role")`; network/timeout/3xx/5xx → `MidError("instance_unreachable", …, detail)`. Then best-effort `GET <url>api/now/table/sys_properties?sysparm_query=name=glide.war&sysparm_fields=value&sysparm_limit=1`; any failure → `buildstamp: null`.
  - `createInstance(user, { label, url, midUser, password }): Promise<InstanceView>` (runs `testConnection` first; unique url → 409 `conflict`); `updateInstance(user, id, { label?, midUser?, password?, buildstamp? })` (re-tests when url/user/password change); `deleteInstance(user, id)` (409 `conflict` with Thai "ยังมี MID ที่ใช้ instance นี้อยู่" if any non-removed MidServer references it); `listInstances(): Promise<InstanceView[]>`; `getInstanceSecret(id): Promise<{ url; midUser; password; buildstamp }>` (server-only, used by Task 7).
  - Routes: `GET /api/instances` (member), `POST /api/instances` (member), `POST /api/instances/test` (member; tests without saving), `PATCH|DELETE /api/instances/[id]` (admin). Audit `instance.create|update|delete|test` with `{ url, label }` only.
  - Codes: `instance_url` 400 "URL ต้องเป็น https://<ชื่อ>.service-now.com เท่านั้น", `instance_auth` 400 "login ไม่ผ่าน: ตรวจ MID user/password", `instance_role` 400 "login ได้แต่ user ไม่มีสิทธิ์: ตรวจว่า user มี role mid_server", `instance_unreachable` 502 "ติดต่อ instance ไม่ได้: ตรวจ URL หรือว่า instance ตื่นอยู่ (demo instance อาจ hibernate)".

- [ ] **Step 1: Write failing tests** (`service.test.ts`, fake `fetchImpl`): URL table — `https://MFECPLCDEMO4.service-now.com` → `https://mfecplcdemo4.service-now.com/`; rejects `http://x.service-now.com`, `https://x.service-now.com.evil.com`, `https://evil.com/x.service-now.com`, `https://user:pw@x.service-now.com`, `https://x.service-now.com:8443`, `https://127.0.0.1`; **fetchImpl is never called for a rejected URL**. Status mapping 200/401/403/timeout; buildstamp parsed from a glide.war response and `null` when that call returns 403. Route test: member PATCH/DELETE → 403; GET never contains `midPasswordEnc`/password; audit detail has no password; delete with a MID using it → 409.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement service, routes, InstancesManager (list, add with "ทดสอบการเชื่อมต่อ", edit, delete via ConfirmDialog; password field write-only with "ตั้งไว้แล้ว" placeholder) and admin page.
- [ ] **Step 4:** Focused + full suite, tsc, eslint → PASS.
- [ ] **Step 5:** Commit `feat(instances): saved demo instances with connection test`.

---

### Task 3: Job engine core

**Files:**
- Create: `lib/jobs/engine.ts`, `lib/jobs/journal.ts`
- Modify: `lib/mids/names.ts` (codes), `lib/env.ts` (derive `jobsDir = path.join(midhubRoot, "jobs")`)
- Test: `lib/jobs/engine.test.ts` (real temp SQLite like `app/api/admin/audit/route.test.ts`, temp `MIDHUB_ROOT`)

**Interfaces:**
- Produces:
  - `type JobKind = "install" | "clone" | "uninstall" | "cancel_install"`; `type JobCtx = { job: JobRow; params: Record<string, unknown>; log(msg: string, level?: "info" | "warn" | "error"): Promise<void>; signal: AbortSignal }`; `type Stage = { name: string; run(ctx: JobCtx): Promise<void> }` — every stage must be safe to run again after a crash.
  - `registerKind(kind: JobKind, stages: Stage[], hooks?: { onSuccess?(ctx): Promise<void>; onFailure?(ctx, err): Promise<void> }): void`.
  - `createJob(user: SessionPayload, kind: JobKind, midName: string, params: object): Promise<JobRow>` — inside one `prisma.$transaction`: if a Job with this `midName` and status `queued|running` exists → `MidError("job_active")` 409; else creates `status:"queued", stage: <first stage>`; then schedules it.
  - Runner: FIFO, max 2 concurrent. Before each stage: update `stage`, `status:"running"`, `updatedAt`; journal `{t, type:"stage", stage}`. On throw: `status:"failed"`, `error` = MidError message (Thai) and journal `{type:"error", code, message, detail}`; stage stays at the failed one. After the last stage: `succeeded`, `finishedAt`.
  - `retryJob(user, id)`: only `failed` → `queued`, `attempt+1`, resumes at the recorded stage.
  - `cancelJob(user, id)`: `queued` → `cancelled`; `failed` install/clone → creates a `cancel_install` job for the same MID (Task 8 registers it) and marks this one `cancelled`; `running` → 409 `job_running`. Authorisation per Global Constraints.
  - `resumeJobs(): Promise<number>` — re-queues every `running` job at its recorded stage (and every `queued` job); returns how many.
  - `journal.ts`: `journalPath(jobId)`, `appendJournal(jobId, entry: object): Promise<void>` (one JSON line, `t` ISO timestamp added), `readJournal(jobId): Promise<object[]>`.
  - Codes: `job_active` 409 "MID นี้มีงานที่กำลังทำอยู่ รอให้เสร็จหรือยกเลิกก่อน", `job_running` 409 "งานกำลังทำงานอยู่ ยกเลิกไม่ได้ในตอนนี้", `job_not_found` 404.

- [ ] **Step 1: Write failing tests** with fake stages that record calls: stages run in order and the DB `stage` is written **before** each run; a throwing stage → `failed` with that stage and the Thai message, journal has an `error` line; `retryJob` resumes at the failed stage (earlier stages not re-run); simulated crash (mark job `running` at stage 2, new engine instance, `resumeJobs()`) runs stages 2..n only; two concurrent `createJob` for the same MID → exactly one succeeds, other `job_active`; third job waits while two run (concurrency 2); member cannot cancel another user's job (403) but admin can.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement engine + journal (`fs.promises.appendFile` with `{ mode: 0o640 }`, mkdir `jobsDir` recursive).
- [ ] **Step 4:** Tests PASS; full suite, tsc, eslint.
- [ ] **Step 5:** Commit `feat(jobs): resumable stage-based job engine with journal`.

---

### Task 4: Package download, cache, GC, disk status

**Files:**
- Create: `lib/mids/packages.ts`, `app/api/packages/route.ts`
- Modify: `lib/mids/names.ts`, `app/api/host/route.ts`, `components/TopBar.tsx`
- Test: `lib/mids/packages.test.ts` (local `http.createServer` serving bytes; temp `MIDHUB_ROOT`)

**Interfaces:**
- Consumes: `packageUrl` (Task 1).
- Produces:
  - `packagePath(buildstamp): string` = `${root}/packages/<buildstamp>.zip`.
  - `ensurePackage(buildstamp: string, opts: { onProgress?(done: number, total: number | null): void; signal?: AbortSignal; urlFor?: (b: string) => string }): Promise<string>` — returns the cached path if it exists; otherwise streams to `<path>.part` (truncate first), checks the byte count equals `Content-Length` when present, then `rename` to the final path. Any failure deletes the `.part`. HTTP 404 → `MidError("package_not_found")`; other errors → `MidError("package_download", …, detail)`; ENOSPC → `MidError("disk_low")`.
  - `gcPackages(): Promise<string[]>` — deletes `packages/*.zip` and stale `*.part` whose buildstamp is not the `version` of any non-removed MidServer nor the `params.buildstamp` of any `queued|running|failed` job; returns deleted names.
  - `diskStatus(): Promise<{ freeBytes: number; totalBytes: number; usage: { mids: number; packages: number; archive: number } | null }>` — free/total from `fs.promises.statfs(root)`; usage from `/usr/bin/du -sb` (execFile, 20 s timeout) cached 60 s, `null` on failure.
  - `listPackages(): Promise<{ buildstamp: string; bytes: number }[]>` (cached `*.zip` only) and route `GET /api/packages` (member) returning it.
  - `GET /api/host` adds `disk`. TopBar shows "ดิสก์ว่าง X GB" (amber when < `MIN_FREE_BYTES`) with a tooltip/visible breakdown.
  - Codes: `package_not_found` 502 "ไม่พบไฟล์ MID สำหรับ build นี้บน install.service-now.com ตรวจ buildstamp", `package_download` 502 "ดาวน์โหลดไฟล์ MID ไม่สำเร็จ ลองใหม่", `disk_low` 507 "พื้นที่ดิสก์เหลือน้อยกว่า 2 GB ลบ MID ที่ไม่ใช้ก่อน".

- [ ] **Step 1: Write failing tests:** download writes final file and no `.part` remains; server closes early (fewer bytes than Content-Length) → throws `package_download`, no final file, no `.part`; existing final file → no HTTP request; leftover `.part` from a "crash" is overwritten, not used; 404 → `package_not_found`; `gcPackages` keeps a buildstamp used by an installed MID or a failed job and deletes an unused one.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (Node `fetch` + `Readable.fromWeb` piped to a write stream; no buffering in memory). **Step 4:** PASS + full suite, tsc, eslint.
- [ ] **Step 5:** Commit `feat(packages): cached MID package download, GC and disk status`.

---

### Task 5: Safe package extraction

**Files:**
- Create: `lib/mids/extract.ts`, `lib/mids/test-fixtures/make-zip.ts` (test helper calling `python3` via execFile)
- Modify: `lib/mids/names.ts`
- Test: `lib/mids/extract.test.ts`

**Interfaces:**
- Produces:
  - `validateZip(zipPath: string): Promise<void>` — `/usr/bin/zipinfo -1` names: reject absolute, `..` segments, backslashes, NUL, names not under `agent/` or `META-INF/`; `/usr/bin/zipinfo` long listing: reject any entry whose mode starts with `l` (symlink); require `agent/bin/mid.sh` and `agent/config.xml`. Violations → `MidError("zip_invalid", …, detail: first offending name)`.
  - `extractPackage(zipPath: string, name: string, jobId: string): Promise<void>` — idempotent: if `mids/<name>/agent/bin/mid.sh` exists and `mids/<name>/.midhub-installed-by` contains `jobId` → return. Else: remove a leftover `mids/.extract-<jobId>` (fd-anchored `removeIn` on the mids dir), `mkdir` it, `/usr/bin/unzip -q -o <zip> -d <tmp>` (`execFile`, 10 min timeout), write `.midhub-installed-by` (jobId) inside tmp, then `rename` tmp → `mids/<name>` (target exists → `MidError("conflict")`). All operations under `mids/` via safe-fs dir handles.
  - Code: `zip_invalid` 400 "ไฟล์ MID ไม่ถูกต้องหรือไม่ปลอดภัย ลบ package แล้วดาวน์โหลดใหม่".

- [ ] **Step 1: Write failing tests** (fixtures via `make-zip.ts`): valid zip extracts to `mids/<name>/agent/bin/mid.sh` and leaves no `.extract-*`; zip with `../evil` → `zip_invalid` and nothing created; zip with a symlink entry → `zip_invalid`; zip missing `agent/config.xml` → `zip_invalid`; running `extractPackage` twice with the same jobId is a no-op the second time; a leftover `.extract-<jobId>` from a crash is replaced; existing `mids/<name>` from another job → `conflict`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(install): validated, idempotent MID package extraction`.

---

### Task 6: Configure and clone files

**Files:**
- Create: `lib/mids/provision.ts`
- Test: `lib/mids/provision.test.ts` (temp root; config.xml fixture = the spike's real template, copy it into `lib/mids/test-fixtures/config.template.xml` with placeholder values only)

**Interfaces:**
- Consumes: `setParams`, `readParams` (`config-xml.ts`), `setHeapMb` (`wrapper-conf.ts`), `setProp` (Task 1), safe-fs, layout constants.
- Produces:
  - `type ProvisionInput = { url: string; midUser: string; password: string; snName: string; heapMb: number; logFiles: number; proxy?: { host: string; port: number; user?: string; password?: string } }`.
  - `configureMid(name: string, input: ProvisionInput): Promise<void>` — rewrites `agent/config.xml` with `setParams({ url, "mid.instance.username", "mid.instance.password", name: snName, ...proxy ? {"mid.proxy.use_proxy":"true","mid.proxy.host","mid.proxy.port", user/password if given} : {} })`; `setHeapMb` + `setProp(wrapper.logfile.maxfiles)` on `agent/conf/wrapper-override.conf`; `setProp` both log counts on `agent/properties/glide.properties`. Idempotent (same input → same bytes). Validates `logFiles` ∈ [1,10] and heap ∈ [MIN_HEAP_MB, MAX_HEAP_MB] → `invalid_request`.
  - `cloneFiles(src: string, dst: string): Promise<void>` — copies src `agent/config.xml` over dst's (then sets `mid_sys_id` to `""`; url/name/credentials are written later by `configureMid`), `agent/conf/wrapper-override.conf`, and `agent/extlib/**` (regular files only, symlinks skipped and journaled by the caller). Never touches `agent/security`.

- [ ] **Step 1: Write failing tests:** after `configureMid`, `readParams` shows the 4 values and the diff against the template touches only those lines (no proxy case); proxy case appends `mid.proxy.*` elements and `validateXml` ok; wrapper-override has `wrapper.java.maxmemory=2048` and `wrapper.logfile.maxfiles=3`; glide.properties counts = 3 and all other lines unchanged; running twice gives identical bytes; `logFiles: 11` → `invalid_request`; `cloneFiles` copies a custom param and extlib jar, sets `mid_sys_id=""`, skips a symlink in extlib, and does not create `agent/security/agent_keystore`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(install): configure new MID and clone files`.

---

### Task 7: Install / clone job stages

**Files:**
- Create: `lib/mids/connected.ts`, `lib/jobs/install.ts`
- Test: `lib/mids/connected.test.ts`, `lib/jobs/install.test.ts` (engine + fakes for helper, package, extract)

**Interfaces:**
- Consumes: Tasks 2–6, `callHelper` (`installUnit`, `fixOwnership`, `start`), `getInstanceSecret`, `openLog(name, "main")` from `lib/mids/files.ts` (verified open fn), `tailFile`, `decryptSecret`, `prisma.midServer`.
- Produces:
  - `waitConnected(name: string, since: Date, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>` — tails `agent0.log.0` via the verified-open `tailFile` from offset 0 of the current file; resolves on the first line containing `CONNECTED_MARKER` whose leading ISO timestamp (`2026-11-18T22:40:42.895+0700`) is ≥ `since`; timeout (default 300 000 ms) → `MidError("connect_timeout")` with detail = last 20 lines containing `ERROR|SEVERE`.
  - `type InstallParams = { instanceId: string; buildstamp: string; snName: string; heapMb: number; logFiles: number; proxy?: { host: string; port: number; user?: string; passwordEnc?: string }; cloneFrom?: string }` — `snName` is the MID's name in ServiceNow (`config.xml` `name`); `Job.midName`/`MidServer.name` is always the MidHub name. No plaintext secret: the proxy password is stored encrypted with `encryptSecret` and decrypted only in `configure`.
  - Stages (registered for `install` and `clone`; `copyFiles` only does work when `cloneFrom` is set): `precheck` (name valid; `diskStatus().freeBytes ≥ MIN_FREE_BYTES` else `disk_low`; instance exists and has a password; clone source exists and is not removed) → `fetchPackage` (`ensurePackage`, journal progress at most once per 5 %) → `extract` → `copyFiles` → `configure` (decrypt password here only) → `fixOwnership` → `installUnit` (heapMb) → `start` (records `params.startedAt = now` in the Job row before calling the helper; quota → the helper's `quota_full` message) → `waitConnected(since = params.startedAt)` → success hook: MidServer `state:"installed"`, `version: buildstamp`, then `gcPackages()`.
  - At job creation (Task 9) the MidServer row is created or revived with `state:"installing"`; failure hook sets `state:"error"`.
  - Code: `connect_timeout` 504 "MID เริ่มทำงานแล้วแต่ยังเชื่อมต่อ instance ไม่ได้ใน 5 นาที ดู Log แท็บเพื่อหาสาเหตุ (เช่น password ผิด หรือ proxy)".

- [ ] **Step 1: Write failing tests:** `connected.test.ts` — an old marker line timestamped before `since` is ignored and a new one after `since` resolves; timeout returns `connect_timeout` with ERROR lines in detail; works when the log file appears only after the call. `install.test.ts` — happy path calls helper ops in order `fixOwnership, installUnit(heapMb), start` and ends with MidServer installed + version; clone path runs `cloneFiles` before `configure`; journal, audit and the Job row never contain the instance or proxy password (search for both fixture password strings); `quota_full` at `start` → job failed at `start`, retry after freeing quota completes without re-downloading or re-extracting (fakes record calls); `disk_low` at precheck fails before any download.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(install): install and clone job stages`.

---

### Task 8: Uninstall, cancel-install, archive retention

**Files:**
- Create: `lib/jobs/uninstall.ts`
- Test: `lib/jobs/uninstall.test.ts`

**Interfaces:**
- Consumes: engine, `callHelper` (`stop`, `removeUnit`, `fixOwnership`), safe-fs (`openDir`, `removeIn`), `ARCHIVE_PATHS`, `gcPackages`.
- Produces:
  - `archiveMid(name: string): Promise<string>` — `/usr/bin/tar -czf <archive>/<name>-<yyyyMMdd-HHmmss>.tar.gz -C <midRoot> <existing ARCHIVE_PATHS>` (execFile; tar stores symlinks as links by default — do not pass `-h`); returns the archive path; mode 0640.
  - `deleteMidDir(name: string): Promise<void>` — `fixOwnership` via helper first, then fd-anchored `removeIn(midsDirHandle, midsReal, name, check)`; already gone → no-op.
  - Stage lists: `uninstall`: `stop` (ignore not running) → `removeUnit` → `archive` → `deleteDir` → `markRemoved` (MidServer `state:"removed"`, `removedAt`), success hook `gcPackages()`. `cancel_install`: same without `archive`.
  - `sweepArchives(now = new Date()): Promise<string[]>` — deletes `archive/*.tar.gz` older than 30 days.

- [ ] **Step 1: Write failing tests:** archive contains `agent/config.xml` and `agent/logs/...` but no `agent/lib`/`agent/jre` entries (list with `tar -tzf`); a planted `agent/extlib/out -> <tmp outside dir>` is archived as a symlink entry and, after `deleteDir`, the outside dir and its files still exist; uninstall marks the row removed and calls helper ops `stop, removeUnit, fixOwnership` in that order; re-running after a crash at `deleteDir` completes; `cancel_install` creates no archive; `sweepArchives` deletes a 31-day-old file and keeps a 29-day-old one.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement and `registerKind` both kinds. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(uninstall): uninstall and cancel-install jobs with lean archive`.

---

### Task 9: Job and lifecycle API + boot wiring

**Files:**
- Create: `app/api/jobs/[id]/route.ts`, `app/api/jobs/[id]/events/route.ts`, `app/api/jobs/[id]/retry/route.ts`, `app/api/jobs/[id]/cancel/route.ts`, `app/api/mids/name-check/route.ts`
- Modify: `app/api/mids/route.ts` (POST), `app/api/mids/[name]/route.ts` (DELETE), `lib/mids/registry.ts` (`MidSummary.job`), `instrumentation.ts`, `lib/ui/audit-format.ts`
- Test: route tests next to each route

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces:
  - `POST /api/mids` (member) body `{ instanceId, name, snName?, heapMb?, logFiles?, proxy?: { host, port, user?, password? }, cloneFrom?, buildstamp? }` (`snName` defaults to `midhub-<name>`; `proxy.password` is encrypted into `params.proxy.passwordEnc` before the job row is written) → 202 `{ jobId }`. Buildstamp = body value (validated by `BUILDSTAMP_RE`) or the instance's stored one, else 400 `buildstamp_unknown` ("ระบุ build ของ instance ไม่ได้ ให้เลือก package ที่มีอยู่หรือกรอก buildstamp"). In one transaction: name not used by a non-removed MidServer (`conflict`), create/revive the MidServer row (`state:"installing"`, `instanceId`, `heapMb`), `createJob`. Audit `job.create` `{ kind, snName, cloneFrom? }`.
  - `GET /api/mids/name-check?name=` (member) → `{ valid: boolean; available: boolean; message?: string }`.
  - `DELETE /api/mids/[name]` (admin) body `{ confirmName }` must equal `name` else 400 `confirm_mismatch` ("พิมพ์ชื่อ MID ให้ตรงเพื่อยืนยัน") → 202 `{ jobId }`; MidServer `state:"uninstalling"`. Audit `mid.uninstall`.
  - `GET /api/jobs/[id]` (member) → `{ id, kind, midName, stage, status, error, attempt, createdBy, startedAt, finishedAt, stages: string[] }`; `GET /api/jobs/[id]/events` SSE: replays the journal then follows it (reuse `tailFile` with a plain open of the journal file) and ends after a terminal status line; `POST …/retry`, `POST …/cancel` → engine functions; audit `job.retry`, `job.cancel`.
  - `MidSummary.job: { id; kind; stage; status } | null` = latest job for that MID. The list includes MIDs in state `installing|uninstalling|error`.
  - `register()` in `instrumentation.ts`: after seed → `registerKind`s (import `lib/jobs/install` and `lib/jobs/uninstall`), `resumeJobs()`, `gcPackages()`, `sweepArchives()`, then `setInterval(sweepArchives, 24h)` (`unref()`).

- [ ] **Step 1: Write failing tests:** member POST → 202 and job queued; same name twice concurrently → one 202, one 409; name of a removed MID can be reused (row revived); member DELETE → 403; admin DELETE with wrong `confirmName` → 400; SSE route emits journal lines then closes on `succeeded`; `GET /api/mids` shows an installing MID with its job; no response body anywhere contains the instance password.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(api): lifecycle and job routes, resume on boot`.

---

### Task 10: Create-MID wizard UI

**Files:**
- Create: `components/CreateMidWizard.tsx`, `components/wizard/InstanceStep.tsx`, `components/wizard/SettingsStep.tsx`, `components/wizard/ReviewStep.tsx`, `components/JobProgress.tsx`, `lib/ui/wizard.ts` (pure step validation)
- Modify: `components/TopBar.tsx` (enable "+ สร้าง MID ใหม่"), `components/Dashboard.tsx` (`?create=1&job=<id>` opens wizard/progress)
- Test: `lib/ui/wizard.test.ts`, `components/JobProgress.test.tsx` (jsdom)

**Interfaces:**
- Consumes: `/api/instances*`, `/api/mids/name-check`, `POST /api/mids`, `/api/jobs/*`, `/api/host` (disk, quota, RAM), `Modal`, `ErrorNotice`, `apiFetch`.
- Produces:
  - `canProceed(step: 1 | 2 | 3, state: WizardState): { ok: boolean; reason?: string }` (Thai reasons), where step 1 needs a selected instance whose test passed in this session; step 2 needs a valid, available name and heap/logFiles in range.
  - Step 1 "Instance": pick saved instance (shows build) or "เพิ่ม instance ใหม่" (url, MID user, password, "ทดสอบการเชื่อมต่อ" must pass; saves via POST). If the instance has no buildstamp: choose from cached packages (`GET /api/packages`, Task 4) or type a buildstamp (validated with `BUILDSTAMP_RE`).
  - Step 2 "ตั้งค่า": MID name (300 ms debounced name-check), ServiceNow MID name `snName` (default = `midhub-<name>`), "Clone จาก MID ที่มีอยู่" select, collapsed "ตั้งค่าขั้นสูง" (proxy, heap default 1024, log files default 3).
  - Step 3 "ตรวจสอบ": summary + checks with visible results: disk ≥ 2 GB (blocks), quota (warns "จะติดตั้งได้ แต่ start ไม่ได้จนกว่าจะหยุดตัวอื่น"), RAM < 1 GiB (warns).
  - Step 4 "ติดตั้ง": `JobProgress` — stage checklist (✓ / spinner / ✗), live journal lines via SSE, download % for `fetchPackage`, on failure ErrorNotice + "ลองใหม่" + "ยกเลิกและลบ" (ConfirmDialog), on success "ไป Validate MID ใน instance" linking `<instanceUrl>ecc_agent_list.do?sysparm_query=name=<snName>`. URL keeps `?job=` so a reload resumes the view.

- [ ] **Step 1: Write failing tests:** `canProceed` table (untested instance blocks step 1 with reason; taken name blocks step 2; logFiles 0 blocks); `JobProgress` renders stages from a mocked SSE sequence and shows retry/cancel only on failure.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Playwright check (scratchpad Playwright as in Phase 1, DB copy + temp `MIDHUB_ROOT`, fake helper not running): wizard steps 1–3 at 1280 and 390 px with no horizontal overflow; screenshots to the scratchpad. Stop the dev server afterwards.
- [ ] **Step 6:** Commit `feat(ui): create-MID wizard with live job progress`.

---

### Task 11: MID panel lifecycle UI

**Files:**
- Create: `components/UninstallDialog.tsx`
- Modify: `components/MidPanel.tsx`, `components/OverviewTab.tsx`, `components/MidList.tsx`, `lib/ui/status-view.ts`
- Test: `lib/ui/status-view.test.ts`, `components/UninstallDialog.test.tsx` (jsdom)

**Interfaces:**
- Consumes: `MidSummary.job`, `DELETE /api/mids/[name]`, `JobProgress` (Task 10).
- Produces:
  - Status view: an active job shows 🟡 with the Thai stage label (`fetchPackage` → "กำลังดาวน์โหลด", `extract` → "กำลังแตกไฟล์", `configure` → "กำลังตั้งค่า", `waitConnected` → "รอเชื่อมต่อ instance", uninstall stages → "กำลังลบ"); a failed job shows 🔴 "ติดตั้งไม่สำเร็จ".
  - While a job is active, Start/Stop/Restart/config save/file writes are disabled with visible reason "มีงานกำลังทำอยู่"; the panel shows `JobProgress`.
  - "ลบ" enabled for admins (visible reason for members "ต้องเป็น Admin"); `UninstallDialog` requires typing the exact MID name, explains that the instance record is not deleted, and after success shows the link to the MID record in the instance with "ลบ record นี้ใน instance เองถ้าไม่ใช้แล้ว".
  - Overview "job ล่าสุด": kind, status, time, link to its progress.

- [ ] **Step 1: Write failing tests** for the new status-view branches and for UninstallDialog (confirm button disabled until the typed name matches exactly; Esc closes).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(ui): job progress and uninstall in the MID panel`.

---

### Task 12: End-to-end verification on the host

**Files:**
- Modify: `docs/spike-mid-linux.md` (append "Phase 2 verification" results), `deploy/README.md` (Phase 2 upgrade notes)

- [ ] **Step 1:** Run full suite, `npx tsc --noEmit`, `npx eslint .`, `npm run helper:build`, `npm run build` → all clean.
- [ ] **Step 2:** On the host with the real helper and app deployed per `deploy/README.md` (human-approved), via the UI as a member: add instance `mfecplcdemo4` with a `mid_server`-only user (record whether `buildstamp` was readable), install MID `p2test` → job reaches `succeeded`; instance shows `midhub-p2test` **Up**; Files tab shows `agent/logs` files `midsvc:midhub 0664`; `glide.properties` counts = 3.
- [ ] **Step 3:** Clone `p2test` → `p2clone`: succeeds, `agent/security/agent_keystore` differs between the two MIDs (or is absent until first start), extlib copied.
- [ ] **Step 4:** Restart `bsm-midhub` during a `fetchPackage` of a third install → job resumes and finishes.
- [ ] **Step 5:** As admin uninstall `p2clone` and `p2test`: archives exist in `/opt/midhub/archive`, each a few MB; `/opt/midhub/mids/p2*` gone; units gone; package for the build kept only if `spike1` (imported) still uses it.
- [ ] **Step 6:** Record results (and any deviation) in `docs/spike-mid-linux.md`; commit `docs: phase 2 host verification`.
