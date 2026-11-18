// OIDC helpers for the SSO login flow: discovery, PKCE, and id_token verification.
// Kept provider-agnostic — works for Entra ID / Azure AD, Google, or any OIDC issuer.
import * as jose from "jose"
import type { User } from "@prisma/client"
import { prisma } from "@/lib/db/client"

export interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

const discoveryCache = new Map<string, Discovery>()

export async function discover(issuer: string): Promise<Discovery> {
  // trim() first: a pasted leading/trailing space makes fetch() see a malformed
  // URL and throw, which the caller turns into a bounce back to /login.
  const base = issuer.trim().replace(/\/+$/, "")
  const cached = discoveryCache.get(base)
  if (cached) return cached
  const res = await fetch(`${base}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`discovery ${res.status}`)
  const d = (await res.json()) as Partial<Discovery>
  if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri || !d.issuer) {
    throw new Error("discovery document missing endpoints")
  }
  const disc: Discovery = {
    issuer: d.issuer,
    authorization_endpoint: d.authorization_endpoint,
    token_endpoint: d.token_endpoint,
    jwks_uri: d.jwks_uri,
  }
  discoveryCache.set(base, disc)
  return disc
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

export function randomString(bytes = 32): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return b64url(b)
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return b64url(new Uint8Array(digest))
}

const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>()

export async function verifyIdToken(
  idToken: string,
  jwksUri: string,
  issuer: string,
  audience: string,
): Promise<jose.JWTPayload> {
  let jwks = jwksCache.get(jwksUri)
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(new URL(jwksUri))
    jwksCache.set(jwksUri, jwks)
  }
  const { payload } = await jose.jwtVerify(idToken, jwks, { issuer, audience })
  return payload
}

export function emailFromClaims(p: jose.JWTPayload): string | null {
  const email = (p.email as string) || (p.preferred_username as string) || (p.upn as string)
  return email && email.includes("@") ? email.toLowerCase() : null
}

export const OIDC_TEMP_COOKIES = ["oidc_state", "oidc_nonce", "oidc_verifier", "oidc_redirect"]

/** Public origin for redirects (behind the reverse proxy req.url is not the real host). */
export function publicBase(req: Request): string {
  return process.env.PUBLIC_URL?.replace(/\/+$/, "") || req.url
}

/** SSO never creates users: only emails already in the User table may sign in. */
export async function findRegisteredUser(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } })
}
