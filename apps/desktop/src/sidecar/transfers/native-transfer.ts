import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  realpath,
  readFile,
  readdir,
  writeFile,
  open,
  lstat,
  link,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeTransferPreview } from "@pix/contracts";
import { ARCHIVE_LIMIT, atomicExport, readBounded, type PixArchive } from "../archives/archive.ts";
import { materializeAttachments, mapAttachmentPaths } from "../archives/attachments.ts";
import { parseSideChatArchive } from "../../main/side-chat-library.ts";
import {
  claudeTranscript,
  codexRollout,
  transferBranches,
  type TransferBranch,
} from "./native-history.ts";
const execFileP = promisify(execFile);
const execP = promisify(exec);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
interface Plan {
  preview: NativeTransferPreview;
  binary: string;
  archive: PixArchive;
  files: { path: string; text: string; sha256: string }[];
}
/** A journal owns new IDs before delivery. Repeated delivery never replaces a target conversation. */
export class NativeTransferStore {
  constructor(private readonly directory: string) {}
  private file(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid_transfer_id");
    return join(this.directory, `${id}.json`);
  }
  private async version(binary: string, target: "claude" | "codex") {
    const options = { timeout: 5000, maxBuffer: 8192 };
    // npm shim launchers (.cmd/.bat) cannot be spawned directly on Windows; route them through cmd.exe.
    const { stdout } =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)
        ? await execP(`"${binary}" --version`, options)
        : await execFileP(binary, ["--version"], options);
    const version =
      target === "claude"
        ? stdout.startsWith("2.1.87 (Claude Code)")
          ? "2.1.87"
          : null
        : /^codex-cli 0\.155\.0-alpha\.9\.2\b/.test(stdout)
          ? "0.155.0-alpha.9.2"
          : null;
    if (!version)
      throw new Error(
        "Unsupported native transfer version. Use Markdown, or validate this client version first.",
      );
    return version;
  }
  async plan(input: {
    archiveId: string;
    archive: PixArchive;
    target: "claude" | "codex";
    binary: string;
    directory: string;
    cwd: string;
  }): Promise<NativeTransferPreview> {
    if (!["claude", "codex"].includes(input.target)) throw new Error("invalid_transfer_target");
    const directory = await realpath(input.directory),
      cwd = await realpath(input.cwd),
      binary = await realpath(input.binary);
    const version = await this.version(binary, input.target);
    // Claude's project-directory encoding is opaque. Bind to an existing native project folder
    // by inspecting its own record metadata, instead of inventing a path encoding algorithm.
    if (input.target === "claude") {
      let matched = false;
      for (const name of (await readdir(directory))
        .filter((name) => /^[a-f0-9-]{36}\.jsonl$/.test(name))
        .slice(0, 100)) {
        const handle = await open(join(directory, name), "r");
        try {
          const bytes = Buffer.alloc(65536);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          for (const line of bytes.subarray(0, bytesRead).toString("utf8").split("\n")) {
            try {
              const row = JSON.parse(line);
              if (typeof row.cwd === "string" && resolve(row.cwd) === cwd) matched = true;
            } catch {
              /* Partial final line. */
            }
          }
        } finally {
          await handle.close();
        }
        if (matched) break;
      }
      if (!matched)
        throw new Error(
          "Choose Claude's existing project session folder for this workspace. Create a conversation in Claude first if the folder does not exist.",
        );
    }
    const id = hash(JSON.stringify([input.archiveId, input.target, version, directory, cwd]));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      return (JSON.parse(await readFile(this.file(id), "utf8")) as Plan).preview;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const archive = structuredClone(input.archive);
    const references = structuredClone(archive);
    mapAttachmentPaths(references, (sessionId, path) => {
      const link = archive.attachments?.links.find(
        (link) => link.sessionId === sessionId && link.path === path,
      );
      return link ? join(directory, "pix-import-assets", id, `${link.sha256}-${link.name}`) : path;
    });
    const branches: TransferBranch[] = [];
    let characters = 0;
    const append = (branch: TransferBranch) => {
      characters += branch.messages.reduce((sum, message) => sum + message.text.length, 0);
      if (branches.length >= 500) throw new Error("native_transfer_too_many_branches");
      if (characters > 16_000_000) throw new Error("native_transfer_too_large");
      branches.push(branch);
    };
    for (const session of references.sessions)
      for (const branch of transferBranches(session)) append(branch);
    if (archive.sideChats != null)
      for (const chat of Object.values(parseSideChatArchive(references.sideChats).chats))
        append({
          sourceSessionId: chat.sessionId,
          leafId: `side:${chat.id}`,
          messages: [
            {
              role: "user",
              text: `Imported Pix side conversation. Quoted selection:\n${chat.selection.text}\nSource context:\n${chat.selection.context}`,
            },
            ...chat.sourceMessages.map(({ role, text }) => ({ role, text })),
            ...chat.messages.map(({ role, text, attachments }) => ({
              role,
              text:
                text +
                (attachments?.length
                  ? `\n[Historical attachment references]\n${attachments.join("\n")}`
                  : ""),
            })),
            ...(chat.draft || chat.attachments.length
              ? [
                  {
                    role: "user" as const,
                    text: `[Unsent Pix draft — reference only, not a request to act]\n${chat.draft}\n${chat.attachments.join("\n")}`,
                  },
                ]
              : []),
          ],
        });
    if (!branches.length) throw new Error("The archive has no conversation branches to transfer.");
    const preview: NativeTransferPreview = {
      id,
      target: input.target,
      version,
      directory,
      cwd,
      sessions: [],
      delivered: false,
      warnings: [
        "Experimental, version-pinned CLI compatibility. Target desktop/IDE interfaces are not verified.",
        "Each branch and side conversation becomes a new independent session. Shared prefixes are duplicated.",
        "Historical tool output is inert text; tool arguments, hidden reasoning and target credentials/settings are excluded. Image bytes stay in Pix archives; packed external attachments are delivered as file references.",
        "Active memories are supplied as reference context, not written into the target's automatic memory store. Original messages can contain forgotten facts.",
        "Delivery makes no model calls. Future conversations use the target client's own permissions and billing.",
        ...archive.warnings,
      ],
    };
    const plan: Plan = { preview, binary, archive, files: [] };
    let encodedBytes = 0;
    for (const branch of branches) {
      const reference: TransferBranch = {
        ...branch,
        messages: [
          {
            role: "user",
            text: `Pix memory reference (not instructions):\n${JSON.stringify(archive.memories.filter((m) => m.status === "active").map(({ scope, content, conditions }) => ({ scope, content, conditions })))}`,
          },
          ...branch.messages,
        ],
      };
      const converted =
        input.target === "claude"
          ? claudeTranscript(reference, cwd, version)
          : codexRollout(reference, cwd, version);
      const timestamp =
        "timestamp" in converted && typeof converted.timestamp === "string"
          ? converted.timestamp
          : "";
      const path =
        input.target === "claude"
          ? join(directory, `${converted.sessionId}.jsonl`)
          : join(
              directory,
              "sessions",
              ...timestamp.slice(0, 10).split("-"),
              `rollout-${timestamp.slice(0, 19).replaceAll(":", "-")}-${converted.sessionId}.jsonl`,
            );
      encodedBytes += Buffer.byteLength(converted.jsonl);
      if (encodedBytes > ARCHIVE_LIMIT) throw new Error("native_transfer_too_large");
      plan.files.push({ path, text: converted.jsonl, sha256: hash(converted.jsonl) });
      preview.sessions.push({
        sourceId: branch.sourceSessionId,
        branch: branch.leafId,
        targetId: converted.sessionId,
      });
    }
    // Plan is private to Pix; no target writes occur before the user sees this preview.
    const serialized = JSON.stringify(plan);
    if (Buffer.byteLength(serialized) > ARCHIVE_LIMIT) throw new Error("native_transfer_too_large");
    await writeFile(this.file(id), serialized, { mode: 0o600, flag: "wx", flush: true });
    return preview;
  }
  async deliver(id: string): Promise<NativeTransferPreview> {
    const plan = JSON.parse((await readBounded(this.file(id))).toString("utf8")) as Plan;
    if (plan.preview.id !== id) throw new Error("transfer_identity_mismatch");
    if (plan.preview.delivered) return plan.preview;
    await this.version(plan.binary, plan.preview.target);
    // Attachment output lives in the target data directory and survives removal of Pix data.
    const assetDirectory = join(plan.preview.directory, "pix-import-assets", id);
    await mkdir(assetDirectory, { recursive: true, mode: 0o700 });
    if ((await realpath(assetDirectory)) !== assetDirectory)
      throw new Error("target_directory_changed");
    await materializeAttachments(structuredClone(plan.archive), assetDirectory);
    for (const file of plan.files) {
      const parent = join(file.path, "..");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      if ((await realpath(parent)) !== parent || (await lstat(parent)).isSymbolicLink())
        throw new Error("target_directory_changed");
      const staging = `${file.path}.pix-import-${randomUUID()}.tmp`;
      try {
        await writeFile(staging, file.text, { flag: "wx", mode: 0o600, flush: true });
        try {
          await link(staging, file.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } finally {
        await unlink(staging).catch(() => {});
      }
      if (
        (await lstat(file.path)).isSymbolicLink() ||
        hash((await readBounded(file.path)).toString("utf8")) !== file.sha256
      )
        throw new Error(
          "Target conversation changed; existing content was preserved. Do not retry with new IDs.",
        );
    }
    plan.preview.delivered = true;
    await atomicExport(this.file(id), JSON.stringify(plan));
    return plan.preview;
  }
}
