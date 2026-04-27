# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the React + TypeScript desktop UI. Keep feature code grouped by area: shared UI in `src/components/ui`, feature views in folders like `src/components/settings` and `src/components/graph`, reusable logic in `src/lib`, Zustand stores in `src/stores`, and shared types in `src/types`. The Tauri backend lives in `src-tauri/src`, with commands under `src-tauri/src/commands`, Rust data types under `src-tauri/src/types`, and the embedded MCP/upload services in Rust modules. Static assets live in `assets/`, browser extension files in `extension/`, and CI definitions in `.github/workflows/`.

## Build, Test, and Development Commands
Run `npm install` once at the repo root. Use `npm run tauri dev` for the desktop app in development. Use `npm run build` to type-check the frontend and build the Vite app. Use `npm test` to run the Vitest suite. For Rust-only verification, run `cargo build` inside `src-tauri/`; this matches the CI backend check.

## Coding Style & Naming Conventions
Follow the existing TypeScript style: 2-space indentation, double quotes, and no semicolons. React components use PascalCase file exports such as `SettingsView`, while most file names are kebab-case like `settings-view.tsx` or `wiki-store.ts`. Prefer the `@/` alias for imports from `src/`. Keep Zustand stores suffixed with `-store.ts`. Rust modules and functions use snake_case and should remain `rustfmt`-friendly.

## Testing Guidelines
Frontend tests use Vitest with Testing Library and `jsdom`. Add UI tests beside the component as `*.test.tsx` and library tests under `src/lib/__tests__/`. There is no explicit coverage gate in CI, so add tests for any changed behavior and run `npm test` before opening a PR.

## Commit & Pull Request Guidelines
Match the existing Conventional Commit pattern: `feat(settings): ...`, `fix(mcp): ...`, `refactor(graph): ...`, `style(rust): ...`. Keep scopes short and tied to the affected area. PRs should explain user-visible impact, note frontend vs. Tauri/MCP changes, list the commands you ran, and include screenshots for UI changes. If a change is platform-specific, call that out explicitly because CI builds on macOS, Ubuntu, and Windows.
