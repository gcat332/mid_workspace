// Pure IPv4/IPv6 CIDR helpers: no DB and no node:net, so client components can import them too.

type Ip = { v: 4 | 6; n: bigint }

function parseV4(s: string): bigint | null {
  const parts = s.split(".")
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null
    n = (n << 8n) | BigInt(p)
  }
  return n
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.includes(":::")) return null
  const halves = s.split("::")
  if (halves.length > 2) return null
  // An embedded IPv4 tail (::ffff:1.2.3.4) counts as two groups.
  const toGroups = (part: string): number[] | null => {
    if (part === "") return []
    const out: number[] = []
    const items = part.split(":")
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.includes(".")) {
        if (i !== items.length - 1) return null
        const v4 = parseV4(it)
        if (v4 === null) return null
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn))
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(it)) return null
        out.push(parseInt(it, 16))
      }
    }
    return out
  }
  const head = toGroups(halves[0])
  const tail = halves.length === 2 ? toGroups(halves[1]) : []
  if (!head || !tail) return null
  let groups: number[]
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    groups = [...head, ...Array<number>(fill).fill(0), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n)
}


function parseIp(s: string): Ip | null {
  const v = s.trim()
  if (v.includes(":")) {
    const n = parseV6(v)
    if (n === null) return null
    // IPv4-mapped (::ffff:a.b.c.d) is treated as the IPv4 address it carries.
    if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn }
    return { v: 6, n }
  }
  const n = parseV4(v)
  return n === null ? null : { v: 4, n }
}

function parseCidr(s: string): { ip: Ip; bits: number } | null {
  const [addr, bitsStr, ...rest] = s.trim().split("/")
  if (rest.length) return null
  const ip = parseIp(addr)
  if (!ip) return null
  // Prefix length is relative to the family as written ("::ffff:1.2.3.4/120" is not supported
  // as a range; mapped addresses are only accepted as single hosts).
  const written6 = addr.includes(":")
  const max = written6 ? 128 : 32
  if (bitsStr === undefined) return { ip, bits: ip.v === 4 ? 32 : 128 }
  if (!/^\d{1,3}$/.test(bitsStr)) return null
  const bits = Number(bitsStr)
  if (bits > max) return null
  if (written6 && ip.v === 4) return null
  return { ip, bits }
}

export function isValidCidr(s: string): boolean {
  return parseCidr(s) !== null
}

export function inCidr(ip: string, cidr: string): boolean {
  const a = parseIp(ip)
  const c = parseCidr(cidr)
  if (!a || !c || a.v !== c.ip.v) return false
  const width = a.v === 4 ? 32n : 128n
  const shift = width - BigInt(c.bits)
  return a.n >> shift === c.ip.n >> shift
}

// A direct local request reaches the gate as "::ffff:127.0.0.1" (dual-stack listener); a request
// with no X-Forwarded-For at all is a local/ops call, since Caddy always sets one.
export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "" || ip === "unknown" ||
    ip.toLowerCase() === "::ffff:127.0.0.1"
}

/** The client IP every gate uses: the first X-Forwarded-For hop ("" when absent). */
export function clientIpFrom(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0].trim() || ""
}

/** Would `ip` get through an allowlist made of `cidrs`? Mirrors isAllowed() without the DB. */
export function wouldAllow(ip: string, cidrs: string[]): boolean {
  if (isLoopback(ip)) return true
  if (cidrs.length === 0) return true
  return cidrs.some((c) => inCidr(ip, c))
}

