export function json(data: any, init?: number | ResponseInit) {
  const res = new Response(JSON.stringify(data), {
    status: typeof init === "number" ? init : (init as ResponseInit)?.status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(typeof init !== "number" ? (init as ResponseInit)?.headers : {}),
    },
  });
  return withCORS(res);
}
export function withCORS(res: Response) {
  const origin = process.env.CORS_ORIGIN || "*";
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type,X-Device-Key");
  return res;
}
