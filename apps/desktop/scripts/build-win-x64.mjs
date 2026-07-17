#!/usr/bin/env node
// 跨平台启动 Windows x64 打包。不能在 package.json 使用
// `CSC_IDENTITY_AUTO_DISCOVERY=false command`：Windows npm scripts 由 cmd.exe 执行，
// 不支持 POSIX 环境变量前缀。改由 Node 注入环境并直接执行 electron-builder CLI。

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronBuilderCli = require.resolve("electron-builder/cli.js");

execFileSync(
  process.execPath,
  [electronBuilderCli, "--win", "--x64", "--publish", "never"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
  },
);
