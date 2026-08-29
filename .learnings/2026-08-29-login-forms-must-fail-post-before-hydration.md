# 登录表单必须在 hydration 前以 POST 失败关闭

## 事件

远端 Chromium 验收在 `domcontentloaded` 后立即点击 React 登录表单。事件处理器尚未完成接管，浏览器按 HTML 默认值执行 GET 表单提交，把测试登录字段放进了查询 URL。测试凭证随即轮换，相关会话全部撤销。

## 根因

- `<form>` 没有显式 `method="post"`，浏览器默认使用 GET。
- 验收器只等待 `domcontentloaded`，没有等待前端资源和 hydration 完成。
- 验收器没有在网络边界阻断包含登录字段的查询字符串。

## 长期约束

- 登录、改密、MFA、支付等敏感表单必须在纯 HTML 状态下也以 POST 失败关闭；不得依赖 JavaScript 阻止默认 GET。
- 浏览器验收提交敏感表单前必须等待 `networkidle` 或产品提供的明确 hydration 标记。
- 自动化网络拦截必须拒绝 URL 查询中的 `password`、`identifier`、OTP、恢复码和同类字段，并在发送前失败。
- 错误输出不得复述已经进入 URL 的凭证；一旦发生，立即轮换、撤销会话并留下不含秘密的审计事实。

## 回归证据

- `tests/login-form-browser-safety.test.mjs`
- `tests/deployed-test-sites-browser-contract.test.mjs`
