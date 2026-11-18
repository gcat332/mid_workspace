import { describe, it, expect } from "vitest"
import { isValidCidr, inCidr, isLoopback, clientIpFrom, wouldAllow } from "@/lib/net/cidr"

describe("isValidCidr", () => {
  it.each(["10.0.0.0/8", "1.2.3.4", "0.0.0.0/0", "2001:db8::/32", "::1", "fe80::1/128", "::ffff:10.1.2.3"])("accepts %s", (v) => {
    expect(isValidCidr(v)).toBe(true)
  })
  it.each(["", "abc", "10.0.0.0/33", "256.1.1.1", "1.2.3", "2001:db8::/129", "2001:::1", "1:2:3:4:5:6:7:8:9", "01.2.3.4", "1.2.3.04", "10.0.0.0/-1", "10.0.0.0/"])("rejects %s", (v) => {
    expect(isValidCidr(v)).toBe(false)
  })
})

describe("inCidr", () => {
  it("matches IPv4 ranges and exact addresses", () => {
    expect(inCidr("10.1.2.3", "10.0.0.0/8")).toBe(true)
    expect(inCidr("11.1.2.3", "10.0.0.0/8")).toBe(false)
    expect(inCidr("1.2.3.4", "1.2.3.4")).toBe(true)
    expect(inCidr("1.2.3.5", "1.2.3.4")).toBe(false)
    expect(inCidr("8.8.8.8", "0.0.0.0/0")).toBe(true)
  })
  it("matches IPv6 ranges", () => {
    expect(inCidr("2001:db8::5", "2001:db8::/32")).toBe(true)
    expect(inCidr("2001:db9::5", "2001:db8::/32")).toBe(false)
    expect(inCidr("2001:DB8:0:0:0:0:0:5", "2001:db8::5")).toBe(true)
  })
  it("never matches across address families, except IPv4-mapped IPv6 against IPv4 rules", () => {
    expect(inCidr("2001:db8::5", "10.0.0.0/8")).toBe(false)
    expect(inCidr("10.1.2.3", "2001:db8::/32")).toBe(false)
    expect(inCidr("::ffff:10.1.2.3", "10.0.0.0/8")).toBe(true)
  })
  it("does not match garbage input", () => {
    expect(inCidr("not-an-ip", "10.0.0.0/8")).toBe(false)
  })
})

describe("isLoopback / clientIpFrom / wouldAllow", () => {
  it("recognises loopback forms", () => {
    expect(isLoopback("127.0.0.1")).toBe(true)
    expect(isLoopback("::1")).toBe(true)
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopback("::ffff:10.8.96.5")).toBe(false)
  })
  it("takes the first X-Forwarded-For hop", () => {
    expect(clientIpFrom(new Headers({ "x-forwarded-for": " 10.1.2.3 , 1.1.1.1" }))).toBe("10.1.2.3")
    expect(clientIpFrom(new Headers())).toBe("")
  })
  it("empty list allows all; otherwise needs a match", () => {
    expect(wouldAllow("8.8.8.8", [])).toBe(true)
    expect(wouldAllow("8.8.8.8", ["10.0.0.0/8"])).toBe(false)
    expect(wouldAllow("10.2.3.4", ["10.0.0.0/8"])).toBe(true)
  })
})
