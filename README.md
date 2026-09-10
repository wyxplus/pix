# Pix

Pix is a desktop shell for the [pi](https://pi.dev) coding agent. The desktop app now uses **Tauri 2 + a bundled Node Agent Sidecar**, with the existing React interface and pi business logic.

## Architecture

```text
React / existing window.pix API
  → Tauri IPC (Rust window, dialogs, notifications, clipboard, updater)
  → supervised Node Sidecar (versioned JSON messages over stdin/stdout)
  → Node Agent Host processes (standard child_process IPC)
  → @earendil-works/pi-coding-agent SDK
```

The renderer has no Node access. The sidecar owns workspace/Git/worktree operations, desktop preferences, themes, SDK selection, managed runtimes and PTYs. Each foreground or parked agent keeps its own Node process; switching conversations preserves background generation. The Rust shell starts the sidecar, forwards requests/events, rejects pending requests on failure, and stops it on application exit. No local HTTP server is used for production IPC.

pi configuration, models, credentials, packages, extensions, tools and sessions continue to use `~/.pi/agent` / `PI_CODING_AGENT_DIR`. Pix does not add a second agent configuration layer. Extensions and tools have the same local access as the pi CLI; process isolation is not a sandbox.

Pix uses pi SDK 0.85.1. On Windows, sessions default to `read`, `powershell`, `edit`, `write`, `ls`, `find`, and `grep`. The native PowerShell tool prefers `pwsh.exe` on PATH and falls back to `powershell.exe`; Git Bash is not required for model-driven PowerShell commands. Explicit pi `defaultTools` settings and tool restrictions take precedence, and extension tools remain enabled by default. These platform defaults are not written to the user's settings. macOS/Linux retain pi's defaults. Manual `!`/`!!` commands still use Bash.

See [Windows usage](WINDOWS.md) for GUI PATH recovery, Unicode output, external terminals, and CLI/TUI configuration.

## Requirements

- Node.js **24+** and pnpm **11.15.1** for development/builds.
- Current stable Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
- macOS: Xcode Command Line Tools. Linux: WebKitGTK 4.1 development libraries. Windows: Microsoft C++ build tools and WebView2.
- Installed desktop apps include Node and their production dependencies; users do not need a system Node installation.

## Develop

```sh
pnpm install
pnpm dev                 # same as pnpm dev:desktop
```

The launcher builds the frontend/sidecar/agent, stages the platform Node binary, starts Vite on `127.0.0.1:1420`, and opens Tauri. If that port is occupied, it selects the next available port and passes the same URL to Tauri. The launcher owns Vite directly and closes it along with the Tauri process tree on exit. Frontend changes use Vite HMR. Restart `pnpm dev` after Node business code changes.

Normal launch shares the CLI's real pi home and restores the last workspace. For an isolated test app with temporary configuration and a local fake model:

```sh
PIX_ISOLATED=1 pnpm dev
```

Other entry points:

| Task                            | Command                     |
| ------------------------------- | --------------------------- |
| Compile frontend + Node sidecar | `pnpm build:desktop`        |
| Build all workspace packages    | `pnpm build`                |
| Landing site development        | `pnpm dev:landing`          |
| Landing site build              | `pnpm build:landing`        |
| Browser chat-content preview    | `pnpm demo:session-content` |
| Check Rust shell                | `pnpm check:rust`           |

## Validate

```sh
pnpm check                         # lint, types, formatting
pnpm test                          # existing workspace business tests
pnpm build:desktop
pnpm --filter @pix/desktop exec node scripts/sidecar-smoke.test.mjs
pnpm check:rust
pnpm test:release-assets
pnpm --filter @pix/desktop exec playwright install chromium webkit
pnpm e2e
```

The Sidecar integration test runs the real SDK against an isolated local fake model. It checks request errors, streaming, sessions, settings, workspace/Git queries, abort, process crash recovery and graceful shutdown.

The migrated Playwright suite runs the existing interface against the real Node sidecar. Native dialogs, notifications and window state use explicit test doubles in that suite; test the installed app for native platform behavior. WebKit coverage can be selected with `PIX_TEST_BROWSER=webkit pnpm e2e`.

## Package

```sh
pnpm package
```

This compiles the app, stages a platform-specific Node executable, deploys the production-only dependency graph from `packages/sidecar-node`, fetches the existing managed Node/Python tool runtimes, and builds Tauri installers. Dependencies are deployed from the lockfile as real directories and executable shims, supporting dynamic pi extensions, WASM and native `node-pty` addons. Staging rejects symlinks because the Tauri resource bundler would omit them.

Output: `apps/desktop/src-tauri/target/release/bundle/`.

Build on each target OS/architecture. Copying an unrelated architecture's Node binary or native modules into a cross-build is rejected. Generated binaries, resources and build directories are ignored by Git.

## Updates and releases

App version lives in `apps/desktop/package.json`; `tauri.conf.json` reads it directly. `pnpm version:set 0.8.0` also updates the Rust package and lockfile. Tag names must match the desktop version.

The release workflow builds macOS arm64/x64, Windows x64 and Linux x64 installers. Signed updates use Tauri's verified `latest.json` feed, replacing Electron YAML/blockmap feeds.

Platform builds run independently so a failure on one OS does not cancel the others. When `APPLE_SIGNING_IDENTITY` is unset, macOS packaging uses an ad-hoc signature (`-`); this does not provide Apple notarization.

Configure these repository secrets to enable automatic updates:

- `TAURI_SIGNING_PUBLIC_KEY`
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (if the private key is encrypted)

The workflow embeds the public key and repository-specific endpoint, generates signed updater artifacts, and combines all platforms into `latest.json`. Incomplete key pairs or partial signed releases fail the release job. Without keys, manual installers are produced and update checking stays disabled. Tauri updater signatures are separate from OS code signing.

For local signed packaging, set `PIX_UPDATER_PUBLIC_KEY`, optionally `PIX_UPDATER_ENDPOINT`, and `TAURI_SIGNING_PRIVATE_KEY`, then enable `bundle.createUpdaterArtifacts` in the Tauri build configuration. Never commit private signing keys.

CI runs checks, business tests, builds, Rust checks, sidecar integration and browser regression. Release jobs build installers; this migration does not publish a release automatically.

## Migration notes

See [MIGRATION.md](MIGRATION.md) for the feature mapping and compatibility details. Portable extension UI remains documented in [EXTENSION_UI.md](packages/agent-runtime/EXTENSION_UI.md).

## License

[MIT](LICENSE).
