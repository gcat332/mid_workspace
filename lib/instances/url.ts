// Pure (no Prisma/Next imports) so AgentHub-integration code can import it too.
import { MidError } from "@/lib/mids/names"

const HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}\.service-now\.com$/

/** Canonical `https://<sub>.service-now.com/`; throws MidError("instance_url") for anything else. */
export function normalizeInstanceUrl(raw: string): string {
  if (typeof raw !== "string") throw new MidError("instance_url")
  const s = raw.trim()
  // Reject backslashes/control chars up front: WHATWG URL treats "\" like "/" which hides path tricks.
  if (!s || /[\\\u0000-\u001f\u007f\s]/.test(s)) throw new MidError("instance_url")
  let u: URL
  try { u = new URL(s) } catch { throw new MidError("instance_url") }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) throw new MidError("instance_url")
  if (u.pathname !== "/") throw new MidError("instance_url")
  const host = u.hostname.toLowerCase()
  if (!HOST_RE.test(host)) throw new MidError("instance_url")
  return `https://${host}/`
}
