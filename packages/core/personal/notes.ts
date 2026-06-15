// 闪记（Flash Notes）数据层 —— 服务主窗口收件箱/时间线。main 是 owner,这是
// 「服务端数据」,走 React Query 而非 zustand（KTD9）。query key 以 projectId 命名
//（桌面端无 wsId 概念,useWorkspaceId 返回占位值,绝不用 wsId,否则同桌面所有项目
// 笔记串到同一 key）。notes:changed 事件只触发 invalidateQueries,不直接 setState、
// 不写 Zustand（遵 CLAUDE.md「事件只触发 invalidation」）;窗口重获焦点 refetch 兜底
// 事件丢失。
//
// 浮层（独立 BrowserWindow 裸 React root,无 CoreProvider/QueryClient,KTD10）严禁用
// 本文件的 hook —— 浮层直连 window.desktopAPI.personal.notesAdd / loadState,只复用
// 本文件导出的纯函数 resolveDefaultNoteProject。

import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DesktopBridge } from "../desktop/bridge";
import type { NoteInput, NoteMeta, NoteStatus, SkillMeta } from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { initialModelDraft, usePersonalStore } from "../store/personal";
import { buildProjectSystemPrompt, usePersonalActions } from "./messages";
import { dayKey } from "./timeline";

// 无项目（未归类）的稳定占位段——绝不用 wsId。
const NO_PROJECT = "no-project";

// 多选深化条数上限（超限阻止,不静默截断条数）。
export const DEEPEN_MAX_NOTES = 20;
// 单条正文级截断上限（非 clipSummary 的 200——那只适合摘要,会砍残正文）。
export const DEEPEN_NOTE_BODY_MAX = 4000;

// query key（与 timelineKeys 形态对齐,均以 projectId 命名空间）。
export const notesKeys = {
  all: ["personal", "notes"] as const,
  byProject: (projectId: string) => ["personal", "notes", projectId] as const,
};

// 更新入参：复用 NoteInput 的可改字段 + 深化推进所需的状态/链接数组（完整数组替换）。
export type NotePatch = Partial<NoteInput> & {
  status?: NoteStatus;
  conversationIds?: string[];
  docPaths?: string[];
};

// ── 纯函数（供浮层与测试复用,无 React 依赖）──────────────────────────────

// 闪记能力是否可用（无 bridge / web 端 / 旧壳缺方法 → UI 隐藏入口）。
export function notesAvailable(bridge: DesktopBridge | null): boolean {
  return !!bridge?.notesList;
}

// 浮层空内容守卫：去掉首尾空白后为空 → 返回 null（调用方据此不创建、浮层保持打开,
// 仿 SpotlightBar.submit）;否则返回修剪后的正文（内部空白保留,仅修剪首尾）。
export function noteContentToSubmit(raw: string): string | null {
  const text = raw.trim();
  return text ? text : null;
}

// 默认归属推导：当前会话.projectId ?? activeProjectId ?? lastActiveProjectId；
// 都没有 → undefined（未归类）。取「第一个有值」的来源后校验该 projectId 仍在
// projects 中,失效则回落 undefined（不继续往下找,避免归到无关项目）。
export function resolveDefaultNoteProject(args: {
  currentSessionProjectId?: string;
  activeProjectId?: string;
  lastActiveProjectId?: string;
  projects: { id: string }[];
}): string | undefined {
  const candidate =
    args.currentSessionProjectId ?? args.activeProjectId ?? args.lastActiveProjectId;
  if (!candidate) return undefined;
  return args.projects.some((p) => p.id === candidate) ? candidate : undefined;
}

// ── 深化种子拼装（U8,纯函数,供编排与测试复用）──────────────────────────────

// prepareDeepenNotes 的结果：成功带处理后的 notes，失败带原因与可直接展示的提示文案。
export type DeepenPrepResult =
  | { ok: true; notes: NoteMeta[]; truncatedCount: number }
  | { ok: false; reason: "empty" | "too-many" | "already-deepening"; message: string };

// 校验 + 规整被选闪记:
// - 空选择 → empty（无可深化条目）;
// - 已在深化中 → already-deepening（防重复触发:deepening 态拦截再次深化,契约 5.5）;
// - 条数 > DEEPEN_MAX_NOTES → too-many（阻止,不静默截断条数）;
// - 按 createdAt 升序排列;
// - 单条正文超 DEEPEN_NOTE_BODY_MAX → 截断到上限（正文级,不可用 clipSummary 200）,
//   返回 truncatedCount 供调用方 toast 提示。
export function prepareDeepenNotes(notes: NoteMeta[]): DeepenPrepResult {
  if (notes.length === 0) {
    return { ok: false, reason: "empty", message: "请先选择要深化的闪记。" };
  }
  // 防重复触发:已深化中的闪记不允许再次发起（避免一条闪记并行多次深化）。已深化（deepened）
  // 可再深化（新开会话,链接追加）,故只拦 deepening。
  if (notes.some((n) => n.status === "deepening")) {
    return {
      ok: false,
      reason: "already-deepening",
      message: "选中的闪记里有正在深化的,请等它完成或回落后再操作。",
    };
  }
  if (notes.length > DEEPEN_MAX_NOTES) {
    return {
      ok: false,
      reason: "too-many",
      message: `一次最多深化 ${DEEPEN_MAX_NOTES} 条闪记,当前选了 ${notes.length} 条,请减少后重试。`,
    };
  }
  const sorted = [...notes].sort((a, b) => a.createdAt - b.createdAt);
  let truncatedCount = 0;
  const prepared = sorted.map((n) => {
    if (n.content.length > DEEPEN_NOTE_BODY_MAX) {
      truncatedCount += 1;
      return { ...n, content: n.content.slice(0, DEEPEN_NOTE_BODY_MAX) };
    }
    return n;
  });
  return { ok: true, notes: prepared, truncatedCount };
}

// 深化产出确定路径 = <cwd 去尾斜杠>/docs/ideation/<sessionId>-deepen.md。含 sessionId 隔离
// 会话（再深化新开会话=新文件,不覆盖旧产出）。run 收尾用 fs.exists 探测此确定路径判「已产出」
// ——不靠 changedFiles（claude 工具参数超 80 字会被截断成 …、extractChangedFile 丢弃,深化
// 产出的长绝对路径几乎必丢）。注入文案把此绝对路径给死 agent,绕开 ce-ideate 自由命名。
export function deepenDocPath(cwd: string, sessionId: string): string {
  const root = cwd.replace(/[/\\]+$/, "");
  return `${root}/docs/ideation/${sessionId}-deepen.md`;
}

// 生成 plan 产出确定路径 = <cwd 去尾斜杠>/docs/plans/<sessionId>-plan.md（与深化同机制）。
export function planDocPath(cwd: string, sessionId: string): string {
  const root = cwd.replace(/[/\\]+$/, "");
  return `${root}/docs/plans/${sessionId}-plan.md`;
}

// 拼深化 system prompt:只注入 ce-ideate 的元数据（源数据）+ SKILL.md 绝对路径,引导 agent
// 自己 Read 并按其方法论深化;在 headless claude -p 一次性流水线下**降格执行**（单 agent、禁
// 子 agent/Task、禁阻塞提问）,并把产出落点给死为确定绝对路径 outPath。每条闪记一个 <note> 块。
// 注意:传入的 notes 应已经过 prepareDeepenNotes 截断,这里只做包裹。
export function buildDeepenSystemPrompt(
  notes: NoteMeta[],
  opts: { skill: SkillMeta; outPath: string },
): string {
  const blocks = notes
    .map(
      (n) =>
        `<note id="${n.id}" created="${new Date(n.createdAt).toISOString()}">\n${n.content}\n</note>`,
    )
    .join("\n\n");
  const hint = opts.skill.argumentHint ? `\n参数提示: ${opts.skill.argumentHint}` : "";
  return [
    `请用内置 skill「${opts.skill.name}」深化下面这批闪记（想法种子）。`,
    `skill 元数据 ——\n名称: ${opts.skill.name}\n说明: ${opts.skill.description}${hint}`,
    `第一步:用 Read 工具读取 SKILL.md 全文并按其方法论执行: ${opts.skill.skillMdPath}`,
    `该 SKILL.md 内引用的所有 references/X 文件位于目录 ${opts.skill.dir}/references/ 下,需要时用该绝对前缀 Read（不要按当前工作目录解析相对路径）。`,
    [
      "执行约束（这是 headless 自动深化,无人交互,务必遵守）:",
      "- 禁止 dispatch 任何子 agent、禁止使用 Task 工具,全部工作在本上下文内完成;",
      "- 禁止使用 AskUserQuestion 或任何阻塞式提问,遇到需要决策处一律用合理默认继续;",
      "- 把下面的闪记正文当作已确定的主题,不要反问澄清;",
      `- 产出一份 markdown 深化文档,直接写到绝对路径: ${opts.outPath}（Write 工具会自动创建父目录,不要写 /tmp、不要自行决定文件名或目录）。`,
    ].join("\n"),
    blocks,
  ].join("\n\n");
}

// 拼生成 plan 的 system prompt:对称注入内置 ce-plan 元数据 + SKILL.md 路径,同款降格执行,
// 产出落点给死为 outPath。基于本会话已有的深化产出推进成 plan。
export function buildPlanSystemPrompt(opts: { skill: SkillMeta; outPath: string }): string {
  const hint = opts.skill.argumentHint ? `\n参数提示: ${opts.skill.argumentHint}` : "";
  return [
    `请用内置 skill「${opts.skill.name}」,基于本会话已产出的深化文档,生成一份可执行的 plan。`,
    `skill 元数据 ——\n名称: ${opts.skill.name}\n说明: ${opts.skill.description}${hint}`,
    `第一步:用 Read 工具读取 SKILL.md 全文并按其方法论执行: ${opts.skill.skillMdPath}`,
    `该 SKILL.md 内引用的所有 references/X 文件位于目录 ${opts.skill.dir}/references/ 下,需要时用该绝对前缀 Read。`,
    [
      "执行约束（headless 自动生成,无人交互,务必遵守）:",
      "- 禁止 dispatch 任何子 agent、禁止使用 Task 工具;",
      "- 禁止使用 AskUserQuestion 或任何阻塞式提问,遇到需要决策处一律用合理默认继续;",
      `- 产出一份 markdown plan 文档,直接写到绝对路径: ${opts.outPath}（Write 工具会自动创建父目录,不要写 /tmp、不要自行决定文件名或目录）。`,
    ].join("\n"),
  ].join("\n\n");
}

// ── 深化状态推进 / 失败回落（纯函数,供 finalizeRun 副作用与测试复用）──────────
//
// 「已产出」判定改为「run 收尾用 fs.exists 探测确定路径」（deepenDocPath / planDocPath,
// 均含 sessionId）。不靠 changedFiles:claude 工具参数超 80 字会被截断成 …、extractChangedFile
// 丢弃,深化产出的长绝对路径几乎必丢。探测在 applyDeepenFinalize（async + bridge）做,纯函数
// deepenStateTransition 只收 produced 布尔,保持可测。

// 追加不覆盖（去重）:再深化时 docPaths/conversationIds 累加同一数组,避免重复。
export function appendUnique(arr: string[] | undefined, item: string): string[] {
  const base = arr ?? [];
  return base.includes(item) ? base : [...base, item];
}

// 这条闪记是否「关联本会话」:conversationIds 含该 sessionId（不限状态）。深化（deepening）与
// 生成 plan（deepened）都复用同一深化会话 id,故 finalize 候选按此 gate;非关联会话完全 no-op。
export function isLinkedToSession(note: NoteMeta, sessionId: string): boolean {
  return !!note.conversationIds?.includes(sessionId);
}

// 仍被本会话深化中（status==='deepening' 且 conversationIds 含 sessionId）。保留供测试/外部用。
export function isDeepeningForSession(note: NoteMeta, sessionId: string): boolean {
  return note.status === "deepening" && isLinkedToSession(note, sessionId);
}

// 从全量闪记筛出「关联本会话」的（deepening 深化 或 deepened 生成 plan）——finalize 候选。
export function notesLinkedToSession(notes: NoteMeta[], sessionId: string): NoteMeta[] {
  return notes.filter((n) => isLinkedToSession(n, sessionId));
}

// 单条闪记在一轮 run 收尾后应得到的状态迁移（纯函数,完全可测）。按 note.status 分流:
// - deepening（深化 run）:terminalFailure → 回落 draft;produced（fs.exists 命中 deepenDocPath）
//   → deepened + 追加 docPath;否则 null（澄清轮,保持 deepening）。
// - deepened（生成 plan run）:terminalFailure → null（绝不回落,保护已深化成果）;
//   produced（命中 planDocPath）→ 仅追加 docPath,不改 status;否则 null。
// - 其它状态 → null（不触碰）。
export function deepenStateTransition(args: {
  note: NoteMeta;
  cwd: string;
  sessionId: string;
  produced: boolean;
  terminalFailure: boolean;
}): NotePatch | null {
  if (args.note.status === "deepening") {
    if (args.terminalFailure) return { status: "draft" };
    if (args.produced) {
      return {
        status: "deepened",
        docPaths: appendUnique(args.note.docPaths, deepenDocPath(args.cwd, args.sessionId)),
      };
    }
    return null;
  }
  if (args.note.status === "deepened") {
    if (args.terminalFailure) return null; // plan run 失败不抹掉已深化态
    if (args.produced) {
      return { docPaths: appendUnique(args.note.docPaths, planDocPath(args.cwd, args.sessionId)) };
    }
    return null;
  }
  return null;
}

// finalizeRun / 失败回落挂的深化副作用入口（messages.ts 调用,async）。严格 gate:
// 仅对「conversationIds 含 sessionId」的闪记动作（深化中 deepening 或 生成 plan 的 deepened）,
// 对普通会话完全 no-op（拉不到任何关联闪记即直接返回,不触碰其它会话/闪记）。产出判定用
// bridge.fileExists 探测确定路径（deepenDocPath/planDocPath）,绕开 changedFiles 截断。
// bridge 缺方法（web/旧壳）安全降级。
export async function applyDeepenFinalize(
  bridge: DesktopBridge | null,
  args: {
    sessionId: string;
    cwd: string | undefined;
    terminalFailure: boolean;
  },
): Promise<void> {
  if (!bridge?.notesList || !bridge.notesUpdate) return;
  let all: NoteMeta[];
  try {
    all = await bridge.notesList();
  } catch {
    return; // 拉取失败静默,不影响会话收尾
  }
  const linked = notesLinkedToSession(all, args.sessionId);
  if (linked.length === 0) return; // 普通会话:无关联闪记 → 完全 no-op
  // cwd 缺失时无法判定产出路径:终态失败仍按状态机处理,否则保持原状。
  const cwd = args.cwd ?? "";
  await Promise.all(
    linked.map(async (note) => {
      // 探测本条对应的确定产出路径是否已生成（deepening→深化文档;deepened→plan 文档）。
      // 终态失败 / 无 cwd 时不探测（produced=false,交状态机按 status 处理）。
      let produced = false;
      if (!args.terminalFailure && cwd) {
        const path =
          note.status === "deepening"
            ? deepenDocPath(cwd, args.sessionId)
            : planDocPath(cwd, args.sessionId);
        produced = (await bridge.fileExists?.(path)) ?? false;
      }
      const patch = deepenStateTransition({
        note,
        cwd,
        sessionId: args.sessionId,
        produced,
        terminalFailure: args.terminalFailure,
      });
      if (patch) await bridge.notesUpdate!(note.id, patch);
    }),
  );
}

// ── 查询（主窗口）─────────────────────────────────────────────────────────

// 单项目闪记列表（收件箱按项目分组 / 时间线合成用）。
export function useProjectNotes(projectId: string | undefined) {
  const bridge = useDesktopBridge();
  return useQuery<NoteMeta[]>({
    queryKey: notesKeys.byProject(projectId ?? NO_PROJECT),
    enabled: !!bridge?.notesList, // 缺桥/旧壳 → 关闭,UI 降级隐藏入口
    queryFn: () => bridge!.notesList!(projectId),
    staleTime: Infinity,
    refetchOnWindowFocus: true, // 兜底事件丢失（窗口重获焦点 refetch）
  });
}

// 全量闪记（收件箱按项目分组用）。
export function useAllNotes() {
  const bridge = useDesktopBridge();
  return useQuery<NoteMeta[]>({
    queryKey: notesKeys.all,
    enabled: !!bridge?.notesList,
    queryFn: () => bridge!.notesList!(),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  });
}

// 闪记能力是否可用（hook 形态,供 UI 降级隐藏入口）。
export function useNotesAvailable(): boolean {
  return notesAvailable(useDesktopBridge());
}

// ── 变更（成功后 invalidate notesKeys,让 RQ 重拉 main 的权威值）────────────

export function useAddNote() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<NoteMeta, Error, NoteInput>({
    mutationFn: (input) => bridge!.notesAdd!(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
    },
  });
}

export function useUpdateNote() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<NoteMeta | null, Error, { id: string; patch: NotePatch }>({
    mutationFn: (vars) => bridge!.notesUpdate!(vars.id, vars.patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
    },
  });
}

export function useDeleteNote() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => bridge!.notesDelete!(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
    },
  });
}

// ── 事件订阅（工作区根部挂载一次）──────────────────────────────────────────
// notes:changed 推全量快照,但这里只 invalidate,不 setQueryData(list)、不写 Zustand,
// 让 React Query 重新 notesList 拉权威值。onNotesChanged 返回 removeListener,卸载即清。
export function useNotesChangeSubscription(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  useEffect(() => {
    if (!bridge?.onNotesChanged) return;
    return bridge.onNotesChanged(() => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
    });
  }, [bridge, qc]);
}

// ── 深化编排（U8:建会话即发,首条防丢）──────────────────────────────────────
// 不为深化新造发送管线:只做「拼种子 → 推导 cwd → createSession → send」,且必须走
// usePersonalActions().send（KTD4:首条走共享 queryKey personalChatKeys.detail(sessionId)
// + ensureChatLoaded,绝不绕过 send 直接 appendMsg/setQueryData）。
//
// 顺序硬约束:createSession 拿到新会话 id → 用 id 拼 outPath/systemPrompt → send。outPath
// 依赖会话 id(= 新会话 id),故必须先建会话。
//
// 本单元只做「触发即置 deepening + 链会话 + 自动切到新会话」（契约 5.5 第一句）;状态
// 推进到「已深化」/ 失败回落留 U9。

export function useDeepenNotes(): (noteIds: string[], onToast: (text: string) => void) => Promise<void> {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const { send } = usePersonalActions();

  return useCallback(
    async (noteIds, onToast) => {
      if (!bridge) {
        onToast("当前环境不支持深化（缺少桌面能力）");
        return;
      }
      // 从 RQ 全量缓存取被选闪记的权威 NoteMeta（useAllNotes 已填充 notesKeys.all）。
      const all = qc.getQueryData<NoteMeta[]>(notesKeys.all) ?? [];
      const idSet = new Set(noteIds);
      const selected = all.filter((n) => idSet.has(n.id));

      // 校验 + 规整（空选择阻止 / 超 20 条阻止 / 升序 / 正文级截断 4000）。
      const prep = prepareDeepenNotes(selected);
      if (!prep.ok) {
        onToast(prep.message);
        return;
      }
      if (prep.truncatedCount > 0) {
        onToast(
          `有 ${prep.truncatedCount} 条正文超过 ${DEEPEN_NOTE_BODY_MAX} 字,已截断后作为种子。`,
        );
      }

      const st = usePersonalStore.getState();
      // 同项目约束由 U6 多选保证:取第一条的 projectId 作整批归属（升序后首条即最早创建）。
      const projectId = prep.notes[0]!.projectId;
      const proj = projectId ? st.projects.find((p) => p.id === projectId) : undefined;

      // cwd 推导（沿用 spotlightHandoff）:有项目 → 项目 path;无项目 → ensureNoProjectDir。
      let cwd = proj?.path;
      if (!cwd) {
        cwd = (await bridge.ensureNoProjectDir?.(dayKey(Date.now()))) ?? undefined;
      }
      if (!cwd) {
        // 失败不静默 return:给 toast 并保持闪记草稿（不置 deepening）。
        onToast("无项目且无桌面能力,无法深化。");
        return;
      }

      // agent/model 走「记忆 + 默认」标准派生（与新会话一致）。
      const draft = initialModelDraft(st);

      // 取内置 ce-ideate skill 元数据（缺失 → 降级早退,不建会话、不置 deepening）。
      const skill = await bridge.skillGet?.("ce-ideate");
      if (!skill) {
        onToast("当前环境缺少内置 ce-ideate skill,无法深化。");
        return;
      }

      // 建会话 → 拿新会话 id（outPath 依赖它,故顺序在 send 之前）。
      const sess = st.createSession(projectId, draft.agent, draft.model, proj ? undefined : { noProjectDir: cwd });
      // pi 专属:补 providerId（createSession 已尽力挂默认,这里对齐草稿选择）。
      if (draft.agent === "pi" && draft.providerId) st.updateSession(sess.id, { providerId: draft.providerId });

      // 深化产出确定路径（含会话 id,run 收尾 fs.exists 探测此路径判已深化）。
      const outPath = deepenDocPath(cwd, sess.id);
      // 注入 ce-ideate 元数据 + SKILL.md 路径（降格执行,产出落点给死 outPath）+ 项目信息块共存。
      const seedPrompt = buildDeepenSystemPrompt(prep.notes, { skill, outPath });
      const projectPrompt = buildProjectSystemPrompt(st.projects);
      const extraSystemPrompt = [projectPrompt, seedPrompt].filter(Boolean).join("\n\n") || undefined;

      // 触发即置 deepening + 把新会话 id 追加进 conversationIds（传完整数组,main 不做 merge）。
      // 在 send 之前先打 deepening:UI 立即显示「深化中」徽标并禁用再次深化（防重复触发）。
      if (bridge.notesUpdate) {
        await Promise.all(
          prep.notes.map((n) =>
            bridge.notesUpdate!(n.id, {
              status: "deepening",
              conversationIds: [...(n.conversationIds ?? []), sess.id],
            }),
          ),
        );
        qc.invalidateQueries({ queryKey: notesKeys.all });
      }

      // 自动切到新会话（与建会话即发一致）。
      st.setActiveSession(sess.id);

      // 首条防丢（KTD4）:send 内 await ensureChatLoaded 在任何 appendMsg 前完成;
      // 首条用户消息(发起深化的指令)走共享 queryKey,空历史不会覆盖它。
      const kickoff = prep.notes.length > 1 ? "请深化这批闪记。" : "请深化这条闪记。";
      await send(sess, cwd, kickoff, [], extraSystemPrompt);
    },
    [bridge, qc, send],
  );
}

// ── 生成 plan 编排（契约 5.7 显式触发,复用深化会话注入 ce-plan）───────────────
// 与 useDeepenNotes 同走 send（首条防丢 KTD4）,但**复用闪记最近一段深化会话**(取
// conversationIds 末项,沿用其工作目录),注入内置 ce-plan skill 元数据+路径,产出落点给死
// 为 planDocPath（docs/plans/<sessionId>-plan.md）。
//
// plan **不改 status**(仍 deepened),只把 planDocPath 追加进 docPaths。追加改靠 run 收尾
// applyDeepenFinalize 探测 planDocPath（deepened 分流,见上）——不在此即时追加,产出未真正
// 落地则不追加,比即时追加更准。不做 agent 链式自动:只在用户显式点「生成 plan」时触发一次。
export function useGeneratePlan(): (noteId: string, onToast: (text: string) => void) => Promise<void> {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const { send } = usePersonalActions();

  return useCallback(
    async (noteId, onToast) => {
      if (!bridge) {
        onToast("当前环境不支持生成 plan（缺少桌面能力）");
        return;
      }
      const all = qc.getQueryData<NoteMeta[]>(notesKeys.all) ?? [];
      const note = all.find((n) => n.id === noteId);
      if (!note) {
        onToast("找不到该闪记。");
        return;
      }
      // 生成 plan 以深化已产出为前提（deepened）。
      if (note.status !== "deepened") {
        onToast("请先完成深化,再生成 plan。");
        return;
      }
      // 取最近一段深化会话（conversationIds 末项;plan 写进它的目录,与 brainstorm 同处）。
      const conversationId = note.conversationIds?.[note.conversationIds.length - 1];
      if (!conversationId) {
        onToast("该闪记没有可用的深化会话,无法生成 plan。");
        return;
      }
      const st = usePersonalStore.getState();
      const sess = st.sessions.find((s) => s.id === conversationId);
      if (!sess) {
        // 深化会话已被删除(断链):新开会话不在本单元范围,给友好提示而非静默。
        onToast("原深化会话已不存在,无法在原目录生成 plan。");
        return;
      }
      // cwd 复用该会话的工作目录:有项目 → 项目 path;无项目会话 → noProjectDir。
      const proj = sess.projectId ? st.projects.find((p) => p.id === sess.projectId) : undefined;
      const cwd = proj?.path ?? sess.noProjectDir;
      if (!cwd) {
        onToast("无法定位深化会话的工作目录,无法生成 plan。");
        return;
      }

      // 取内置 ce-plan skill 元数据（缺失 → 降级早退）。
      const skill = await bridge.skillGet?.("ce-plan");
      if (!skill) {
        onToast("当前环境缺少内置 ce-plan skill,无法生成 plan。");
        return;
      }

      // plan 产出确定路径（复用深化会话 id;run 收尾 fs.exists 探测此路径追加 docPaths）。
      const outPath = planDocPath(cwd, conversationId);
      const planPrompt = buildPlanSystemPrompt({ skill, outPath });
      const projectPrompt = buildProjectSystemPrompt(st.projects);
      const extraSystemPrompt = [projectPrompt, planPrompt].filter(Boolean).join("\n\n") || undefined;
      // 注意:plan 路径不在此即时追加 docPaths,改靠 run 收尾 applyDeepenFinalize 探测 planDocPath
      // 后追加（deepened 分流,不改 status）——产出未真正落地则不追加,语义更准。

      // 切回该深化会话（继续观察 plan 产出,与深化一致）。
      st.setActiveSession(conversationId);

      // 首条防丢（KTD4）:复用 send,空历史不会覆盖追加的指令。
      await send(sess, cwd, "请基于已有深化文档生成 plan 文档。", [], extraSystemPrompt);
    },
    [bridge, qc, send],
  );
}
