// U6:发送侧 /skill:name 派发的纯函数模块。原内联在 PersonalChatArea.tsx,抽出成独立模块
// 供写作助手面板(WritingAssistantPanel)复用——写作侧 import 重组件文件会连带拉入整个个人
// 聊天区依赖图,故按「纯函数下沉」原则单独成文件。行为与原实现逐字一致。
import { renderClaudeSkillSlash, renderSkillInvocation } from "@cortex-work/core";
import type { AgentKind, InjectableSkill } from "@cortex-work/core";

// 发送侧 /skill:name 派发结果。outText 是最终发给 send() 的文本;invokedSkill 仅 codex 单发
// 原生触发时非空(随请求落到 CliStartRequest.invokedSkill,主进程按 transport 决定 ws/exec)。
export interface SkillDispatch {
  outText: string;
  invokedSkill?: { name: string; path: string };
  artifactKind?: "design" | "slides";
}

function artifactKindForSkill(skill: InjectableSkill): SkillDispatch["artifactKind"] {
  return skill.name === "design" || skill.name === "slides" ? skill.name : undefined;
}

function withArtifactKind(artifactKind: SkillDispatch["artifactKind"]): Pick<SkillDispatch, "artifactKind"> {
  return artifactKind ? { artifactKind } : {};
}

// U6:把命中的 /skill:name 按 agent + 路由改写成三路(纯函数,便于单测)。
//  - 圆桌编排(useOrchestration=true):claude/codex 都维持现状 renderSkillInvocation prose——编排
//    路径(startOrchestration)绕开 cli:start,没有原生 skill 挂点(见 U5/U6 编排分支不改动)。
//  - 单发 + claude:转 claude CLI 认得的裸 slash,claude 自身在输入层原生展开(桥接目录见 U1/U2)。
//  - 单发 + codex:文本保留用户 args,并置 invokedSkill 结构化字段;prose 由主进程按 transport 决定
//    (ws 不注入 prose、exec 委派回退才 renderSkillInvocation,见 cli.ts U4)。
//  - 其它(理论不达,pi 已在调用前排除):原样透传,不阻断。
export function resolveSkillDispatch(
  agent: AgentKind,
  originalText: string,
  parsedArgs: string,
  skill: InjectableSkill,
  useOrchestration: boolean,
  allRecords: InjectableSkill[],
): SkillDispatch {
  const artifactKind = artifactKindForSkill(skill);
  if (useOrchestration) {
    return { outText: renderSkillInvocation(skill, parsedArgs), ...withArtifactKind(artifactKind) };
  }
  // claude 的裸 slash 命令名需按「本批次已启用 skill 集合」推导(碰撞消歧/空 slug 兜底与主进程建
  // 桥接目录时的算法一致,见 renderClaudeSkillSlash/resolveClaudeSlashName 注释),故传入 allRecords
  // 而非只传中选的这一条——否则会跟桥接目录的实际命名漂移(R7)。
  if (agent === "claude") {
    return {
      outText: renderClaudeSkillSlash(skill, parsedArgs, allRecords),
      ...withArtifactKind(artifactKind),
    };
  }
  if (agent === "codex") {
    return {
      outText: parsedArgs,
      invokedSkill: { name: skill.name, path: skill.dir },
      ...withArtifactKind(artifactKind),
    };
  }
  return { outText: originalText, ...withArtifactKind(artifactKind) };
}
