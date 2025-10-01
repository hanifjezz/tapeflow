import { NextResponse } from "next/server";
import { getStore, Point } from "../_store";
export const dynamic = "force-dynamic";

export async function GET() {
  const STORE: Point[] = getStore();
  const uids = Array.from(new Set(STORE.map(p => p.uid)));

  const devices =
    uids.length
      ? uids.map(uid => ({ id: uid, name: uid.toUpperCase(), location: "Public" }))
      : [{ id: "esp32-a", name: "ESP32 A", location: "Public" }];

  return NextResponse.json(devices, { status: 200 });
}
