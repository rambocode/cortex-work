import { describe, expect, it } from "vitest";

import { nodePtyDiskRoot, nodePtySpawnHelperCandidates } from "./pty";

describe("node-pty spawn-helper path", () => {
  it("maps packaged app.asar roots to app.asar.unpacked before chmod", () => {
    const root = "/Applications/Cortex.app/Contents/Resources/app.asar/node_modules/node-pty";

    expect(nodePtyDiskRoot(root)).toBe(
      "/Applications/Cortex.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty",
    );
  });

  it("does not double-map an already unpacked root", () => {
    const root = "/Applications/Cortex.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty";

    expect(nodePtyDiskRoot(root)).toBe(root);
  });

  it("builds chmod candidates from the physical node-pty root", () => {
    const candidates = nodePtySpawnHelperCandidates(
      "/Applications/Cortex.app/Contents/Resources/app.asar/node_modules/node-pty",
      "darwin",
      "arm64",
    );

    expect(candidates).toEqual([
      "/Applications/Cortex.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper",
      "/Applications/Cortex.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Debug/spawn-helper",
      "/Applications/Cortex.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    ]);
  });
});
