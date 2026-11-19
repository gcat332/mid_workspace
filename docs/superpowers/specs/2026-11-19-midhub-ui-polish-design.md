# MidHub UI polish: header, labels, logs, files

Date: 2026-11-19 · Status: approved by the user (labels option ก.)

## Intent

Functionality works in production. The user now wants MidHub to look and feel like a real system and like part of
BSM AgentHub. They asked for four things:

1. The header spacing should match AgentHub exactly.
2. The labels should follow one system-grade standard.
3. The log view should show only the latest 150 lines, in a dark, editor-style view with syntax highlighting.
4. The files view should be easier to work with, modelled on AgentHub's file browser and made nicer.

## Decisions

- **Label standard (user picked "ก."):**
  - Short UI chrome is in English, Title Case, matching AgentHub. This covers navigation, tabs, buttons, menu items,
    headings, table headers, field labels, status chips and placeholders.
  - Sentences stay in Thai: help text, confirmations, hints and every error message. Thai is easier to act on.
  - Words follow ServiceNow and AgentHub: MID Server, Instance, Start / Stop / Restart, Save, Cancel, Delete, Rename,
    Upload, Download, New Folder, New File, Loading…
- **Header:**
  - Copy AgentHub's `AppChrome` values exactly:
    - header `px-5`, with no `gap-2` between items;
    - logo `h-7 -mt-1.5`, divider `mx-2`;
    - wordmark `text-2xl md:text-[31px] leading-8 md:leading-9`;
    - nav `gap-5 md:gap-7 px-4 md:px-8`.
  - Keep MidHub's one deliberate difference: the chrome stays visible on phones.
- **Logs:**
  - The server sends the last 150 lines when the stream connects, then the live tail. The client keeps at most the
    latest 150 lines.
  - The view is a dark editor-style pane (VS Code Dark colours) with a line-number gutter and a monospace font.
  - A small in-house tokenizer for the MID/wrapper log format colours these parts:
    - the timestamp;
    - the level (ERROR red, WARN amber, INFO blue, DEBUG grey);
    - `(thread)`, `[Class:line]`, paths, URLs, numbers and quoted strings.
  - No new dependency. Search highlight, the level filter, pause/follow and Download (full file) stay.
- **Files:**
  - AgentHub-style browser: a collapsible folder tree (children load lazily per folder from the existing list API)
    with file-type icons and an icon toolbar (Upload, New File, New Folder, Refresh).
  - Every row has a right-click menu and a "⋯" button for touch. Actions are Open, Download, Rename and Delete,
    filtered by the existing `readOnly`, `locked`, `secret` and `config` flags.
  - Files dropped onto a folder are uploaded with a progress bar (XHR).
  - Opening a file shows a full-screen modal Monaco editor:
    - ● when unsaved, Save, and **Ctrl/Cmd+S**;
    - a confirm before discarding unsaved changes;
    - the editor follows the app's light or dark theme;
    - `wordWrap`, minimap, font 14.
  - New File uses the existing create path (PUT with `baseHash: ""`).
  - The read-only hint for the program folder and the extlib note stay.

## Approaches considered

- **Logs:** Monaco read-only versus a hand-written tokenizer. Monaco is heavy for 150 lines and fights live
  appending, so the tokenizer wins. xterm (AgentHub's run page) needs ANSI, which MID logs don't have.
- **Files:** keep the table and restyle it, versus an AgentHub-style tree plus modal editor. The user asked for
  AgentHub's way of working, so the tree wins.
- **Labels:** English chrome with Thai sentences (picked), versus all-formal Thai (rejected: differs from
  AgentHub).

## Non-goals

- No drag-to-move between folders (the API only renames within a folder).
- No multi-select or bulk delete.
- No zip download of folders.
- No API or permission changes, apart from the logs initial window.
- Monaco keeps loading from the CDN as today.

## Left to the builder

- Exact token colours.
- Icon set: inline SVG, no icon library.
- Tests updated for the new labels and behaviour.
- A visual check in a local run (fake AgentHub) in light and dark, at 1280 px and 390 px.
