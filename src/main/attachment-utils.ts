import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const IMG_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

export interface Attachment {
  abs: string;
  name: string;
}

/**
 * Convert composer attachments into prompt pieces. Images are passed through
 * as base64 (the only way the model can see them); every other attachment is a
 * path-only reference — content is never inlined into the prompt, the agent
 * reads the file itself with its tools.
 */
export function processAttachments(attachments: Attachment[] | undefined, text: string): { text: string; images: unknown[] } {
  const images: unknown[] = [];
  let extra = "";
  if (attachments && attachments.length) {
    for (const a of attachments) {
      const ext = extname(a.name || a.abs).toLowerCase();
      try {
        if (ext in IMG_MIME) {
          const buf = readFileSync(a.abs);
          images.push({ type: "image", data: buf.toString("base64"), mimeType: IMG_MIME[ext] });
          continue;
        }
        if (statSync(a.abs).isDirectory()) {
          extra += `\n\n<folder name="${a.name}" path="${a.abs}" />`;
        } else {
          extra += `\n\n<file name="${a.name}" path="${a.abs}" />`;
        }
      } catch (e: any) {
        extra += `\n\n<file name="${a.name}" error="${e?.message || "read failed"}" />`;
      }
    }
  }
  return { text: text + extra, images };
}
