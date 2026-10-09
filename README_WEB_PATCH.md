# Web Patch — Suno-Song-Remaster

## Masalah
Aplikasi ini aslinya aplikasi desktop (Electron). Semua operasi file
(buka MP3, simpan hasil) lewat `window.electronAPI` yang cuma ada di Electron.
Waktu di-deploy ke Vercel sebagai website biasa, API itu tidak ada sehingga
tombol load file tidak berfungsi.

## Perbaikan (2 file)
1. **`src/public/browser-shim.js`** (baru) — kalau `window.electronAPI` tidak
   ada, shim ini membuatnya ulang pakai API browser:
   - `selectFile` / `selectFiles` → dialog file browser biasa
   - `getPathForFile` → daftarkan File hasil drag & drop
   - `readAudioFile` → baca bytes dari File
   - `saveFile` / `writeFile` / `selectDirectory` → hasil mastering diunduh
     otomatis sebagai `namalagu_mastered.wav` ke folder Download
   - `getSystemInfo` → stub (cuma dipakai dialog debug)
   - Tombol minimize/maximize/close khas desktop disembunyikan
   - Kalau dijalankan di Electron asli, shim tidak mengubah apa-apa.
2. **`src/index.html`** — tambah satu baris sebelum `renderer.js`:
   `<script src="./browser-shim.js"></script>`

Tidak ada satu baris pun kode aplikasi (`renderer.js`) yang diubah.

## Cara pakai / deploy ulang
- File ZIP ini berisi source yang sudah di-patch (tanpa `node_modules`).
- Ganti file project kamu dengan isi ZIP ini, lalu redeploy ke Vercel
  (kalau Vercel-mu tersambung ke git, cukup push/commit; Vercel akan
  rebuild otomatis dengan `npm run build`).
- Hasil mastering sekarang terunduh sebagai file WAV via browser.

## Batasan versi web
- Export selalu ke folder Download browser (browser tidak bisa pilih folder).
- Tidak ada fitur yang butuh akses disk langsung selain itu.
