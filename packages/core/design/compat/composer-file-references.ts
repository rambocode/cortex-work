// Kun lib/composer-file-references 的裁剪版：design 树仅消费类型。
export type ComposerFileReferenceKind = "file" | "directory";

export type ComposerFileReference = {
  path: string;
  relativePath: string;
  name: string;
  type?: ComposerFileReferenceKind;
  // null 表示显式允许工作区之外的用户手选文件。
  workspaceRoot?: string | null;
};
