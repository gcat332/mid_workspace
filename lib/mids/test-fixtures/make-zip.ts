// Test helper: builds zips with python3's zipfile so unsafe entries (../, absolute, symlink) can be produced.
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

export type ZipEntry = { name: string; data?: string; symlinkTo?: string; mode?: number }

const PY = `
import sys, json, zipfile
entries = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for e in entries:
        zi = zipfile.ZipInfo(e["name"], (2026, 1, 1, 0, 0, 0))
        zi.create_system = 3
        if "symlinkTo" in e:
            zi.external_attr = (0o120777 << 16)
            z.writestr(zi, e["symlinkTo"])
        else:
            zi.external_attr = (e.get("mode", 0o100644) << 16)
            z.writestr(zi, e.get("data", ""))
`

export async function makeZip(dest: string, entries: ZipEntry[]): Promise<void> {
  await run("/usr/bin/python3", ["-I", "-c", PY, dest, JSON.stringify(entries)])
}

export const VALID_ENTRIES: ZipEntry[] = [
  { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\n" },
  { name: "agent/bin/mid.sh", data: "#!/bin/sh\n", mode: 0o100755 },
  { name: "agent/config.xml", data: "<parameters/>" },
  { name: "agent/lib/a.jar", data: "x" },
]
