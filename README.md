# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
# AgentNovas

当前版本已完成前台平台壳、组织后台、行情展示、账户连接界面、模拟盘订单、硬风控、审计链和健康检查。

## 运行边界

- 第一阶段仅允许模拟盘下单，服务端拒绝实盘订单。
- 行情不可用、单日亏损超限、仓位超限或全局紧急停止时，禁止新开仓。
- 交易所凭证需要配置 `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY` 加密保存。
- 上线真实交易前，还需要配置生产数据库、交易所适配器、WebSocket 行情源和正式密钥，并完成模拟盘与小额实盘验收。
- `/api/health` 可用于部署后的基础配置检查。

## 部署验收顺序

1. 配置 `BOOTSTRAP_SECRET`、`EXCHANGE_CREDENTIAL_ENCRYPTION_KEY` 和 `PLATFORM_EMERGENCY_STOP=false`。
2. 按 `drizzle/` 目录中的迁移顺序同步 Cloudflare D1 `DB`。
3. 请求 `/api/health`，确认数据库和加密密钥状态为 `ready`。
4. 先使用模拟账户完成连接、行情、风控、下单、成交、平仓和审计链验收。
5. 只有完成模拟盘验收后，才进入交易所适配器和小额实盘的独立评审。

出现系统异常时，将 `PLATFORM_EMERGENCY_STOP` 设置为 `true`，系统会停止新开仓，同时保留查询、撤单和平仓能力。

## 三套平台 AI 策略运行链路

平台内置的 `AI 稳健型`、`AI 平衡型` 和 `AI 激进型` 已使用独立、可审计的确定性策略引擎。客户先在策略详情中选择已通过检测的验证账户并确认风险，随后由 Cloudflare 每 5 分钟调用：

`POST /api/automation/platform-ai-cycle`

每轮按策略周期读取真实完整K线，计算 EMA、RSI、ATR、成交量、通道和布林区间，经过反方审查、会员/催收、账户权限、单日亏损、总仓位和平台紧急停止检查后，保存平台决策、七角色工作记录及订单审计。默认只建立站内验证仓位；仅当 `OKX_DEMO_EXECUTION_ENABLED=true` 时向 OKX 验证环境提交订单。实盘订单路由仍由服务端硬性关闭。
