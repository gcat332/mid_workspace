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

Run on the production deployment (`/home/bsmmidhub/midhub` at `e2fc6d9`; `bsm-midhub` + `bsm-midhub-helper`, Caddy at
`https://10.4.150.142/midhub`) through the HTTP API as the admin (plan Task 12, Steps 2-6). spike1 was not touched
(active since 2026-11-18 22:41:51, 0 restarts, Up in the instance throughout).

**Result: all steps pass, with two new open bugs (5, 6 below).** Bug 5 means a freshly installed MID ends up
stopped about 40 s after its job reports success, until someone presses Start once.

### Deviations

- Instance `mfecplcdemo4` already existed (created by the spike1 import, without credentials). Its MID user/password were
  set with `PATCH /api/instances/<id>` using the **admin account** of the instance (no `mid_server`-only user exists yet;
  a human has to create one and replace the credentials in Admin > Instances).
- Driven through the API (curl, admin cookie), not the browser UI; the admin is allowed to act as a member.
- To get past Bug 5, each new MID was started once more through the normal `POST /api/mids/<name>/actions {"action":"start"}`.

### Results

| Step | Result | Timing |
|---|---|---|
| Instance credentials | ✅ `buildstamp` **readable** with admin creds (`glide.war`) = `australia-02-11-2026__patch7w42-10-08-2026_10-13-2026_1248` | 0.9 s |
| 2. Install `p2test` | ✅ The first attempt downloaded the package (488,425,848 B, ~46 s) and later runs **reused** it. The job blocked by Bug 4 was retried after the fix: it resumed at `fixOwnership` and reached `succeeded` (installUnit, start, waitConnected). Unit `midhub-mid-p2test` active and enabled (`User=midsvc`, `MemoryMax=1536M`). `agent0.log.0` has "MID Server is connected to instance host: mfecplcdemo4.service-now.com". All `agent/logs` files are `midsvc:midhub 0664` (dir 2775). Counts: `wrapper.logfile.maxfiles=3`, `MIDLogFileHandler.count=3`, `SecurityLogFileHandler.count=3` (1 line each), until the instance overwrote the MID count with 10 (Bug 5). `midhub-p2test` **Up** in `ecc_agent`. | retry -> succeeded 14 s; fresh install (p2resume) 27 s, extract ~8 s |
| 3. Clone `p2test` -> `p2clone` | ✅ `succeeded` in 24 s. `agent_keystore` **differs** (sha256 `c0caaa08…` vs `97065bbe…`). `mid_sys_id` is a new one. `config.xml` `name=midhub-p2clone`. The encrypted password was cleared (journal warning) and re-set by configure. A 4 KiB marker jar in `agent/extlib` was **copied** (same sha256). The MID's own `FileSync:ecc_agent_jar` then deleted the jar from both MIDs (see note). | 24 s |
| 4. Resume | ✅ Install `p2resume`. `systemctl restart bsm-midhub` was issued **0.3 s into `extract`** (package cached, so `fetchPackage` was too fast to catch). The app was back after ~3.5 s. The job re-entered `extract` (attempt 0), its leftover `staging/.extract-<job>` was cleaned, and it reached `succeeded`. | 27 s total |
| 5a. Agent checklist | ✅ Before: all MIDs `usable:false`, only `agent_access` failing. After `PATCH /api/mids/p2test {agentAccess:true}`: p2test `usable:true` (all 5 checks ok). With session instance `other.service-now.com`: `instance_match` failed, 403 `agent_check_failed`, `agent.check_failed` audit. | |
| 5c. File ops | ✅ Raw upload 2 KiB (sha matches on disk); PUT new text file; PUT `baseHash:""` again -> 409 `exists`; read back (hash = sha256 of content); list; `logs?file=main&lines=5` -> 5 lines; write to `agent/bin` -> 403 `read_only`; read `config.xml` content -> 403; DELETE both -> 200, extlib empty. | |
| 5d. Load check | ✅ Two rounds of 4 parallel 52,428,800 B uploads: each round **2 x 200 (~0.8-1.1 s) + 2 x 429 `busy` (~0.1-0.16 s)**, no 5xx. App `MemoryCurrent` 314 MB at baseline, **peak 548 MB** (0.1 s samples from `memory.current`; anon 178 MB, the rest page cache). `MemoryMax=1G`. Cgroup `memory.peak` since app start was 958 MB, from the p2resume extract's page cache. `Content-Length: 4000000000` with a 4-byte body -> **413 `too_large` in 0.04 s**, nothing written. Chunked without Content-Length -> 411 `length_required`. All uploads deleted. App stayed active. | |
| 5e. Restart | ✅ `POST agent/mids/p2test/restart` -> `{ok:true}`; reconnected after 23 s; stayed up (no further self-restart). Audit `agent.restart`, `agent.file.*` with `via/taskId/sessionInstances`, no secret. | 23 s |
| 6. Uninstall (admin) | ✅ p2resume, p2clone, p2test: each `stop -> removeUnit -> archive -> deleteDir -> markRemoved` in ~10 s. Archives `p2clone-…tar.gz` 624,297 B, `p2resume-…` 476,685 B, `p2test-…` 289,692 B (conf, extlib, logs, properties, security, config.xml). `/opt/midhub/mids/p2*` gone, units gone, staging empty. **Package deleted by GC** although spike1 runs that build (Bug 6). | ~10 s each |
| Instance records | `ecc_agent` (read-only GET) at the end: `midhub-p2test`, `midhub-p2clone`, `midhub-p2resume` **Down** (validated=false); `midhub-spike1` Up. Left in place for a human to delete. | |
| Failed-job errors | ✅ show their real code: `fix_ownership_failed` with command and stderr (Bug 4 run). | |

Note: on start, a MID's `FileSync:ecc_agent_jar` deletes every jar in `agent/extlib` that is not an `ecc_agent_jar` record in
the instance (log: `Deleting /opt/midhub/mids/<name>/agent/extlib/<file>.jar`). Jars copied by clone, uploaded in the files tab
or uploaded by AgentHub survive only until the next sync unless they are registered as MID Server JAR files in the instance.

### Bug history (brief)

1. Fixed (`33971b9`): the signed package was rejected at extract (FAT-attribute `META-INF/*` modes in `zipinfo`, giving "listing mismatch").
2. Fixed (`33971b9`/`08d3718`): duplicate `MidError` classes in the bundle made every job error `internal` without detail.
3. Fixed (`33971b9`/`08d3718`): chown/chmod failures were reported as `systemctl_failed` without detail.
4. Fixed (`e2fc6d9`): the helper unit's `User=root` + `NoNewPrivileges` + `ProtectKernelModules` dropped CAP_SETUID on systemd 255, so
   `setpriv` in `fixOwnership` failed (also the cause of the spike1 import's fixOwnership failure).
5. **Verified on host (2026-11-19, commit 24dae4e; unit `Restart=always`):** a fresh MID `p3check` was installed (job succeeded 08:14:57), the MID restarted itself at 08:15:28 (~40 s after first connect, ShutdownHandler in agent0.log.0), systemd brought the unit back to `active` by 08:15:42 (`NRestarts=1`) and the log shows "MID Server is connected to instance" again at 08:15:53. Uninstall afterwards was clean (unit gone, folder gone, archive `p3check-20261119-081737.tar.gz` 172,720 B). Check of I1 (`reset-failed` before start/restart): 6 back-to-back `POST /api/mids/p3check/actions {"action":"restart"}` all returned 200 (first 8.6 s, rest ~1 s), unit `active`, `Result=success`.
   `Changed properties saved to MID glide.properties file: [com.service_now.mid.logging.MIDLogFileHandler.count=10]` and
   `Restarting MID Server as MID glide.properties file has been updated with settings from the Instance`. The wrapper then gets
   TERM, exits 0, and systemd marks the unit inactive (`Restart=on-failure` does not fire). Seen on p2test, p2clone and p2resume
   (3/3). The job already reported `succeeded` and MidHub then shows "stopped". One manual Start fixes it (no further restart).
   The trigger is MidHub writing `MIDLogFileHandler.count=3` while the instance enforces 10, so the requested log retention also
   does not stick for the MID log (`SecurityLogFileHandler.count` stayed 3).
6. **Fixed (GC keeps the Instance.buildstamp package):** imported MIDs get `version = NULL`, so `gcPackages` does not count them. Uninstalling the last MidHub-installed MID of
   a build deleted that build's package although imported spike1 runs it. Not harmful to spike1; the next install re-downloads ~488 MB.

### Other observations

- `bsm-midhub` stop logs `status=143` / "Failed with result 'exit-code'" (SIGTERM exit code not declared a success); cosmetic.
- The package cache did not survive the first deploy (spike zip gone); the first install downloads ~488 MB (~46 s here).
