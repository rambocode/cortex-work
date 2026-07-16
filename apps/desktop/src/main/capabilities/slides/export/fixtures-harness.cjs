// Slides 导出 fixture 渲染 harness:由测试用
//   `electron fixtures-harness.cjs <fixturesDir> <outDir> <injectScriptFile>`
// 直接拉起(真实 Chromium 渲染;vitest 的 Node 环境没有布局引擎,故隔进程跑)。
//
// 注入脚本由参数传入、不在本文件内维护:提取器的唯一事实源是 TS 侧的 dom-extractor.ts,
// 而本 harness 由裸 electron 执行(无 TS 转译)无法 import 它 —— 故测试先把
// EXTRACT_SCENE_SOURCE 写进临时文件,再把路径交给这里,避免两份实现漂移。
//
// 对 fixtures 目录中每个 *.html:
//   1. 隐藏 BrowserWindow 以固定 1280×720 加载,等 fonts/images 就绪;
//   2. 整页截图 <name>.full.png(人工/视觉对比基准);
//   3. 执行注入脚本得到 SlideScene,同时给原生/栅格元素打标记;
//   4. 注入 CSS 隐藏原生节点,再截 <name>.base.png(base raster,只剩复杂层与页面背景);
//   5. 计算 full/base 的「非背景像素占比」写入 <name>.scene.json 的 meta,
//      供测试量化断言「原生内容确实从 base raster 中被剔除」。
// 全部窗口在 finally 中销毁;完成情况写 done.json 供测试判定。

/* eslint-disable */

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// 等待字体与全部图片 load/error 完成(与 writing-export 同口径),避免截到未就绪版面。
const READY_WAIT_SCRIPT = `
  Promise.all([
    document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(),
    Promise.all(Array.from(document.images).map((img) => {
      if (img.complete) return Promise.resolve();
      return new Promise((res) => {
        img.addEventListener('load', () => res(undefined), { once: true });
        img.addEventListener('error', () => res(undefined), { once: true });
      });
    }))
  ]).then(() => undefined)
`;

// 隐藏原生节点、强制显示栅格层(visibility 可被子级覆盖,借此实现「容器隐藏但复杂子层保留」)。
const HIDE_NATIVE_CSS =
  '[data-cortex-native="1"] { visibility: hidden !important; }' +
  '[data-cortex-raster="1"] { visibility: visible !important; }';

// 非背景像素占比:以左上角像素为背景色,统计差异像素比例(BGRA 每通道容差 6)。
// 用途:text fixture 的 base raster 应接近纯背景(占比≈0),complex fixture 应明显非零。
function nonBackgroundRatio(nativeImg) {
  const size = nativeImg.getSize();
  const bmp = nativeImg.toBitmap();
  if (!size.width || !size.height || bmp.length < 4) return 0;
  const bgB = bmp[0];
  const bgG = bmp[1];
  const bgR = bmp[2];
  let diff = 0;
  const total = size.width * size.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (Math.abs(bmp[o] - bgB) > 6 || Math.abs(bmp[o + 1] - bgG) > 6 || Math.abs(bmp[o + 2] - bgR) > 6) {
      diff += 1;
    }
  }
  return diff / total;
}

// 处理单个 fixture:加载 → 截 full → 提取 scene → 隐藏原生层 → 截 base → 落盘 JSON/PNG。
// 复用同一个隐藏窗口顺序加载:实测「销毁旧窗口后立刻新建并 loadURL」会零星 ERR_FAILED(-2),
// 单窗口顺序 loadURL 无此问题;insertCSS 注入的样式在下一次导航后自动失效,无需手动清理。
async function processFixture(win, name, htmlPath, outDir, extractSource) {
  await win.loadURL(pathToFileURL(htmlPath).href);
  await win.webContents.executeJavaScript(READY_WAIT_SCRIPT);
  const full = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.full.png`), full.toPNG());

  const scene = await win.webContents.executeJavaScript(extractSource);

  await win.webContents.insertCSS(HIDE_NATIVE_CSS);
  // 等两帧确保隐藏样式已绘制,再截 base raster。
  await win.webContents.executeJavaScript(
    "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))))",
  );
  const base = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.base.png`), base.toPNG());

  const meta = {
    fullNonBackgroundRatio: nonBackgroundRatio(full),
    baseNonBackgroundRatio: nonBackgroundRatio(base),
    capturedSize: full.getSize(),
  };
  fs.writeFileSync(path.join(outDir, `${name}.scene.json`), JSON.stringify({ ...scene, meta }, null, 2));
}

async function main() {
  const fixturesDir = process.argv[2];
  const outDir = process.argv[3];
  const injectScriptFile = process.argv[4];
  if (!fixturesDir || !outDir || !injectScriptFile) {
    console.error("usage: electron fixtures-harness.cjs <fixturesDir> <outDir> <injectScriptFile>");
    app.exit(2);
    return;
  }
  const extractSource = fs.readFileSync(injectScriptFile, "utf8");
  fs.mkdirSync(outDir, { recursive: true });
  const fixtures = fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".html"))
    .sort();
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: { sandbox: true },
  });
  const done = [];
  try {
    for (const f of fixtures) {
      const name = path.basename(f, ".html");
      await processFixture(win, name, path.join(fixturesDir, f), outDir, extractSource);
      done.push(name);
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
    // 完成标记:macOS Electron 的 app.exit 码传递不可靠,测试端以 done.json 判定成败。
    fs.writeFileSync(path.join(outDir, "done.json"), JSON.stringify({ done }, null, 2));
  }
}

// 测试子进程不进 Dock、不用 GPU(headless CI 更稳)。
app.disableHardwareAcceleration();
if (app.dock) app.dock.hide();

app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error("[slides-poc-harness]", err);
    app.exit(1);
  });
