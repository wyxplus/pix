# Desktop security boundaries

The main renderer calls a fixed set of Sidecar RPC handlers through Rust. This is
not an agent sandbox: the terminal, session bash and agent tools intentionally
execute with the user's local privileges. Preventing renderer script injection
remains essential.

Paths supplied over IPC do not create grants. Workspaces are authorized from
persisted backend state, backend-created worktrees, the native folder picker or
OS drag-and-drop events recorded by Rust. Paths are canonicalized before checking
directory containment, including existing parents of new output files. Session
files must also refer to an authorized workspace; imports into another workspace
require selecting that workspace in the native dialog. Pending session paths are
accepted only when returned by the agent host.

Images may be read from the active workspace or an explicitly selected attachment.
Before a prompt, approved images are copied into a private, randomly named
attachment directory. The host separately checks its allowed image directories.
Clipboard files use a fixed extension allowlist, random names, exclusive creation,
private permissions and a size limit. Graceful shutdown removes temporary copies.

Content links cannot launch applications or executable file types. Source files
open through an explicit editor. VS Code and Cursor support line and column
locations; without a supported editor, a location request reports an error instead
of silently dropping the location. Plain text falls back to TextEdit, Notepad or
gedit. Passive media uses the system viewer, with a second file-type check in Rust.
Remote Markdown images are explicit links and are not automatically loaded; CSP
also blocks HTTPS image loads. Inline styles remain necessary for existing UI and
math rendering; script restrictions and Markdown sanitization remain enabled.

Windows editor launch paths never pass through `cmd.exe`. Editor shims are
resolved to executables. macOS terminal commands quote both the shell argument and
the containing AppleScript string. Branch switches use `git switch` with explicit
ref validation and never reset an existing branch as an error fallback.

Python runtime SHA-256 pins live in `apps/desktop/runtimes/versions.json`. The
20260807 pins were obtained from the asset digests in the
[official release API](https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/20260807).
When changing Python versions, review and update every platform digest. Cached and
new archives must match before extraction or execution. Node and npm still belong
to the trusted build toolchain; npm is copied from the Node distribution used to
build the app. Updater initialization requires both a public key and an explicit
HTTPS endpoint; Tauri still verifies update signatures.

Regression coverage includes temporary real Git repositories, AppleScript string
round-trips on macOS, filesystem traversal and symlink fixtures, simulated Windows
process arguments, Rust native guards, and Sidecar IPC tests with a local fake model
server. Windows process behavior still requires validation on a Windows host.
