// 右栏「Tasks」面板数据层：聚合 docs/{ideation,brainstorms,plans}/*.md 文档。
// 服务端数据走 React Query（main/磁盘是 owner，不复制进 Zustand）。query key 以**仓库根**
// 命名空间——桌面端无 wsId 概念（参见 notes.ts 头注），docs 是仓库级资源，绝不用 wsId。
// docs/ 目录变更经 watchDir/onDirChanged 只触发 invalidateQueries（事件不直接 setState）。
//
// 解析全部委托给 core 纯函数（parseDocMeta/normalizeStatus/deriveTags/buildLineage）；
// listDocs 桥方法是 dumb 列表（列目录 + 头部文本）。「继续」动作复用闪记 headless 范式
// （skillGet → createSession → 拼 outPath/prompt → send），只读不回写源文档 frontmatter。

import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DesktopBridge } from "../desktop/bridge";
import type { DocFileRaw, SkillMeta } from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { initialModelDraft, usePersonalStore } from "../store/personal";
import { buildProjectSystemPrompt, usePersonalActions } from "./messages";
import { dayKey } from "./timeline";
import { parseDocMeta, type DocKind, type ParsedDocMeta } from "./docMeta";
import { normalizeStatus, type TaskStatus } from "./docStatus";
import { buildLineage } from "./docLineage";
import { deriveTags, type Tag } from "./docTags";

// 无项目（未归类）的稳定占位段——绝不用 wsId。
const NO_PROJECT = "no-project";

// 归一 + 标签后的文档视图（UI 直接消费）。
export interface DocMetaView extends ParsedDocMeta {
  status: TaskStatus;
  tags: Tag[];
  mtimeMs: number; // 来自 listDocs（用于排序/相对时间显示）
}

export interface DocTasksResult {
  docs: DocMetaView[];
  pipelines: DocMetaView[][];
  orphans: DocMetaView[];
}

export const docTasksKeys = {
  all: ["personal", "doc-tasks"] as const,
  byRoot: (root: string) => ["personal", "doc-tasks", root] as const,
};

// ── 纯组装（可表驱动测试，无 React/IO 依赖）─────────────────────────────────
export function assembleDocTasks(raw: DocFileRaw[]): DocTasksResult {
  const docs: DocMetaView[] = raw.map((r) => {
    const parsed = parseDocMeta(r.head, r.path, r.kind);
    return {
      ...parsed,
      mtimeMs: r.mtimeMs,
      status: normalizeStatus(parsed.statusRaw, parsed.kind),
      tags: deriveTags(parsed),
    };
  });
  const { pipelines, orphans } = buildLineage(docs);
  return { docs, pipelines, orphans };
}

// 文档能力是否可用（无 bridge / web / 旧壳缺 listDocs → UI 隐藏面板）。
export function docTasksAvailable(bridge: DesktopBridge | null): boolean {
  return !!bridge?.listDocs;
}

// 当前活动项目根目录（docs/ 所在仓库根）。无项目 → undefined（面板空态）。
function useActiveProjectRoot(): string | undefined {
  const projects = usePersonalStore((s) => s.projects);
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);
  return activeProjectId ? projects.find((p) => p.id === activeProjectId)?.path : undefined;
}

// ── 查询（按仓库根命名空间）───────────────────────────────────────────────
export function useDocTasks() {
  const bridge = useDesktopBridge();
  const root = useActiveProjectRoot();
  return useQuery<DocTasksResult>({
    queryKey: docTasksKeys.byRoot(root ?? NO_PROJECT),
    enabled: !!bridge?.listDocs && !!root,
    queryFn: async () => assembleDocTasks(await bridge!.listDocs!(root!)),
    staleTime: Infinity,
    refetchOnWindowFocus: true, // 兜底事件丢失
  });
}

// ── docs/ 目录监听（面板挂载一次）→ 只 invalidate，不 setQueryData/写 Zustand ──
export function useDocTasksWatch(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const root = useActiveProjectRoot();
  useEffect(() => {
    if (!bridge?.watchDir || !bridge.onDirChanged || !root) return;
    const id = `docs:${root}`;
    void bridge.watchDir(id, `${root.replace(/[/\\]+$/, "")}/docs`);
    const off = bridge.onDirChanged((changedId) => {
      if (changedId === id) qc.invalidateQueries({ queryKey: docTasksKeys.byRoot(root) });
    });
    return () => {
      off?.();
      bridge.unwatchDir?.(id);
    };
  }, [bridge, qc, root]);
}

// ── 继续动作（按 kind 路由下一步 skill；复用闪记 headless 范式）──────────────

export interface NextSkill {
  name: string; // 内置 skill 名
  label: string; // 按钮文案
  produces: DocKind | null; // 产出文档类别（null = ce-work，不产单一文档）
}

// 纯映射：ideation→brainstorm，brainstorm→plan，plan→实现（ce-work）。
export function nextSkillForKind(kind: DocKind): NextSkill {
  switch (kind) {
    case "ideation":
      return { name: "ce-brainstorm", label: "生成 Brainstorm", produces: "brainstorm" };
    case "brainstorm":
      return { name: "ce-plan", label: "生成 Plan", produces: "plan" };
    case "plan":
    default:
      return { name: "ce-work", label: "开始实现", produces: null };
  }
}

// brainstorm 产出确定路径（与 deepenDocPath/planDocPath 同机制：含会话 id）。
export function brainstormDocPath(cwd: string, sessionId: string): string {
  const root = cwd.replace(/[/\\]+$/, "");
  return `${root}/docs/brainstorms/${sessionId}-brainstorm.md`;
}

function planDocPathFor(cwd: string, sessionId: string): string {
  const root = cwd.replace(/[/\\]+$/, "");
  return `${root}/docs/plans/${sessionId}-plan.md`;
}

// 拼「继续」system prompt：注入下一步 skill 元数据 + SKILL.md 路径 + headless 降格约束，
// 让 agent 先 Read 源文档作输入；产出落点给死 outPath（ce-work 无 outPath，仅读 plan 实现）。
export function buildContinueSystemPrompt(opts: {
  skill: SkillMeta;
  sourcePath: string;
  outPath?: string;
}): string {
  const hint = opts.skill.argumentHint ? `\n参数提示: ${opts.skill.argumentHint}` : "";
  const outLine = opts.outPath
    ? `- 产出一份 markdown 文档，直接写到绝对路径: ${opts.outPath}（Write 工具会自动创建父目录，不要写 /tmp、不要自行决定文件名或目录）。`
    : `- 这是实现型 skill：基于上述源文档直接在项目中实现，不需另写一份产出文档。`;
  return [
    `请用内置 skill「${opts.skill.name}」，基于下面这份源文档继续推进。`,
    `第一步：用 Read 工具读取源文档全文作为输入: ${opts.sourcePath}`,
    `skill 元数据 ——\n名称: ${opts.skill.name}\n说明: ${opts.skill.description}${hint}`,
    `第二步：用 Read 工具读取 SKILL.md 全文并按其方法论执行: ${opts.skill.skillMdPath}`,
    `该 SKILL.md 内引用的所有 references/X 文件位于目录 ${opts.skill.dir}/references/ 下，需要时用该绝对前缀 Read（不要按当前工作目录解析相对路径）。`,
    [
      "执行约束（headless 自动执行，无人交互，务必遵守）:",
      "- 禁止 dispatch 任何子 agent、禁止使用 Task 工具;",
      "- 禁止使用 AskUserQuestion 或任何阻塞式提问，遇到需要决策处一律用合理默认继续;",
      outLine,
    ].join("\n"),
  ].join("\n\n");
}

// 从文档卡触发：起一个新 headless 会话推进到下一阶段。只读源文档、不回写其 frontmatter。
export function useContinueDoc(): (doc: DocMetaView, onToast: (text: string) => void) => Promise<void> {
  const bridge = useDesktopBridge();
  const { send } = usePersonalActions();

  return useCallback(
    async (doc, onToast) => {
      if (!bridge) {
        onToast("当前环境不支持继续（缺少桌面能力）");
        return;
      }
      const next = nextSkillForKind(doc.kind);

      const st = usePersonalStore.getState();
      const projectId = st.activeProjectId;
      const proj = projectId ? st.projects.find((p) => p.id === projectId) : undefined;

      // cwd 推导（沿用深化）：有项目 → 项目 path；无项目 → ensureNoProjectDir。
      let cwd = proj?.path;
      if (!cwd) cwd = (await bridge.ensureNoProjectDir?.(dayKey(Date.now()))) ?? undefined;
      if (!cwd) {
        onToast("无法定位工作目录，无法继续。");
        return;
      }

      // 取下一步 skill 元数据（缺失 → 降级早退，不建会话）。
      const skill = await bridge.skillGet?.(next.name);
      if (!skill) {
        onToast(`当前环境缺少内置 ${next.name} skill，无法继续。`);
        return;
      }

      const draft = initialModelDraft(st);
      // 建会话 → 拿 id（outPath 依赖它，故顺序在 send 之前）。
      const sess = st.createSession(projectId, draft.agent, draft.model, proj ? undefined : { noProjectDir: cwd });
      if (draft.agent === "pi" && draft.providerId) st.updateSession(sess.id, { providerId: draft.providerId });

      const outPath =
        next.produces === "brainstorm"
          ? brainstormDocPath(cwd, sess.id)
          : next.produces === "plan"
            ? planDocPathFor(cwd, sess.id)
            : undefined;

      const continuePrompt = buildContinueSystemPrompt({ skill, sourcePath: doc.path, outPath });
      const projectPrompt = buildProjectSystemPrompt(st.projects);
      const extraSystemPrompt = [projectPrompt, continuePrompt].filter(Boolean).join("\n\n") || undefined;

      st.setActiveSession(sess.id);
      await send(sess, cwd, `请基于源文档继续：${next.label}。`, [], extraSystemPrompt);
      // 产出落地由用户在新会话观察；docs 目录变更经 watch 自动 invalidate 刷新面板。
    },
    [bridge, send],
  );
}
