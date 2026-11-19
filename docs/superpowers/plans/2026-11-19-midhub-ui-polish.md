# MidHub UI polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MidHub looks like part of BSM AgentHub: identical header spacing, one English label standard, a dark
highlighted 150-line log view, and an AgentHub-style file browser with a full-screen editor.

**Architecture:** Client components only, plus one server change (the log stream's first batch is trimmed to 150
lines). New small pure modules carry the testable logic: `lib/ui/log-highlight.ts` (tokenizer) and
`lib/ui/file-tree.ts` (tree state). There are no new npm dependencies.

**Tech Stack:** Next.js 16 / React 19 / Tailwind v4, `@monaco-editor/react` (already used), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-19-midhub-ui-polish-design.md`

## Global Constraints

### Label standard

- Short UI chrome is in **English, Title Case**. This covers navigation, tabs, buttons, menu items, headings,
  table headers, field labels, status chips, placeholders and aria-labels of controls.
- **Sentences stay Thai.** This covers help text, confirmations' body text, hints and every error message (API
  messages are untouched).
- Glossary (use exactly):

  | Area | Labels |
  |---|---|
  | Top nav | Dashboard · Admin |
  | Admin nav | Users · Instances · IP Allowlist · Audit Log |
  | MID tabs | Overview · Configuration · Files · Logs |
  | MID actions | Start · Stop · Restart · Upgrade · Uninstall · Repair Permissions |
  | Generic | Save · Saving… · Saved · Cancel · Close · Confirm · Delete · Rename · Upload · Download · New File · New Folder · Refresh · Search · Loading… · Read-only · Unsaved changes · Retry |
  | Status chips | Running · Stopped · Starting · Failed · Unknown · Working · Install Failed · Uninstall Failed |
  | Overview fields | Service Status · MID Server Name · Instance Record · Version · Memory Usage · Last Job · View Progress · Open in ServiceNow |
  | AgentHub switch | AgentHub Access, with the Thai description kept underneath |
  | Logs | Agent Log · Wrapper Log · All Levels · Errors · Warnings and Above · Follow · Pause · Live · Connecting… · Paused · Log Not Found |
  | Create/import | New MID Server · Import MID Server, with wizard step titles in English |

### Look and limits

- **Full width (user request, added after approval):**
  - The dashboard and admin pages use the whole screen width, with no `max-w-6xl` / `mx-auto` on `<main>`.
  - Padding is `px-4 md:px-8 py-4`, so content lines up with the nav tabs.
  - The MID list column is `md:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]`.
  - On tall screens the log pane and the editor use viewport height (log `h-[max(32rem,calc(100svh-22rem))]`, editor modal already full screen).
  - Narrow forms (ConfigTab form, dialogs, the login card) keep their own max widths.
- Header must match AgentHub `components/AppChrome.tsx` (read-only reference at
  `/home/bsmagenthub/ai_workspace/components/AppChrome.tsx`) value for value, except that MidHub keeps the chrome
  visible below `md`.
- Log view: at most **150** lines kept and shown. Dark pane colours:
  - background `#1e1e1e`, text `#d4d4d4`, gutter `#858585`;
  - ERROR `#f48771`, WARN `#cca700`, INFO `#4fc1ff`, DEBUG `#808080`;
  - timestamp `#6a9955`, thread `#c586c0`, class `#4ec9b0`, number `#b5cea8`, string `#ce9178`, path/URL `#9cdcfe`.
- Editor: Monaco, `theme` follows the app (`vs-dark`/`vs`) via the existing `useIsDark()`, with options
  `{ fontSize: 14, wordWrap: "on", minimap: { enabled: true }, scrollBeyondLastLine: false, automaticLayout: true, readOnly }`.
- Icons: inline SVG components in `components/icons.tsx`. No icon library.
- Never modify `/home/bsmagenthub/ai_workspace`.

## Review Focus

1. A log line longer than the pane or with no recognisable structure (wrapper.log, stack traces `\tat ...`) must
   still render, uncoloured where nothing matches, and never throw. Pinned in Task 2 tokenizer tests.
2. Search highlighting must still work inside coloured tokens, so a match that spans two tokens is still marked.
   Pinned in Task 2.
3. Ctrl+S with no unsaved changes, in a read-only file, or while a lifecycle job runs (`busyReason`) sends nothing.
   Pinned in Task 3.
4. Dropping several files on a folder, or a file over 50 MB, behaves as the current upload rules say: one at a
   time, a size error for the large one, and the overwrite confirm for an existing name. Pinned in Task 3.
5. `secret` files offer no Open or Download, `locked` entries offer no Rename or Delete, and `config` files offer
   "Edit in Configuration". All three apply in the context menu too. Pinned in Task 3.

---

### Task 1: Header matches AgentHub; full-width pages

**Files:**
- Modify: `components/AppChrome.tsx`, `components/Dashboard.tsx` (`<main>` and grid), `app/admin/layout.tsx` (`<main>`)
- Test: `components/AppChrome.test.tsx` (create), `components/Dashboard.test.tsx` (add a width assertion)

**Interfaces:**
- Produces: nothing new.

- [ ] **Step 1: Write the failing test.** Render `<AppChrome user={{email:"a@b.c",role:"admin"}}>x</AppChrome>`
  (mock `next/navigation` `usePathname` → "/"). Assert:
  - `header` className contains `px-5` and does not contain `gap-2`;
  - each logo `img` has `h-7` and `-mt-1.5`;
  - the divider span has `mx-2`;
  - the wordmark has `text-2xl md:text-[31px] leading-8 md:leading-9`;
  - `nav` has `gap-5 md:gap-7 px-4 md:px-8`;
  - neither `header` nor `nav` contains `max-md:hidden`.
  - In `Dashboard.test.tsx`, the dashboard `<main>` className contains neither `max-w-6xl` nor `mx-auto` and does
    contain `md:px-8`.
- [ ] **Step 2: Run** `npx vitest run components/AppChrome.test.tsx components/Dashboard.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Copy AgentHub's class values** into `AppChrome.tsx`. Keep `BASE_PATH` on the logo `src`, and keep
  it visible on phones.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 4b: Full width.** Apply the full-width constraint to the Dashboard `<main>` and grid and to the admin
  layout `<main>`.
- [ ] **Step 5: Commit** `style(chrome): header spacing matches AgentHub; pages use the full width`.

### Task 2: Logs: 150 lines, dark highlighted pane

**Files:**
- Create: `lib/ui/log-highlight.ts`, `lib/ui/log-highlight.test.ts`
- Modify: `components/LogTab.tsx`, `app/api/mids/[name]/logs/route.ts`, `app/api/mids/[name]/logs/route.test.ts`
- Test: `components/LogTab.test.tsx` (create)

**Interfaces:**
- Produces:
  - `type LogToken = { text: string; kind: "plain" | "time" | "level-error" | "level-warn" | "level-info" | "level-debug" | "thread" | "class" | "number" | "string" | "path" }`
  - `tokenizeLogLine(line: string): LogToken[]`. The concatenated `text` always equals `line`.
  - `export const LOG_VIEW_LINES = 150` in `lib/ui/log-highlight.ts`.

- [ ] **Step 1: Failing tokenizer tests** in `lib/ui/log-highlight.test.ts`:
  - `tokenizeLogLine("2026-11-19T13:37:38.840+0700 INFO  (Worker-Interactive:HeartbeatProbe-14b9) [AWorker:190] Worker starting: HeartbeatProbe")`
    yields kinds in order containing `time`, `level-info`, `thread`, `class`. The joined text equals the input.
  - A line with `ERROR` gives `level-error`. `WARNING`/`WARN` gives `level-warn`. `SEVERE` gives `level-error`.
  - `/opt/midhub/mids/spike1/agent/work/x.xml` → a `path` token. `https://a.service-now.com/x` → a `path` token.
    `"quoted"` → `string`. `910.0mb` → `number` covering `910.0`.
  - A wrapper.log line `INFO   | jvm 1    | 2026/11/19 13:00:00 | started` gives `time` for `2026/11/19 13:00:00`
    and `level-info`.
  - `"\tat com.x.Y.z(Y.java:12)"` and `""` don't throw. For every input in the test, the joined text equals the
    input.
- [ ] **Step 2: Run** `npx vitest run lib/ui/log-highlight.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `tokenizeLogLine`** with one combined sticky regex of named alternatives, scanned left to
  right. Unmatched characters merge into `plain` tokens.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Server test.** In `route.test.ts`, add a case where the log file has 1,000 lines: the first
  `data:` frame carries exactly the last 150 lines, and lines appended later still stream. Expected: FAIL.
- [ ] **Step 6: Server change.** In the route, add `const INITIAL_LINES = 150`. Until the first non-empty batch has
  been sent, buffer the batches that `tailFile` yields from the initial window, then send only the last
  `INITIAL_LINES`. Keep `WINDOW_BYTES` as is. Run: PASS.
- [ ] **Step 7: LogTab tests** in `components/LogTab.test.tsx`. Mock `apiFetch` to return an SSE body with 200 lines.
  Assert:
  - only the last 150 rows render;
  - each row has a gutter line number;
  - an ERROR line contains an element with `data-kind="level-error"`;
  - searching `Heartbeat` wraps the match in `<mark>`, including inside a coloured token;
  - the labels follow the glossary: `Agent Log`, `Wrapper Log`, `All Levels`, `Pause`/`Follow`, `Download`, and
    status `Live`.

  Expected: FAIL.
- [ ] **Step 8: Rewrite the LogTab view.**
  - Set `MAX_LINES = LOG_VIEW_LINES`.
  - The pane is `bg-[#1e1e1e] text-[#d4d4d4] font-mono text-[12.5px] leading-5 rounded-lg border border-neutral-700`
    and `h-[max(32rem,calc(100svh-22rem))]` (full-width constraint).
  - Each row is a grid of a right-aligned gutter (`text-[#858585] select-none`) and the line. The line holds token
    spans with colours from Global Constraints and `data-kind`.
  - The search mark is applied per token (`bg-[#623315] text-inherit`).
  - The toolbar sits above the pane in the app style, with glossary labels. The footer reads
    `Showing the latest 150 lines`.
  - Keep the stream, reconnect, pause and download logic unchanged.

  Run: PASS.
- [ ] **Step 9: Commit** `feat(logs): latest 150 lines in a dark highlighted pane`.

### Task 3: AgentHub-style file browser and full-screen editor

**Files:**
- Create:
  - `lib/ui/file-tree.ts` and `lib/ui/file-tree.test.ts`
  - `components/icons.tsx`
  - `components/files/FileTree.tsx`
  - `components/files/FileEditorModal.tsx`
  - `components/files/FileContextMenu.tsx`
  - `components/files/FilesTab.test.tsx`
- Modify: `components/FilesTab.tsx`. It becomes the container: state, API calls and dialogs. Rendering moves to
  `components/files/*`.

**Interfaces:**
- Consumes: the existing file API, unchanged:
  - `GET ?path=` returns `{entries, readOnly}`;
  - `GET ?path=&content=1` returns `{content, hash}`;
  - `PUT {path, content, baseHash}`, where `baseHash: ""` creates a new file and an existing one gives 409 `exists`;
  - `POST` is either a FormData upload `{dir, file}` or `{op:"mkdir"|"rename"}`;
  - `DELETE ?path=`;
  - `GET /download?path=`.
- Produces:
  - `type TreeState = { children: Record<string, Entry[] | "loading" | { error: string }>; expanded: Set<string> }`,
    where the key is the dir path and `""` is the root;
  - `visibleRows(state: TreeState): { path: string; depth: number; entry: Entry }[]`, which lists directories
    first, then names in `localeCompare` order, and only descends into expanded dirs;
  - `toggle(state, path): TreeState`.

- [ ] **Step 1: Failing `file-tree` tests.**
  - With root `[dir a, file z.txt, dir b]` and `a` expanded with children `[file x.xml]`, `visibleRows` gives
    `a(0), x.xml(1), b(0), z.txt(0)`.
  - A collapsed dir hides its children.
  - Toggling an expanded dir collapses it.

  Run: FAIL.
- [ ] **Step 2: Implement** `lib/ui/file-tree.ts`. Run: PASS.
- [ ] **Step 3: Failing FilesTab tests** (mock `apiFetch`, `@monaco-editor/react` as a textarea, and
  `XMLHttpRequest`):
  - Clicking a folder row expands it, lazily calls `GET ?path=agent`, and shows its children indented.
  - Clicking a file opens a `role="dialog"` editor titled with the path. Typing marks it `Unsaved changes` (●).
    `Ctrl+S` sends `PUT` with `baseHash`. Then `Saved` shows.
  - `Ctrl+S` sends nothing in each of these cases: no changes, `readOnly`, or `busyReason` set.
  - Closing with unsaved changes asks the Thai confirm. Cancelling keeps the editor.
  - Right-click on a row opens a menu:
    - a `secret` file has no Open or Download;
    - a `locked` entry has no Rename or Delete;
    - a `config` file has "Edit in Configuration", which calls `onOpenConfig`.
  - The "⋯" button opens the same menu.
  - Toolbar buttons are labelled `Upload`, `New File`, `New Folder` and `Refresh`. New File with name `a.txt` sends
    `PUT {path:"<dir>/a.txt", content:"", baseHash:""}` and then opens the file.
  - Dropping a file over 50 MB shows the size error and sends nothing. Dropping an existing name shows the
    overwrite confirm. Dropping two files uploads them one after the other through XHR, with a progress bar
    (`role="progressbar"`).
  - The read-only hint for the program folder and the extlib note still show.

  Run: FAIL.
- [ ] **Step 4: Implement.**
  - **Layout:** a card with a toolbar row and a breadcrumb `<midName>/<dir>` that is the "upload target" (the
    selected folder). Toolbar icon buttons with text tooltips (`title` + `aria-label`) go on the right.
  - **Tree rows:** follow AgentHub's row style. The row is
    `group flex items-center pr-2 hover:bg-gray-100 dark:hover:bg-neutral-700`, with the selected row
    `bg-blue-50 dark:bg-blue-950/40`. Indent is `6 + depth*14` px. Each row shows a ▸/▾ chevron for folders, an
    icon by extension (folder, xml, properties/conf, jar, log, generic), the name, a 🔒 for read-only, the size
    and modified time in muted text on `sm+`, and a "⋯" button that shows on hover or focus and is always visible
    on touch.
  - **Context menu:** a `FileContextMenu` positioned at the pointer and closed on Esc or an outside click. Items
    are Open, Download, Rename, Delete (red) and Edit in Configuration, filtered by the flags.
  - **Rename / New Folder / New File:** reuse the existing name `Modal` and its validation.
  - **Uploads:** drag-over highlights the target folder. Uploads go one at a time through XHR to
    `${API_BASE}${base}` with progress. They keep the existing 50 MB rule, the overwrite confirm and the
    busyReason guard.
  - **`FileEditorModal`:**
    - shell `fixed inset-0 z-[60] flex flex-col bg-black/40 backdrop-blur-sm p-2 sm:p-8`, with an inner
      `rounded-xl overflow-hidden bg-white dark:bg-neutral-900 border shadow-2xl`;
    - header: path (mono), ● with "Unsaved changes", Saved status, Read-only badge, Download, Save (primary) and
      Close;
    - the Monaco options from Global Constraints;
    - Ctrl/Cmd+S handled on `keydown` with `preventDefault`;
    - the stale (409) error keeps the "reload file" action;
    - the busyReason banner.

  Run: PASS.
- [ ] **Step 5: Full suite, `tsc`, `eslint`.**
- [ ] **Step 6: Commit** `feat(files): tree browser, context menu, drag-drop upload, full-screen editor`.

### Task 4: Label standard across the rest of the UI

**Files:**
- Modify: every remaining user-visible component and page:
  - `components/*.tsx` other than LogTab, FilesTab and `files/*`;
  - `components/wizard/*.tsx`;
  - `app/**/page.tsx` and `app/admin/layout.tsx`;
  - `lib/ui/status-view.ts` and `lib/ui/stages.ts` labels;
  - their tests.

**Interfaces:**
- Consumes: the glossary in Global Constraints.

- [ ] **Step 1: List the strings to change.** Find every short UI string (≤ 4 words, a button, tab, heading, th,
  label, chip, placeholder or aria-label) that is Thai or mixed, e.g. `job ล่าสุด`, `ภาพรวม`, `ซ่อมสิทธิ์ไฟล์`,
  `ลบ`, `กำลังโหลด...`, `เมนูผู้ใช้`. Write them as a table in the commit body.
- [ ] **Step 2: Update the tests first** so they query the glossary labels. Run: FAIL.
- [ ] **Step 3: Replace the strings** per the glossary. Thai sentences, confirm bodies and errors stay. Use the
  typographic ellipsis `…` in `Loading…` and `Saving…`. Run the full suite: PASS. Run `tsc` and `eslint` clean.
- [ ] **Step 4: Commit** `style(copy): English Title Case UI labels per the AgentHub standard`.

### Task 5: Visual check and deploy (orchestrator)

- [ ] **Step 1: Run the build locally.** Start `npm run build && next start` on a spare loopback port with:
  - a temporary DB and `MIDHUB_ROOT` that hold one fake MID (with `agent/` files and a 1,000-line `agent0.log.0`);
  - `AGENTHUB_URL` pointing at a fake AgentHub that answers `/api/auth/me` with an admin;
  - `AGENTHUB_SERVICE_USER=none`.
- [ ] **Step 2: Screenshot with Playwright.** Capture light at 1280 px and dark at 390 px:
  - the dashboard, with the header next to AgentHub's values;
  - the Overview, Logs and Files tabs;
  - the editor modal and the context menu.

  Check that the pages have no horizontal overflow and no page errors.
- [ ] **Step 3: Deploy.** Run `sudo scripts/deploy.sh`, then `deploy/golive-gates.sh`. Expected: FAIL 0.
