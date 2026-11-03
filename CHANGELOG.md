# Changelog

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
- Nama proyek diganti dari GASPOLL menjadi GASPOLL; variabel env GASPOLL_* menjadi GASPOLL_*.
- Pengembangan & Pengujian: 63 tes; `npm test` lewat test/run-tests.js (guard: gagal bila results/ asli berubah); tes diisolasi lewat GASPOLL_RESULTS (folder sementara) (test/run-tests.js, test/unit.test.js, test/ui-flow.test.js).
