import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { json, withCORS } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEVICE_TOKEN = process.env.DEVICE_TOKEN ?? "";
const DEFAULT_DEVICE_ID = Number(process.env.DEFAULT_DEVICE_ID || 0);

export function OPTIONS() {
  return withCORS(new Response(null, { status: 204 }));
}

// Dapatkan sensors.id & device_id. ref bisa id numerik atau kode string.
// Kalau string belum ada -> buat sensor baru dengan device default.
async function getOrCreateSensor(ref: string) {
  const pool = getPool();

  // 1) numerik -> cari by id
  const n = Number(ref);
  if (!Number.isNaN(n) && String(n) === ref.trim()) {
    const [rows]: any = await pool.query("SELECT id, device_id FROM sensors WHERE id=? LIMIT 1", [n]);
    if (!rows?.length) throw new Error(`Sensor id ${n} tidak ditemukan`);
    return { sensorId: rows[0].id, deviceId: rows[0].device_id as number | null };
  }

  // 2) string -> cari by code atau name
  const [found]: any = await pool.query(
    "SELECT id, device_id FROM sensors WHERE code=? OR name=? LIMIT 1",
    [ref, ref]
  );
  if (found?.length) return { sensorId: found[0].id, deviceId: found[0].device_id as number | null };

  // 3) belum ada -> buat baru (butuh DEFAULT_DEVICE_ID valid)
  if (!DEFAULT_DEVICE_ID) throw new Error("DEFAULT_DEVICE_ID belum di-set");
  const [ins]: any = await pool.execute(
    "INSERT INTO sensors (device_id, code, name) VALUES (?, ?, ?)",
    [DEFAULT_DEVICE_ID, ref, ref]
  );
  return { sensorId: (ins as any).insertId as number, deviceId: DEFAULT_DEVICE_ID };
}

export async function GET() {
  const [rows]: any = await getPool().query(
    `SELECT m.id,
            COALESCE(s.code, CAST(m.sensor_id AS CHAR)) AS sensor_id,
            m.temperature,
            m.created_at
     FROM measurements m
     LEFT JOIN sensors s ON s.id = m.sensor_id
     ORDER BY m.id DESC
     LIMIT 500`
  );
  return json(rows);
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("x-device-key");
  if (DEVICE_TOKEN && token !== DEVICE_TOKEN) return json({ error: "Unauthorized device" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const { sensor_id, temperature } = body || {};
  if (sensor_id == null) return json({ error: "sensor_id required" }, 400);

  try {
    const { sensorId, deviceId } = await getOrCreateSensor(String(sensor_id));
    const deviceIdFinal = deviceId || DEFAULT_DEVICE_ID;

    if (!deviceIdFinal) {
      return json({ error: "NO_DEVICE_ID", detail: "Set DEFAULT_DEVICE_ID atau pastikan sensors.device_id terisi" }, 400);
    }

    await getPool().execute(
      "INSERT INTO measurements (sensor_id, device_id, temperature) VALUES (?, ?, ?)",
      [sensorId, deviceIdFinal, temperature ?? null]
    );
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "DB_ERROR", detail: e?.message ?? String(e) }, 500);
  }
}
