// Shared by the app client and the root helper. Must stay free of Next/Prisma/env imports and use relative imports only.
export type HelperRequest =
  | { op: "start" | "stop" | "restart"; name: string }
  | { op: "installUnit"; name: string; heapMb: number }
  | { op: "removeUnit" | "fixOwnership"; name: string }

export type HelperErrorCode = "invalid_name" | "invalid_request" | "quota_full" | "not_found" | "systemctl_failed" | "fix_ownership_failed" | "busy" | "internal"

export type HelperResponse = { ok: true } | { ok: false; code: HelperErrorCode; message: string }

export const HELPER_OPS = ["start", "stop", "restart", "installUnit", "removeUnit", "fixOwnership"] as const
export const MIN_HEAP_MB = 256
export const MAX_HEAP_MB = 2048
export const MAX_REQUEST_BYTES = 4096
export const HELPER_ERROR_CODES: readonly HelperErrorCode[] = ["invalid_name", "invalid_request", "quota_full", "not_found", "systemctl_failed", "fix_ownership_failed", "busy", "internal"]
export const READ_DEADLINE_MS = 10_000
export const EXEC_TIMEOUT_MS = 120_000
export const CLIENT_TIMEOUT_MS = 150_000
