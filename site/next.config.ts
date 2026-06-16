import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 默认语言为中文：根路径与裸语言路径都回到 /zh。
  async redirects() {
    return [{ source: "/", destination: "/zh", permanent: false }];
  },
};

export default nextConfig;
