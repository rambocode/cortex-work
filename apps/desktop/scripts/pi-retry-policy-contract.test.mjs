import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const piPackageJson = resolve(
  desktopRoot,
  "node_modules/@earendil-works/pi-coding-agent/package.json",
);
const bun =
  [process.env.BUN_PATH, join(process.env.HOME || "", ".bun/bin/bun")].find(
    (candidate) => candidate && existsSync(candidate),
  ) || "bun";

describe("Pi retry policy contract", () => {
  it("treats Bun socket-closed errors as retryable", () => {
    const result = spawnSync(
      bun,
      [
        "-e",
        `
          import { realpathSync } from "node:fs";
          import { dirname, resolve } from "node:path";
          import { pathToFileURL } from "node:url";
          const piPackageJson = realpathSync(${JSON.stringify(piPackageJson)});
          const compatPath = resolve(dirname(piPackageJson), "../pi-ai/dist/compat.js");
          const { isRetryableAssistantError } = await import(pathToFileURL(compatPath));
          const retryable = isRetryableAssistantError({
            role: "assistant",
            stopReason: "error",
            errorMessage:
              "The socket connection was closed unexpectedly. For more information, pass verbose mode to fetch()",
          });
          if (!retryable) process.exit(2);
        `,
      ],
      { cwd: desktopRoot, encoding: "utf8" },
    );

    expect(
      result.status,
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
    ).toBe(0);
  });
});
