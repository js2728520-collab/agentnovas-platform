# Learning: rsync 多源同步必须使用明确目录目标

**Date**: 2026-08-29
**Type**: error
**Agent**: Codex

## Context

M1.2 远端验证期间，需要把 Operations 与 Maintenance 的两份增量文件同步到一次性验证目录。

## Problem/Issue

一次 `rsync` 调用同时提供两个源文件，却把目标写成了带文件名的歧义路径。`rsync` 将该路径创建为目录，并在其中放入两份错误副本。正式源码、测试站和正确的远端文件均未被覆盖，但一次性验证目录被多余文件污染。

## Solution

先用只读 `find` 和 `sha256sum` 精确确认影响范围，再校验目标位于受控 `/tmp/agentnovas-m1-s2.*` 前缀下并删除该错误目录。随后每个源文件分别使用完整、明确的目标文件路径同步。

## Key Insights

- `rsync source-a source-b host:/path/name.tsx` 会把最后一段当作目录，而不是共同的目标文件。
- 多应用文件不能为了少一次 SSH 往返而共用看似文件名的目标。
- 验证目录也要在继续构建前检查是否出现非仓库路径，避免无意进入构建上下文。

## Prevention

多个源文件只有在目标明确以 `/` 结尾且确实是共同目录时才合并同步；跨应用增量默认逐文件执行，并在同步后对源、目标分别计算 SHA-256。

## See Also

- `.learnings/2026-08-27-remote-node-container-and-zsh-status.md`
