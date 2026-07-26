// Slides IPC 域(bento 化):renderer(SlidesWorkspace UI)↔ 主进程 deck 持久化的唯一通道。
//
// 跨进程契约:通道与请求/结果形状见 ./slides-ipc-types(与 core/desktop/slides-ipc-types
// 镜像)。所有 handler:
//   - 不信任 renderer 输入:workspaceRoot/deckId/revision 全部在 capabilities/slides/
//     bento-workspace 内重新校验(realpath、符号链接、边界、乐观锁);
//   - 不抛未捕获异常:一律返回结构化 { ok:false, error } 结果;
//   - 另存为的目标路径只由主进程保存对话框决定,renderer 不传输出路径。
import { BrowserWindow, dialog, ipcMain } from "electron";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BentoCreateDeckRequest,
  BentoDeckIpcResult,
  BentoDeckScopedRequest,
  BentoExportFileResult,
  BentoGetDeckResult,
  BentoSetStageRequest,
  BentoWriteDeckHtmlRequest,
  SlidesPresentRequest,
  SlidesPresentResult,
} from "./slides-ipc-types";
import {
  createBentoDeck,
  ensureBentoDeckRuntime,
  readBentoDeck,
  reshellBentoPresentation,
  updateBentoDeckMeta,
  writeBentoDeckHtml,
} from "../capabilities/slides/bento-workspace";
import { readBentoRuntimeHtml } from "../capabilities/slides/bento-runtime";
import {
  addSlidesDeckEventSender,
  type SlidesDeckEventSender,
} from "../capabilities/slides/deck-events";
import { openPresenterWindow } from "../presenter-window";

// 渲染端调任意 slides IPC 就意味着它在看某份 deck,需要接收 slides:deckChanged 推送 ——
// 与 ipc/research.ts 同一手法,不再单开一个 subscribe 通道(少一个通道少一处漂移)。
// 测试经存根 invoke 传 event=null,故防御性判空。
function registerSender(event: unknown): void {
  const sender = (event as { sender?: SlidesDeckEventSender } | null)?.sender;
  if (sender) addSlidesDeckEventSender(sender);
}

// 统一兜底:handler 内任何意外异常都转成结构化 io_error,不让 invoke reject。
async function guarded<T>(
  fallbackMessage: string,
  job: () => Promise<T>,
): Promise<T | { ok: false; error: { code: "io_error"; message: string } }> {
  try {
    return await job();
  } catch (err) {
    return {
      ok: false,
      error: { code: "io_error", message: `${fallbackMessage}: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}

async function showSaveDialog(
  parent: BrowserWindow | null,
  defaultName: string,
  filter: Electron.FileFilter,
): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    title: "导出演示文稿",
    defaultPath: defaultName,
    filters: [filter],
  };
  const res = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  return res.canceled || !res.filePath ? null : res.filePath;
}

export function registerSlidesHandlers(): void {
  ipcMain.handle("slides:bentoCreateDeck", (event, req: BentoCreateDeckRequest): Promise<BentoDeckIpcResult> => {
    registerSender(event);
    return guarded("创建演示文稿失败", async () => {
      const runtimeHtml = await readBentoRuntimeHtml();
      const res = await createBentoDeck({
        workspaceRoot: req.workspaceRoot,
        deckId: req.deckId,
        title: req.title,
        runtimeHtml,
      });
      return res.ok ? { ok: true as const, revision: res.value.revision } : { ok: false as const, error: res.error };
    });
  });

  ipcMain.handle("slides:bentoGetDeck", (event, req: BentoDeckScopedRequest): Promise<BentoGetDeckResult> => {
    registerSender(event);
    return guarded("读取演示文稿失败", async () => {
      const ensured = await ensureBentoDeckRuntime({
        workspaceRoot: req.workspaceRoot,
        deckId: req.deckId,
        runtimeHtml: await readBentoRuntimeHtml(),
      });
      if (!ensured.ok) return { ok: false as const, error: ensured.error };
      const res = await readBentoDeck({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      return res.ok
        ? {
            ok: true as const,
            json: res.value.json,
            revision: res.value.revision,
            stage: res.value.stage,
            outline: res.value.outline,
          }
        : { ok: false as const, error: res.error };
    });
  });

  // 提纲 gate 阶段推进(批准/退回;详见 bento-workspace 的 BentoDeckStage)。
  ipcMain.handle("slides:bentoSetStage", (event, req: BentoSetStageRequest): Promise<BentoDeckIpcResult> => {
    registerSender(event);
    return guarded("更新演示文稿阶段失败", async () => {
      const res = await updateBentoDeckMeta({
        workspaceRoot: req.workspaceRoot,
        deckId: req.deckId,
        patch: { stage: req.stage },
      });
      if (!res.ok) return { ok: false as const, error: res.error };
      const state = await readBentoDeck({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      return state.ok
        ? { ok: true as const, revision: state.value.revision }
        : { ok: false as const, error: state.error };
    });
  });

  ipcMain.handle("slides:bentoWriteDeckHtml", (event, req: BentoWriteDeckHtmlRequest): Promise<BentoDeckIpcResult> => {
    registerSender(event);
    return guarded("保存演示文稿失败", async () => {
      // runtimeHtml 用于落盘规范化(治体积膨胀,见 normalize-deck-html)。读壳失败不阻断保存:
      // 缺该参数时持久层退回原样直写,用户的编辑一定落得下去。
      const runtimeHtml = await readBentoRuntimeHtml().catch(() => undefined);
      const res = await writeBentoDeckHtml({
        workspaceRoot: req.workspaceRoot,
        deckId: req.deckId,
        html: req.html,
        baseRevision: req.baseRevision,
        runtimeHtml,
      });
      return res.ok ? { ok: true as const, revision: res.value.revision } : { ok: false as const, error: res.error };
    });
  });

  // 另存为 .bento.html:文档注入当前 runtime 后交付,避免旧 deck 导出历史运行壳。
  ipcMain.handle("slides:bentoExportFile", (event, req: BentoDeckScopedRequest): Promise<BentoExportFileResult> => {
    registerSender(event);
    return guarded("导出演示文稿失败", async () => {
      const res = await readBentoDeck({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      if (!res.ok) return { ok: false as const, error: res.error };
      let title = req.deckId;
      try {
        title = res.value.json ? ((JSON.parse(res.value.json) as { title?: string }).title ?? title) : title;
      } catch {
        // 标题仅用于默认文件名,解析失败无所谓。
      }
      const safeName = `${title.replace(/[^\w\d一-鿿-]+/g, "_").replace(/^_+|_+$/g, "") || "presentation"}.bento.html`;
      // 测试经存根 invoke 传 event=null;真实 IPC 恒有 sender,这里防御性判空。
      const sender = (event as { sender?: Electron.WebContents } | null)?.sender;
      const parent = sender ? BrowserWindow.fromWebContents(sender) : null;
      const target = await showSaveDialog(parent, safeName, { name: "HTML 演示文稿", extensions: ["html"] });
      if (!target) return { ok: false as const, canceled: true as const };
      // 保存对话框可停留任意时长;用户确认路径后重新读取,确保导出包含等待期间的编辑。
      const latest = await readBentoDeck({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      if (!latest.ok) return { ok: false as const, error: latest.error };
      const exportedHtml = latest.value.json
        ? reshellBentoPresentation(latest.value.json, await readBentoRuntimeHtml())
        : null;
      if (!exportedHtml) {
        return {
          ok: false as const,
          error: { code: "invalid_doc" as const, message: "演示文稿缺少有效文档,无法导出" },
        };
      }
      await fsp.writeFile(target, exportedHtml, "utf8");
      return { ok: true as const, path: target };
    });
  });

  // 演示模式(bento):直接加载 deck.bento.html;只读操作(不动 deck)。
  // stateOf 状态页不进线性导航,railIndices 在此从文档计算后交给演示窗口。
  ipcMain.handle("slides:present", (event, req: SlidesPresentRequest): Promise<SlidesPresentResult> => {
    registerSender(event);
    return guarded("打开演示窗口失败", async () => {
      const res = await readBentoDeck({ workspaceRoot: req.workspaceRoot, deckId: req.deckId });
      if (!res.ok) return { ok: false as const, error: res.error };
      // doc 解析失败(上游新格式)时退回宽松 JSON 读取 slides;再不行按无页处理。
      let slides: Array<{ stateOf?: unknown }> = (res.value.doc?.slides ?? []) as Array<{ stateOf?: unknown }>;
      if (slides.length === 0 && res.value.json) {
        try {
          const raw = JSON.parse(res.value.json) as { slides?: Array<{ stateOf?: unknown }> };
          slides = Array.isArray(raw.slides) ? raw.slides : [];
        } catch {
          slides = [];
        }
      }
      if (slides.length === 0) {
        return { ok: false as const, error: { code: "not_found" as const, message: "deck 里还没有可播放的页面" } };
      }
      const railIndices = slides
        .map((slide, index) => (slide && typeof slide.stateOf === "string" && slide.stateOf ? -1 : index))
        .filter((index) => index >= 0);
      // 放映一律用当前 runtime 换壳:deck.bento.html 携带的是创建时的旧 runtime,直接加载
      // 会让 runtime 侧修复(如演讲者视图布局)对存量 deck 不生效。换壳产物写临时目录,
      // cleanupPath 交给演示窗口在关闭时删除;换壳/写盘失败回退直接加载 deck(旧行为)。
      let deckHtmlPath = res.value.htmlAbs;
      let cleanupPath: string | undefined;
      if (res.value.json) {
        try {
          const reshelled = reshellBentoPresentation(res.value.json, await readBentoRuntimeHtml());
          if (reshelled) {
            const dir = await fsp.mkdtemp(join(tmpdir(), "cortex-present-"));
            deckHtmlPath = join(dir, "deck.bento.html");
            await fsp.writeFile(deckHtmlPath, reshelled);
            cleanupPath = dir;
          }
        } catch {
          // 换壳失败不阻断放映:回退 deck 原路径。
        }
      }
      await openPresenterWindow({
        title: res.value.doc?.title || req.deckId,
        deckHtmlPath,
        startIndex: Math.max(0, req.startIndex ?? 0),
        railIndices: railIndices.length > 0 ? railIndices : [0],
        cleanupPath,
      });
      return { ok: true as const };
    });
  });
}
