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

Run on the production deployment (`/home/bsmmidhub/midhub`, `bsm-midhub` + `bsm-midhub-helper`, Caddy at
`https://10.4.150.142/midhub`) through the HTTP API as the admin (plan Task 12, Steps 2-6). spike1 was not touched
and stayed Up throughout.

**Status: BLOCKED (second run, after fixes at `08d3718`).** Extract now passes, but every install/clone stops at
`fixOwnership` (Bug 4 below). Clone, resume, the AgentHub file/upload checks and uninstall of a running MID are
still unverified.

### Deviations

- Instance `mfecplcdemo4` already existed (created by the spike1 import, without credentials). Its MID user/password were
  set with `PATCH /api/instances/<id>` using the **admin account** of the instance (no `mid_server`-only user exists
  yet; a human has to create one and replace the credentials in Admin > Instances).
- Driven through the API (curl, admin cookie), not the browser UI; the admin is allowed to act as a member.

### Results

| Step | Result |
|---|---|
| Instance credentials | ✅ `PATCH` 200 in 0.9 s; `buildstamp` **readable** with admin creds (`glide.war`) = `australia-02-11-2026__patch7w42-10-08-2026_10-13-2026_1248`. Not tested with a `mid_server`-only user. |
| 2. Install `p2test` (run 1, `6646724`) | ❌ `fetchPackage` downloaded 488,425,848 B in ~46 s (cache was empty); `extract` failed (Bug 1), shown as `internal` (Bug 2). |
| 2. Install `p2test` (run 2, `08d3718`) | ❌ package **reused** from cache (`fetchPackage` < 0.1 s); `extract` ✅ 7.6 s (signed zip accepted); `copyFiles`/`configure` ✅; `fixOwnership` failed after 8 s: `fix_ownership_failed`, detail `chmod -R failed (code 127): setpriv: setresuid failed: Operation not permitted` (Bug 4). The failed-job error now carries its real code and detail, so Bug 2 and Bug 3 are fixed. Reviving the name auto-cancelled the previous lifecycle's failed job, as designed. |
| 3. Clone, 4. Resume | ⛔ not run (need a working install) |
| 5a/5b. Agent API checklist (run 1) | ✅ on the failed `p2test` record: five checks; `agent_access` toggled by `PATCH /api/mids/p2test`; other session instance -> `instance_match` failed, 403 `agent_check_failed`, `agent.check_failed` audit row without the secret. Wrong secret 401, non-loopback `Host`/`X-Forwarded-For` 403, via Caddy 404. `usable:true` not reachable (`mid_ready`). |
| 5c-5e. Files, 4 x 50 MiB load, 413, restart | ⛔ not run (need a `mid_ready` MID; the size/busy checks sit behind the checklist) |
| 6. Uninstall | ✅ (run 1) for a failed `p2test` without dir/unit: wrong `confirmName` 400; job succeeded in 0.6 s, no archive (nothing to archive). Uninstall of a real MID not yet verified. |
| Instance records | `ecc_agent` (read-only GET): only `midhub-spike1` (Up, validated=false); no `midhub-p2*` records yet. |

### Bug history (brief)

1. Fixed in `33971b9`: `checkListing` rejected the signed package (FAT-attribute `META-INF/*` entries print a 7-char mode in `zipinfo`, giving "listing mismatch").
2. Fixed in `33971b9`/`08d3718`: two `MidError` classes in the production bundle made `failJob` report every stage error as `internal` without its detail.
3. Fixed in `33971b9`/`08d3718`: helper chown/chmod failures were reported as `systemctl_failed` without detail.
4. **Open, blocks every install/clone:** the helper unit (`deploy/bsm-midhub-helper.service`) combines `User=root`,
   `NoNewPrivileges=yes` and `ProtectKernelModules=yes`. Under systemd 255 (255.4-1ubuntu8.18) that combination starts the
   service **without CAP_SETUID**: live helper `CapEff=000001fffffeff7f` (bit 7 clear), `CapInh=0000000000200100`. So the
   `setpriv --reuid=midsvc` step of `fixOwnership` fails. Reproduced outside MidHub:
   `systemd-run --wait --pipe -p User=root -p NoNewPrivileges=yes -p PrivateTmp=yes -p ProtectKernelModules=yes setpriv --reuid=midsvc --regid=midhub --clear-groups id`
   -> `setpriv: setresuid failed: Operation not permitted`. Dropping `User=root` (or `ProtectKernelModules`, or `NoNewPrivileges`)
   keeps CAP_SETUID. This is very likely also the cause of the spike1 import's `fixOwnership` failure. The earlier probe passed only
   because it left out `User=root`.

### Other observations

- Imported MIDs get `version = NULL`, so `gcPackages` does not keep the package an imported MID runs.
- A failed install job keeps its buildstamp in the GC keep set until the name is reused (then it is auto-cancelled).
- The package cache did not survive the deploy (spike zip gone), so the first install downloads ~488 MB.
