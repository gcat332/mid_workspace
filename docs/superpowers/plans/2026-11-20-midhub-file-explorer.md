# MidHub Files Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explorer-style Files tab: protected system/config paths, drag to move, drag out to download, multi-select
with bulk delete / zip download, and keyboard shortcuts.

**Architecture:** Server rules stay in `lib/mids/files.ts` (fd-anchored safe-fs, one place for both the browser API and
the AgentHub API). A new `move` op joins the existing JSON POST ops; zip is a separate GET route backed by a small
in-house streaming ZIP writer. Client logic that can be pure (selection, drop rules, URLs) lives in `lib/ui/*` with unit
tests; `FilesTab` wires it to the tree.

**Tech Stack:** Next.js 16 app router, React 19, Tailwind 4, Node 22 (`zlib.crc32`, `zlib.createDeflateRaw`), Vitest +
Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-11-20-midhub-file-explorer-design.md`

## Global Constraints

- Every write: `assertSettled` (route), fd-anchored safe-fs, `recordAudit`. Reads/downloads are not audited.
- Never follow a symlink for a write or for zip content; never serve `config.xml`; program dirs stay read-only.
- No new npm dependency.
- Labels: short UI chrome in English Title Case (Download .zip, Delete, Clear, Replace, Skip); sentences and every
  error in Thai ("what happened + what to do").
- Upload rules unchanged: 50 MB per file, one at a time.
- Zip: total uncompressed ≤ 1 GiB (`1024 ** 3`), ≤ 10 000 files, ≤ 2 concurrent zip streams; no ZIP64.
- Move and multi-select are desktop-only; touch users keep the "⋯" menu (Open, Download, Rename, Delete, Download .zip).
- Plain click behaviour unchanged (file → editor, folder → expand + upload target).
- Dark mode for every new UI element (existing `dark:` class pattern).
- Commands: `npx vitest run <file>`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.

## Review Focus

1. **A log file growing while it is zipped** (`agent0.log.0`): the zip must stay valid and hold at most the planned
   size → Task 3/4 tests.
2. **Moving a file onto a folder that already holds a folder of that name, or a folder onto a file name**: clear
   refusal, nothing changed → Task 2 test.
3. **Dragging the open file in the editor somewhere else**: the editor closes with a note instead of saving to the old
   path → Task 7 test.
4. **Bulk delete where item 2 of 3 fails** (e.g. protected): stops, says how many were deleted and which failed, reloads
   → Task 6 test.
5. **Thai / spaces in names inside the zip and in Content-Disposition**: names open correctly in Windows Explorer
   (UTF-8 flag) → Task 3 test with `unzip -l`, Task 4 header test.

---

### Task 1: Protected system / configuration paths

**Files:**
- Modify: `lib/mids/layout.ts` (constants), `lib/mids/names.ts` (`ERRORS.protected`), `lib/mids/files.ts` (`Ctx`,
  `ctxFor`, `listDir`, `rename`, `remove`)
- Test: `lib/mids/files.test.ts`

**Interfaces:**
- Produces (layout.ts):
  - `PROTECTED_TREES = ["agent/conf", "agent/properties", "agent/security", "agent/etc", "agent/package", "agent/midinstaller"] as const`
  - `PROTECTED_DIRS = ["agent/logs", "agent/extlib", "agent/work", "agent/scripts", "agent/tools"] as const`
  - `PROTECTED_SCRIPT_DIR = "agent"` (every `*.sh` directly inside it is level 1)
- Produces (files.ts, module-private but used by Task 2/4): `isProtected(c: Ctx, abs: string): boolean`,
  `inProtectedTree(c: Ctx, abs: string): boolean`, `protErr(msg?: string): MidError`.
- Produces (names.ts): code `protected` → `[403, "ไฟล์/โฟลเดอร์นี้เป็นไฟล์ระบบหรือไฟล์ตั้งค่าของ MID ต้องอยู่ที่เดิม จึงย้าย เปลี่ยนชื่อ หรือลบไม่ได้ (ยังเปิดดู แก้ไขเนื้อหา และดาวน์โหลดได้ตามปกติ)"]`.

- [ ] **Step 1: Write the failing tests** (new `describe("protected system/config paths")`; extend `beforeEach` dirs
  with `agent/properties`, `agent/security`, `agent/logs`, and files `agent/properties/glide.properties`,
  `agent/security/agent_keystore`, `agent/logs/agent0.log.0`, `agent/start.sh`, `agent/conf/wrapper.conf`)

```ts
it("level 1: the folder and everything inside cannot be renamed or deleted", async () => {
  for (const p of ["agent/properties", "agent/properties/glide.properties", "agent/security/agent_keystore", "agent/conf/wrapper.conf", "agent/start.sh"]) {
    await rejects(rename("m1", p, "x"), "protected", 403)
    await rejects(remove("m1", p), "protected", 403)
  }
  expect(fs.existsSync(path.join(m, "agent/security/agent_keystore"))).toBe(true)
})
it("level 2: the folder itself is locked, its files are free", async () => {
  for (const p of ["agent/logs", "agent/extlib"]) {
    await rejects(rename("m1", p, "x"), "protected", 403)
    await rejects(remove("m1", p), "protected", 403)
  }
  expect(await rename("m1", "agent/logs/agent0.log.0", "old.log")).toEqual({ to: "agent/logs/old.log" })
  await remove("m1", "agent/logs/old.log")
})
it("renaming onto a protected name is refused", async () => {
  fs.mkdirSync(path.join(m, "agent/tmpdir"))
  await rejects(rename("m1", "agent/tmpdir", "scripts"), "protected", 403)
})
it("a symlink inside a level-1 folder cannot be removed either", async () => {
  fs.symlinkSync(path.join(m, "work/note.txt"), path.join(m, "agent/security/lnk"))
  await rejects(remove("m1", "agent/security/lnk"), "protected", 403)
})
it("listDir reports locked for protected entries, not for files in level-2 folders", async () => {
  const a = await listDir("m1", "agent")
  for (const n of ["properties", "security", "logs", "extlib", "start.sh"]) expect(a.find((e) => e.name === n)?.locked).toBe(true)
  expect((await listDir("m1", "agent/properties"))[0]).toMatchObject({ locked: true, readOnly: false })
  expect((await listDir("m1", "agent/logs"))[0].locked).toBe(false)
})
it("editing, uploading and creating inside protected folders still work", async () => {
  const r = await readText("m1", "agent/properties/glide.properties")
  await writeText("m1", "agent/properties/glide.properties", "x=1\n", r.hash)
  await upload("m1", "agent/security", "ca.pem", Buffer.from("x"))
  await mkdir("m1", "agent/logs", "sub")
})
it("a symlinked agent dir cannot dodge protection", async () => {
  fs.renameSync(path.join(m, "agent"), path.join(m, "work/realagent"))
  fs.symlinkSync(path.join(m, "work/realagent"), path.join(m, "agent"))
  await rejects(remove("m1", "work/realagent/security"), "protected", 403)
})
```

  Existing tests keep their codes: checks run in the order `assertWritable` → `assertNotContainer` → protected, so
  `rename agent/conf` stays `use_config_tab`, `remove agent/bin/mid.sh` stays `read_only`,
  `rename agent/extlib → jre` stays `read_only`. One existing assertion changes on purpose: in
  `"listing flags: locked/symlink/secret"`, `extlib` is now `locked: true` (level 2).

- [ ] **Step 2: Run** `npx vitest run lib/mids/files.test.ts` — Expected: the new tests FAIL (`protected` not thrown /
  `locked` false); existing tests PASS.

- [ ] **Step 3: Implement.** In `ctxFor` resolve every `PROTECTED_TREES` / `PROTECTED_DIRS` entry and the `agent` dir
  both lexically and through symlinks, exactly as `roDirs` is built, into `protTrees`, `protDirs`, `scriptDirs`.
  `isProtected(c, abs)` = inside any `protTrees` (incl. equal) ∨ equal to any `protDirs` ∨ (`path.dirname(abs)` ∈
  `scriptDirs` ∧ `abs.endsWith(".sh")`). `isContainer` also returns true when `abs` contains a `protTrees`/`protDirs`
  entry. `rename`: after the existing checks, `if (isProtected(c, e.abs) || isProtected(c, path.join(e.parent, newName))) throw protErr()`.
  `remove`: check `isProtected(c, e.abs)` before the symlink branch. `listDir`: `locked = (!symlink && (readOnly || isContainer(c, abs))) || isProtected(c, abs)`.

- [ ] **Step 4: Run** `npx vitest run lib/mids/files.test.ts app/api` — Expected: all PASS.

- [ ] **Step 5: Verify level-1 script names against a real Linux MID package** if one is reachable (an installed MID
  under `/opt/midhub/mids/*/agent` or a package zip in `/opt/midhub/packages`, read with appropriate rights): list
  `agent/` top level. If `etc`, `package` or `midinstaller` live somewhere other than `agent/`, fix the constants and
  note it in the spec. If none is reachable, leave the constants and record "not verified" in the final report.

- [ ] **Step 6: Commit** `feat(files): protect MID system and config paths from rename/delete`

---

### Task 2: Server `move` op

**Files:**
- Modify: `lib/mids/files.ts` (new `move`), `app/api/mids/[name]/files/route.ts` (POST op), `lib/ui/audit-format.ts`
  (`"file.move": "Move File"`)
- Test: `lib/mids/files.test.ts`, `app/api/mids/[name]/files/route.test.ts`, `lib/ui/audit-format.test.ts` (if it
  enumerates labels)

**Interfaces:**
- Consumes: Task 1 `isProtected`, `inProtectedTree`, `protErr`.
- Produces: `move(name: string, rel: string, toDir: string, overwrite?: boolean): Promise<{ to: string }>`;
  HTTP `POST /api/mids/:name/files` `{ op: "move", path: string, to: string, overwrite?: boolean }` → `{ to }`;
  audit `file.move` `{ path, to }`.
- Error contract the client relies on (Task 7):
  - `409 exists` — **only** a file-over-file clash with `overwrite` false (client asks Replace/Skip). Thai:
    `มีไฟล์ชื่อนี้อยู่ในโฟลเดอร์ปลายทางแล้ว เลือกแทนที่หรือข้าม`.
  - `409 conflict` — clash involving a folder. Thai: `ปลายทางมีโฟลเดอร์หรือไฟล์ชื่อเดียวกันอยู่แล้ว ระบบไม่รวมโฟลเดอร์ให้ เปลี่ยนชื่อก่อนแล้วลองย้ายใหม่`.
  - `409 conflict` — source is a symlink. Thai: `symlink ย้ายไม่ได้ (ลิงก์จะชี้ผิดที่) ให้สร้างลิงก์ใหม่ที่ปลายทางแทน`.
  - `403 protected` — source protected (default message) or destination inside a level-1 folder. Thai for the latter:
    `ย้ายไฟล์เข้าโฟลเดอร์ระบบ/ตั้งค่าของ MID (เช่น agent/conf, agent/security) ไม่ได้`.
  - `400 invalid_request` — destination is the current parent (`ไฟล์อยู่ในโฟลเดอร์นี้อยู่แล้ว`), or inside the source
    (`ย้ายโฟลเดอร์เข้าไปในตัวเองไม่ได้`), or not a directory; destination reached through a symlink
    (`โฟลเดอร์ปลายทางเป็น symlink ย้ายเข้าไม่ได้ เลือกโฟลเดอร์จริงแทน`).
  - `EXDEV` → `409 conflict` `ย้ายข้ามดิสก์ไม่ได้ ให้ดาวน์โหลดแล้วอัปโหลดที่ปลายทางแทน`.

- [ ] **Step 1: Write failing tests** in `describe("move")`:

```ts
it("moves a file and a folder into another folder", async () => {
  fs.mkdirSync(path.join(m, "work/d")); fs.writeFileSync(path.join(m, "work/d/f"), "1")
  expect(await move("m1", "work/note.txt", "agent/extlib")).toEqual({ to: "agent/extlib/note.txt" })
  expect(await move("m1", "work/d", "agent/logs")).toEqual({ to: "agent/logs/d" })
  expect(fs.readFileSync(path.join(m, "agent/logs/d/f"), "utf8")).toBe("1")
})
it("file over file: exists without overwrite, atomic replace with it", async () => {
  fs.writeFileSync(path.join(m, "agent/extlib/note.txt"), "old")
  await rejects(move("m1", "work/note.txt", "agent/extlib"), "exists", 409)
  expect(fs.existsSync(path.join(m, "work/note.txt"))).toBe(true)
  await move("m1", "work/note.txt", "agent/extlib", true)
  expect(fs.readFileSync(path.join(m, "agent/extlib/note.txt"), "utf8")).toBe("hello")
})
it("a clash involving a folder is conflict even with overwrite; nothing changes", async () => {
  fs.mkdirSync(path.join(m, "agent/extlib/note.txt"))
  await rejects(move("m1", "work/note.txt", "agent/extlib", true), "conflict", 409)
  fs.mkdirSync(path.join(m, "work/x")); fs.writeFileSync(path.join(m, "agent/extlib/x"), "")
  await rejects(move("m1", "work/x", "agent/extlib", true), "conflict", 409)
  expect(fs.statSync(path.join(m, "work/x")).isDirectory()).toBe(true)
})
it("refuses protected sources, level-1 destinations, program dirs, config files", async () => {
  await rejects(move("m1", "agent/properties/glide.properties", "work"), "protected", 403)
  await rejects(move("m1", "agent/logs", "work"), "protected", 403)
  await rejects(move("m1", "work/note.txt", "agent/conf"), "protected", 403)
  await rejects(move("m1", "work/note.txt", "agent/bin"), "read_only", 403)
  await rejects(move("m1", "agent/config.xml", "work"), "use_config_tab", 403)
})
it("refuses same parent, into itself, non-dir destination, symlink source, symlinked destination", async () => {
  fs.mkdirSync(path.join(m, "work/d/e"), { recursive: true })
  await rejects(move("m1", "work/note.txt", "work"), "invalid_request", 400)
  await rejects(move("m1", "work/d", "work/d/e"), "invalid_request", 400)
  await rejects(move("m1", "work/d", "work/note.txt"), "invalid_request", 400)
  fs.symlinkSync(path.join(m, "work/note.txt"), path.join(m, "work/lnk"))
  await rejects(move("m1", "work/lnk", "agent/extlib"), "conflict", 409)
  fs.symlinkSync(path.join(m, "agent/extlib"), path.join(m, "work/extlink"))
  await rejects(move("m1", "work/d", "work/extlink"), "invalid_request", 400)
})
```

  Route test (`route.test.ts`, existing mocking style with `move` mocked):
  `POST {op:"move", path:"work/a", to:"agent/extlib"}` → 200 `{ to }` and
  `audit` called with `"file.move", "m1", { path: "work/a", to: "agent/extlib/a" }`; `overwrite` passed through as
  boolean (`true` only when the body has `overwrite: true`); non-string `to` → 400.

- [ ] **Step 2: Run** `npx vitest run lib/mids/files.test.ts "app/api/mids/[name]/files/route.test.ts"` — Expected:
  FAIL (`move` is not exported).

- [ ] **Step 3: Implement `move`** in `lib/mids/files.ts` inside `mapped(...)`, in this order: `ctxFor`; `entryOf(c, rel)`;
  source checks `assertWritable` → `assertNotContainer` → `isProtected`; `toDir` = `resolveMidPath(name, toDir)` and
  refuse when it differs from `path.join(c.root, cleanRel)` (destination reached through a symlink); `statDirOf`;
  `assertWritable(c, dest)`; `inProtectedTree(c, dest)` → protErr(move-in msg); same parent / inside source;
  `destAbs` checks `assertWritable` + `isProtected`; `beforeIo()`; open both dirs with `openDir(..., writeCheck(c))`;
  `lstatIn` source (missing → `not_found`, symlink → conflict); `lstatIn` destination for the clash rules above;
  `fs.promises.rename(fdPath(srcD, base), fdPath(dstD, base))`, mapping `EXDEV` before `mapFsErrors` sees it; close
  both handles in `finally`. Return `{ to: path.relative(c.root, destAbs) }`.
  Route: add the `op === "move"` branch next to `rename`; audit `{ path: <cleaned path>, to: r.to }`. Update the
  route's header comment.

- [ ] **Step 4: Run** the same command — Expected: PASS. Also run `npx vitest run lib/ui/audit-format.test.ts`.

- [ ] **Step 5: Commit** `feat(files): move op with clash, protection and symlink rules`

---

### Task 3: Streaming ZIP writer

**Files:**
- Create: `lib/zip/writer.ts`
- Test: `lib/zip/writer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ZipSource = { name: string; mtime: Date } & (
    | { dir: true }
    | { dir?: false; open: () => Promise<{ stream: AsyncIterable<Uint8Array>; close: () => Promise<void> } | null> }
  )
  /** Streams a valid ZIP of `sources` in order. `open` returning null skips that entry (vanished). */
  export function zipStream(sources: AsyncIterable<ZipSource> | Iterable<ZipSource>): ReadableStream<Uint8Array>
  ```
  `name` is a POSIX path inside the archive; directory names end with `/`.

- [ ] **Step 1: Write failing tests.** Write the stream to a temp file, then shell out (`execFileSync`, as
  `files.test.ts` already does):

```ts
it("produces an archive unzip -t accepts, with dirs, empty files and UTF-8 names", async () => {
  const zip = await toFile(zipStream([
    { name: "logs/", dir: true, mtime: new Date() },
    { name: "logs/agent0.log.0", mtime: new Date(), open: src("hello\n".repeat(10000)) },
    { name: "logs/ว่าง เปล่า.txt", mtime: new Date(), open: src("") },
  ]))
  expect(execFileSync("unzip", ["-t", zip]).toString()).toMatch(/No errors detected/)
  const list = execFileSync("unzip", ["-Z1", zip]).toString().split("\n")
  expect(list).toEqual(expect.arrayContaining(["logs/", "logs/agent0.log.0", "logs/ว่าง เปล่า.txt"]))
  expect(execFileSync("unzip", ["-p", zip, "logs/agent0.log.0"]).toString()).toBe("hello\n".repeat(10000))
})
it("a source that returns null is left out, the archive stays valid", async () => { /* open: async () => null */ })
it("an error in a source errors the stream (no silently truncated archive)", async () => { /* stream throws */ })
it("memory stays flat for a 200 MB source streamed in 64 KiB chunks", async () => { /* assert heapUsed delta < 64 MB */ })
```

  (`src(s)` returns an `open` that yields `Buffer.from(s)` in chunks; `toFile` pipes the web stream to a temp file.)

- [ ] **Step 2: Run** `npx vitest run lib/zip/writer.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `zipStream`.** Per entry: local file header (sig `0x04034b50`, version 20, flags
  `0x0808` = data descriptor + UTF-8, method 8 for files / 0 for dirs, DOS time/date from `mtime`, CRC/sizes 0), name
  bytes; for files pipe chunks through `zlib.createDeflateRaw()` while `crc = zlib.crc32(chunk, crc)` and counting raw
  bytes; then data descriptor (sig `0x08074b50`, crc, compressed, uncompressed). Track each entry's offset; at the end
  write central directory records (sig `0x02014b50`, version made by `0x031E` (Unix), external attrs `0o100644 << 16`
  for files / `(0o40755 << 16) | 0x10` for dirs) and EOCD (sig `0x06054b50`). Respect back-pressure (pull-based
  `ReadableStream`). No ZIP64: throw if any size/offset would exceed `0xFFFFFFFF` (callers cap at 1 GiB).

- [ ] **Step 4: Run** — Expected: PASS. Then by hand once: open a generated zip with a Thai filename in Windows
  Explorer or macOS Archive Utility if available; otherwise note "checked with unzip only".

- [ ] **Step 5: Commit** `feat(zip): in-house streaming ZIP writer (deflate, UTF-8, no deps)`

---

### Task 4: MID zip plan + `/files/zip` route

**Files:**
- Create: `lib/mids/zip.ts`, `app/api/mids/[name]/files/zip/route.ts`
- Test: `lib/mids/zip.test.ts` (same fixture style as `files.test.ts`), `app/api/mids/[name]/files/zip/route.test.ts`

**Interfaces:**
- Consumes: Task 3 `zipStream`; `files.ts` internals `ctxFor`, `readCheck`, `plainName`, `UPLOAD_TMP_RE` (export
  them from `files.ts` for this module; keep them out of the route).
- Produces:
  ```ts
  export const ZIP_MAX_BYTES = 1024 ** 3
  export const ZIP_MAX_FILES = 10_000
  export type ZipPlan = { files: number; bytes: number; filename: string; entries: { rel: string; zipName: string; dir: boolean; size: number; mtime: Date }[] }
  export function planZip(name: string, dir: string, names: string[]): Promise<ZipPlan>
  export function zipPlanStream(name: string, plan: ZipPlan): ReadableStream<Uint8Array>
  ```
  HTTP `GET /api/mids/:name/files/zip?dir=&name=…[&check=1]` → `application/zip` stream, or with `check=1`
  `{ files, bytes }`. Errors: `413 too_large` (`ไฟล์ที่เลือกรวมกันใหญ่เกิน 1 GB หรือเกิน 10,000 ไฟล์ เลือกโฟลเดอร์ย่อยหรือไฟล์น้อยลงแล้วลองใหม่`),
  `429 busy` (`มีการดาวน์โหลด .zip อยู่ 2 รายการแล้ว รอให้เสร็จแล้วลองใหม่`), `404 not_found` for a missing selected
  name, `400 invalid_filename` for a bad name.

- [ ] **Step 1: Write failing tests** (`lib/mids/zip.test.ts`):

```ts
it("whole folder: relative names, skips config.xml, symlinks, temp files", async () => {
  fs.symlinkSync("/etc", path.join(m, "agent/out")); fs.writeFileSync(path.join(m, "agent/.midhub-upload-0123456789abcdef.part"), "")
  const p = await planZip("m1", "agent", [])
  const names = p.entries.map((e) => e.zipName)
  expect(names).toContain("agent/conf/wrapper-override.conf")
  expect(names.some((n) => n.endsWith("config.xml") || n.includes("out") || n.includes(".part"))).toBe(false)
  expect(p.filename).toBe("agent.zip")
})
it("selection inside a folder; filename rules", async () => {
  expect((await planZip("m1", "work", ["note.txt"])).filename).toBe("note.txt.zip")
  expect((await planZip("m1", "agent", ["conf", "extlib"])).filename).toBe("agent.zip")
  expect((await planZip("m1", "", [])).filename).toBe("m1.zip")
  await rejects(planZip("m1", "work", ["nope"]), "not_found", 404)
  await rejects(planZip("m1", "work", ["../x"]), "invalid_filename", 400)
})
it("over 10 000 files or over 1 GiB is too_large before any byte", async () => { /* 10 001 empty files; and a sparse 1 GiB+1 file via fs.truncateSync */ })
it("a file growing after the plan is cut at the planned size; the archive is valid", async () => {
  const plan = await planZip("m1", "work", ["note.txt"])
  fs.appendFileSync(path.join(m, "work/note.txt"), "MORE")
  const zip = await toFile(zipPlanStream("m1", plan))
  expect(execFileSync("unzip", ["-p", zip, "note.txt"]).toString()).toBe("hello")
})
it("a file swapped for a symlink to outside after the plan is skipped (never followed)", async () => { /* … */ })
```

  Route tests: `check=1` → `{ files, bytes }` JSON; normal → `content-type: application/zip`,
  `Content-Disposition` uses `filename*=UTF-8''` (Thai folder name encoded) like `lib/http/download.ts`; third
  concurrent request while two streams are open → 429; the slot is released when a stream is cancelled
  (`res.body.cancel()`) and when it finishes.

- [ ] **Step 2: Run** `npx vitest run lib/mids/zip.test.ts "app/api/mids/[name]/files/zip"` — Expected: FAIL.

- [ ] **Step 3: Implement.** `planZip`: walk from `openDir(dir, readCheck(c))`, descending with `openDirIn` (dev/ino
  verified, one fd per level), `lstat` each child; skip per spec; accumulate and throw `too_large` as soon as a limit
  is crossed. `zipPlanStream`: map plan entries to `ZipSource`s whose `open` re-resolves with `resolveMidPath` and
  `openFile(abs, "r", readCheck(c))`, returns `null` on `not_found`/`path_outside`/`invalid_request`, and streams
  `createReadStream({ start: 0, end: size - 1 })` (nothing for size 0). Route: `requireUser`; parse `dir`,
  `searchParams.getAll("name")`; slot counter on `globalThis` (max 2) checked for both modes, held only by real
  streams, released in the stream's `finally`/`cancel`; headers as in `downloadResponse` with
  `Content-Type: application/zip` and no `Content-Length`.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat(files): download a folder or selection as .zip`

---

### Task 5: Client pure helpers (selection, drop rules, URLs)

**Files:**
- Create: `lib/ui/selection.ts`, `lib/ui/file-drag.ts`
- Modify: `lib/ui/file-tree.ts` (add `parentOf`, `siblingsOf`; `FilesTab` then imports `parentOf` from here)
- Test: `lib/ui/selection.test.ts`, `lib/ui/file-drag.test.ts`, `lib/ui/file-tree.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // file-tree.ts
  export const parentOf: (p: string) => string
  export function siblingsOf(state: TreeState, parent: string): string[] // display order (dirs first, then name)
  // selection.ts
  export type Selection = { parent: string; paths: string[]; anchor: string | null }
  export const EMPTY_SELECTION: Selection
  export function clickSelect(sel: Selection, path: string, mods: { toggle: boolean; range: boolean }, siblings: string[]): Selection
  export function selectAll(parent: string, siblings: string[]): Selection
  export function pruneSelection(sel: Selection, siblings: string[]): Selection // drop vanished paths
  // file-drag.ts
  export const INTERNAL_MIME = "application/x-midhub-paths"
  export function canMoveTo(paths: string[], target: string, info: { roDirs: Record<string, boolean>; entry: (p: string) => Entry | undefined; busy: boolean }): boolean
  export function zipUrl(base: string, dir: string, names: string[], check?: boolean): string // base = `/mids/<name>/files`
  export function zipFilename(midName: string, dir: string, names: string[]): string // same rules as planZip
  export function downloadUrlData(filename: string, absoluteUrl: string): string // "application/octet-stream:<filename>:<url>"
  ```

- [ ] **Step 1: Write failing tests** covering: plain click → `{paths:[p], anchor:p}`; toggle adds/removes within the
  same parent and starts over in another parent; range selects the sibling slice between anchor and target in display
  order (both directions); `selectAll`; `pruneSelection`. `canMoveTo` false for: target is a current parent of any
  path, target equals or is inside a dragged path, `roDirs[target]`, target entry `symlink`, target equal to or under
  any `PROTECTED_TREES` entry (import it from `lib/mids/layout.ts`, which has no Node imports, so it is safe in the
  client bundle; the server stays the authority for symlinked variants), any dragged entry `locked`/`symlink`/`secret`,
  `busy`; true for a plain folder such as `agent/extlib` or `work`. `zipUrl` encodes Thai names and repeats
  `name=`; `zipFilename` matches Task 4 cases.

- [ ] **Step 2: Run** `npx vitest run lib/ui` — Expected: FAIL.

- [ ] **Step 3: Implement** the functions above (no React).

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat(files-ui): selection, drop-rule and zip-url helpers`

---

### Task 6: Multi-select, keyboard shortcuts, selection bar, bulk delete, zip download

**Files:**
- Create: `components/files/SelectionBar.tsx`
- Modify: `components/files/FileTree.tsx` (props `selection: Set<string>`, row click passes modifiers, selected
  styling, `aria-selected`), `components/files/FileContextMenu.tsx` (`onZip` → "Download .zip" on folder rows,
  readable for every folder), `components/FilesTab.tsx`
- Test: `components/files/FilesTab.test.tsx`

**Interfaces:**
- Consumes: Task 5 helpers; Task 4 HTTP contract.
- Produces: `onRowClick(row: TreeRow, mods: { toggle: boolean; range: boolean })` (toggle = `ctrlKey || metaKey`,
  range = `shiftKey`); `SelectionBar` props `{ count: number; deleteDisabledReason: string | null; busy: boolean; onZip(): void; onDelete(): void; onClear(): void }`.

- [ ] **Step 1: Write failing tests** (existing harness; extend `apiFetch` mock for `/files/zip?…&check=1` and
  `DELETE`):
  - Ctrl+click two files in `agent/extlib` → no editor opens, bar shows `เลือก 2 รายการ`; Esc clears it.
  - Shift+click selects the range in display order; Ctrl+click in another folder starts a new selection.
  - Plain click on a file still opens the editor (regression).
  - Bar Delete → confirm `Delete 2 Items?` → two DELETE calls in order → folder reloaded.
  - Bulk delete where the second DELETE returns 403 `protected`: third not sent; error says `ลบแล้ว 1 จาก 3 รายการ` plus
    the server message.
  - Bar Delete disabled with a reason when any selected entry is `locked`, or `busyReason` is set.
  - Bar "Download .zip" → `check=1` request; on 413 shows the Thai message and does not navigate; on 200 navigates to
    the zip URL (spy on an injected `navigate` or `HTMLAnchorElement.prototype.click`).
  - Folder "⋯" menu shows "Download .zip"; file rows do not.
  - Keys with focus in the tree: Del opens the delete confirm for the selection; F2 opens Rename for one unlocked row
    (nothing for a locked row or ≥2 selected); Enter on a focused row = plain click; Ctrl+A selects the siblings of
    the focused row. Keys typed inside the name dialog or the editor do nothing to the tree.

- [ ] **Step 2: Run** `npx vitest run components/files/FilesTab.test.tsx` — Expected: new tests FAIL.

- [ ] **Step 3: Implement.** Selection state in `FilesTab` (`Selection`), pruned after each `load(dir)`. Keydown handler
  on the tree wrapper; focused row = `document.activeElement?.closest("[data-row]")`. Bulk delete reuses the existing
  confirm (title `Delete N Items?` when N > 1) and runs DELETEs sequentially, calling `forget` per success. Zip:
  `apiFetch(zipUrl(..., true))`, then navigate with a temporary `<a href={API_BASE + zipUrl(...)} download>` click.
  `SelectionBar` renders at the bottom of the card when `paths.length >= 2`, above the footer hint.

- [ ] **Step 4: Run** `npx vitest run components lib/ui` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(files-ui): multi-select, shortcuts, bulk delete and zip download`

---

### Task 7: Drag to move, drag out to download, footer hint

**Files:**
- Create: `components/files/MoveConflictDialog.tsx`
- Modify: `components/files/FileTree.tsx` (row `draggable`, `onDragStart`, move-drop handlers on folder rows),
  `components/FilesTab.tsx` (breadcrumb segments as move targets; move loop; editor closing; footer hint)
- Test: `components/files/FilesTab.test.tsx`

**Interfaces:**
- Consumes: Task 2 HTTP contract and error codes; Task 5 `INTERNAL_MIME`, `canMoveTo`, `downloadUrlData`, `zipUrl`,
  `zipFilename`.
- Produces: `MoveConflictDialog` props `{ name: string; onReplace(all: boolean): void; onSkip(all: boolean): void; onCancel(): void }`
  (title `Replace {name}?`, Thai body `ปลายทางมีไฟล์ชื่อนี้อยู่แล้ว ไฟล์เดิมจะถูกแทนที่ กู้คืนไม่ได้`, checkbox
  `ใช้กับไฟล์ที่ชื่อซ้ำทั้งหมดในการย้ายครั้งนี้`, buttons Replace / Skip / Cancel).

- [ ] **Step 1: Write failing tests** (simulate with `fireEvent.dragStart/dragOver/drop` and a fake `dataTransfer`
  object that records `setData`):
  - dragStart on a file sets `INTERNAL_MIME` with `["work/a"]` and `DownloadURL` =
    `application/octet-stream:a:http://localhost/midhub/api/mids/m1/files/download?path=work%2Fa`; on a folder the
    DownloadURL is the zip URL with `<folder>.zip`; on a selected row with 2 selected it carries both paths and the
    selection zip; `secret` rows set no DownloadURL; `locked`/`symlink` rows set no `INTERNAL_MIME` (download only).
  - dragOver a valid folder highlights it; over the current parent, a read-only dir, or a level-1 folder it does not
    (`dropEffect` "none").
  - drop → `POST {op:"move", path, to}` per item in order → source and target folders reloaded, selection cleared.
  - 409 `exists` → dialog; Replace resends with `overwrite: true`; Skip moves on; "Apply to all" answers the rest
    without asking again; Cancel stops the remaining items.
  - 409 `conflict` / 403 `protected` → stops, shows `ย้ายแล้ว N จาก M รายการ` + the server message.
  - Moving the file open in the editor closes the editor and shows `ไฟล์ที่เปิดอยู่ถูกย้ายไปที่ <to>`.
  - A desktop file drop on a folder still uploads (regression), and an internal drag dropped on the card background
    does nothing.
  - Footer hint text equals
    `ลากไฟล์จากเครื่องมาวางเพื่ออัปโหลด (สูงสุด 50 MB) · ลากไปวางบนโฟลเดอร์เพื่อย้าย · ลากออกไปวางบน Desktop เพื่อดาวน์โหลด (Chrome/Edge)`.

- [ ] **Step 2: Run** `npx vitest run components/files/FilesTab.test.tsx` — Expected: new tests FAIL.

- [ ] **Step 3: Implement.** Keep upload drop handlers keyed on `hasFiles(e)` and add move handlers keyed on
  `types.includes(INTERNAL_MIME)`; a row handles whichever kind is being dragged. Dragging an unselected row selects
  it first. `DownloadURL` needs an absolute URL: `new URL(API_BASE + path, window.location.href).href`. Move loop
  mirrors `uploadFiles` (sequential, `busy` set, `fail` once). Use `forget(path)` for moved paths and `load` for both
  folders.

- [ ] **Step 4: Run** `npx vitest run` (full suite), `npm run lint`, `npx tsc --noEmit` — Expected: all PASS, no lint
  errors.

- [ ] **Step 5: Commit** `feat(files-ui): drag to move, drag out to download`

---

### Task 8: End-to-end check in a real browser

**Files:** none (fix-ups only if something fails, each with a test first).

- [ ] **Step 1:** `npm run build` — Expected: success.
- [ ] **Step 2:** Run the app (`npm run dev` with a test `MIDHUB_ROOT` holding a fake MID tree like the unit fixture,
  or the project's `run` skill) and, in Chrome via chrome-devtools MCP:
  - drag a file and a folder onto another folder → moved, audit page shows "Move File";
  - drag a file from the tree onto the desktop / a folder → saved with the right name (confirms the session cookie is
    sent; if it is not, remove DownloadURL and update the footer hint + spec instead);
  - multi-select two logs → Download .zip → opens with `unzip -t`;
  - protected rows: no Rename/Delete in the menu, no drag-move, refused drop into `agent/conf`;
  - dark mode screenshot of the selection bar and the conflict dialog;
  - phone width (375 px): "⋯" menu still offers every action, nothing overflows.
- [ ] **Step 3:** Record results (and the Task 1 Step 5 package check) in the final report; commit any fix-ups.
