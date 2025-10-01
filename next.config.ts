import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // Jangan fail build gara-gara ESLint error
    ignoreDuringBuilds: true,
  },
  // opsional: kalau ada error TS saat build dan kamu mau melanjutkan
  // typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
