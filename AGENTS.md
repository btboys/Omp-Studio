# Repository Guidelines

## Project Overview

Omp Studio is a cross-platform Electron desktop client for the [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp, a fork of the [Pi coding agent](https://github.com/earendil-works/pi)). It provides a desktop workspace for omp projects, threads, model configuration, extensions, permission controls, scheduled automations, and file previews. The Electron main process spawns the omp CLI in RPC mode and bridges it to a React UI; it also manages an embedded, versioned Node.js + omp runtime. This is an independent community project, not affiliated with the Pi or omp maintainers.

- Current release: `0.3.1` (package.json `version`); pinned omp runtime `17.2.11` (`ompRuntimeVersion`).
- Packaging targets: Windows x64 (NSIS), macOS arm64 (DMG), plus Linux AppImage config.
- Supported dev Node version: `>=24.14.0 <25` (package.json `engines`).

## Architecture & Data Flow

Three-process Electron app built with electron-vite (see `electron.vite.config.ts`, which builds three targets: main, preload, renderer).

1. **main** (`src/main/`) — privileged Node process. Spawns the bundled `omp` CLI (`--mode rpc-ui --no-title`, plus `--session <file>` for existing threads) as a child process per thread (`PiBridge`, `src/main/pi-bridge.ts`) and speaks JSONL over stdio: write `{id,type,...}\n` on stdin, read `response` / `extension_ui_request` / agent events on stdout. Registers every IPC endpoint in `src/main/ipc.ts`, which owns the threadId→bridge registry and a warm-spare process pool (one standby omp process to hide ~5s cold starts).
2. **preload** (`src/preload/index.ts`) — `contextBridge.exposeInMainWorld("pi", ...)`: a typed `window.pi` API. Every renderer→main call is `ipcRenderer.invoke`.
3. **renderer** (`src/renderer/`) — React 18 + Zustand UI.

**Data flow (streaming):** renderer → `window.pi.<ns>.<method>` → `ipcRenderer.invoke("ns:method")` → `ipcMain.handle` in `ipc.ts` → PiBridge stdin JSONL → pi stdout events → `ipc.ts` routes them to renderer push channels → `src/renderer/src/lib/usePiEvents.ts` → the single store reducer (`src/renderer/src/store.ts`), which queues events and flushes **one store update per animation frame** (no per-token re-renders).

**IPC surface:** invoke namespaces `app:`, `thread:`, `plugins:`, `automation:`, `settings:`, `window:` (e.g. `thread:prompt`, `thread:setPermission`, `app:getConfig`, `settings:saveModels`, `plugins:getPackages`, `automation:runNow`, `window:close`). Push channels: `pi:event`, `pi:extui`, `pi:exit`, `pi:error`, `pi:automation`, `pi:appUpdate`, `pi:coreUpdate`, `window:maximized-changed`.

**Permission model:** every pi process loads a gate extension (`src/main/permission-gate-ext.ts`, installed into userData and passed via `--extension`). `src/main/permission-gate.ts` writes a per-thread mode file exposed as `PI_STUDIO_GATE_MODE_FILE`; the gate allows `sandbox` (default) or `full` and intercepts Pi's `tool_call` events to gate shell commands, cross-project writes, mutating tools, and subagents.

**Shared config:** omp's own config lives under `~/.omp/agent` (`models.json`, `settings.json`, `sessions/*.jsonl`); Omp Studio's own settings live in `AppConfig` (`src/main/config.ts`), persisted to Electron's userData `config.json`.

## Key Directories

- `src/main/` — Electron main process: IPC broker (`ipc.ts`), Pi bridge (`pi-bridge.ts`), config singleton (`config.ts`), permission gate (`permission-gate.ts`, `permission-gate-ext.ts`), runtime packaging (`runtime-package.ts`), core/app updaters (`core-updater.ts`, `app-updater.ts`), automation scheduler (`automation.ts`), session reader (`session-store.ts`), plugins/models services (`plugins.ts`, `models-service.ts`), file/preview services (`fs-service.ts`, `preview-service.ts`, `html-preview-protocol.ts`).
- `src/preload/` — contextBridge surface (`index.ts`) and its global types (`index.d.ts`).
- `src/renderer/src/components/` — React UI components, PascalCase `.tsx` (Chat, Sidebar, Composer, Preview, Settings, PluginsPanel, AutomationPanel, SearchModal, ExtUiModal, ExtUiPromptCard, Toasts, icons).
- `src/renderer/src/lib/` — pure helpers/hooks/types: `types.ts`, `usePiEvents.ts`, `useOutsideClose.ts`, `format.ts`, `markdown.tsx`, `artifacts.ts`, `i18n.ts`, `reasoning.ts`, `update.ts`.
- `scripts/` — build/runtime/icon/test scripts (`bundle-runtime.mjs`, `finalize-runtime.mjs`, `generate-icon.py`, `test-permission-gate.mjs`).
- `resources/` — app icons (`icon.png` master, `icon.ico`, `icon.icns`) and `runtime-manifest.json`.
- `runtime-release/` — generated runtime tar.gz (output of `npm run bundle`; gitignored).
- `release/` — installer output (gitignored).
- `.github/workflows/` — CI installer build (`build-installers.yml`).

## Development Commands

Requires Node `>=24.14.0 <25` and npm. No global agent install is needed: `npm run bundle` downloads the pinned oh-my-pi (`omp`) release binary (`ompRuntimeVersion` in `package.json`).

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | electron-vite dev server with HMR |
| `npm run typecheck` | `tsc --noEmit` on both `tsconfig.node.json` (main/preload) and `tsconfig.json` (renderer) |
| `npm run test:permission` | Run the permission-gate assertion suite (`node scripts/test-permission-gate.mjs`) |
| `npm run build` | electron-vite production build → `out/` |
| `npm run bundle` | Build the embedded Node.js + omp runtime tar.gz → `runtime-release/` + write `resources/runtime-manifest.json` (SHA-512) |
| `npm run pack` | `bundle` + `build` + `electron-builder --dir` + `finalize-runtime` (unpacked dir) |
| `npm run dist` | `bundle` + `build` + `electron-builder` + `finalize-runtime` (installers in `release/`) |
| `python scripts/generate-icon.py` | Regenerate `resources/icon.png|ico|icns` (manual, Pillow) |

Env vars used by packaging: `PI_RUNTIME_VERSION` (overrides the pinned runtime version), `PI_PACKAGE_DIR` (package a specific local pi install), `CSC_IDENTITY_AUTO_DISCOVERY=false` (CI, unsigned builds).

## Code Conventions & Common Patterns

- **TypeScript strict** everywhere; no lint/prettier/eslint config exists in the repo — `npm run typecheck` is the only static gate.
- **IPC contract flow for new features:** register the handler in `src/main/ipc.ts`, expose the method on `window.pi` in `src/preload/index.ts`, declare types in `src/preload/index.d.ts` and `src/renderer/src/lib/types.ts`. Keep renderer-side shapes in sync with the IPC contract.
- **Main-process state:** module-level singletons (cached `AppConfig`, `bridges` Map, warm-spare handle). Error handling is local `try/catch` + `console.log`; there are deliberately no global `unhandledRejection`/`uncaughtException` handlers.
- **Renderer state:** one global Zustand store (`src/renderer/src/store.ts`); access via `useStore(selector)` with primitive selectors to avoid re-renders.
- **Renderer→main boundary:** components NEVER use raw Electron APIs; everything goes through `window.pi`.
- **Styling:** one global stylesheet `src/renderer/src/styles.css` (~4.6k lines) with CSS custom properties (`--bg`, `--accent`, `--radius`, …) and BEM-like class names (`.composer`, `.chat-head`, `.msg`, `.tool-card`, `.set-row`). No CSS Modules/Tailwind/styled-components. Inline styles only for dynamic widths/heights.
- **Icons:** custom SVG set in `src/renderer/src/components/icons.tsx`; add new icons there (each accepts a `size` prop).
- **i18n:** bilingual zh/en, driven by `config.language` through `src/renderer/src/lib/i18n.ts` + `components/LanguageBridge.tsx`; gate strings on `config.language || "en"`.
- **UI feedback:** `useStore.getState().pushToast(kind, text)` for transient notifications; wrap popovers/dropdowns with the `useOutsideClose` hook (close on outside click/Escape).
- **Streaming:** consume main events in `usePiEvents.ts`; event reduction lives in `store.ts` and is batched per `requestAnimationFrame` — keep it that way.
- **Permissions:** threads and automation tasks carry a `sandbox`/`full` level; extension permission/dialog requests surface through `extuiQueue` (rendered by `ExtUiPromptCard`/`ExtUiModal`).
- **House rules (README Contributing):** keep changes focused; never commit local data, generated bundles, installers, credentials (`auth.json`, `models.json`, session files), or QA browser profiles.

## Important Files

- `src/main/index.ts` — app bootstrap: single-instance lock, main BrowserWindow (frameless), runtime dir discovery, lifecycle cleanup.
- `src/main/ipc.ts` — the single IPC wiring point: all `ipcMain.handle` registrations + bridges registry + event routing to renderer.
- `src/main/pi-bridge.ts` — `PiBridge`: spawns/owns the pi RPC child process, JSONL protocol, runtime resolution (override → userData → bundled → PATH).
- `src/main/permission-gate-ext.ts` — the gate extension source loaded by pi; classify/parse shell commands, project-boundary checks, tool-call gating. The repo's only unit-tested module.
- `src/main/config.ts` — file-backed `AppConfig` singleton (userData `config.json`).
- `src/preload/index.ts` + `index.d.ts` — `window.pi` surface + global types; the only bridge into main.
- `src/renderer/src/store.ts` — single source of truth for all renderer state + actions + event reducer.
- `src/renderer/src/App.tsx` — root shell (title bar, sidebar, chat/preview, overlays, theme).
- `src/renderer/src/styles.css` — global styling source of truth.
- `electron.vite.config.ts` — three-target build definition (main/preload/renderer).
- `package.json` — scripts, `build` (electron-builder config), `allowScripts`, `ompRuntimeVersion`.
- `scripts/bundle-runtime.mjs` — embedded runtime pipeline (Node binary + omp release binary → tar.gz + SHA-512 manifest).

## Runtime/Tooling Preferences

- **Runtime:** Node `>=24.14.0 <25` (engines-pinned; Node 24 only). npm is the package manager — no yarn/pnpm lockfiles.
- **Package install scripts:** `allowScripts` in package.json allowlists `electron` and `esbuild` postinstall scripts; adding a dependency with install scripts requires extending this allowlist.
- **Build tooling:** electron-vite (Vite 5) + electron-builder; TypeScript 5.6; React 18; Zustand 4.
- **Packaging:** electron-builder config lives in `package.json` → `build` (appId `com.pi-studio.app`, productName "Omp Studio", output `release/`, extraResources: `runtime-manifest.json` + `runtime-release/` + icons). Installers are unsigned (SmartScreen/Gatekeeper warnings expected).
- **Updates:** app auto-update via `electron-updater` publishing to GitHub Releases (`flowflic/Pi-Studio`); omp runtime updated in-app via `core-updater.ts` (sha256-verified omp release binary under `<userData>/runtime/versions/<version>`, `current.json` pointer).
- **CI:** `.github/workflows/build-installers.yml` — triggers: push to `main`, tags `v*`, `workflow_dispatch`; matrix: windows-latest x64 + macos-15 arm64; Node 24.14.0.

## Testing & QA

- **The only automated test in the repo** is `scripts/test-permission-gate.mjs` (no Jest/Vitest/Mocha config, no other `*.test.*` files). It imports `src/main/permission-gate-ext.ts` directly and asserts `classifyShellCommand` risk levels (allow/approval/always), `parseShellCommand`, `isOutsideProject`, and gate UI caching. Run: `npm run test:permission`. Success: prints `permission gate tests passed`.
- **Run `npm run typecheck` before every change** (both tsconfigs must pass).
- **CI gates:** typecheck + (Windows job only) `test:permission`, then runtime bundle + manifest verification + installer build. `test:permission` runs only on Windows in CI; run it locally regardless when permission/tool-execution code changes (per README).
- **New logic worth guarding:** follow the existing pattern — a plain Node script under `scripts/` using `node:assert` against a pure module in `src/main/`, wired into package.json as `test:*` and run with `node`. No coverage tooling exists or is expected.
- **Manual QA:** `npm run dev` for the app; installers from `npm run dist` land in `release/`.
