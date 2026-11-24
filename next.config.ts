import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Edge voice talks over a WebSocket; bundling `ws` breaks its optional native helpers.
  serverExternalPackages: ["msedge-tts", "ws"],
};

export default nextConfig;
