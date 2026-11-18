# MidHub × AgentHub Integration (MidHub side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MidHub exposes a server-to-server API (`/midhub/api/agent/*`) that AgentHub calls on behalf of a user's Java session, so Java can list MIDs with a pass/fail checklist and, when every check passes, edit files, read logs and restart that MID — with MidHub's existing sandbox, quota and audit.

**Architecture:** A new auth path for `/api/agent/*` (shared secret + loopback-only + actor email → MidHub `User`) bypasses the cookie gate in `proxy.ts`. A pure checklist function decides per MID. File/log/restart routes are thin wrappers over `lib/mids/files.ts`, the log reader and `callHelper`, so every rule from Phase 1 applies unchanged. A per-MID opt-in flag `agentAccess` gates everything.

**Tech Stack:** Existing MidHub stack. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-18-midhub-agenthub-integration-design.md` (primary), `docs/superpowers/specs/2026-11-18-midhub-design.md`.

## Global Constraints

- Feature is off unless `MIDHUB_AGENT_SECRET` is set (≥ 32 chars); off → every `/api/agent/*` returns 404 `{code:"not_found"}`.
- Request headers from AgentHub: `X-MidHub-Agent-Secret`, `X-MidHub-Actor-Email`, `X-MidHub-Session-Id`, `X-MidHub-Session-Instances` (comma-separated, may be empty).
- Reject before anything else: secret mismatch (constant-time compare) → 401 `agent_auth`; any `X-Forwarded-For` header present → 403 `agent_auth` (not loopback-direct).
- Actor: email lowercased; must be an existing, not-locked MidHub `User` (`isLocked`); acts with that user's role.
- Checklist ids and Thai messages exactly as spec §5.2 (`user_registered`, `session_instance`, `instance_match`, `agent_access`, `mid_ready`); instance normalisation = `normalizeInstanceUrl` (Phase 2 Task 2; if Phase 2 is not merged yet, put the function in `lib/instances/url.ts` and have Phase 2 import it).
- MID instance = `Instance.url` of the MID, else `url` from `config.xml`; both present and different → `instance_match` fails with the spec's mismatch message.
- File rules = Files tab rules (`lib/mids/files.ts`), upload ≤ 52,428,800 bytes with `Content-Length` required; never `agent/config.xml`/`wrapper-override.conf` writes; program dirs read-only.
- Logs endpoint: `lines` default 200, max 2000; only `main|wrapper`.
- Restart: no low-memory confirm from this path (`low_memory` 409 is returned as-is).
- Audit every mutating call and every failed checklist, as the actor, with `{ via: "agenthub", taskId, sessionInstances, path? }`; never the secret.
- Thai cause+fix messages; `{ code, message, detail? }` error shape.

## Review Focus

1. A request reaching MidHub through Caddy (has `X-Forwarded-For`) with a correct secret → 403, and no file op runs. Test in Task 2.
2. A session whose instances are `{A, B}` asks for a MID on instance `C` → 403 `agent_check_failed` naming A, B and C, and an `agent.check_failed` audit row. Test in Task 3.
3. A MID with `agentAccess` off is listed (with the failed check) but every file/log/restart call on it is refused. Test in Task 4.
4. Upload without `Content-Length`, or with a body larger than declared, or > 50 MiB → 411/413 and no partial file left. Test in Task 4.
5. An actor whose MidHub account was deleted or locked after the run started → 403 on the next call (checked per request, not cached). Test in Task 2.

---

### Task 1: Per-MID opt-in flag and UI

**Files:**
- Modify: `prisma/schema.prisma` (+ migration `agent_access`), `lib/mids/registry.ts` (`MidSummary.agentAccess`), `app/api/mids/[name]/route.ts` (PATCH), `components/OverviewTab.tsx`, `components/MidList.tsx`, `lib/ui/audit-format.ts`
- Test: `app/api/mids/[name]/route.test.ts`

**Interfaces:**
- Produces: `MidServer.agentAccess Boolean @default(false)`; `MidSummary.agentAccess: boolean`; `PATCH /api/mids/[name]` body `{ agentAccess: boolean }` (member) → 200 `{ agentAccess }`, audit `mid.agent_access` `{ enabled }`. Overview tab switch labelled "อนุญาตให้ AgentHub (น้อง Java) แก้ไฟล์ MID นี้" with the help text from spec §7; list badge "AgentHub" when on.

- [ ] **Step 1: Failing tests:** PATCH toggles and returns the new value; non-boolean → 400 `invalid_request`; unknown MID → 404; audit row written; unauthenticated → 401.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement schema, route, UI. **Step 4:** PASS + full suite, tsc, eslint.
- [ ] **Step 5:** Commit `feat(agent): per-MID AgentHub access switch`.

---

### Task 2: Agent API authentication

**Files:**
- Create: `lib/agent/auth.ts`, `lib/agent/http.ts`
- Modify: `lib/env.ts` (`agentSecret: string | null`, validated ≥ 32 chars when set), `proxy.ts` (skip cookie gate, CSRF and allowlist redirect logic for paths starting `/api/agent/`; IP allowlist still applies), `.env.local.example`, `lib/mids/names.ts` (codes)
- Test: `lib/agent/auth.test.ts`, `proxy.test.ts`

**Interfaces:**
- Produces:
  - `type AgentCaller = { user: SessionPayload; taskId: string; sessionInstances: string[] }` (`sessionInstances` normalised, deduped, invalid entries dropped).
  - `authenticateAgent(req: Request): Promise<AgentCaller>` — throws `MidError("not_found")` when the feature is off, `MidError("agent_auth")` 401/403 per Global Constraints, `MidError("agent_user")` 403 when the actor has no usable MidHub account (message = `user_registered` text).
  - `agentRoute(handler: (req: Request, caller: AgentCaller, ctx) => Promise<Response>)` in `lib/agent/http.ts` — wraps auth + `handleRouteError`.
  - Codes: `agent_auth` (401 "AgentHub ยืนยันตัวตนกับ MidHub ไม่ผ่าน ตรวจ MIDHUB_AGENT_SECRET ทั้งสองฝั่ง"), `agent_user` (403), `agent_check_failed` (403).

- [ ] **Step 1: Failing tests:** feature off → 404; wrong/missing secret → 401; correct secret + `X-Forwarded-For` → 403; unknown/locked actor → 403 `agent_user`; actor role taken from DB; `sessionInstances` parsing (`"https://A.service-now.com, junk,https://a.service-now.com/"` → `["https://a.service-now.com/"]`); proxy lets `/api/agent/mids` through without a cookie and still blocks a non-allowlisted IP.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (use `crypto.timingSafeEqual` on equal-length buffers). **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(agent): server-to-server auth for AgentHub calls`.

---

### Task 3: Checklist and MID listing

**Files:**
- Create: `lib/agent/checks.ts`, `app/api/agent/mids/route.ts`
- Test: `lib/agent/checks.test.ts`, `app/api/agent/mids/route.test.ts`

**Interfaces:**
- Consumes: `AgentCaller`, `listMids`/`getMid`, `readParams` on `config.xml` via safe-fs (registry helper), `normalizeInstanceUrl`.
- Produces:
  - `type Check = { id: "user_registered" | "session_instance" | "instance_match" | "agent_access" | "mid_ready"; ok: boolean; message?: string }`.
  - `evaluateChecks(caller: AgentCaller, mid: { agentAccess: boolean; state: string; activeJob: string | null; instanceUrl: string | null; configUrl: string | null }): Check[]` (pure; messages per spec §5.2, filling instance names).
  - `requireUsableMid(caller: AgentCaller, name: string): Promise<MidSummary>` — loads the MID, evaluates; any failed check → audit `agent.check_failed` and throw `MidError("agent_check_failed", 403, <first failed message>)` with `checks` attached to the JSON body.
  - `GET /api/agent/mids` → `{ mids: { name, snName, instanceUrl, status, usable, checks }[] }`.

- [ ] **Step 1: Failing tests:** table over `evaluateChecks` (each check failing alone, message text contains the instance hosts); MID with Instance url ≠ config url → `instance_match` false with the mismatch message; route lists all non-removed MIDs with correct `usable`; `requireUsableMid` writes the audit row on failure.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(agent): per-MID checklist and listing`.

---

### Task 4: File, log and restart endpoints

**Files:**
- Create: `app/api/agent/mids/[name]/files/route.ts`, `app/api/agent/mids/[name]/logs/route.ts`, `app/api/agent/mids/[name]/restart/route.ts`, `lib/mids/log-lines.ts`
- Modify: `lib/mids/files.ts` (export a streaming `uploadStream(name, dirRel, filename, body: ReadableStream, declaredLength: number)` that writes via the same verified create/overwrite path and enforces the declared length and 50 MiB cap while streaming)
- Test: route tests + `lib/mids/log-lines.test.ts` + `lib/mids/files.test.ts` additions

**Interfaces:**
- Consumes: `agentRoute`, `requireUsableMid`, `listDir/readText/writeText/mkdir/rename/remove` (`files.ts`), `openLog` (`files.ts`), `callHelper({op:"restart"})`, `readHostMemory` (same low-memory rule as the actions route for a non-running MID), `recordAudit`.
- Produces:
  - Routes exactly as spec §5.3 (GET list/content, PUT write, POST upload raw body with `?dir=&filename=`, POST JSON `{op:"mkdir"|"rename"}`, DELETE, GET logs, POST restart).
  - `readLastLines(open: OpenFn, n: number, maxBytes = 2 MiB): Promise<string[]>` — reads backwards from EOF via the verified handle.
  - `uploadStream` rejects: missing/invalid length → `length_required`; > 52,428,800 → `too_large`; body longer/shorter than declared → `invalid_request` and removes the partial new file (or leaves an overwritten file's original content untouched by writing to a temp name in the same dir first, then renaming over it).
  - Audits: `agent.file.write|upload|mkdir|rename|delete`, `agent.restart`.

- [ ] **Step 1: Failing tests:** each route refuses when `agentAccess` is off (403 `agent_check_failed`, no fs change); write to `agent/config.xml` → `use_config_tab`; write into `agent/bin` → `read_only`; upload happy path then a 51 MiB declared upload → 413 with no file; body shorter than `Content-Length` → 400 and no file; logs `lines=5000` → clamped to 2000; restart calls helper `restart`; audit detail contains `via: "agenthub"` and `taskId` and never the secret header value.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(agent): file, log and restart endpoints for AgentHub`.

---

### Task 5: Deploy wiring and docs

**Files:**
- Modify: `deploy/Caddyfile.midhub` (`@midhubAgent path /midhub/api/agent/*` → `respond 404` placed before `handle @midhub`), `deploy/README.md` (secret generation `openssl rand -base64 48`, same value in AgentHub's env, AgentHub `MIDHUB_URL=http://127.0.0.1:3100/midhub`), `docs/agent-api.md` (API reference for the AgentHub patch author: every endpoint, headers, example curl through AgentHub's route, error codes)

- [ ] **Step 1:** Write the files; `caddy validate` on the snippet wrapped in a dummy site → "Valid configuration".
- [ ] **Step 2:** Local loopback smoke: dev server with `MIDHUB_AGENT_SECRET` set, `curl -H` the four headers to `http://127.0.0.1:3100/midhub/api/agent/mids` → 200 JSON; same with `-H 'X-Forwarded-For: 1.2.3.4'` → 403.
- [ ] **Step 3:** Commit `docs(agent): AgentHub integration deploy notes and API reference`.
