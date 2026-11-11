# Analisis Edge Cases & Opsi Pengembangan Fitur: Antigravity Discord Rich Presence

- **Tanggal:** 2026-11-11
- **Branch:** `feat/discord-rpc-enhancements` (berbasis `development`)
- **Lingkup:** Audit teknis codebase saat ini, analisis spesifikasi protokol **Discord Developer RPC / IPC**, identifikasi edge case, serta 6 opsi pengembangan fitur strategis kedepannya.

---

## 1. Analisis Edge Cases (Codebase & Discord RPC Protocol)

Berikut adalah daftar edge case kritis yang teridentifikasi dari kombinasi audit implementasi saat ini (`src/daemon.ts`, `src/state.ts`, `src/dispatch.ts`, `src/ipc.ts`, `src/sanitizer.ts`, `hooks.json`) dan dokumentasi resmi Discord Rich Presence.

### A. Spesifikasi & Limitasi Protokol Discord RPC

1. **Batas Panjang Karakter Ketat & Risiko Penolakan Payload (`SET_ACTIVITY`)**
   - **Spesifikasi Discord:** Protokol RPC memberlakukan batas maksimal pada field payload:
     - `details` & `state`: Maksimal **128 karakter** (minimal 2 karakter jika diisi).
     - `largeImageText` & `smallImageText`: Maksimal **128 karakter**.
     - `largeImageKey` & `smallImageKey`: Maksimal **32 karakter** (untuk asset key internal aplikasi) atau URL eksternal valid (`mp:external/...`).
     - `buttons`: Maksimal **2 tombol**, masing-masing dengan `label` maksimal **32 karakter** dan `url` maksimal **512 karakter**.
   - **Celah Saat Ini:** Fungsi `buildActivity()`, `formatState()` di `src/state.ts`, serta `mapToolToAction()` di `src/sanitizer.ts` belum melakukan *truncation* (pemotongan aman dengan `...`). Nama repository panjang, nama branch panjang (misal `feat/JIRA-1234-implement-oauth2-pkce-provider`), atau argumen command/tool summary yang panjang dapat melampaui 128 karakter dan menyebabkan Discord RPC menolak payload atau memutus socket.

2. **Validasi Skema & Keamanan URL pada Action Buttons**
   - **Spesifikasi Discord:** `buttons[].url` wajib menggunakan skema `http://` atau `https://` yang valid dan panjang <= 512 karakter.
   - **Celah Saat Ini:** `sanitizeGitUrl()` di `src/sanitizer.ts` sudah mengonversi `ssh://` dan format SCP (`git@github.com:...`) ke `https://`, namun belum membatasi panjang maksimal 512 karakter maupun menyaring host lokal/non-routable jika diperlukan.
   - **UX Caveat (Self-Click Behavior):** Discord Desktop secara sengaja menonaktifkan klik tombol Rich Presence saat dilihat pada kartu profil pengguna itu sendiri (preview/anti-abuse). Tanpa catatan di dokumentasi/FAQ, pengguna sering mengira fitur tombol rusak.

3. **Rate Limiting Discord `SET_ACTIVITY` vs. Rapid Tool Execution Burst**
   - **Spesifikasi Discord:** Pembaruan Rich Presence (`SET_ACTIVITY`) pada Discord Desktop dibatasi oleh *sliding window rate limit* (umumnya rata-rata 1 pembaruan efektif setiap ~15–20 detik dengan *burst allowance* terbatas).
   - **Celah Saat Ini:** `RpcDaemon` di `src/daemon.ts` menggunakan `throttleMs = 2000` (2 detik). Ketika agent mengeksekusi 10–15 tool secara berurutan dalam hitungan detik (misal serangkaian `read_file` atau `grep`), daemon mengirim update setiap 2 detik. Hal ini berisiko memicu *silent drop* dari klien Discord sehingga status yang tampil di profil tertinggal (*stale*) pada tool lama.

4. **Koneksi Discord Cold-Start, Sleep/Hibernasi, & Multi-Client (`discord-ipc-0..9`)**
   - **Discord Dibuka Terlambat:** Jika Antigravity dimulai sebelum Discord Desktop berjalan, `connectDiscord()` di `src/daemon.ts` gagal secara silent (`_isConnected = false`) dan tidak memiliki *background reconnect loop*. Koneksi baru dicoba lagi hanya saat ada event masuk ke `sendPresenceToDiscord()`. Jika agent sedang dalam fase `WAITING_REVIEW` atau `IDLE`, status tidak akan pernah muncul sampai user memicu prompt baru.
   - **OS Sleep / Wake & Discord Restart:** Ketika sistem operasi masuk mode *sleep/hibernate* atau Discord melakukan auto-update/restart, named pipe (`\\.\pipe\discord-ipc-0` di Windows atau `/tmp/discord-ipc-0` / `$XDG_RUNTIME_DIR/discord-ipc-0` di Linux/macOS) terputus. Transport lama dapat menjadi tidak valid dan membutuhkan *re-instantiation* atau *exponential backoff reconnect*.
   - **Multiple Discord Clients:** Pengguna yang menjalankan Discord Stable bersamaan dengan Discord PTB / Canary / Development dapat menempati indeks pipe selain `0` (`discord-ipc-1` s/d `discord-ipc-9`).

5. **Dependensi Asset Key Terhadap `AGY_DISCORD_CLIENT_ID` Kustom**
   - **Celah Saat Ini:** `src/state.ts` menanamkan asset key statis (`"antigravity"`, `"brain"`, `"gear"`, `"hourglass"`, `"zzz"`). Jika pengguna mengisi `AGY_DISCORD_CLIENT_ID` dengan Application ID miliknya sendiri tanpa mengunggah ulang semua nama aset tersebut ke Discord Developer Portal, ikon tidak akan muncul pada profilnya.

---

### B. Arsitektur Antigravity Hook, Daemon, & Sistem Operasi

6. **Environment Configuration Gap (`README.md` vs. `src/daemon.ts`)**
   - **Temuan Codebase:** `README.md` mendokumentasikan 4 environment variable untuk kustomisasi: `AGY_DISCORD_CLIENT_ID`, `AGY_DISCORD_PRIVACY_MODE`, `AGY_DISCORD_IDLE_TIMEOUT`, dan `AGY_DISCORD_SHOW_REPO_BUTTON`.
   - **Celah Saat Ini:** Saat dijalankan sebagai standalone process (`isDirectRun` pada `src/daemon.ts`), `new RpcDaemon()` dipanggil langsung dengan `DEFAULT_CONFIG` (`src/types.ts`) tanpa membaca keempat environment variable tersebut. Hanya `AGY_IPC_PATH`, `AGY_DISCORD_RPC_PIPE`, `AGY_DAEMON_PATH`, dan `AGY_AUTO_SPAWN` yang saat ini dibaca oleh `src/ipc.ts` dan `src/dispatch.ts`.

7. **Cold-Start Event Loss pada Auto-Spawn Daemon**
   - **Temuan Codebase:** Pada `runDispatch()` (`src/dispatch.ts`), ketika daemon belum berjalan (`!delivered`), dispatcher memanggil `spawnDaemon(env)` lalu segera keluar agar tidak menghambat eksekusi hook (target < 50ms).
   - **Masalah:** `payload` pertama yang memicu *spawn* (biasanya `SessionStart` atau `PreInvocation` pertama) tidak diteruskan ke daemon yang baru hidup dan tidak dikirim ulang. Akibatnya, daemon menyala dalam keadaan kosong tanpa status sampai event hook berikutnya tiba.

8. **Multi-Workspace State Bleeding & Named Pipe Collision (`EADDRINUSE`)**
   - **State Bleeding:** Di `PresenceStateMachine` (`src/state.ts`), daftar `sessions` disimpan per `conversationId`, tetapi properti `this.cwd`, `this.gitInfo`, dan `this.startTimestamp` bersifat global tunggal. Jika pengguna membuka 2 jendela Antigravity pada 2 repositori berbeda secara bersamaan, metadata Git repositori kedua langsung menimpa repositori pertama.
   - **Pipe Collision (`EADDRINUSE`):** Alamat default IPC (`\\.\pipe\agy-discord-rpc` / `/tmp/agy-discord-rpc.sock`) bersifat tunggal secara global per mesin. Ketika daemon plugin sudah berjalan di background dan developer menjalankan `npm test`, suite `tests/ipc.test.ts` dan `tests/dispatch.test.ts` gagal dengan error `listen EADDRINUSE: address already in use \\.\pipe\agy-discord-rpc` karena pengujian tidak mengisolasi socket IPC.
   - **Unix Socket Unlink Risk:** Pada `src/ipc.ts`, saat startup di non-Windows, `fs.unlinkSync(this.path)` langsung menghapus socket yang ada jika ditemukan di disk. Jika ternyata masih ada daemon aktif, socket milik daemon aktif tersebut terhapus/terputus secara sepihak.

9. **Zombie Daemon Process & Celah Hook `SessionEnd`**
   - **Temuan Codebase:** `PresenceStateMachine.handleHook()` (`src/state.ts`) sudah memiliki handler untuk event `"SessionEnd"`, tetapi `hooks.json` tidak mendaftarkan event `"SessionEnd"`.
   - **Masalah:** Jika pengguna menutup jendela Antigravity secara langsung, membatalkan sesi di level UI tanpa memicu `Stop` non-`NO_TOOL_CALL`, atau IDE mengalami crash, daemon (`bin/daemon.js`) tidak menerima sinyal berhenti. Karena daemon berjalan dalam mode `detached: true` tanpa *inactivity auto-shutdown watchdog*, proses dapat terus hidup menjadi *zombie/orphan process* dan menampilkan status *stale* di Discord.

10. **Orphaned Subagent Leak pada State Machine**
    - **Celah Saat Ini:** Subagent dihapus dari `this.sessions` hanya jika mengirim hook `Stop` atau `SessionEnd` (`src/state.ts` baris 207–210). Jika subagent dibatalkan paksa atau gagal tanpa memicu hook penutup, entri subagent tetap tersimpan di `this.sessions` dengan status `THINKING` atau `EXECUTING_TOOL`. Akibatnya, `getCurrentStatus()` terkunci pada status aktif, `(N subagents active)` terus muncul, dan idle timer tidak pernah berjalan.

11. **Celah Kebocoran Privasi Sekunder (`mapToolToAction`)**
    - **Nama File Sensitif:** Saat `privacyMode = false`, `mapToolToAction()` menampilkan `path.basename` untuk `read_file`, `write_file`, dan `edit_file`. File konfigurasi sensitif seperti `.env`, `.env.production`, `id_rsa`, atau `credentials.json` akan langsung terekspos ke Discord (misal: `Editing .env.production`).
    - **`toolSummary` Bypass:** Pada `run_command` saat `privacyMode = false`, jika `args.toolSummary` tersedia, nilainya langsung dikembalikan tanpa melalui `sanitizeCommand()`.

12. **Registrasi Ganda di `hooks.json`**
    - **Temuan Codebase:** `hooks.json` memiliki dua blok root yang identik (`"discord-presence"` dan `"antigravity-discord-presence"`). Apabila runner Antigravity mengevaluasi seluruh root key di `hooks.json`, setiap event memicu eksekusi `node bin/dispatch.js` sebanyak 2 kali paralel, menggandakan overhead startup proses Node.js dan trafik IPC.

---

## 2. Opsi Pengembangan Fitur Kedepannya (6 Pilihan Roadmap)

Berikut adalah 6 pilihan fitur pengembangan yang dapat dipilih dan diprioritaskan untuk iterasi berikutnya:

### Opsi 1: Multi-Workspace Isolation & Native Swarm / Subagent "Party" Metrics
- **Deskripsi:** Mengoptimalkan integrasi khusus untuk workflow multi-agen Antigravity dengan memanfaatkan fitur `party` pada spesifikasi Discord RPC.
- **Cakupan Fitur:**
  - Mengisolasi konteks `cwd`, `gitInfo`, dan `startTimestamp` per workspace/root session pada `PresenceStateMachine`.
  - Menggunakan payload `party: { id: <conversationId>, size: [<activeAgents>, <maxOrTotalAgents>] }` di Discord RPC agar Discord menampilkan indikator jumlah agen yang sedang berkolaborasi secara native (contoh: *"Antigravity Swarm (3 of 5)"*).
  - Menambahkan mekanisme *stale session TTL reaper* untuk membersihkan subagent yang timeout atau gagal tanpa event `Stop`.
- **Target Dampak:** Menghilangkan konflik antar-jendela Antigravity dan menonjolkan keunikan orkestrasi AI multi-agen Antigravity di Discord.

### Opsi 2: Contextual Tech Stack & Language Detection (Dynamic Assets)
- **Deskripsi:** Mendeteksi bahasa pemrograman dan ekosistem proyek secara real-time untuk ditampilkan sebagai ikon dinamis di Discord Rich Presence.
- **Cakupan Fitur:**
  - Mendeteksi ekstensi file dari argumen tool aktif (`read_file`, `write_file`, `edit_file` -> `.ts`, `.py`, `.rs`, `.go`, `.dart`, `.vue`, dll.) dan manifest proyek (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`).
  - Memetakan teknologi ke `smallImageKey` / `largeImageKey` khusus (misal ikon TypeScript, Python, Rust, Docker) dengan teks hover informatif (contoh: *"Editing daemon.ts (TypeScript)"*).
  - Menyediakan fallback otomatis apabila asset key tidak tersedia pada `clientId` kustom.
- **Target Dampak:** Meningkatkan estetika visual dan memberikan konteks teknis instan tentang stack yang sedang dikerjakan pengguna.

### Opsi 3: Granular Privacy Profiles & Persistent Config File (`config.json`)
- **Deskripsi:** Mengubah konfigurasi privasi dari sekadar *on/off boolean* menjadi sistem profil bertingkat sekaligus menyambungkan seluruh opsi konfigurasi env dan file lokal.
- **Cakupan Fitur:**
  - **3 Preset Privasi:**
    - `stealth`: Hanya menampilkan *"Working in Antigravity"* dan timer; menyembunyikan nama repo, branch, tool, dan button.
    - `balanced` *(Default)*: Menampilkan nama repo, branch, dan aktivitas kategori umum, namun otomatis menyensor nama file sensitif (`.env*`, `*secret*`, `*.pem`, `*key*`).
    - `showcase`: Menampilkan detail lengkap (nama file spesifik, stack teknologi, hitungan subagent, repo button).
  - Membaca konfigurasi dari file JSON lokal (misal `~/.gemini/antigravity-discord-rpc.json` atau workspace config) serta mengaktifkan parsing environment variables (`AGY_DISCORD_*`) di `src/daemon.ts`.
- **Target Dampak:** Memberikan kendali privasi tingkat lanjut bagi developer enterprise maupun streamer/open-source.

### Opsi 4: Dual-Action Interactive Buttons & Smart Git Context
- **Deskripsi:** Memanfaatkan kuota maksimal **2 tombol interaktif** Discord Rich Presence untuk navigasi konteks proyek yang lebih kaya.
- **Cakupan Fitur:**
  - **Tombol 1 (Smart Git Context):** Menghasilkan URL dinamis sesuai konteks branch aktif (contoh: mengarah ke `.../tree/<branch>` pada GitHub/GitLab, atau tetap ke root repository jika branch masih lokal) dengan validasi ketat panjang URL <= 512 karakter dan label <= 32 karakter.
  - **Tombol 2 (Configurable Companion Link):** Dapat diarahkan ke halaman plugin/Antigravity, dokumentasi proyek, atau URL kustom dari config pengguna.
  - Menghormati `privacyMode` / `stealth` secara konsisten.
- **Target Dampak:** Memaksimalkan kapabilitas interaktif kartu profil Discord.

### Opsi 5: Daemon Self-Healing, Watchdog, & Zero-Loss Hardening (Reliability)
- **Deskripsi:** Memperkuat ketahanan sistem background daemon, komunikasi IPC, dan pengujian otomatis agar bebas dari seluruh technical debt yang teridentifikasi.
- **Cakupan Fitur:**
  - **Zero-Loss Cold Start:** Meneruskan payload pemicu awal ke daemon yang baru di-spawn (misal via flag `--initial-payload` atau fallback retry cepat setelah spawn) sehingga hook pertama tidak terbuang.
  - **Inactivity Auto-Shutdown Watchdog:** Daemon otomatis berhenti secara graceful apabila tidak ada event masuk dalam durasi tertentu (misal 60 menit setelah `IDLE` atau `STOPPED`) agar tidak meninggalkan zombie process.
  - **Auto-Reconnect Backoff Loop:** Mencoba ulang koneksi Discord RPC dengan *exponential backoff* ketika Discord Desktop dibuka terlambat atau setelah sistem operasi bangun dari sleep.
  - **Payload Truncation & Rate-Limit Smarter Debounce:** Otomatis memotong string `details`/`state` pada batas 128 karakter dan mengoptimalkan pengiriman pembaruan status agar selaras dengan rate limit Discord.
  - **Test Isolation:** Memastikan unit & integration test memakai jalur IPC acak/terisolasi agar `npm test` selalu lolos meski plugin sedang aktif berjalan.
- **Target Dampak:** Menjamin stabilitas produksi jangka panjang (*fire-and-forget*), bebas memory leak, dan test suite deterministik.

### Opsi 6: Long-Running Task Notifier & Discord Webhook Bridge (`/goal` Companion)
- **Deskripsi:** Memberikan jembatan notifikasi asinkron bagi pengguna yang menjalankan task otonom berdurasi lama (seperti workflow `/goal`, build besar, atau test suite panjang).
- **Cakupan Fitur:**
  - Melacak durasi eksekusi aktif sejak turn dimulai hingga masuk status `WAITING_REVIEW` atau selesai.
  - Integrasi opsional via `AGY_DISCORD_WEBHOOK_URL`: jika tugas selesai setelah berjalan melebihi ambang durasi (misal > 3 menit), daemon dapat mengirimkan ringkasan singkat ke channel Discord pribadi / private server (contoh: nama proyek, branch, durasi eksekusi, dan status kesiapan review).
  - Opsional menambahkan metrik *turn/step count* atau estimasi countdown (`endTimestamp`) jika tersedia di payload.
- **Target Dampak:** Memudahkan developer memantau progres agent jarak jauh (misalnya dari HP lewat aplikasi Discord) tanpa harus terus-menerus memantau layar desktop.
