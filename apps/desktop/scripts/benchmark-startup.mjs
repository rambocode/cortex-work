import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electron from "electron";

const METRIC_PREFIX = "CORTEX_STARTUP_METRIC ";
const runArgument = process.argv.slice(2).find((argument) => argument !== "--");
const requestedRuns = Number.parseInt(runArgument ?? "5", 10);
if (!Number.isSafeInteger(requestedRuns) || requestedRuns < 1 || requestedRuns > 30) {
  throw new Error("运行次数必须是 1 到 30 之间的整数");
}

const appDir = join(import.meta.dirname, "..");

/** 启动独立 Electron 实例并采集 ready-to-show；超时或异常退出均明确失败。 */
async function measureOnce(index) {
  const userData = await mkdtemp(join(tmpdir(), `cortex-startup-${index}-`));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(electron, [appDir], {
        env: {
          ...process.env,
          CORTEX_STARTUP_BENCHMARK_USER_DATA: userData,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`第 ${index} 次启动 15 秒内未到 ready-to-show\n${stderr}`));
      }, 15_000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        const metrics = stdout
          .split(/\r?\n/u)
          .filter((line) => line.startsWith(METRIC_PREFIX))
          .map((line) => JSON.parse(line.slice(METRIC_PREFIX.length)));
        const ready = metrics.find((metric) => metric.name === "ready-to-show");
        const firstScreen = metrics.find((metric) => metric.name === "first-screen");
        if (!ready || typeof ready.elapsedMs !== "number") {
          reject(new Error(`第 ${index} 次启动未输出 ready-to-show（code=${code}, signal=${signal}）\n${stderr}`));
          return;
        }
        if (!firstScreen || typeof firstScreen.elapsedMs !== "number") {
          reject(new Error(`第 ${index} 次启动未输出 first-screen（code=${code}, signal=${signal}）`));
          return;
        }
        resolve({ firstScreenMs: firstScreen.elapsedMs, readyToShowMs: ready.elapsedMs, metrics });
      });
    });
  } finally {
    // 仅删除本轮 mkdtemp 创建且路径已精确持有的临时目录，不触碰真实 userData。
    await rm(userData, { recursive: true, force: true });
  }
}

const samples = [];
const firstScreenSamples = [];
for (let index = 1; index <= requestedRuns; index += 1) {
  const sample = await measureOnce(index);
  samples.push(sample.readyToShowMs);
  firstScreenSamples.push(sample.firstScreenMs);
  const created = sample.metrics.find((metric) => metric.name === "window-created");
  const createdText = typeof created?.elapsedMs === "number" ? `${created.elapsedMs.toFixed(1)} ms` : "n/a";
  console.info(`run ${index}: first-screen=${sample.firstScreenMs.toFixed(1)} ms window-created=${createdText} ready-to-show=${sample.readyToShowMs.toFixed(1)} ms`);
}

const sorted = [...samples].sort((a, b) => a - b);
const firstScreenSorted = [...firstScreenSamples].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const firstScreenMedian = firstScreenSorted[Math.floor(firstScreenSorted.length / 2)];
const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
const firstScreenAverage = firstScreenSamples.reduce((sum, value) => sum + value, 0) / firstScreenSamples.length;
console.info(`first-screen: median=${firstScreenMedian.toFixed(1)} ms average=${firstScreenAverage.toFixed(1)} ms min=${firstScreenSorted[0].toFixed(1)} ms max=${firstScreenSorted.at(-1).toFixed(1)} ms`);
console.info(`ready-to-show: median=${median.toFixed(1)} ms average=${average.toFixed(1)} ms min=${sorted[0].toFixed(1)} ms max=${sorted.at(-1).toFixed(1)} ms`);
