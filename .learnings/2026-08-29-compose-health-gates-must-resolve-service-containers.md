# Learning: Compose 健康门禁必须解析实际服务容器

**Date**: 2026-08-29
**Type**: error
**Agent**: Codex

## Context

M1.2 测试站滚动部署使用 Compose 重建 Client、Operations 与 Maintenance，并在切换后等待三个服务通过健康检查。

## Problem/Issue

门禁脚本按项目名和服务名拼出了 `agentnovas-riverton-preview-client` 等容器名，但 Compose 实际创建的是带实例序号的 `agentnovas-riverton-preview-client-1`。检查因此持续得到 `missing`，把健康运行的新容器误判为失败并触发安全回滚。回滚正常完成，数据库、Worker 和生产环境均未受影响。

## Solution

先检查实际 Compose 容器并确认上一版本三个服务均为 `healthy`、零重启，再改用 `docker compose ps --format json` 或 Compose 返回的容器 ID解析服务状态，不再手工推导容器名。

## Key Insights

- Compose 容器名属于编排器实现细节，可能包含实例序号或自定义 `container_name`。
- 健康门禁应以服务为主键，通过 Compose 查询实际容器，而不是拼接字符串。
- 自动回滚必须继续保留；误报时它仍然保证测试站停留在已验证版本。

## Prevention

所有预览部署先运行 `docker compose ps --format json` 并确认三项服务都能被解析；健康循环从 Compose 服务查询状态，门禁证据同时记录服务、实际容器和镜像 ID。
