// 个人工作区输入框内核：不依赖 session 的纯输入壳。支持 Prompt/Todo 拖入（skill/todo
// 附件 pill）、模型切换、语音输入（ASR）、Skills 开关、slash 命令、编辑重发、运行中停止。
// 会话页（PersonalComposer 薄封装）与新会话落地页（草稿态）共用。复用 cortex-desktop.css
// 的 composer 类名体系。

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  AGENT_MODELS,
  DEFAULT_AGENT_THINKING,
  agentThinkingOptions,
  useDesktopBridge,
  usePersonalStore,
  usePetStore,
} from "@cortex-work/core";
import { useComposerVoice } from "./useComposerVoice";
import { useTranslation } from "@cortex-work/core/i18n";
import type {
  AgentKind,
  AgentThinkingValue,
  DerivedAgentMeta,
  ExecPermission,
  PendingDocFile,
  PendingImage,
  PersonalAttachment,
  ConversationArtifactRef,
} from "@cortex-work/core";
import { CustomizePill } from "./CustomizePill";
import { ModelThinkingPill } from "./ModelThinkingPill";
import { VisionBlockBanner } from "../VisionBlockBanner";
// pi 模型候选的唯一来源：Provider Catalog（认证可用 ∧ 未隐藏），与设置页选择器同一份数据。
import { collectModelOptions, useProviderViews } from "../../settings/provider/useProviderData";
import { useDismissableMenu } from "../../shared/useDismissableMenu";
import { RESEARCH_SKILL_PILL } from "./useSlashCommands"; // 只取常量;反向引用是 import type,无运行时循环
import { MentionDropdown, useMentionAutocomplete } from "./MentionAutocomplete";
import { PROMPT_DRAG_MIME } from "../../skills/PromptPanel";
import { TODO_DRAG_MIME } from "../../tasks/TodosView";
import { FILE_DRAG_MIME } from "../../files/FilesView";
import {
  MAX_IMAGES_PER_MESSAGE,
  checkImageFile,
  fileToPendingImage,
  imageDedupeKey,
  rejectReasonText,
} from "./imageIntake";
import {
  DOC_ACCEPT_ATTR,
  MAX_DOCS_PER_MESSAGE,
  checkDocFile,
  docDedupeKey,
  docRejectText,
  fileToPendingDocFile,
  isAcceptedDoc,
  isBinaryDoc,
  pendingDocFromPath,
} from "./docIntake";

// 输入框占位文案中的 agent 展示名。
const AGENT_PLACEHOLDER_NAME: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

let attachSeq = 0;

// 从 skill 文件提取展示名,让用户明确知道拖入的是哪个 skill:
// 1) 优先 frontmatter 的 name 字段;
// 2) 文件名是通用 SKILL.md 时,退用所在目录名(skill 目录约定);
// 3) 否则用去扩展名的文件名。
function deriveSkillName(path: string, fileName: string, content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm?.[1];
  if (frontmatter) {
    const m = frontmatter.match(/^\s*name\s*:\s*(.+?)\s*$/m);
    const raw = m?.[1];
    if (raw) {
      const v = raw.replace(/^['"]|['"]$/g, "").trim();
      if (v) return v;
    }
  }
  const base = fileName.replace(/\.md$/i, "");
  if (base.toLowerCase() === "skill") {
    const parts = path.split(/[/\\]/).filter(Boolean);
    const dir = parts[parts.length - 2];
    if (dir) return dir;
  }
  return base;
}

/**
 * slash 命令项。kind 决定选中语义(KTD4):
 *  - "builtin"(默认):选中即执行(onSend(cmd)),如 /clear、/compact。
 *  - "skill":选中插入 `cmd ` 到输入框、保留焦点、不发送,供用户填 argHint 参数后再发。
 * argHint 为 pi skill frontmatter 的 argument-hint(如 `<url>` / `[branch]`),展示在命令名后。
 */
export type SlashCommand = {
  cmd: string;
  desc: string;
  argHint?: string;
  kind?: "builtin" | "skill";
  // 菜单展示用友好名(Title Case,如 Image Gen);缺省回退展示 cmd。匹配时 cmd 与 displayName 都参与。
  displayName?: string;
  // 来源标签(个人/系统/工作区),展示在菜单项右侧。
  tag?: string;
};

// slash 命令模糊匹配打分:输入 "/br" 也能命中 "/skill:agent-browser"。返回档位(越小越优),-1 = 不匹配。
//   0 前缀命中(旧行为,最优);1 去斜杠子串命中;2 子序列命中(q 的字符按序出现在 cmd 中)。
// query 与 cmd 均小写比较,去斜杠子串让 "/browser" 命中 "/skill:agent-browser"。
export function rankSlashMatch(query: string, cmd: string): number {
  const q = query.toLowerCase();
  const c = cmd.toLowerCase();
  if (c.startsWith(q)) return 0;
  const sub = q.startsWith("/") ? q.slice(1) : q;
  if (sub && c.includes(sub)) return 1;
  let qi = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) if (c[ci] === q[qi]) qi++;
  return qi === q.length ? 2 : -1;
}

// 一条命令的最优档位:cmd 与 displayName(若有)都参与匹配,取更优(更小)者;都不匹配 = -1。
// 让「/imag」「image gen」都能命中 Image Gen(displayName)与 /skill:image-gen(cmd)。
function bestSlashRank(query: string, c: SlashCommand): number {
  let best = -1;
  for (const target of [c.cmd, c.displayName]) {
    if (!target) continue;
    const r = rankSlashMatch(query, target);
    if (r >= 0 && (best === -1 || r < best)) best = r;
  }
  return best;
}

// 按打分过滤 + 排序 slash 命令:档位升序,同档保持原顺序(builtins 在前、skill 按名),稳定不打乱。
export function matchSlashCommands(query: string, commands: SlashCommand[]): SlashCommand[] {
  return commands
    .map((c, i) => ({ c, i, r: bestSlashRank(query, c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

// 以「用户编辑」的方式整体替换 textarea 内容,使这次写入进入浏览器原生撤销栈(Cmd+Z 可撤回)。
// 程序化 setText 不会被原生撤销栈记录——用户点场景示例填入提示词后按 Cmd+Z 撤不回来(用户反馈)。
// execCommand 虽已废弃,但仍是 Chromium 里唯一能写进撤销栈的通道;返回 false 表示未生效,调用方回退。
function insertTextAsUserEdit(ta: HTMLTextAreaElement | null, next: string): boolean {
  if (!ta || typeof document.execCommand !== "function") return false;
  try {
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    return document.execCommand("insertText", false, next) === true;
  } catch {
    return false;
  }
}

export function ComposerShell({
  agent,
  derivedAgentId,
  derivedAgents,
  agentsAvailable,
  model,
  providerId,
  useOwnSkills,
  running,
  editing,
  slashCommands = [],
  acceptComposerInsert = false,
  visionBlockSessionId,
  className,
  placeholder,
  onSend,
  onStop,
  onSteer,
  onChangeAgent,
  onChangeModel,
  onChangePiModel,
  thinkingValue,
  onChangeThinking,
  execPermission,
  onChangeExecPermission,
  onToggleSkills,
  webSearch,
  onToggleWebSearch,
  webSearchUnavailable,
  researchSkillAvailable,
  onCancelEdit,
  onToast,
  onPrewarm,
  artifact,
  onOpenArtifact,
  onRemoveArtifact,
}: {
  agent: AgentKind;
  // agent 选择(opt-in,仅新会话落地页用):选中的派生 id + 候选/门控数据 + 切换回调。
  // 传入 onChangeAgent 时并入合并 pill(头像 + 面板 Agent 行);会话内 PersonalComposer 不传
  // → pill 退化为「模型 + 推理」(会话头 PersonalTopBar 已有选择器,避免重复)。
  derivedAgentId?: string;
  derivedAgents?: DerivedAgentMeta[];
  agentsAvailable?: Partial<Record<AgentKind, boolean>>;
  model: string | undefined;
  providerId: string | undefined;
  useOwnSkills: boolean;
  running: boolean;
  /** 编辑重发:正在编辑的历史用户消息(原文填入输入框,顶部出提示条)。 */
  editing?: { uid: string; text: string } | null;
  /** slash 命令注册表;留空则不启用 slash 提示(如新会话落地页)。 */
  slashCommands?: SlashCommand[];
  /** 是否订阅全局 composerInsert(文件预览「发送到 Chat」),仅会话页启用。 */
  acceptComposerInsert?: boolean;
  /** 传入会话 id 即在输入框上方渲染「图片能力阻断」提示条(落地页草稿态不传)。 */
  visionBlockSessionId?: string;
  /** 注入根 .composer-wrap 的附加类名(如落地页 pw-landing-composer)。 */
  className?: string;
  /** 覆盖非运行态占位文案;缺省用「给 {agent名} 发消息…」。 */
  placeholder?: string;
  // 返回是否「已消费」(真正发出):composer 据此决定清空待发图(未消费则保留供重试,KTD9)。
  // /clear 返回 false（保留待发图）;真正 send 返回 core send 的 Promise<boolean>。
  onSend: (
    text: string,
    attachments: PersonalAttachment[],
    images?: PendingImage[],
    docFiles?: PendingDocFile[],
  ) => void | boolean | Promise<void | boolean>;
  onStop?: () => void;
  /** pi 运行中插话:把引导注入当前轮（仅 pi + 提供时启用;非 pi/单发不传 → 运行中只能停止）。 */
  onSteer?: (text: string) => void;
  /** agent 切换(opt-in):提供则合并 pill 带 agent 头像 + 面板 Agent 下钻行。derived 存在表示切到派生 agent。 */
  onChangeAgent?: (agent: AgentKind, derived?: DerivedAgentMeta) => void;
  onChangeModel: (model: string) => void;
  // pi 多供应商:同时切换 provider 与模型。
  onChangePiModel: (providerId: string, model: string) => void;
  // 思考强度:非 Pi 映射为 effort（下一轮生效）;Pi 映射为 thinkingLevel（运行时即时生效）。
  thinkingValue?: AgentThinkingValue;
  onChangeThinking?: (value: AgentThinkingValue) => void;
  // 执行权限 pill(会话级)。提供 onChange 才渲染。
  execPermission?: ExecPermission;
  onChangeExecPermission?: (p: ExecPermission) => void;
  onToggleSkills: () => void;
  /// 联网检索开关(会话级布尔,opt-in)。开启后主进程给本会话的 agent 注入 web_search / web_read。
  ///
  /// **放在底栏而不是收进二级菜单**:联网带有数据出站语义,当前是开还是关必须一眼看得见。
  /// 与其它 opt-in 分组同范式——只有宿主传 onToggleWebSearch 时才渲染(研究引擎未开 / 无桥时不渲染)。
  webSearch?: boolean;
  onToggleWebSearch?: () => void;
  /// 引擎开着但搜索后端还没配好:pill 仍渲染但禁用 + tooltip 指路,而不是悄悄消失。
  /// 直接不注入(见 buildResearchMcpServerConfig 的后端门控)时若还给个可点的按钮,
  /// 用户会以为开了却毫无反应。
  webSearchUnavailable?: boolean;
  /// 「转为深度研究」菜单项是否可用。判定要读设置与桥（见 useResearchSkillAvailable），composer
  /// 不该知道这些，故只收一个布尔；false 时整项不渲染——点了没反应的入口比不给更糟。
  researchSkillAvailable?: boolean;
  onCancelEdit?: () => void;
  onToast: (text: string) => void;
  // 会话预热(opt-in):输入非空文本时触发,供个人工作区提前拉起 pi 进程消除首轮冷启。
  // 每次非空变更都会调用,幂等/去重由调用方负责;团队侧不传 → no-op。
  onPrewarm?: () => void;
  /** 会话当前绑定的设计/Slides 产物。普通追问默认继续作用于它。 */
  artifact?: ConversationArtifactRef;
  onOpenArtifact?: () => void;
  onRemoveArtifact?: () => void;
}) {
  const { t } = useTranslation("chat");
  const bridge = useDesktopBridge();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PersonalAttachment[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [docFiles, setDocFiles] = useState<PendingDocFile[]>([]);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // slash 命令下拉:当前键盘高亮项 + 是否被 Esc 临时收起（下次编辑文本即重开）。
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  // 插件「在对话中试用」上下文:输入框前渲染的插件 pill（composerIcon 图标+名称）。发送或手动移除即清。
  const [tryPlugin, setTryPlugin] = useState<{ id: string; name: string; icon?: string } | null>(null);
  // 选项1(图2):选中 skill 后在输入框上方显示的 pill(icon + 友好名);textarea 只留参数,发送时拼回 cmd。
  const [selectedSkill, setSelectedSkill] = useState<{ cmd: string; displayName: string } | null>(null);
  // 把 pill 单向镜像进 store,供落地页 SceneChips 展示对应 skill 的示例提示词。
  // 真源仍是上面的本地 state:组件卸载(切会话/离开落地页)时清掉,避免 pill 跨会话残留在示例区。
  const setComposerSkill = usePersonalStore((s) => s.setComposerSkill);
  useEffect(() => {
    setComposerSkill(selectedSkill ?? undefined);
  }, [selectedSkill, setComposerSkill]);
  useEffect(() => () => setComposerSkill(undefined), [setComposerSkill]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 上传入口合并:图片/文档共用单个隐藏 input,经「+」菜单「文件」项触发,onChange 按 MIME 分流。
  const attachInputRef = useRef<HTMLInputElement>(null);
  // 上传入口合并:文件上传 + Skills 开关收进单个「+」按钮的上弹菜单(复用 AgentSelect 同款关闭范式)。
  const attachMenu = useDismissableMenu();
  const mention = useMentionAutocomplete(text, setText, taRef);

  // 会话未单独设 thinkingLevel 时,下拉回退全局默认（与 sendPiTurn 的实际生效值一致,避免「显关闭、实际用默认」）。
  const piThinkingDefault = usePersonalStore((s) => s.generalSettings.piThinkingDefault);
  // 读取 ASR 配置（U9：不再硬编码，从 store 取用户配置）。
  const asrSettings = usePersonalStore((s) => s.asrSettings);
  const isPi = agent === "pi";
  const models = AGENT_MODELS[agent];
  const thinkingOptions = agentThinkingOptions(agent);
  const resolvedThinkingValue = isPi ? (thinkingValue ?? piThinkingDefault ?? "off") : (thinkingValue ?? DEFAULT_AGENT_THINKING);
  // pi:模型下拉改由 Provider Catalog 驱动（计划 §4.2）——候选是「认证可用 ∧ 用户未隐藏」的
  // Provider 的全部模型，能力（图片/推理/上下文）只读，来自 pi 内置目录。
  // 选项编码沿用 `${providerId}::${modelId}`（onChangePiModel 据此拆分），不改上层契约。
  const providerViews = useProviderViews().views;
  const piModelOptions = isPi
    ? collectModelOptions(providerViews).map((o) => ({ value: `${o.providerId}::${o.modelId}`, label: o.model.name }))
    : [];
  const piModelValue = `${providerId ?? ""}::${model ?? ""}`;

  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = "auto";
    taRef.current.style.height = Math.min(140, taRef.current.scrollHeight) + "px";
  }, [text]);

  // pi 运行中可插话（steer）:把引导注入当前轮。仅 pi + 提供 onSteer 时启用。
  const canSteer = !!onSteer && isPi && running;

  // 以显式文本发送（「插入并运行」自动提交用）:不读闭包 text state,避免 setText 异步后发到旧值。
  const sendText = async (textToSend: string) => {
    // 纯图 / 纯文档(无文本)也允许发送。
    if ((!textToSend.trim() && images.length === 0 && docFiles.length === 0) || running || sending) return;
    setSending(true);
    // 乐观清空输入框:发送瞬间即清文本/附件 pill/插件 pill,不等本轮 agent 跑完。
    // 依据:core 的 send 在 await 整轮流式(drainCliStream / sendPiTurn)之前,已同步 pushMessages
    //(用户气泡上屏)+ setRunning(true),「消息已受理」在发送瞬间即成立。若把清空留到 await onSend
    // 之后,而 onSend 的 Promise 直到 agent 本轮结束才 resolve,输入框文字会滞留到本轮结束(bug)。
    // 待发图/文档仍按 consumed 在 await 后清(保留「未消费则留待重试」语义):先存快照再传参,
    // React setter 不改当前闭包已绑定的 attachments/images/docFiles,本次入参不受上面清空影响。
    const sentImages = images.length ? images : undefined;
    const sentDocs = docFiles.length ? docFiles : undefined;
    setText("");
    setAttachments([]);
    setTryPlugin(null); // 发送后清插件试用 pill
    setSelectedSkill(null); // 发送后清已选 skill pill(选项1)
    try {
      // onSend 返回「是否已消费」(真正发出);未消费(/clear、pi 不可用、落盘失败)则保留待发图/文档供重试。
      const consumed = await onSend(textToSend, attachments, sentImages, sentDocs);
      if (consumed) {
        setImages([]); // 仅真正消费才清待发图/文档
        setDocFiles([]);
      }
    } finally {
      setSending(false);
    }
  };
  // 已选 skill 时:把 pill 的 cmd 与输入的参数拼回 `/skill:name args`(无参数则仅 cmd)交发送路径解析。
  const send = () => {
    const args = text.trim();
    const outText = selectedSkill ? (args ? `${selectedSkill.cmd} ${args}` : selectedSkill.cmd) : text;
    void sendText(outText);
  };

  // 采集图片:格式/大小校验(toast 原因)→ 读成 PendingImage → 去重 + 张数上限以 prev 为准
  // (放进 setImages 函数式更新,避免快速连续采集时过期闭包 images 导致越限/漏去重)。
  const addImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const accepted: File[] = [];
    for (const f of files) {
      const reason = checkImageFile(f);
      if (reason) onToast(rejectReasonText(reason, f.name));
      else accepted.push(f);
    }
    if (accepted.length === 0) return;
    let pending: PendingImage[];
    try {
      pending = await Promise.all(accepted.map((f) => fileToPendingImage(f)));
    } catch (err) {
      onToast(t("composer.readImageFailed", { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    let overflow = false;
    setImages((prev) => {
      const seen = new Set(prev.map((i) => imageDedupeKey(i.name, i.data.byteLength)));
      const merged = [...prev];
      for (const img of pending) {
        const key = imageDedupeKey(img.name, img.data.byteLength);
        if (seen.has(key)) continue; // 同名同尺寸去重
        if (merged.length >= MAX_IMAGES_PER_MESSAGE) {
          overflow = true;
          continue;
        }
        seen.add(key);
        merged.push(img);
      }
      return merged;
    });
    if (overflow) onToast(t("composer.maxImages", { count: MAX_IMAGES_PER_MESSAGE }));
  };

  // 粘贴:剪贴板文件分流——图片走图片通道、受支持文档走文档通道(R8 不混用);纯文本走原行为(不拦截)。
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fileItems = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    const imgs = fileItems.filter((f) => f.type.startsWith("image/"));
    const docs = fileItems.filter((f) => !f.type.startsWith("image/") && isAcceptedDoc(f.name));
    if (imgs.length === 0 && docs.length === 0) return;
    e.preventDefault();
    if (imgs.length) void addImageFiles(imgs);
    if (docs.length) void addDocFiles(docs);
  };

  // 统一文件选择:单个 input 同时接受图片与文档,按 MIME 分流——图片走图片通道、其余走文档通道
  // (文档侧 checkDocFile 仍会校验/拒绝不支持的类型)。选完即清空 input.value,允许重复选同一文件。
  const onPickAttachments = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    const docs = files.filter((f) => !f.type.startsWith("image/"));
    if (imgs.length) void addImageFiles(imgs);
    if (docs.length) void addDocFiles(docs);
  };

  // 采集文档:格式/大小校验(toast 原因)→ File → PendingDocFile(优先 srcPath)→ 去重 + 张数上限。
  // 文档内容不进消息,发送时经 doc:save 落盘 + 由 agent 经 extract_document 按需读取。
  const addDocFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const accepted: File[] = [];
    for (const f of files) {
      const reason = checkDocFile(f);
      if (reason) onToast(docRejectText(reason, f.name));
      else accepted.push(f);
    }
    if (accepted.length === 0) return;
    let pending: PendingDocFile[];
    try {
      pending = await Promise.all(accepted.map((f) => fileToPendingDocFile(f)));
    } catch (err) {
      onToast(t("composer.readDocFailed", { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    let overflow = false;
    setDocFiles((prev) => {
      const seen = new Set(prev.map((d) => docDedupeKey(d.name, d.sizeBytes)));
      const merged = [...prev];
      for (const d of pending) {
        const key = docDedupeKey(d.name, d.sizeBytes);
        if (seen.has(key)) continue;
        if (merged.length >= MAX_DOCS_PER_MESSAGE) {
          overflow = true;
          continue;
        }
        seen.add(key);
        merged.push(d);
      }
      return merged;
    });
    if (overflow) onToast(t("composer.maxDocs", { count: MAX_DOCS_PER_MESSAGE }));
  };

  const steer = () => {
    if (!text.trim() || !onSteer) return;
    onSteer(text);
    setText("");
  };

  // Enter:运行中可插话则 steer,否则 send（send 内部对 running 短路）。
  const submit = () => (canSteer ? steer() : send());

  // 进入编辑重发:原文替换输入框内容并聚焦。
  useEffect(() => {
    if (!editing) return;
    setText(editing.text);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [editing]);

  const cancelEdit = () => {
    setText("");
    onCancelEdit?.();
  };

  // 文件预览「发送到 Chat」:片段插入输入框（不直接发送,让用户补一句再回车）。
  // nonce 去重:composer 随会话切换重挂载时,旧 insert 不能再次插入。
  // 镜像 text 供插入 effect 读取,避免在 setText 更新函数里做副作用计算最终文本（自动提交需显式文本）。
  const composerInsert = usePersonalStore((s) => s.composerInsert);
  const consumedNonceRef = useRef(composerInsert?.nonce ?? 0);
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    if (!acceptComposerInsert) return;
    if (!composerInsert || composerInsert.nonce === consumedNonceRef.current) return;
    consumedNonceRef.current = composerInsert.nonce;
    if (composerInsert.plugin) setTryPlugin(composerInsert.plugin); // 插件试用上下文 → 输入框前 pill
    if (composerInsert.skill) setSelectedSkill(composerInsert.skill); // 落地页场景 chip → 输入框前 skill pill
    const prev = textRef.current;
    // 空文本 insert（纯预置 pill 的场景 chip 路径）不得动 textarea:否则会往用户已写的半句后面
    // 追加一个空行。仅在真的带文本时才做「空则替换 / 非空则换行追加」。
    const finalText = !composerInsert.text
      ? prev
      : !prev.trim()
        ? composerInsert.text
        : `${prev}${prev.endsWith("\n") ? "" : "\n"}${composerInsert.text}`;
    // 走「用户编辑」通道写入,让这次插入进浏览器原生撤销栈(Cmd+Z 可撤回填入的示例提示词);
    // 直接 setText 是程序化改值,原生撤销栈看不见。execCommand 已废弃但 Chromium 仍支持,
    // 失败/环境不支持(如 jsdom)时回退直接填入——功能不受影响,只是那次插入撤不回。
    if (finalText !== prev && !insertTextAsUserEdit(taRef.current, finalText)) setText(finalText);
    // 随插入携带的待发图片(如批注「始终包含截图」,U4):并入 images,沿用去重 + 张数上限。
    // 满张数上限时溢出图片不静默丢——同拖拽路径出 toast(评审 correctness)。
    if (composerInsert.images?.length) {
      const incoming = composerInsert.images;
      let overflow = false;
      setImages((prevImgs) => {
        const seen = new Set(prevImgs.map((i) => imageDedupeKey(i.name, i.data.byteLength)));
        const merged = [...prevImgs];
        for (const img of incoming) {
          const key = imageDedupeKey(img.name, img.data.byteLength);
          if (seen.has(key)) continue;
          if (merged.length >= MAX_IMAGES_PER_MESSAGE) {
            overflow = true;
            continue;
          }
          seen.add(key);
          merged.push(img);
        }
        return merged;
      });
      if (overflow) onToast(t("composer.maxImages", { count: MAX_IMAGES_PER_MESSAGE }));
    }
    // submit 且空闲:以显式文本直接提交（tasks「插入并运行」);running 时退化为仅插入。
    if (composerInsert.submit && !running) {
      void sendText(finalText);
    } else {
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [composerInsert, acceptComposerInsert]);

  // 转写成功后：追加到输入框（保留现有内容 + 换行），并聚焦。
  const appendTranscript = useCallback((transcript: string) => {
    setText((prev) => {
      const clean = transcript.trim();
      if (!prev.trim()) return clean;
      return `${prev}${prev.endsWith("\n") ? "" : "\n"}${clean}`;
    });
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);

  // ── 语音录制与转写 hook（U9）─────────────────────────────────────────────────
  // 抽离录音状态机、WAV 重采样、按钮可用条件到 useComposerVoice；
  // ComposerShell 只负责 onTranscript 回填和 onToast。
  const {
    recording,
    transcribing,
    micVisible,
    micReady,
    downloadPercent,
    toggleRecording,
  } = useComposerVoice({
    bridge,
    asrSettings,
    onTranscript: appendTranscript,
    onToast,
    runningOrSending: running || sending,
  });

  const appendTodoInstruction = (title: string) => {
    const instruction = t("composer.todoInstruction", { title });
    setText((prev) => {
      if (!prev.trim()) return instruction;
      if (prev.includes(instruction)) return prev;
      return `${prev}${prev.endsWith("\n") ? "" : "\n"}${instruction}`;
    });
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // slash 命令:输入 "/" 前缀即时匹配;↑/↓ 选择、Enter/Tab 执行高亮项、Esc 收起。
  // 触发收紧(KTD7):仅当文本以 "/" 开头且**尚无空格**(还在键入命令 token)时打开。
  // 否则 skill 项插入 "/skill:name " 后,菜单会立刻重开覆盖输入、Enter 又被拦为重执行——
  // 有空格即视为「已选定命令、正在填参数」,菜单关闭,Enter 正常发送。
  // afterSlash 保留尾随空格(不做 trimEnd):插入 "/skill:name " 后它含空格 → 视为「已选定、填参中」→ slashQuery=null → 菜单关闭。
  const afterSlash = text.trimStart();
  const slashQuery =
    slashCommands.length > 0 && afterSlash.startsWith("/") && !afterSlash.includes(" ") && !afterSlash.includes("\n")
      ? afterSlash
      : null;
  // 模糊匹配(子序列 + 排序):输入 "/br" 也能命中 "/skill:agent-browser"(见 matchSlashCommands)。
  const slashMatches = slashQuery ? matchSlashCommands(slashQuery, slashCommands) : [];
  const slashOpen = !!slashQuery && slashMatches.length > 0 && !slashDismissed;
  // 查询变化（输入/删除字符）→ 高亮回到首项并撤销 Esc 收起;纯方向键导航不改 query,选择得以保持。
  useEffect(() => {
    setSlashSel(0);
    setSlashDismissed(false);
  }, [slashQuery]);

  // 选中命令:内建立即执行;skill 选中后在输入框上方显示 pill(选项1/图2),textarea 清空供填参,
  // 发送时由 send() 把 pill 的 cmd 与参数拼回 `/skill:name args`。菜单随 text 清空自动关闭。
  const runCommand = (c: SlashCommand) => {
    if (c.kind === "skill") {
      setSelectedSkill({ cmd: c.cmd, displayName: c.displayName ?? c.cmd });
      setText("");
      taRef.current?.focus();
      return;
    }
    onSend(c.cmd, []);
    setText("");
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // @mention autocomplete 优先拦截
    if (mention.handleMentionKeyDown(e)) return;
    // 已选 skill chip 在输入框最前:参数为空时按 Backspace/Delete 即删除该 chip(退格移除前置 chip 的直觉)。
    if (selectedSkill && text === "" && (e.key === "Backspace" || e.key === "Delete") && !e.nativeEvent.isComposing) {
      e.preventDefault();
      setSelectedSkill(null);
      return;
    }
    if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = slashMatches.length;
      setSlashSel((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
      return;
    }
    if (slashOpen && e.key === "Escape") {
      e.preventDefault();
      setSlashDismissed(true);
      return;
    }
    // Tab / Enter:执行当前高亮的命令（高亮项可能因过滤变化越界,故 clamp）。
    if (slashOpen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing))) {
      e.preventDefault();
      runCommand(slashMatches[Math.min(slashSel, slashMatches.length - 1)]!);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const rawPrompt = e.dataTransfer.getData(PROMPT_DRAG_MIME);
    const rawTodo = e.dataTransfer.getData(TODO_DRAG_MIME);
    const rawFile = e.dataTransfer.getData(FILE_DRAG_MIME);
    // 应用内 MIME(skill/todo/file)优先;否则当作系统文件拖入,按类型分流:
    // 图片→图片通道、受支持文档→文档通道(R8 不混用)、其余(含旧二进制 .doc/.xls/.ppt)→ 逐个 toast 跳过。
    if (!rawPrompt && !rawTodo && !rawFile) {
      const all = Array.from(e.dataTransfer.files ?? []);
      const imgs = all.filter((f) => f.type.startsWith("image/"));
      const docs = all.filter((f) => !f.type.startsWith("image/") && isAcceptedDoc(f.name));
      const rejected = all.filter((f) => !f.type.startsWith("image/") && !isAcceptedDoc(f.name));
      if (imgs.length) void addImageFiles(imgs);
      if (docs.length) void addDocFiles(docs);
      for (const f of rejected) onToast(docRejectText("type", f.name));
      return;
    }
    if (!bridge) return;
    try {
      // 文件预览拖入(U6):复用 kind:"prompt" 附件通道,但直接用文件名(不跑 deriveSkillName,
      // 避免含 name: frontmatter 的普通文件被改成无关 skill 名)。同路径已存在则去重 no-op。
      if (rawFile) {
        const { path, name } = JSON.parse(rawFile) as { path: string; name: string };
        // 仅二进制文档(PDF/Office)走文档附件通道(已知路径作 srcPath 直接落盘 → agent 经
        // extract_document 读取);文本文件(.md/.txt/代码/配置等)保持既有 readFile→prompt 注入,
        // 不在此改道(那是注入文件内容作上下文的独立功能,非"附文档")。
        if (isBinaryDoc(name)) {
          setDocFiles((prev) =>
            prev.some((d) => d.srcPath === path) || prev.length >= MAX_DOCS_PER_MESSAGE
              ? prev
              : [...prev, pendingDocFromPath(path, name)],
          );
          return;
        }
        if (attachments.some((a) => a.path === path)) return;
        const { content, truncated } = await bridge.readFile(path);
        if (truncated) onToast(t("composer.fileTruncated", { name }));
        attachSeq += 1;
        setAttachments((prev) => [...prev, { id: `pa-${attachSeq}`, name, path, kind: "prompt", content }]);
        return;
      }
      if (rawTodo) {
        const { id, detailPath, title, projectName } = JSON.parse(rawTodo) as {
          id: string;
          detailPath: string;
          title: string;
          projectName: string;
        };
        if (attachments.some((a) => a.kind === "todo" && a.id === id)) {
          appendTodoInstruction(title);
          return;
        }
        const { content, truncated } = await bridge.readFile(detailPath);
        if (truncated) onToast(t("composer.todoTruncated", { title }));
        setAttachments((prev) => [...prev, { id, name: title, path: detailPath, kind: "todo", projectName, content }]);
        appendTodoInstruction(title);
        return;
      }
      const { path, name } = JSON.parse(rawPrompt) as { path: string; name: string };
      if (attachments.some((a) => a.path === path)) return;
      const { content, truncated } = await bridge.readFile(path);
      if (truncated) onToast(t("composer.skillTruncated", { name }));
      attachSeq += 1;
      const skillName = deriveSkillName(path, name, content);
      setAttachments((prev) => [...prev, { id: `pa-${attachSeq}`, name: skillName, path, kind: "prompt", content }]);
    } catch (err) {
      onToast(t("composer.readAttachmentFailed", { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <div className={`composer-wrap${className ? ` ${className}` : ""}`}>
      {/* 图片能力阻断提示条放在这里（而不是外层聊天区）：待发图片是 ComposerShell 的内部状态，
          「移除图片」必须由持有它的组件执行，否则只能靠一层 store 中转，徒增一条隐式契约。 */}
      {visionBlockSessionId ? (
        <VisionBlockBanner sessionId={visionBlockSessionId} onRemoveImages={() => setImages([])} />
      ) : null}
      <div
        className={`composer ${dragOver ? "pw-drop-target" : ""}`}
        onDragOver={(e) => {
          // 应用内 skill/todo 或系统文件(图片)拖入都给高亮反馈。
          if (
            e.dataTransfer.types.includes(PROMPT_DRAG_MIME) ||
            e.dataTransfer.types.includes(TODO_DRAG_MIME) ||
            e.dataTransfer.types.includes(FILE_DRAG_MIME) ||
            e.dataTransfer.types.includes("Files")
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {attachments.length > 0 ? (
          <div className="attach-row">
            {attachments.map((a) => (
              <span key={a.id} className="attach-pill">
                <span
                  className="ap-thumb"
                  style={{
                    background:
                      a.kind === "todo" ? "linear-gradient(135deg,#4f7f62,#2d5c45)" : "linear-gradient(135deg,#c96442,#a84e30)",
                  }}
                >
                  {a.kind === "todo" ? "TD" : "SK"}
                </span>
                <span>{a.name}</span>
                <button
                  className="attach-x"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  title={t("composer.remove")}
                >
                  <Icon.X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {images.length > 0 ? (
          <div className="img-attach-row">
            {images.map((img) => (
              <span key={img.id} className="img-attach">
                <img src={img.dataUrl} alt={img.name} className="img-attach-thumb" />
                <button
                  type="button"
                  className="img-attach-x"
                  aria-label={t("composer.removeImage", { name: img.name })}
                  title={t("composer.remove")}
                  onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
                >
                  <Icon.X size={11} />
                </button>
              </span>
            ))}
            {running ? <span className="img-attach-hint">{t("composer.imagesHint")}</span> : null}
          </div>
        ) : null}
        {docFiles.length > 0 ? (
          <div className="attach-row">
            {docFiles.map((d) => (
              <span key={d.id} className="attach-pill" title={d.name}>
                <span className="ap-thumb" style={{ background: "linear-gradient(135deg,#3b6fb0,#2a5183)" }}>
                  <Icon.File size={12} />
                </span>
                <span>{d.name}</span>
                <button
                  className="attach-x"
                  onClick={() => setDocFiles((prev) => prev.filter((x) => x.id !== d.id))}
                  title={t("composer.remove")}
                >
                  <Icon.X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {/* slash 命令匹配提示:↑/↓ 选择、Enter/Tab 执行高亮项、点击亦可执行 */}
        {slashOpen ? (
          <div className="pw-slash-hint" role="listbox">
            {slashMatches.map((c, i) => {
              const active = i === Math.min(slashSel, slashMatches.length - 1);
              return (
                <button
                  key={c.cmd}
                  role="option"
                  aria-selected={active}
                  className={`pw-slash-item ${active ? "is-active" : ""}`}
                  onMouseEnter={() => setSlashSel(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    runCommand(c);
                  }}
                >
                  {/* skill 项:图标 + Title-Case 友好名(如 Image Gen);内建命令仍展示原始 /cmd。 */}
                  {c.displayName ? (
                    <>
                      <Icon.Sparkle size={14} className="pw-slash-icon" />
                      <span className="pw-slash-name">{c.displayName}</span>
                    </>
                  ) : (
                    <code>{c.cmd}</code>
                  )}
                  {c.argHint ? <span className="pw-slash-arg">{c.argHint}</span> : null}
                  {/* 描述单行省略:skill 的 SKILL.md 描述可能很长,全显会撑爆菜单(title 给悬停全文)。 */}
                  <span className="pw-slash-desc" title={c.desc}>{c.desc}</span>
                  {/* 来源标签(个人/系统/工作区),右侧弱化展示。 */}
                  {c.tag ? <span className="pw-slash-tag">{c.tag}</span> : null}
                  {/* 动作提示按 kind 区分(KTD4):skill 为「插入」(选中填参),内建为「运行」(立即执行)。 */}
                  {active ? (
                    <kbd className="pw-slash-kbd">
                      {c.kind === "skill" ? t("composer.slashInsert") : t("composer.slashRun")}
                    </kbd>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {editing ? (
          <div className="pw-edit-bar">
            <Icon.Edit size={12} />
            <span>{t("composer.editBar")}</span>
            <button type="button" onClick={cancelEdit}>
              {t("composer.cancel")}
            </button>
          </div>
        ) : null}
        <div className="input-area">
          {artifact ? (
            // 标题过长时靠 CSS 省略号截断,hover 提示带上全名(而不只是落盘路径),否则截掉的部分无处可查。
            <span className="pw-try-pill pw-artifact-pill" title={`${artifact.title}\n${artifact.entryPath}`}>
              <button
                type="button"
                className="pw-artifact-pill-open"
                aria-label={`打开产物 ${artifact.title}`}
                onClick={onOpenArtifact}
              >
                <span className="pw-try-pill-ico">
                  <Icon.Sparkle size={12} />
                </span>
                <span className="pw-try-pill-name">{artifact.title}</span>
              </button>
              <button
                type="button"
                className="pw-try-pill-x"
                aria-label="移除当前产物"
                onClick={onRemoveArtifact}
              >
                <Icon.X size={11} />
              </button>
            </span>
          ) : null}
          {/* 插件「在对话中试用」pill:图标(首字母)+名称,内联在提示词左侧。点 × 移除。 */}
          {tryPlugin ? (
            <span className="pw-try-pill" title={tryPlugin.name}>
              <span className="pw-try-pill-ico">
                {tryPlugin.icon ? (
                  <img className="pw-try-pill-img" src={tryPlugin.icon} alt="" />
                ) : (
                  (tryPlugin.name.charAt(0) || "?").toUpperCase()
                )}
              </span>
              <span className="pw-try-pill-name">{tryPlugin.name}</span>
              <button
                type="button"
                className="pw-try-pill-x"
                aria-label={t("composer.remove")}
                onClick={() => setTryPlugin(null)}
              >
                <Icon.X size={11} />
              </button>
            </span>
          ) : null}
          {/* 选项1(图2):已选 skill pill —— 图标 + 友好名 + ×;textarea 里只填参数,发送时拼回 /skill:name。 */}
          {selectedSkill ? (
            <span className="pw-try-pill pw-skill-pill" title={selectedSkill.displayName}>
              <span className="pw-try-pill-ico">
                <Icon.Sparkle size={12} />
              </span>
              <span className="pw-try-pill-name">{selectedSkill.displayName}</span>
              <button
                type="button"
                className="pw-try-pill-x"
                aria-label={t("composer.remove")}
                onClick={() => {
                  setSelectedSkill(null);
                  taRef.current?.focus();
                }}
              >
                <Icon.X size={11} />
              </button>
            </span>
          ) : null}
          {mention.isOpen && (
            <MentionDropdown
              options={mention.filtered}
              activeIndex={mention.activeIdx}
              onSelect={mention.selectMention}
              anchorRect={mention.anchorRect}
            />
          )}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // 会话预热:敲下首个字符即预拉起 agent 进程(去重在调用方),发送时省掉冷启等待。
              if (e.target.value.trim()) onPrewarm?.();
              // @mention autocomplete：文本变更时重新检测 @query
              requestAnimationFrame(() => mention.updateMentionState());
              // 宠物:进入「看你打字」状态（停止输入后由节拍器衰减回 idle）。
              const pet = usePetStore.getState();
              if (pet.state === "idle" || pet.state === "sleeping" || pet.state === "typing") pet.set("typing");
            }}
            onKeyDown={onKey}
            onPaste={onPaste}
            placeholder={
              canSteer
                ? t("composer.steerPlaceholder")
                : running
                ? t("composer.runningPlaceholder")
                : placeholder ?? t("composer.defaultPlaceholder", { name: AGENT_PLACEHOLDER_NAME[agent] })
            }
            rows={1}
          />
        </div>
        <div className="comp-foot">
          {/* 语音按钮：仅 bridge 存在 + STT enabled 时显示（R11）。
              下载中禁用并给出进度 tooltip；配置不就绪时禁用。 */}
          {micVisible ? (
            <button
              className={`pill pw-mic-btn ${recording ? "is-recording" : ""} ${transcribing ? "is-busy" : ""}`}
              onClick={toggleRecording}
              disabled={running || sending || transcribing || !micReady}
              title={
                recording
                  ? t("composer.micStopTitle")
                  : transcribing
                  ? t("composer.micBusyTitle")
                  : downloadPercent !== null
                  ? t("composer.micDownloadingTitle", { percent: downloadPercent })
                  : !micReady
                  ? t("composer.micNotReadyTitle")
                  : t("composer.micTitle")
              }
            >
              {transcribing ? <Icon.Clock size={13} /> : <Icon.Mic size={13} />}
            </button>
          ) : null}
          {/* 图片/文档上传 + Skills 开关合并进单个「+」按钮的上弹菜单:
              「文件」统一图片与附件(单个 input,按 MIME 分流);Skills 行内开关显示当前态,
              点击切换且不收起菜单(便于看到状态变化)。 */}
          <div
            className="pw-tb-menu-wrap"
            ref={attachMenu.wrapRef}
            onMouseLeave={attachMenu.onMouseLeave}
            onMouseEnter={attachMenu.onMouseEnter}
          >
            <button
              className="pill"
              type="button"
              aria-haspopup="menu"
              aria-expanded={attachMenu.open}
              onClick={() => attachMenu.setOpen((v) => !v)}
              title={t("composer.addMenu")}
              aria-label={t("composer.addMenu")}
            >
              <Icon.Plus size={15} />
            </button>
            {attachMenu.open ? (
              <div className="pw-tb-menu pw-tb-menu--up pw-tb-menu--left" role="menu">
                <button
                  className="pw-tb-menu-item"
                  role="menuitem"
                  onClick={() => {
                    attachInputRef.current?.click();
                    attachMenu.setOpen(false);
                  }}
                >
                  <Icon.Paperclip size={14} />
                  <span>{t("composer.uploadFile")}</span>
                </button>
                <button
                  className={`pw-tb-menu-item ${useOwnSkills ? "is-on" : ""}`}
                  role="menuitemcheckbox"
                  aria-checked={useOwnSkills}
                  title={useOwnSkills ? t("composer.skillsOnTitle") : t("composer.skillsOffTitle")}
                  onClick={() => onToggleSkills()}
                >
                  <Icon.Sparkle size={14} color="#7c5cff" />
                  <span>{t("composer.skills")}</span>
                  <span className="pw-tb-menu-state">
                    {useOwnSkills ? t("composer.skillsOn") : t("composer.skillsOff")}
                  </span>
                </button>
                {/* 反向入口：套上「深度研究」skill pill，已写的文本原样留着当研究目标。走 pill 而非
                    直接发起 = 与用户敲 `/skill:research` 同一条路径，发起前能改词、也能退格取消。
                    **不按文本为空禁用**：先套 pill 再想目标是常见顺序，空目标留给发送那一刻拒。 */}
                {researchSkillAvailable ? (
                  <button
                    className="pw-tb-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setSelectedSkill(RESEARCH_SKILL_PILL);
                      attachMenu.setOpen(false);
                    }}
                  >
                    <Icon.Search size={14} />
                    <span>{t("composer.toResearch")}</span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {/* 统一附件入口:单个 input 同时接受图片与文档,onChange 按 MIME 分流到图片/文档通道。 */}
          <input
            ref={attachInputRef}
            type="file"
            accept={`image/png,image/jpeg,image/gif,image/webp,${DOC_ACCEPT_ATTR}`}
            multiple
            style={{ display: "none" }}
            onChange={onPickAttachments}
          />
          {/* 执行权限选择 pill(置于「+」之后),opt-in:提供 onChange 才渲染。 */}
          {onChangeExecPermission ? (
            <CustomizePill
              agent={agent}
              execPermission={execPermission}
              onChangeExecPermission={onChangeExecPermission}
              running={running}
            />
          ) : null}
          {/* 「联网」开关(会话级):开启后本会话的 agent 拿到 web_search / web_read,自行决定何时用。
              刻意做成底栏上一眼可见的独立 pill 而非菜单项——出站能力的当前状态不该藏在二级菜单里。
              运行中不可改:claude/codex 的工具集在本轮 spawn 时已定,改了也要等下一轮,
              让按钮此刻可点只会造成「我改了但没用」的误解。 */}
          {onToggleWebSearch ? (
            <button
              className={`pill ${webSearch ? "is-on" : ""}`}
              type="button"
              aria-pressed={!!webSearch}
              disabled={running || webSearchUnavailable}
              title={t(
                webSearchUnavailable
                  ? "composer.webSearch.unconfiguredTitle"
                  : webSearch
                  ? "composer.webSearch.onTitle"
                  : "composer.webSearch.offTitle",
              )}
              onClick={onToggleWebSearch}
            >
              <Icon.Globe size={13} />
              <span>{t("composer.webSearch.label")}</span>
            </button>
          ) : null}
          <div className="spacer" />
          {/* agent + 模型 + 推理强度合并为单个 pill(Image #3 行式下钻)。
              agent 维度 opt-in:仅新会话落地页传 onChangeAgent 时,pill 才有 agent 头像与
              面板的 Agent 下钻行;会话内不传 → 退化为「模型 + 推理」(会话内切换在顶栏)。 */}
          <ModelThinkingPill
            isPi={isPi}
            models={models}
            model={model}
            onChangeModel={onChangeModel}
            piModelOptions={piModelOptions}
            piModelValue={piModelValue}
            onChangePiModel={onChangePiModel}
            thinkingOptions={thinkingOptions}
            resolvedThinkingValue={resolvedThinkingValue}
            onChangeThinking={onChangeThinking}
            disabled={isPi ? piModelOptions.length === 0 : models.length === 0}
            agent={agent}
            derivedAgentId={derivedAgentId}
            agentsAvailable={agentsAvailable}
            derivedAgents={derivedAgents}
            onSwitchAgent={onChangeAgent}
          />
          {running ? (
            <>
              {canSteer && text.trim() ? (
                <button className="send" onClick={steer} title={t("composer.steerSend")}>
                  <Icon.ArrowUp size={15} />
                </button>
              ) : null}
              <button className="send pw-stop-btn" onClick={onStop} title={t("composer.stop")}>
                <Icon.Stop size={15} />
              </button>
            </>
          ) : (
            <button
              className={`send ${text.trim() || images.length ? "" : "muted"}`}
              onClick={() => void send()}
              disabled={(!text.trim() && images.length === 0) || sending}
              title={t("composer.send")}
            >
              <Icon.ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
