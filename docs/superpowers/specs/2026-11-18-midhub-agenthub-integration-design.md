# MidHub × AgentHub integration — Design

วันที่: 2026-11-18 · สถานะ: ร่าง รอ review · ต่อจาก `docs/superpowers/specs/2026-11-18-midhub-design.md`

> สัญลักษณ์: **[ผู้ใช้]** = ผู้ใช้ตัดสินใจเอง · **[ผู้ออกแบบ]** = ผู้ออกแบบเลือกให้ แก้ได้

## 1. เป้าหมายและเหตุผล

คนในทีมที่ทำงานกับ น้อง Java (agent ใน BSM AgentHub) ต้องการทำ custom app บน ServiceNow ที่ใช้ MID Server และอยากให้ Java **แก้ไฟล์ใน MID ได้เองจากใน session ของ AgentHub** โดยไม่ต้องสลับไปทำมือใน MidHub [ผู้ใช้]

ต้องมี **การตรวจก่อนอนุญาต** อย่างน้อยว่า instance ที่ session ของ AgentHub ใช้อยู่ (ใน `.env` ของ session: `SN_INSTANCE_URL`) **ตรงกับ instance ของ MID** [ผู้ใช้] และใช้ **ระบบหลังบ้านกลาง** คือ MidHub เป็นคนตัดสินและเป็นคนแก้ไฟล์ ส่วน AgentHub เป็นตัวกลางที่ยืนยันว่าใครเป็นคนสั่ง (แบบ ข.) [ผู้ใช้]

## 2. Goals / Non-goals / Anti-goals

**Goals**
1. Java เรียกดูรายการ MID พร้อม checklist ว่าใช้ได้หรือไม่ และเหตุผลถ้าไม่ได้
2. เมื่อผ่าน checklist: Java list/อ่าน/เขียน/upload/สร้างโฟลเดอร์/rename/ลบไฟล์ใน MID ได้ ด้วยกติกาเดียวกับแท็บไฟล์ของ MidHub
3. Java อ่าน log ล่าสุดของ MID และสั่ง restart ได้ (ติดโควต้าเดิม)
4. ทุกการกระทำผ่านช่องทางนี้บันทึกลง audit ของ MidHub ในชื่อผู้ใช้จริง และระบุว่ามาจาก AgentHub session ไหน
5. ผู้ใช้ไม่ต้อง copy token หรือตั้งค่าอะไรเพิ่มใน session (ใช้ email จาก SSO ตัวเดียวกัน) [ผู้ใช้ เลือกแบบ ข.]

**Non-goals**
- Java สร้าง/ลบ/upgrade MID, แก้ `config.xml` หรือ `wrapper-override.conf` (มี password และมี backup ในแท็บตั้งค่าของ MidHub) [ผู้ออกแบบ]
- Java แก้ไฟล์ในโฟลเดอร์โปรแกรม `agent/bin`, `agent/lib`, `agent/jre` [ผู้ออกแบบ]
- แสดง UI ของ MidHub ภายใน AgentHub

**Anti-goals** (ล้มเหลวแม้ฟีเจอร์ทำงาน)
- AgentHub หรือ Java ได้สิทธิ์ระบบไฟล์ของ MID โดยตรง (เช่น เพิ่ม `bsmagenthub` เข้า group `midhub`) ซึ่งข้าม sandbox/audit ทั้งหมด
- Java ปลอมตัวเป็นผู้ใช้อื่น หรือใช้สิทธิ์ของคนที่ไม่มีบัญชี MidHub
- Java ไปแก้ MID ที่ชี้ instance อื่นจากที่ session ทำงานอยู่ โดยไม่มีใครรู้
- secret ระหว่างระบบรั่วเข้า session ของ Java

## 3. Constraints

- MidHub และ AgentHub อยู่เครื่องเดียวกัน หลัง Caddy เดียวกัน: MidHub `127.0.0.1:3100` (basePath `/midhub`), AgentHub `127.0.0.1:3000`
- Java รันใน sandbox (`bwrap`) เป็น user `bsmagenthub` ด้วย env allowlist (`agentEnv()`), เรียก AgentHub กลับได้ด้วย `curl` + task-scoped token (มีรูปแบบอยู่แล้ว: `AGENT_TASK_TOKEN`, `lib/auth/subtask-token.ts`)
- session ของ AgentHub = `Task` ที่มี `userId` เจ้าของ, โฟลเดอร์ `workspace/sessions/<taskId>/` มี `.env` ที่ผู้ใช้/agent แก้ได้
- กฎ Phase 1 ของ MidHub ยังใช้ทั้งหมด: safe-fs, read-only program dirs, `use_config_tab`, upload ≤ 50 MiB, โควต้า, audit, error ภาษาไทยแบบบอกสาเหตุ+วิธีแก้

## 4. Approaches

| | แนวทาง | ข้อดี | ข้อเสีย |
|---|---|---|---|
| ก | token ต่อคนที่สร้างใน MidHub แล้ว copy ไปใส่ `.env`, Java เรียก MidHub ตรง | ไม่ต้องแก้ AgentHub | ผู้ใช้ต้องจัดการ token เอง, Java เป็นคนบอก instance เอง |
| **ข** | **AgentHub เป็นตัวกลาง: อ่าน `.env` ของ session เอง แล้วเรียก MidHub ด้วย secret ระหว่างระบบ + email ผู้ใช้** | ไม่ต้องตั้งค่าเพิ่ม, Java ปลอมตัวไม่ได้, ใช้ SSO email เดียวกัน | ต้อง patch AgentHub, มี secret เพิ่ม 1 ตัว |
| ค | ให้ AgentHub แก้ไฟล์ตรง (เพิ่ม group) | ง่ายสุด | ผิด anti-goal: ข้าม sandbox/audit/read-only, ได้ทุก MID |

เลือก **ข** [ผู้ใช้] · ค ตัดเพราะผิด anti-goal · ก ตัดเพราะผู้ใช้ต้องจัดการ token และ instance มาจากฝั่ง Java

## 5. ภาพรวม

```
Java (sandbox, user bsmagenthub)
  │  curl  Authorization: Bearer $AGENT_MIDHUB_TOKEN   (token ผูก taskId + userId ของคนที่สั่ง run, หมดอายุพร้อม run)
  ▼
AgentHub  /api/tasks/<taskId>/midhub/<path>            (patch ฝั่ง AgentHub)
  1. verify token → taskId ตรง path, หา actor user (email)
  2. อ่าน workspace/sessions/<taskId>/.env → SN_INSTANCE_URL (ฝั่ง server อ่านเอง)
  3. forward ไป MidHub ทาง loopback พร้อม header ด้านล่าง (stream body/response)
  ▼
MidHub  http://127.0.0.1:3100/midhub/api/agent/<path>  (ฝั่ง MidHub)
  1. ตรวจ shared secret (constant-time) และต้องไม่มี X-Forwarded-For (= มาจาก loopback ตรง ไม่ผ่าน Caddy)
  2. actor email ต้องมีบัญชี MidHub, ไม่ถูกล็อก → ใช้ role ของคนนั้น
  3. checklist ต่อ MID → ผ่านทุกข้อจึงทำงาน (ใช้ lib/mids/files.ts, log, helper เดิม)
  4. audit: action agent.* + { via: "agenthub", taskId }
```

### 5.1 สัญญาระหว่างระบบ (header ที่ AgentHub ส่งไป MidHub) [ผู้ออกแบบ]

| Header | ค่า |
|---|---|
| `X-MidHub-Agent-Secret` | ค่า `MIDHUB_AGENT_SECRET` (มีทั้งสองฝั่ง, ≥ 32 ตัวอักษร) |
| `X-MidHub-Actor-Email` | email ของผู้ใช้ AgentHub ที่สั่ง run นี้ (lowercase) |
| `X-MidHub-Session-Id` | `taskId` ของ AgentHub (ใช้ใน audit) |
| `X-MidHub-Session-Instances` | ชุด instance ของ session คั่นด้วย `,` (ดู 5.1.1) หรือว่าง ถ้าไม่มี |

ข้อกำหนดเพิ่ม: `X-MidHub-Session-Id` ต้องมีและไม่ว่าง (ไม่เช่นนั้น MidHub ตอบ 400 `agent_auth`) · AgentHub ต้องเรียก `http://127.0.0.1:3100/midhub` เพื่อให้ `Host` เป็น loopback (`127.x`/`[::1]`/`localhost` พอร์ตใดก็ได้) MidHub ตอบ 403 `agent_auth` ถ้า Host หรือ X-Forwarded-For/X-Real-IP/Forwarded ไม่ใช่ loopback (ชั้นป้องกันเสริม; ชั้นหลักคือ Caddy 404 `/midhub/api/agent/*`)

#### 5.1.1 instance ของ session มาจากไหน [ผู้ใช้เลือกแบบ ก. ดูรวมทุกแหล่ง]

AgentHub (ฝั่ง server) รวบรวมจากทุกแหล่งต่อไปนี้ แล้ว normalize เป็น `https://<x>.service-now.com/` ตัดค่าที่ไม่ใช่ `*.service-now.com` ทิ้ง และตัดซ้ำ:
1. `Task.instanceHost` (AgentHub ตั้งเองตอนเปิด session จาก instance connection — agent แก้ไม่ได้)
2. `SN_INSTANCE_URL` ใน `workspace/sessions/<taskId>/.env`
3. `SN_INSTANCE_URL` ในทุก `workspace/sessions/<taskId>/snow-projects/*/.env` (โปรเจกต์ที่สร้างด้วย snow-init)

`instance_match` ผ่านเมื่อ instance ของ MID อยู่ในชุดนี้ — Java ไม่ต้องระบุ instance เอง ข้อเสียที่ยอมรับ: session ที่มีหลายโปรเจกต์แก้ MID ของ instance ใดก็ได้ในชุด [ผู้ใช้]

#### 5.1.2 sub-task [ผู้ออกแบบ]

sub-task ที่ Java แยกส่งผ่าน `/subtasks` ได้ `AGENT_MIDHUB_TOKEN` ด้วย โดยใช้ **ชุด instance และ actor ของ session แม่** (AgentHub หา parent จาก task ของ sub-task) จะได้สั่ง sub-agent ไปแก้ MID ได้ โดยสิทธิ์ไม่ขยายไปคนอื่น

#### 5.1.3 instance ของ MID [ผู้ออกแบบ]

ใช้ `Instance.url` ที่ MID ผูกไว้ (normalize แล้ว) ถ้า MID ไม่มี Instance ให้ใช้ `url` ใน `config.xml` — ถ้ามีทั้งสองอย่างแต่ไม่ตรงกัน ถือว่า `instance_match` ไม่ผ่าน ("instance ใน MidHub และใน config.xml ของ MID ไม่ตรงกัน แก้ในแท็บตั้งค่าก่อน")

- ฝั่ง MidHub: ถ้า `MIDHUB_AGENT_SECRET` ไม่ได้ตั้ง → `/api/agent/*` ตอบ 404 (ปิดฟีเจอร์) · request ที่มี `X-Forwarded-For` → 403 (กันคนนอกยิงผ่าน Caddy แม้ได้ secret ไป) · Caddy block `/midhub/api/agent/*` จากภายนอกด้วย (ตอบ 404) เป็นชั้นที่สอง
- `/api/agent/*` ไม่ผ่าน session gate / CSRF ของ `proxy.ts` (ไม่มี cookie) แต่ต้องผ่านการตรวจข้างบนทุก request ก่อนทำอย่างอื่น
- secret อยู่ใน env ของ server เท่านั้น: AgentHub ห้ามใส่ใน `agentEnv()` หรือ prompt ของ Java

### 5.2 Checklist ต่อ MID [ผู้ใช้ข้อ 2 · ผู้ออกแบบข้ออื่น]

| id | ผ่านเมื่อ | ข้อความเมื่อไม่ผ่าน (ไทย, สาเหตุ + วิธีแก้) |
|---|---|---|
| `user_registered` | actor email มีบัญชี MidHub และไม่ถูกล็อก | "ผู้ใช้ <email> ยังไม่มีสิทธิ์ใช้ MidHub ให้ Admin เพิ่มในหน้า Users" |
| `session_instance` | ชุด instance ของ session (5.1.1) ไม่ว่าง | "session นี้ยังไม่มี instance: ตั้ง SN_INSTANCE_URL ใน .env หรือสร้างโปรเจกต์ด้วย snow-init" |
| `instance_match` | instance ของ MID (5.1.3) อยู่ในชุด instance ของ session | "session นี้ทำงานกับ <A, B> แต่ MID นี้ต่อ <C> เลือก MID ที่ต่อ instance ของ session หรือเพิ่ม instance นั้นใน .env" |
| `agent_access` | MID เปิด "อนุญาตให้ AgentHub แก้ไฟล์" ไว้ | "MID นี้ยังไม่เปิดให้ AgentHub แก้ ให้เปิดในหน้า MidHub แท็บภาพรวม" |
| `mid_ready` | MID ไม่ได้อยู่ระหว่าง job และ state = installed | "MID นี้กำลังมีงานอยู่ (<stage>) รอให้เสร็จก่อน" |

- **`agent_access` เป็นสวิตช์ต่อ MID ค่าเริ่มต้นปิด** [ผู้ออกแบบ]: เพราะ spec หลักไม่แยกข้อมูลระหว่างผู้ใช้ สวิตช์นี้ทำให้ MID ของ POC อื่นที่ชี้ instance เดียวกันไม่ถูก Java ของคนอื่นแก้โดยไม่ตั้งใจ — member เปิด/ปิดได้ใน MidHub และบันทึก audit
- `instance_match` คือการกันพลาด ไม่ใช่ขอบเขตสิทธิ์ (`.env` แก้ได้) สิทธิ์จริงมาจากบัญชี MidHub ของผู้ใช้ + `agent_access`

### 5.3 API ฝั่ง MidHub (`/midhub/api/agent/...`) [ผู้ออกแบบ]

| Method + path | ทำอะไร |
|---|---|
| `GET mids` | รายการ MID ทั้งหมดที่ไม่ถูกลบ: `{ name, snName, instanceUrl, status, usable, checks: [{ id, ok, message? }] }` |
| `GET mids/<name>/files?path=` | list (เหมือนแท็บไฟล์) |
| `GET mids/<name>/files?path=&content=1` | อ่าน text + hash |
| `PUT mids/<name>/files` `{ path, content, baseHash }` | เขียน text (stale → 409) — ไฟล์ใหม่ใช้ `baseHash: ""` |
| `POST mids/<name>/files?dir=&filename=` body = raw bytes, `Content-Length` จำเป็น | upload ≤ 50 MiB (raw body ไม่ใช้ multipart เพื่อให้ curl ง่าย) |
| `POST mids/<name>/files` `{ op: "mkdir" \| "rename", ... }` | เหมือนแท็บไฟล์ |
| `DELETE mids/<name>/files?path=` | ลบ |
| `GET mids/<name>/logs?file=main\|wrapper&lines=200` | log ล่าสุด N บรรทัด (สูงสุด 2000), JSON `{ lines }` |
| `POST mids/<name>/restart` | restart ผ่าน helper (โควต้าเดิม; ถ้า RAM ต่ำได้ `low_memory` 409 — ไม่มี confirm จากฝั่ง agent) |

- ทุก route ที่อ้าง MID ผ่าน checklist ครบก่อน ไม่ผ่าน → 403 `{ code: "agent_check_failed", message, checks }`
- error อื่นใช้ `{ code, message, detail? }` ชุดเดียวกับ MidHub
- audit: `agent.file.write|upload|mkdir|rename|delete`, `agent.restart`, `agent.check_failed` (บันทึกเมื่อ checklist ไม่ผ่านด้วย) พร้อม `{ via: "agenthub", taskId, sessionInstances, path? }` ในชื่อผู้ใช้จริง
- `GET mids` ไม่บันทึก audit (อ่านอย่างเดียว ถี่)

### 5.4 ฝั่ง AgentHub (patch) [ผู้ใช้จะทำ patch · รายละเอียดผู้ออกแบบเสนอ]

- token family ใหม่ `AGENT_MIDHUB_TOKEN` แยกจาก session JWT และจาก subtask token แบบเดียวกับ `lib/auth/subtask-token.ts`: claims `{ taskId, actorUserId, purpose: "midhub-proxy" }`, issuer `ai-workspace/midhub-proxy`, TTL 4 ชม. ใส่ใน env ของ run เฉพาะเมื่อตั้ง `MIDHUB_URL` + `MIDHUB_AGENT_SECRET` แล้ว
- actor = ผู้ใช้ที่ส่งข้อความที่ทำให้เกิด run นี้ (รองรับ collaboration: ใครสั่ง คนนั้นรับผิดชอบ) ถ้าระบุไม่ได้ใช้เจ้าของ task
- route ใหม่ `ALL /api/tasks/[id]/midhub/[...path]` (bypass session gate แบบเดียวกับ `/subtasks`): verify token, `taskId` ต้องตรง, actor ยังมีสิทธิ์ใน task, รวบรวมชุด instance ของ session (5.1.1, ของ session แม่ถ้าเป็น sub-task) ฝั่ง server, forward แบบ stream ไป `MIDHUB_URL + "/api/agent/" + path` (method, query, body, `Content-Type`, `Content-Length`) พร้อม header ใน 5.1 และส่ง status/body กลับตรงๆ · timeout 120 วิ · path ต้องตรง allowlist ของ 5.3
- เอกสารสำหรับ Java ต่อท้าย prompt (แบบ `buildSubagentDispatchDoc`) เมื่อเปิดฟีเจอร์: บอกให้เริ่มจาก `GET mids` เสมอ, ตัวอย่าง curl ทุก endpoint, และข้อห้าม (config.xml, agent/bin|lib|jre)
- ไม่แก้ `agentEnv()` allowlist ของ server secret

## 6. Data model (MidHub)

- `MidServer.agentAccess Boolean @default(false)` [ผู้ออกแบบ]
- ไม่มีตารางใหม่: identity มาจาก `User` เดิม, audit ใช้ `AuditLog` เดิม

## 7. UI (MidHub)

- แท็บภาพรวม: สวิตช์ "อนุญาตให้ AgentHub (น้อง Java) แก้ไฟล์ MID นี้" + คำอธิบายสั้น และข้อความว่าต้องใช้ session ที่ `SN_INSTANCE_URL` ตรงกับ instance ของ MID
- รายการ MID: badge เล็ก "AgentHub" เมื่อเปิด
- หน้า Audit: label ไทยของ action `agent.*` และแสดง `via: agenthub` + taskId

## 8. Deploy

- ทั้งสองฝั่งเพิ่ม `MIDHUB_AGENT_SECRET` (`openssl rand -base64 48`, ค่าเดียวกัน) · AgentHub เพิ่ม `MIDHUB_URL=http://127.0.0.1:3100/midhub`
- Caddy: ใน site ที่มี block MidHub เพิ่ม `@midhubAgent path /midhub/api/agent/*` → `respond 404` ก่อน `handle @midhub`
- `bsm-midhub.service` ไม่ต้องเปลี่ยน (loopback อยู่แล้ว)

## 9. ลำดับ

- ฝั่ง MidHub ทำได้อิสระจาก Phase 2 (ใช้แค่ของ Phase 1) — แผน: `docs/superpowers/plans/2026-11-18-midhub-agenthub-integration.md`
- ฝั่ง AgentHub ทำหลัง MidHub มี `/api/agent/*` แล้ว — แผน: `docs/superpowers/plans/2026-11-18-agenthub-midhub-patch.md` (ไฟล์อยู่ใน repo MidHub เพื่อส่งต่อให้คนทำ patch AgentHub)

## 10. ให้ผู้ build ตัดสินใจเอง

- ชื่อไฟล์/ฟังก์ชัน, การจัดโค้ด, รายละเอียดหน้าตา
- วิธี stream body ใน AgentHub (Web streams / `duplex: "half"`)
- จำนวนบรรทัด default ของ `logs`
