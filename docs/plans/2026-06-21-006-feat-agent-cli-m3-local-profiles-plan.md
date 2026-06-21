---
title: "feat: Agent CLI 调用层 M3-A — 用户 JSON 派生/覆盖 agent"
type: feat
date: 2026-06-21
origin: docs/brainstorms/2026-06-21-optimize-agent-cli-invocation-requirements.md
---

# feat: Agent CLI 调用层 M3-A — 用户 JSON 派生/覆盖 agent(FR-M3-1)

> 建立在 M1(管线硬化)+ M2(声明式 `AgentDef`)之上。M3 范围很大,本 plan 只覆盖 **FR-M3-1**
> (A 的 JSON 扩展):用户写一份 JSON 即可不改代码派生/覆盖 agent。FR-M3-2/3(Plugin 框架 B)与
> FR-M3-4(市场/信任/GenUI)另立 plan —— 见文末「后续」。

## Summary

对标 open-design `runtimes/local-profiles.ts`,新增 `~/.cortex-desktop/agents.local.json`:
- **覆盖内置 agent**(id 与某内置同名):换 bin / 追加参数 / 注入 env —— 零渲染端改动即端到端生效;
- **派生新 agent**(新 id,base 指向某内置):复用其 `parseLine` 与能力位,只换调起方式。

纯主进程 + 一处 IPC 暴露。安全姿态:解析失败 / 字段非法不抛错、不阻断启动(跳过非法项、保留合法项、记 warn)。

## Requirements

- R1. 用户配置文件 `agents.local.json` 派生/覆盖 agent,不改代码加新 CLI。(origin FR-M3-1)
- R2. 派生只能基于内置 def(claude/codex/pi),沿用其 `parseLine` 与能力位;只允许覆盖 bin/args/env。
- R3. 解析健壮:文件缺失/非法 JSON/非法条目一律降级,不影响内置 agent 与启动。
- R4. 行为保持:无 `agents.local.json` 时,claude/codex/pi 与 M2 结束态完全一致。

## Key Technical Decisions

- KTD1. **派生 = base def + 覆盖三元(bin/extraArgs/env)。** `deriveAgentDef(base, profile)` 产出新 `AgentDef`:
  `cmd` 由 `profile.bin` 覆盖;`extraArgs` 追加到 base `args` **末尾**(prompt 已走 stdin,末尾追加 flag 安全);
  `parseLine`/能力位/stdin 沿用 base;`env` 经新增的 `AgentDef.extraEnv` 由 spawn 站点注入。
- KTD2. **注册表懒加载 + 缓存 + 可刷新。** `getAgentDef` 先查派生(覆盖内置同名),再回内置,均无则抛错。
  首次访问读盘派生并缓存;`refreshLocalAgentProfiles()` 失效缓存(用户改文件后由 `agents:reloadProfiles` IPC 触发)。
  `setLocalAgentProfilesLoader` 为测试注入点。
- KTD3. **不依赖 electron 的纯逻辑层。** `agent-profiles.ts` 用 `os.homedir()` 而非 electron `app`,与
  `mcp-config.ts` 一致,校验/派生/读盘全部可单测。
- KTD4. **id 类型放宽 + 双份镜像同步。** `AgentDef.id` 由 `AgentKind` 放宽为 `string`(派生 id 任意);
  新增 `DerivedAgentMeta` 在 `ipc/types.ts` 与 `core/desktop/types.ts` 镜像同步,经 `DesktopBridge` 暴露。

## Implementation Units(均已实现)

- U1. `agents/agent-profiles.ts`:`LocalAgentProfile` 类型 + `parseLocalAgentProfiles`(校验/去重/跳过非法)
  + `readLocalAgentProfilesFile`(ENOENT/非法 JSON → [])+ `defaultAgentProfilesPath`。配 `agent-profiles.test.ts`。
- U2. `deriveAgentDef` + `AgentDef.extraEnv` 字段 + `id` 放宽为 string。配派生测试。
- U3. `agents/index.ts`:懒加载缓存、`getAgentDef` 解析派生、`listAgentProfiles`、`refreshLocalAgentProfiles`、
  `setLocalAgentProfilesLoader`。配 `index.test.ts`。
- U4. `cli.ts` 新增 `spawnEnvForDef(req, def)` 合并 `def.extraEnv`;cli:start / oneshot / ask / automation
  四条 spawn 路径接入。配 `spawnEnvForDef` 测试。
- U5. IPC `agents:profiles` / `agents:reloadProfiles`(`cli.ts`)+ preload + `DesktopBridge` 暴露;本 plan 文档。

## 配置文件格式

`~/.cortex-desktop/agents.local.json`:

```json
{
  "agents": [
    {
      "id": "claude-custom-endpoint",
      "base": "claude",
      "label": "Claude(自建网关)",
      "bin": "/opt/bin/claude",
      "extraArgs": ["--model", "claude-opus-4-8"],
      "env": { "ANTHROPIC_BASE_URL": "https://gateway.internal" }
    },
    { "id": "codex", "base": "codex", "bin": "/usr/local/bin/codex" }
  ]
}
```

- `id`:小写字母数字 + 单连字符;与内置同名(如 `codex`)= **覆盖内置**,否则 = 派生新 agent。
- `base`:`claude` | `codex` | `pi`,决定输出解析与能力位。
- `bin` / `extraArgs` / `env`:均可选;`extraArgs` 追加到内置参数末尾。

## Scope Boundaries

### 本 plan 不做(另立 plan)

- **FR-M3-2/3 Plugin 框架 B**:`SKILL.md + 清单` 解析 / 安装 / prompt 注入块。**与现有 pi 插件/skill 基础设施
  (`ipc/skills.ts`、`agents/pi-extensions.ts`、`ipc/pi-extensions-market.ts`、`skills/registry`)高度重叠**,
  需先做整合设计再落 plan。
- **FR-M3-4**:市场 UI / 信任分级 / 能力门控 / 流水线 / GenUI(origin 已标延后)。
- **渲染端 agent 选择器列出派生新 agent**:后端 `agents:profiles` 已就绪且新 id 可 spawn;选择器 UI 接线留作
  UI 跟进(覆盖内置 id 的场景已零 UI 改动生效)。

## 成功标准

- 写一份 `agents.local.json` 覆盖 `codex` 的 `bin` → 选 codex 跑通走自定义二进制(零渲染端改动)。
- 派生新 id → `agents:profiles` 列出,`getAgentDef(id)` 解析,spawn 用其 bin/args/env。
- 删除/写坏 `agents.local.json` → 内置 agent 行为不受影响。
