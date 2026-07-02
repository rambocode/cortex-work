// 任务附件落盘/删除的纯函数（U13）——**复用**聊天文档附件闸门（doc.ts），只换存储根 + 引用形状。
// 核心逻辑接收 root/dir 入参（不内部调 taskDocsRoot），可在临时目录单测；主进程入口（ipc/tasks.ts）
// 注入 paths.taskDocsRoot()/taskDocsDir() 并把 electron 绑定（ipcMain.handle / store 写回 / broadcast）
// 裹在外层。
//
// 安全要点（全部沿用 doc.ts，勿另造）：
//  - 写侧：saveDocInto 已做扩展名 allowlist（extToDocExt，仅 pdf/docx/xlsx/pptx/csv/txt/md，图片被拒）
//    + magic-bytes 复核 + 50MB 上限 + randomUUID 文件名（原始名不参与路径）+ 目录 0700 + 原子 tmp→rename。
//  - 删侧：assertDocPath 做 realpath + lstat 拒符号链接 + 严格根边界 + 扩展名 allowlist，只删「校验后的
//    真实路径」（消除 TOCTOU）；**绝不裸删任意入参路径**。task-docs 根同 chat-docs，不入 allowedRoots()。

import { promises as fsp } from "fs";
import { saveDocInto, assertDocPath } from "./doc";
import type { DocSaveResult, TaskAttachment } from "./types";

// 保存一个任务附件：root = task-docs 根，taskId 作子目录（saveDocInto 内部 join(root, taskId)，
// 与 taskDocsDir(taskId) 一致）。返回写回 TaskMeta.attachments 的引用（sizeBytes 取磁盘真实字节数）。
export async function saveTaskDoc(
  root: string,
  taskId: string,
  file: { name: string; mimeType: string; srcPath?: string; data?: ArrayBuffer },
): Promise<TaskAttachment> {
  const res: DocSaveResult = await saveDocInto(root, taskId, file.name, {
    srcPath: file.srcPath,
    data: file.data,
  });
  return { path: res.path, name: file.name, mimeType: file.mimeType, sizeBytes: res.sizeBytes };
}

// 删除一个任务附件的磁盘文件：dir = taskDocsDir(taskId)，requested = 待删的落盘 path。
// 先经 assertDocPath 校验（越界 / 符号链接 / 非文档扩展名 → 抛「路径不在允许范围内」等），
// 再 unlink 校验后的真实路径。文件已不存在（ENOENT）由 assertDocPath 抛出，调用方据 code 放行清引用。
export async function deleteTaskDoc(dir: string, requested: string): Promise<void> {
  const real = await assertDocPath(dir, requested);
  await fsp.unlink(real);
}
