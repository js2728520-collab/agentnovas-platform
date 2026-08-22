/**
 * 主题引导脚本 —— 刻意独立成一个不含 React、不含 JSX、不带 "use client"
 * 的模块。
 *
 * app/layout.tsx 是服务端组件且被每个页面共享；如果从 theme-toggle.tsx
 * （客户端组件，还引着整套图标）里 import 常量，整个模块会被拖进所有页面
 * 的公共包，公开落地页也不例外，直接把 client 的 JS 预算顶爆。
 */

export const THEME_STORAGE_KEY = "riverton-theme";

/**
 * 在 <head> 内联执行，必须早于首帧绘制，否则暗色用户会看到一次白闪。
 * 只写 data-theme 属性；具体颜色由 app/design-tokens.css 决定。
 * 未做选择时不写属性，交给 prefers-color-scheme 处理（跟随系统）。
 */
export const themeBootstrapScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()`;
