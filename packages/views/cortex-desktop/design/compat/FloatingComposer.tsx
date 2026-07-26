// Kun chat/FloatingComposer(2596 行)的最小替身：只保留「输入 + 发送 / 停止」核心闭环，
// 让设计工作台的对话回路先能用。模型选择/附件/上下文 chip 等富功能按计划(批5+)
// 逐步换成 cortex 的 ComposerShell 正式接线,本组件届时整体退役。
// Props 用「显式核心字段 + 开放索引」:Kun 调用点传的 30+ 个 props 不必逐一声明。
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, Paperclip, X } from "lucide-react";
import type { DesignComposerContext } from "@cortex-work/core/design/design-composer-context";

export type { DesignComposerContext };

/** 待发图片(尚未落盘)。dataUrl 仅供本地缩略图预览,不参与投递。 */
export type ComposerPendingImage = {
  id: string;
  name: string;
  mimeType: string;
  data: ArrayBuffer;
  dataUrl: string;
};

export type ComposerPendingTextFile = {
  id: string;
  name: string;
  sizeBytes: number;
  content: string;
  truncated?: boolean;
};

type FloatingComposerProps = {
  input: string;
  setInput: (value: string) => void;
  busy?: boolean;
  onSend?: () => void;
  onInterrupt?: () => void;
  /** 占位文案(缺省为设计需求;slides 传演示主题口径)。 */
  placeholder?: string;
  /** 待发图片;传入即启用图片入口(粘贴 / 选取)。 */
  images?: ComposerPendingImage[];
  onAddImages?: (files: File[]) => void;
  onRemoveImage?: (id: string) => void;
  /** 待发纯文本文件；扩展名与大小校验由宿主负责。 */
  textFiles?: ComposerPendingTextFile[];
  textFileAccept?: string;
  onAddTextFiles?: (files: File[]) => void;
  onRemoveTextFile?: (id: string) => void;
} & Record<string, unknown>;

export function FloatingComposer(props: FloatingComposerProps) {
  const { t } = useTranslation("design");
  const {
    input,
    setInput,
    busy,
    onSend,
    onInterrupt,
    placeholder,
    images,
    onAddImages,
    onRemoveImage,
    textFiles,
    textFileAccept,
    onAddTextFiles,
    onRemoveTextFile,
  } = props;
  const imageFileRef = useRef<HTMLInputElement>(null);
  const textFileRef = useRef<HTMLInputElement>(null);
  const imagesEnabled = typeof onAddImages === "function";
  const filesEnabled = typeof onAddTextFiles === "function";
  const pending = images ?? [];
  const pendingTextFiles = textFiles ?? [];
  // 有图时允许「只发图不打字」——一张截图配一句「照这个改」很常见,但只发图也说得通。
  const canSend =
    !busy && (input.trim().length > 0 || pending.length > 0 || pendingTextFiles.length > 0);

  /** 一次遍历把图片和其他文件分流；文本 allowlist 校验归宿主。 */
  const takeFiles = (list: FileList | File[] | null | undefined): void => {
    if (!list) return;
    const imageFiles: File[] = [];
    const otherFiles: File[] = [];
    for (const file of Array.from(list)) {
      if (file.type.startsWith("image/")) imageFiles.push(file);
      else otherFiles.push(file);
    }
    if (imageFiles.length && onAddImages) onAddImages(imageFiles);
    if (otherFiles.length && onAddTextFiles) onAddTextFiles(otherFiles);
  };
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-black/10 bg-white/70 p-2 dark:border-white/10 dark:bg-black/20"
      onDragOver={imagesEnabled || filesEnabled ? (e) => e.preventDefault() : undefined}
      onDrop={
        imagesEnabled || filesEnabled
          ? (e) => {
              e.preventDefault();
              takeFiles(e.dataTransfer?.files);
            }
          : undefined
      }
    >
      {pending.length ? (
        <div className="flex flex-wrap gap-1.5 px-0.5" data-testid="composer-images">
          {pending.map((img) => (
            <div key={img.id} className="relative">
              <img
                src={img.dataUrl}
                alt={img.name}
                className="h-14 w-14 rounded-md border border-black/10 object-cover dark:border-white/15"
              />
              {onRemoveImage ? (
                <button
                  type="button"
                  onClick={() => onRemoveImage(img.id)}
                  className="absolute -right-1.5 -top-1.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-black/70 text-white transition hover:bg-black"
                  title={t("composerImageRemove", { defaultValue: "移除图片" })}
                  aria-label={`${t("composerImageRemove", { defaultValue: "移除图片" })}: ${img.name}`}
                >
                  <X className="h-2.5 w-2.5" strokeWidth={2.4} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {pendingTextFiles.length ? (
        <div className="flex flex-wrap gap-1.5 px-0.5" data-testid="composer-text-files">
          {pendingTextFiles.map((file) => (
            <div
              key={file.id}
              className="flex max-w-full items-center gap-1 rounded-md border border-black/10 bg-black/5 px-2 py-1 text-xs dark:border-white/15 dark:bg-white/8"
            >
              <Paperclip className="h-3 w-3 shrink-0" strokeWidth={1.8} />
              <span className="min-w-0 truncate">
                {file.name}
                {file.truncated ? "（已截断）" : ""}
              </span>
              {onRemoveTextFile ? (
                <button
                  type="button"
                  onClick={() => onRemoveTextFile(file.id)}
                  title={`${t("composerFileRemove", { defaultValue: "移除文件" })}: ${file.name}`}
                  aria-label={`${t("composerFileRemove", { defaultValue: "移除文件" })}: ${file.name}`}
                >
                  <X className="h-3 w-3" strokeWidth={2} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <textarea
        className="min-h-[72px] w-full resize-none bg-transparent px-1 py-0.5 text-sm outline-hidden"
        value={input}
        placeholder={placeholder ?? t("composerPlaceholder", { defaultValue: "描述你的设计需求…" })}
        onChange={(e) => setInput(e.target.value)}
        // 截图直接 ⌘V 是最常用的入口(用户拿设计稿/报错截图来问)。
        onPaste={imagesEnabled || filesEnabled ? (e) => takeFiles(e.clipboardData?.files) : undefined}
        onKeyDown={(e) => {
          // Enter 发送、Shift+Enter 换行（与个人工作区 composer 习惯一致）。
          if (e.key === "Enter" && !e.shiftKey && canSend) {
            e.preventDefault();
            onSend?.();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        {imagesEnabled || filesEnabled ? (
          <div className="mr-auto flex items-center gap-1">
            {imagesEnabled ? (
              <>
            <input
              ref={imageFileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                takeFiles(e.target.files);
                e.target.value = ""; // 允许连选同一张
              }}
            />
            <button
              type="button"
              className="rounded-md p-1.5 text-black/45 transition hover:bg-black/5 hover:text-black/70 dark:text-white/45 dark:hover:bg-white/10 dark:hover:text-white/80"
              onClick={() => imageFileRef.current?.click()}
              title={t("composerImageAdd", { defaultValue: "添加图片(也可直接粘贴或拖入)" })}
              aria-label={t("composerImageAdd", { defaultValue: "添加图片(也可直接粘贴或拖入)" })}
            >
              <ImagePlus className="h-4 w-4" strokeWidth={1.8} />
            </button>
              </>
            ) : null}
            {filesEnabled ? (
              <>
                <input
                  ref={textFileRef}
                  type="file"
                  accept={textFileAccept}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    takeFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="rounded-md p-1.5 text-black/45 transition hover:bg-black/5 hover:text-black/70 dark:text-white/45 dark:hover:bg-white/10 dark:hover:text-white/80"
                  onClick={() => textFileRef.current?.click()}
                  title={t("composerFileAdd", { defaultValue: "添加文件(也可直接粘贴或拖入)" })}
                  aria-label={t("composerFileAdd", { defaultValue: "添加文件(也可直接粘贴或拖入)" })}
                >
                  <Paperclip className="h-4 w-4" strokeWidth={1.8} />
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {busy ? (
          <button
            type="button"
            className="rounded-md border border-black/10 px-3 py-1 text-xs dark:border-white/15"
            onClick={() => onInterrupt?.()}
          >
            {t("composerStop", { defaultValue: "停止" })}
          </button>
        ) : (
          <button
            type="button"
            className="rounded-md bg-black px-3 py-1 text-xs text-white disabled:opacity-40 dark:bg-white dark:text-black"
            disabled={!canSend}
            onClick={() => onSend?.()}
          >
            {t("composerSend", { defaultValue: "发送" })}
          </button>
        )}
      </div>
    </div>
  );
}
