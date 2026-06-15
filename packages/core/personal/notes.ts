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
import type { NoteInput, NoteMeta, NoteStatus } from "../desktop/types";
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

// 确定性产出文档目录 = <projectDir>/docs/flash-notes/<conversationId>（剥项目目录尾斜杠）。
// conversationId = 本轮深化新会话 id（天然支持再深化:新会话=新目录,不覆盖旧产出）。
export function deepenDocDir(projectDir: string, conversationId: string): string {
  const root = projectDir.replace(/[/\\]+$/, "");
  return `${root}/docs/flash-notes/${conversationId}`;
}

// 拼深化种子 system prompt:首条前加引导语,每条一个 <note id created> 块,
// 把确定性产出路径 <docDir>/brainstorm.md 喂给 agent（复用 buildAttachmentSystemPrompt 的
// XML 包裹风格）。注意:传入的 notes 应已经过 prepareDeepenNotes 截断,这里只做包裹。
export function buildDeepenSystemPrompt(notes: NoteMeta[], docDir: string): string {
  const blocks = notes
    .map(
      (n) =>
        `<note id="${n.id}" created="${new Date(n.createdAt).toISOString()}">\n${n.content}\n</note>`,
    )
    .join("\n\n");
  return [
    "以下是用户记录的同一批闪记（想法种子）。请先提出关键澄清问题,再把它们孵化成 brainstorm 文档。",
    `产出文档请写到:${docDir}/brainstorm.md（如后续生成 plan,写到同目录 plan.md）。`,
    blocks,
  ].join("\n\n");
}

// 生成 plan 的种子 prompt（U10,契约 5.7 显式触发,不做 agent 链式自动）:
// 在已产出 brainstorm 的同一深化会话目录里,要求 agent 把 brainstorm 推进成 plan.md。
export function buildPlanSystemPrompt(docDir: string): string {
  return [
    `请基于已产出的 ${docDir}/brainstorm.md,把它推进成一份可执行的 plan 文档。`,
    `产出文档请写到:${docDir}/plan.md（与 brainstorm 同目录）。`,
  ].join("\n\n");
}

// ── 深化状态推进 / 失败回落（U9,纯函数,供 finalizeRun 副作用与测试复用）──────
//
// 「已深化」判定以「本轮 run 的 changedFiles 含约定产出路径」为准（KTD5）,不能靠
// 「文件存在」单独判（防再深化/放弃时旧同名文件误判）。路径归一化:约定路径与采集
// 路径都规约成「相对 cwd」再 includes 比对。

// 约定产出文档名（plan 同目录 plan.md;判已深化只认 brainstorm.md）。
export const DEEPEN_BRAINSTORM_FILE = "brainstorm.md";
// 生成 plan 的产出文件名（同 conversationId 目录;不计入「已深化」判定,只追加 docPaths）。
export const DEEPEN_PLAN_FILE = "plan.md";

// plan 产出文档的绝对路径（与 brainstorm 同目录,追加进 docPaths;不改 status）。
export function deepenPlanPath(cwd: string, conversationId: string): string {
  return `${deepenDocDir(cwd, conversationId)}/${DEEPEN_PLAN_FILE}`;
}

// 把一个路径规约成「相对 cwd」:绝对路径剥 cwd 前缀,已是相对则原样;统一正斜杠、
// 去首尾斜杠,便于跨平台/绝对相对混写时严格 includes 比对。extractChangedFile 截断
// 返回 undefined 的路径不会进 changedFiles,这里只处理已落地的字符串。
export function relForCompare(path: string, cwd: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = norm(cwd);
  let p = norm(path);
  if (root && (p === root || p.startsWith(root + "/"))) p = p.slice(root.length);
  return p.replace(/^\/+/, "");
}

// 本轮 run 的 changedFiles 是否含约定产出路径 <cwd>/docs/flash-notes/<sessionId>/brainstorm.md。
// changedFiles 里可能是相对 cwd（extractChangedFile 已剥前缀）或绝对（agent 写绝对路径）,
// 都规约成相对 cwd 再比对;约定路径同样规约。命中 → 本轮确有产出,可置已深化。
export function runProducedDeepenDoc(
  changedFiles: Iterable<string>,
  conversationId: string,
  cwd: string,
): boolean {
  const docDir = deepenDocDir(cwd, conversationId);
  const target = relForCompare(`${docDir}/${DEEPEN_BRAINSTORM_FILE}`, cwd);
  for (const f of changedFiles) {
    if (relForCompare(f, cwd) === target) return true;
  }
  return false;
}

// 约定产出文档的绝对路径（命中后写入 docPaths;追加不覆盖,再深化累加）。
export function deepenDocPath(cwd: string, conversationId: string): string {
  return `${deepenDocDir(cwd, conversationId)}/${DEEPEN_BRAINSTORM_FILE}`;
}

// 追加不覆盖（去重）:再深化时 docPaths/conversationIds 累加同一数组,避免重复。
export function appendUnique(arr: string[] | undefined, item: string): string[] {
  const base = arr ?? [];
  return base.includes(item) ? base : [...base, item];
}

// 这条闪记是否「正被本会话深化」:status==='deepening' 且 conversationIds 含该 sessionId。
// finalizeRun / 失败回落的副作用必须按此 gate —— 普通(非深化)会话完全 no-op,绝不误伤。
export function isDeepeningForSession(note: NoteMeta, sessionId: string): boolean {
  return note.status === "deepening" && !!note.conversationIds?.includes(sessionId);
}

// 从全量闪记里筛出「正被本会话深化」的（finalizeRun 副作用入口用）。
export function notesDeepeningForSession(notes: NoteMeta[], sessionId: string): NoteMeta[] {
  return notes.filter((n) => isDeepeningForSession(n, sessionId));
}

// 单条深化闪记在一轮 run 收尾后应得到的状态迁移（纯函数,完全可测）:
// - terminalFailure（spawn 失败/鉴权失败/超时/用户放弃且无产出）→ 回落 draft,
//   不置已深化、不追加 docPaths（conversationIds 保留断链历史）;
// - 本轮 changedFiles 含约定产出路径 → 置 deepened + 追加该路径到 docPaths（追加不覆盖）;
// - 普通澄清轮（无产出、无终态失败）→ 返回 null（保持 deepening,不回落、不已深化）。
export function deepenStateTransition(args: {
  note: NoteMeta;
  conversationId: string;
  cwd: string;
  changedFiles: Iterable<string>;
  terminalFailure: boolean;
}): NotePatch | null {
  if (args.terminalFailure) {
    return { status: "draft" };
  }
  if (runProducedDeepenDoc(args.changedFiles, args.conversationId, args.cwd)) {
    return {
      status: "deepened",
      docPaths: appendUnique(args.note.docPaths, deepenDocPath(args.cwd, args.conversationId)),
    };
  }
  // 无产出且非终态失败:深化进行中（agent 先提澄清问题）。保持 deepening,什么都不动。
  return null;
}

// finalizeRun / 失败回落挂的深化副作用入口（messages.ts 调用,async）。严格 gate:
// 仅对「该 session 有 status==='deepening' 且 conversationIds 含 sessionId」的闪记动作,
// 对普通会话完全 no-op（拉不到任何 deepening 闪记即直接返回,不触碰其它会话/闪记）。
// bridge 缺方法（web/旧壳）安全降级。
export async function applyDeepenFinalize(
  bridge: DesktopBridge | null,
  args: {
    sessionId: string;
    cwd: string | undefined;
    changedFiles: Iterable<string>;
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
  const linked = notesDeepeningForSession(all, args.sessionId);
  if (linked.length === 0) return; // 普通会话:无深化闪记 → 完全 no-op
  // cwd 缺失时无法判定产出路径:终态失败仍回落,否则保持 deepening。
  const cwd = args.cwd ?? "";
  await Promise.all(
    linked.map(async (note) => {
      const patch = deepenStateTransition({
        note,
        conversationId: args.sessionId,
        cwd,
        changedFiles: args.changedFiles,
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
// 顺序硬约束:createSession 拿到新会话 id → 用 id 拼 docDir/systemPrompt → send。docDir
// 依赖 conversationId(= 新会话 id),故必须先建会话。
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

      // 建会话 → 拿新会话 id（= conversationId,docDir 依赖它,故顺序在 send 之前）。
      const sess = st.createSession(projectId, draft.agent, draft.model, proj ? undefined : { noProjectDir: cwd });
      // pi 专属:补 providerId（createSession 已尽力挂默认,这里对齐草稿选择）。
      if (draft.agent === "pi" && draft.providerId) st.updateSession(sess.id, { providerId: draft.providerId });

      const docDir = deepenDocDir(cwd, sess.id);
      // 种子 system prompt + 项目信息块共存（项目块在前、种子在后,与 spotlight 合并风格一致）。
      const seedPrompt = buildDeepenSystemPrompt(prep.notes, docDir);
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

// ── 生成 plan 编排（U10:契约 5.7 显式触发,再开一段深化写 plan.md）─────────────
// 与 useDeepenNotes 同走 send（首条防丢 KTD4）,但**复用闪记最近一段深化会话**(取
// conversationIds 末项),在同一 conversationId 目录写 plan.md（5.6 路径约定:新会话=新目录,
// 这里刻意不新建会话,沿用 brainstorm 所在会话目录,让 plan 与 brainstorm 同处)。
//
// 与 brainstorm 不同:plan.md **不改 status、不计入「已深化」判定**(U9 交接约定),只把
// plan.md 路径追加进 docPaths（appendUnique 去重）。因该闪记已是 deepened（非 deepening）,
// finalizeRun 的 applyDeepenFinalize 对它完全 no-op（isDeepeningForSession 要求 deepening）,
// 故 docPaths 在此 UI 触发时即时追加,不依赖 run 收尾副作用。
//
// 不做 agent 链式自动:只在用户显式点「生成 plan」时触发一次。
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
      // 生成 plan 以 brainstorm 已产出为前提（deepened）。
      if (note.status !== "deepened") {
        onToast("请先深化产出 brainstorm,再生成 plan。");
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

      const docDir = deepenDocDir(cwd, conversationId);
      const planPrompt = buildPlanSystemPrompt(docDir);
      const projectPrompt = buildProjectSystemPrompt(st.projects);
      const extraSystemPrompt = [projectPrompt, planPrompt].filter(Boolean).join("\n\n") || undefined;

      // plan.md 即时追加进 docPaths（不改 status,仍 deepened;追加不覆盖,再生成幂等）。
      if (bridge.notesUpdate) {
        await bridge.notesUpdate(note.id, {
          docPaths: appendUnique(note.docPaths, deepenPlanPath(cwd, conversationId)),
        });
        qc.invalidateQueries({ queryKey: notesKeys.all });
      }

      // 切回该深化会话（继续观察 plan 产出,与深化一致）。
      st.setActiveSession(conversationId);

      // 首条防丢（KTD4）:复用 send,空历史不会覆盖追加的指令。
      await send(sess, cwd, "请基于已有 brainstorm 生成 plan 文档。", [], extraSystemPrompt);
    },
    [bridge, qc, send],
  );
}
