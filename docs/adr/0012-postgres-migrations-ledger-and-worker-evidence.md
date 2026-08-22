# ADR-0012: PostgreSQL 迁移、账本和运行证据采用单一生产真源

状态：Accepted  
日期：2026-08-20

## 决策

`postgres/migrations` 是唯一生产 schema 真源。迁移器保存 version/checksum/commit SHA，使用 advisory lock 和每文件事务。账本由唯一 posting service 写入，保证同币种借贷平衡、来源幂等、账户锁定、wallet version CAS 和 append-only/reversal。Worker 以数据库 heartbeat/last success/failure/current job 证明运行，不以 env 开关代替健康。

## 结果

- fresh、N-1、rerun、checksum mismatch、并发与恢复是发布门禁。
- 三端、Worker 和 migrator 使用不同最小数据库角色。
- public health 只粗粒度；详细状态受 Maintenance RBAC 保护。
- 数据库只执行前向兼容 expand/contract；本实施阶段不运行生产迁移。

