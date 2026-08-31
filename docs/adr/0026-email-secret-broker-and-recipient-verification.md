# ADR-0026：邮件密钥 Broker 与独立测试收件人

状态：Accepted
日期：2026-08-29
替代范围：ADR-0025 中“网页不能发起密钥安装/轮换”和“测试地址等于当前操作者邮箱”两项决定；其余投递状态、审计和失败关闭决定继续有效。

## 背景

邮件服务页只展示环境变量是否存在，不能完成配置；测试地址又隐式绑定当前 Maintenance 账号。操作者无法回答“如何配置、测试发给谁、配置是否已应用、最终是否送达”。

让 Maintenance Web 直接持有 Resend API Key、Broker 私钥或主机写权限会把公网 Web 进程变成高权限密钥代理，不可接受。把密钥明文写入数据库、日志、审计或浏览器回显同样不可接受。

## 决策

1. 新增独立 Email Secret Broker。Broker 使用独立数据库角色、独立 RSA-OAEP 私钥、独立进程身份，并且只能写两份专用邮件密钥文件；它不能读取其他应用密钥，也不暴露 HTTP 入口。
2. Maintenance Web 只返回 Broker 的公开公钥和 key id。浏览器用临时 AES-256-GCM 加密配置，再用 RSA-OAEP/SHA-256 包装 AES 密钥；Web 和数据库只接触密文 envelope。
3. 密钥请求仅允许 `install` 或 `rotate`，必须同时提交 Resend API Key、Webhook Secret 和 3–500 字原因。API 严格校验 envelope 结构、大小、key id、权限、近期 MFA、同源和幂等；不根据密文推断秘密格式。
4. Broker 解密后严格验证 `re_…` 与 `whsec_…` 格式，使用临时文件、`fsync`、权限校验和原子 rename 更新专用文件。失败时保留上一版本，数据库只记录受限错误码。
5. Maintenance Web 与 Notification Worker 动态读取专用邮件密钥文件，并保留原环境变量作为迁移期只读回退。页面只显示是否配置、请求状态、配置指纹短标识、更新时间和操作者，不返回密文或明文。
6. 测试收件人改为独立资源。邮箱地址使用专用 AES-GCM 密钥加密保存，同时保存规范化 SHA-256、掩码和状态；该密钥只授予 Maintenance 与 Notification Worker，不复用交易、集成或 Session 密钥。
7. 收件人生命周期固定为 `pending_verification → active ↔ disabled → deleted`。新增地址后发送一次性验证码；验证码只保存 HMAC 摘要、10 分钟过期、最多 5 次尝试并可限频重发。只有已验证且未抑制的地址可用于测试投递。
8. 测试投递必须显式选择 `recipientId`。`notification_deliveries` 只保存该外键，不复制邮箱；Worker 在领取任务后解密地址。验证码模板只能投递到对应 pending 记录，普通测试模板只能投递到 active 记录。
9. 新增、重发验证码、验证、启停、删除、密钥安装/轮换和测试投递全部写追加式审计。删除为软删除；历史记录继续显示当时的安全掩码。
10. 本轮只部署测试站。正式环境继续保持关闭，真实测试或验证码邮件必须由操作者在页面明确触发；自动化验收不得暗中发送邮件。

## 进程与文件边界

- Maintenance：可读取 Broker 公钥、专用收件人加密密钥和 Webhook Secret 专用文件；不能读取 Broker 私钥和 Resend API Key。
- Notification Worker：可读取专用收件人加密密钥和 Resend API Key 专用文件；不能读取 Broker 私钥和 Webhook Secret。
- Email Secret Broker：可读取私钥和自己的数据库凭证，可写专用邮件密钥目录；不能读取其他服务环境文件。
- PostgreSQL：保存收件人密文和配置请求密文；不保存任何 Provider 密钥明文、验证码明文或 Broker 私钥。

## 失败与回滚

- Broker 不可用、心跳过期、公钥不匹配或请求失败时，页面明确显示失败；现有有效配置保持不变。
- 密钥文件更新任一步失败时不替换旧文件。两个文件必须属于同一配置版本；消费者只接受完整、校验通过的版本。
- 迁移期回退只允许发生在受管目录尚无 manifest 时；manifest 已存在后的格式、权限或校验错误一律失败关闭，不回退到可能过期的环境值。
- 收件人解密失败、未验证、已禁用、已删除或被 suppression 命中时，Worker 失败关闭并写受限错误码。
- 回滚应用版本时保留新表和旧环境变量回退，不删除密钥请求或收件人审计事实。

## 后果

- 操作者可以在 Maintenance 页面完成配置和轮换，但页面、Web 进程、数据库和日志都不会取得 Provider 明文密钥。
- 测试地址不再受账号域名或 MX 限制，且每次测试都明确选择已验证地址。
- 部署增加一个最小权限 Worker、一个密钥目录和三份独立密钥材料，Runbook 与恢复演练必须覆盖它们。
