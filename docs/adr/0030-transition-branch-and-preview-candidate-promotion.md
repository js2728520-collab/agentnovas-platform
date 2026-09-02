# ADR-0030：一次性过渡分支与 Preview 候选晋级

状态：Accepted

日期：2026-09-02

关联：ADR-0014、ADR-0016、ADR-0024

## 背景

仓库已经以 SemVer tag、完整 commit、镜像 digest 和迁移版本定义正式发布身份，也已经实现默认关闭的受限部署控制面。当前仍缺少一条适合日常迭代的中间路径：先把 main 的候选变更放到可审阅分支，在三个测试域名验证，再由人决定是否合并和创建正式 tag。

直接从 main 自动部署会把代码合并和环境变更耦合；复用 production 的受限部署工作流又会在 G7 未完成时虚假扩大授权。把长期 SSH 或 Docker 凭证放入 GitHub Actions 同样违反 ADR-0024 的凭证分域和目标侧 fencing。

## 决策

1. 每个候选版本建立一次性 `codex/release-transition-vX.Y.Z` 分支，必须从当时的 main 创建；分支版本与根 `package.json` 完全一致，且高于仓库全部正式 SemVer tag。
2. PR 是 main 的唯一常规晋级入口。`verify` 与 `quality-release` 必须成功，未解决会话必须清零；仓库管理员保留事故处置能力，但不得用它跳过候选验收。
3. 过渡分支 push 触发 `.github/workflows/preview-candidate.yml`。工作流先执行测试、类型、lint、三端构建、包打包、安全边界和依赖审计，再生成四张 Preview 专用镜像及聚合 manifest。
4. 候选镜像只使用 `candidate-<version>-<40位commit>` 标签，同时保存 digest、运行时版本、迁移版本和聚合 SHA-256；不创建或覆盖正式 SemVer tag，不生成 `latest`。
5. 工作流只生产可交付制品，不持有服务器 SSH、数据库或 Docker 管理凭证，也不自动部署任何环境。Preview 部署继续由获授权操作者按 Runbook 从精确 digest 执行，并保留 current/previous、备份、健康和浏览器证据。
6. main 不自动部署。三个测试域名验收通过后，需求方先审阅证据，再手动合并 PR；若 main 已前进，候选分支先 rebase 并重跑全部门禁。
7. 只有合并后的 main commit 才能创建 annotated `vX.Y.Z` tag。正式 tag 触发既有容器发布工作流，使用 production audience host 重新构建正式镜像；Preview 候选不能直接改名为正式制品。
8. GitHub Actions 全部第三方 Action 固定 40 位 commit；Dependabot 只通过 PR 提议 npm 与 Actions 更新，仍受相同门禁约束。
9. Production、受限部署 profile、真实模型调用、真实交易和资金出站均不因本 ADR 解锁。ADR-0024 的 G7 和首次生产授权仍是唯一解锁条件。

## 状态流

```text
main 基线
  -> 一次性过渡分支
  -> PR + 全量 Gate
  -> 不可变 Preview 候选
  -> 三测试域名人工部署与验收
  -> 人工决定：修复 / 放弃 / 合并 main
  -> 合并后 annotated SemVer tag
  -> 正式镜像发布（不等于 production 部署）
```

任一步失败都停留在当前阶段。失败候选可以由同一分支的新 commit 取代，但旧 commit 镜像和 manifest 不覆盖；放弃候选时删除分支不删除历史 CI/制品证据。

## 分支保护与权限

- main 禁止强制推送和删除，要求分支保持最新并通过 `verify`、`quality-release`。
- CODEOWNERS 明确发布工作流、部署、ADR、Runbook 和发布脚本的责任人。
- GitHub-hosted Runner 视为不受信任执行面，只能取得当前仓库的短时 `GITHUB_TOKEN`，不得取得环境长期凭证。
- Preview 操作者必须使用目标主机既有最小权限 secret 文件和 Compose 边界；凭证、备份和验收账号文件不进入 Git、Actions artifact 或日志。

## 后果

- main 的稳定性、Preview 的可看性和正式发布身份被拆成三个可审计阶段。
- 候选工作流会增加构建时间和 GHCR 存储；候选镜像需按保留策略清理，但不能在仍作为 current/previous 时删除。
- 在受限 CI/CD 的 G7 完成前，Preview 最后一公里仍需人工执行。这是明确的安全边界，不是声称已经完全自动部署。
