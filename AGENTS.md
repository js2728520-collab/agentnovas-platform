<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AgentNovas project rules

- Before changing code, read `docs/DEVELOPMENT_HANDOFF.md`, the relevant ADRs, and the latest Git commit; then inspect `git status` so existing user changes are preserved.
- Continue feature work on `codex/three-app-riverton-split` unless the user explicitly requests another branch.
- Never push a branch, create a pull request, or otherwise publish repository changes without the user's explicit permission. Local commits are allowed only when requested.
- The target runtime is self-hosted Linux with Node.js, PostgreSQL, Research Worker, Runtime Worker, Nginx, and Certbot. Do not add Cloudflare Runtime or Redis dependencies.
- Real perpetual order routing is out of scope and must remain disabled. LLM output may explain or propose, but deterministic code owns validation, backtesting, scoring, risk gates, and simulated order intents.
- Never commit `.env*`, API keys, database passwords, exchange credentials, encryption keys, personal account data, or production dumps. Transfer secrets and database backups outside Git.
- Use Node.js 22.21.0 or newer. Preserve the proxy-aware `npm run dev`, `npm run start`, and Worker scripts because exchange instrument and market-data requests may depend on Node's environment proxy support.
- Before handing off code, run proportionate tests plus TypeScript/build and lint checks, report pre-existing warnings separately, and record material decisions in the handoff document or an ADR.
