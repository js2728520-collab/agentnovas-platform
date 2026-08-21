# Changelog

本项目采用 SemVer；Git tag 与 commit 是版本身份真源，Maintenance 发布记录用于保存验证和环境证据，不创建或改写 tag。

## [Unreleased]

## [1.0.0-beta.2] - 2026-08-21

### Fixed

- Maintenance Udun 充值页的生产 E2E 合同与已发布的“优盾充值通道”标题保持一致，恢复主分支质量发布 Gate。

## [1.0.0-beta.1] - 2026-08-21

### Added

- Maintenance `/releases` 版本发布控制面：不可变版本身份、独立验证、staging/production 部署结果与回滚证据。
- `maint.releases.view/manage/approve` 显式权限和 `0041_release_version_management.sql`。
- 版本管理 contracts、OpenAPI、API inventory、PostgreSQL 状态机与回归测试。
- 三端 audience-bound Next.js standalone 镜像、独立 Runtime/Migrator 镜像和私有 PostgreSQL Compose。
- SemVer release identity、四镜像 manifest、GHCR tag workflow、SBOM/provenance 与无 `latest` 的版本升级路径。

### Fixed

- Production HTML smoke 将随机监听端口显式映射到 Client audience。
- 冒烟断言与未登录根页的会话验证安全边界对齐，不再要求服务端泄露交易大厅正文。
- 三端 audience Server Component 在导入应用树前分发登录页，不再加载已认证 session 数据树或预取受保护根路由；未使用字体不再阻塞登录页 LCP。
- GitHub Actions 升级到 Node 24 runtime 的 checkout、setup-node 与 upload-artifact 官方 major，消除旧 Node 20 action 弃用路径。

### Deployment boundaries

- Payment、legacy Research、真实订单和自动资金路径保持硬关闭。
- Email、Udun 与平台 Demo 只有在目标环境 secret、allowlist/Webhook 和独立 smoke 通过后才启用；镜像发布不等于这些外部通道已启用。
