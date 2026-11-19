import type { NextConfig } from "next";
import pkg from "./package.json";

const nextConfig: NextConfig = {
  basePath: "/midhub",
  env: { NEXT_PUBLIC_APP_VERSION: pkg.appVersion },
  devIndicators: false,
  experimental: {
    proxyClientMaxBodySize: "51mb",
  },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
