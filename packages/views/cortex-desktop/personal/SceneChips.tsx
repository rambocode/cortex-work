// 落地页(新会话首页)的「场景 tab + 快捷能力 chips」:替代原先价值偏低的用量日历 + 一日总结。
// 两类 chip：
//   - skill 类(演示文稿 / 设计稿)：不直接提交，只经 store 的 composerInsert.skill 在下方输入框
//     预置一个 skill pill(等价用户敲 `/skill:xxx` 选中)，用户补一句主题后回车走既有 artifact 派发链路。
//   - 视图类(深度研究 / 写作 / 自动化 / Loop 工作流)：调 store 的 open* action 直接切到对应工作台。
// 能力门控与 PersonalSidebar 保持一致：桥缺对应子域(Web 端 bridge 为 null)或研究引擎未开时，
// 整条 chip 不渲染——入口不该出现在一个后端根本没起来的功能上。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import { normalizeResearchEngineSettings } from "@cortex-work/core/research/settings";
import { useTranslation } from "@cortex-work/core/i18n";
import { SYSTEM_SKILL_COMMANDS } from "./useSlashCommands";

type SceneKey = "office" | "creative";
type ChipIcon = keyof typeof Icon;

// i18n key 在这里是按场景/chip/示例拼出来的，生成的 key 联合类型表达不了动态拼接；
// 逐处 `as "home.scene.office"` 只是噪音，统一收在一个窄化过的取值函数里。
type TFixed = (key: string) => string;

// 每个产物类 skill 的示例提示词 id（文案在 timeline.json 的 home.scene.examples.<skill>.<id>）。
// 只有产物类 skill 配示例——用户手动敲 `/skill:xxx` 选中别的 skill 时示例区自动不出现。
const SKILL_EXAMPLES: Record<string, string[]> = {
  "/skill:slides": ["pixel", "launch", "defense", "report"],
  "/skill:design": ["landing", "mobile", "poster", "dashboard"],
};

// `/skill:slides` → `slides`，用于拼示例文案的 i18n key。
function skillNameOf(cmd: string): string {
  return cmd.replace(/^\/skill:/, "");
}

// skill chip 只记 cmd，展示名从 SYSTEM_SKILL_COMMANDS 反查，保证与 slash 菜单同源。
type SceneChip =
  | { key: string; kind: "skill"; cmd: string; icon: ChipIcon; hintKey?: string }
  | { key: string; kind: "view"; action: ViewAction; icon: ChipIcon };

type ViewAction = "research" | "writing" | "automation" | "workflow";

// 场景 → chips 顺序表。设计稿刻意走 `/skill:design` 而非 store 的 openDesign()——
// 后者的 designOpen 目前没有任何渲染方(死开关)，接上去只会得到一片空白。
const SCENES: { key: SceneKey; chips: SceneChip[] }[] = [
  {
    key: "office",
    chips: [
      { key: "slides", kind: "skill", cmd: "/skill:slides", icon: "Chart", hintKey: "slidesHint" },
      { key: "research", kind: "view", action: "research", icon: "Search" },
      { key: "writing", kind: "view", action: "writing", icon: "Edit" },
      { key: "automation", kind: "view", action: "automation", icon: "Workflow" },
    ],
  },
  {
    key: "creative",
    chips: [
      { key: "design", kind: "skill", cmd: "/skill:design", icon: "Palette", hintKey: "designHint" },
      { key: "slides", kind: "skill", cmd: "/skill:slides", icon: "Chart", hintKey: "slidesHint" },
      { key: "workflow", kind: "view", action: "workflow", icon: "GitBranch" },
    ],
  },
];

export function SceneChips() {
  const { t } = useTranslation("timeline");
  const tx = t as TFixed;
  const bridge = useDesktopBridge();
  // 场景选择是纯展示态，不持久化：换个场景只是换一排入口，不值得占持久化配置。
  const [scene, setScene] = useState<SceneKey>("office");

  const insertToComposer = usePersonalStore((s) => s.insertToComposer);
  const openResearch = usePersonalStore((s) => s.openResearch);
  const openWriting = usePersonalStore((s) => s.openWriting);
  const openAutomation = usePersonalStore((s) => s.openAutomation);
  const openWorkflow = usePersonalStore((s) => s.openWorkflow);
  const researchEngine = usePersonalStore((s) => s.generalSettings.researchEngine);
  // 输入框当前的 skill pill(ComposerShell 单向镜像),决定示例区展示哪一组提示词。
  const composerSkill = usePersonalStore((s) => s.composerSkill);

  // 深度研究双门控(同 PersonalSidebar)：桥有 research 子域 **且** 设置里开了研究引擎。
  const researchAvailable = !!bridge?.research && normalizeResearchEngineSettings(researchEngine).enabled;
  const viewAvailable: Record<ViewAction, boolean> = {
    research: researchAvailable,
    writing: !!bridge, // 写作是整窗覆盖层，desktop-only；Web 端 bridge 为 null 自动降级
    automation: !!bridge?.automationList,
    workflow: !!bridge?.workflowList,
  };
  const viewOpen: Record<ViewAction, () => void> = {
    research: () => openResearch(),
    writing: openWriting,
    automation: openAutomation,
    workflow: openWorkflow,
  };

  const chips = useMemo(
    () => SCENES.find((s) => s.key === scene)!.chips.filter((c) => c.kind === "skill" || viewAvailable[c.action]),
    [scene, viewAvailable.research, viewAvailable.writing, viewAvailable.automation, viewAvailable.workflow],
  );

  // 点 skill chip：只预置 pill，不带文本、不自动提交，等用户补主题。
  const pickSkill = (cmd: string) => {
    const command = SYSTEM_SKILL_COMMANDS.find((c) => c.cmd === cmd);
    insertToComposer("", { skill: { cmd, displayName: command?.displayName ?? cmd } });
  };

  // 已选 skill 的示例提示词：点一下把整段需求追加进输入框（输入框已有内容时另起一行，不覆盖用户已写的字）。
  // 不带 skill 字段——pill 已经在了，重复下发只会白刷一次 setSelectedSkill。
  const examples = composerSkill ? (SKILL_EXAMPLES[composerSkill.cmd] ?? []) : [];
  const exampleBase = composerSkill ? `home.scene.examples.${skillNameOf(composerSkill.cmd)}` : "";
  // 选中某个有示例的 skill 后，整行换成它的示例：选了什么已经写在输入框的 pill 上，
  // 这里再摆一遍是重复信息。清掉输入框里的 pill 即恢复完整 chips。
  const focused = examples.length > 0;

  return (
    <section className="pw-scene" aria-label={t("home.scene.title")}>
      <div className="pw-scene-tabs" role="tablist" aria-label={t("home.scene.title")}>
        {SCENES.map(({ key }) => (
          <button
            key={key}
            role="tab"
            aria-selected={scene === key}
            className={`pw-scene-tab ${scene === key ? "is-active" : ""}`}
            onClick={() => setScene(key)}
          >
            {tx(`home.scene.${key}`)}
          </button>
        ))}
      </div>

      {/* 未选 skill 时是能力入口行;选中带示例的 skill 后,整行换成该 skill 的示例提示词。 */}
      <div className="pw-scene-chips" aria-label={t("home.scene.chipsLabel")}>
        {focused
          ? examples.map((id) => {
              const prompt = tx(`${exampleBase}.${id}.prompt`);
              return (
                <button key={id} className="pw-scene-example" title={prompt} onClick={() => insertToComposer(prompt)}>
                  <span>{tx(`${exampleBase}.${id}.label`)}</span>
                  {/* ↘ 指向下方输入框,暗示「点了会填到那里」 */}
                  <Icon.ArrowDownRight size={12} />
                </button>
              );
            })
          : chips.map((chip) => {
              const Glyph = Icon[chip.icon];
              const label = tx(`home.scene.${chip.key}`);
              return (
                <button
                  key={`${chip.kind}:${chip.key}`}
                  className="pw-scene-chip"
                  title={chip.kind === "skill" && chip.hintKey ? tx(`home.scene.${chip.hintKey}`) : label}
                  onClick={() => (chip.kind === "skill" ? pickSkill(chip.cmd) : viewOpen[chip.action]())}
                >
                  <Glyph size={14} />
                  <span>{label}</span>
                </button>
              );
            })}
      </div>
    </section>
  );
}
