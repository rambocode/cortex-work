import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const platform = readArg("--platform", process.platform);
const arch = readArg("--arch", process.arch);
const goos = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
const resourceOS = platform === "win32" ? "win" : platform === "darwin" ? "mac" : platform;
const goarch = arch === "x64" ? "amd64" : arch;
if (!new Set(["darwin/arm64", "darwin/amd64", "windows/amd64", "linux/amd64", "linux/arm64"]).has(`${goos}/${goarch}`)) {
  throw new Error(`不支持 Cortex Runtime 目标: ${platform}-${arch}`);
}
const targetDir = join(desktopRoot, "resources", "cortex-runtime", `${resourceOS}-${arch}`);
const output = join(targetDir, goos === "windows" ? "cortex-runtime.exe" : "cortex-runtime");
mkdirSync(targetDir, { recursive: true });
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", output, "./cmd/cortex-runtime"], {
  cwd: join(desktopRoot, "runtime"),
  stdio: "inherit",
  env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
});
if (goos !== "windows") chmodSync(output, 0o755);
console.log(`[prepare-cortex-runtime] 已生成: ${output}`);
