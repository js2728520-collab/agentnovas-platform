# Changelog

本项目采用 SemVer；Git tag 与 commit 是版本身份真源，Maintenance 发布记录用于保存验证和环境证据，不创建或改写 tag。

## [Unreleased]

### Added

- Maintenance `/releases` 版本发布控制面：不可变版本身份、独立验证、staging/production 部署结果与回滚证据。
- `maint.releases.view/manage/approve` 显式权限和 `0041_release_version_management.sql`。
- 版本管理 contracts、OpenAPI、API inventory、PostgreSQL 状态机与回归测试。

### Fixed

- Production HTML smoke 将随机监听端口显式映射到 Client audience。
- 冒烟断言与未登录根页的会话验证安全边界对齐，不再要求服务端泄露交易大厅正文。

## Planned: v1.0.0-beta.1

首个受邀商业 Beta tag 只在全部发布 Gate、staging 证据和远端 CI 通过后创建；本文件不代表该版本已经部署。
