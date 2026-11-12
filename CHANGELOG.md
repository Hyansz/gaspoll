# Changelog

## [1.2.7] - 2026-11-12
- Menu utama ditata ulang: tombol 1 sampai 8 berurutan (UTAMA berisi 1-4, ALAT berisi 5-8), dan [g] Riwayat serta [q] Keluar di baris sendiri.
- Gambar menu di README diperbarui dan kini menampilkan menu [8].

## [1.2.6] - 2026-11-11
- Menu baru [8] Realtime bot guardian: perantara lokal (127.0.0.1:20130) di depan 9Router. Saat sebuah model kena limit, macet, atau menjawab kosong, permintaan yang sama langsung dialihkan ke model berikutnya dari combo-auto-combo.json, tanpa mengubah combo di 9Router maupun urutan di berkas.
- Layar live berbasis teks: model yang sedang dipakai, status tiap model (sehat, tertahan, nonaktif), dan peristiwa terbaru. Tombol r (cek semua), 1 (reset), q (keluar).
- Model bermasalah ditahan 20 detik (naik dua kali lipat sampai 300 detik) dan kembali ke posisi semula setelah 2 cek berhasil beruntun.
- Log kegagalan results/guardian-failures.log (key disamarkan) untuk menyetel pola limit. Pola tambahan lewat --limit-pattern atau GASPOLL_GUARD_PATTERN.
- Batasan: hanya /v1/chat/completions (gaya OpenAI). /v1/messages (Claude Code) belum didukung.
- Perbaikan: diagnosis gagal login dashboard. Pesan kini membedakan HTTP 429 (diblokir sementara, ada waktu tunggu), 401, dan 500, menyebut sumber password dan berkas config tanpa mencetak isinya, serta menyarankan perintah --apply --name auto-combo.
- Tes baru untuk guardian, menu [8], dan diagnosis login.
- README ditata ulang: tabel fitur, diagram alur guardian, dan panduan pemecahan masalah login dan guardian.

## [1.2.5] - 2026-11-05
- README: gambar menu, petunjuk menjalankan per sistem operasi (CMD, PowerShell, Linux, macOS), opsi tampilan terminal.
- .gitattributes: .bat selalu CRLF dan .sh selalu LF.
- Workflow CI (GitHub Actions) menguji Linux, macOS, dan Windows.
- Perbaikan: menu Pengaturan [7] crash "UI.padTo is not a function" (padTo kini diekspor dari src/ui.js).
- Tes baru: semua rujukan UI.x dan L.x harus ada di ekspor modulnya.
- Dukungan Linux dan macOS: launcher gaspoll.sh, pembuka folder dan clipboard lintas OS.
- Pembuka folder tidak lagi crash bila xdg-open/open tidak terpasang.
- Deteksi UTF-8 membaca LC_ALL, LC_CTYPE, lalu LANG.
- Tes portabilitas Linux/macOS.

## [1.2.4] - 2026-11-04
- Perbaikan: `actionSettings()` dan menu opsi `[5]` (Buka folder hasil) di `src/cli.js` mendefinisikan `s` dengan benar sehingga tidak crash 's is not defined'.
- Perbaikan: `src/bench-9router.js` menambahkan `require('path')` agar `writeLastRunBench` dapat menulis `last-run.json` tanpa error 'path is not defined'.

## [1.2.3] - 2026-11-03
- Perbaikan: Header ringkas (perbaikan garis ganda, separator yatim, dan awalan 'v' pada versi).
- Perbaikan: Banner penuh selalu tampil pada terminal tinggi (rows >= 30), menghapus aturan render pertama ringkas.
- Perbaikan: `gaspoll.bat` tidak lagi memaksa `GASPOLL_UNICODE=1` agar CMD lama mendeteksi ASCII secara otomatis.

## [1.2.2] - 2026-11-03
- Perbaikan: Tes provider dan Jalankan semua gagal dengan "s is not defined" saat menyusun combo; pesan kegagalan membedakan tes yang berhasil dari combo yang gagal.

## [1.2.1] - 2026-11-03
- Menu: banner penuh hanya di layar pertama dan header ringkas untuk terminal pendek (GASPOLL_COMPACT).
- Blok status lebih jelas: combo belum dibuat, API key disamarkan (sk-c****c181) atau belum diatur, tes/bench terakhir.
- Istilah menu diseragamkan ("Tes provider & buat combo", "Tes + benchmark berurutan").
- Asap banner menjadi jejak tipis horizontal satu ukuran.
- Skrip pack menyalin pohon siap-zip ke folder berbagi C:\sandbox\gaspoll dengan pembersihan Recycle Bin.

## [1.2.0] - 2026-10-31
- Riwayat & log: 10 entri terbaru; "(1-N)" sesuai jumlah tampil; ikon tunggal; petunjuk Enter; "b" dari detail kembali ke daftar riwayat; paginasi detail menjaga judul bagian bersama isinya (src/paging.js).
- Klasifikasi kegagalan terpadu (UI.failureKind): HTTP 402 hanya dari kode status; semua label punya petunjuk (src/lib.js, test/unit.test.js).
- Ringkasan hasil: kegagalan dikelompokkan per provider+label; judul layar seragam; legenda skor dibungkus sesuai lebar; ID model tidak dipotong; header "Memakai N model" tunggal (src/show-results.js, src/bench-9router.js, src/ui.js).
- ASCII/Unicode: pilihan tampilan diwariskan ke proses anak; GASPOLL_ASCII / GASPOLL_UNICODE / --ascii / --unicode (src/ui.js, test/unit.test.js).
- Perbaikan: "Cannot access 's' before initialization" di test-9router jalur ASCII (src/test-9router.js).
- Settings: bracket sejajar; saran "tekan 7" untuk API key kosong (src/ui.js, test/unit.test.js).
- Nama proyek menjadi GASPOLL; variabel lingkungan memakai awalan GASPOLL_.
- Pengembangan & Pengujian: 63 tes; `npm test` lewat test/run-tests.js (guard: gagal bila results/ asli berubah); tes diisolasi lewat GASPOLL_RESULTS (folder sementara) (test/run-tests.js, test/unit.test.js, test/ui-flow.test.js).
