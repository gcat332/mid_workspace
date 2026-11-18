# BSM MidHub — Design

วันที่: 2026-11-18 · สถานะ: ร่าง รอ review

> สัญลักษณ์: **[ผู้ใช้]** = ผู้ใช้ตัดสินใจเอง · **[ผู้ออกแบบ]** = ผู้ออกแบบเลือกให้ แก้ได้ · **[spike]** = ต้องลองบนเครื่องจริงก่อนเขียนโค้ดส่วนนั้น

## 1. เป้าหมายและเหตุผล

MidHub เป็นเว็บแบบ one-stop สำหรับจัดการ ServiceNow MID Server ทุกตัวที่ติดตั้งบน Linux host เครื่องเดียว ซึ่งเป็นเครื่องเดียวกับที่รัน BSM AgentHub ทีม MFEC ใช้สร้าง ตั้งค่า ดูแล อัปเกรด และถอน MID สำหรับงาน Dev/POC ได้จากหน้าเว็บ **โดยไม่ต้อง SSH และไม่ต้องรู้คำสั่ง Linux** [ผู้ใช้]

- ผู้ใช้: ทีม MFEC เท่านั้น [ผู้ใช้]
- MID ทุกตัวชี้ไปที่ demo instance ของ MFEC เท่านั้น ไม่ใช่ instance ของลูกค้า [ผู้ใช้]
- ปัจจุบันบนเครื่องยังไม่มี MID จึงออกแบบใหม่ได้ทั้งหมด [ผู้ใช้]
- หลักสำคัญที่สุดคือ **ใช้ง่ายที่สุด** [ผู้ใช้]
- MID จะถูกสร้างและลบบ่อยตามรอบ POC ดังนั้นการสร้างตัวใหม่ต้องเร็วและพลาดยาก [ผู้ออกแบบ]

## 2. Goals / Non-goals / Anti-goals

**Goals (v1)**
1. ดูรายการ MID ทั้งหมดพร้อมสถานะ, instance, เวอร์ชัน และ RAM
2. Start / Stop / Restart
3. ติดตั้ง MID ใหม่ผ่าน wizard และ clone จากตัวที่มีอยู่ได้
4. แก้ config (`config.xml`, `wrapper-override.conf`) ผ่าน form และ raw editor มี backup, diff และ rollback
5. File manager ภายในโฟลเดอร์ของ MID แต่ละตัว
6. Log viewer แบบ real-time
7. Upgrade ด้วยมือพร้อม rollback และแสดงเวอร์ชันเทียบกับ instance
8. Uninstall โดย archive โฟลเดอร์เก็บไว้ก่อน
9. Audit log ว่าใครทำอะไร

**Non-goals**
- หลาย host, Windows, MID บน Docker
- instance ของลูกค้า และการแยกข้อมูลระหว่างผู้ใช้
- ระบบ alerting หรือ monitoring ภายนอก (LINE/Teams ฯลฯ)
- จัดการ MID cluster, capability และ IP range ในฝั่ง instance
- Web terminal / การรันคำสั่ง shell แบบอิสระ

**Anti-goals** (ถ้าเกิดเรื่องเหล่านี้ ถือว่าล้มเหลวแม้ฟีเจอร์จะทำงานครบ)
- เว็บหรือผู้ใช้สั่งคำสั่งใดก็ได้ด้วยสิทธิ์ root
- MID กิน RAM จน AgentHub ล่ม
- งานปกติยังต้องให้คน SSH เข้าไปทำ
- error ที่ผู้ใช้อ่านไม่รู้เรื่องว่าต้องแก้อย่างไร

## 3. Constraints

- OS: Linux [ผู้ใช้] · host เดียวกับ AgentHub [ผู้ใช้] · RAM 8 GB + swap 4 GB และ AgentHub ตั้ง `MemoryMax=6G` (จาก `bsm_agenthub/ai-workspace/deploy/bsm-agenthub.service`)
- **MID ที่รันพร้อมกันต้องไม่เกิน 4 ตัว** [ผู้ใช้] ส่วนตัวที่ติดตั้งไว้แต่หยุดอยู่ มีได้ไม่จำกัด [ผู้ออกแบบ]
- เป็นแอปแยกจาก AgentHub [ผู้ใช้] แต่ใช้ **stack เดียวกัน** [ผู้ใช้]: Next.js 16 (App Router) + React 19 + TypeScript, Tailwind v4, Prisma 7 + SQLite (better-sqlite3 adapter), `jose`, `@monaco-editor/react`, `archiver`, Vitest, Node 22, systemd + Caddy, ไม่ใช้ Docker
- **บัญชีแยกจาก AgentHub แต่ใช้ SSO ตัวเดียวกัน** [ผู้ใช้] (รายละเอียดในหัวข้อ 6)

## 4. ภาพรวมสถาปัตยกรรม

```
Browser ──HTTPS──► Caddy (ตัวเดียวกับ AgentHub)
                    ├── /midhub/*  → 127.0.0.1:3100  MidHub (Next.js, user: bsmmidhub)
                    └── /*         → 127.0.0.1:3000  AgentHub (เดิม)

MidHub (ไม่ใช่ root)
  ├── SQLite: Instance, MidServer, Job, ConfigBackup, AuditLog
  ├── Job runner (stage-based, resume ได้)
  ├── อ่าน/เขียนไฟล์ใน /opt/midhub/mids/<name>/ (ผ่าน group permission)
  └── Unix socket ──► midhub-helper (root, systemd unit แยก)
                        └── จัดการ systemd unit ของ MID เท่านั้น

MID แต่ละตัว = systemd unit  midhub-mid-<name>.service  รันด้วย user: midsvc
```

### 4.1 Layout บน host [ผู้ออกแบบ]

| Path | เจ้าของ | ใช้ทำอะไร |
|---|---|---|
| `/home/bsmmidhub/midhub` | bsmmidhub | repo checkout = deployment (แบบเดียวกับ AgentHub) |
| `/opt/midhub/mids/<name>/` | `midsvc:midhub`, setgid, g+rw | โฟลเดอร์ติดตั้ง MID (`<name>/agent/...`) |
| `/opt/midhub/packages/<buildstamp>.zip` | bsmmidhub | cache ของ installer แยกตามเวอร์ชัน (เก็บเฉพาะเวอร์ชันที่ยังมี MID ใช้ ดู 8.1) |
| `/opt/midhub/archive/` | bsmmidhub | archive ตอน uninstall และ backup ก่อน upgrade (เก็บเฉพาะไฟล์ที่แก้ได้ ดู 8.1) |
| `/opt/midhub/db/` | bsmmidhub 0750 | SQLite ของ MidHub (ย้ายออกจาก repo ตอน deploy Phase 1) |
| `/opt/midhub/jobs/<jobId>.jsonl` | bsmmidhub 0750 | journal ของ job (Phase 2) |
| `/opt/midhub/releases/<buildstamp>/` | root, อ่านอย่างเดียว | release ที่แชร์ระหว่าง MID ด้วย hardlink (Phase 2b, ดู 8.1) |
| `/run/midhub/helper.sock` | `root:bsmmidhub` 0660 | socket ของ helper |

- user `bsmmidhub` อยู่ใน group `midhub` เพื่ออ่านและเขียนไฟล์ของ MID ได้โดยไม่ต้องใช้ root
- MID ทุกตัวรันด้วย user `midsvc` ซึ่งไม่ใช่ root

### 4.2 midhub-helper (ใช้สิทธิ์ root)

- โปรแกรม Node/TS ตัวเล็ก อยู่ใน repo เดียวกัน (เช่น `helper/`) รันเป็น `bsm-midhub-helper.service`
- รับเฉพาะ **คำสั่งตามรายการนี้** ผ่าน JSON บน Unix socket:
  - `installUnit(name, heapMb)`: เขียน `/etc/systemd/system/midhub-mid-<name>.service` จาก template ที่ฝังอยู่ใน helper แล้วสั่ง `daemon-reload`
  - `removeUnit(name)`
  - `start|stop|restart(name)`
  - `fixOwnership(name)`: chown/chmod โฟลเดอร์ `/opt/midhub/mids/<name>` ให้เป็นค่ามาตรฐาน
- ตรวจ `name` ทุกครั้งด้วย `^[a-z0-9][a-z0-9-]{1,39}$` ประกอบ path เองจากค่าคงที่ ไม่รับ path จาก client และไม่มีคำสั่ง shell อิสระ
- จำกัดการเข้าถึงด้วยสิทธิ์ไฟล์ของ socket (`0660 root:bsmmidhub`) เพราะ Node ไม่มี SO_PEERCRED ให้ตรวจ peer credential
- **บังคับโควต้า 4 ตัวที่ helper ด้วย** ก่อน `start` และ `restart` ของตัวที่หยุดอยู่ ให้นับ unit `midhub-mid-*` ที่ active ถ้าครบ 4 แล้วให้ปฏิเสธ จะได้มีด่านกันชั้นสุดท้าย
- การอ่านสถานะ (`systemctl show ...`, `MemoryCurrent`) ไม่ต้องใช้ root เว็บอ่านเองได้

### 4.3 systemd unit ของ MID [ผู้ออกแบบ + spike]

- `User=midsvc`, `MemoryMax = heapMb + 512M`, `Restart=on-failure`
- **หลัง host reboot ให้เปิดเฉพาะ MID ที่รันอยู่ก่อน reboot** โดยสั่ง `systemctl enable` ตอน start และ `disable` ตอนผู้ใช้กด stop จำนวนที่เปิดอัตโนมัติจึงไม่เกิน 4 ตัวตามโควต้าอยู่แล้ว [ผู้ออกแบบ]
- ExecStart = `agent/bin/mid.sh console` (Tanuki wrapper แบบ foreground) และ `UMask=0002` — **ยืนยันจาก spike 2026-11-18** (`docs/spike-mid-linux.md`): รันเป็น midsvc ได้, stop ด้วย SIGTERM ปิดเรียบร้อยใน ~5 วินาที ส่วน auto-upgrade ของ MID ใต้ systemd ยังไม่ได้ทดสอบ (ต้องรอ instance upgrade)
- heap เริ่มต้น 1024 MB ตั้งผ่าน `wrapper-override.conf` [ผู้ออกแบบ]
- ข้อสังเกตเรื่อง RAM: 4 × (1 GB + 0.5 GB) + AgentHub สูงสุด 6 GB เกิน RAM จริง แต่ปกติไม่ได้ใช้ถึงเพดานพร้อมกัน ให้ dashboard แสดง RAM ทั้งเครื่องและเตือนเมื่อ RAM ว่างต่ำกว่า 1 GB ก่อนสั่ง start

## 5. หน้าจอและการใช้งาน

ภาษาของ UI: ภาษาไทยเป็นหลัก ศัพท์ ServiceNow ใช้ทับศัพท์ [ผู้ออกแบบ]

**หน้าตาเหมือน AgentHub เปลี่ยนแค่ชื่อเป็น "BSM MIDHub"** [ผู้ใช้ 2026-11-18]: ใช้ design system ของ AgentHub (`DESIGN.md` และ token ใน `app/globals.css` ของ AgentHub: สี brand navy/sky, palette blue/gray ที่ override, ฟอนต์ Inter + Noto Sans Thai, radius, ปุ่ม `btn-primary`, header แบบ `AppChrome`, dark mode) ยกเว้นธีมเทศกาลและ mascot — ภาษาของข้อความระบบยังเป็นไทยตามข้อข้างบน [ผู้ออกแบบ: ตีความ "ดีไซน์" เป็นหน้าตา ไม่ใช่ภาษา แก้ได้]

### 5.1 หน้าหลัก: รายการ + แผงรายละเอียด [ผู้ใช้เลือกแบบ B]

- **แถบด้านบน**: "กำลังรัน x/4", RAM ที่ MID ใช้รวม / RAM ทั้งเครื่อง และปุ่ม **+ สร้าง MID ใหม่**
- **ด้านซ้าย**: รายชื่อ MID พร้อมไอคอนสถานะ (🟢 กำลังรัน · ⚪ หยุด · 🟡 กำลังทำ job · 🔴 ล่ม/ผิดพลาด) และชื่อ instance
- **ด้านขวา** (เมื่อคลิกชื่อ MID): ปุ่ม Restart, Stop/Start, Upgrade, ลบ และแท็บ
  - **ภาพรวม**: instance, เวอร์ชัน (เทียบกับเวอร์ชันของ instance), สถานะ service, uptime, RAM, job ล่าสุด และลิงก์ไปที่ record ของ MID ใน instance
  - **ตั้งค่า** (5.3) · **ไฟล์** (5.4) · **Log** (5.5)
- ถ้า job กำลังทำงาน ให้แสดง progress ในแผงนี้ และปิดปุ่มที่ใช้ไม่ได้ระหว่างนั้น

### 5.2 Wizard สร้าง MID [ผู้ใช้เลือกแบบ B ทีละขั้น]

1. **Instance**: เลือกจาก demo instance ที่บันทึกไว้ หรือเพิ่มใหม่ (URL + MID user/password) แล้วกด **ทดสอบการเชื่อมต่อ** ต้องผ่านก่อนจึงไปต่อได้ ทดสอบโดยเรียก REST ด้วย user นั้น และถ้าตรวจได้ ให้ดึงเวอร์ชัน/buildstamp ของ instance มาเก็บไว้ด้วย
2. **ตั้งค่า**: ชื่อ MID (ตรวจรูปแบบและไม่ซ้ำแบบ real-time) และตัวเลือก "Clone จาก MID ที่มีอยู่" ซึ่งคัดลอก `config.xml` (ยกเว้น url/ชื่อ/credential/`mid_sys_id`), `wrapper-override.conf` และ `extlib/` — **ไม่คัดลอก `agent/security/agent_keystore`** เพราะ spike พบว่า MID สร้างไฟล์นี้เองตอน start ครั้งแรกเป็นตัวตน/กุญแจเข้ารหัสของ MID แต่ละตัว ถ้าคัดลอกจะได้ MID สองตัวที่ใช้กุญแจเดียวกัน [ผู้ออกแบบ] ส่วน "ตั้งค่าขั้นสูง" ซ่อนไว้ (proxy, heap, จำนวนไฟล์ log)
3. **ตรวจสอบ**: สรุปค่าที่กรอก, เช็ค disk ว่าง (≥ 2 GB), เช็คโควต้า 4 ตัว และเช็ค RAM ว่าง
4. **ติดตั้ง**: แสดง progress รายขั้นพร้อม log สด ปิดหน้าไปแล้วกลับมาก็ยังตามต่อได้ เมื่อเสร็จ ให้บอกขั้นต่อไปให้ชัด เช่น "ไป Validate MID ใน instance" พร้อมลิงก์

### 5.3 แท็บตั้งค่า

- **Form mode**: instance URL, MID user, password (เขียนทับได้อย่างเดียว ไม่แสดงค่าเดิม เพราะ MID เข้ารหัส password เองหลัง start), MID name, proxy (host/port/user/pass) และ heap
- **Raw mode**: Monaco editor สำหรับ `config.xml` (ตรวจว่าเป็น XML ถูกต้องก่อน save) และ `wrapper-override.conf`
- **backup ก่อน save ทุกครั้ง** ลง `ConfigBackup` มีหน้าประวัติ ดู diff และ rollback ได้
- หลัง save ให้ถามว่า "Restart เลยไหม" (ค่า config มีผลหลัง restart)

### 5.4 แท็บไฟล์

- browse, upload, download, rename, ลบ และสร้างโฟลเดอร์ได้ **เฉพาะใน `/opt/midhub/mids/<name>/`**
- resolve realpath ทุกครั้ง และปฏิเสธ symlink หรือ `..` ที่ออกนอก root
- ขนาด upload ไม่เกิน 50 MB (ตรงกับ Caddy)
- โฟลเดอร์ที่เป็นโปรแกรมของ MID (`agent/bin`, `agent/lib`, `agent/jre`) **อ่านได้อย่างเดียว** ใน file manager เพื่อไม่ให้แทนที่ binary จนกลายเป็นช่องรันโค้ดได้ง่าย ๆ [ผู้ออกแบบ]
- แก้ไฟล์ text ได้ผ่าน Monaco ส่วนไฟล์ binary ให้ download/replace ได้อย่างเดียว
- ปรับมาจาก `lib/session/file-manager.ts` และ `components/FileBrowser.tsx` ของ AgentHub

### 5.5 แท็บ Log

- tail `agent/logs/agent0.log.0` แบบ real-time ผ่าน SSE และเลือกดู `wrapper.log` ได้
- filter ERROR/WARN, ค้นหาข้อความ, หยุดหรือเลื่อนต่อ และ download ไฟล์ log

### 5.6 หลักการเรื่องใช้ง่าย [ผู้ออกแบบ]

- action ที่ทำให้ MID หยุดต้องกดยืนยัน ส่วนการลบต้องพิมพ์ชื่อ MID ซ้ำ
- error ต้องบอกสาเหตุและวิธีแก้ เช่น "login ไม่ผ่าน: เช็คว่า user มี role mid_server" ไม่แสดง stack trace (ให้กดดูรายละเอียดได้)
- ปุ่มที่ใช้ไม่ได้ต้องบอกเหตุผล เช่น "รันครบ 4 ตัวแล้ว ให้หยุดตัวอื่นก่อน"

## 6. Authentication (บัญชีแยก ใช้ SSO ตัวเดียวกับ AgentHub)

- **MidHub มีบัญชีผู้ใช้และ session ของตัวเอง** แยกจาก AgentHub และ **ใช้ IdP (OIDC) ตัวเดียวกับ AgentHub** [ผู้ใช้] จึงไม่ต้องแก้ AgentHub เลย
- ตั้งค่า SSO ด้วยการเพิ่ม redirect URI ของ MidHub (`https://<host>/midhub/api/auth/oidc/callback`) ใน app registration เดิมของ IdP หรือสร้าง app registration ใหม่ก็ได้ ค่า issuer, client id และ secret ตั้งผ่านหน้า admin ของ MidHub (copy `IdpConfig` + `IdpConfigManager` มาจาก AgentHub) [ผู้ออกแบบ]
- copy auth ของ AgentHub มาใช้: `lib/auth/jwt.ts`, `session.ts`, `helpers.ts`, `oidc.ts`, `lockout.ts`, `auth-log.ts`, `login-next.ts` แต่ใช้ **`JWT_SECRET` ของ MidHub เอง**, issuer `bsm-midhub/session`, idle timeout 4 ชม. แบบ sliding window
- cookie ชื่อ `midhub_session` และ `Path=/midhub` ไม่ให้ชนกับ cookie `session` ของ AgentHub ที่อยู่บน host เดียวกัน [ผู้ออกแบบ]
- **ใครเข้าได้** [ผู้ออกแบบ แก้ได้]: เข้าด้วย SSO ได้เฉพาะ email ที่ Admin เพิ่มไว้ในหน้า Users เท่านั้น MidHub จะไม่สร้างบัญชีอัตโนมัติให้ทุกคนที่ผ่าน IdP (ต่างจาก `findOrCreateSsoUser` ของ AgentHub) เพราะ MidHub แก้ config และ upload ไฟล์ลง MID บนเครื่องได้
- **Admin คนแรก** seed จาก env (`ADMIN_EMAIL`, `ADMIN_PASSWORD`) และใช้ local password login ได้เป็นทางสำรองตอน SSO ล่ม เหมือน AgentHub
- **สิทธิ์**: Admin จัดการ users, IdP, IP allowlist, ลบ MID และลบหรือแก้ instance ที่บันทึกไว้ ส่วน Member ทำอย่างอื่นได้ทั้งหมด **รวมถึงเพิ่ม instance ใหม่ใน wizard** [ผู้ออกแบบ]
- **IP allowlist**: copy `IpAllowlist` + `IpAllowlistManager` และการตรวจใน `proxy.ts` มาจาก AgentHub ใช้ตารางของ MidHub เอง ส่วน maintenance mode ไม่ต้องมี [ผู้ออกแบบ]

## 7. Data model (Prisma, SQLite) [ผู้ออกแบบ]

- **Instance**: `id, label, url, midUser, midPasswordEnc, buildstamp?, createdBy, createdAt` เข้ารหัส password ด้วย vault key ของ MidHub เอง (`MIDHUB_VAULT_KEY`) ตามแบบ `lib/services/instance-connection.ts`
- **MidServer**: `id, name (unique), instanceId, dir, serviceName, heapMb, version?, state (installing|installed|upgrading|uninstalling|removed|error), createdBy, createdAt, removedAt?`
- **Job**: `id, midId, kind (install|clone|upgrade|uninstall), stage, status (queued|running|succeeded|failed|rolled_back), params JSON, journalPath, error?, createdBy, startedAt, finishedAt`
- **ConfigBackup**: `id, midId, file, content, note, createdBy, createdAt`
- **User**, **IdpConfig**, **IpAllowlist**: ใช้โครงเดียวกับ AgentHub (ตัดฟิลด์ที่ไม่ใช้)
- **AuditLog**: `id, at, userId, email, action, midId?, detail JSON`
- สถานะ running/stopped และ RAM อ่านจาก systemd ตอนเรียกดู ไม่เก็บลง DB

## 8. Jobs (install / upgrade / uninstall)

- มีได้ **1 job ต่อ MID ต่อครั้ง** และตรวจโควต้า 4 ตัวตอนเข้า stage ที่จะ start
- แต่ละ stage **ทำซ้ำได้ (idempotent)** บันทึกชื่อ stage ลง DB **ก่อน** เริ่มทุกครั้ง และเขียน progress เป็น JSONL ลง `journalPath` แล้ว stream ให้ UI ผ่าน SSE
- ตอน MidHub boot ให้หา job ที่ status `running` แล้วทำต่อจาก stage ที่บันทึกไว้ (แนวคิดเดียวกับ `recoverRuns()`/`compactStage` ของ AgentHub แต่รันใน process ของ MidHub ได้ ไม่ต้อง detached) [ผู้ออกแบบ]

**Install / Clone**
`precheck → fetchPackage → extract → configure → (clone: copyFiles) → fixOwnership → installUnit → start → waitConnected`
- `fetchPackage`: ดาวน์โหลด Linux MID package ที่ตรงกับ buildstamp ของ instance แล้ว cache ไว้ที่ `packages/<buildstamp>.zip` — **จาก spike**: host ออก `install.service-now.com:443` ได้ และ URL คือ `https://install.service-now.com/glide/distribution/builds/package/app-signed/mid/<YYYY>/<MM>/<DD>/mid.<buildstamp>.linux.x86-64.zip` โดย `<YYYY>/<MM>/<DD>` มาจากวันที่ชุดสุดท้าย (`MM-DD-YYYY`) ใน buildstamp และ buildstamp อ่านจาก `sys_properties.glide.war` (ตัด `glide-` และ `.zip`) [spike ✅]
  - ถ้าอ่าน buildstamp จาก instance ไม่ได้ (เช่น user ที่มีแค่ role `mid_server` อ่าน `sys_properties` ไม่ได้) ให้ wizard เลือกจาก package ที่ cache ไว้ หรือให้กรอก buildstamp เอง (ตรวจรูปแบบ) **ตัดการ upload zip เองออกจาก v1** เพราะ host ออก internet ได้ และ zip ใหญ่ ~490 MB เกินที่ผ่าน proxy ได้ [ผู้ออกแบบ]
- `extract`: แตก zip เป็น user ของแอป (bsmmidhub, group midhub) ลง `mids/<name>/` แล้วให้ helper `fixOwnership` เปลี่ยนเป็น `midsvc:midhub` — **จาก spike**: ไม่ต้องใช้ `installer.sh`/`configure.sh` เลย (installer ใช้แค่ sed แก้ config.xml แล้วสร้าง service ของตัวเอง ซึ่งเราไม่ต้องการ) ตรวจ entry ใน zip ก่อนแตก: ห้ามมี path ที่ออกนอกปลายทาง และห้ามมี symlink [spike ✅]
- `configure`: เขียน `config.xml` (url, mid.instance.username/password, name, proxy) ด้วย `setParams`, heap ใน `wrapper-override.conf` และค่าจำนวนไฟล์ log (ดู 8.1) เองโดยตรง — proxy ใน template อยู่ในคอมเมนต์ จึงต้อง append element ใหม่ [spike ✅]
- `waitConnected`: รอจนใน `agent/logs/agent0.log.0` มีบรรทัด `MID Server is connected to instance host:` ที่เกิด **หลัง** เวลาที่สั่ง start (timeout 5 นาที) [spike ✅]
- ถ้าล้มเหลว: หยุดที่ stage นั้น แสดงสาเหตุและปุ่ม "ลองใหม่" (ทำต่อจาก stage เดิม) หรือ "ยกเลิกและลบ"

**Upgrade (ด้วยมือ)**
`precheck → fetchPackage → stop → backup(tar.gz) → extractToTemp → carryOver → swap → start → waitConnected` ถ้าล้มเหลวหลัง `swap` ให้ **rollback อัตโนมัติ** จาก backup แล้ว start ตัวเดิม
- `carryOver`: `config.xml`, `conf/wrapper-override.conf`, `extlib/`, `security/` (มี `agent_keystore` ที่ MID สร้างเอง) และไฟล์ที่ผู้ใช้เพิ่มเอง [spike: รายการเบื้องต้นจากสิ่งที่ MID สร้าง ยังต้องยืนยันกับ upgrade จริง]
- auto-upgrade ปกติของ MID ยังเปิดอยู่ หน้าภาพรวมจะเตือนเมื่อเวอร์ชันไม่ตรงกับ instance เกิน 30 นาที [ผู้ออกแบบ]

**Uninstall** (Admin เท่านั้น)
`confirm(พิมพ์ชื่อ) → stop → removeUnit → archive(tar.gz ไป /opt/midhub/archive) → deleteDir → mark removed`
- archive เก็บเฉพาะไฟล์ที่แก้ได้ (ดู 8.1) และเก็บ 30 วันแล้วลบอัตโนมัติ [ผู้ออกแบบ]
- ไม่ลบ record ของ MID ในฝั่ง instance (ต้องใช้สิทธิ์ admin ของ instance) แต่แสดงลิงก์ให้ไปลบเองพร้อมข้อความเตือน [ผู้ออกแบบ]
- "ยกเลิกและลบ" ของ install ที่ล้มเหลวใช้ขั้นตอนเดียวกันแต่ไม่ทำ archive และ Member ที่สร้าง job นั้นกดเองได้ (เพราะ MID ยังไม่เคยใช้งาน) [ผู้ออกแบบ]

### 8.1 การประหยัดพื้นที่ดิสก์ [ผู้ใช้ขอ · ผู้ออกแบบเสนอ]

วัดจาก MID จริงตอน spike (build australia patch 7):

| ส่วน | ขนาด |
|---|---|
| `agent/lib` | 431 MB |
| `agent/jre` | 107 MB |
| ส่วนอื่นตอนติดตั้งใหม่ | ~5 MB |
| log สูงสุดตามค่า default (agent + security + wrapper อย่างละ 10 × 10 MB) | ~300 MB |
| **รวมต่อ MID** | **~540 MB ตอนติดตั้ง, สูงสุด ~850 MB** |
| zip ต่อเวอร์ชัน | ~470 MB |

ข้อจำกัด: root fs เป็น ext4 (ไม่มี reflink) และ LVM ไม่มีพื้นที่ว่าง (VFree 0) จึงทำ volume XFS/btrfs แยกไม่ได้ถ้าไม่เพิ่มดิสก์

**ทำใน Phase 2**
1. **archive/backup เฉพาะไฟล์ที่แก้ได้**: `agent/config.xml`, `agent/conf/`, `agent/extlib/`, `agent/security/`, `agent/properties/`, `agent/logs/` — ไม่เก็บ `lib/`, `jre/`, `bin/` เพราะดึงจาก package ได้ (archive จาก ~500 MB เหลือไม่กี่ MB)
2. **จำกัดจำนวนไฟล์ log ตั้งแต่ติดตั้ง** (ค่าเริ่มต้น 3, ปรับได้ 1–10 ใน "ตั้งค่าขั้นสูง"): `wrapper.logfile.maxfiles` ใน `conf/wrapper-override.conf` และ `com.service_now.mid.logging.MIDLogFileHandler.count` / `SecurityLogFileHandler.count` ใน `agent/properties/glide.properties` (log สูงสุด ~300 → ~90 MB ต่อ MID)
3. **เก็บ package เฉพาะเวอร์ชันที่ยังมี MID (ที่ยังไม่ถูกลบ) หรือ job ที่ค้างอยู่ใช้** ลบที่เหลือหลัง install/uninstall สำเร็จ และตอน boot
4. แสดงพื้นที่ที่ MidHub ใช้ (`/opt/midhub` แยก mids/packages/archive) และพื้นที่ว่างที่ top bar, precheck ยังต้องการ ≥ 2 GB

**Phase 2b (หลัง spike ทดสอบ auto-upgrade ผ่าน)**
5. **แชร์ release ด้วย hardlink**: แตก package ครั้งเดียวที่ `/opt/midhub/releases/<buildstamp>/` (root, อ่านอย่างเดียว) แล้วให้ helper op ใหม่ `linkRelease(name, buildstamp)` สร้าง hardlink ของ `agent/lib`, `agent/jre`, `agent/bin` เข้า MID (ไฟล์อื่น copy จริง) — MID ตัวที่ 2 เป็นต้นไปของ build เดียวกันใช้ ~10 MB + log แทน ~540 MB และ hardlink เป็นไฟล์ปกติภายในโฟลเดอร์ MID จึงไม่ชน sandbox ของแท็บไฟล์ (symlink จะชน)
   - เงื่อนไข: ต้องยืนยันว่า auto-upgrade ของ MID **แทนที่ไฟล์** (ได้ inode ใหม่ → hardlink แยกเอง) ไม่ใช่เขียนทับในที่เดิม ถ้าเขียนทับจะล้มเพราะไฟล์เป็นของ root → ทางสำรองคือปิด auto-upgrade แล้วใช้ upgrade ของ MidHub (Phase 3)
   - เปิดด้วย env `MIDHUB_SHARED_RELEASES=1` (ค่าเริ่มต้นปิด)

**ไม่ทำ**: overlayfs (ต้อง mount ต่อ MID ทุกครั้งที่ start ซับซ้อนเกินคุ้มใน v1), ลบ jar ใน `lib/` ที่ดูไม่จำเป็น (ไม่ supported และ upgrade จะใส่กลับ)

## 9. Deploy [ผู้ออกแบบ]

- ทำตามแบบ AgentHub: repo checkout คือ deployment, `bsm-midhub.service` (User=bsmmidhub, `HOSTNAME=127.0.0.1`, `PORT=3100`, `ProtectSystem=strict`, `ReadWritePaths=/home/bsmmidhub/midhub /opt/midhub`, `ExecStartPre=prisma migrate deploy`)
- เพิ่ม `bsm-midhub-helper.service` ที่รันเป็น root, socket อยู่ที่ `/run/midhub/` (`RuntimeDirectory=midhub`)
- เพิ่ม block `handle /midhub/*` ใน Caddyfile ของ AgentHub โดยใช้ `header_up X-Forwarded-For {remote_host}` เหมือนเดิม
- `deploy/install.sh` สร้าง user/group (`bsmmidhub`, `midsvc`, `midhub`) และโฟลเดอร์ใน `/opt/midhub` แล้วติดตั้ง unit ทั้งสอง
- `.env.local`: `DATABASE_URL`, `JWT_SECRET` (ของ MidHub เอง), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `MIDHUB_VAULT_KEY`, `MIDHUB_ROOT=/opt/midhub`, `MIDHUB_MAX_RUNNING=4`
- **pipeline แบบเดียวกับ AgentHub** [ผู้ใช้ 2026-11-18]: `scripts/build.sh` (next build + helper build), `scripts/deploy.sh` (git pull --ff-only → npm ci → build → prisma migrate deploy → install helper copy → restart services, idempotent) และ `deploy/golive-gates.sh` (ตรวจอัตโนมัติ PASS/FAIL/MANUAL: services active, helper socket 0660, protected_hardlinks, SQLite WAL, native modules, /midhub ตอบ login, /midhub/api/agent ปิดจากภายนอก, AgentHub ยังตอบ)

## 10. ลำดับการทำ

0. **Spike บนเครื่องจริง** (ทำด้วยมือ ไม่ต้องเขียนโค้ด): ติดตั้ง MID 1 ตัวโดยเขียนไฟล์ config เองและใช้ systemd unit ของเรา แล้วตอบทุกข้อที่มีป้าย [spike] ในเอกสารนี้ บันทึกผลลง `docs/spike-mid-linux.md`
1. **แกนหลัก**: auth (local + SSO + users + IP allowlist), layout หน้าหลัก, helper (start/stop/restart + โควต้า), รายการและสถานะ, แท็บตั้งค่า, ไฟล์ และ Log, audit log ในช่วงนี้ให้ import MID ที่ติดตั้งด้วยมือจาก spike เข้ามาใช้ทดสอบ
2. **วงจรชีวิต**: instance ที่บันทึกไว้, wizard install/clone, job engine และ uninstall รวมการประหยัดดิสก์ข้อ 1–4 ใน 8.1
   - 2b. แชร์ release ด้วย hardlink (8.1 ข้อ 5) หลังทดสอบ auto-upgrade
3. **Upgrade**: เทียบเวอร์ชัน, manual upgrade และ rollback

## 11. เรื่องที่ให้ผู้ build ตัดสินใจเอง

- โครงสร้างโฟลเดอร์ในโค้ด, ชื่อ API route และ component
- รายละเอียดหน้าตา ใช้ AgentHub เป็นต้นแบบ
- โปรโตคอลบน Unix socket ของ helper (แนะนำ JSON 1 บรรทัดต่อ request) โดยยังรักษาข้อจำกัดในหัวข้อ 4.2
- การ copy โค้ดจาก AgentHub (copy มาแล้วตัดส่วนที่ไม่ใช้ ไม่ทำเป็น shared package)
- รูปแบบการทดสอบ (Vitest) โดยต้องมี test สำหรับ path traversal, การตรวจชื่อใน helper, โควต้า 4 ตัว และการ resume job
