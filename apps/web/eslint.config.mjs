import nextConfig from "@cortex-work/eslint-config/next";

export default [...nextConfig, { ignores: [".next/", "out/"] }];
