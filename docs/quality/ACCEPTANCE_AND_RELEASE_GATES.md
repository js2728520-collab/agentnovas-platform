# 受控测试验收与发布门禁

## 1. 总原则

只有同时通过自动化、数据库集成、真实浏览器、安全审查和文档核对的切片才能标记完成。规划、页面骨架、源码正则测试或手工截图单独存在都不构成完成。

## 2. Gate 0：文档与清洁 CI

- PRD、三应用 Spec、七智能体基线、迁移矩阵和 ADR 已评审。
- `tasks/todo.md` 使用 `CURRENT/PARTIAL/TARGET/BLOCKED`，不把页面骨架勾成完成。
- fresh clone/clean worktree 不依赖 `.gitignore` 中的旧 `dist`。
- `npm test` 的脚本说明与实际顺序一致。
- CI 使用与生产目标一致的 Node/PostgreSQL 主版本，或明确记录兼容矩阵。

## 3. Gate 1：身份与 Audience

- 三 audience 登录、Cookie、退出和 `next` 路径隔离。
- Operations/Maintenance 无注册、找回密码和邀请入口。
- 所有内部 API 有 audience + permission + scope policy。
- legacy role fallback 有开关、观察指标和退出日期。
- 登录/找回/bootstrap 限流；高权限账户强认证。
- 错误 audience 页面/API 不泄露资源存在性。

## 4. Gate 2：七智能体模拟闭环

- 官方三卡目标边界显示为 USDT 现货；当前环境明确为 shadow/paper。
- 七角色名称、顺序和输出与产品基线一致；audit 不占角色位。
- 决策轮详情来自数据库事件，无静态会议、静态价格或 fallback 业绩。
- 风控拒绝、数据不足、等待、退回、无信号和模拟执行均可追溯。
- 真实订单开关关闭且 Client 无真实订单入口。

## 5. Gate 3：Operations 业务闭环

- 客户/组织的数据范围有 PostgreSQL 集成测试。
- 列表/详情 PII 一致；导出/日志也遵守脱敏。
- 充值、策略治理、财务和授权审批禁止自审、重复决定和竞态覆盖。
- 账本不可编辑/删除；调整使用反向分录。
- 旧 Admin 能力逐项迁移或批准下线。

## 6. Gate 4：Maintenance 运行闭环

- Profile、Agent、数据、邮件、支付响应均不含密钥/完整端点/payload。
- configured、enabled、heartbeat、last success 分开显示。
- Worker 状态来自真实心跳，不只读取环境变量。
- 紧急暂停有 scope、原因和审计；解除不自动恢复策略。
- 所有外部测试在开关关闭时返回真实 503。

## 7. 自动命令

```bash
npm test
npx tsc --noEmit
npm run lint
npm run test:apps
git diff --check
```

推荐新增：

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:clean-ci
```

## 8. 浏览器矩阵

使用隔离 Profile 和一次性 PostgreSQL Schema：

| 身份 | 核心流 |
| --- | --- |
| Client | 登录、七智能体空/实数据、钱包、充值未配置、通知、策略/回测回归 |
| Ops 申请人 | 客户 scope、充值操作申请、策略上架申请、敏感角色申请 |
| Ops 审批人 | 禁止自审、第二人审批、重复/过期冲突、PII 差异 |
| Maintenance 管理员 | 模型安全视图、Worker 心跳、邮件/支付 503、安全暂停 |

每个身份检查 320/768/1024/1440，键盘 Tab 顺序、对话框焦点、可访问性树、console 和 network。

## 9. 发布否决项

出现以下任一项即不允许进入受控测试：

- 跨 audience API 可读写。
- PII、密钥、临时密码或私有端点回显。
- 静态数据冒充实时或模拟冒充真实。
- 敏感审批可以自审或重复产生副作用。
- 清洁 CI 依赖旧构建产物。
- 真实支付、邮件或订单在无明确授权时可执行。
- 生产迁移无恢复演练和回滚。

## 10. 证据包

每个 Gate 保存：版本/commit、迁移版本、命令输出、数据库测试摘要、浏览器截图、网络/console 摘要、已知限制、审批人和回滚说明。测试账号只在安全渠道交付，不写入仓库。
