# 开发工具链漏洞停止项关闭记录

状态：`CLOSED`。本记录关闭 2026-08-28 / 首个付费 Beta 邀请前必须清零的 17 项开发依赖临时例外；
不构成 production 发布授权，也不替代 T9.5 真实人员演练。

## 变更

- `package.json` 增加受控 overrides：`esbuild 0.28.2`、`lighthouse 13.4.1`、`tmp 0.2.7`、
  `uuid 11.1.1`，并以 Node 22.21.1 重建 lockfile。
- `extract-zip` 已从依赖图移除；未使用 `npm audit fix --force` 提议的 drizzle-kit/LHCI 破坏性降级。
- PostgreSQL Client identity 边界测试改用每进程唯一的 Web/Auth 测试角色，避免并发文件共享全局角色。
  生产迁移和运行角色没有改变。

## 退出 Gate

| Gate | 结果 |
| --- | --- |
| 完整 dependency audit | PASS：0 vulnerability |
| 全量 Node/PostgreSQL | PASS：1449/1449；隔离复现 4 × 5/5 |
| TypeScript / ESLint / 架构边界 | PASS / PASS / 8 PASS |
| 三端 production build / Bundle | PASS / PASS；Client JS gzip 204,739 bytes，距上限 61 bytes |
| canonical Chromium/axe | PASS：20/20，external writes false |
| Lighthouse 13.4.1 | PASS：3 runs；代表运行 0.96/1.00/1.00，LCP 2436 ms、CLS 0、TBT 162 ms |
| release evidence | PASS；E2E、Bundle、Lighthouse、cleanup 一致 |

证据根目录：
`an-saas:/opt/agentnovas-riverton-preview/validations/audit-zero-20260826T1532Z/`。

- audit：`df33ebcb533ac533badec1ea3e65ed6fdd36b1bd20dde21e75e5b729abb7d9cd`
- full test：`69b3f5bf158ba36b84c7da8f40086570df39688e7a6484aa2c512f13f5d21d7a`
- type/lint/boundaries：`c972800634a3effee022baf7f344acb69b74b9d070e60cb0a796a085950bea72`
- E2E：`ebb325da72224acf8f9ae5239b0ec4f2cf6566edb4ffb39e3d9ada0fd1e6e887`
- final Lighthouse：`fe42c6263b0c43b5bc5cc8a32b8777502d4919592f38b5ff06b214905dfe24d6`
- release manifest：`3893360bdd778bf94d6911407174bfb63709b8d4e7e23af9e30eba5680b80179`

两个失败尝试作为编排证据保留：断网 build 无法取得 `next/font` 的 Geist；首次 release evidence
组合因 root 复制与 node 校验的所有权不一致触发 `EACCES`。按项目代理感知构建边界和统一所有权重跑后
通过，不归类为代码或依赖回归。
