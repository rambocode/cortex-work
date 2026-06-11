import reactConfig from "@cortex-work/eslint-config/react";

export default [...reactConfig, { ignores: ["out/", "dist/"] }];
