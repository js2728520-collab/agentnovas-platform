# 平台语言偏好合同规格

状态：`TARGET/PARTIAL_CURRENT`；T3.11a 公开 Client 着陆页解析合同实施中，全站/三端/邮件一致性待 T3.11b
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
