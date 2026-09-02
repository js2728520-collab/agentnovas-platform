# Changelog

本项目采用 SemVer；Git tag 与 commit 是版本身份真源，Maintenance 发布记录用于保存验证和环境证据，不创建或改写 tag。

## [Unreleased]

### Added

- 增加一次性版本过渡分支、不可变 Preview 候选镜像和人工晋级 Runbook；main 不自动部署。
- 增加 npm/GitHub Actions 依赖更新治理、CODEOWNERS 与完整提交 SHA 锁定的 CI 供应链基线。

### Changed

- 候选版本提升为 `1.0.0-beta.7`，仅在人工确认并合并 main 后才允许创建正式 SemVer tag。

## [1.0.0-beta.5] - 2026-08-22

### Fixed

- Credits 余额投影不再读取受 FORCE RLS 保护的 `users`，无 Credits 账户时返回明确零余额和空更新时间，不伪造时间。
- Client 商业披露确认使用每用户 advisory transaction lock；优盾充值订单直接使用已认证 session 主体，不重新开放身份表。

## [1.0.0-beta.4] - 2026-08-22

### Fixed

- 将公开 `/` 与认证后的 `/dashboard` 分离，登录、Logo、面包屑和客户导航不再把已登录用户送回着陆页。
- Client 改用独立客户交易 Shell，策略实验室嵌入同一导航，移除内部控制台外观和二次登录闪烁。
- 商业披露收窄到新建会员订单，不再全局阻断 Paper、行情、通知、钱包只读和账户安全。
- Client Web/Auth 身份表访问收敛到 session 绑定的能力网关，身份表强制 RLS，未知或错配数据库角色失败关闭。
- 恢复演练在 FORCE RLS 下固定使用专用 migrator 与 row-security-aware dump，并完成 44 迁移、139 表实测恢复。

## [1.0.0-beta.3] - 2026-08-22

### Fixed

- 客户端根域恢复独立公开着陆页，不再先触发登录守卫；七语言文案按需加载并保持首屏 bundle 预算。
- 客户端着陆页、登录页、工作台与 favicon 统一使用 Riverton Capital 品牌资产，并修复 320px 顶栏入口可见性。

## [1.0.0-beta.2] - 2026-08-21

### Fixed

- Maintenance Udun 充值页的生产 E2E 合同与已发布的“优盾充值通道”标题保持一致，恢复主分支质量发布 Gate。
- Lighthouse 发布证据按 LHCI 0.15.1 的 FCP/Interactive 代表运行算法执行性能阈值，并绑定三次独立报告、审计目标、版本与 manifest；质量 runner 单测纳入默认测试套件。

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
