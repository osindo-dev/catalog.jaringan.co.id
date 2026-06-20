// ============================================================
// ALVA SYNC WORKER
// Sinkronisasi internal data produk AlvaMitra (Hikvision, HiLook,
// Ezviz, Sandisk, Synology, Seagate, WD) ke Cloudflare KV,
// untuk ditampilkan (read-only, tanpa cart/checkout) di Pages.
//
// PENTING — baca sebelum deploy:
// Halaman produk alvamitra.com di-render client-side (Next.js).
// fetch() biasa dari Worker TIDAK akan dapat data — perlu layanan
// rendering JS. Kode ini memakai Nimble Extract API sebagai
// jembatan (yang sama dipakai saat sesi ini berjalan), tapi
// kredensial API Nimble milik AKUN ANDA SENDIRI, bukan dari sesi
// Claude ini. Anda harus daftar/dapatkan API key di nimbleway.com
// dan isi sebagai secret NIMBLE_API_KEY sebelum kode ini berjalan.
// Tanpa itu, fungsi fetchProductJsonLd() di bawah akan gagal.
// ============================================================

const TARGET_BRANDS = [
  "Hikvision",
  "HiLook",
  "Ezviz",
  "Sandisk",
  "Synology",
  "Seagate",
  "WD",
  "Western Digital",
];

const SITEMAP_URL = "https://alvamitra.com/sitemap.xml";
const PRODUCT_URL = (id) => `https://alvamitra.com/product/${id}`;

// ---- 1. Ambil semua ID produk dari sitemap (request ringan, biasa) ----
async function getAllProductIds() {
  const res = await fetch(SITEMAP_URL);
  const xml = await res.text();
  const matches = [...xml.matchAll(/\/product\/(\d+)/g)];
  const ids = [...new Set(matches.map((m) => m[1]))];
  return ids;
}

// ---- 2. Ambil JSON-LD + compareProduct dari satu halaman produk ----
// Ini perlu rendering JS -> pakai Nimble Extract API.
// Ganti fungsi ini kalau Anda pilih provider lain (mis. Cloudflare
// Browser Rendering API) — kontrak return-nya tetap sama.
async function fetchProductData(id, env) {
  const targetUrl = PRODUCT_URL(id);

  // Endpoint terverifikasi dari docs.nimbleway.com/api-reference/introduction
  const nimbleRes = await fetch("https://sdk.nimbleway.com/v1/extract", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NIMBLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: targetUrl,
      render: true,
      wait: 3000,
      driver: "vx8",
    }),
  });

  if (!nimbleRes.ok) {
    throw new Error(`Nimble extract gagal untuk produk ${id}: ${nimbleRes.status}`);
  }

  const data = await nimbleRes.json();
  const text = data.data?.html || "";

  // JSON-LD schema.org Product ada di dalam <script type="application/ld+json">,
  // tapi nimble_extract plain_text sudah membuang tag — kita re-parse dari
  // pola "compareProduct" yang ditemukan tertanam di payload RSC Next.js.
  const compareMatch = text.match(/"compareProduct":\{([^}]*\}[^}]*)\}/);
  const ldJsonMatch = text.match(/\{"@context":"https:\/\/schema\.org","@type":"Product"[^]*?\}\}/);

  let brand = null;
  let price = null;
  let availability = null;
  let name = null;
  let sku = null;

  if (ldJsonMatch) {
    try {
      const ld = JSON.parse(ldJsonMatch[0]);
      brand = ld.brand?.name ?? null;
      price = ld.offers?.price ?? null;
      availability = ld.offers?.availability?.includes("InStock") ? "Ready" : "Lainnya";
      name = ld.name ?? null;
      sku = ld.sku ?? null;
    } catch (e) {
      // fallback ke regex sederhana di bawah kalau JSON.parse gagal
    }
  }

  // Fallback kasar kalau JSON-LD tidak ketemu (struktur halaman berubah)
  if (!brand) {
    const m = text.match(/Merek:\s*([A-Za-z0-9 .-]+)/);
    if (m) brand = m[1].trim();
  }
  if (!name) {
    const m = text.match(/^([^\n]+)\n/);
    if (m) name = m[1].trim();
  }

  return {
    id,
    name,
    sku,
    brand,
    price,
    availability,
    url: targetUrl,
    updatedAt: new Date().toISOString(),
  };
}

// ---- 3a. FULL SYNC (bulanan): bangun master list + filter merek ----
async function runFullSync(env) {
  const ids = await getAllProductIds();
  const filtered = [];
  const BATCH_SIZE = 20; // jaga supaya tidak melebihi batas waktu eksekusi Worker

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((id) => fetchProductData(id, env))
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.brand) {
        const brandNormalized = r.value.brand.trim();
        if (TARGET_BRANDS.some((b) => brandNormalized.toLowerCase() === b.toLowerCase())) {
          filtered.push(r.value);
        }
      }
    }
  }

  await env.PRODUCTS_KV.put("master_list", JSON.stringify(filtered));
  await env.PRODUCTS_KV.put(
    "master_list_meta",
    JSON.stringify({
      totalScanned: ids.length,
      totalFiltered: filtered.length,
      lastFullSync: new Date().toISOString(),
    })
  );

  return { totalScanned: ids.length, totalFiltered: filtered.length };
}

// ---- 3b. DAILY SYNC: refresh harga & stok untuk produk yang sudah difilter ----
async function runDailySync(env) {
  const raw = await env.PRODUCTS_KV.get("master_list");
  if (!raw) {
    // belum pernah full sync -> jalankan full sync dulu sebagai fallback
    return await runFullSync(env);
  }

  const products = JSON.parse(raw);
  const BATCH_SIZE = 20;
  const updated = [];

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((p) => fetchProductData(p.id, env))
    );

    results.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        updated.push(r.value);
      } else {
        // kalau gagal, pertahankan data lama supaya tidak hilang
        updated.push(batch[idx]);
      }
    });
  }

  await env.PRODUCTS_KV.put("master_list", JSON.stringify(updated));
  await env.PRODUCTS_KV.put(
    "master_list_meta",
    JSON.stringify({
      totalFiltered: updated.length,
      lastDailySync: new Date().toISOString(),
    })
  );

  return { totalFiltered: updated.length };
}

export default {
  async scheduled(event, env, ctx) {
    // Bedakan full sync (tanggal 1) vs daily sync (selain itu)
    const isMonthlyRun = event.cron === "0 3 1 * *";
    if (isMonthlyRun) {
      ctx.waitUntil(runFullSync(env));
    } else {
      ctx.waitUntil(runDailySync(env));
    }
  },

  // Endpoint API sederhana untuk dibaca Pages (frontend statis)
  // GET /products       -> semua produk terfilter
  // GET /products?brand=Hikvision -> filter tambahan per merek
  // GET /meta            -> info sinkronisasi terakhir
  // POST /sync/full      -> trigger manual full sync (untuk testing)
  // POST /sync/daily     -> trigger manual daily sync (untuk testing)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Endpoint debug: test parsing untuk SATU produk saja, supaya bisa
    // pastikan koneksi + parsing Nimble benar sebelum jalankan full sync
    // 4000+ produk yang berisiko timeout. Hapus rute ini setelah yakin jalan.
    // Debug: lihat response MENTAH dari Nimble apa adanya, supaya kita tahu
    // struktur field-nya yang benar sebelum perbaiki parsing.
    // Test skala kecil sebelum full sync 4000+ produk: jalankan batching +
    // tulis ke KV pakai 5 ID produk saja (ambil dari Best Seller yang sudah
    // kita kenal datanya). Hapus rute ini setelah yakin full sync jalan baik.
    if (url.pathname === "/debug/mini-sync") {
      const testIds = ["9170", "233", "14533", "9169", "9325"];
      const results = await Promise.allSettled(
        testIds.map((id) => fetchProductData(id, env))
      );
      const products = results
        .filter((r) => r.status === "fulfilled" && r.value.brand)
        .map((r) => r.value);

      await env.PRODUCTS_KV.put("master_list", JSON.stringify(products));
      await env.PRODUCTS_KV.put(
        "master_list_meta",
        JSON.stringify({
          totalFiltered: products.length,
          lastFullSync: new Date().toISOString(),
          note: "mini-sync test, bukan full sync",
        })
      );
      return Response.json({ totalProcessed: testIds.length, totalSaved: products.length, products });
    }

    if (url.pathname === "/debug/raw") {
      const testId = url.searchParams.get("id") || "9170";
      const nimbleRes = await fetch("https://sdk.nimbleway.com/v1/extract", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NIMBLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: `https://alvamitra.com/product/${testId}`, render: true, wait: 3000, driver: "vx8" }),
      });
      const status = nimbleRes.status;
      const raw = await nimbleRes.text();
      return new Response(JSON.stringify({ status, raw: raw.slice(0, 3000) }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/debug/one-product") {
      const testId = url.searchParams.get("id") || "9170";
      try {
        const result = await fetchProductData(testId, env);
        return Response.json({ success: true, result });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/products") {
      const raw = (await env.PRODUCTS_KV.get("master_list")) || "[]";
      let products = JSON.parse(raw);
      const brand = url.searchParams.get("brand");
      if (brand) {
        products = products.filter(
          (p) => p.brand?.toLowerCase() === brand.toLowerCase()
        );
      }
      return Response.json(products, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === "/meta") {
      const raw = (await env.PRODUCTS_KV.get("master_list_meta")) || "{}";
      return Response.json(JSON.parse(raw), {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // POST untuk pemakaian normal/otomatis, GET diizinkan juga supaya
    // bisa di-trigger langsung dari address bar browser saat testing.
    if (url.pathname === "/sync/full" && (request.method === "POST" || request.method === "GET")) {
      const result = await runFullSync(env);
      return Response.json(result);
    }

    if (url.pathname === "/sync/daily" && (request.method === "POST" || request.method === "GET")) {
      const result = await runDailySync(env);
      return Response.json(result);
    }

    return new Response("Not found", { status: 404 });
  },
};
