import { Elysia } from "elysia";
import { existsSync, mkdirSync } from "fs";
import { basename, extname, join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

export const ATTACHMENTS_DIR = join(homedir(), ".maw", "attachments");

const MAX_BYTES = 10 * 1024 * 1024;
const CODE_EXTS = new Set([
  ".css",
  ".csv",
  ".go",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function ensureAttachmentsDir() {
  if (!existsSync(ATTACHMENTS_DIR)) mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  return ATTACHMENTS_DIR;
}

function safeOriginalName(file: Blob): string {
  return basename((file as any).name || `attachment-${Date.now()}`);
}

function safeExt(name: string, mimeType: string): string {
  const ext = extname(name).toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (ext) return ext;
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType.startsWith("image/")) return `.${mimeType.slice(6).replace(/[^a-z0-9]/g, "") || "img"}`;
  if (mimeType.startsWith("text/")) return ".txt";
  return ".bin";
}

function isAllowed(file: Blob, name: string): boolean {
  const mimeType = file.type || "";
  if (mimeType.startsWith("image/")) return true;
  if (mimeType.startsWith("text/")) return true;
  if (mimeType === "application/pdf") return true;
  if (CODE_EXTS.has(extname(name).toLowerCase())) return true;
  return false;
}

export function attachmentPath(filename: string): string | null {
  const safeName = basename(filename);
  if (!safeName || safeName !== filename) return null;
  return join(ATTACHMENTS_DIR, safeName);
}

export const attachApi = new Elysia();

attachApi.post("/attach", async ({ body, set }) => {
  try {
    const file = (body as any)?.file;
    if (!file || !(file instanceof Blob)) {
      set.status = 400;
      return { ok: false, error: "missing 'file' field — use multipart/form-data field name 'file'" };
    }

    const originalName = safeOriginalName(file);
    const mimeType = file.type || "application/octet-stream";
    if (file.size > MAX_BYTES) {
      set.status = 413;
      return { ok: false, error: `file too large: ${(file.size / 1024 / 1024).toFixed(1)}MB (max 10MB)` };
    }
    if (!isAllowed(file, originalName)) {
      set.status = 415;
      return { ok: false, error: `unsupported file type: ${mimeType || extname(originalName) || "unknown"}` };
    }

    const id = randomUUID();
    const filename = `${id}${safeExt(originalName, mimeType)}`;
    const dest = join(ensureAttachmentsDir(), filename);
    const bytes = Buffer.from(await file.arrayBuffer());
    await Bun.write(dest, bytes);

    return {
      ok: true,
      id,
      url: `/attachments/${filename}`,
      localUrl: `file://${dest}`,
      name: originalName,
      size: bytes.length,
      mimeType,
    };
  } catch (err) {
    set.status = 500;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

