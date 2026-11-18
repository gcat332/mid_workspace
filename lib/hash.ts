import { createHash } from "node:crypto"

/** Hex SHA-256 of a string (UTF-8) or bytes. */
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex")
