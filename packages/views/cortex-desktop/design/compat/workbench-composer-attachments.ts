// Kun workbench-composer-attachments 的类型垫层：design 树只消费 scope 与 updater 类型。
import type { AttachmentReference } from "@cortex-work/core/design/compat/agent-types";

export const COMPOSER_ATTACHMENT_SCOPES = ["chat", "write", "design", "sdd", "inactive"] as const;

export type ComposerAttachmentScope = (typeof COMPOSER_ATTACHMENT_SCOPES)[number];
export type ComposerAttachmentsByScope = Record<ComposerAttachmentScope, AttachmentReference[]>;
export type ComposerAttachmentUpdater =
  | AttachmentReference[]
  | ((current: AttachmentReference[]) => AttachmentReference[]);
