# 过渡分支、Preview 晋级与回滚 Runbook

状态：`CURRENT_BASELINE`

## 1. 发布通道

| 通道 | 输入 | 自动动作 | 明确不做 |
| --- | --- | --- | --- |
| PR 验证 | 任意目标为 main 的 PR | 完整 Node/PostgreSQL、三端构建、E2E 与质量证据 | 不发布镜像、不部署 |
| Preview 候选 | `codex/release-transition-vX.Y.Z` push | 验证后发布 commit 唯一的四镜像和 manifest | 不使用 SSH、不部署 main/production |
| 正式制品 | 合并后 main 上的 annotated `vX.Y.Z` tag | 发布 production-host 镜像、SBOM、provenance 和 manifest | 不自动部署 production |

main 不自动部署。过渡分支确认无误后，只允许需求方或获授权维护者手动 fast-forward/通过 GitHub PR 合并到 main；本 Runbook 不授权自动合并。

## 2. 建立候选

1. 确认 main 与 `origin/main` 一致、工作区干净，确定下一个未使用的 SemVer。
2. 从 main 建立 `codex/release-transition-vX.Y.Z`；同步根 `package.json`、lockfile 和 Changelog。
3. 运行 `npm run release:candidate-identity`。分支名、版本、完整 SHA、未发布状态或 Changelog 任一不匹配都必须停止。
4. 提交并推送过渡分支，创建目标为 main 的 PR，但不启用自动合并。
5. 等待 PR 的 `verify`、`quality-release` 与 Preview candidate workflow 全绿，下载并核对 manifest 的四张 image digest 和 `artifactSha256`。

## 3. Preview 部署前 Gate

- 只允许三个测试域名和 Compose project `agentnovas-riverton-preview`；production 域名、3100–3102 正式容器和正式数据库不在范围。
- 当前 `current`、`previous`、容器 image ID、数据库 migration registry 和 Worker 状态先保存为证据。
- 迁移集合变化时必须先生成 `0600` PostgreSQL custom dump，验证 SHA-256、TOC 和恢复方案；只执行向前兼容迁移。
- 镜像必须按 manifest digest 拉取或在精确 commit 的干净 checkout 构建。禁止 `latest`、浮动 tag 和工作区临时内容。
- 外部写入开关沿用当前 Preview 配置；不得因部署候选自动启用模型、交易、资金、邮件或 Provider 调用。

## 4. 切换与验证

1. 建立新的只读 release 目录，保存 compose、Preview override、manifest 和非秘密证据；不要覆盖旧目录。
2. 在不删除 PostgreSQL volume 的前提下先执行 Compose config 预检，再应用必要迁移和最小角色模板。
3. 只重建候选涉及的服务。三端 Web 按 Client → Operations → Maintenance 验证 live、ready、login、正确 Host 200 与错误 Host 404。
4. 验证容器 image digest、完整 commit、restart=0、日志无新增 error marker；后台 Worker 和外部写入状态必须与部署前一致。
5. 使用隔离验收账号完成三端登录、主要导航、关键页面、四断点、console/page error、失败响应、跨 audience Cookie 和 axe 检查。
6. 稳定性采样通过后，原子更新 `previous` 为旧 current、`current` 为新 release；保存 HTTP、浏览器、迁移、角色和镜像证据。

## 5. 回滚

若 config、迁移、健康、Host、登录、浏览器或稳定性任一 Gate 失败：

1. 停止继续切换，保留失败容器、日志和 release 目录用于诊断。
2. 使用 `previous` 中记录的精确镜像和配置只重建应用服务；不得执行数据库 down migration。
3. 再次验证三 Host、登录、容器 digest、数据库角色和 Worker 状态。
4. 不执行 `docker compose down --volumes`，不删除 Preview PostgreSQL volume，不把失败候选标记为成功。

## 6. 人工合并与正式 tag

Preview 验收通过后提交：PR URL、CI run、candidate manifest、当前/previous、备份、三端 HTTP/浏览器和外部写入关闭证据。需求方明确确认后才合并：

1. main 未前进时通过 GitHub PR 手动合并；需要线性历史时选择 rebase/fast-forward 语义。
2. main 已前进时把过渡分支 rebase 到最新 main，重新执行全部 Gate 和 Preview 验收，不沿用旧证据。
3. 合并后再从 main 创建 annotated `vX.Y.Z` tag；确认 tag commit、package version 和 Changelog 一致后推送。
4. Tag workflow 成功只表示正式制品已生成，不表示 production 已部署。

分支删除、候选镜像清理和测试账号轮换都在 main 合并确认后另行执行；current/previous 引用中的候选镜像不得提前删除。
