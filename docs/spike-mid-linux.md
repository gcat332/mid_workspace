# Phase 0 spike: MID Server on Linux under systemd

Run on the real host with a demo instance. Every value below is PROVISIONAL in code; confirm or change it
in the listed place, then fill the Result column. (grep -rn PROVISIONAL to re-check.)

| Item | Where (file:line) | Current value | Verify on host | Change where | Result |
|---|---|---|---|---|---|
| EXEC_START (unit ExecStart) | helper/unit-template.ts:4 (EXEC_START_REL), :23 | `agent/bin/mid.sh console` | Does it run in foreground under `Type=simple`, run as midsvc, stop cleanly on SIGTERM? Is `start`/`wrapper` needed instead? Also User/Group/NoNewPrivileges/PrivateTmp OK? | `EXEC_START_REL`; refresh deploy/midhub-mid.service.example | |
| config.xml path | lib/mids/layout.ts:2-3 | `agent/config.xml` | File exists at that path | `CONFIG_XML` | |
| wrapper override path | lib/mids/layout.ts:4-5 | `agent/conf/wrapper-override.conf` | Exists / where heap (`wrapper.java.maxmemory`) is set | `WRAPPER_OVERRIDE` (+ heap handling) | |
| LOG_FILES | lib/mids/layout.ts:6-7 | main `agent/logs/agent0.log.0`, wrapper `agent/logs/wrapper.log` | Names, rotation scheme, which one shows startup | `LOG_FILES` | |
| Program dirs (read-only) | lib/mids/paths.ts:71; also lib/mids/files.ts:52 | `agent/bin`, `agent/lib`, `agent/jre` | Dir names; anything else that must be read-only | `dirs` in paths.ts, files.ts | |
| config.xml parameter names | lib/mids/config-service.ts:21 (FORM_PARAMS) | url, mid.instance.username, mid.instance.password, name, mid.proxy.use_proxy, mid.proxy.host, mid.proxy.port, mid.proxy.username, mid.proxy.password | Each parameter name in a real config.xml; password rewritten encrypted after first start | `FORM_PARAMS` | |
| CONNECTED_LOG_PATTERN (Phase 2) | not yet in code | n/a | Exact log line meaning "connected to instance" | new constant (Phase 2) | |
| CARRY_OVER_FILES (Phase 2) | not yet in code | n/a | Files to preserve across auto-upgrade (config.xml, wrapper-override.conf, extlib/, keystore, ...) | new constant (Phase 2) | |
| PACKAGE_URL_RECIPE (Phase 2) | not yet in code | n/a | How to obtain the Linux MID zip for an instance build; host reaches install.service-now.com? | new constant (Phase 2) | |
| Auto-upgrade under systemd | n/a | n/a | Behaviour of MID self-upgrade when run by systemd | notes | |
