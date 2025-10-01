// app/api/measurements/route.ts
import { NextResponse } from "next/server";
import { getStore, Point } from "../_store";

/** ==== Vercel runtime & cache hints ==== */
export const runtime = "nodejs";                  // hindari Edge utk in-memory store
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const preferredRegion = ["sin1"];          // dekat Indonesia (Singapore)

/** Parse "YYYY-MM-DD HH:mm:ss" (lokal) → Date UTC sesuai offset menit. */
function parseWithOffset(mysqlLocal: string | null, offMin: number): Date | null {
  if (!mysqlLocal) return null;
  const m = mysqlLocal.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) {
    const d = new Date(mysqlLocal);
    return isNaN(+d) ? null : d;
  }
  const [_, Y, M, D, h, mi, s] = m.map(Number);
  const utcMs = Date.UTC(Y, M - 1, D, h, mi, s);
  return new Date(utcMs - offMin * 60 * 1000);
}

/** Normalisasi ID sensor: angka -> huruf (1->A), huruf -> huruf uppercase. */
function toLetter(raw: string | number | null | undefined): string {
  const s = String(raw ?? "").trim();
  const asNum = Number(s);
  if (!Number.isNaN(asNum) && asNum > 0 && asNum < 27) return String.fromCharCode(64 + asNum); // 1->A
  const m = s.match(/[A-Za-z]$/);
  return (m ? m[0] : s || "A").toUpperCase();
}
const sensorSort = (a: string, b: string) => a.localeCompare(b, "en");

/** GET: ringkas & robust */
export async function GET(req: Request) {
  try {
    const STORE: Point[] = getStore();
    const url = new URL(req.url);
    const q = url.searchParams;

    // --- Filter device ---
    const deviceId = q.get("device_id") || q.get("uid") || undefined;

    // --- Filter sensor (addr) ---
    const id2addr: Record<string, string> = { "1": "A", "2": "B", "3": "C" };
    const askedAddr =
      q.get("addr")?.toUpperCase() ||
      (q.get("sensor_id") ? id2addr[q.get("sensor_id") as string] : undefined);

    // --- Waktu + grace window ---
    const tzOff = Number(q.get("tzOffsetMinutes") || "0");   // WIB=420
    const graceSec = Math.min(Math.max(Number(q.get("graceSec") || "10"), 0), 60); // 0..60s
    const now = new Date();

    let from =
      parseWithOffset(q.get("from") || q.get("start"), tzOff) ??
      new Date(now.getTime() - 60 * 60 * 1000); // default 1 jam
    let to =
      parseWithOffset(q.get("to") || q.get("end"), tzOff) ??
      now; // default sekarang

    // longgarkan sedikit ke belakang supaya data telat tetap masuk
    from = new Date(from.getTime() - graceSec * 1000);

    // jaga agar to > from
    if (+to <= +from) to = new Date(from.getTime() + 1000);

    // --- Filter & clamp ---
    const matched = STORE.filter((p) => {
      if (deviceId && p.uid !== deviceId) return false;
      if (askedAddr && p.addr.toUpperCase() !== askedAddr.toUpperCase()) return false;
      const t = new Date(p.timestamp); // ISO UTC saat POST
      return t >= from && t < to;
    });

    // --- Kelompokkan per addr ---
    const grouped = new Map<string, { name: string; rows: { timestamp: string; temperature: number }[] }>();
    for (const r of matched) {
      const addr = toLetter(r.addr);
      if (!grouped.has(addr)) grouped.set(addr, { name: `Wadah ${addr}`, rows: [] });
      grouped.get(addr)!.rows.push({
        timestamp: r.timestamp,
        temperature: r.temperature,
      });
    }

    // --- Susun series: urut A, B, C, ... ---
    const series = Array.from(grouped.entries())
      .sort((a, b) => sensorSort(a[0], b[0]))
      .map(([addr, s]) => ({
        id: addr,
        name: s.name,
        rows: s.rows.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp)),
      }));

    // --- rows tunggal (untuk FE mode single) ---
    let rows: { timestamp: string; temperature: number }[] = [];
    if (askedAddr) {
      rows = series.find((s) => s.id === askedAddr.toUpperCase())?.rows ?? [];
    } else if (series.length === 1) {
      rows = series[0].rows;
    }

    return NextResponse.json(
      { series, rows, from: from.toISOString(), to: to.toISOString() },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[GET /api/measurements] error:", err);
    return NextResponse.json(
      { series: [], rows: [] },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/** POST: simpan ke ring-buffer in-memory */
export async function POST(req: Request) {
  try {
    // Opsional kunci sederhana
    const token = process.env.MEASUREMENTS_TOKEN;
    if (token) {
      const got = req.headers.get("x-api-key");
      if (!got || got !== token) {
        return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
    }

    const { uid, addr, temperature, humidity } = await req.json();

    if (!uid || !addr || typeof temperature !== "number" || isNaN(temperature)) {
      return NextResponse.json({ ok: false, error: "bad payload" }, { status: 400 });
    }

    const STORE: Point[] = getStore();
    const nowISO = new Date().toISOString(); // simpan UTC ISO

    STORE.push({
      uid: String(uid),
      addr: toLetter(addr),                // simpan sebagai huruf konsisten
      temperature: Number(temperature),
      humidity,
      timestamp: nowISO,
    });

    // ring buffer
    const MAX = 10_000;
    if (STORE.length > MAX) STORE.splice(0, STORE.length - MAX);

    return NextResponse.json(
      { ok: true, at: nowISO },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[POST /api/measurements] error:", err);
    return NextResponse.json(
      { ok: false, error: "bad payload" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
