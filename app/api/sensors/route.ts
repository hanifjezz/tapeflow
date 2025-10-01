import { NextResponse } from "next/server";
import { getStore, Point } from "../_store";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const STORE: Point[] = getStore();
  const url = new URL(req.url);
  const deviceId = url.searchParams.get("device_id") || "esp32-a";

  const addrs = Array.from(new Set(STORE.filter(p => p.uid === deviceId).map(p => p.addr)));
  const fallback = ["A", "B", "C"];

  const list = (addrs.length ? addrs : fallback).map((addr, i) => ({
    id: i + 1,            // FE pakai numeric id
    addr,
    name: `Wadah ${addr}`,
  }));

  return NextResponse.json(list, { status: 200 });
}
