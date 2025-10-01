// app/api/measurements/route.ts
import { NextResponse } from "next/server";
import { getStore, Point } from "../_store";

export const dynamic = "force-dynamic";

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

export async function GET(req: Request) {
  try {
    const STORE: Point[] = getStore();
    const url = new URL(req.url);
    const q = url.searchParams;

    const deviceId = q.get("device_id") || q.get("uid") || undefined;

    // sensor_id numeric → addr A/B/C; juga dukung ?addr=A
    const id2addr: Record<string, string> = { "1": "A", "2": "B", "3": "C" };
    const onlyAddr =
      (q.get("addr") as string | null) ??
      (q.get("sensor_id") ? id2addr[q.get("sensor_id") as string] : undefined);

    const tzOff = Number(q.get("tzOffsetMinutes") || "0"); // contoh WIB = 420
    const from =
      parseWithOffset(q.get("from") || q.get("start"), tzOff) ??
      new Date(Date.now() - 60 * 60 * 1000);
    const to =
      parseWithOffset(q.get("to") || q.get("end"), tzOff) ?? new Date();

    // Filter & clamp
    const matched = STORE.filter((p) => {
      if (deviceId && p.uid !== deviceId) return false;
      if (onlyAddr && p.addr !== onlyAddr) return false;
      const t = new Date(p.timestamp); // ISO UTC saat POST
      return t >= from && t < to;
    });

    // Kelompokkan per addr
    const grouped = new Map<
      string,
      { name: string; rows: { timestamp: string; temperature: number }[] }
    >();
    for (const r of matched) {
      if (!grouped.has(r.addr)) grouped.set(r.addr, { name: `Wadah ${r.addr}`, rows: [] });
      grouped.get(r.addr)!.rows.push({ timestamp: r.timestamp, temperature: r.temperature });
    }

    const series = Array.from(grouped.entries()).map(([addr, s]) => ({
      id: addr,
      name: s.name,
      rows: s.rows.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp)),
    }));

    // Selalu kirim rows juga:
    // - kalau user minta addr tertentu → rows untuk addr itu
    // - kalau tidak, tapi hanya ada 1 seri → rows seri pertama
    // - kalau banyak seri → rows = [] (biar FE mode All abaikan)
    let rows: { timestamp: string; temperature: number }[] = [];
    if (onlyAddr) {
      rows = series.find(s => s.id === onlyAddr)?.rows ?? [];
    } else if (series.length === 1) {
      rows = series[0].rows;
    }

    return NextResponse.json({ series, rows }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/measurements] error:", err);
    return NextResponse.json({ series: [], rows: [] }, { status: 200 });
  }
}

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
      addr: String(addr),
      temperature: Number(temperature),
      humidity,
      timestamp: nowISO,
    });

    // ring buffer
    const MAX = 10_000;
    if (STORE.length > MAX) STORE.splice(0, STORE.length - MAX);

    return NextResponse.json({ ok: true, at: nowISO }, { status: 200 });
  } catch (err) {
    console.error("[POST /api/measurements] error:", err);
    return NextResponse.json({ ok: false, error: "bad payload" }, { status: 400 });
  }
}
