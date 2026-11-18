import { beforeEach, describe, expect, it, vi } from "vitest"

const envMock = vi.hoisted(() => ({ vaultKey: "" }))
vi.mock("@/lib/env", () => ({ env: envMock }))

import { decryptSecret, encryptSecret } from "./vault"

beforeEach(() => {
  envMock.vaultKey = Buffer.alloc(32, 7).toString("base64")
})

describe("vault", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("p@ss ไทย")
    expect(decryptSecret(a)).toBe("p@ss ไทย")
    expect(encryptSecret("p@ss ไทย")).not.toBe(a)
  })
  it("throws on tampered ciphertext", () => {
    const [iv, tag, ct] = encryptSecret("secret").split(":")
    const bad = Buffer.from(ct, "base64url")
    bad[0] ^= 1
    expect(() => decryptSecret([iv, tag, bad.toString("base64url")].join(":"))).toThrow()
  })
  it("throws on a malformed blob", () => {
    expect(() => decryptSecret("nope")).toThrow(/malformed/)
  })
  it("rejects a key that is not 32 bytes", () => {
    envMock.vaultKey = "change-me-vault-key"
    expect(() => encryptSecret("x")).toThrow(/32 bytes/)
  })
})
