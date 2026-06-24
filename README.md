# Katalog Internal — PT Jaringan Semesta Raya

Sistem katalog harga internal berbasis Cloudflare Pages + Worker. Menampilkan data produk ********* (Hikvision, HiLook, Ezviz, Sandisk, Synology, Seagate, WD) untuk referensi harga proposal dan pengadaan.

**Tidak untuk publik.** Akses dilindungi Cloudflare Access.

---

## Arsitektur

```
Browser (catalog.jaringan.co.id)     ← Cloudflare Pages
        │  fetch /products, /meta
        ▼
Cloudflare Worker (sync.jaringan.workers.dev)
        │  Nimble Extract API (render JS)
        ▼
*********.com  →  Cloudflare KV (master_list)
```

| Komponen | Keterangan |
|---|---|
| `index.html` | Frontend statis — filter, sort, search, export Excel, sync panel |
| Worker `sync` | Backend API + sync engine — **tidak** terhubung ke Git (lihat catatan deploy) |
| KV `PRODUCTS_KV` | Penyimpanan data produk dan state sync |
| Nimble Extract API | Rendering JS halaman *********.com (Next.js client-side) |

---

## Fitur

### Katalog
- Filter merek (Hikvision, HiLook, Ezviz, Sandisk, Synology, Seagate, WD)
- Filter kategori (dropdown, diisi dinamis dari data)
- Pencarian nama / SKU
- Urutan: Harga ↑, Harga ↓, Nama A–Z, Nama Z–A
- Chip filter aktif + reset per filter atau reset semua
- Export Excel (.xlsx via SheetJS)
- Salin ke WhatsApp per produk
- Indikator perubahan harga (▲ naik / ▼ turun vs sync sebelumnya)

### Sync Panel (terintegrasi di halaman)
- **Full Sync** — chunked, dijalankan dari browser, tidak timeout
- **Daily Sync** — update harga saja tanpa Nimble, lebih cepat
- Progress bar real-time + log per chunk
- Tombol Stop dan Lanjutkan (resume dari queue)
- Reload katalog otomatis setelah sync selesai

---

## Endpoint Worker

| Endpoint | Method | Keterangan |
|---|---|---|
| `/products` | GET | Semua produk. `?brand=Hikvision` untuk filter merek |
| `/meta` | GET | Info sync terakhir (timestamp, jumlah produk) |
| `/sync/status` | GET | Status sync real-time dari KV |
| `/sync/init` | GET | Inisialisasi full sync — fetch sitemap, simpan queue ke KV |
| `/sync/chunk` | GET | Proses satu batch dari queue. `?size=10` (default 10, max 15) |
| `/sync/full` | GET | Alias → redirect ke `/sync/init` |
| `/sync/daily` | GET | Trigger daily price sync (background) |
| `/debug/one-product` | GET | Test fetch satu produk. `?id=9170` |
| `/debug/mini-sync` | GET | Test sync 5 produk, tulis ke KV |
| `/debug/raw` | GET | Lihat response mentah Nimble. `?id=9334` |
| `/debug/test-notify` | GET | Test notifikasi ntfy.sh |

---

## Jadwal Cron

| Jadwal | Trigger | Aksi |
|---|---|---|
| `0 3 1 * *` | Tanggal 1 tiap bulan, jam 03.00 | Full sync (via `ctx.waitUntil`) |
| Selain itu | Cron lain yang dikonfigurasi | Daily price sync |

> **Catatan:** Full sync via cron hanya memulai satu batch pertama karena batas wall-clock Worker. Untuk full sync lengkap (4000+ produk), gunakan Sync Panel di browser.

---

## Cara Deploy Worker

> ⚠️ **Worker `sync` TIDAK boleh dihubungkan ke GitHub.** Menghubungkan Worker ke Git mengubahnya ke mode static-assets-only — semua KV bindings, cron triggers, dan secrets hilang. Worker di-deploy manual via Cloudflare Dashboard atau Wrangler CLI, dan di-backup ke Google Drive.

### Wrangler CLI

```bash
# Deploy worker
wrangler deploy

# Set secrets (hanya perlu sekali, tersimpan di Cloudflare)
wrangler secret put NIMBLE_API_KEY
wrangler secret put AUTH_PASSWORD
wrangler secret put NTFY_TOPIC
```

### Cloudflare Dashboard

1. Workers & Pages → Worker `sync` → Edit Code
2. Paste konten `worker.js` (ambil dari Google Drive backup)
3. Deploy

### Bindings yang harus ada

| Tipe | Nama variabel | Nilai |
|---|---|---|
| KV Namespace | `PRODUCTS_KV` | Namespace ID katalog |
| Secret | `NIMBLE_API_KEY` | API key akun Nimble |
| Secret | `AUTH_PASSWORD` | Password login halaman (opsional) |
| Secret | `NTFY_TOPIC` | Topic ntfy.sh untuk notifikasi gagal (opsional) |

---

## Cara Deploy Pages (index.html)

Repo ini terhubung ke Cloudflare Pages project `catalog`. Push ke `main` → otomatis deploy.

```bash
git add index.html
git commit -m "update"
git push origin main
```

---

## Menjalankan Full Sync

1. Buka `https://catalog.jaringan.co.id`
2. Klik area **Sinkronisasi Data** di bawah badge "Internal · Tidak untuk publik"
3. Klik **▶ Full Sync**
4. Biarkan tab terbuka — progress bar jalan otomatis (~272 chunk × 10 produk)
5. Selesai saat bar hijau dan katalog reload otomatis

Jika browser ditutup di tengah: buka kembali halaman, klik **⟳ Lanjutkan** (muncul otomatis jika ada queue tersisa).

---

## Struktur KV

| Key | Isi | Keterangan |
|---|---|---|
| `master_list` | JSON array produk terfilter | Data utama yang dibaca frontend |
| `master_list_meta` | `{totalScanned, totalFiltered, lastFullSync, lastDailySync}` | Metadata ditampilkan di navbar |
| `master_list_wip` | Array produk sementara | Hanya ada saat full sync berjalan, dihapus setelah selesai |
| `sync_progress` | `{status, processed, filtered, totalIds, ...}` | Dibaca `/sync/status` untuk progress bar |
| `sync_queue` | Array ID produk yang belum diproses | Mengecil tiap chunk, dihapus setelah selesai |
| `product_ids_cache` | Array semua ID dari sitemap | Cache fallback jika Nimble sitemap timeout |

---

## Catatan Teknis

**Nimble timeout (524):** Diatasi dengan retry 3× + exponential backoff di `getAllProductIds()`. Cache `product_ids_cache` dipakai sebagai fallback jika semua retry gagal.

**Chunked sync:** Full sync tidak bisa selesai dalam satu Worker invocation (4000+ produk × ~5 detik/produk via Nimble). Solusi: browser memanggil `/sync/chunk` berulang, masing-masing invocation baru, sampai queue habis.

**KV eventual consistency:** Jeda 1.5 detik ditambahkan di browser setelah `/sync/init` sebelum chunk pertama dipanggil, memberi waktu KV write tersebar ke semua edge node.

**Safety check:** Chunk terakhir membandingkan jumlah produk baru vs lama sebelum menimpa `master_list`. Jika hasil baru < 50% dari data lama, sync dibatalkan dan notifikasi ntfy dikirim.
