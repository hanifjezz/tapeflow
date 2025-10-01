import { NextResponse } from "next/server";
import { getStore, Point } from "../_store";
export const dynamic = "force-dynamic";

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(+d) ? null : d;
}

export async function GET(req: Request) {
  try {
    const STORE: Point[] = getStore();
    const url = new URL(req.url);
    const q = url.searchParams;

    const deviceId = q.get("device_id") || q.get("uid") || undefined;
    const sensorId = q.get("sensor_id"); // 1->A, 2->B, 3->C
    const id2addr: Record<string,string> = { "1":"A", "2":"B", "3":"C" };
    const onlyAddr = sensorId ? id2addr[sensorId] : undefined;

    const from = parseDate(q.get("from") || q.get("start")) ?? new Date(Date.now() - 60*60*1000);
    const to   = parseDate(q.get("to")   || q.get("end"))   ?? new Date();

    const rows = STORE.filter(p => {
      if (deviceId && p.uid !== deviceId) return false;
      if (onlyAddr && p.addr !== onlyAddr) return false;
      const t = new Date(p.timestamp);
      return t >= from && t < to;
    });

    const grouped = new Map<string, { name:string; rows:{ timestamp:string; temperature:number }[] }>();
    for (const r of rows) {
      if (!grouped.has(r.addr)) grouped.set(r.addr, { name: `Wadah ${r.addr}`, rows: [] });
      grouped.get(r.addr)!.rows.push({ timestamp: r.timestamp, temperature: r.temperature });
    }

    const series = Array.from(grouped.entries()).map(([addr, s]) => ({
      id: addr,
      name: s.name,
      rows: s.rows.sort((a,b) => +new Date(a.timestamp) - +new Date(b.timestamp)),
    }));

    return NextResponse.json({ series }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/measurements] error:", err);
    return NextResponse.json({ series: [] }, { status: 200 });
  }
}

export async function POST(req: Request) {
  try {
    const token = process.env.MEASUREMENTS_TOKEN;
    if (token) {
      const got = req.headers.get("x-api-key");
      if (!got || got !== token) {
        return NextResponse.json({ ok:false, error:"unauthorized" }, { status:401 });
      }
    }

    const { uid, addr, temperature, humidity } = await req.json();
    if (!uid || !addr || typeof temperature !== "number" || isNaN(temperature)) {
      return NextResponse.json({ ok:false, error:"bad payload" }, { status:400 });
    }

    const STORE: Point[] = getStore();
    const nowISO = new Date().toISOString();
    STORE.push({ uid:String(uid), addr:String(addr), temperature:Number(temperature), humidity, timestamp: nowISO });

    const MAX = 10_000;
    if (STORE.length > MAX) STORE.splice(0, STORE.length - MAX);

    return NextResponse.json({ ok:true, at: nowISO }, { status:200 });
  } catch (err) {
    console.error("[POST /api/measurements] error:", err);
    return NextResponse.json({ ok:false, error:"bad payload" }, { status:400 });
  }
}
