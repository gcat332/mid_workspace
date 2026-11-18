// Password-login lockout policy. Client-safe: no imports.

/** Consecutive wrong passwords before the account locks; only an admin unlock clears it. */
export const MAX_FAILED_LOGINS = 3
