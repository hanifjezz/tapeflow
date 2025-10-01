// app/api/_store.ts
export type Point = {
    uid: string;
    addr: string;                 // "A" | "B" | "C" | ...
    temperature: number;
    humidity?: number;
    timestamp: string;            // ISO string
  };
  
  /** Dapatkan ring buffer in-memory yang aman secara typing */
  export function getStore(): Point[] {
    // Perlu cast agar TypeScript paham global custom prop
    const g = globalThis as unknown as { __TAPEFLOW_STORE__?: Point[] };
    if (!g.__TAPEFLOW_STORE__) g.__TAPEFLOW_STORE__ = [];
    return g.__TAPEFLOW_STORE__!;
  }
  