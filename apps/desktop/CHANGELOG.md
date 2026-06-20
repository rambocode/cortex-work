<!--
  Cortex Desktop 更新日志（应用内「更新内容」来源）。
  发布前由 scripts/extract-release-notes.mjs 按 package.json 的 version 提取当前版本段,
  写入 build/release-notes.md → electron-updater 清单 latest-mac.yml + GitHub Release 页面。

  标题格式契约（脚本正则与此绑定）：版本段标题须匹配 `^## \[?<version>\]?`,
  <version> 为 package.json 裸版本号（无 v 前缀）。允许三种写法：
    ## [0.1.9] - 2026-07-01
    ## 0.1.9
    ## [0.1.9]
  正文写到下一个 `## ` 版本段为止。发版时在顶部新增对应版本段。
-->

# 更新日志

## [0.1.8]

- 更新流程改为用户主导：发现新版本时仅在标题栏提示，点击查看更新内容后再手动下载。
- 新增更新内容弹窗，展示版本号与本次更新说明。
