# Repository Guidelines

## Project Structure & Module Organization

This package is the Electron desktop client for Cortex. Main-process code lives in `src/main/`, preload bridge code in `src/preload/`, and renderer entry points in `src/renderer/`. Shared UI and business views should come from workspace packages such as `@cortex-work/ui`, `@cortex-work/core`, and `@cortex-work/views` instead of being duplicated here.

Assets used by the packaged app belong in `assets/` or `resources/`. Build outputs are generated under `out/` and `dist/`; do not edit or commit generated artifacts unless a release workflow explicitly requires it.

The `pi` agent runs in a **resident gateway worker**: the main process forks a long-lived `utilityProcess` (`src/main/agents/pi-gateway/` protocol + client, `src/worker/pi-host/` host, built to `out/worker/pi-host.js`), which imports the `@earendil-works/*` packages from `node_modules` (shipped inside `app.asar`) and drives `createAgentSession()`. All chat sessions share one worker; credentials are fetched over RPC from the main process's safeStorage vault on demand. One-shot runs stay in-process in the main process (`src/main/agents/pi-inproc/oneshot.ts`). Nothing pi-related is staged into `resources/`; the former bun-compiled binary and its build chain have been removed.

## Build, Test, and Development Commands

Use pnpm from the repository root or this package directory.

- `pnpm --filter @cortex-work/desktop dev`: build the native helpers and worker bundles, then run Electron through `electron-vite dev`.
- `pnpm --filter @cortex-work/desktop build`: build the Electron main, preload, and renderer bundles.
- `pnpm --filter @cortex-work/desktop typecheck`: run both Node and web TypeScript projects.
- `pnpm --filter @cortex-work/desktop test`: run Vitest tests.
- `pnpm --filter @cortex-work/desktop lint`: run ESLint for this package.
- `pnpm dist:desktop:dmg`: create an unsigned macOS DMG via the root script.

## Coding Style & Naming Conventions

Use TypeScript ES modules and follow the workspace ESLint configuration. Name React components with `PascalCase`, functions and variables with `camelCase`, and tests as `*.test.ts` or `*.test.tsx`. Keep Electron boundaries explicit: main-process APIs stay in `src/main/`, renderer-safe bridge contracts stay in `src/preload/`, and browser UI stays in `src/renderer/`.

## Testing Guidelines

Vitest is used for desktop package tests. Add focused tests beside the code being changed, especially for main-process utilities, geometry calculations, hotkeys, IPC-facing behavior, and packaging-sensitive path logic. Run targeted tests first when possible, then `pnpm --filter @cortex-work/desktop test` before handing off.

## Commit & Pull Request Guidelines

Use clear Conventional Commit-style messages such as `fix: handle missing desktop resource` or `feat: add notes overlay shortcut`. Pull requests should describe the desktop behavior changed, list verification commands, and include screenshots or recordings for visible UI changes. For packaging changes, mention the exact artifact checked, such as `dist/mac-arm64` or a generated DMG.

## Security & Configuration Tips

Do not commit local tokens, user data, logs, or generated build outputs. Keep preload APIs narrow and typed; never expose unrestricted Node or filesystem access directly to renderer code. Validate external paths and IPC inputs in the main process before using them.
