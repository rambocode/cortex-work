# Lessons

## 2026-06-11 跨进程状态时序：renderer store ≠ 主进程视角

**事故**：首页「点击添加扫描项目」后，右栏立即 `fs:scanDirTree` 被主进程路径白名单拒绝——白名单读的是**落盘的** persisted state，而 renderer 持久化有 500ms 节流。

**规则**：在 renderer 新增任何「写 store 后立刻触发主进程 IPC」的入口时，先问一句：**主进程此刻看到的状态和 renderer 一致吗？** 凡主进程决策（白名单、配置、路由）依赖 persisted state 的：

1. 主进程应持有内存镜像，`store:save` 一到同步更新（不等磁盘）；
2. 影响主进程决策的 store 切片（如 `projects`/`promptRoot`）变更要**立即**落盘，绕过节流；同源 IPC 按序处理可保证先 save 后用。

排查入口：`apps/desktop/src/main/ipc/fs.ts` 的 `assertAllowed`、`packages/core/desktop/usePersonalPersistence.ts` 的 `saveUrgency`。
