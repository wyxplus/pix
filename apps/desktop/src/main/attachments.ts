import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";

const EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
export const MAX_ATTACHMENT_BYTES = 12_000_000;

export class AttachmentStore {
  readonly directory: string;
  constructor(
    tempRoot = tmpdir(),
    private readonly persistent = false,
  ) {
    if (persistent) mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(
      persistent ? tempRoot : mkdtempSync(join(tempRoot, "pix-attachments-")),
    );
    chmodSync(this.directory, 0o700);
  }

  save(bytes: number[] | Buffer, extension = "png"): string {
    const ext = extension.trim().replace(/^\./, "").toLowerCase();
    if (!EXTENSIONS.has(ext)) throw new Error("Unsupported clipboard image extension");
    if (
      !bytes.length ||
      bytes.length > MAX_ATTACHMENT_BYTES ||
      (!Buffer.isBuffer(bytes) && !bytes.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
    )
      throw new Error("Invalid or oversized clipboard image");
    const path = join(this.directory, `${randomUUID()}.${ext}`);
    writeFileSync(path, Buffer.from(bytes), { flag: "wx", mode: 0o600 });
    return path;
  }

  /** Snapshot an already authorized image so later symlink changes cannot redirect the host. */
  copy(path: string): string {
    if (statSync(path).size > MAX_ATTACHMENT_BYTES) throw new Error("Image is too large");
    return this.save(readFileSync(path), extname(path));
  }

  dispose(): void {
    if (!this.persistent) rmSync(this.directory, { recursive: true, force: true });
  }
}
