# 平台语言偏好合同规格

状态：`TARGET/PARTIAL_CURRENT`；T3.11a 公开 Client 着陆页解析合同已实现，全站/三端/邮件一致性待 T3.11b
日期：2026-08-24
上位真源：`../product/PRD.md` 第 10 节；`V3_CLIENT_APP_TARGET_SPEC.md` 第 11 节

## 1. 目标与本切片边界

T3.11a 建立唯一语言 allowlist 和确定性优先级，使公开 Client 着陆页满足：

1. 已保存且受支持的匿名偏好优先。
2. 没有合法偏好时，按浏览器 `navigator.languages` 顺序选择首个受支持语言。
3. 两者均无匹配时回退 `en-US`，首屏也默认英语。
4. 只使用浏览器语言，不采集或推断 IP、GPS、城市、时区或设备指纹。
5. 用户选择只保存 allowlist 中的 canonical locale；非法、超长或损坏存储值被忽略。
6. 非英语字典继续按需加载，不把七种语言全部加入公开首屏 bundle。

T3.11a 不声称已完成已登录 Client、Operations、Maintenance、认证页、错误页、邮件、法律正文
或格式化器的全站翻译，也不改变 Maintenance `defaultLocale` 的产品语义。以上属于 T3.11b，等待
需求方确认语言覆盖、三端偏好范围与 Maintenance override 规则。

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
差异检查通过。实现提交 `81b86bc`。T3.11b 的数据库偏好、三端/认证/错误页/邮件与完整翻译范围
仍等待需求确认，不能由本切片推导为完成。

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

在完整三端偏好语义确认前，可以先完成不会改写既有用户的数据库底座：

- forward migration 把 `users.locale` 的新行默认值从 `zh-CN` 改为 `en-US`，与 PRD fallback 一致。
- 新增七语言 CHECK 为 `NOT VALID`：迁移后所有新写入/更新都必须在 allowlist 内，但不因历史未知值
  阻断上线，也不把历史账号静默改成英语。
- migration 必须可重复执行；同一事务内重建约束，不暴露无约束窗口。
- SQLite/Drizzle 兼容 schema 的新行默认同步为 `en-US`；历史 migration 文件保持不可变。
- 实际 PostgreSQL 测试覆盖旧中文默认升级、历史非标准值保留、七种合法值、新非法值拒绝和重放。

本切片不提供用户修改 API，不决定偏好跨三端还是仅 Client，也不把数据库 default 当成已保存的
显式选择。已有账号继续保持原值，后续只有在需求方确认的 UI/API 中由用户主动更新。
