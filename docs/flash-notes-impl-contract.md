---
title: "闪记(Flash Notes)实现契约"
type: contract
date: 2026-06-15
plan: docs/plans/2026-06-15-001-feat-flash-notes-plan.md
brainstorm: docs/brainstorms/2026-06-15-shanji-notes-requirements.md
status: 实现期唯一权威契约（与计划一致；7 个待解问题在第 11 节定死，实现期不得再分歧）
---

# 闪记(Flash Notes)实现契约

本文件是计划 `2026-06-15-001` 的可执行落地契约。所有签名、路径、行号尽量逐字给出；
凡与本契约冲突的旧理解一律以本契约为准。开发与验证全部在 worktree
`/Users/mike/source/ai/cortex-work/.worktrees/feat/flash-notes` 内进行（先 `pnpm install`）。

行号基于当前 worktree 的源码快照（已逐一核对），实现期若有微小漂移以「锚点函数名/字面量」为准。

---

## 0. 命名与术语统一（全局约定）

- IPC 域名：`notes`（与 `store`/`timeline`/`automation` 风格一致）。
- 浮层命名空间：`notesOverlay`（preload 单列对象，**不**并入 `personal`/`DesktopBridge`，仿 `spotlight`）。
- 浮层窗口模块导出前缀：`NotesOverlay`（`showNotesOverlay` / `getNotesOverlayWindow` …）。
- 时间线事件 kind：`"note"`，合成事件 id 前缀：`note-<noteId>`。
- React Query key 根：`["personal", "notes", projectId]`（以 projectId 命名，**绝不用 wsId**，桌面端无 wsId 概念）。
- 闪记自身存储文件：`~/.cortex-desktop/notes.json`（单文件，元数据 + 内容内联）。
- 深化产出文档目录：`<projectDir>/docs/flash-notes/<conversationId>/`（`brainstorm.md` / `plan.md`）。

---

## 1. 共享数据契约（NoteMeta / NoteContent / NoteInput / NotesFileData）

### 1.1 决策（待解问题 1 定死）

**单文件 `notes.json`，元数据 + 内容内联进单一记录。** 没有独立 `NoteContent` 文件实体；
正文字段名定为 `content`（string，markdown 文本），内联在 `NoteMeta` 上。v1 不分文件。

> 计划任务文里出现的 "NoteContent" 仅指「正文」这一概念，落地为 `NoteMeta.content` 字段，不单独建类型。

### 1.2 TS 定义（逐字，须同时镜像到两份 types.ts）

两份文件**逐字一致**：
- `apps/desktop/src/main/ipc/types.ts`（主进程侧，注释「与 packages/core/desktop/types.ts 镜像」）
- `packages/core/desktop/types.ts`（core 侧，注释「与 apps/desktop/src/main/ipc/types.ts 镜像」）

```ts
// 闪记状态机：草稿 → 深化中 → 已深化（失败/放弃回落草稿）。
export type NoteStatus = "draft" | "deepening" | "deepened";

// 闪记单条记录：元数据 + 正文内联（单文件 notes.json，v1 不分文件）。
export interface NoteMeta {
  id: string;
  projectId?: string;            // 缺省 = 未归类（事后可归档到项目）
  status: NoteStatus;            // 默认 "draft"
  content: string;              // 正文（markdown 文本，内联）
  tags?: string[];
  sourceSessionId?: string;     // 捕捉时若在某会话内唤起则记下该会话
  conversationIds?: string[];   // 深化新开的会话 id（支持再深化，追加不覆盖）
  docPaths?: string[];          // 深化产出文档路径（追加不覆盖，再深化累加）
  createdAt: number;            // epoch ms（main 生成）
  updatedAt: number;            // epoch ms（main 每次写刷新）
}

// 渲染端创建闪记的入参（id/status/createdAt/updatedAt 由 main 生成，不传）。
export interface NoteInput {
  projectId?: string;
  content: string;
  tags?: string[];
  sourceSessionId?: string;
}

// notes.json 文件结构（对桥接层不透明，主进程独占写）。
export interface NotesFileData {
  version: 1;
  notes: NoteMeta[];
}
```

字段约束：
- `notesAdd` 由 main 生成 `id = newNoteId()`、`status = "draft"`、`createdAt = updatedAt = Date.now()`。
- `notesUpdate(id, patch)` 字段级合并，刷新 `updatedAt`；`conversationIds`/`docPaths` 由调用方传**完整数组**（main 不做数组 merge，避免重复去重逻辑分散）。
- 镜像漂移是头号坑：两份 types.ts 字段必须逐字相同，否则 preload 编译通过但运行期字段错位。

---

## 2. IPC 域契约（notes:list/add/update/delete + notes:changed）

### 2.1 通道名（裸字符串，三处必须完全一致）

| 用途 | 通道名 | 方向 |
|---|---|---|
| 拉列表 | `notes:list` | renderer → main（invoke） |
| 新增 | `notes:add` | renderer → main（invoke） |
| 更新 | `notes:update` | renderer → main（invoke） |
| 删除 | `notes:delete` | renderer → main（invoke） |
| 变更广播 | `notes:changed` | main → 所有窗口（send） |

三处对齐点：① `ipcMain.handle/on` 的 key（`apps/desktop/src/main/ipc/notes.ts`）；
② `ipcRenderer.invoke/on` 的 key（`apps/desktop/src/preload/index.ts`）；
③ `webContents.send` 的 key（notes.ts 内的 broadcast 助手）。拼错只在运行期表现为 invoke 永久 pending / 事件收不到，无编译报错。

### 2.2 入参 / 出参（逐字）

```ts
// main handler 签名（ipc/notes.ts）
ipcMain.handle("notes:list",   (_e, projectId?: string): Promise<NoteMeta[]> => …)
//   无 projectId → 返回全部；有 projectId → 仅返回该 projectId 的（含 undefined? 否，严格相等）
ipcMain.handle("notes:add",    (_e, input: NoteInput): Promise<NoteMeta> => …)
//   main 生成 id/status="draft"/createdAt/updatedAt，写盘后 broadcast，返回完整 NoteMeta
ipcMain.handle("notes:update", (_e, id: string, patch: Partial<Omit<NoteMeta,"id"|"createdAt">>): Promise<NoteMeta | null> => …)
//   找不到 id 返回 null；命中则字段级合并 + 刷新 updatedAt，写盘后 broadcast，返回更新后 meta
ipcMain.handle("notes:delete", (_e, id: string): Promise<void> => …)
//   删除该 id（仅删自身，不触碰文档/会话），写盘后 broadcast
```

### 2.3 notes:changed 事件载荷

```ts
// 推全量快照（不是增量）：renderer 收到后整体替换 / 直接 invalidate
webContents.send("notes:changed", list: NoteMeta[])
```
> 推全量是硬约定（对齐 automation/events.ts）。但因走 KTD9，core 侧 `onNotesChanged` 回调里
> **只 `queryClient.invalidateQueries`，不直接 setQueryData(list)、不写 Zustand**（见第 7 节）。

### 2.4 preload（apps/desktop/src/preload/index.ts，`personal` 对象内，逐字）

在 `personal` 对象内、automation 方法（:197-215）旁新增：

```ts
notesList:   (projectId?: string): Promise<NoteMeta[]> => ipcRenderer.invoke("notes:list", projectId),
notesAdd:    (input: NoteInput): Promise<NoteMeta>      => ipcRenderer.invoke("notes:add", input),
notesUpdate: (id: string, patch: Partial<NoteInput> & { status?: NoteStatus; conversationIds?: string[]; docPaths?: string[] }): Promise<NoteMeta | null> =>
  ipcRenderer.invoke("notes:update", id, patch),
notesDelete: (id: string): Promise<void>                => ipcRenderer.invoke("notes:delete", id),
onNotesChanged: (cb: (list: NoteMeta[]) => void): (() => void) => {
  const listener = (_e: IpcRendererEvent, list: NoteMeta[]) => cb(list);
  ipcRenderer.on("notes:changed", listener);
  return () => ipcRenderer.removeListener("notes:changed", listener);
},
```
`NoteMeta` / `NoteInput` / `NoteStatus` 从 `"../main/ipc/types"` 导入（与现有 import 同源）。
`onNotesChanged` **必须**返回 removeListener 取消函数（否则切 workspace/反复挂载泄漏）。

### 2.5 DesktopBridge 新增可选方法（packages/core/desktop/bridge.ts，automation 段 :167-177 旁，逐字）

全部 `?:` 可选（web 端 bridge=null / 旧壳缺方法时 UI 据此降级隐藏闪记入口）：

```ts
// 闪记（个人工作区）：可选能力，web 端无此桥、旧壳无此方法时收件箱/浮层入口降级隐藏。
notesList?(projectId?: string): Promise<NoteMeta[]>;
notesAdd?(input: NoteInput): Promise<NoteMeta>;
notesUpdate?(id: string, patch: Partial<NoteInput> & { status?: NoteStatus; conversationIds?: string[]; docPaths?: string[] }): Promise<NoteMeta | null>;
notesDelete?(id: string): Promise<void>;
onNotesChanged?(cb: (list: NoteMeta[]) => void): () => void;
```
- preload 的 `personal` 对象形状与 DesktopBridge **手工对齐、无 satisfies**：方法名/参数/返回逐条比对。
- core/views 调用前先判存在：`const bridge = useDesktopBridge(); bridge?.notesList?.(projectId)`。
- App.tsx / CoreProvider **无需改**（`window.desktopAPI.personal` 已泛化注入）。

---

## 3. 主进程存储（apps/desktop/src/main/ipc/notes.ts，新建）

### 3.1 照搬 store.ts 的哪些机制（待解问题 1 定死写法）

新建 `apps/desktop/src/main/ipc/notes.ts`，**直接复制 `store.ts` 的单文件三件套**（不要用 timeline 的 `Map<id,Promise>`，因 notes.json 是单文件）：

1. **串行写队列（单 Promise 链）**：
   ```ts
   let writeQueue: Promise<void> = Promise.resolve();
   ```
2. **内存镜像 cached**：
   ```ts
   let cached: NotesFileData | null = null;
   ```
3. **原子写（mkdir + 写 .tmp + rename）**，缩进对齐 store.ts 用 `JSON.stringify(data, null, 2)`（2 空格，人类可读、便于 diff）：
   ```ts
   async function saveNotesFile(data: NotesFileData): Promise<void> {
     const path = notesStorePath();
     await fsp.mkdir(dirname(path), { recursive: true });   // 首次写兜底，目录不存在 ENOENT
     const tmp = path + ".tmp";
     await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
     await fsp.rename(tmp, path);
   }
   ```
4. **读（优先缓存 + version/结构校验 + 失败不缓存）**，复制 store.ts:29/33-36 的语义：
   ```ts
   async function getNotes(): Promise<NotesFileData> {
     if (cached) return cached;
     try {
       const raw = await fsp.readFile(notesStorePath(), "utf8");
       const parsed = JSON.parse(raw);
       if (parsed?.version === 1 && Array.isArray(parsed.notes)) { cached = parsed; return parsed; }
     } catch { /* 文件不存在/损坏 */ }
     return { version: 1, notes: [] };   // 故意不缓存空状态（首次成功 save 才建镜像）
   }
   ```
5. **handler 写路径**（add/update/delete）模式（复制 store.ts:59-65 的 `cached = …; writeQueue = writeQueue.then(...).catch(console.error); return …`）：
   - 改内存数组（基于 `cached` 或 `getNotes()` 结果）→ 立即 `cached = next` → 串到 writeQueue → broadcast → return 结果。
   - catch 吞错只 `console.error`（与 store/timeline/chat 一致，v1 不向 renderer 上报写失败）。

6. **broadcast 助手**（在 notes.ts 内或单独 notes-events.ts，仿 automation/events.ts:7-11）：
   ```ts
   function broadcastNotesChanged(list: NoteMeta[]): void {
     for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("notes:changed", list);
   }
   ```

7. **id 生成**：`newNoteId()` 仿 automation/store.ts:uid，`note-<base36 时间>-<seq>-<random>`。

8. **register 导出**：`export function registerNotesHandlers(): void { … }`，注册四个 handler。

### 3.2 安全前提（与 timeline 一致，免 assertAllowed）

- notes.json 路径由主进程内部 `notesStorePath()` 生成，**renderer 只能传 content/projectId，不能传路径**。
- 因此 notes.ts **完全不调用 `assertAllowed`**（fs.ts:25），也**不需要 SAFE_ID 正则**（无可变 id 段拼进文件名，文件名固定 `notes.json`）。
- **不调用 `ensureMigrated`**（notes.json 是全新文件，无旧位置迁移历史，仿 timeline）。

### 3.3 paths.ts 新增（apps/desktop/src/main/paths.ts）

在 `automationsStorePath()`（:42-45）旁新增，形态完全一致：
```ts
// 闪记：单文件全量（元数据 + 正文内联）。
export function notesStorePath(): string {
  return join(cortexHome(), "notes.json");
}
```
同时更新 paths.ts 顶部目录清单注释（:1-4），补一行 `notes.json  闪记元数据 + 正文`。

### 3.4 register.ts（apps/desktop/src/main/ipc/register.ts）

- 第 16 行后加 `import { registerNotesHandlers } from "./notes";`
- `registerIpcHandlers()` 体内（`registerStoreHandlers();` 附近）加一行 `registerNotesHandlers();`。
- notes 域无外部依赖（不复用 fs 的 assertAllowed），放在 `registerStoreHandlers()` 后即可；import 与调用两处都要加，漏一处 invoke 永久 pending。

---

## 4. personal store 切片改动（packages/core/store/personal.ts + 镜像类型）

### 4.1 lastActiveProjectId 持久化（KTD2，四文件五处）

**(1) `packages/core/desktop/types.ts` PersistedState（:385-404）**，在 `lastProviderId?` 后加：
```ts
  // 最近活跃项目（浮层默认归属推导用；归档/删除该项目时清空）。
  lastActiveProjectId?: string;
```

**(2) `packages/core/store/personal.ts` PersonalState 接口（:94 `lastProviderId?` 旁）**：
```ts
  lastActiveProjectId?: string;
```

**(3) hydrate 回填（:256 `lastProviderId` 旁）**：
```ts
      lastActiveProjectId: s.lastActiveProjectId,
```

**(4) toPersistedState 快照（:557 `lastProviderId` 旁）**：
```ts
    lastActiveProjectId: s.lastActiveProjectId,
```

**(5) saveUrgency immediate 档（packages/core/desktop/usePersonalPersistence.ts:20-25）**，把 immediate 条件扩为：
```ts
  if (
    s.projects !== prev.projects ||
    s.promptRoot !== prev.promptRoot ||
    s.generalSettings !== prev.generalSettings ||
    s.lastActiveProjectId !== prev.lastActiveProjectId   // 浮层经主进程 cached 读它，必须立即落盘绕过 500ms 节流
  )
    return "immediate";
```
> immediate 的代价 = 每次切项目一次全量写（toPersistedState 全量快照）。这是规避 `tasks/lessons.md` 2026-06-11
> 同款竞态的必需代价（亚秒级捕捉读旧值会归错项目）。

### 4.2 写入入口

**activateProject（:450-457，左栏点项目名，直接对象 set，加一行最简洁）**：
```ts
  activateProject: (projectId) =>
    set({
      activeProjectId: projectId,
      lastActiveProjectId: projectId,   // 新增
      activeSessionId: undefined,
      timelineProjectId: undefined,
      homeOpen: false,
      automationOpen: false,
    }),
```

**setActiveSession（:437-448，函数式回调，仅在 sess.projectId 存在时写，避免无项目会话覆盖）**：
```ts
  setActiveSession: (sessionId) =>
    set((s) => {
      const sess = s.sessions.find((x) => x.id === sessionId);
      return {
        activeSessionId: sessionId,
        activeProjectId: sess?.projectId ?? s.activeProjectId,
        lastActiveProjectId: sess?.projectId ?? s.lastActiveProjectId,   // 新增：无项目会话不覆盖
        timelineProjectId: undefined,
        homeOpen: false,
        automationOpen: false,
      };
    }),
```
> createSession 不强制写 lastActiveProjectId（建完会话即发流程会随后调 setActiveSession）。若实现期发现深化建会话未经 setActiveSession，则在 createSession 的 set 里同样按 `projectId ?? s.lastActiveProjectId` 补（需把 :369 起的直接对象 set 改为 `(s) => …` 回调）。

### 4.3 清空入口（防悬空 id，判等清空，与 activeProjectId 处理对称）

**removeProject（:271-280）** 内 set 对象追加：
```ts
      lastActiveProjectId: s.lastActiveProjectId === id ? undefined : s.lastActiveProjectId,
```
**archiveProject（:287-298）** 内 set 对象追加同一行（归档项目不应再作默认归属拉起）：
```ts
      lastActiveProjectId: s.lastActiveProjectId === id ? undefined : s.lastActiveProjectId,
```

### 4.4 rightView 加 "notes"（三处，强烈建议同时抽别名）

**最小改三处字面量**：
- personal.ts:67 `rightView: "files" | "skills" | "todos" | "notes";`
- personal.ts:152 `setRightView: (view: "files" | "skills" | "todos" | "notes") => void;`
- `packages/views/cortex-desktop/personal/PersonalTopBar.tsx:74` `const pick = (view: "files" | "skills" | "todos" | "notes") => {`

> **治本建议（推荐）**：在 personal.ts 顶部 `export type RightView = "files" | "skills" | "todos" | "notes";`，三处引用 `RightView`，后续再加视图不必三处改。改完必跑 `store/personal.test.ts` 与 `PersonalRightPanel.test.tsx`（断言了 rightView）。

### 4.5 requestNoteDetail / consumeNoteDetailRequest 三件套（严格镜像 filePreview）

**(a) 瞬态状态字段（紧贴 :65 `filePreviewRequest?` 加，注释标明「瞬态，不进 toPersistedState」）**：
```ts
  // 瞬态：点击收件箱/时间线某条闪记 → 跨栏打开详情；消费即清，不进 toPersistedState。
  noteDetailRequest?: { noteId: string };
```

**(b) action 签名（紧贴 :151 加）**：
```ts
  requestNoteDetail: (req: { noteId: string }) => void;
  consumeNoteDetailRequest: () => { noteId: string } | undefined;
```

**(c) 实现（紧贴 :504 加，request 同时切 rightView:"notes"，consume 取出即清，无 nonce）**：
```ts
  requestNoteDetail: (req) => set({ noteDetailRequest: req, rightView: "notes" }),
  consumeNoteDetailRequest: () => {
    const req = get().noteDetailRequest;
    if (req) set({ noteDetailRequest: undefined });
    return req;
  },
```
> `noteDetailRequest` **绝不进 toPersistedState（:541-559），也不进 saveUrgency 任何分支** —— 纯瞬态 UI 跳转请求。
> consume 用「消费即清」而非 nonce：NotesView 可能在 request 发出时未挂载，取出即清才能让挂载后 effect 接到。

---

## 5. 深化管线（U8 + U9）

### 5.1 两段挂载（严格复刻 spotlightHandoff，不在回调里直接 send）

不为深化新造发送管线。深化触发点（NotesView 多选「深化」按钮）只做「拼种子 → 切工作区 → 建会话 → send」，
但**必须走 `usePersonalActions().send`**（messages.ts:735-741），并满足首条防丢。深化编排放
`packages/core/personal/notes.ts`（导出 `useDeepenNotes()` hook 或 `deepenNotes(...)` 编排函数）。

### 5.2 种子拼装（KTD7 + 待解问题 6 定死）

```ts
// 常量（放 notes.ts 顶部）
export const DEEPEN_MAX_NOTES = 20;            // 多选条数上限
export const DEEPEN_NOTE_BODY_MAX = 4000;      // 单条正文级截断上限（非 clipSummary 的 200）
```

规则：
- 多选**限同项目内**（跨项目不可同时选，与单一 cwd 一致）；超过 `DEEPEN_MAX_NOTES` 条给提示并阻止（不静默截断条数）。
- 按 `createdAt` **升序**排列。
- 单条 `content` 超过 `DEEPEN_NOTE_BODY_MAX` 字符 → 截断到 4000 并给 toast 提示（正文级，不可用 clipSummary 200）。
- 每条包一个 `<note>` 块，首条前加引导提示。复用 `buildAttachmentSystemPrompt`（messages.ts:44）的 XML 包裹风格：

```ts
// 拼装出 extraSystemPrompt（或扩 PersonalAttachment 联合加 NoteAttachment 走 attachments；二选一，推荐前者更简单）：
function buildDeepenSystemPrompt(notes: NoteMeta[], docDir: string): string {
  const blocks = notes.map((n) => {
    const body = n.content.length > DEEPEN_NOTE_BODY_MAX ? n.content.slice(0, DEEPEN_NOTE_BODY_MAX) : n.content;
    return `<note id="${n.id}" created="${new Date(n.createdAt).toISOString()}">\n${body}\n</note>`;
  }).join("\n\n");
  return [
    "以下是用户记录的同一批闪记（想法种子）。请先提出关键澄清问题，再把它们孵化成 brainstorm 文档。",
    `产出文档请写到：${docDir}/brainstorm.md（如后续生成 plan，写到同目录 plan.md）。`,
    blocks,
  ].join("\n\n");
}
```
> 选项 A（推荐）：拼进 `send(..., extraSystemPrompt)`，与 spotlight 的「项目信息块」共存（messages.ts:826-828 合并：extraSystemPrompt 在前、attachment 在后）。
> 选项 B：扩 `PersonalAttachment` 联合加 `NoteAttachment { kind:"note"; … }`（messages.ts:25-42）+ 在 `buildAttachmentSystemPrompt` 加 `kind==="note"` 分支。仅当需要结构化附件通道时选 B。

### 5.3 cwd 推导（沿用 spotlightHandoff.ts:46-53）

- 有 projectId → `projects.find(p => p.id === projectId)?.path`。
- 无项目（未归类闪记深化）→ `await bridge.ensureNoProjectDir?.(dayKey(Date.now()))`，失败时**不要静默 return**：给 toast 提示「无项目且无桌面能力，无法深化」并保持闪记草稿态（对齐 R17 失败回落）。
- `createSession(projectId, agent, model, proj ? undefined : { noProjectDir: cwd })`；pi 专属补 `updateSession(sess.id, { providerId })`。

### 5.4 首条防丢（KTD4，硬约束）

- 闪记会话消息读写**必须**沿用 `personalChatKeys.detail(sessionId) = ["personal","convo",sessionId]`（messages.ts:21-23）作为唯一 queryKey。
- 加载统一走 `ensureChatLoaded`（messages.ts:685）/ `usePersonalChat`（messages.ts:701），保证 `qc.ensureQueryData` 与 `useQuery` 共享在途请求去重（复现防御 `1e0f2e7`）。
- 即建即发硬时序：`createSession` → 同一 tick `send`；`send` 内 `await ensureChatLoaded`（:766）在任何 appendMsg 前完成。
- **绝不绕过 send 直接 appendMsg/setQueryData**，也不能用不同 queryKey 或不 sanitize。

### 5.5 result/exit 兜底 + 「已深化」判定（KTD5）

- 沿用 `scheduleResultExitFallback`（messages.ts:498-505，`RESULT_EXIT_GRACE_MS=1_000`）；不假设 `cli:exit` 必达。
- 「发完一轮」后的副作用（推进闪记状态）**挂到 `finalizeRun`（messages.ts:507-582）而非 result 分支**，否则 exit 丢失漏触发或 result+exit 都到重复触发。
- **「已深化」判定**：以**本轮 run 的 `changedFiles` 含约定产出路径**为准（经 `extractChangedFile` messages.ts:139-148 采集，run.changedFiles messages.ts:108/424-425）：
  - 比对前**路径归一化**：约定路径 `<projectDir>/docs/flash-notes/<conversationId>/brainstorm.md`，`extractChangedFile` 在 detail 以 cwd 前缀开头时返回相对路径、否则原样（可能绝对路径）、截断（`…` 结尾）返回 undefined。比对时把约定路径与采集路径都规约成「相对项目根」或都规约成绝对，再判 includes。
  - 「文件存在」**仅作兜底**，不能单独用来判已深化（否则再深化/放弃时旧同名文件被误判）。
  - 命中 → `notesUpdate(noteId, { status:"deepened", docPaths:[...旧, 新路径] })`（docPaths 传完整数组）。
- **失败回落（R17）**：spawn 失败 / 鉴权失败 / 超时 / 用户关闭且无产出 → `notesUpdate(noteId, { status:"draft" })`，不置已深化、不留悬挂 docPaths（conversationIds 可保留断链历史，docPaths 不追加）。
- 触发深化即先 `notesUpdate(noteId, { status:"deepening", conversationIds:[...旧, 新会话 id] })`，UI 显示「深化中」徽标并禁用再次深化（防重复触发）。

### 5.6 深化产出文档落点（待解问题 3 定死）

- 约定路径 = `<projectDir>/docs/flash-notes/<conversationId>/brainstorm.md`，plan 同目录 `plan.md`。
- `conversationId` = **本轮新会话 id**（天然支持再深化：新会话 = 新目录，不覆盖旧产出）。
- 多选深化：该路径写入**每条被选闪记**的 `docPaths`（共享同一 conversationId 目录）。
- 无项目深化：走 `ensureNoProjectDir` 返回的目录下同结构 `docs/flash-notes/<conversationId>/`。
- 文档写入项目目录走 `DesktopBridge.writeFile`（fs:writeFile，**会过 assertAllowed**，因 `<projectDir>` 在白名单 = project.path）；
  **不**走 notes.ts 的免白名单通道。agent 自己写文件时同理落在 project.path 下被放行（自动 mkdir -p 父目录，fs.ts:331）。

### 5.7 plan.md 触发（待解问题 2 定死）

- **用户显式触发**：brainstorm 产出后，收件箱/详情提供「生成 plan」动作，再开一段深化（同 conversationId 目录写 plan.md）。
- **不做 agent 链式自动**（降低失控与失败耦合）。

---

## 6. 回看（NotesView + 右栏接入 + 时间线合成）

> **2026-06-15 更新（计划 `docs/plans/2026-06-15-002-feat-flash-note-live-editor-plan.md`，已落地）：编辑面升级为中心区宽写作面。**
> 闪记的**编辑入口已从右栏窄详情迁到主内容区**:
> - 列表行点击 → `usePersonalStore.openNoteEditor(noteId)`,在 `.pw-center-col` 打开 `FlashNoteEditor`（向左延伸覆盖聊天区），提供「源码 / 实时预览 / 仅预览」三档（CodeMirror 6 移植自 Kun,`personal/editor/`）+ 去抖自动保存（`useNoteAutosave`）。`noteEditorId` 为新增中心视图态(瞬态,与 homeOpen/automationOpen/timelineProjectId 互斥)。
> - 右栏 NotesView 的 `selected`/NoteDetail **保留**,但仅供跨栏 `requestNoteDetail` 速览(时间线卡片跳转,不抢占中心区);**列表点击不再开右栏详情**。下文 6.1 描述的 textarea 详情编辑仍是右栏速览路径的实现,新中心写作面是其超集。
> - 删除/状态徽标/深化产物/放弃深化/生成 plan 等入口在 FlashNoteEditor 头部/底部复刻(行为不变;产物文档经 `requestFilePreview` 在右栏文件视图打开,不与中心编辑器争夺)。

### 6.1 NotesView（packages/views/cortex-desktop/personal/NotesView.tsx，新建，照抄 TodosView）

- 顶层 `export function NotesView({ onToast }: { onToast: (text: string) => void })`（仿 TodosView.tsx:660）。
- 双态切换：`selected: { kind:"note"; id:string } | null`（仿 SelectedItem TodosView.tsx:505）。null → 列表；否则详情。
- 取数走 `useDesktopBridge()` + 第 7 节的 React Query notes 封装（**不**新建 Zustand 副本）。
- 详情头复用 `.pw-panel-h`（返回 `Icon.Back` + 图标 + `.pw-panel-title` + spacer + 徽章）；列表头同结构无返回按钮。
- 编辑：textarea（受控）+ `Cmd/Ctrl+S` 存、`Esc` 取消（仿 MarkdownDetail TodosView.tsx:153-159）；预览 `<div className="pw-todo-md"><MarkdownView content={...}/></div>`（MarkdownView.tsx:79）。
  - 闪记正文存内存/store（来自 notes.json，非磁盘 md），故照抄 MarkdownDetail 的 editing/draft/save/onKeyDown 逻辑，但把 readFile/writeFile 换成 `bridge.notesUpdate(id, { content })`。
- 多选**限同项目内**（跨项目不可同时选），多选选中态进 Zustand UI 态（如 `core/store/personal.ts` 新增 `selectedNoteIds` 客户端态，或本地 useState）。多选用于深化触发（交 U8）。
- 删除三件套（R18）：`bridge.notesDelete(id)`（仅删自身，**不**删文档/会话）→ 失败 `onToast` 提示并 return，成功 `onToast("已删除")`，禁止 throw。
- request/consume：`consumeNoteDetailRequest`（第 4.5 节）落地为 `setSelected({ kind:"note", id })`（仿 TodosView.tsx:672-679）。
- 选中目标失效自动退出详情（仿 TodosView.tsx:737-745）：list 不含 selected.id 时 `setSelected(null)`。
- 空态两档：整体无闪记 `.pw-panel-empty`（如「还没有闪记」）；「未归类」无内容时**隐藏该分组标题**。
- 未归类分组提供「移到项目」归档动作 → `notesUpdate(id, { projectId })`，归档后该闪记进目标项目收件箱 + 时间线。
- 已深化徽标 + 跳转入口由本组件统一拥有（U10 复用，不重复实现）：已深化显示「已深化」徽标，可跳转 `docPaths` 文档（右栏文件预览 / MarkdownView + textarea，磁盘 md 走 fs 写）与来源会话；多份文档全部列出，缺失项给友好提示（断链降级）。
- 下拉/飞出菜单一律 hover 自动收起（closeTimer + onMouseLeave 延迟 setOpen(false) + onMouseEnter cancel，TodosView.tsx:409-421 / PersonalTopBar.tsx:64-72，用户 MEMORY 硬约定）。
- **CSS 纪律**：每写一个 className 立即 `rg -n '类名' *.css` 双向对账（CSS 完整 token 匹配，`pw-x-trigger ≠ pw-x`）；命中区 = 整卡可点而非只标题文字。

### 6.2 右栏接入

- `packages/views/cortex-desktop/personal/PersonalRightPanel.tsx`：
  - `RIGHT_VIEW_TITLE`（:17-21）加 `notes: "闪记"`。
  - 渲染分支（:94-100）加 `view === "notes" ? <NotesView onToast={onToast} /> : …`（NotesView 自动获得 `.pw-rp-resizer` 拖宽）。
- `packages/views/cortex-desktop/personal/PersonalTopBar.tsx`（**右栏视图选择器在这里，不是 TitleBar**）：
  - `pick` 入参联合加 `"notes"`（:74）。
  - 菜单在 todos 项后追加 `<button onClick={() => pick("notes")}><Icon.Pin size={14}/><span>闪记</span>{rightOpen && rightView === "notes" ? <Icon.Check/> : null}</button>`（:106-120）。
- **TitleBar.tsx 不改**（其 Section 是顶级路由 `chat|tasks|agents`，与右栏 view 无关；个人区 DesktopTabs 不渲染）。
  - 计划 U6 列出的 `TitleBar.tsx` 实为 PersonalTopBar 的笔误，实现期改 PersonalTopBar。
- 打开右栏：调用方补 `setRightOpen(true)`（在 `useCortexUIStore`，非 personal store；pick 内已含此逻辑）。

### 6.3 时间线合成（KTD6，读取期合成不落盘）

**(a) 类型前置（packages/core/desktop/types.ts）**：
- `TimelineEventKind`（:457）扩为 `"run" | "summary.day" | "session.created" | "git.commit" | "note"`。
- `TimelineEvent.meta`（:468-475）补 `noteId?: string; noteStatus?: NoteStatus;`。

**(b) 纯函数 noteEvents（packages/core/personal/timeline.ts，紧贴 commitEvents :165 旁，逐字对齐 sessionCreatedEvents :151-163）**：
```ts
export function noteEvents(notes: NoteMeta[], projectId: string): TimelineEvent[] {
  return notes
    .filter((n) => n.projectId === projectId)
    .map((n) => ({
      id: `note-${n.id}`,                  // 稳定前缀，避免与落盘 run 事件 id 碰撞
      projectId,
      sessionId: n.sourceSessionId,        // 有来源会话则可 onJump 跳源会话
      ts: n.createdAt,
      kind: "note" as const,
      title: clipSummary(n.content),       // 首行/截断标题（复用既有 clipSummary）
      summary: n.content,
      meta: { noteId: n.id, noteStatus: n.status },
    }));
}
```

**(c) useProjectTimeline 合并点（timeline.ts:296-324）**：
- 新增 notes useQuery（**notes 是异步主进程态，不像 sessions 同步在 Zustand，必须订阅 query，不能 getState() 同步拿**），照搬 :304-310 范式：
  ```ts
  const { data: notesData } = useQuery<NoteMeta[]>({
    queryKey: notesKeys.byProject(projectId ?? "none"),   // 见第 7 节
    enabled: !!bridge && !!projectId && !!bridge.notesList,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: () => (bridge?.notesList ? bridge.notesList(projectId) : Promise.resolve([])),
  });
  ```
- 合成 + 合并（待解问题 7 定死：软上限 500）：
  ```ts
  const notes = noteEvents(notesData ?? [], projectId);   // v1 合成全部、不分页
  return { events: [...stored, ...synthesized, ...git, ...notes], loading: isLoading };
  ```
  > 软上限：若某项目 notes 超过 500 条，noteEvents 内仅取**最近 500**（按 createdAt 降序切片再升序），并 `console.warn` 提示（no silent cap）；分页后置。

**(d) groupEventsByDay（timeline.ts:58-90）**：
- `DayStats`（:50-55）加 `notes: number;`。
- ensure 初始化（:63）`stats: { sessions: 0, runs: 0, files: 0, commits: 0, notes: 0 }`。
- 统计循环（:81-86）加 `if (ev.kind === "note") g.stats.notes += 1;`。
- note 走默认 `push` 分支（**不**套 summary.day 的 continue 抽离）。
- **待解问题 4 定死**：`note` 计入「当日事件数」，与其它 kind 口径一致（即进 g.events、进 notes 统计）。

**(e) EventCard（packages/views/cortex-desktop/personal/TimelineView.tsx）**：
- 在 `git.commit` 早返回分支（:62-71）后、run 默认分支（:74）前插 `if (event.kind === "note") { return (<闪记卡片/>); }`（复用 `hhmm(ts)` 与 `onJump`；卡片可点跳转 `requestNoteDetail({ noteId: event.meta!.noteId! })`）。
- **务必在 run 默认分支之前**，否则 note 掉进 run 富卡片错渲。

**(f) 「只看闪记」筛选（新增 UI，TimelineView 现无 kind 级筛选）**：
- header（:363-370）tab 旁加筛选状态（如 `const [onlyNotes, setOnlyNotes] = useState(false)`）。
- 筛选**只作用于 timeline 子视图事件流**（在 events→groups 前或 TimelineList 渲染处按 `ev.kind === "note"` 过滤），**不污染 calendar 的 groups 统计**（否则热力图只剩闪记失真）。
- statChips（:35-42）加 `if (stats.notes) chips.push(`${stats.notes} 条闪记`)` 露出天头计数。heatLevel/monthTotal/calendar dots 是否纳入 notes：v1 **不纳入**（闪记不算编码活动，保持热力图口径不变）。

**(g) 双写禁令**：时间线侧 note 事件**只读取期合成**，**绝不调用 `recordTimelineEvent`（:256）/ `mutateTimeline`（:233）** 把 note 写进 `timeline/<projectId>.json`，否则与 notes 主存储双源漂移、污染 loadTimelineData 去重。

---

## 7. React Query 约定（packages/core/personal/notes.ts，新建）

### 7.1 query key（以 projectId 命名，非 wsId）

```ts
export const notesKeys = {
  all: ["personal", "notes"] as const,
  byProject: (projectId: string) => ["personal", "notes", projectId] as const,
};
```
- 桌面端无 wsId 概念（`useWorkspaceId` 返回占位值），**绝不用 wsId 命名**（会让同桌面所有项目笔记串到同一 key）。
- 无项目场景（未归类）用稳定占位段：`notesKeys.byProject("no-project")` 或专门的 `notesKeys.unassigned`，**不**用 wsId。
- 与 `timelineKeys`（timeline.ts:24-27）形态对齐（均以 projectId 命名空间）。

### 7.2 hook 形态

```ts
export function useProjectNotes(projectId: string | undefined) {
  const bridge = useDesktopBridge();
  return useQuery<NoteMeta[]>({
    queryKey: notesKeys.byProject(projectId ?? "no-project"),
    enabled: !!bridge?.notesList,                // 缺桥/旧壳 → 关闭，UI 降级隐藏入口
    queryFn: () => bridge!.notesList!(projectId),
    staleTime: Infinity,
    refetchOnWindowFocus: true,                  // 兜底事件丢失（窗口重获焦点 refetch）
  });
}
// 全量（收件箱按项目分组用）：useAllNotes() → notesList(undefined)
// mutations：useAddNote/useUpdateNote/useDeleteNote 调 bridge.notes*，成功后 invalidate notesKeys
```

### 7.3 事件 → invalidation（不直接 setState）

- 在主窗口某根组件（与 `usePersonalCliEvents` 同处或 NotesView 顶层）订阅 `bridge.onNotesChanged?.(...)`：
  ```ts
  useEffect(() => {
    if (!bridge?.onNotesChanged) return;
    return bridge.onNotesChanged(() => {
      queryClient.invalidateQueries({ queryKey: notesKeys.all });   // 只 invalidate，不 setQueryData(list)，不写 Zustand
    });
  }, [bridge, queryClient]);
  ```
- `notes:changed` 推的是全量快照，但 core 侧**只 invalidate**（遵 CLAUDE.md「事件只触发 invalidation」），让 React Query 重新 `notesList` 拉权威值。
- 窗口重获焦点 refetch（`refetchOnWindowFocus: true`）兜底事件丢失。

### 7.4 浮层 KTD10 直连，不走 hook

- 闪记浮层是独立 BrowserWindow 裸 React root（无 CoreProvider/QueryClientProvider），**严禁在浮层用 React Query hook 或 usePersonalStore**（无 Provider/无 store 同步会崩或读不到主窗口状态）。
- 浮层只 `const api = window.desktopAPI`，直连 `api.personal.notesAdd(...)` / `api.personal.loadState()`（读 lastActiveProjectId 推默认归属）+ `api.notesOverlay.resize/hide`。
- `core/personal/notes.ts` 的 React Query 封装**只服务主窗口**收件箱/时间线。

---

## 8. 浮层窗口与全局热键（U3 + U4 + U5）

### 8.1 浮层窗口（apps/desktop/src/main/notes-overlay.ts，新建，照搬 spotlight.ts 单例骨架）

- 模块级 `let win: BrowserWindow | null = null`，导出 `showNotesOverlay()/hideNotesOverlay()/toggleNotesOverlay()/resizeNotesOverlay(height)/getNotesOverlayWindow()/destroyNotesOverlay()`。
- BrowserWindow 配方逐字复用 spotlight.ts:32-51（`frame:false`/`transparent:true`/`hasShadow:false`/`backgroundColor:"#00000000"`/`skipTaskbar:true`/`show:false` + darwin `type:"panel"` + `setAlwaysOnTop(true,"screen-saver")` + `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`），preload 仍指 `../preload/index.js`。
- 常量按闪记 UI 另设（`NOTES_WIDTH`/`NOTES_HEIGHT`/`NOTES_MAX_HEIGHT`/`NOTES_BOTTOM_MARGIN`）；定位可复用按光标屏（spotlight.ts:23-29）或改屏幕居中（只改 position() 的 y 计算）。
- `showNotesOverlay()` 用 `showInactive()` 后再 `focus()`（顺序不能颠倒）；darwin 每次 show 都重申 `setVisibleOnAllWorkspaces`。
- 高度自适应：renderer 实测 `rootRef.scrollHeight + 4` → `api.notesOverlay.resize(h)`；主进程 `resizeNotesOverlay` 夹取 `Math.max(NOTES_HEIGHT, Math.min(round(h), NOTES_MAX_HEIGHT))` 后重定位（透明窗口高度必须 ≥ 白卡+投影，否则投影硬切）。
- prod html 双路径回退（spotlight.ts:17-21 `flat`/`nested` existsSync 探测）—— **漏抄会打包后白屏**。
- 失焦自隐：`win.on("blur", () => hideNotesOverlay())`。**注意**：闪记若需「边写边切应用」可能误伤，实现期评估是否保留 blur 自隐（v1 保留，与 spotlight 一致）。

### 8.2 三件套 + vite 入口

- 新建 `apps/desktop/src/renderer/notes.html`（根目录，`<div id="root">` + `<script type="module" src="/src/notes-overlay.tsx">`）。
  > 计划写 `notes.html`，与 IPC 域 `notes:*` 不冲突（一个是 html 文件名，一个是 IPC 通道）。
- 新建 `apps/desktop/src/renderer/src/notes-overlay.tsx`（`createRoot(document.getElementById("root")!).render(<NotesOverlay/>)` + `import "./notes-overlay.css"`，**不包 CoreProvider/QueryClient**）。
- 新建 `apps/desktop/src/renderer/src/notes-overlay.css`（照搬 spotlight.css：`html,body{background:transparent;overflow:hidden}` + 卡片留 padding 让投影淡出）。
- `apps/desktop/electron.vite.config.ts` 的 `build.rollupOptions.input`（:29-32）加一行 `notes: resolve("src/renderer/notes.html")`。dev 模式不读 config（按 `${ELECTRON_RENDERER_URL}/notes.html` URL 解析），prod 才暴露缺 input → 改完必 build 验证。

### 8.3 preload notesOverlay 桥（apps/desktop/src/preload/index.ts，单列对象，不并入 personal）

在 `const spotlight = {...}`（:231-235）旁新增：
```ts
const notesOverlay = {
  resize: (height: number): void => ipcRenderer.send("notes-overlay:resize", height),
  hide: (): void => ipcRenderer.send("notes-overlay:hide"),
};
```
并加进 `contextBridge.exposeInMainWorld("desktopAPI", { personal, spotlight, notesOverlay, ... })`（与 spotlight 并列）。
> 浮层提交闪记**不走** notesOverlay 桥，而走 `window.desktopAPI.personal.notesAdd`（已有 IPC 域，直接落盘）。
> 故 notesOverlay 桥**只需 resize/hide**，无需 submit/consumePending intent 接力（闪记直接落盘，不经主窗口）。

### 8.4 ipc/notes-overlay.ts（新建，仿 ipc/spotlight.ts）

```ts
export function registerNotesOverlayHandlers(): void {
  ipcMain.on("notes-overlay:resize", (_e, height: number) => resizeNotesOverlay(height));
  ipcMain.on("notes-overlay:hide", () => hideNotesOverlay());
}
```
在 register.ts 注册（紧挨 registerNotesHandlers）。

### 8.5 全局热键（KTD3 + 待解问题 5 定死）

- **默认键位 `CommandOrControl+Shift+N`**。
- `apps/desktop/src/main/index.ts` `whenReady`（:106 内）：`const ok = globalShortcut.register("CommandOrControl+Shift+N", toggleNotesOverlay);`
  - `ok === false`（被占用）→ **不抛错**，标记降级，经事件/toast 提示用户「热键被占用，改用窗口图标入口」。
  - v1 **不做改键 UI**（后置）。
- 注销：`before-quit`（:157-166，与 `destroySpotlight()` 同处，仓库无 will-quit handler）末尾追加 `globalShortcut.unregisterAll();` + `destroyNotesOverlay();`。
- **首次引入 globalShortcut**（全仓零先例）：`import { globalShortcut } from "electron"`。
- 把「注册失败 → 降级状态」抽成可测纯函数先写测试；globalShortcut 系统行为人工验证。

### 8.6 main/index.ts 必改三处

1. import：`import { toggleNotesOverlay, destroyNotesOverlay, getNotesOverlayWindow } from "./notes-overlay";` + `import { registerNotesOverlayHandlers } from "./ipc/notes-overlay";`
2. whenReady：`registerNotesOverlayHandlers();` + `globalShortcut.register(...)`（见 8.5）。
3. **`app.on("activate")` 的 filter（:136）必改**（否则「主窗口已关、只剩浮窗」点 Dock 不重建）：
   ```ts
   const real = BrowserWindow.getAllWindows().filter((w) => w !== getSpotlightWindow() && w !== getNotesOverlayWindow());
   ```
4. `before-quit`（:165 `destroySpotlight()` 旁）追加 `destroyNotesOverlay();` + `globalShortcut.unregisterAll();`。
   - **不**在 window-all-closed（:150-154）销毁浮窗（有意后台常驻，仿 spotlight）。

### 8.7 窗口图标入口（U4/U5）

- 在 `packages/views/cortex-desktop/personal/ComposerShell.tsx` 的 `.comp-foot`（Mic pill :403 之后、spacer :404 之前）加 `<button className="pill" onClick={onOpenFlashNote}><Icon.Pin size={13}/></button>`。
- 新增 `onOpenFlashNote` 回调，由 ComposerShell props → PersonalComposer 透传（对齐 `onToggleSkills` 透传链）；触发调 preload 暴露的 show 方法（窗口内入口可还焦到 composer，R2 焦点契约）。
  > 窗口内 show 入口可经 personal 桥新增方法或复用 spotlight 风格的独立通道；实现期与 8.3 一并定（建议加 `window.desktopAPI.notesOverlay.show()` 或经 personal 一个 `showNotesOverlay()` 方法）。
- 焦点契约拆分（KTD2/R2）：窗口内入口保存后还焦 composer；全局热键入口只保证浮层关闭，焦点归还交 OS（best-effort）。

### 8.8 浮层捕捉交互（notes-overlay.tsx，U5）

- 直连 `window.desktopAPI`（KTD10）：`loadState()` 读 `lastActiveProjectId` + 当前态推默认归属。
- 归属推导**纯函数**放 `packages/core/personal/notes.ts`（供浮层与测试复用）：
  ```ts
  // 默认归属 = 当前会话.projectId ?? activeProjectId ?? lastActiveProjectId；都没有 → undefined（未归类）
  // 读后校验该 projectId 仍在 projects 中，失效回落 undefined。
  export function resolveDefaultNoteProject(args: {
    currentSessionProjectId?: string; activeProjectId?: string; lastActiveProjectId?: string; projects: { id: string }[];
  }): string | undefined { … }
  ```
- 项目切换器：仿 SpotlightBar 下拉（**真实路径 `apps/desktop/src/renderer/src/SpotlightBar.tsx`，渲染端裸 root，非 views**；项目下拉 :206-213），`projects.filter(p => p.archivedAt == null)`，空 option「未归类」；`projects` 来自 `api.personal.loadState()`（SpotlightBar.tsx:46/54）。
- 空内容守卫：`const text = v.trim(); if (!text) return;`（不创建、浮层保持打开，仿 SpotlightBar.submit :119-120）。
- 保存：`api.personal.notesAdd({ projectId, content, sourceSessionId? })`；成功才 `api.notesOverlay.hide()` + 焦点契约；失败浮层不关、保留草稿、就地报错可重试。
- 窗口 mount + window 'focus' 时清空输入并 requestAnimationFrame 聚焦 textarea；Esc → `api.notesOverlay.hide()`（与主进程 blur 自隐双保险）。
- 闪记**仅写入 notes store，不进任何会话上下文**（R14/R15）。

---

## 8b. exports 更新（packages/core/package.json）

在 exports（:11-30）的 `./personal/*` 段加一行（放在 `./personal/filePaths` 旁）：
```json
    "./personal/notes": "./personal/notes.ts",
```
> 若 notes.ts 拆出纯函数（路径判定/序列化）成无 node 依赖模块，比照 filePaths.ts 各自加 exports 项。

---

## 9. 纪律清单（实现期必须遵守）

1. **跨进程节流竞态**：`lastActiveProjectId` 影响主进程（浮层经 cached 读默认归属），必须纳入 saveUrgency immediate 档绕过 500ms 节流（第 4.1 节）。主进程 `cached` 在 `store:save` 一到即同步。
2. **CSS className↔选择器双向对账**：NotesView / notes-overlay 每写一个 className 立即 `rg -n '类名' *.css` 双向对账（CSS 完整 token 匹配，`pw-x-trigger ≠ pw-x`）；死代码该删。纯 CSS 问题自动化测不到，靠 grep + 人工验证。
3. **命中区 = 视觉区**：闪记卡片/列表整块可点（非只标题文字）；改命中区前先 `getBoundingClientRect` 量各层 top/height/gap。
4. **core 硬边界**：闪记 hook/store/类型放 `packages/core`（不依赖 react-dom/localStorage/process.env）；纯展示放 ui（不引 core）；NotesView 放 views（不引 next/*、react-router-dom）。store 只能在 `core/store/`。
5. **DesktopBridge 三处同步**：bridge.ts 接口 / preload personal / main/ipc/notes.ts handler + 两份 types.ts，通道名与签名逐字一致；新增方法一律 `?:` 可选，web 端 null 降级。
6. **服务端态走 React Query、不双写 Zustand**：notes 列表/详情走 RQ（key 以 projectId），`notes:changed` 只 invalidate。仅浮层草稿/收件箱多选/rightView 进 Zustand。
7. **镜像逐字一致**：NoteMeta/NoteInput/NotesFileData/NoteStatus 两份 types.ts 逐字相同；TimelineEventKind/TimelineEvent.meta 改动同步。
8. **worktree 内验证**：所有 `pnpm test/typecheck/lint` 在 `.worktrees/feat/flash-notes/` 内跑（先 `pnpm install`），用输出绝对路径前缀核对，git stash 比对基线。
9. **首条防丢硬约束**：深化即建即发必须走共享 queryKey `["personal","convo",sessionId]` + `ensureChatLoaded`，副作用挂 finalizeRun（第 5 节）。
10. **提交规范**：Conventional Commits 中文（如 `feat(notes): 新增闪记浮层与主进程存储`），注释/提交用 zh-Hans，ESM only。

---

## 10. 逐单元实现顺序与文件冲突说明

### 10.1 共享 hub 文件（多单元同改，是冲突高发区）

| Hub 文件 | 涉及单元 | 说明 |
|---|---|---|
| `packages/core/personal/notes.ts`（新建） | U1, U5, U8, U9 | RQ 封装(U1) + 归属纯函数(U5) + 深化编排/种子(U8) + 状态机/落点(U9)。**单一文件多单元写**，建议 U1 先建骨架（类型导入 + RQ + key），后续单元各加 export。 |
| `packages/core/store/personal.ts` | U2, U6, U8 | lastActiveProjectId(U2) + rightView/requestNoteDetail(U6) + createSession 复用(U8)。U2 与 U6 改不同区域可并行，但同文件需串行落 commit。 |
| `packages/core/desktop/types.ts` | U1, U2, U7 | NoteMeta 镜像(U1) + PersistedState.lastActiveProjectId(U2) + TimelineEventKind/meta(U7)。改不同段，但同文件。 |
| `apps/desktop/src/main/ipc/types.ts` | U1, U4(若回报热键) | NoteMeta 镜像(U1)。 |
| `apps/desktop/src/main/index.ts` | U3, U4 | 浮层接线(U3) + globalShortcut(U4)。强串行（U4 依赖 U3）。 |
| `apps/desktop/src/preload/index.ts` | U1, U4/U5(图标入口/show) | notes* 方法(U1) + notesOverlay 桥(U3/U5)。 |
| `packages/views/cortex-desktop/personal/NotesView.tsx`（新建） | U6, U10 | 列表/详情/删除(U6) + 已深化徽标/跳转(U10)。U6 先建，U10 加段。 |
| `packages/views/cortex-desktop/personal/TimelineView.tsx` | U7 | EventCard note 分支 + 筛选。 |
| `packages/core/personal/timeline.ts` | U7 | noteEvents + useProjectTimeline 合并 + groupEventsByDay。 |
| `apps/desktop/src/main/ipc/register.ts` | U1, U3 | registerNotesHandlers(U1) + registerNotesOverlayHandlers(U3)。 |

### 10.2 安全的串/并行波次建议

- **波次 1（并行）**：U1（数据模型+notes 存储域+RQ 封装）、U2（lastActiveProjectId）。二者文件几乎不重叠（U1 主战场 notes.ts/notes 存储；U2 主战场 personal.ts/usePersonalPersistence.ts），仅 `core/desktop/types.ts` 共改不同段——可并行，合并时注意 types.ts。
- **波次 2（串行内部，可与波次 3 并行）**：U3（浮层窗口）→ U4（热键+图标入口）→ U5（浮层交互）。三者强依赖（U4 依赖 U3、U5 依赖 U1/U2/U3），main/index.ts 与 preload 串行。
- **波次 3（依赖 U1，可与波次 2 并行）**：U6（NotesView 收件箱）、U7（时间线合成）。U6 改 personal.ts/PersonalRightPanel/PersonalTopBar/NotesView；U7 改 timeline.ts/types.ts/TimelineView——文件不重叠，可并行；仅 types.ts 共改（U7 改 TimelineEventKind，U6 不改 types）。
- **波次 4（串行，依赖最多）**：U8（深化触发+种子，依赖 U1/U6）→ U9（状态机/落点/链接，依赖 U8）→ U10（产出查看，依赖 U6/U9）。U8/U9 共写 notes.ts + messages.ts，强串行；U10 在 NotesView 加段（与 U6 同文件，串行）。

### 10.3 关键冲突规避

- `core/personal/notes.ts` 是 4 个单元共写的最大 hub：U1 阶段把文件骨架（imports、`notesKeys`、`useProjectNotes/useAllNotes`、mutations、`resolveDefaultNoteProject` 占位）一次建好，U5/U8/U9 各自往里加 export，减少 rebase 冲突。
- `core/desktop/types.ts`：U1（NoteMeta 段）、U2（PersistedState 段）、U7（Timeline 段）改不同区域，按波次顺序 commit 即可。
- `main/index.ts`：U3 先落浮层接线（含 activate filter 改动），U4 在其上加 globalShortcut，禁止并行。

---

## 11. 7 个待解问题的最终决策（编排者拍板，实现期不得再分歧）

1. **存储**：单文件 `notes.json`，元数据 + 内容内联（闪记短、量级小）；落点 `~/.cortex-desktop/notes.json`；写机制仿 store.ts（`.tmp`+rename + 串行 writeQueue + 内存镜像），目录归属仿 timeline.ts（免 assertAllowed）。NoteContent 内联进 NoteMeta（单一记录），v1 不分文件。
2. **plan.md 触发**：用户显式触发（brainstorm 产出后，提供「生成 plan」动作再开一段深化），不做 agent 链式自动。
3. **深化产出文档落点**（必在项目目录、assertAllowed 白名单内）：约定路径 = `<projectDir>/docs/flash-notes/<conversationId>/brainstorm.md`（plan 同目录 `plan.md`）；conversationId 用本轮新会话 id，天然支持再深化（新会话=新目录）；多选深化时该路径写入每条被选闪记的 docPaths。无项目走 ensureNoProjectDir 目录下同结构。
4. **时间线统计**：note 合成事件计入 `groupEventsByDay` 的「当日事件数」，与其它 kind 口径一致。
5. **全局热键**：默认键位 `CommandOrControl+Shift+N`；注册失败 → toast 降级提示（占用，改用窗口图标入口），v1 不做改键 UI（后置）。
6. **多选深化**：条数上限 20；单条正文截断上限 4000 字符（正文级，非 clipSummary 的 200）；超限给提示。
7. **时间线读取期合成**：v1 不分页、合成全部；但设软上限 500 条/项目，超出仅合成最近 500 并 `console.warn` 提示（no silent cap），分页后置。
