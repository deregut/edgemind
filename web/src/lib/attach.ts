import type { Part } from "@edgemind/shared";
import { fileToBase64, isTextFile, type AttachFn } from "@/components/chat/Composer";
import { uploadFile } from "./upload";

const KB = 1024;
const MB = 1024 * KB;

/**
 * Attachment → message part.
 *  - small images (≤ 4 MB) and small text files (≤ 256 KB) go inline;
 *  - everything else is uploaded browser-direct to S3 and referenced by `fileId`
 *    (the agent loop resolves it: text inline, images/PDF as base64 for capable models).
 */
export function makeAttach(ctx: () => { conversationId: string | null; projectId: string | null }): AttachFn {
  return async (file: File, onProgress?: (f: number) => void): Promise<Part> => {
    const mime = file.type || (isTextFile(file) ? "text/plain" : "application/octet-stream");
    if (mime.startsWith("image/") && file.size <= 4 * MB) return { type: "image", mime, data: await fileToBase64(file) };
    if (isTextFile(file) && file.size <= 256 * KB) return { type: "file", name: file.name, mime, text: await file.text() };
    const { conversationId, projectId } = ctx();
    const f = await uploadFile(file, { scope: "upload", conversationId, projectId }, onProgress);
    return { type: "file", fileId: f.id, name: file.name, mime };
  };
}
