# Development Stages & Implementation Roadmap: Antigravity Discord Rich Presence

- **Tanggal:** 2026-11-11
- **Branch:** `feat/discord-rpc-enhancements`
- **Referensi Utama:** [Edge Cases & Feature Options](./2026-11-11-edge-cases-and-feature-options.md)

---

## 1. Prinsip Pengurutan Tahapan (Dependency & Risk Analysis)

Untuk menghindari *rework*, regresi, maupun payload ditolak oleh protokol Discord RPC, urutan implementasi disusun berdasarkan dependensi teknis:

1. **Reliability & Protocol Compliance Terlebih Dahulu:** Saat ini terdapat beberapa celah mendasar di codebase: environment variable pada `README.md` belum dibaca oleh `src/daemon.ts`, event cold-start pertama berpotensi hilang saat `spawnDaemon()`, belum ada pembatasan panjang karakter Discord RPC (`128`/`32`/`512`), dan test suite (`tests/ipc.test.ts`, `tests/dispatch.test.ts`) gagal dengan `EADDRINUSE` jika daemon aktif berjalan. Semua fitur baru bergantung pada perbaikan fondasi ini.
2. **Isolasi State & Privasi Sebelum Fitur Visual:** Multi-workspace isolation dan tier privasi menentukan struktur data `PresenceStateMachine` dan aturan penyensoran sebelum fitur ikon tech stack atau dual-button memformat teks akhir.
3. **Ekspresi Visual & Konteks (User-Facing UX):** Tech stack detection dan dual-action buttons dibangun di atas state machine yang sudah terisolasi dan aman dari batas karakter.
4. **Ekstensi Asinkron Ekosistem:** Integrasi webhook untuk tugas jangka panjang bersifat opsional dan dapat ditambahkan paling akhir tanpa mengganggu jalur utama IPC/RPC.

---

## 2. Tahapan Implementasi (5 Stages)

### Stage 1: Foundation Hardening, Spec Compliance & Test Isolation
> **Target Rilis:** `v1.1.0-alpha` / Patch Stabilitas Inti  
> **Mengatasi:** Opsi 5 + Edge Cases #1, #2, #3, #4, #6, #7, #8b, #9, #11b, #12

Fokus utama tahap ini adalah memperbaiki bug/gap yang sudah ditemukan di codebase dan memastikan kepatuhan penuh terhadap batasan protokol Discord RPC.

#### Pekerjaan Teknis:
1. **Parity Config Loader (`src/types.ts`, `src/daemon.ts`):**
   - Implementasikan helper `loadConfigFromEnv()` agar `RpcDaemon` saat dijalankan langsung (`isDirectRun`) membaca `AGY_DISCORD_CLIENT_ID`, `AGY_DISCORD_PRIVACY_MODE`, `AGY_DISCORD_IDLE_TIMEOUT`, dan `AGY_DISCORD_SHOW_REPO_BUTTON` (bukan hanya `DEFAULT_CONFIG`).
2. **Isolasi IPC pada Unit/Integration Test (`tests/ipc.test.ts`, `tests/dispatch.test.ts`):**
   - Gunakan jalur pipe/socket unik per test suite (via `AGY_IPC_PATH` berbasis `process.pid`/random suffix) sehingga `npm test` selalu lolos meski plugin daemon production sedang berjalan di background.
3. **Discord RPC Payload Guard & Truncation (`src/sanitizer.ts`, `src/state.ts`):**
   - Tambahkan helper pemotong string aman (misal `truncateRpcField(value, maxLen)`):
     - `details`, `state`, `largeImageText`, `smallImageText` maksimal **128 karakter** (minimal 2 karakter jika terisi).
     - `button.label` maksimal **32 karakter**; `button.url` maksimal **512 karakter** dengan validasi skema `http:` / `https:`.
   - Lewatkan `args.toolSummary` pada `mapToolToAction()` melalui `sanitizeCommand()` agar secret tidak lolos saat `privacyMode = false`.
4. **Zero-Loss Cold Start (`src/dispatch.ts`, `src/daemon.ts`):**
   - Saat `!delivered`, kirim payload awal ke proses daemon yang di-spawn (misal via env `AGY_INITIAL_PAYLOAD` atau argumen CLI `--initial-payload`) agar event `SessionStart`/`PreInvocation` pertama tidak terbuang.
5. **Resiliensi Koneksi Discord & Watchdog (`src/daemon.ts`, `src/ipc.ts`):**
   - Tambahkan *background reconnect loop* dengan *exponential backoff* ketika Discord Desktop dibuka terlambat atau socket terputus akibat OS sleep/wake.
   - Evaluasi dan sesuaikan strategi rate-limit debounce untuk menghadapi *rapid tool burst* tanpa terkena *silent drop* dari Discord.
   - Tambahkan *Inactivity Auto-Shutdown Watchdog* (misal berhenti graceful setelah 60 menit berada di status `IDLE` atau `STOPPED`) untuk mencegah zombie process.
6. **Audit `hooks.json`:**
   - Pastikan tidak terjadi eksekusi ganda akibat duplikasi root group (`"discord-presence"` dan `"antigravity-discord-presence"`), serta evaluasi penambahan event `"SessionEnd"` jika didukung oleh Antigravity App.

#### Definition of Done (DoD):
- `npm test` berjalan hijau (100% pass) ketika Antigravity App aktif menggunakan plugin ini.
- Payload melebihi 128 karakter terpotong rapi tanpa error RPC.
- Daemon mati otomatis setelah periode inaktif panjang dan menyala kembali dengan membawa payload awal tanpa kehilangan event pertama.

---

### Stage 2: Multi-Workspace Isolation & Swarm "Party" Architecture
> **Target Rilis:** `v1.1.0`  
> **Mengatasi:** Opsi 1 + Edge Cases #8a, #10

Fokus tahap ini adalah membuat `PresenceStateMachine` sadar terhadap batas workspace dan menonjolkan kemampuan multi-agen (Swarm/Subagent) milik Antigravity.

#### Pekerjaan Teknis:
1. **Workspace-Scoped Context (`src/state.ts`):**
   - Pindahkan penyimpanan `cwd`, `gitInfo`, dan `startTimestamp` dari properti global tunggal ke struktur per-workspace / per-root session agar dua jendela Antigravity tidak saling menimpa metadata Git.
   - Definisikan aturan arbitrase antar-workspace (workspace dengan aktivitas paling baru atau status prioritas tertinggi `EXECUTING_TOOL > THINKING > WAITING_REVIEW` yang tampil di Discord).
2. **Orphaned Subagent TTL Reaper (`src/state.ts`):**
   - Tambahkan pembersihan otomatis untuk sesi `isSubagent: true` yang tidak menerima pembaruan hook melebihi batas TTL tertentu (misal 10 menit), mencegah status terkunci pada `(N subagents active)`.
3. **Discord RPC `party` Metrics (`src/types.ts`, `src/state.ts`, `src/daemon.ts`):**
   - Tambahkan dukungan opsional `party?: { id: string; size: [number, number] }` pada `PresenceActivity` dan teruskan ke `rpcClient.user.setActivity()`.
   - Tampilkan indikator party saat subagent atau swarm sedang aktif.

#### Definition of Done (DoD):
- Test multi-workspace membuktikan perubahan `cwd` pada Workspace B tidak merusak konteks Git Workspace A yang sedang aktif.
- Subagent yang macet/crash tanpa `Stop` otomatis dibersihkan setelah melewati TTL.

---

### Stage 3: Granular Privacy Profiles & Persistent Configuration (`config.json`)
> **Target Rilis:** `v1.2.0`  
> **Mengatasi:** Opsi 3 + Edge Cases #5, #11a

Fokus tahap ini adalah memperluas kontrol keamanan/privasi pengguna dan menyediakan cara konfigurasi yang lebih ramah pengguna selain environment variables.

#### Pekerjaan Teknis:
1. **3-Tier Privacy Presets (`src/types.ts`, `src/sanitizer.ts`, `src/state.ts`):**
   - Ganti atau perluas `privacyMode: boolean` dengan `privacyProfile: "stealth" | "balanced" | "showcase"`:
     - `stealth`: Hanya menampilkan *"Working in Antigravity"* + timer, tanpa repo, branch, tool, file, maupun buttons.
     - `balanced` *(Default)*: Menampilkan repo & branch, kategori aksi umum, serta otomatis menyamarkan nama file sensitif (`.env*`, `*.pem`, `*secret*`, `*credentials*`, `id_rsa`).
     - `showcase`: Menampilkan detail lengkap termasuk nama file non-sensitif, tool info, subagent count, dan repo button.
   - Jaga *backward compatibility*: jika `AGY_DISCORD_PRIVACY_MODE=true`, petakan otomatis ke profil `stealth`.
2. **File Config Persisten:**
   - Tambahkan pembacaan opsional file konfigurasi JSON di level global user (misal `~/.gemini/antigravity-discord-rpc.json`) maupun level workspace (`.agents/discord-rpc.json`) dengan hierarki: `Env Vars > Workspace Config > Global Config > DEFAULT_CONFIG`.
3. **Dokumentasi Custom Client ID & Asset Checklist:**
   - Perbarui `README.md` dengan daftar asset key wajib (`antigravity`, `brain`, `gear`, `hourglass`, `zzz`) bagi pengguna yang ingin memakai `AGY_DISCORD_CLIENT_ID` sendiri.

#### Definition of Done (DoD):
- Seluruh preset privasi dan penyensoran file sensitif teruji pada `tests/sanitizer.test.ts` dan `tests/state.test.ts`.
- Konfigurasi dari file JSON dan env vars ter-merge sesuai urutan prioritas.

---

### Stage 4: Contextual Tech Stack Detection & Dual-Action Interactive Buttons
> **Target Rilis:** `v1.3.0`  
> **Mengatasi:** Opsi 2 & Opsi 4 + Edge Case #2 (UX Caveat)

Fokus tahap ini adalah meningkatkan kualitas visual profil Discord (setara IDE extension modern) dan memaksimalkan kuota 2 tombol interaktif Discord RPC.

#### Pekerjaan Teknis:
1. **Language & Ecosystem Detector (`src/techstack.ts`):**
   - Petakan ekstensi file dari argumen tool aktif (`Path`, `path`, `filePath`, `file_path`) seperti `.ts`, `.tsx`, `.py`, `.rs`, `.go`, `.java`, `.dart`, `.css`, dll.
   - Tambahkan fallback deteksi level proyek dari manifest (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`) dengan caching per workspace.
   - Integrasikan hasil deteksi ke `smallImageKey` / `smallImageText` (atau `largeImageKey` opsi konfigurasi), dengan fallback aman ke ikon bawaan (`gear`/`antigravity`) jika asset tidak tersedia atau profil berada pada mode `stealth`.
2. **Smart Git Branch URL & Dual Buttons (`src/git.ts`, `src/state.ts`):**
   - **Button 1:** Smart Git link — mendukung opsi langsung mengarah ke URL branch aktif (misal `.../tree/<branch>` untuk GitHub/GitLab) atau root repository.
   - **Button 2:** Tombol opsional kedua yang dapat dikonfigurasi pengguna (misal *Antigravity RPC* atau tautan kustom dokumentasi/portofolio).
   - Terapkan batas maksimal 2 tombol, label <= 32 char, dan URL <= 512 char.
3. **Asset Portal Update & Dokumentasi UX:**
   - Unggah aset ikon bahasa pemrograman ke Discord Developer Portal untuk default `clientId`.
   - Tambahkan catatan di `README.md` mengenai perilaku Discord Desktop yang tidak mengizinkan klik tombol pada kartu profil milik sendiri.

#### Definition of Done (DoD):
- Pengeditan file `.ts`, `.py`, atau `.rs` otomatis memunculkan metadata/asset bahasa yang sesuai (kecuali dalam mode `stealth`).
- Kedua tombol tampil valid di payload RPC tanpa melanggar batasan jumlah maupun panjang karakter.

---

### Stage 5: Long-Running Task Notifier & Discord Webhook Bridge (`/goal` Companion)
> **Target Rilis:** `v1.4.0`  
> **Mengatasi:** Opsi 6

Fokus tahap ini adalah membantu developer yang menjalankan agent secara otonom dalam waktu lama agar mendapat notifikasi saat task selesai.

#### Pekerjaan Teknis:
1. **Active Turn Duration Tracking (`src/state.ts`):**
   - Catat timestamp awal ketika sesi masuk ke siklus eksekusi aktif (`PreInvocation`/`PreToolUse`) hingga berpindah ke `WAITING_REVIEW` atau `Stop`.
2. **Non-Blocking Webhook Notifier (`src/webhook.ts`):**
   - Jika `AGY_DISCORD_WEBHOOK_URL` terkonfigurasi (valid `https://discord.com/api/webhooks/...`) dan durasi aktif melebihi ambang batas (misal `AGY_DISCORD_NOTIFY_MIN_SECONDS`, default `180` detik), kirim notifikasi embed ringkas secara asinkron menggunakan `fetch` dengan timeout pendek (misal 2–3 detik).
   - Pastikan isi webhook menghormati `privacyProfile` (tidak membocorkan detail perintah/file bila berada di mode `stealth` atau `balanced`).
3. **Turn/Step Counter (Opsional):**
   - Hitung jumlah tool invocation per turn untuk ditampilkan pada ringkasan notifikasi selesai.

#### Definition of Done (DoD):
- Turn singkat (< threshold) tidak memicu webhook.
- Turn panjang (>= threshold) memicu webhook dengan format aman tanpa memblokir IPC daemon maupun menggagalkan transisi status jika jaringan offline.

---

## 3. Alternatif Strategi Eksekusi (Pilihan untuk Brainstorming)

Sebelum masuk ke tahap penulisan desain teknis (`docs/superpowers/specs/`) dan eksekusi, berikut 3 alternatif pendekatan ritme pengerjaan yang dapat dipilih:

| Pendekatan | Cakupan Awal | Kelebihan | Kekurangan / Trade-off |
| :--- | :--- | :--- | :--- |
| **A. Engineering-First (Recommended)** | Urut berjenjang: **Stage 1 → Stage 2 → Stage 3 → Stage 4 → Stage 5** | Fondasi paling stabil; test suite hijau sejak awal; nol rework pada state machine dan config. | Perubahan visual baru terasa oleh pengguna pada Stage 4. |
| **B. Hardening + Visual Fast-Track** | Gabungkan item kritikal **Stage 1** (env config, test isolation, truncation) + **Stage 4** (Tech Stack & Dual Buttons), lalu susul Stage 2, 3, 5. | Pengguna langsung melihat peningkatan visual signifikan di rilis terdekat. | Berisiko terjadi penyesuaian ulang struktur `PresenceStateMachine` saat Stage 2 (Multi-Workspace) masuk belakangan. |
| **C. Stabilization Patch Only (`v1.0.1`)** | Fokus murni menyelesaikan **Stage 1** saja, rilis ke `development`/`main`, lalu diskusikan ulang fitur baru. | Scope kecil, cepat selesai, langsung memperbaiki bug nyata pada versi saat ini. | Belum ada penambahan fitur baru pada rilis terdekat. |
