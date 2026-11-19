# MidHub look: Option A "AgentHub Soft"

Date: 2026-11-19 · Status: approved by the user (picked option A on the style-options canvas
https://claude.ai/artifact/1dHoTxtm3Botz1vQS7GBR4, board "A · AgentHub Soft")

## Intent

MidHub should look like part of BSM AgentHub. It follows AgentHub's `DESIGN.md`, which is a read-only reference at
`/home/bsmagenthub/ai_workspace/DESIGN.md`: "The Soft-SaaS Control Room". That means:

- cool ground `#F6F8FB` and white panels;
- hairline borders plus one whisper shadow;
- one interactive blue, `#2F5FA6`;
- soft tint status pills with a dot;
- 14/12 px type with weight-based hierarchy;
- mono for anything the machine said;
- primary actions top-right, form actions bottom-right.

## Decisions

### Status pills replace emoji everywhere

The emoji 🟢 ⚪ 🟡 🔴 go in the MID list, the panel header, Overview and job views. Each pill is a soft tint, a 6 px
dot and a 12 px / 500 label, with full-pill radius and `px-2.5 py-0.5`.

| Tone | Used for | Pill | Dot |
|---|---|---|---|
| running | Running | `bg-blue-50`, `text-blue-700` | `#2F5FA6` |
| stopped | Stopped | gray tint | gray |
| busy | Starting / Working / job labels | blue tint | pulsing dot (`motion-safe:animate-pulse`) |
| failed | Failed / Install Failed / Uninstall Failed | `red-50`, `red-700` | red |
| unknown | Unknown | gray | gray, hollow |

The MID list uses the dot only.

### Host stats strip (Dashboard toolbar)

- **One white card** with segments divided by hairlines. Each segment has a 12 px / 500 muted label over a 14 px / 600
  value:
  - Running `1 / 4`;
  - Memory: `657 MB` MID, then muted `· 6.4 GB free of 11.7 GB`, with a 4 px usage bar (accent fill = used share of
    total RAM);
  - Disk Free;
  - Storage: a muted 12 px line `MID … · Packages … · Archive …`.
- The low-RAM warning stays, as an amber pill in the strip.
- Import (secondary) and New MID Server (primary gradient, with a + icon) sit top-right.

### MID list card

- It fits its content (`self-start`, so it never stretches to the panel height) and has a 12 px / 500 header
  "MID Servers · N".
- Each row shows:
  - the status dot;
  - the **mono** name, 13 px (600 when selected, navy);
  - a small AgentHub chip (11 px, blue tint) when enabled;
  - the instance host only (no scheme) on a muted 12 px line, truncated.
- The selected row is `bg-blue-50`, rounded 8 px.

### MID panel header

- The name is **mono** 20 px / 600, followed by the status pill.
- Top-right:
  - Restart and Stop, as secondary buttons with stroke icons; Stop has red text and border. Start replaces Stop or
    Restart where the state calls for it.
  - A "⋯" icon button with `aria-label` "More actions" that opens a menu: Repair Permissions, Upgrade, and
    Uninstall in red.
- The "Upgrade ยังไม่เปิดให้ใช้ในเวอร์ชันนี้" line is removed. Every disabled reason becomes the `title` tooltip of its
  disabled control and is also exposed to screen readers. No reason may be lost.

### Overview tab

- **Four tiles** in a row (two on small screens). Each is 10 px radius, ground-tinted, 12 px label over 14 px / 600
  value:
  - Uptime;
  - Memory Usage: `673 MB`, then muted `of 1024 MB heap`;
  - Version (mono);
  - AgentHub Access: the tile label plus the switch only. Earlier the user asked to drop the On/Off and description
    text; the explanation stays in the tooltip.
- **A definition list** below: 180 px label column, 12 px / 500 muted labels, rows split by faint hairlines.
  - Instance is a mono link.
  - MID Server Name is mono.
  - Service is the systemd unit name, mono.
  - Instance Record is "Open in ServiceNow ↗".
  - Any other existing rows are kept.

### Forms (Configuration and admin forms)

- Labels are 12 px / 500 muted and sit above their fields.
- Configuration's form is two columns from `lg` up.
- The action row is bottom-right: secondary on the left, primary on the right.
- Hints are 12 px muted, under the field.

### Tables (admin: Users, Instances, IP Allowlist, Audit Log)

- Header row is a tinted ground (`bg-gray-50`) with 12 px / 500 muted headers.
- Rows hover with a faint tint.
- Cells use compact padding.
- Machine values are mono: times, IPs/CIDRs, URLs and IDs.
- Tables sit inside a white, 12 px-radius card.

### Elevation and radius

- Resting cards and panels use only `shadow-[0_1px_2px_rgba(23,35,50,0.06)]`. Nothing deeper rests on the page.
- Panels use a 12 px radius, buttons 8 px (primary 10 px), and inputs 8 px.
- Menus, popovers and modals keep their deeper shadows.

### Dark mode

Every change keeps working in dark mode through the existing token overrides (`dark:` variants where colours are
literal).

## Non-goals

- No behaviour or API changes: labels, routes and permissions stay as they are.
- No font loading change.
- The Logs and Files views keep their current design apart from shared pills, buttons and shadows.

## Approaches considered

- A "AgentHub Soft" (picked).
- B "Ops Console": dark sidebar and dense layout; rejected by the user.
- C "MFEC Corporate": Prompt font and pill buttons; rejected by the user.
