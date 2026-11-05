# Monitor 7 Mesin Trading

Merekam setiap setup dari **7 mesin** (`crypto`, `tn`, `tnv2`, `tnv2c2`, `dseek`, `grox`, `chatgpt`), lalu
membandingkan performanya. Dashboard: **https://triasnugra.github.io/monitorv2/** (nama repo harus `monitorv2`).
Status tiap selector dan asumsi ada di `docs/VERIFIED.md`.

## Dua catatan data yang terpisah: Setup dan Jurnal
Dashboard punya dua tab terpisah, masing-masing dengan berkas data sendiri.

| | Tab **Setup** | Tab **Jurnal** |
|---|---|---|
| Isi | Analisis yang **siap dieksekusi saat ini**: kartu yang lolos filter/gerbang tiap mesin | **Riwayat lengkap** semua setup yang pernah dihasilkan tiap mesin |
| Berkas | `data/setup.json` (snapshot per mesin, ditimpa tiap scan terkonfirmasi) | `data/jurnal.json` (tidak pernah dihapus; dulu bernama `setups.json`, tetap terbaca otomatis) |
| Sumber | Kartu "Sinyal setup" di halaman mesin yang lolos gerbang (`crypto`: kartu setupnya; `tn`: kartu halaman via browser) | Jurnal website (tabel + JSON) untuk `tn`, `tnv2`, `tnv2c2`, `dseek`, `grox`, `chatgpt`; kartu yang pernah terlihat untuk `crypto` |
| Tujuan | Apa yang bisa dieksekusi sekarang | Melacak mana yang **terpakai** dan apakah analisisnya **akurat** |

Aturan Setup:
- Daftar kosong hanya menimpa daftar lama bila **terkonfirmasi** (kartu terbaca, atau halaman menyatakan 0 setup). Bila pembacaan kartu gagal, daftar lama dipertahankan dan ditandai *tidak terkonfirmasi (data lama)*.
- Setup yang tidak lolos filter lagi keluar dari tab Setup, tetapi jejaknya tetap ada di Jurnal lewat penanda **Pernah di Setup** (`readyEver`, `readyFirstSeenUtc`, `readyLastSeenUtc`). Penanda ini hanya mencatat apa yang terlihat sejak pelacakan dimulai; setup yang muncul dan hilang di antara dua scan (±30 menit) bisa terlewat.
- Pencocokan Setup ke Jurnal: `crypto` memakai ID yang sama; mesin lain mencocokkan koin + arah + entry (toleransi 0,05%), memilih jurnal terbaru.

Definisi di tab Jurnal (menurut basis hasil yang dipilih):
- **Terpakai** = entry tersentuh sehingga trade benar-benar terjadi (hasil TP atau SL). **Berjalan** = entry tersentuh, belum selesai (hanya diketahui dari verifikasi candle). **Menunggu** = belum ada konfirmasi entry. **Tidak terpakai** = kedaluwarsa / tidak terisi / batal. **Tak ternilai** = INVALID / AMBIGUOUS.
- **Akurat** = TP, **meleset** = SL; dihitung hanya dari yang terpakai. Akurasi = TP ÷ (TP + SL). Tingkat eksekusi = terpakai ÷ (terpakai + tidak terpakai), hanya dari setup yang sudah final.
- "Terpakai" berarti *terisi di pasar menurut hasil mesin / candle*, bukan penanda eksekusi manual oleh pengguna.

## Dua basis hasil (dropdown di dashboard)
- **Menurut mesin (default):** `hasil` yang tertampil di jurnal website tiap mesin (TP / SL / menunggu / kedaluwarsa /
  tidak terisi), dipetakan apa adanya. Angka di sini harus sama dengan website.
- **Verifikasi candle:** hasil dihitung ulang dari candle Binance (teoretis, tanpa fee/slippage). Bisa berbeda dari
  website; selisih TP vs SL ditampilkan di Data Quality.
Mesin tanpa hasil sendiri (`crypto`) memakai verifikasi candle di kedua basis.

## Sumber data per mesin
| Mesin | Sumber |
|---|---|
| `crypto` | DOM kartu `#setups > article.c` (Playwright). Tanpa waktu analisis → `first_seen`. |
| `tn` | `data/journal.json` langsung. ID dari hash rantai `h` (histori lama tetap utuh). |
| `tnv2`, `tnv2c2`, `dseek`, `grox`, `chatgpt` | **Jurnal yang tampil di halaman**: halaman dibuka di browser, *Scan ulang* ditekan, lalu (1) JSON jurnal yang dimuat halaman itu sendiri ditangkap dari jaringan, dan (2) tabel jurnal di DOM dibaca (header `waktu/aset/arah/entry/sl/tp/hasil/R`). Bila hasil di tabel berbeda dari JSON, **tabel yang dipakai** (itu yang dilihat pengguna). Baris yang hanya ada di tabel ikut dicatat. |

Kartu "Sinyal setup" mesin keluarga tn **tidak masuk Jurnal**; kartu yang lolos gerbang dicatat terpisah di `data/setup.json` (tab Setup),
sedangkan kartu yang ditolak gerbang hanya dihitung di diagnostik. Sebelumnya kartu dicampur ke riwayat sehingga hanya 3 setup aktif yang
terbaca padahal jurnal sudah memuat puluhan sinyal dengan hasil TP/SL. Record kartu lama otomatis dibuang dari jurnal saat run pertama.
`setupId` memakai menit + aset + arah + entry, sama untuk sumber JSON maupun tabel, sehingga tidak terjadi duplikat bila sumber berganti.

## Setup (cukup lewat web GitHub)
1. Buat repo **`monitorv2`**, unggah isi proyek ini (termasuk folder `.github/`).
2. **Settings → Pages → Source: GitHub Actions.** **Settings → Actions → General → Workflow permissions: Read and write.**
3. **Verifikasi (sangat disarankan, terutama `grox`):** Actions → **"Discover"** → pilih `tnv2,tnv2c2,dseek,grox,chatgpt` → Run.
   Periksa `data/discovery/<mesin>/journal-tables.json` (header, jumlah baris, hitungan hasil) dan `json-responses.json`.
   Hasil harus cocok dengan jurnal di website. Bila `journal-tables.json` kosong untuk suatu mesin, jurnalnya tidak berbentuk tabel
   standar dan perlu penyesuaian.
4. **Actions → "Collect, evaluate, deploy" → Run workflow.** Jalan terjadwal ±30 menit (best-effort).

Tidak perlu GitHub Secrets (data publik).

## Alur
`collect` (sumber → item mentah → `TO_RECORD[engine]` → `buildRecord` → upsert idempoten ke **jurnal**; kartu lolos filter → `applyLiveScan` → **setup**) →
`evaluate` (candle Binance → status) → `build` (statistik → `site/data/dashboard.json`).
`npm test` dijalankan di workflow sebelum koleksi; kegagalan test menghentikan run.

## Aturan utama
- **Status final:** `TP`, `SL`, `CANCELLED`, `EXPIRED`, `INVALID`, `AMBIGUOUS`. `PENDING` untuk yang masih aktif.
- **Hasil sumber disimpan terpisah** (`sourceResult`). Dashboard menampilkan ketidaksesuaian TP/SL antara
  sumber dan evaluasi kita di Data Quality.
- **Waktu analisis:**
  - `source`: dari sumber (tn).
  - `first_seen`: waktu scan pertama kali melihat setup (tnv2, setelah pelacakan dimulai).
  - `unknown_before_tracking`: setup yang sudah ada saat pelacakan dimulai (tnv2). Tidak dievaluasi.
- **Setup baru dari sumber yang sama tidak menimpa histori.** ID tn berasal dari hash `h` jurnal;
  ID tnv2 berasal dari level kartu (stabil antar-scan).
- **TP tercapai sebelum entry tersentuh** → `EXPIRED`, bukan menang.
- **TP dan SL dalam candle yang sama** → diselesaikan dengan candle 1m; jika tetap ambigu → `AMBIGUOUS`.
- **Verdict** "mesin lebih baik" hanya muncul jika tiap mesin punya ≥30 setup selesai dan CI95 bootstrap
  selisih expectancy tidak mencakup 0.
- Sampel independen: satu setup per klaster near-duplicate (engine + simbol + arah, ≤24 jam, entry ±1%).

## Asumsi & keterbatasan
- Fill limit dianggap terjadi saat harga menyentuh level. Tanpa fee, funding, dan slippage.
- R = |TP−fill| / |fill−SL| untuk TP; −1 untuk SL. Hanya TP pertama yang dievaluasi.
- TTL entry 72 jam dan batas hold 30 hari (config/settings.json). Journal tn memakai `due` 7 hari;
  aturan yang sama diterapkan ke kedua mesin, jadi perbedaan status kedaluwarsa dicatat, bukan disamakan diam-diam.
- Setup berurutan dari satu mesin berkorelasi; CI bersifat indikatif.

## Troubleshooting
| Gejala | Penyebab / tindakan |
|---|---|
| `FETCH_FAILED` tnv2 | Lihat Diagnostics (HTTP/timeout/JS error). Run ulang. |
| `ZERO_CARDS_UNCONFIRMED` tnv2 | Struktur halaman mungkin berubah. Jalankan Discover dan bandingkan dengan `docs/VERIFIED.md`. |
| `SUMMARY_COUNT_MISMATCH` | Jumlah kartu tidak sama dengan ringkasan halaman. Periksa `rendered.html` terbaru. |
| `JOURNAL_HTTP_*` tn | journal.json tidak bisa diambil; run berikutnya akan mencoba lagi. |
| `TIME_MISMATCH` | Field `t` tidak sama dengan `waktu` pada entri jurnal. Dicatat sebagai peringatan. |
| `priceDataError` (HTTP 451/403) | Binance memblokir runner. Ubah `binanceBaseUrls` di settings. |
| Push gagal | Concurrency dan retry sudah ada. Pastikan izin *Read and write*. |

## Menjalankan lokal
`npm ci && npm test`. Koleksi nyata membutuhkan `npx playwright install chromium`.

## Pemulihan data & perubahan terbaru
- **`scripts/rebuild-setups.mjs`**: membangun ulang `data/jurnal.json` dari `data/raw/` (scan asli) dan, opsional,
  menggabungkan jurnal/`setups.json` repo lain (`--merge=path`). `data/setup.json` tidak disentuh (snapshot, bukan riwayat). Tidak pernah menghapus; evaluasi yang sudah ada
  dipertahankan (final mengalahkan PENDING). Default dry-run; tambah `--write` untuk menyimpan.
  Workflow manual `rebuild.yml` menjalankannya lalu `evaluate` + `build`.
  **Penting:** `raw/` dipangkas ke `rawRetentionPerEngine` (100) scan per mesin, sekitar 14 hari. Pulihkan sebelum
  scan tertua terhapus, atau naikkan angka itu di `config/settings.json`.
- **`sourceResult` / `sourceR` / `rawData`** kini diperbarui tiap scan; nilai pertama disimpan di `firstSourceResult`.
  Sebelumnya membeku di nilai saat pertama terlihat (mis. "menunggu"), sehingga hasil tn terlihat usang.
- **Timeframe tn** = `1D`. `journal.json` tidak punya field timeframe; nilainya diturunkan dari kode tn
  (sinyal dihitung dari candle harian). Konstanta `TN_TIMEFRAME` di `src/parsers/tn.js`.

## Hanya sinyal milik tiap mesin yang dinilai (lineage)
tnv2, tnv2c2, dan chatgpt adalah turunan `/tn/` dan memakai rantai jurnal yang sama. Halaman tnv2 menyatakan sendiri bahwa panel
"Jurnal sinyal"-nya mencatat **v1 (semua sinyal, tanpa gerbang)**; sinyal tnv2 sendiri ("Eliz v2", gerbang kualitas) hanya sebagian kecil
dan ditandai field `engine` yang berbeda. Karena itu jurnal tnv2 dulu terbaca hampir identik dengan tn.

Aturan per mesin ada di `config/sources.json` (ketujuh mesin wajib punya `inheritedEngineIds`; ada tes yang memeriksanya):

| Mesin | `inheritedEngineIds` | `legacyWithoutEngine` | `tableOnlyRows` | Dasar |
|---|---|---|---|---|
| crypto | `[]` | – | – | Kartu DOM, semua milik sendiri |
| tn | `[]` | – | – | Sumber v1; semua milik sendiri |
| tnv2 | v1 `0537067ed55fc5be` | inherited | unverified | Terverifikasi: 310 baris v1 + 15 lama = salinan; milik sendiri = engine `cdaa11430a4b55e8` |
| tnv2c2 | v1 | inherited | unverified | Terverifikasi: 290 baris v1 + 15 lama; milik sendiri = `c7f151a420fb0701` |
| dseek | v1 | own | own | Terverifikasi: rantai mulai kosong 2026-10-29 (engine `1eea4198621d8ad0`) |
| grox | v1 | own | unverified | Struktur halaman belum terverifikasi; entri hanya-tabel tidak dicatat |
| chatgpt | v1 | inherited | unverified | Terverifikasi: 290 baris v1 + 15 lama; milik sendiri = `dcfc14e83216c90f` |

- Entri dengan hash v1, atau (bila `legacyWithoutEngine: inherited`) entri lama tanpa field `engine`, adalah **salinan v1** dan tidak dicatat sebagai analisis mesin turunan.
- Entri yang hanya ada di tabel tidak bisa diperiksa engine-nya. Bila `tableOnlyRows: unverified`, entri itu tidak dicatat dan muncul peringatan `JOURNAL_LINEAGE_UNVERIFIED`.
- Record lama diberi tanda `lineage` pada run berikutnya; salinan v1 disembunyikan dari rekap dan riwayat (tidak dihapus dari `jurnal.json`), tidak dievaluasi ulang, dan tidak ditautkan ke tab Setup.
- Tab Diagnostics menampilkan per scan: jumlah baris milik sendiri / salinan v1 / tak pasti, beserta hash engine milik sendiri yang terlihat. Bila suatu mesin mengubah engine (hash baru), hash itu otomatis dianggap milik sendiri dan terlihat di sini.
- Bila `grox` atau `dseek` ternyata mewarisi jurnal v1, hash v1 sudah dikecualikan; sesuaikan `legacyWithoutEngine` setelah Discover.

## NO_TRADE
Hasil jurnal `NO_TRADE` (mis. chatgpt: "FILTER: Target sudah tercapai sebelum entry") berarti filter mesin menolak sinyal itu; tidak pernah menjadi trade.
Dinilai `CANCELLED` (tampil "Tidak terpakai"), baik pada basis mesin maupun basis candle, dan tidak dievaluasi dari candle.
