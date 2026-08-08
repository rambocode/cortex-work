// 下载 openWakeWord 唤醒词 ONNX 模型到 resources/kws/（幂等：SHA-256 一致即跳过）。
// 模型随包分发（构建期 electron.vite.config.ts 的 kwsAssetsPlugin 拷进 out/renderer/kws/），
// 三个文件合计约 3.6MB：melspectrogram + embedding 共享，classifier 每唤醒词一个。
// 固定 release tag + SHA-256：上游 release 资产被替换时构建失败而非静默换模型。

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "resources", "kws");

const RELEASE_BASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
const MODELS = [
  {
    name: "melspectrogram.onnx",
    sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
  },
  {
    name: "embedding_model.onnx",
    sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
  },
  {
    name: "hey_jarvis_v0.1.onnx",
    sha256: "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
  },
];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  mkdirSync(destDir, { recursive: true });
  for (const model of MODELS) {
    const target = join(destDir, model.name);
    if (existsSync(target) && sha256(readFileSync(target)) === model.sha256) {
      console.log(`[kws] ${model.name} 已就绪，跳过`);
      continue;
    }
    const url = `${RELEASE_BASE}/${model.name}`;
    console.log(`[kws] 下载 ${url}`);
    // Node ≥18 的全局 fetch；经 globalThis 引用绕开脚本目录 eslint env 未声明 fetch 的误报。
    const res = await globalThis.fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`[kws] 下载失败 ${model.name}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const actual = sha256(buf);
    if (actual !== model.sha256) {
      throw new Error(`[kws] ${model.name} SHA-256 不匹配：期望 ${model.sha256}，实际 ${actual}`);
    }
    writeFileSync(target, buf);
    console.log(`[kws] ${model.name} 完成 (${buf.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
