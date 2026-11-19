# MidHub look: Option A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle MidHub to option A, "AgentHub Soft": status pills, a stats strip, a compact MID list, a panel
header with an actions menu, Overview tiles, and AgentHub-style forms and tables.

**Architecture:** Presentation-only changes in `components/` and `app/`, plus one small shared `StatusPill`
component and a tone field from `lib/ui/status-view.ts`. No API, route or permission changes.

**Tech Stack:** Next.js 16 / React 19 / Tailwind v4 (tokens in `app/globals.css`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-19-midhub-style-a-design.md`. Visual reference: the canvas board
"A · AgentHub Soft" in https://claude.ai/artifact/1dHoTxtm3Botz1vQS7GBR4 (`Main.dc.html`).

## Global Constraints

- Follow the spec's values exactly: colours, sizes, radii and the shadow `shadow-[0_1px_2px_rgba(23,35,50,0.06)]`.
- Read-only design reference: `/home/bsmagenthub/ai_workspace/DESIGN.md`. Never modify anything under
  `/home/bsmagenthub`.
- Labels keep the existing English Title Case glossary, and Thai sentences stay Thai. Do not change any label text
  unless the spec says to.
- The AgentHub agent API's Thai status strings (`statusView(..., "th")`) must not change.
- No HTTP PATCH from the browser: the corporate F5 WAF rejects it.
- Every disabled reason that is visible today must stay reachable, as a `title` tooltip plus screen-reader text.
- Light and dark mode both work. Phone width (390 px) works: no horizontal page overflow, and toolbars wrap.

## Review Focus

1. Every MID state renders a pill with the right tone, and no emoji is left in UI components:
   running, stopped, starting, failed, unknown, an active job, and failed install/uninstall.
2. The ⋯ menu keeps every action's enable/disable logic and confirmations. In particular, Uninstall still opens its
   dialog, and Repair Permissions and Upgrade keep their disabled reasons.
3. A long MID name or a long instance host in the list truncates, without widening the 224 px column.
4. Dark mode: tiles, pills, the strip and table headers stay legible (4.5:1 for text).
5. At 390 px, the strip wraps, the header actions wrap, and the tiles become two columns.

---

### Task 1: Status pills

**Files:**
- Create: `components/StatusPill.tsx` and `components/StatusPill.test.tsx`
- Modify: `lib/ui/status-view.ts`, which adds `tone: "running" | "stopped" | "busy" | "failed" | "unknown"` to
  `StatusView`. Keep `icon` only if a server caller still needs it.
- Modify: `components/MidList.tsx`, `components/MidPanel.tsx`, `components/OverviewTab.tsx`, and every other UI place
  that prints `sv.icon` or a status emoji.

**Interfaces:**
- Produces: `StatusPill({ view }: { view: StatusView })`, which renders the pill.
- Produces: `StatusDot({ tone }: { tone: StatusView["tone"] })`, which renders the dot alone with `aria-hidden` (the
  label lives elsewhere).

- [ ] **Step 1: Write failing tests.**
  - The pill shows the label and has a `data-tone` attribute.
  - The busy dot has the pulse class.
  - `statusView` returns the right tone for each state in Review Focus 1.
  - No component source under `components/` contains 🟢, ⚪, 🟡 or 🔴.
- [ ] **Step 2: Implement and swap the call sites.** Run the full suite, `tsc` and `eslint`, then commit
  `style: status pills instead of emoji`.

### Task 2: Dashboard: stats strip, MID list, panel header

**Files:**
- Modify: `components/DashboardToolbar.tsx`, `components/MidList.tsx`, `components/MidPanel.tsx`,
  `components/Dashboard.tsx` (grid `items-start`), and their tests.

- [ ] **Step 1: Write failing tests.**
  - The strip has the segments Running, Memory with its `role="meter"` or progress bar, Disk Free and Storage.
  - The list header reads "MID Servers · N". Names render in a `font-mono` element, and the host is shown without a
    scheme.
  - The panel header has Restart/Stop (or Start) visible, plus a "More actions" button whose menu lists Repair
    Permissions, Upgrade and Uninstall.
  - The upgrade note line is gone. The Upgrade item is disabled and carries that reason as its `title`.
- [ ] **Step 2: Implement per the spec.**
  - The menu reuses the existing context-menu pattern from `components/files/FileContextMenu.tsx`: it closes on Esc
    or an outside click and is keyboard-reachable.
  - Run the full suite, `tsc` and `eslint`, then commit `style: dashboard strip, MID list and panel header (option A)`.

### Task 3: Overview tab

**Files:**
- Modify: `components/OverviewTab.tsx`, `components/AgentAccessSwitch.tsx` (only if the tile needs a compact
  variant), and their tests.

- [ ] **Step 1: Write failing tests.**
  - There are four tiles: Uptime, Memory Usage, Version and AgentHub Access, with the switch inside the last one.
  - The definition list keeps every existing row. Instance, MID Server Name and Service are mono.
- [ ] **Step 2: Implement.** Run the full suite, `tsc` and `eslint`, then commit `style: overview tiles and details
  (option A)`.

### Task 4: Forms, tables, elevation

**Files:**
- Modify:
  - `components/ConfigTab.tsx`;
  - `components/UsersManager.tsx`, `components/InstancesManager.tsx`, `components/IpAllowlistManager.tsx`,
    `components/AuditLog.tsx`;
  - the admin page headers under `app/admin/**`;
  - any resting card with a shadow deeper than the spec's.
  - their tests, where they assert classes.

- [ ] **Step 1: Write failing tests.**
  - The Configuration form's Save button sits in a right-aligned action row.
  - Admin tables have a tinted header row.
  - Audit times are mono.
- [ ] **Step 2: Implement.** Run the full suite, `tsc` and `eslint`, then commit `style: forms, tables and elevation
  (option A)`.

### Task 5: Visual check and deploy (orchestrator)

- [ ] **Step 1: Screenshot.** Rebuild, run the local harness (fake AgentHub, fake MID), and take Playwright
  screenshots at light 1440 and dark 390 of: dashboard, Overview, Configuration, Files, Logs, Audit Log, and the
  open ⋯ menu.
- [ ] **Step 2: Compare against the canvas board.**
- [ ] **Step 3: Deploy.** Merge to main, run `sudo scripts/deploy.sh` and then `deploy/golive-gates.sh`.
