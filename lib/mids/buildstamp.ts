import { MidError } from "./names"

export const BUILDSTAMP_RE =
  /^[a-z]+-\d{2}-\d{2}-\d{4}__patch[0-9a-z]+-\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{4}_\d{4}$/

// glide.war value "glide-<buildstamp>.zip" -> buildstamp, or null when it does not look like one.
export function buildstampFromGlideWar(war: string): string | null {
  const m = /^glide-(.+)\.zip$/.exec(war.trim())
  return m && BUILDSTAMP_RE.test(m[1]) ? m[1] : null
}

// Recipe confirmed in the spike (docs/spike-mid-linux.md): the LAST date (MM-DD-YYYY) gives the path.
export function packageUrl(buildstamp: string): string {
  if (!BUILDSTAMP_RE.test(buildstamp)) throw new MidError("invalid_buildstamp")
  const m = /_(\d{2})-(\d{2})-(\d{4})_\d{4}$/.exec(buildstamp)!
  const [, mm, dd, yyyy] = m
  return `https://install.service-now.com/glide/distribution/builds/package/app-signed/mid/${yyyy}/${mm}/${dd}/mid.${buildstamp}.linux.x86-64.zip`
}
