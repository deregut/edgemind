import type { Part } from "@edgemind/shared";
import { fileToBase64, isTextFile, type AttachFn } from "@/components/chat/Composer";

const MB = 1024 * 1024;

/** Attachment → message part. Images go inline (vision); text files inline as text; PDFs inline base64. */
export function makeAttach(_ctx: () => { conversationId: string | null; projectId: string | null }): AttachFn {
  return async (file: File): Promise<Part> => {
    const mime = file.type || "application/octet-stream";
    if (mime.startsWith("image/")) {
      if (file.size > 8 * MB) throw new Error("圖片超過 8 MB");
      return { type: "image", mime, data: await fileToBase64(file) };
    }
    if (isTextFile(file)) {
      if (file.size > 2 * MB) throw new Error("文字檔超過 2 MB");
      return { type: "file", name: file.name, mime: mime === "application/octet-stream" ? "text/plain" : mime, text: await file.text() };
    }
    if (mime === "application/pdf") {
      if (file.size > 10 * MB) throw new Error("PDF 超過 10 MB");
      return { type: "file", name: file.name, mime, data: await fileToBase64(file) };
    }
    throw new Error("不支援的檔案類型");
  };
}
