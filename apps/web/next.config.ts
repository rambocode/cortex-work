import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@cortex-work/core", "@cortex-work/ui", "@cortex-work/views"],
};

export default nextConfig;
