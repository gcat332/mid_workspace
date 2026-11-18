// Per-MID file locations, relative to the MID root. Resolve with resolveMidPath, never path.join.
// Confirmed in spike 2026-11-18 (docs/spike-mid-linux.md)
export const CONFIG_XML = "agent/config.xml"
// Confirmed in spike 2026-11-18 (docs/spike-mid-linux.md)
export const WRAPPER_OVERRIDE = "agent/conf/wrapper-override.conf"
// Confirmed in spike 2026-11-18 (docs/spike-mid-linux.md)
export const LOG_FILES = { main: "agent/logs/agent0.log.0", wrapper: "agent/logs/wrapper.log" } as const
