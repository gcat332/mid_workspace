// Single source of truth for the JWT signing secret. Dependency-free so it is safe to
// import from the Edge runtime (proxy) as well as Node.

const DEV_FALLBACK = "dev-secret-change-in-production"

/** HS256 secret as bytes. Fails closed in production on a missing/default/short secret. */
export function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET
  if (process.env.NODE_ENV === "production" && (!secret || secret === DEV_FALLBACK || secret.length < 32)) {
    throw new Error("JWT_SECRET must be set to a strong (32+ chars), non-default value in production")
  }
  return new TextEncoder().encode(secret ?? DEV_FALLBACK)
}
