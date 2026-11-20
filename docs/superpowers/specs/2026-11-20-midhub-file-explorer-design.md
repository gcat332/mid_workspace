# MidHub Files tab: Explorer-style drag, multi-select and zip download

Date: 2026-11-20 · Status: approved by the user (layout option ก.; move/multi-select desktop-only, option ก.)

## Intent

The user wants the Files tab of a MID to work like the file explorer people already know from Windows, so that the
people who look after MID Servers can do their daily file work without friction. The bar is "usable and convenient for
real end users", not feature completeness. The user explicitly cut an emulated Linux terminal from scope to keep it lean.

Typical real-world work this serves (assumed from the MID Server domain, not stated by the user):

- dropping JDBC drivers / custom JARs into `agent/extlib`;
- collecting several log files (`agent/logs`) to hand to ServiceNow support;
- tidying files: moving, renaming, deleting several at once;
- editing small properties/conf files (already works).

## What exists today (do not rebuild)

- `components/FilesTab.tsx` + `components/files/FileTree.tsx`: a single lazily loaded tree (name, size, mtime per
  row), breadcrumb "upload target", toolbar (Upload, New File, New Folder, Refresh), per-row "⋯"/right-click menu
  (`FileContextMenu`: Open, Download, Rename, Delete), Monaco editor modal for text files ≤ 2 MB.
- Drag **from the desktop into** the tree already uploads (onto a folder row, or anywhere on the card → current
  target). One file at a time, ≤ 50 MB each, overwrite confirm.
- Server: `lib/mids/files.ts` does every operation through fd-anchored `safe-fs` handles with these rules, which every
  new operation must keep:
  - never leave the MID root; symlinks are never followed for writes;
  - program dirs (`agent/bin`, `agent/lib`, `agent/jre`) are read-only;
  - `config.xml` is never served (secret) and, with `wrapper-override.conf`, never written here (Configuration tab);
  - an entry that *contains* a program dir or config file (or is the root) cannot be renamed/deleted (`locked`).
- Writes go through `assertSettled` (no lifecycle job running) and are audited with `recordAudit`. Reads/downloads are
  not audited.

## Goals

1. **Drag to move** files and folders onto another folder inside the tree.
2. **Drag out to download**: drag a row from the tree onto the desktop / a file manager window to save it.
3. **Multi-select** with Ctrl/Cmd+click and Shift+click, with bulk **Delete** and bulk **Download (.zip)**.
4. **Download a folder, or a multi-selection, as one .zip**.
5. **Keyboard shortcuts**: Del, F2, Enter, Ctrl/Cmd+A, Esc.
6. **Protect system / configuration files and folders** from move, rename and delete (section 3a).

## Non-goals

- Emulated or real terminal (cut by the user).
- Copy / paste (Ctrl+C/V/X), duplicate, cross-MID operations.
- Two-pane Windows layout (user picked the single tree, option ก.).
- Searching inside files (the Log tab already searches logs).
- Larger or parallel uploads; the 50 MB / one-at-a-time rule stays.
- Moving files and multi-select on touch devices: both are desktop-only (mouse + keyboard). No "Move to…" folder
  picker. *(user picked this: MID admins work on desktops.)*
- Changes to the AgentHub agent API (`app/api/agent/mids/[name]/files`).

## Anti-goals (would be a failure even if it "works")

- Any new path that bypasses the safety rules above, e.g. a move that lands a file in `agent/lib`, a zip that contains
  `config.xml`, or anything that follows a symlink out of the MID.
- A drag that silently does something destructive: a drop must never overwrite without asking.
- Breaking what users already do: a single click on a file still opens it; a single click on a folder still
  expands it and makes it the upload target; drag-from-desktop upload still works everywhere it does today.
- Making the phone experience worse than today. Touch users keep the "⋯" menu for every action that exists today
  (Open, Download, Rename, Delete) plus the new "Download .zip" on folders.

## Approaches considered

- **ก. Keep the single tree, add the behaviours (picked by the user).** Least change, existing tests mostly hold,
  works on narrow screens.
- ข. Two-pane Windows layout (folder tree left, sortable file list right). Most familiar to Windows users, but means
  rewriting most of `FilesTab` and is poor on narrow screens.
- Terminal-centred variants were dropped with the terminal.

## Design

### 1. Selection model

- Selection is a set of paths that are **siblings (same parent folder)**, like a selection inside one Explorer
  window. *(my call: cross-folder selections make bulk move/zip ambiguous and a tree makes them hard to see.)*
- Plain click: unchanged behaviour (file → open editor; folder → expand/collapse + set upload target). It also makes
  the selection just that row.
- Ctrl/Cmd+click: toggle the row in the selection, without opening or expanding. Clicking a row in another folder
  starts a new selection there.
- Shift+click: select the range between the last-clicked row and this one, among the visible siblings of that folder.
- Selected rows get a clear highlight (distinct from the existing "open file / target" highlight if both can show).
- When **2 or more** rows are selected, a selection bar appears at the bottom of the card:
  `เลือก N รายการ  [Download .zip]  [Delete]  [✕ Clear]`. Delete is disabled if any selected entry is `locked`, or a
  job is running (`busyReason`), with the reason in the button's title / sr text as other disabled buttons do.
  *(my call: Thai sentence, English button labels, per the 2026-11-19 label standard.)*
- Esc clears the selection. Selection is cleared on refresh of that folder or when its entries disappear.

### 2. Keyboard shortcuts

Active when focus is inside the tree (not in dialogs or the editor):

| Key | Action |
|---|---|
| Del / Delete (macOS: also Cmd+Backspace) | Delete the selection (same confirm dialog as today, with a count for >1) |
| F2 | Rename, when exactly one unlocked row is selected |
| Enter | Same as plain click on the focused row |
| Ctrl/Cmd+A | Select all siblings of the focused row |
| Esc | Clear selection |

Up/Down arrow navigation between rows is left to the builder (nice to have, not required).

### 3. Drag to move (inside the tree)

- Any row that is not `locked`, not a `symlink`, and not `secret` can be dragged to move. *(my call: moving a
  relative symlink silently changes what it points to; symlinks stay rename/delete-only. Symlink rows can still be
  dragged **out** for download if they are files.)* Symlinked folders are not move drop targets. Dragging a selected row
  drags the whole selection; dragging an unselected row drags just that row (and selects it).
- Valid drop targets: folder rows and the breadcrumb segments (incl. the MID root). Dropping on the card background
  does nothing for a move (it stays the upload target for desktop files only).
- A target is refused (no highlight, `dropEffect = "none"`) when: it is read-only (`roDirs`), it is the item's current
  parent, it is the item itself or inside a dragged folder, or a job is running.
- Internal drags are told apart from desktop file drags by a custom MIME type (e.g. `application/x-midhub-paths`);
  the existing `hasFiles` upload handlers ignore internal drags and vice versa.
- Items move one request at a time, in order. On a name clash the user gets a confirm per item:
  - file over file: "Replace?" → retry with `overwrite: true`; "Skip" moves on;
  - anything involving a folder: refused with a clear message (no merging folders).
  - The confirm offers "Apply to all" for the rest of this drop. *(my call)*
- After the drop, both the source and target folders reload; the selection is cleared; the open editor, if it showed a
  moved file, is closed with a note (or re-pointed; builder's call).
- An error on one item stops the rest and shows which item failed and how many moved.

**Server: new `move` op.** `POST /api/mids/:name/files` JSON `{ op: "move", path, to, overwrite? }` → `{ to }`.

- `path`: entry to move; `to`: destination folder (relative, "" = root). Keeps the base name.
- Same checks as `rename` on the source (`assertWritable`, `assertNotContainer`), plus `assertWritable` on the
  destination folder and the destination path, plus: destination is a directory; destination is not the source or
  inside it; source parent ≠ destination; the source is not a symlink (lstat) and the destination folder is not
  reached through a symlink (refused with a clear error, tested).
- Implementation: open both parent dirs as verified handles, then `rename(fdPath(srcDir, base), fdPath(dstDir, base))`
  (cross-dir version of `renameIn`). Checks on the real paths as everywhere else.
- Clash: if the destination name exists → `409 exists` unless `overwrite` is true **and** both source and destination
  are regular files (lstat; never a symlink or dir) → atomic replace by the rename itself.
- `EXDEV` (different filesystem) → a clear Thai error; no copy fallback.
- `assertSettled` first; audit `file.move` with `{ path, to }`. The Audit log page must render the new action.
- Unit tests in `lib/mids/files.test.ts` style for every refusal above plus the happy paths.

### 3a. Protected system / configuration paths (user request)

The user asked that system and configuration files cannot be moved. They picked option ก.: the protection covers
**move, rename and delete** alike (renaming `wrapper.conf` or deleting `agent/security` breaks a MID just as moving
it does). Viewing, editing contents, downloading and uploading stay exactly as today.

Enforced on the server in `lib/mids/files.ts` (so it also applies to the AgentHub agent API, which calls the same
functions), and surfaced as `locked: true` on the entries so the existing UI hides Rename/Delete and drag-to-move
refuses them. The list is a constant next to `PROGRAM_DIRS` / `CONFIG_XML` in `lib/mids/layout.ts`.

**Level 1 – the folder and everything inside it** (no move out, no move in, no rename, no delete of the folder or of
anything under it):

- `agent/conf` (wrapper config, incl. `wrapper.conf`)
- `agent/properties` (`glide.properties`)
- `agent/security` (keystore, certificates)
- `agent/etc`, `agent/package`, `agent/midinstaller` (shipped with the installer)
- the shell scripts directly in `agent/` (e.g. `start.sh`, `stop.sh`; exact names verified against a real Linux MID
  package during implementation: this host has no installed MID and the package dir is not readable from a dev
  session)

**Level 2 – the folder itself only** (cannot be moved, renamed or deleted; the files inside are free to move, rename,
delete, and to receive moved files):

- `agent/logs` (MID and the Log tab rely on it)
- `agent/extlib`
- `agent/work`, `agent/scripts`, `agent/tools` (created and synced by the MID)

Rules that follow:

- Existing ones stay: program dirs, `config.xml`, `wrapper-override.conf`, the MID root, and any folder containing a
  protected path (e.g. `agent`) remain locked.
- `move` refuses a destination inside a level-1 folder (403, Thai message naming the folder and why). Level-2 folders
  are fine as destinations.
- Errors reuse the `read_only` style: a Thai sentence saying this is a MID system/config file that must stay in place,
  and that its contents can still be edited / downloaded.
- Server checks resolve both lexically and through symlinks, as `ctxFor` already does for program dirs.
- Tests: rename, delete and move refused for each level-1 example (folder and a file inside), each level-2 folder
  itself; allowed for a file inside a level-2 folder; `listDir` reports `locked` accordingly. Existing tests that
  rename/delete inside these folders are updated.

### 4. Drag out to download

- On `dragstart` of a row the client also sets
  `dataTransfer.setData("DownloadURL", "application/octet-stream:<filename>:<absolute URL>")`.
  - single file → the existing `/files/download?path=…` URL, filename = its name;
  - folder → the new zip URL for that folder, filename `<folder>.zip`;
  - multi-selection → the zip URL for the selection, filename `<parent-folder or midName>.zip`.
- `secret` rows (config.xml) get no DownloadURL (they still can't be downloaded at all).
- This works in Chrome and Edge only. Other browsers simply don't save anything on a desktop drop; the "⋯" menu and
  selection bar stay the reliable path. The footer hint says so in one short line.
- Authentication relies on the browser sending the session cookie for the same-origin URL (verify in Chrome during
  implementation; if it does not, fall back to only the menu path and say so).

### 5. Zip download

**Endpoint:** `GET /api/mids/:name/files/zip?dir=<folder>&name=<a>&name=<b>…`

- `dir` is the folder; `name` (repeatable) picks entries inside it. No `name` → the whole folder.
- Response streams `application/zip` with `Content-Disposition` like `downloadResponse`. A GET so it works as a plain
  link and as a drag-out URL.
- Contents: regular files and folders, walked fd-by-fd from verified handles (as `removeIn` does), paths inside the
  zip relative to `dir`.
  - **Skipped:** symlinks (never followed), `config.xml`, non-regular files, `.midhub-upload-*.part` temp files.
    *(my call: skip silently rather than fail, so "download agent/" just works; the UI tooltip says config.xml is not
    included.)*
  - Program dirs are readable today, so they are included if selected.
- **Limits** *(my call)*: total uncompressed ≤ 1 GiB and ≤ 10 000 files, checked by a pre-walk **before** any bytes
  are sent, so an over-limit request gets a normal JSON error (413 `too_large` with a Thai message suggesting a
  smaller folder). Each file is sent up to the size it had in the pre-walk (growing logs don't break the archive).
- At most 2 zip streams at once across the app (`429 busy`, Thai message), mirroring the upload guard; the 1 GB
  `MemoryMax` must never be at risk (stream, never buffer a whole file).
- **Format:** in-house minimal streaming ZIP writer: local headers with data descriptors, DEFLATE via
  `zlib.createDeflateRaw`, CRC via `zlib.crc32` (Node 22), UTF-8 name flag, central directory at the end. No ZIP64
  (the 1 GiB cap keeps every size/offset < 4 GiB). *(my call: the project avoids new dependencies; Node 22 has
  everything needed.)* Must open with Windows Explorer's built-in zip, macOS Archive Utility and `unzip -t`.
- Not audited (downloads aren't today).

**Client entry points:** "Download .zip" on folder rows in the "⋯" menu, the selection bar, and drag-out of a folder or
selection.

**Showing errors** *(my call)*: the same URL with `&check=1` runs only the pre-walk and the busy check and returns JSON
`{ files, bytes }` or the normal error. The menu item and selection bar call it first, show any error with
`ErrorNotice` (Thai message), and only then navigate to the real URL (a hidden link / `location`), so the browser
streams to disk and nothing is buffered in page memory. Drag-out cannot pre-check; there a refused zip shows as
Chrome's own "Failed" download, which is acceptable because the menu path explains it.

### 6. Copy changes

- Footer hint becomes one line, e.g.: `ลากไฟล์จากเครื่องมาวางเพื่ออัปโหลด (≤ 50 MB) · ลากไปวางบนโฟลเดอร์เพื่อย้าย ·
  ลากออกไปวางบน Desktop เพื่อดาวน์โหลด (Chrome/Edge)`. Exact wording is the builder's, kept short.
- New Thai error/confirm sentences follow the existing tone: what happened + what to do.

## Constraints

- Next.js 16 app router, React 19, Tailwind 4, Vitest + Testing Library; follow existing patterns and test style.
- Prod: `next start` on 127.0.0.1 behind Caddy, systemd `MemoryMax=1G`, `ProtectSystem=strict`.
- Every write op: `assertSettled`, fd-anchored safe-fs, audit. Every new path: unit tests for refusals.
- Dark mode and the 2026-11-19 label standard (English chrome, Thai sentences).

## Left to the builder

- Component split (e.g. a `useSelection` hook, `SelectionBar` component) and where drag state lives.
- Exact highlight styles, arrow-key navigation, whether the editor follows a moved file.
- Zip writer internals and how its output is verified in tests.
