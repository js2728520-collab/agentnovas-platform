<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AgentNovas project rules

- Before changing code, read `docs/DEVELOPMENT_HANDOFF.md`, the relevant ADRs, and the latest Git commit; then inspect `git status` so existing user changes are preserved.
- Continue feature work on the branch named at the top of `tasks/plan.md` unless the user explicitly requests another branch. `codex/three-app-riverton-split` is the last pushed branch, not the current working branch.
- Local commits are expected as slices complete; each slice records its evidence in `docs/DEVELOPMENT_HANDOFF.md`.
- **The GitHub remote `js2728520-collab/agentnovas-platform` is a PUBLIC repository.** Pushing publishes the
  code, the docs and every commit's author identity to the open internet, permanently. Confirm the scope with
  the user before the first push of a branch; afterwards, keep pushing that branch as agreed. Creating a pull
  request or adding a new remote still needs explicit permission.
- Commit as `Claude <noreply@anthropic.com>`, never under the repository owner's personal name, email or
  machine hostname. A local `user.email` such as `name@Hostname.local` leaks the owner's account and machine
  name into a public history that cannot be retracted. Set `user.name`/`user.email` in the worktree before the
  first commit — rewriting authorship afterwards changes every SHA and breaks the commit references that the
  handoff document uses as implementation evidence.
- Deployment to the target host is a separate decision from pushing. Do not run production migrations, switch
  traffic, restart production services or touch the production database without explicit approval for that
  specific action. Building on the remote host inside a disposable directory is not a deployment; clean the
  directory up afterwards and say so in the handoff entry.
- The target runtime is self-hosted Linux with Node.js, PostgreSQL, Research Worker, Runtime Worker, Nginx, and Certbot. Do not add Cloudflare Runtime or Redis dependencies.
- Real perpetual order routing is out of scope and must remain disabled. LLM output may explain or propose, but deterministic code owns validation, backtesting, scoring, risk gates, and simulated order intents.
- Never commit `.env*`, API keys, database passwords, exchange credentials, encryption keys, personal account data, or production dumps. Transfer secrets and database backups outside Git.
- Use Node.js 22.21.0 or newer. Preserve the proxy-aware `npm run dev`, `npm run start`, and Worker scripts because exchange instrument and market-data requests may depend on Node's environment proxy support.
- Before handing off code, run proportionate tests plus TypeScript/build and lint checks, report pre-existing warnings separately, and record material decisions in the handoff document or an ADR.
