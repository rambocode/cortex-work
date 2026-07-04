// Kun lib/image-attachment-upload 的裁剪版：design 树仅消费类型。
import type { CoreAttachmentTextFallbackJson } from "./kun-contract";

// 已准备好上传的图片附件（base64 数据 + 文本兜底描述）。
export type PreparedImageAttachmentUpload = {
  dataBase64: string;
  mimeType: string;
  textFallback: CoreAttachmentTextFallbackJson;
};
