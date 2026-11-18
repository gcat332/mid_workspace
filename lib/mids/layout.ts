// Per-MID file locations, relative to the MID root. Resolve with resolveMidPath, never path.join.
// Confirmed in spike 2026-11-18 (docs/spike-mid-linux.md)
export const CONFIG_XML = "agent/config.xml"
// Confirmed in spike 2026-11-18 (docs/spike-mid-linux.md)
export const WRAPPER_OVERRIDE = "agent/conf/wrapper-override.conf"
// Confirmed in spike 2026-11-18 (docs/spike-mid-linux.md)
export const LOG_FILES = { main: "agent/logs/agent0.log.0", wrapper: "agent/logs/wrapper.log" } as const

// Phase 2: what a clone/upgrade carries over, and install-time constants (spec §7, §8, §8.1).
export const ARCHIVE_PATHS = [
  "agent/config.xml",
  "agent/conf",
  "agent/extlib",
  "agent/security",
  "agent/properties",
  "agent/logs",
] as const
export const GLIDE_PROPERTIES = "agent/properties/glide.properties"
// Confirmed in spike 2026-11-18 (docs/spike-mid-linux.md), logged by StartupSequencer in agent0.log.0
export const CONNECTED_MARKER = "MID Server is connected to instance host:"
export const LOG_COUNT_KEYS = {
  wrapper: "wrapper.logfile.maxfiles",
  mid: "com.service_now.mid.logging.MIDLogFileHandler.count",
  security: "com.service_now.mid.logging.SecurityLogFileHandler.count",
} as const
export const DEFAULT_LOG_FILES = 3
export const MIN_LOG_FILES = 1
export const MAX_LOG_FILES = 10
export const MIN_FREE_BYTES = 2 * 1024 ** 3
