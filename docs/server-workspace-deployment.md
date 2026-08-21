# 服务器工作区：内网执行节点部署指南

> 适用：`feat/team-server-workspace`（前端）+ `../server` 的 `feat/server-workspace`（后端）。
> 目标：在团队内部服务器上部署一个常驻 agent 执行节点（`multica daemon`），全体成员即可在
> 桌面端选择该服务器上的「服务器工作区」（共享或独立）进行工作。

## 架构一图流

```
桌面端 (cortex-work)                     后端 API (server)                 内网执行节点
┌──────────────────┐   HTTPS/WSS   ┌─────────────────────┐   HTTPS/WS   ┌──────────────────────┐
│ 登录 → 选工作区   │ ───────────▶ │ /api/server-workspaces│ ◀────────── │ multica daemon        │
│ 发消息(invoke)    │              │ agent_task_queue      │  claim/回报  │  ├ serverws reconcile │
│ WS 流式渲染/排队  │ ◀─────────── │ /ws 事件+流式帧        │             │  ├ 持久 checkout       │
└──────────────────┘              └─────────────────────┘             │  └ claude/codex CLI    │
                                                                       └──────────────────────┘
```

- **共享工作区**：`{root}/{workspaceID}/{swID}/shared/` 单一 checkout，全队任务按 instance 串行排队。
- **独立工作区**：`{root}/{workspaceID}/{swID}/members/{userID}/` 每成员一份 worktree，互不阻塞。
- 所有 checkout 与 repocache 的 bare clone 共享 git objects，磁盘只多付 checkout 部分。

## 前置条件

- 后端 API 已部署（`../server` 的 docker-compose：postgres + redis + backend）。
- 一台内网服务器（Linux/macOS），能访问后端 API 与团队 git 仓库。
- 服务器上安装要用的 agent CLI（`claude` / `codex` 等）并完成登录/配置 API key。
- git 凭据（SSH key 或 credential helper）装在服务账号 HOME 下，能 clone 团队仓库。

## 第 1 步：签发凭据（PAT → daemon token，全部现有流程）

1. 在团队 workspace 里准备一个**服务账号成员**（建议专职 admin，如 `agent-node@team`，
   邮箱验证码登录一次即可）。
2. 用该账号在桌面端/API 签发 Personal Access Token（`mul_` 前缀）。
3. daemon 首次以该 PAT 调 `POST /api/daemon/register`（`multica daemon` 启动时自动做，
   带 `want_token=true`）→ 换取 `mdt_` daemon token（30 天有效，每次注册自动轮换，无需人工续期）。

## 第 2 步：systemd 常驻（裸机推荐）

`/etc/systemd/system/multica.service`：

```ini
[Unit]
Description=Cortex multica agent daemon (server workspaces)
After=network-online.target
Wants=network-online.target

[Service]
User=multica
# multica 二进制来自后端仓库构建：go build ./cmd/multica（或复用 Docker 镜像内产物）
ExecStart=/usr/local/bin/multica daemon
Restart=always
RestartSec=5
Environment=MULTICA_SERVER_URL=https://cortex.internal.example.com
Environment=MULTICA_TOKEN=mul_xxxxxxxxxxxxxxxx
Environment=MULTICA_SERVER_WORKSPACES_ROOT=/var/lib/multica/server_workspaces
# agent CLI 与 git 凭据都装在 multica 服务账号 HOME 下
WorkingDirectory=/var/lib/multica

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -m -d /var/lib/multica multica
sudo -u multica claude login          # 或配置 API key / codex 凭据
sudo systemctl enable --now multica
journalctl -u multica -f              # 观察 register / heartbeat / reconcile 日志
```

## 第 3 步（可选）：docker-compose 方式

在后端 compose 里加一个 `agent-node` 服务（镜像已产出 multica 二进制）：

```yaml
  agent-node:
    image: <同 backend 镜像>
    command: ./multica daemon
    environment:
      MULTICA_SERVER_URL: http://backend:8080
      MULTICA_TOKEN: mul_xxxxxxxxxxxxxxxx
      MULTICA_SERVER_WORKSPACES_ROOT: /var/lib/multica/server_workspaces
    volumes:
      - multica_node_data:/var/lib/multica   # bare cache + server workspaces + execenv 同盘
```

注意：容器内需自备 agent CLI 与 git 凭据；server workspace 数据在 volume，容器重建不丢。

## 第 4 步：验证

1. 桌面端登录团队 → 设置 → Runtimes：应出现该服务器（在线绿点）。
2. 新建一个「共享」工作区（填 repo url）→ 状态从「准备中（clone）」变「就绪」。
3. 在通讯录选一个分身 → Composer 上方 pill 选中该工作区 → 发一条消息 →
   流式回复正常；第二人同时发 → 显示「排队中 · 前方 1 个任务」，前一任务结束后自动接续。

## 运维要点

- **token 轮换**：`mdt_` 每次 register 自动轮换；吊销 = 删除服务账号 PAT + daemon token。
- **磁盘布局**：`MULTICA_SERVER_WORKSPACES_ROOT` 默认在 execenv WorkspacesRoot 同级的
  `_server` 兄弟目录，天然不受任务临时目录 GC 清扫。
- **删除工作区**：当前版本删除只清服务端记录与在途任务，daemon 磁盘目录暂不回收
  （遗留项），需要时手动清理对应 `{swID}` 目录。
- **升级**：daemon 与 server 同仓发版；老版本 daemon 不认识 `server_workspace_session`
  任务，新工作区只应建在已升级的 daemon 节点上。
