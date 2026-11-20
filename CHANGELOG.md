# Changelog — BSM MIDHub

Type tags: `[feature]` new capability · `[bug]` fix · `[style]` UI/visual only ·
`[security]` security/hardening · `[chore]` tooling/release. Newest first; versions
nest as major › minor › patch on the `/changelog` page.

## Release names

Friendly titles for each major/minor line, shown next to the version on the
`/changelog` page. Add a line here (`- v0.X.Y — Name`) when starting a new minor.

- v0.1 — Foundation
- v0.1.0 — MID Server Manager
- v0.2 — AgentHub Bridge
- v0.2.0 — Agent API
- v0.2.1 — AgentHub Sign-in
- v0.2.2 — Behind AgentHub Proxy
- v0.3 — Polish
- v0.4 — File Explorer
- v0.4.0 — Explorer-style Files
- v0.4.1 — RAM Limit
- v0.4.2 — Copy & Paste

## v0.4.2 — `[feature]`

**Copy paths and paste files to upload.**

- Cmd/Ctrl+C copies the selected files' paths (one per line); the ⋯ menu has Copy Path on every row
- Cmd/Ctrl+V uploads files copied in Finder or Explorer into the selected folder (folders are skipped with a note)
- Existing files in MID system folders such as `agent/security` can be replaced by upload again; new names are still refused
- When some files are refused and an upload also fails, both messages are shown
- Ctrl+C and Ctrl+A work with the Thai keyboard layout

## v0.4.1 — `[feature]`

**RAM (heap) is capped at 2048 MB.**

- Heap accepts 256–2048 MB in the wizard, the Configuration tab and raw `wrapper.java.maxmemory` edits
- The note about rewriting the systemd unit under the Heap field is removed

## v0.4.0 — `[feature]`

**The Files tab works like a desktop file explorer.**

- Drag files and folders onto another folder to move them; a name clash asks Replace or Skip
- Drag a file out onto the desktop to download it (Chrome/Edge)
- Ctrl/Shift+click to select several files, then delete them or download them as one .zip
- Download a whole folder as .zip (config.xml is never included)
- Shortcuts: Del (Cmd+Backspace on Mac), F2, Enter, Ctrl/Cmd+A, Esc
- MID system and config files (`agent/conf`, `agent/properties`, `agent/security`, scripts, `agent/logs` …) cannot be moved, renamed or deleted, also through the agent API
- Moves are recorded in the audit log as Move File

## v0.3.0 — `[style]`

**UI polish to match AgentHub.**

- Header and navigation match AgentHub; pages use the full screen width
- English Title Case labels across the UI (sentences stay Thai)
- Dark, syntax-highlighted log view showing the latest 150 lines
- File browser with a folder tree, context menu, drag-and-drop upload and a full-screen editor
- Footer with the app version, and this changelog page

## v0.2.3 — `[bug]`

**Saves work through the corporate F5 WAF.**

- The WAF rejects `PATCH`, so saves are now sent as `POST`
- An HTML reply from the proxy is shown as an error instead of being parsed as data

## v0.2.2 — `[feature]`

**Works behind AgentHub's `/midhub` proxy.**

- Served on the domain path through AgentHub's `/midhub` route
- Redirects are relative, so they keep the proxy prefix
- CSRF checks use `X-Forwarded-Host`; refusals are logged with the forwarded host headers
- The agent API refuses forwarded requests

## v0.2.1 — `[feature]`

**Sign in with AgentHub.**

- Only AgentHub admins can sign in; the local login is removed
- The actor on agent calls must be an AgentHub admin, and agent-created users are audited

## v0.2.0 — `[feature]`

**Agent API for AgentHub.**

- น้อง Java can read and edit MID files, read logs and restart a MID through server-to-server endpoints
- Per-MID AgentHub Access switch and checklist
- Agent routes need loopback access and a signed server-to-server token

## v0.1.0 — `[feature]`

**MID Server Manager.**

- Create, import, start, stop, restart and uninstall MID servers, with live job progress
- Configuration, Files and Logs tabs for each MID
- Admin pages: users, instances, IP allowlist and audit log
- Root helper service for privileged operations
- Build, deploy and go-live scripts with health gates
