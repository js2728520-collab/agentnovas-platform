# r4 Preview Phase 9 运营演练记录

状态：`READY_FOR_HUMAN_EXECUTION`，不得作为 T9.5 已通过的证据。

## 候选身份

- Release：`preview-7c047b6-wt-20260826T142018Z`
- Git HEAD：`7c047b6`（候选包含未提交工作树，不能登记为正式 release）
- Source tree SHA-256：`18be3df441b4a93395f834cb6582397ea9366b0b496923f4b07bf385b066ff2f`
- Preview：`test.agentnovas.com`、`ops-test.agentnovas.com`、`main-test.agentnovas.com`
- 外部写入：全部关闭；真实订单、邮件、支付和 provider 调用不在本轮范围

## 人员登记

| 角色 | 姓名/账号 | 已确认 |
| --- | --- | --- |
| Exercise Director | 待指定 | 否 |
| Incident Commander | 待指定 | 否 |
| Recorder | 待指定 | 否 |
| Support Lead | 待指定 | 否 |
| Risk Lead | 待指定 | 否 |
| Finance Maker | 待指定 | 否 |
| Finance Checker | 待指定，必须不同于 Maker | 否 |
| Maintenance/Security | 待指定 | 否 |

## 技术预检

- T9.0–T9.4 preview、迁移/恢复、浏览器/性能和安全边界证据已通过。
- 与六场注入对应的隔离技术 fixture 已在远端禁网 PostgreSQL 16.14 和只读 Node 22.21.1 容器中完成：105/105 通过，`external_writes_enabled=false`、`real_provider_calls=0`。日志 `t95-technical-drills.log` SHA-256 为 `079d2f6b4fd69fa8caa78c67d7e111e35e3007872596572b24e4b15cd60363f0`；临时数据库、network 和依赖卷均已删除。
- 完整开发工具链 17 项临时漏洞例外仍是 2026-08-28/首个付费 Beta 前停止条件。

## 场次结果

| 场次 | 状态 | Ack/Contain/Impact | 证据 | 偏差/Owner |
| --- | --- | --- | --- | --- |
| D1 客服 | NOT_RUN | 待记录 | 待记录 | 待记录 |
| D2 风控 | NOT_RUN | 待记录 | 待记录 | 待记录 |
| D3 财务 | NOT_RUN | 待记录 | 待记录 | 待记录 |
| D4 综合事故 | NOT_RUN | 待记录 | 待记录 | 待记录 |
| D5 provider 故障 | NOT_RUN | 待记录 | 待记录 | 待记录 |
| D6 密钥泄露 | NOT_RUN | 待记录 | 待记录 | 待记录 |

最终结论：技术预检 `PASS`，人员演练 `NOT_RUN`。只有真实参与人按 `docs/runbooks/phase9-operational-drills.md` 完成六场、填写时间线并由 director/recorder 签字后，才能把 T9.5 改为 PASS。
