# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install                    # Install all deps (root + workspace packages)
npm run tauri dev              # Desktop app with hot reload (Vite on :1420)
npm run build                  # tsc + vite build + build MCP workspace package
npm test                       # Run Vitest suite
npx vitest run src/lib/__tests__/some.test.ts  # Single test file
npm run mcp -- --project /path/to/wiki         # Launch read-only MCP server
cd src-tauri && cargo build    # Rust-only check
```

## Architecture

**Hybrid desktop app**: React 19 + TypeScript frontend (Vite) with Tauri v2 Rust backend.

### Frontend (`src/`)

- **Components** (`src/components/`): Feature views grouped by area — `chat/`, `graph/`, `layout/`, `settings/`, `sources/`, `review/`, `lint/`, `search/`, `editor/`, `project/`. Shared shadcn/ui primitives in `components/ui/`.
- **Business logic** (`src/lib/`): Core engine modules — `ingest.ts` (two-step chain-of-thought), `llm-client.ts` (multi-provider streaming), `retrieval-core.ts` → `retrieval-text.ts` + `retrieval-graph-core.ts` (multi-phase query pipeline), `wiki-graph.ts` + `graph-relevance.ts` (4-signal relevance model), `wiki-query.ts` (query orchestration), `deep-research.ts`, `lint.ts`, `embedding.ts`, `search.ts`.
- **State** (`src/stores/`): Zustand stores — `wiki-store.ts` (project + files), `chat-store.ts`, `review-store.ts`, `activity-store.ts`, `research-store.ts`.
- **MCP** (`src/mcp/`): In-app MCP server — `server.ts` (tool definitions), `http-server.ts` (Streamable HTTP transport), `project-discovery.ts`, `vector-search.ts`.
- **Types** (`src/types/`): Shared TypeScript definitions.
- **i18n** (`src/i18n/`): English + Chinese via react-i18next.

### Rust Backend (`src-tauri/src/`)

- **Commands** (`src-tauri/src/commands/`): `fs.rs` (file operations, document parsing), `project.rs` (project management), `vectorstore.rs` (LanceDB vector ops).
- Document parsers: pdf-extract, docx-rs, calamine (XLSX/XLS/ODS), ZIP+XML (PPTX).
- `tiny_http` server on port 19827 for Chrome extension web clipper.
- Axum-based web search endpoint.

### MCP Workspace Package (`packages/llm-wiki-mcp/`)

Publishable `@haowan36/llm-wiki-mcp` — standalone read-only MCP server with Streamable HTTP transport. Shares source from `src/mcp/` at build time.

### Browser Extension (`extension/`)

Chrome Manifest V3 extension. Uses Readability.js + Turndown.js for web clipping. Communicates with app via local HTTP API (port 19827).

## Key Design Patterns

- **Three-layer wiki**: Raw Sources (immutable) → Wiki (LLM-generated) → Schema (rules/config). Based on Karpathy's LLM Wiki pattern.
- **Two-step ingest**: Analysis LLM call → Generation LLM call, with SHA256 incremental cache to skip unchanged files.
- **Multi-phase retrieval**: Tokenized search → optional vector search (LanceDB) → graph expansion (2-hop) → budget-controlled context assembly.
- **`@/` import alias** maps to `src/`.
- **Zustand stores** are the single source of truth; components read from stores and dispatch actions.
- **`dataVersion` signaling**: Components watch a version counter that increments when wiki content changes, triggering graph/UI refreshes.
- **Path normalization**: `normalizePath()` used throughout for cross-platform compatibility (backslash → forward slash).

## Conventions

- TypeScript: 2-space indent, double quotes, no semicolons.
- React components: PascalCase exports, kebab-case filenames.
- Zustand stores: kebab-case filenames suffixed with `-store.ts`.
- Rust: snake_case, `rustfmt`-friendly.
- Commits: Conventional Commits with scope — `feat(settings):`, `fix(mcp):`, `refactor(graph):`, `style(rust):`.
- Tests: Vitest + Testing Library + jsdom. UI tests beside components as `*.test.tsx`, library tests in `src/lib/__tests__/`.
- CI builds on macOS, Ubuntu, Windows — platform-specific changes must be called out.

## Prerequisites

Node.js 20+, Rust 1.70+, protoc (protobuf compiler).
