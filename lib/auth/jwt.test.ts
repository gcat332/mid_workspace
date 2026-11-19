import { describe, it, expect } from "vitest"
import * as jose from "jose"
import { signToken, verifyToken } from "./jwt"

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET ?? "dev-secret-change-in-production")
const sign = (claims: Record<string, unknown>, iss = "bsm-midhub/session") =>
  new jose.SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuer(iss).setExpirationTime("1h").sign(secret())

describe("jwt", () => {
  const p = { userId: "u1", email: "a@b.c", role: "admin" as const, ahAt: 1_800_000_000 }

  it("round-trips a session payload", async () => {
    expect(await verifyToken(await signToken(p))).toMatchObject(p)
  })
  it("an old-style session without ahAt (local login) is invalid", async () => {
    const { ahAt: _drop, ...old } = p
    void _drop
    expect(await verifyToken(await sign(old))).toBeNull()
    expect(await verifyToken(await sign({ ...old, ahAt: "1800000000" }))).toBeNull()
  })
  it("signToken can keep an existing expiry (re-verified background poll must not slide the idle timeout)", async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    const t = await signToken(p, { expiresAt: exp })
    expect(jose.decodeJwt(t).exp).toBe(exp)
    expect(await verifyToken(t)).toMatchObject(p)
  })
  it("rejects a foreign issuer", async () => {
    expect(await verifyToken(await sign(p, "ai-workspace/session"))).toBeNull()
  })
  it("rejects a token carrying a purpose claim", async () => {
    expect(await verifyToken(await sign({ ...p, purpose: "x" }))).toBeNull()
  })
  it("rejects alg none", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
    const t = `${b64({ alg: "none", typ: "JWT" })}.${b64({ ...p, iss: "bsm-midhub/session", exp: 9999999999 })}.`
    expect(await verifyToken(t)).toBeNull()
  })
  it("rejects a payload without userId", async () => {
    expect(await verifyToken(await sign({ email: "a@b.c", role: "admin" }))).toBeNull()
  })
  it("rejects an unknown role", async () => {
    expect(await verifyToken(await sign({ ...p, role: "root" }))).toBeNull()
  })
})
