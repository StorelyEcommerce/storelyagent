# Repository Guidelines

## Project Structure & Module Organization
- `src/`: React + TypeScript frontend. Routes live in `src/routes/`, hooks in `src/hooks/`, API client in `src/lib/api-client.ts`, and shared API types in `src/api-types.ts`.
- `worker/`: Cloudflare Workers backend. Entry point is `worker/index.ts`, with APIs in `worker/api/`, agents in `worker/agents/`, and services in `worker/services/`.
- `shared/`: Types shared between frontend and backend (non-worker-specific).
- `migrations/`: D1 database migrations managed by Drizzle.
- `templates/`: App scaffolding templates and deployment scripts.
- `public/`, `docs/`, `scripts/`, `container/`: Static assets, docs, utilities, and sandbox tooling.

## Build, Test, and Development Commands
- `bun run setup`: Bootstraps local Cloudflare resources, templates, and DB.
- `bun run dev`: Start the Vite dev server at `http://localhost:5173`.
- `bun run build`: Type-check and build production assets.
- `bun run typecheck`: TS build without emitting output.
- `bun run lint`: ESLint over the codebase.
- `bun run test`, `bun run test:watch`, `bun run test:coverage`: Vitest in run/watch/coverage modes.
- `bun run deploy`: Build and deploy to Cloudflare (uses `.prod.vars`).

## Coding Style & Naming Conventions
- TypeScript + React with Vite. Prefer explicit, shared types from `src/api-types.ts` and `shared/`.
- Indentation: tabs; quotes: single (see Prettier in `package.json`).
- Naming: React components `PascalCase.tsx`, utilities/hooks `kebab-case.ts`, backend services `PascalCase.ts`.
- Follow existing patterns in `src/lib/api-client.ts` and `worker/api/` before introducing new ones.

## Testing Guidelines
- Framework: Vitest with Cloudflare Workers pool (`vitest.config.ts`).
- Naming: `*.test.ts(x)` or `*.spec.ts(x)`.
- Example locations: `src/utils/ndjson-parser/ndjson-parser.test.ts`, `worker/agents/output-formats/**`.

## Commit & Pull Request Guidelines
- Conventional commits enforced by commitlint (types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`).
- Example: `chore: update template deploy docs`.
- PRs should include a concise description, tests run, and screenshots for UI changes. Link relevant issues and note any migration or template changes.

## Security & Configuration Tips
- Use `.dev.vars` for local secrets and `.prod.vars` for deploys; see `.dev.vars.example`.
- `wrangler.jsonc` defines bindings and template repository settings; keep it in sync with local setup.

## Agent-Specific Notes
- See `CLAUDE.md` for strict type-safety and architecture rules used by automation and contributors.

## Storely Product (High-Level)
- Storely is a vibe-coding platform focused on ecommerce websites.
- Users describe the store they want, and the platform generates, previews, and deploys production-ready storefronts.
- Core Storely scope includes storefront generation, store admin workflows, custom domains, and Stripe payment connectivity.
