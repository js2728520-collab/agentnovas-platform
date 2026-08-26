# 平台语言偏好合同规格

状态：`CONFIRMED/PARTIAL_CURRENT`；T3.11a 与 T3.11b1 已实现，T3.11b2 Client Portal 七语言合同已确认待实施
日期：2026-08-26
上位真源：`../product/PRD.md` 第 10 节；`V3_CLIENT_APP_TARGET_SPEC.md` 第 11 节

## 1. 目标与本切片边界

T3.11a 建立唯一语言 allowlist 和确定性优先级，使公开 Client 着陆页满足：

1. 已保存且受支持的匿名偏好优先。
2. 没有合法偏好时，按浏览器 `navigator.languages` 顺序选择首个受支持语言。
3. 两者均无匹配时回退 `en-US`，首屏也默认英语。
4. 只使用浏览器语言，不采集或推断 IP、GPS、城市、时区或设备指纹。
5. 用户选择只保存 allowlist 中的 canonical locale；非法、超长或损坏存储值被忽略。
6. 非英语字典继续按需加载，不把七种语言全部加入公开首屏 bundle。

T3.11a 不声称已完成已登录 Client、认证页、错误页、邮件、法律正文或格式化器的完整翻译。
2026-08-26 已确认 T3.11b2 的范围：Client 默认英语并支持七语言；Operations/Maintenance 保持
中文单语言；系统邮件统一英语。具体账号偏好和 Client Portal 合同见第 6 节。

## 2. 合同

- 支持语言固定为 `en-US/zh-CN/zh-TW/ru-RU/es-ES/ja-JP/ko-KR`，只有一个代码真源。
- saved preference 只接受 canonical allowlist 值；不把任意 BCP 47 值持久化。
- browser preference 可接受大小写、`_` 分隔和常见 language-only 值；`zh-Hant/zh-HK/zh-MO`
  映射 `zh-TW`，其他 `zh` 映射 `zh-CN`，其余六种语言映射平台固定 region locale。
- 最多读取 16 个浏览器候选，每项最多 35 个字符；解析不抛异常、不访问网络。
- 解析结果同时返回 `saved/browser/fallback` 来源，便于后续审计和测试，但不把浏览器原值保存到日志。
- 本地存储键使用平台命名空间，读取异常（禁用 storage、隐私模式等）降级而不阻断页面。
- 首次 hydration 后若浏览器语言命中非英语，加载对应字典并设置 `document.documentElement.lang`；
  加载失败保留当前合法语言和可读错误，不显示混合语言状态。

## 3. 测试与完成标准

- 纯合同覆盖 saved 优先、浏览器顺序、语言别名、中文 script/region、损坏值、数量/长度上限和英语回退。
- UI 合同证明英语首屏、持久化 allowlist、浏览器解析和非英语动态字典加载。
- 定向、全量、TypeScript、ESLint、架构、安全与云端三端 production build 通过。
- 公开页可见行为改变后，使用本地真实 Chromium 验证英语默认、浏览器推断、刷新持久化和非法值回退。
- T3.11a 完成后 T3.11 总任务仍保持部分完成，不把局部公开页证据扩大为全站 i18n 通过。

## 4. T3.11a 实施结果

2026-08-24 已新增唯一七语言 allowlist 和纯解析器。saved preference 只接受 canonical 值；浏览器
候选最多 16 项、每项最多 35 字符，支持大小写/下划线、language-only 和中文 script/region 映射，
最终固定回退 `en-US`。实现不读取 IP、GPS、时区或身份信息，也不记录原始浏览器语言。

公开 Client 着陆页首屏改为英语，hydration 后按匿名 localStorage 与 `navigator.languages` 加载
非英语字典；字典路径仍是编译期常量。存储不可用时页面继续工作，损坏值被忽略，自动加载和人工
选择用请求序号防止旧请求覆盖新选择。此前硬编码中文的 skip link、首页 aria、流程 aria 和 Demo
环境标签已进入七语言字典，避免英语首屏出现混合语言。

新增 7 项合同测试，定向 31/31、全量 1385/1385、TypeScript、全仓 ESLint、8 条架构边界、
三端 key-custody、repository secret scan（3076 个候选文件）、production dependency audit 0 和
差异检查通过。实现提交 `81b86bc`。这是 2026-08-24 的历史实施边界；当时尚未确认的
T3.11b 数据库偏好、三端/认证/错误页/邮件范围现已由第 6 节取代，不能由 T3.11a 推导为完成。

云端以浏览器测试提交 `d6b6c5f`、tree `259f69cb7cd592881151dc03d478b32ac0d3b287` 的 3076
文件精确 Git 归档构建，源码 archive SHA-256 为
`b738db75c7f75b2daeeb11b56af0d91d3ffc820d9e5211c2717bfd4b7407bd96`。Node 22.21.1 完成
Client 68、Operations 62、Maintenance 51 页 production build，production-only audit 为 0，
官方 nginx 1.29.8 语法通过并保留 8 条已知兼容警告。standalone 归档 SHA-256
`a9968e2ce63e544467baf7ea2d8f06349c3f0c0d73cdda2b134b8c0eaa773329` 下载前后相同。

本地以云端产物、隔离 PostgreSQL、MFA 关闭和外部写入全部禁用运行真实 Chromium 18/18。
新增旅程覆盖空存储英语 fallback、中文浏览器推断、人工西班牙语跨刷新优先和损坏存储回退；同一
套件继续覆盖三端空浏览器登录、Host/Cookie、权限链接、五设备、三端 UI 与无确认弹窗。
schema 与运行时秘密已清理，本机构建缓存恢复，本地/云端临时目录已删除；未部署。

## 5. T3.11b1 新账号数据库默认与写入边界

本节记录完整三端偏好语义确认前完成、且不会改写既有用户的数据库底座：

- forward migration 把 `users.locale` 的新行默认值从 `zh-CN` 改为 `en-US`，与 PRD fallback 一致。
- 新增七语言 CHECK 为 `NOT VALID`：迁移后所有新写入/更新都必须在 allowlist 内，但不因历史未知值
  阻断上线，也不把历史账号静默改成英语。
- migration 必须可重复执行；同一事务内重建约束，不暴露无约束窗口。
- SQLite/Drizzle 兼容 schema 的新行默认同步为 `en-US`；历史 migration 文件保持不可变。
- 实际 PostgreSQL 测试覆盖旧中文默认升级、历史非标准值保留、七种合法值、新非法值拒绝和重放。

本切片当时未提供用户修改 API，也未决定偏好跨三端还是仅 Client；数据库 default 仍不等于已保存的
显式选择。已有账号继续保持原值，后续用户主动更新合同现以第 6 节为准。

### 5.1 实施证据（2026-08-24）

forward migration `0073_platform_locale_default.sql` 已把新行默认值改为 `en-US`，以
`NOT VALID` CHECK 约束七种 canonical locale；没有更新历史用户，也没有修改既有 migration。
SQLite/Drizzle 兼容 schema 同步默认值。实际 PostgreSQL 定向测试证明旧中文默认升级、历史未知值
保留、七语言接受、新非法 INSERT/UPDATE 拒绝和 migration 重放，完整 0000–0073 migration 链、
质量 fixture、密码重置及并发 runner 共 3/3 通过。实现提交为 `bfeb9bb`。

本地全量 `npm test` 1386/1386、TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、
repository secret scan、production dependency audit 0 和 `git diff --check` 均通过。本证据仍不覆盖
T3.11b2 的已登录偏好消费与全站翻译范围。

云端使用文档提交 `93d63fe5ea5530cc50c3c0f94253760da301fdec`、tree
`487fcb9ab7d683cf1dbeb628d7fa1f263e8fb0e8` 的 3078 文件精确归档；本地与 `an-saas` 收到的
archive SHA-256 均为 `ffd92552e168e90d9cf427d22c4b75ef72f07a7ee8fecea910a5ab7258c7f50d`。
Node 22.21.1 完成 Client 68、Operations 62、Maintenance 51 页 production build，production-only
audit 为 0；官方 nginx 1.29.8 语法通过并保留 8 条已知兼容警告。一次性目录已删除，未部署。

## 6. T3.11b2 Client Portal 七语言合同（2026-08-26 已确认）

### 6.1 应用范围

- Client 公开营销页、登录/认证、错误页和已登录 Portal 默认 `en-US`，支持既有七个 canonical locale。
- Operations 和 Maintenance 保持 `zh-CN` 单语言，不加载 Client 字典，也不消费 Client 账号语言。
- 系统邮件统一英语；法律正文、用户内容和 provider 内容不机器翻译，界面显示其来源语言。
- Client 营销页可保持独立深色视觉，但语言偏好与 Client Portal 使用同一合同。

### 6.2 偏好优先级与同步

已登录 Client 的确定性优先级为：

```text
账号显式偏好 > 当前设备本地偏好 > navigator.languages > en-US
```

- 未登录时继续使用 `riverton.platform-locale` 本地偏好和浏览器解析。
- 登录后显式偏好写入账号并跨设备同步，同时镜像到当前设备，避免后续首帧回退。
- 同源 Client 标签页通过 `storage` 事件实时同步；请求使用版本/序号防止旧响应覆盖新选择。
- 登录另一个有显式偏好的账号时，以新账号为准更新本地镜像。
- 清除账号显式偏好时，同时清除本地镜像并恢复浏览器/英语解析。
- storage 异常不影响账号保存结果；当前页面继续使用用户刚选择的合法 locale。

### 6.3 数据与 API 合同

`users.locale` 的数据库默认值不等于用户主动选择。新增可空的
`locale_preference_updated_at`：`NULL` 表示没有账号显式偏好，非空表示 `users.locale` 是账号真源。
既有账号不得批量改写；保存或清除时必须在同一事务中更新 locale 与显式标记。
清除时把 `users.locale` 规范化回 `en-US` 并把显式标记置为 `NULL`；该字段随后只作为数据库默认，
前端仍按设备 > 浏览器 > 英语解析，不得把清除动作重新解释成账号显式选择英语。

新增最小 Client-only 资源：

```text
PATCH /api/account/preferences/locale
```

- 请求只接受七个 canonical locale 或 `null`；非法值返回稳定 422 error code。
- 使用现有会话、CSRF/Origin、API Policy、请求体上限和限流。
- 不要求当前密码，不撤销会话，不复用处理身份字段的 `/api/account/profile` PATCH。
- 保存返回规范化 locale、`explicit: true` 和更新时间；清除返回 `locale: null`、`explicit: false`。
  响应不返回额外账号信息或浏览器原始语言。
- 这是低风险偏好更新，不要求 recent MFA、maker/checker 或业务审计流水。

### 6.4 前端与字典边界

- 建立 Client-only locale provider；共享 allowlist 与解析器继续以 `lib/platform-locale.ts` 为唯一代码真源。
- 字典按功能 namespace/路由懒加载；营销页和 Portal 可以分包，但不得复制 locale 类型、显示名称或解析规则。
- Client 主题控件从 locale provider 接收七语言 labels；共享主题组件不判断 audience 或 locale。
- 已知服务端错误按稳定 error code 翻译；未知错误使用安全英语 fallback，不直接机器翻译任意错误原文。
- 当前 locale 必须同步到 `document.documentElement.lang`；日期、数字和货币使用对应 locale 格式化。
- 本阶段保持现有 URL 结构，不增加 locale path segment。

### 6.5 完成标准

- 纯合同覆盖账号/设备/浏览器/英语优先级、别名、非法值、清除和竞态。
- PostgreSQL 覆盖 forward migration、既有账号保留、显式标记、原子保存/清除和重放。
- API 覆盖 401/403/422、Client-only audience、CSRF、幂等与最小响应。
- 真实 Chromium 覆盖公开页、登录页、核心 Client Portal 工作区、七语言、刷新、跨设备账号模拟、
  同源标签页、正确 `lang`、格式化、四断点、键盘、axe 和 clean console/hydration。
- 局部翻译或主题 labels 不得被写成完整 T3.11b2、G8 或生产发布通过。
