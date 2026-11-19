// Only in-app paths under /midhub. The value becomes a redirect Location after sign-in, so it must never become
// an open redirect: no protocol-relative (//), backslashes, control characters or dot-segments.
const NEXT_RE = /^\/midhub(\/.*)?$/

export function validLoginNext(v: string | null | undefined): string | null {
  if (!v || !NEXT_RE.test(v)) return null
  if (v.includes("//") || v.includes("\\") || v.includes("..") || /[\x00-\x1f\x7f]/.test(v)) return null
  return v
}
