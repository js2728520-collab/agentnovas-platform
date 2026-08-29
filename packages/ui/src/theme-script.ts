/**
 * 主题引导脚本 —— 刻意独立成一个不含 React、不含 JSX、不带 "use client"
 * 的模块。
 *
 * app/layout.tsx 是服务端组件且被每个页面共享；如果从 theme-toggle.tsx
 * （客户端组件，还引着整套图标）里 import 常量，整个模块会被拖进所有页面
 * 的公共包，公开落地页也不例外，直接把 client 的 JS 预算顶爆。
 */

export const THEME_STORAGE_KEY = "riverton-theme";
export const PALETTE_STORAGE_KEY = "riverton-palette";
export const PLATFORM_LOCALE_STORAGE_KEY = "riverton.platform-locale";
export const appLocaleCookieName = (audience: "client" | "operations" | "maintenance") => `rv_locale_${audience}`;

export type ThemeMode = "system" | "light" | "dark";
export type ThemePalette = "classic" | "harbor" | "forest";

export const themeModes = ["system", "light", "dark"] as const;
export const themePalettes = ["classic", "harbor", "forest"] as const;

/**
 * 在 <head> 内联执行，必须早于首帧绘制，否则暗色用户会看到一次白闪。
 * 只写 data-theme 属性；具体颜色由 app/design-tokens.css 决定。
 * 未做选择时不写属性，交给 prefers-color-scheme 处理（跟随系统）。
 */
export const themeBootstrapScript = `(function(){try{var r=document.documentElement,t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}),p=localStorage.getItem(${JSON.stringify(PALETTE_STORAGE_KEY)});if(t==="light"||t==="dark"){r.setAttribute("data-theme",t)}else{r.removeAttribute("data-theme")}if(p==="harbor"||p==="forest"){r.setAttribute("data-palette",p)}else{r.removeAttribute("data-palette")}}catch(e){}})()`;

export function appPreferenceBootstrapScript(input: {
  audience: "client" | "operations" | "maintenance";
  preference?: { locale: string; themeMode: ThemeMode; themePalette: ThemePalette } | null;
}) {
  const encoded = JSON.stringify(input.preference ?? null);
  const audience = JSON.stringify(input.audience);
  return `(function(){try{var r=document.documentElement,s=${encoded},a=${audience},t,p,l;if(s){t=s.themeMode;p=s.themePalette;l=s.locale;localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)},t);localStorage.setItem(${JSON.stringify(PALETTE_STORAGE_KEY)},p);localStorage.setItem(${JSON.stringify(PLATFORM_LOCALE_STORAGE_KEY)},l)}else{t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});p=localStorage.getItem(${JSON.stringify(PALETTE_STORAGE_KEY)});l=localStorage.getItem(${JSON.stringify(PLATFORM_LOCALE_STORAGE_KEY)});var c=["en-US","zh-CN","zh-TW","ru-RU","es-ES","ja-JP","ko-KR"],i=["zh-CN","en-US"],o=a==="client"?c:i;if(o.indexOf(l)<0){l=a==="client"?null:"zh-CN"}if(!l&&a==="client"){var n=navigator.languages||[navigator.language||""];for(var x=0;x<n.length&&!l;x++){var q=String(n[x]).replace("_","-").toLowerCase();for(var y=0;y<c.length;y++){var z=c[y].toLowerCase();if(q===z||q.split("-")[0]===z.split("-")[0]){l=c[y];break}}}l=l||"en-US"}}if(t==="light"||t==="dark"){r.setAttribute("data-theme",t)}else{r.removeAttribute("data-theme")}if(p==="harbor"||p==="forest"){r.setAttribute("data-palette",p)}else{r.removeAttribute("data-palette")}r.lang=l||((a==="client")?"en-US":"zh-CN");document.cookie="rv_locale_"+a+"="+encodeURIComponent(r.lang)+"; Path=/; Max-Age=31536000; SameSite=Lax"}catch(e){}})()`;
}
