import { describe, expect, it } from "vitest"
import { buildstampFromGlideWar, packageUrl } from "./buildstamp"

const BS = "australia-02-11-2026__patch7w42-10-08-2026_10-13-2026_1248"

describe("buildstamp", () => {
  it("extracts the buildstamp from glide.war", () => {
    expect(buildstampFromGlideWar(`glide-${BS}.zip`)).toBe(BS)
    expect(buildstampFromGlideWar(`  glide-${BS}.zip\n`)).toBe(BS)
  })
  it("returns null for non-matching input", () => {
    expect(buildstampFromGlideWar("foo.zip")).toBeNull()
    expect(buildstampFromGlideWar(`glide-${BS}`)).toBeNull()
    expect(buildstampFromGlideWar("glide-../x.zip")).toBeNull()
  })
  it("builds the package URL from the last date", () => {
    expect(packageUrl(BS)).toBe(
      `https://install.service-now.com/glide/distribution/builds/package/app-signed/mid/2026/10/13/mid.${BS}.linux.x86-64.zip`,
    )
  })
  it("rejects invalid buildstamps", () => {
    for (const bad of ["../x", "", `${BS}/..`, `${BS}x`, `X${BS}`]) {
      expect(() => packageUrl(bad)).toThrowError(expect.objectContaining({ code: "invalid_buildstamp" }))
    }
  })
})
