// app/api/measurements/route.ts
import { NextResponse } from "next/server";

// Hindari cache Vercel utk endpoint ini
export const dynamic = "force-dynamic";

type Point = {
  uid: string;            // device id (mis. "esp32-a")
  addr: string;           // channel (mis. "A"|"B"|"C")
  temperature: number;
  humidity?: number;
  timestamp: string;      // ISO
};

// In-memory store (per instance). Cukup untuk demo publik.
declare global {
  // eslint-disable-next-line no-var
  var __TAPEFLOW_STORE__: Point[] | undefined;
}
const STORE: Point[] = (globalThis as any).__TAPEFLOW_STORE__ ?? ((globalThis as any).__TAPEFLOW_STORE__ = []);

// Ring buffer sederhana
function pushPoint(p: Point) {
  STORE.push(p);
  const MAX = 10_000; // simpan maksimal ~10k titik
  if (STORE.length > MAX) STORE.splice(0, STORE.length - MAX);
}

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(+d) ? null : d;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams;

    const deviceId = q.get("device_id") || q.get("uid") || undefined;
    const from = parseDate(q.get("from") || q.get("start")) ?? new Date(Date.now() - 60 * 60 * 1000);
    const to   = parseDate(q.get("to")   || q.get("end"))   ?? new Date();

    // Ambil data sesuai device (atau semua kalau deviceId kosong)
    const rows = STORE.filter(p => {
      if (deviceId && p.uid !== deviceId) return false;
      const t = new Date(p.timestamp);
      return t >= from && t < to;
    });

    // Kelompokkan per addr (A/B/C/...)
    const grouped = new Map<string, { name: string; rows: { timestamp: string; temperature: number }[] }>();
    for (const r of rows) {
      if (!grouped.has(r.addr)) grouped.set(r.addr, { name: `Wadah ${r.addr}`, rows: [] });
      grouped.get(r.addr)!.rows.push({ timestamp: r.timestamp, temperature: r.temperature });
    }

    // Sort per series berdasarkan waktu ASC
    const series = Array.from(grouped.entries()).map(([addr, s]) => ({
      id: addr,
      name: s.name,
      rows: s.rows.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp)),
    }));

    // FE kamu mengharapkan { series: [...] }
    return NextResponse.json({ series }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/measurements] error:", err);
    // Fallback aman → jangan 500 agar FE tidak merah
    return NextResponse.json({ series: [] }, { status: 200 });
  }
}

export async function POST(req: Request) {
  try {
    // Opsi auth sederhana via env (hanya aktif jika variabel diset)
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

    const nowISO = new Date().toISOString();
    pushPoint({ uid: String(uid), addr: String(addr), temperature: Number(temperature), humidity, timestamp: nowISO });

    return NextResponse.json({ ok: true, at: nowISO }, { status: 200 });
  } catch (err) {
    console.error("[POST /api/measurements] error:", err);
    // Jangan 500—balas bad request
    return NextResponse.json({ ok: false, error: "bad payload" }, { status: 400 });
  }
}
