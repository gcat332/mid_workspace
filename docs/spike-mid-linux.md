# Phase 0 spike: MID Server on Linux under systemd — results

Run on 2026-11-18 on host `agenthubdemo` (the AgentHub host) against demo instance
`mfecplcdemo4.service-now.com` (build `australia-02-11-2026__patch7w42-10-08-2026_10-13-2026_1248`).
MID `spike1` (ServiceNow name `midhub-spike1`) installed at `/opt/midhub/mids/spike1`, unit
`midhub-mid-spike1.service` rendered by `helper/unit-template.ts` (see `deploy/midhub-mid.service.example`).
It connected and shows **Up** in the instance (`ecc_agent`); **Validate** in the instance is still to be clicked
by a human (it is a write to the instance).

## Host preparation used (same as `deploy/install.sh` does)

- group `midhub` (system), user `midsvc` (system, nologin, no home, primary group `midhub`),
  `bsmmidhub` added to `midhub`; `fs.protected_hardlinks=1`.
- `/opt/midhub` root:root 0755; `mids` midsvc:midhub 2770 (was 2775; no access for others because config.xml holds a plaintext password until first start); `packages`, `archive`, `db` bsmmidhub 0750.
- `packages/` is not readable by `midsvc`, so the package is extracted **as bsmmidhub** into `mids/<name>`
  (group `midhub`, setgid dir) and then ownership is normalised exactly like the helper's `fixOwnership`
  (`chown -R -P -h midsvc:midhub` as root, then `chmod -R g+rwX` as midsvc via `setpriv`). This is the flow
  Phase 2's install job should use.

## Results

| Item | Where in code | Value | Result |
|---|---|---|---|
| EXEC_START | helper/unit-template.ts (`EXEC_START_REL`) | `agent/bin/mid.sh console` | ✅ Works with `Type=simple`, `User=midsvc`, `Group=midhub`, `NoNewPrivileges`, `PrivateTmp`. Tanuki wrapper 3.5.57 starts "as Console"; MainPID is `mid.sh`. `systemctl stop` → "TERM trapped. Shutting down." → clean stop in ~5 s (`Result=success`). Restart reconnects. No `installer.sh`/`configure.sh` needed. |
| UMask=0002 | helper/unit-template.ts | `UMask=0002` | ✅ Files/dirs the MID creates (logs, `security/agent_keystore`, `work/`, `scripts/`, `tools/`, `SecurityAudit/`) are `midsvc:midhub`, files 0664, dirs 2775. |
| config.xml path | lib/mids/layout.ts `CONFIG_XML` | `agent/config.xml` | ✅ |
| wrapper override | lib/mids/layout.ts `WRAPPER_OVERRIDE` | `agent/conf/wrapper-override.conf` | ✅ Exists (ships `wrapper.name`, `wrapper.displayname` and a commented `#wrapper.java.maxmemory=1024`). Default heap comes from `conf/wrapper.conf` (`wrapper.java.maxmemory=1024`); `setHeapMb` appending the line to the override is correct. |
| LOG_FILES | lib/mids/layout.ts `LOG_FILES` | `agent/logs/agent0.log.0`, `agent/logs/wrapper.log` | ✅ Both exist. `agent0.log.0` is appended across restarts (not truncated). `wrapper.conf` sets `wrapper.logfile=logs/wrapper.log.ROLLNUM`, maxsize 10m, maxfiles 10 → current file `wrapper.log`, rolled `wrapper.log.N`. Other files: `security0.log.0`, `*.lck`, `FileHandlerReport.txt`, `ExtendedLogReport.txt`, `jfr_dump_on_exit.jfr`. |
| Program dirs (read-only) | lib/mids/paths.ts `PROGRAM_DIRS` | `agent/bin`, `agent/lib`, `agent/jre` | ✅ Present. (Also shipped: `package/`, `midinstaller/`, `etc/` — left writable; revisit if needed.) |
| config.xml parameter names | lib/mids/config-service.ts `FORM_PARAMS` | `url`, `mid.instance.username`, `mid.instance.password` (`secure="true"`), `name`, `mid.proxy.use_proxy/host/port/username/password` | ✅ All present in the shipped template. The proxy block is **inside an XML comment** in the template, so saving proxy settings appends new `<parameter>` elements (setParams' documented behaviour). Writing url/user/password/name with the app's `setParams` changed exactly those 4 lines. |
| Password encryption | — | — | ✅ After first start the MID rewrote `mid.instance.password` as `ENCv2[...]` and added `mid_sys_id`; owner/mode stayed `midsvc:midhub 0664`. The config tab's stale-hash check covers this rewrite. |
| CONNECTED_LOG_PATTERN (Phase 2) | not yet in code | `MID Server is connected to instance host:` (in `agent0.log.0`, `StartupSequencer`) | ✅ Appears ~2 s after JVM start. Earlier line: `InstanceConnectivityTest ... Successfully connected to instance`. Startup also logs `MIDServerState ... MID Server started`. |
| PACKAGE_URL_RECIPE (Phase 2) | not yet in code | see below | ✅ Host reaches `install.service-now.com:443`. |
| CARRY_OVER_FILES (Phase 2) | not yet in code | `agent/config.xml`, `agent/conf/wrapper-override.conf`, `agent/extlib/`, `agent/security/` (`agent_keystore`) | Proposed from what the MID creates; not verified against a real upgrade. |
| MID version (overview) | — | `agent/properties/glide.properties` has `mid.buildstamp=2026-10-13-1248`; instance `ecc_agent.version` has the full buildstamp | Phase 2/3 can read either (overview currently shows "ไม่ทราบ"). |
| Memory | — | heap 1024 MB, unit `MemoryMax=1536M` | Peak ~480 MB right after start. |
| Auto-upgrade under systemd | — | — | ⏳ Not verified (needs an instance upgrade). The wrapper restarts the JVM itself, which should work under `console` mode; check on the next instance upgrade. |

### PACKAGE_URL_RECIPE

1. Read the instance build: `GET /api/now/table/sys_properties?sysparm_query=name=glide.war` →
   `glide-<buildstamp>.zip`, e.g. `glide-australia-02-11-2026__patch7w42-10-08-2026_10-13-2026_1248.zip`.
2. `<buildstamp>` = value without `glide-` and `.zip`. Its last date `MM-DD-YYYY` (here `10-13-2026`) gives the path.
3. URL: `https://install.service-now.com/glide/distribution/builds/package/app-signed/mid/<YYYY>/<MM>/<DD>/mid.<buildstamp>.linux.x86-64.zip`
   (≈ 488 MB; the unsigned `.../package/mid/...` and the `.deb` installer also exist).

## Notes

- `wrapper | Classpath element, wrapper.java.classpath.2, did not match any files: extlib/*.jar` is benign (empty extlib).
- JVM prints `System::setSecurityManager` deprecation warnings to the wrapper log — benign.
- For real use, create a dedicated instance user with only the `mid_server` role; the spike used an admin account.
- Spike leftovers on the host: `/opt/midhub/mids/spike1`, `/opt/midhub/packages/<buildstamp>.zip`,
  `/etc/systemd/system/midhub-mid-spike1.service` (running, not enabled). Import it from the dashboard
  ("Import MID ที่มีอยู่", name `spike1`) once MidHub is deployed.

## Phase 2 verification (2026-11-19)

Run on the production deployment (`/home/bsmmidhub/midhub`, commit `6646724`, `bsm-midhub` + `bsm-midhub-helper`
active, Caddy at `https://10.4.150.142/midhub`) through the HTTP API as the admin (plan Task 12, Steps 2-6).
**Result: BLOCKED at the first install.** The real (signed) MID package is rejected by the extract stage, so
install, clone, resume, the AgentHub file/upload checks and the uninstall of installed MIDs could not be verified.
`spike1` was not touched and stayed Up throughout.

### Deviations

- Instance `mfecplcdemo4` already existed (created by the spike1 import, without credentials). Its MID user/password were
  set with `PATCH /api/instances/<id>` using the **admin account** of the instance (no `mid_server`-only user exists
  yet; a human still has to create one and replace the credentials in Admin > Instances).
- Driven through the API (curl, admin cookie), not the browser UI; the admin is allowed to act as a member.

### Results

| Step | Result |
|---|---|
| Instance credentials | ✅ `PATCH` 200 in 0.9 s; connection test passed; `buildstamp` **readable** (`glide.war` via `sys_properties`, admin creds) = `australia-02-11-2026__patch7w42-10-08-2026_10-13-2026_1248`. Not tested with a `mid_server`-only user. |
| 2. Install `p2test` | ❌ `fetchPackage` **downloaded** the package (cache was empty: `/opt/midhub/packages` had been recreated, the spike's zip was gone): 488,425,848 bytes in ~46 s from `install.service-now.com`, progress logged every 5 %. `extract` then failed in < 0.1 s with `ไฟล์ MID ไม่ถูกต้องหรือไม่ปลอดภัย...` (see bug below). Retry resumed at `extract` (attempt 1) and failed the same way, so the failure is deterministic. Nothing was left in `staging/` or `mids/`. |
| 3. Clone | ⛔ not run (needs an installed MID) |
| 4. Resume after `systemctl restart bsm-midhub` | ⛔ not run (every install fails at extract, and the package is now cached so `fetchPackage` is instant) |
| 5a/5b. Agent API checklist | ✅ on the failed `p2test` record: `GET agent/mids` lists all five checks; before: `agent_access`+`mid_ready` failed; `PATCH /api/mids/p2test {agentAccess:true}` 200; after: only `mid_ready` failed; with session instance `https://other.service-now.com` -> `instance_match` failed; per-MID route -> 403 `agent_check_failed` and an `agent.check_failed` audit row (`via`, `taskId`, `sessionInstances`, no secret). Auth: wrong secret 401, non-loopback `Host` 403 `agent_auth`, non-loopback `X-Forwarded-For` 403, `/midhub/api/agent/mids` via Caddy 404. |
| 5c/5d/5e. Files, 50 MiB load check, 413, restart | ⛔ not run: every file route runs the checklist first, so it needs a `mid_ready` MID (spike1 must not be modified). The 413 / 429 checks sit behind the checklist too. |
| 6. Uninstall | ✅ for the failed `p2test` (no dir, no unit): wrong `confirmName` -> 400; job `stop -> removeUnit -> archive ("ไม่พบโฟลเดอร์ MID ข้ามการสำรอง") -> deleteDir -> markRemoved` succeeded in 0.6 s; no archive (nothing to archive), no `/opt/midhub/mids/p2test`, no unit. The package was kept, but only because the failed install job still references its buildstamp: spike1's `version` is NULL (import does not set it), so `gcPackages` would not keep it for spike1. |
| Instance records | `ecc_agent` (read-only GET): only `midhub-spike1` (Up, validated=false). No `midhub-p2*` records were created. |

### Bug: signed MID package always rejected by `checkListing` (blocks every install)

- `lib/mids/extract.ts` `checkListing` parses `zipinfo` long lines with `^([-dlcbps?][-rwxsStT]{9})\s+...`.
  The app-signed package (`PACKAGE_URL_RECIPE` above) has 3 `META-INF/*` entries (`MANIFEST.MF`, `GENERAL_.SF`,
  `GENERAL_.RSA`) stored with FAT host attributes; `zipinfo` prints their mode as `-rw----` (7 chars), so those lines
  do not match. The parsed count is 1142 vs 1145 names, which throws `zip_invalid("listing mismatch")`.
- The official unsigned package of the same build (`.../package/mid/2026/10/13/mid.<buildstamp>.linux.x86-64.zip`,
  488,278,604 bytes) has no `META-INF` and identical `agent/` entries (same 1142 names, sizes, CRC-32 and modes), so
  it would pass. Swapping the cached package for it was not done (data change on production, not approved).
- Unit tests use synthetic zips, so they did not catch it.

### Bug (likely): stage errors lose their code and detail in the production build

The job journal records `code: "internal"`, message `ตัวช่วยระบบทำงานผิดพลาด...` and detail = the `zip_invalid` message,
instead of `code: "zip_invalid"` with detail `listing mismatch`. `failJob` (`lib/jobs/engine.ts`) wraps any error that is not
`instanceof MidError` as `internal`. The production `.next` bundle contains two separate `MidError` classes
(`chunks/lib_mids_names_ts_*.js` and `chunks/lib_http_route_ts_*.js`), so `instanceof` fails across chunks. Effect: users get the
generic "helper failed" text plus advice to delete the package and re-download, which would not help, and the real cause is lost.

### Other observations

- spike1 import (06:56): audit `mid.import` has `fixOwnership: "failed: systemctl_failed"`; the app log only has the generic
  message (detail dropped). A `setpriv --reuid=midsvc` no-op in a `NoNewPrivileges=yes` transient unit works, and spike1's tree is
  fully `midsvc:midhub`, group-rw, with no symlinks. Likely cause (not confirmed): `chmod -R` racing files the running MID
  creates or deletes. The helper reports chown/chmod failures under the code `systemctl_failed`.
- A failed install job of a removed MID keeps its buildstamp in `gcPackages`' keep set indefinitely.
