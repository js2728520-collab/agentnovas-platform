# Learning: 预览部署的 Compose overlay 必须显式继承

**Date**: 2026-08-29
**Type**: error
**Agent**: Codex

## Context

M1.2 正式预览发布目录由仓库源码快照创建，但测试服务器还依赖仅存在于既有发布目录中的 `compose.preview.yml`。

## Problem/Issue

新发布目录首次执行 `docker compose ... config` 时找不到 `compose.preview.yml`。失败发生在容器替换之前，因此没有环境影响，但说明正式源码快照并不包含测试站完整部署输入。

## Solution

从上一份已验证发布中复制 overlay，比较源和目标 SHA-256 一致后再执行 `compose config`，确认服务和镜像解析正确才允许进入部署。

## Key Insights

- 服务器侧部署 overlay 也是发布输入，不能假设新 release 目录天然具备。
- `compose config` 是无副作用的必要前置门禁，应在任何容器替换前执行。
- 继承必须来自明确的上一份已验证 release，且要记录内容哈希。

## Prevention

发布流程显式传入上一份已验证 overlay 的绝对路径，复制后校验 SHA-256，并把 `docker compose config --services` 与 `--images` 结果保存为发布证据。长期应把不含 Secret 的 overlay 纳入版本化部署资产。
