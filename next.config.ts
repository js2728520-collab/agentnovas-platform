import type { NextConfig } from "next";

const appAudience = process.env.RIVERTON_APP_AUDIENCE;

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  ...(appAudience ? { distDir: `.next-${appAudience}` } : {}),
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
