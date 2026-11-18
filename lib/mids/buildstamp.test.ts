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
  it("accepts hotfix and base forms", () => {
    const hot = "xanadu-07-02-2024__patch5-hotfix1-10-15-2024_10-23-2024_2141"
    const hot2 = "vancouver-06-23-2023__patch10-hotfix2a-08-01-2023_08-09-2023_1200"
    const base = "xanadu-07-02-2024_07-10-2024_1234"
    expect(buildstampFromGlideWar(`glide-${hot}.zip`)).toBe(hot)
    expect(packageUrl(hot)).toContain("/mid/2024/10/23/mid.")
    expect(packageUrl(hot2)).toContain("/mid/2023/08/09/mid.")
    expect(packageUrl(base)).toContain("/mid/2024/07/10/mid.")
  })
  it("rejects out-of-range month/day in the build date", () => {
    for (const bad of [
      "australia-02-11-2026__patch7w42-10-08-2026_13-13-2026_1248",
      "australia-02-11-2026__patch7w42-10-08-2026_00-13-2026_1248",
      "australia-02-11-2026__patch7w42-10-08-2026_10-32-2026_1248",
      "australia-02-11-2026__patch7w42-10-08-2026_10-00-2026_1248",
    ]) {
      expect(() => packageUrl(bad)).toThrowError(expect.objectContaining({ code: "invalid_buildstamp" }))
    }
  })
  it("still rejects injection attempts", () => {
    for (const bad of ["../x", `${BS}/../../y`, `${BS}?x=1`, `${BS}\n`, `${BS}__patch1-hotfix-/x`, "a-01-01-2024_01-01-2024_1234/.."]) {
      expect(() => packageUrl(bad)).toThrowError(expect.objectContaining({ code: "invalid_buildstamp" }))
    }
  })
})
