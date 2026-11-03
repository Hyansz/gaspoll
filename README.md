<div align="center">

# GASPOLL

**Uji, bandingkan, dan rangkai combo model terbaik untuk 9Router, langsung dari terminal.**

![Versi](https://img.shields.io/badge/versi-1.2.2-blue)  
![Lisensi: MIT](https://img.shields.io/badge/lisensi-MIT-green)  
![Node.js](https://img.shields.io/badge/Node.js-LTS-339933?logo=node.js&logoColor=white)  
![Platform](https://img.shields.io/badge/diuji%20di-Windows-0078D6?logo=windows&logoColor=white)  
![Tanpa dependensi](https://img.shields.io/badge/dependensi-0-brightgreen)

<img src="docs/screenshot-menu.png" alt="Tampilan menu utama GASPOLL" width="760">

</div>

---

## Tentang

GASPOLL adalah alat berbasis terminal (Node.js) untuk [9Router](https://github.com/decolua/9router). Ia menguji semua model dari semua provider, mengukur kecepatan dan keandalannya, menjalankan benchmark kemampuan coding, lalu membuat combo dari model yang lolos. Setiap hasil tersimpan sebagai riwayat yang bisa dibuka kembali.

## Fitur

- **Tes semua provider dan model.** Mengukur waktu respons dan status tiap model, plus ringkasan kegagalan per provider.
- **Combo otomatis.** Model yang lolos langsung dirangkai menjadi combo.
- **Benchmark agent coding.** Skor per tugas untuk membandingkan model secara adil.
- **Ulangi benchmark per provider.** Tidak perlu menjalankan ulang semuanya.
- **Riwayat dan log.** Lihat hasil lama, buka detail, dan salin log.
- **Tampilan adaptif.** Unicode di terminal modern, ASCII otomatis di CMD, dan layout menyesuaikan lebar terminal. ID model selalu tampil utuh.
- **Tanpa dependensi eksternal.** Cukup Node.js, tidak perlu `npm install`.

## Prasyarat


| Kebutuhan     | Keterangan                                                     |
| ------------- | -------------------------------------------------------------- |
| Node.js       | Versi LTS terbaru. Rilis ini diuji di Node.js 22 dan 24.       |
| 9Router       | Harus sudah berjalan (alamat bawaan `http://localhost:20128`). |
| Akses 9Router | API key aktif atau password dashboard 9Router.                 |
| Git           | Opsional, hanya untuk cara instalasi lewat `git clone`.        |


> GASPOLL dikembangkan dan diuji di Windows. `gaspoll.bat` khusus Windows, sedangkan `node src/cli.js` bisa dijalankan dari terminal mana pun yang punya Node.js.

## Instalasi

### Opsi 1: Git

```bash
git clone https://github.com/Hyansz/gaspoll.git
cd gaspoll
```

### Opsi 2: Unduh ZIP

1. Buka [halaman repo](https://github.com/Hyansz/gaspoll).
2. Klik **Code**, lalu **Download ZIP**.
3. Ekstrak ke folder pilihanmu dan buka terminal di folder tersebut.

Tidak ada langkah `npm install`. Proyek ini tidak punya dependensi eksternal.

### Konfigurasi

Salin berkas contoh menjadi `config.json`:

```bash
copy config.example.json config.json
```

Lalu sesuaikan isinya (atau biarkan `gaspoll.bat` membuatkan konfigurasi bawaan saat pertama dijalankan):


| Kunci      | Fungsi                                                                   | Bawaan                   |
| ---------- | ------------------------------------------------------------------------ | ------------------------ |
| `baseUrl`  | Alamat URL 9Router                                                       | `http://localhost:20128` |
| `apiKey`   | API key aktif 9Router. Kosongkan agar diambil otomatis, atau isi manual. | kosong                   |
| `password` | Password dashboard 9Router                                               | `123456`                 |


`config.json` dan folder `results/` sudah masuk `.gitignore`, jadi API key dan hasil ujimu tidak ikut ter-commit.

## Menjalankan

Pastikan 9Router sudah berjalan, lalu pilih salah satu:

```bash
gaspoll.bat            # Windows (klik dua kali atau dari terminal)
node src/cli.js      # terminal mana pun
```

### Menu utama


| Tombol | Fungsi                       |
| ------ | ---------------------------- |
| `1`    | Tes provider & buat combo |
| `2`    | Benchmark agent coding       |
| `3`    | Tes + benchmark berurutan    |
| `4`    | Lihat hasil terakhir         |
| `5`    | Buka folder hasil            |
| `6`    | Ulangi benchmark 1 provider  |
| `7`    | Pengaturan                   |
| `g`    | Riwayat dan log              |
| `q`    | Keluar                       |


Tekan `Ctrl+C` kapan saja untuk menghentikan proses yang sedang berjalan.

### Tampilan terminal

CMD bawaan Windows menampilkan mode ASCII, sedangkan Windows Terminal menampilkan tampilan Unicode penuh. Kamu bisa memaksa salah satunya:

```bash
node src/cli.js --ascii
```


| Variabel lingkungan        | Fungsi                                       |
| -------------------------- | -------------------------------------------- |
| `GASPOLL_UNICODE=1`        | Paksa tampilan Unicode                       |
| `GASPOLL_ASCII=1`          | Paksa tampilan ASCII (sama dengan `--ascii`) |
| `GASPOLL_COMPACT=1`        | Paksa header ringkas (atau 0 untuk banner penuh)|
| `GASPOLL_NOCLEAR=1`        | Jangan bersihkan layar antar menu            |
| `GASPOLL_RESULTS=<folder>` | Simpan hasil dan riwayat di folder lain      |

Terminal pendek (< 30 baris) otomatis memakai header ringkas; paksa dengan `GASPOLL_COMPACT=1`, atau `GASPOLL_COMPACT=0` untuk banner penuh.


Contoh di CMD: `set GASPOLL_UNICODE=1` lalu `node src/cli.js`. Di PowerShell: `$env:GASPOLL_UNICODE = 1`.

## Pemecahan masalah


| Gejala                                               | Penyebab dan solusi                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| Semua model gagal dengan "api key ditolak" (401/403) | API key salah. Ganti lewat menu `7` (Pengaturan).                 |
| Pesan bahwa router belum jalan                       | Jalankan 9Router lebih dulu, lalu cek `baseUrl` di `config.json`. |
| Karakter aneh atau garis putus-putus di CMD          | Gunakan Windows Terminal, atau paksa mode ASCII dengan `--ascii`. |


## Pengujian

```bash
npm test
```

Rangkaian tes (63 tes pada rilis 1.2.0) mencakup alur menu, tata letak di berbagai lebar terminal, mode ASCII dan Unicode, serta skenario error dari router tiruan. Tes memakai folder hasil sementara, jadi data di `results/` tidak tersentuh.

## Struktur proyek

```text
gaspoll/
├── src/
│   ├── cli.js              # menu utama dan alur interaktif
│   ├── ui.js               # tampilan, warna, dan tata letak
│   ├── lib.js              # fungsi bersama dan konfigurasi
│   ├── paging.js           # paginasi tampilan riwayat
│   ├── test-9router.js     # tes provider dan model
│   ├── bench-9router.js    # benchmark agent coding
│   ├── show-results.js     # tampilan hasil
│   ├── verify-combos.js    # verifikasi combo
│   └── ui-preview.js
├── test/                   # rangkaian tes otomatis
├── docs/                   # gambar untuk dokumentasi
├── config.example.json     # contoh konfigurasi
├── gaspoll.bat               # peluncur Windows
├── CHANGELOG.md
└── LICENSE
```

## Keamanan

- Jangan membagikan atau meng-commit `config.json`. Berkas itu berisi API key dan password.
- Folder `results/` dapat memuat nama model dan alamat router milikmu, jadi periksa dulu sebelum membagikannya.
- Nilai mirip kunci di folder `test/` adalah data palsu untuk keperluan tes.

## Riwayat perubahan

Lihat [CHANGELOG.md](CHANGELOG.md).

## Lisensi

Dirilis di bawah lisensi MIT. Lihat berkas [LICENSE](LICENSE).
