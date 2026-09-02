# Release Engineering 长期路线图

状态：`CURRENT_TARGET`

## 目标架构

发布体系长期保持“版本身份、制品生产、环境变更、业务批准”四域分离。每个域只持有完成自身职责所需的最小权限，任何单一 Runner、Web 进程或维护者都不能同时伪造批准与目标部署成功。

## 阶段

### R0：过渡分支与人工 Preview（当前）

- 一次性版本过渡分支、PR 全量 Gate、commit 唯一候选镜像、人工 Preview 部署和可验证回滚。
- main 分支保护、CODEOWNERS、Dependabot、Action commit pinning。
- 完成定义：候选 PR 绿、三个测试域名验收、main 未自动变更、Production 未触碰。

### R1：可重复 Preview 交付

- 把当前人工命令收敛为目标主机上的窄 schema adapter，不接收任意 shell、路径或 Compose 参数。
- 为候选制品增加签名/attestation 验证、保留期和 current/previous 引用保护。
- 自动生成匿名化部署证据包；账号凭证与数据库备份继续排除在 artifact 外。

### R2：Staging 受限部署 G7

- 完成 ADR-0024 所需 GitHub App、OIDC、environment、ephemeral runner、目标侧 generation/CAS、签名 receipt、双人 activation 和事故演练。
- 先仅开放 staging deploy/rollback，故障注入覆盖未知 dispatch、Runner 失陷、迟到回调、并发切流和凭证轮换。
- 不满足任一 G7 证据时失败关闭并回到 R1 人工流程。

### R3：Production 人工批准的受限部署

- 需求方单独授权首次 production enablement；Maker/Checker、recent MFA、环境批准和目标回执同时成立。
- Progressive delivery、SLO/error-budget、自动健康停止和人工回滚；不基于不可信 Runner 日志改变 current。
- 真实交易、资金、模型 Provider 与发布授权保持独立，不由 CI/CD 自动开启。

## 周期性维护

- 每周：Dependabot PR、Action pin 漂移、npm audit、secret scan。
- 每月：Preview 回滚演练、备份恢复抽样、候选镜像引用/保留审计、权限漂移检查。
- 每季度：Node/PostgreSQL/Next 升级窗口、Runner/供应链威胁复审、灾难恢复演练和 ADR/Runbook 对账。
- 每次发布：SemVer/commit/digest/migration 四元身份、Changelog、PR Gate、Preview 浏览器证据和人工批准。

## 度量

- Change failure rate、候选到 Preview lead time、Preview 到 main 决策时间、回滚恢复时间。
- CI 首次通过率、flaky retry 数、依赖修复时长、候选制品保留违规数。
- 所有度量只用于改进交付，不得替代安全门禁或把失败隐藏为成功。
