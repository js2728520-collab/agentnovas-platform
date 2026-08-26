# 平台主题偏好合同规格

状态：`CONFIRMED/PLANNED`；T3.10b 尚未实现或通过体验 Gate
日期：2026-08-26
上位真源：`../product/PRD.md` 第 10、15 节；`../../packages/contracts/src/product-parameters.ts` 的 P-10

## 1. 产品决定与范围

T3.10b 直接完成三组浅深主题、偏好持久化和应用工作区体验，不再交付临时的
`system | light | dark` 单轴模型。

- 主题系列为 `riverton / neutral / high-contrast`。
- 明暗偏好为 `system / light / dark`；默认 `riverton + system`。
- `system` 只切换明暗，不改变用户选择的主题系列。
- 六个最终主题为 `riverton-light`、`riverton-dark`、`neutral-light`、`neutral-dark`、
  `high-contrast-light`、`high-contrast-dark`。
- Client Portal、Operations 和 Maintenance 应用工作区使用本合同。
- 三端登录页消费已保存主题但不展示主题选择器。
- Client 公开营销落地页继续使用独立单一深色品牌视觉，不消费应用主题偏好。

本合同不改变 S0 Paper/Demo 发布范围，不启用真实现货、永续、资金出站或 Maintenance CI/CD。

## 2. 偏好模型与存储

```ts
type ThemeFamily = "riverton" | "neutral" | "high-contrast";
type ThemeModePreference = "system" | "light" | "dark";

type ThemePreferenceV1 = {
  version: 1;
  family: ThemeFamily;
  mode: ThemeModePreference;
};
```

- 本地存储键继续使用 `riverton-theme`，值为单个版本化 JSON 对象。
- 主题是设备/浏览器偏好，不进入账号、API 或数据库，也不跨三个应用域共享。
- 同一应用的同源标签页通过标准 `storage` 事件实时同步。
- 旧字符串 `"light"`、`"dark"` 分别迁移为 `riverton + light/dark`，并在可写时回存 v1。
- 缺失值、非法 JSON、未知版本、非法 family/mode 或超出合同的值回退为 `riverton + system`；
  非法持久化值在可删除时清除。
- storage 读取、写入或删除异常不得阻断页面。写入失败时只保证当前会话行为，不声称刷新后持久化。
- 原始持久化内容不得影响 CSS 变量名、HTML 属性名、脚本片段或模块路径。

## 3. 生效主题与 DOM 合同

`data-theme` 只表达最终生效主题，合法值严格限于六个主题 ID。不得写
`data-theme="system"`，也不得把未验证的 storage 内容直接写入 DOM。

- 显式 light/dark 不受 `prefers-color-scheme` 后续变化覆盖。
- system 根据媒体查询解析同一 family 的 light/dark；系统变化时更新最终 `data-theme`。
- 首帧 bootstrap 在 `<head>` 内通过 CSP nonce 执行，读取并规范化偏好后写最终主题 ID。
- bootstrap 必须保持轻量，不导入 React、JSX、账户、locale 或 audience 业务逻辑。
- 脚本不可用、被策略阻断或 storage 不可读时，CSS 以默认 Riverton family 和
  `prefers-color-scheme` 提供可读 fallback。
- 根布局继续使用 `suppressHydrationWarning` 和每请求 nonce；不得为主题读取引入服务端账号依赖。

## 4. UI 与语言边界

登录后的工作区使用两个原生、带可见标签的 `<select>`：

1. 主题系列：Riverton、Neutral、High Contrast。
2. 显示模式：跟随系统、浅色、深色。

- Client Portal 通过 T3.11b2 locale provider 传入七语言 labels。
- Operations/Maintenance 传入中文 labels。
- 共享主题组件只接收 labels，不自行判断 audience 或 locale。
- 原生控件必须支持键盘、可见焦点、读屏名称和移动端；不增加菜单状态机或第三方依赖。
- 高对比主题须满足 WCAG 对比度要求，并保留 `forced-colors` 可用性。
- 主题切换不得制造影响可读性的动画；任何过渡须尊重 `prefers-reduced-motion`。

## 5. 设计令牌与资源

- `app/design-tokens.css` 继续作为应用工作区唯一颜色真源。
- 三组浅深主题必须覆盖表面、正文、边框、交互、语义状态、涨跌、图表、骨架和焦点令牌。
- 先按已确认 P-10 使用现有品牌色派生；正式设计资产到位后可以替换数值，但不得改变主题 ID、
  偏好 schema 或历史语义。
- Logo 和状态色必须验证六主题可读性，不能只靠颜色传达状态。
- Client 营销落地页的私有令牌不并入应用主题，也不作为六主题通过证据。

## 6. 完成标准

- 纯合同测试覆盖 schema、默认值、旧值迁移、非法值、六主题解析和 storage 异常。
- bootstrap 测试覆盖六个最终 ID、system、非法输入、CSP nonce 和不可执行内容隔离。
- 真实 Chromium 覆盖 Client Portal、Operations、Maintenance 的三个 family、三个 mode、刷新、
  system 媒体变化、同源标签页同步、登录页消费、四断点、键盘、axe 和 clean console/hydration。
- 三端 production build 完成后再执行 bundle budget；Client 新代码不得挤破既有预算。
- 本地验证只构成开发证据，不表示完整 G8、生产批准、部署或高风险能力解锁。
