# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm/Turbo monorepo for Cortex Desktop, with a Go backend in `server/`.

- `apps/web/`: Next.js App Router web client.
- `apps/desktop/`: Electron desktop app built with electron-vite.
- `packages/core/`: shared types, mock API, React Query hooks, Zustand store, and `CoreProvider`.
- `packages/ui/`: pure reusable UI controls, icons, and utilities.
- `packages/views/`: business views such as `CortexDesktopView`.
- `packages/tsconfig/` and `packages/eslint-config/`: shared TypeScript and ESLint configuration.
- `server/`: Go services, CLI commands, handlers, migrations, and tests.

Keep module boundaries strict: `core` must not depend on `react-dom`, `localStorage`, or `process.env`; `ui` must not depend on `core`; `views` must not import `next/*` or router-specific APIs.

## Build, Test, and Development Commands

Use pnpm `10.28.2`.

- `pnpm install`: install workspace dependencies.
- `pnpm dev:web`: run the web app on `FRONTEND_PORT` or `3000`.
- `pnpm dev:desktop`: run the Electron desktop app.
- `pnpm typecheck`: run TypeScript checks through Turbo.
- `pnpm test`: run workspace tests.
- `pnpm lint`: run ESLint after typechecking dependencies.
- `pnpm build`: build web and desktop targets.
- `cd server && go test ./...`: run Go backend tests.

## Coding Style & Naming Conventions

The root package is `"type": "module"`, so use ES modules (`import`/`export`) instead of `require()`. TypeScript and React code should follow `@cortex-work/eslint-config`; React Hooks rules are enforced. Use `PascalCase` for React components, `camelCase` for functions and variables, and colocate tests beside the code they verify. Format Go code with `gofmt`.

## Testing Guidelines

Frontend packages use Vitest, Testing Library, and jsdom where configured. Name tests `*.test.ts` or `*.test.tsx`. Add tests for shared behavior in `core`, interaction logic in `views`, and reusable components in `ui`. Backend tests live beside Go packages as `*_test.go`; prefer table-driven tests for handlers and services. Run targeted tests first, then `pnpm test` and `cd server && go test ./...`.

## Commit & Pull Request Guidelines

Git history is not available from this checkout, so use clear Conventional Commit-style messages such as `feat: add workspace activity filter` or `fix: handle missing daemon token`. Pull requests should include a summary, linked issue, screenshots for UI changes, migration notes, and exact test commands run.

## Security & Configuration Tips

Do not commit secrets, local tokens, generated uploads, or environment-specific config. Keep mock data in `packages/core/mock/` realistic enough to exercise visible UI states, and replace mock API implementations without changing query keys or component contracts.
