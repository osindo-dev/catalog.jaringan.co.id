# Alva Sync Worker

Worker internal untuk sinkronisasi data produk AlvaMitra (merek: Hikvision,
HiLook, Ezviz, Sandisk, Synology, Seagate, WD) ke Cloudflare KV — dipakai
sebagai sumber data untuk halaman internal Cloudflare Pages (tampilan saja,
tanpa cart/checkout).

## ASUMSI & RISIKO YANG BELUM TERVERIFIKASI — wajib dicek sebelum deploy

1. **Endpoint Nimble API (`https://api.nimbleway.com/v1/extract`) di
   `worker.js` adalah TEBAKAN berdasarkan pola umum REST API, BUKAN endpoint
   resmi yang terkonfirmasi.** Saat saya menjalankan extract di sesi chat ini,
   itu lewat MCP tool yang mengabstraksi endpoint asli + kredensial akun
   Anda — saya tidak punya akses ke dokumentasi REST API Nimble yang
   sesungguhnya. **Anda WAJIB login ke dashboard Nimble, cek dokumentasi API
   resmi mereka, dan sesuaikan URL endpoint + format request/response di
   fungsi `fetchProductData()` sebelum kode ini bisa jalan.**
2. **Parsing JSON-LD mengandalkan struktur halaman alvamitra.com saat ini
   (Juni 2026).** Kalau mereka redesign situs, regex ini akan rusak diam-diam
   (silent failure — fallback ke null). Sebaiknya tambahkan alerting kalau
   `totalFiltered` di `/meta` turun drastis dari biasanya.
3. **Biaya Nimble untuk ~4.069 produk (full sync) + subset hasil filter
   (daily sync) belum saya hitung** — itu tergantung paket/harga akun Nimble
   Anda. Cek dulu sebelum jadwal otomatis aktif, supaya tidak kena biaya
   tak terduga.
4. **Batas eksekusi Cloudflare Worker (CPU time)** — kode ini pakai batching
   20 produk per langkah dengan `Promise.allSettled`, tapi untuk full sync
   4.069 produk ini akan butuh ratusan batch berurutan dalam satu invocation
   `scheduled()`. Worker gratis punya limit CPU time (~10ms-50ms CPU per
   request tergantung paket, BUKAN wall-clock — fetch eksternal tidak
   dihitung tapi tetap ada batas). **Anda kemungkinan perlu paket Workers
   Paid (Unbound) untuk full sync bulanan ini, atau pecah jadi beberapa
   Durable Object / Queue.** Saya tandai ini sebagai risiko nyata, bukan
   detail sepele.

## Cara deploy (setelah poin di atas diverifikasi)

```bash
npm install -g wrangler
wrangler login

# Buat KV namespace
wrangler kv namespace create PRODUCTS_KV
# Salin "id" hasilnya ke wrangler.toml

# Set API key Nimble (akun Anda sendiri)
wrangler secret put NIMBLE_API_KEY

# Deploy
wrangler deploy
```

## Testing manual sebelum mengandalkan cron

```bash
curl -X POST https://alva-sync-worker.<subdomain>.workers.dev/sync/full
curl https://alva-sync-worker.<subdomain>.workers.dev/meta
curl https://alva-sync-worker.<subdomain>.workers.dev/products?brand=Hikvision
```

Jalankan `/sync/full` manual dulu dan cek `totalFiltered` di response —
pastikan angkanya masuk akal (bukan 0, bukan sama dengan totalScanned)
sebelum mempercayakan ke cron bulanan otomatis.

## Cara Pages membaca data ini

Halaman Pages Anda (statis) tinggal `fetch()` ke
`https://alva-sync-worker.<subdomain>.workers.dev/products` saat render
(client-side fetch dari browser pengunjung, bukan build-time) — header CORS
sudah diatur terbuka (`*`) karena ini internal. Kalau mau dibatasi cuma bisa
diakses dari domain Pages Anda, ganti `Access-Control-Allow-Origin` jadi
domain spesifik.
