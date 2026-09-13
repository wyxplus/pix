import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export async function loadPromptImages(paths: string[], allowedRoots: string[]) {
  if (!Array.isArray(paths) || paths.length > 12) throw new Error("Invalid image attachments");
  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  const types: Record<string, string> = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return Promise.all(
    paths.map(async (path) => {
      const canonical = await realpath(resolve(allowedRoots[0] ?? process.cwd(), path));
      const allowed = roots.some((root) => {
        const rel = relative(root, canonical);
        return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
      });
      if (!allowed) throw new Error("Prompt image is outside the authorized directories");
      const mimeType = types[extname(canonical).toLowerCase()];
      if (!mimeType) throw new Error(`Unsupported prompt image type: ${path}`);
      const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > 12_000_000)
          throw new Error("Invalid or oversized prompt image");
        const bytes = await file.readFile();
        if (!bytes.length || bytes.length > 12_000_000)
          throw new Error("Invalid or oversized prompt image");
        return { type: "image" as const, data: bytes.toString("base64"), mimeType };
      } finally {
        await file.close();
      }
    }),
  );
}

export function promptImageRoots(cwd: string): string[] {
  return [cwd, ...(process.env.PIX_ATTACHMENT_DIR ? [process.env.PIX_ATTACHMENT_DIR] : [])];
}
