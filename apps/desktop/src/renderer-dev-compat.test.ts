import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const semver = require("semver") as {
  satisfies(version: string, range: string): boolean;
};

function readPackageJson(entrypoint: string): unknown {
  const entrypointPath = require.resolve(entrypoint);
  return JSON.parse(
    readFileSync(resolve(dirname(entrypointPath), "../package.json"), "utf8"),
  );
}

describe("desktop renderer dev dependencies", () => {
  it("keeps electron-vite and the React plugin compatible with Vite", () => {
    const vite = require("vite/package.json") as { version: string };
    const reactPlugin = readPackageJson("@vitejs/plugin-react") as {
      peerDependencies: { vite: string };
    };
    const electronVite = readPackageJson("electron-vite") as {
      peerDependencies: { vite: string };
    };

    expect(
      semver.satisfies(vite.version, reactPlugin.peerDependencies.vite),
      `Vite ${vite.version} does not satisfy @vitejs/plugin-react ${reactPlugin.peerDependencies.vite}`,
    ).toBe(true);
    expect(
      semver.satisfies(vite.version, electronVite.peerDependencies.vite),
      `Vite ${vite.version} does not satisfy electron-vite ${electronVite.peerDependencies.vite}`,
    ).toBe(true);
  });
});
