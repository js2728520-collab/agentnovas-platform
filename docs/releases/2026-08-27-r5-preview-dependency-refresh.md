# r5 Preview 依赖清零刷新

状态：`PREVIEW_PASS / PRODUCTION_HOLD`。本次刷新只把已清零的开发工具链 lockfile 和相同应用源码重新
构建到三个测试域，不构成 production 发布授权。

## 候选

- Release：`preview-7c047b6-wt-20260826T161203Z`
- Source tree SHA-256：`e5c9acbf9d741922e7984686066b2f99c6c5678840553e0d309e1afb26f64f47`
- 域名：`test.agentnovas.com`、`ops-test.agentnovas.com`、`main-test.agentnovas.com`
- 能力范围：继承 r4 capability manifest；所有真实 provider、外部 Worker、资金、通知、模型调用和订单仍关闭。
- 回滚：r4 三张 Web 镜像与 predeploy image ID 保留；preview 数据卷未重建。

## 镜像与部署

| 镜像 | Digest |
| --- | --- |
| Client | `sha256:c12fc4f041b827265add5a5e42c7bbfe65f356c1304bcc1debea40c715a3cc49` |
| Operations | `sha256:8dc41daef5bdc301e1627033c792d420a89b6490aefb25defffd05fc7b65374f` |
| Maintenance | `sha256:4026f36573e7ef62d392149d222a65d75722d16c6021f415e18e224ec0f0a3db` |
| Runtime | `sha256:b574f9a23e4fd9a0bb27ee65f39737d8733248f59f8a2dd390e084a1b09f37a0` |

只重建 preview 的三个 Web 容器；PostgreSQL、Caddy、DNS、Worker 和 production 均未修改。三容器以
`node`、read-only rootfs、`cap_drop=ALL`、`no-new-privileges` 运行，普通环境敏感键为 0，只连接 preview
backplane/edge，restart 0。

## 验收

- 公网 live/ready/login：9/9 HTTP 200、TLS verify 0。
- 错误/正式/cross-audience Host：12/12 HTTP 404。
- 10 个 30 秒采样点：60/60 live/ready 200，p95 0.171643 秒、最大 0.240948 秒。
- 结束状态：三容器 running/healthy、restart 0；app error marker 0、Caddy 5xx 0、Worker 0。
- preview migration registry：源码 77 个、registry 78 条；唯一 db-only 行是 r4 前已登记的 preview 历史
  `0068_internal_registration_role_guard_owner.sql`，source-only 为 0。本次未修改 registry。

证据根目录：
`an-saas:/opt/agentnovas-riverton-preview/releases/preview-7c047b6-wt-20260826T161203Z/`。

当前 production/付费 Beta 仍为 `HOLD`：T9.5 六场真实人员演练与用户 production 发布授权尚未完成；
T8.0 的 CI/CD 安全评审也没有被本次 Web-only preview 刷新绕过。
