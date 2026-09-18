# MacBook M4 16 GB — แก้ปัญหา RAM ไม่พอจนโปรแกรมค้าง

โจทย์: เครื่องออฟฟิศ M4 / 16 GB ต้องเปิด Chrome, Ghostty, VS Code, Google Chat, Gather,
Docker, Lens, Beekeeper, Finder และรัน Terraform พร้อมกัน → RAM ไม่พอ → not responding บ่อย

เงื่อนไข: ไม่ซื้อเครื่องใหม่ ไม่เปลี่ยน workflow ไม่เพิ่มความยุ่งยากรายวัน

## TL;DR

ทำครั้งเดียว 15 นาที แล้วปล่อยให้ระบบดูแลตัวเอง:

```bash
# 1) ติดตั้ง (ต้องมี jq: brew install jq)
cp tools/macbook-ram-optimizer/ramctl ~/.local/bin/ramctl && chmod +x ~/.local/bin/ramctl
ramctl install          # ติดตั้ง + เปิด watchdog แจ้งเตือนก่อนเครื่องจะค้าง

# 2) ปรับค่าแอปหนัก ๆ ครั้งเดียว (มี backup ให้ทุกไฟล์)
ramctl setup --dry-run  # ดูก่อนว่าจะแก้อะไร
ramctl setup            # แก้จริง: Docker VM 4 GB, VS Code watcher/tsserver, terraform plugin cache

# 3) ใช้ประจำวัน (ตอนมี notification เด้ง หรือรู้สึกว่าเริ่มหน่วง)
ramctl status           # ใครกิน RAM + ควรทำอะไร
ramctl quit-idle        # ปิด Lens / Beekeeper / Gather ที่เปิดทิ้งไว้แต่ไม่มีหน้าต่าง
```

ผลที่คาดหวัง: steady state ลดจาก ~20-27 GB demand เหลือ ≤ 12 GB, memory pressure อยู่โซนเขียว,
swap used < 1 GB, beachball หายไปแทบหมด

## 1. ปัญหาจริง ๆ คืออะไร

macOS ไม่ค้างเพราะ "RAM ใช้เต็ม 16 GB" (มันควรเต็มอยู่แล้ว macOS เอา RAM ที่เหลือมาทำ cache)
มันค้างเพราะ **memory pressure สูง**: ต้องบีบอัด (compressed) และ swap ลง SSD ตลอดเวลา
ทุกครั้งที่สลับแอป kernel ต้องคลาย/โหลดหน้ากลับ → UI ไม่ตอบสนอง

ประมาณการความต้องการ RAM ของชุดแอปที่เปิดทิ้งไว้:

| แอป | RAM โดยประมาณ | หมายเหตุ |
|---|---|---|
| macOS + WindowServer + wired | 3–4 GB | ลดไม่ได้ |
| Chrome (30+ tabs, extensions, Google Chat PWA) | 3–5 GB | tab ละ process |
| Docker Desktop VM | **ค่า default = 8 GB** (50% ของเครื่อง) | ตัวการอันดับ 1 |
| VS Code (2 windows, tsserver, terraform-ls, extensions) | 1.5–3 GB | window ละ extension host |
| Lens | 0.8–1.5 GB | Electron + kube watch |
| Gather | 0.6–1.2 GB | Electron + WebRTC |
| Beekeeper Studio | 0.4–0.8 GB | Electron |
| Terraform (CLI + providers ตอน plan) | 0.5–2 GB | provider ละ process, aws ตัวเดียว ~0.5 GB |
| Ghostty, Finder | ~0.3 GB | เบา |
| **รวม** | **~20–27 GB** | บนเครื่อง 16 GB |

ข้อสังเกตสำคัญ: Lens, Gather, Beekeeper, VS Code, Google Chat (ใน Chrome) ล้วนเป็น
**Chromium/Electron** แต่ละตัวมี browser process + GPU process + network + renderer ของตัวเอง
ก่อนจะเปิดเนื้อหาอะไรเลยก็กินไปตัวละ 300–500 MB แล้ว

## 2. หลักการออกแบบ

แก้ 3 ชั้น เรียงตาม "GB ที่ได้คืน ÷ ความยุ่งยาก":

| ชั้น | ทำอะไร | ได้คืน | ยุ่งยาก |
|---|---|---|---|
| **A. จำกัดตัวกินหลัก** | Docker VM cap 4 GB + Resource Saver, Chrome Memory Saver, VS Code watcher/tsserver | 5–8 GB | ตั้งครั้งเดียว |
| **B. ตัด baseline ที่ไม่ได้ใช้** | login items / updater agents, Electron apps ที่เปิดทิ้ง | 1–3 GB | ตั้งครั้งเดียว + 1 คำสั่งเมื่อจำเป็น |
| **C. Early warning** | watchdog แจ้งเตือนเมื่อ free < 12% พร้อมบอกว่าใครกิน | ป้องกัน beachball | ไม่ต้องทำอะไร |

สิ่งที่ตั้งใจ **ไม่ทำ**: ไม่ปิด swap, ไม่ใช้แอป "memory cleaner", ไม่ให้ watchdog ปิดแอปเอง
(กันการเสียงานกลางคัน) — มันแค่แจ้งและบอกคำสั่งที่ควรรัน

## 3. รายละเอียดแต่ละแอป

### Docker Desktop (ตัวการอันดับ 1)

- Default บน Apple Silicon จอง VM ได้ถึง **50% ของ RAM = 8 GB** และ VM ไม่คืน RAM ให้ host ง่าย ๆ
- `ramctl docker tune` ตั้ง Memory 4096 MiB / CPUs 4 / Swap 1024 MiB ลงใน
  `~/Library/Group Containers/group.com.docker/settings-store.json` (หรือ `settings.json` รุ่นเก่า)
  โดยใช้ชื่อ key ตามที่มีอยู่ในไฟล์จริง มี backup ให้ และต้อง restart Docker หนึ่งครั้ง
- ตรวจว่า **Resource Saver** เปิดอยู่ (default เปิดตั้งแต่ 4.24): เมื่อไม่มี container รัน 5 นาที
  VM จะหยุดและคืน RAM เกือบทั้งหมด → เลิกนิสัย "เปิด container ทิ้งไว้เผื่อใช้"
- ถ้างานปกติ container ใช้ไม่ถึง 4 GB (dev DB + 2-3 services) ค่านี้พอ ถ้าไม่พอปรับใน
  `~/.config/ramctl/config` แล้วรันใหม่
- **ทางเลือกที่ดีกว่า**: [OrbStack](https://orbstack.dev) ใช้ `docker` CLI เดิมทุกอย่าง แต่ VM
  ใช้ RAM แบบ dynamic, idle ~100 MB, มี Kubernetes ในตัว ประหยัดกว่า Docker Desktop อีก 2–4 GB
  (ต้องเช็ค license เพราะใช้งานเชิงพาณิชย์ต้องซื้อ) — Colima เป็นทางเลือกฟรี

### Chrome

- `chrome://settings/performance` → **Memory Saver = Maximum** (tab ที่ไม่ได้ดูจะถูก discard
  และโหลดกลับเมื่อคลิก) และใส่ site ที่ต้องการให้ active ตลอด เช่น Google Chat, Gather ไว้ใน
  "Always keep these sites active"
- `chrome://extensions` ปิด extension ที่ไม่ได้ใช้ทุกวัน (แต่ละตัว = 1 process + inject ทุก tab)
- `chrome://settings/system` ปิด "Continue running background apps when Google Chrome is closed"
- Google Chat ให้เปิดเป็น PWA ใน Chrome (ที่ใช้อยู่แล้ว) ไม่ต้องหาแอปแยก
- นิสัยที่ช่วยมากโดยไม่ต้องคิด: ใช้ **Tab Groups + ยุบกลุ่ม** แทนเปิดหน้าต่างใหม่

### VS Code

- `ramctl vscode tune` merge ค่าเข้า `settings.json` (ดู `vscode-settings.json`):
  - `files.watcherExclude` / `search.exclude` สำหรับ `node_modules`, `.terraform`, `dist`, `.venv`
    → โฟลเดอร์ `.terraform` มี provider binary หลายร้อย MB การ watch มันเปลืองทั้ง RAM และ CPU
  - `typescript.tsserver.maxTsServerMemory: 2048` (default 3072)
  - จำกัด editor ที่เปิดค้าง 12 tab ต่อ group (tab เก่าถูกปิดอัตโนมัติ ไม่กระทบไฟล์ที่แก้ค้าง)
- ทำเองครั้งเดียว: extension ที่ไม่เกี่ยวกับ repo นั้น → คลิกขวา → **Disable (Workspace)**
- เปิด **1 window ต่อครั้ง** ใช้ multi-root workspace ถ้าต้องดูหลาย repo (window ละ 1 extension host + 1 renderer)
- ถ้าใช้ HashiCorp Terraform extension กับ repo ใหญ่ ให้เพิ่ม
  `"terraform.languageServer.indexing.ignorePaths": ["**/.terraform/**"]`
- terminal ใช้ Ghostty ที่เปิดอยู่แล้ว ไม่ต้องเปิด integrated terminal หลาย tab

### Lens / Beekeeper / Gather (Electron ที่เปิดทิ้ง)

- Lens ใช้บางครั้ง → ปิดเมื่อไม่ใช้ งาน routine (ดู pod, log, exec) ใช้ `k9s` ใน Ghostty แทน
  (`brew install k9s`, ~50 MB vs ~1 GB)
- Beekeeper: result set ใหญ่ ๆ ค้างใน tab กิน RAM ปิด tab query ที่ไม่ใช้ หรือ quit เมื่อไม่ใช้
- Gather: ถ้าเปิด desktop app ทิ้งไว้ทั้งวัน ลองเปิดใน **Chrome tab** แทน — ใช้ GPU/network process
  ร่วมกับ Chrome ประหยัดไป 1 ชุด (ถ้า screen share ใน browser ใช้ได้ดีพอ)
- `ramctl quit-idle` ปิดแอปในรายการนี้ให้เมื่อ **ไม่มีหน้าต่างเปิดอยู่** (เปิดทิ้งไว้ใน Dock เฉย ๆ)
  ถ้า macOS ไม่ให้สิทธิ์ตรวจหน้าต่าง จะถามยืนยันทีละตัว

### Terraform

- `ramctl setup` ตั้ง `plugin_cache_dir` ใน `~/.terraformrc` → `init` เร็วขึ้นและไม่ดาวน์โหลด
  provider ซ้ำทุก workspace (ประหยัด disk/เวลา)
- ตอน plan/apply บน state ใหญ่: `terraform plan -parallelism=5` (default 10) ลด peak memory
  ของ provider ลงครึ่งหนึ่ง แลกกับช้าลงเล็กน้อย ใช้เฉพาะตอนเครื่องตึง
- process `terraform-provider-*` ค้างหลัง plan ล้มเหลว เกิดได้ `ramctl status` จะบอกให้ `pkill`

### macOS

- `ramctl audit` แสดง login items + LaunchAgents/Daemons ที่ไม่ใช่ของ Apple → ปิด updater/helper
  ที่ไม่จำเป็น (System Settings → General → Login Items & Extensions)
- ตั้ง Lens, Beekeeper, Docker ให้ **ไม่เปิดตอน login** เปิดเองเมื่อจะใช้
- Spotlight: System Settings → Siri & Spotlight → เอาโฟลเดอร์ที่มี `node_modules`/`.terraform`
  ออกจากการ index (ลด `mds_stores` ช่วงบ่าย ๆ)
- อย่าปิด swap อย่า `sudo purge` (มันล้างแค่ file cache ไม่ช่วยและทำให้ช้าลง)

## 4. Watchdog ทำงานอย่างไร

- launchd agent `com.ramctl.watchdog` รัน `ramctl watchdog check` ทุก 60 วินาที (nice 10, low-priority IO
  กิน RAM ~ไม่กี่ MB ระหว่างรัน แล้วจบ)
- อ่าน `memory_pressure` (ตัวเลขเดียวกับ Activity Monitor) ถ้า free < **12%** และยังไม่เตือนใน 10 นาทีที่ผ่านมา
  → macOS notification: `RAM เหลือ 9% — ใกล้ค้าง` พร้อม top 3 แอปที่กิน
- log ที่ `~/Library/Logs/ramctl-watchdog.log` (rotate เองที่ 1 MB) เอาไว้ดูย้อนหลังว่า
  เวลาไหน/แอปไหนทำให้ตึง เช่น "ทุกครั้งที่ plan โปรเจกต์ X"
- ปรับ threshold/cooldown ได้ที่ `~/.config/ramctl/config` มีผลทันที

## 5. Daily flow (ไม่ต้องเปลี่ยนนิสัย)

1. ทำงานตามปกติ
2. มี notification "RAM เหลือ N%" → เปิด Ghostty → `ramctl status`
3. ทำตาม 1 บรรทัดที่มันแนะนำ (ส่วนใหญ่คือ `ramctl quit-idle` หรือปิด tab Chrome สักกลุ่ม)
4. จบ — ไม่ต้องรอให้ค้างแล้วค่อย force quit

## 6. วัดผล

ก่อน/หลัง ให้ดู 3 ค่านี้จาก `ramctl status` ช่วงบ่ายที่เปิดครบทุกแอป:

| ตัวชี้วัด | ก่อน (คาด) | เป้าหมาย |
|---|---|---|
| memory free % | < 10% (แดง) | ≥ 20% (เขียว) |
| swap used | 2–5 GB | < 1 GB |
| compressed | 3–5 GB | < 2 GB |

## 7. ไฟล์ในโฟลเดอร์นี้

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `ramctl` | script หลัก (bash, ไม่มี dependency นอกจาก `jq` สำหรับ setup) |
| `vscode-settings.json` | ค่าที่ `ramctl vscode tune` merge เข้า settings.json (เอาไปวางเองก็ได้) |
| `launchd/com.ramctl.watchdog.plist` | ตัวอย่าง launchd agent ที่ `ramctl watchdog install` สร้าง (แทน `__HOME__`) |

ถอดทั้งหมด: `ramctl watchdog uninstall && rm ~/.local/bin/ramctl` และคืนไฟล์ `.bak.*`
ของ Docker/VS Code ถ้าต้องการ
