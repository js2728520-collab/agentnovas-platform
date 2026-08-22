"use client";

import { useSyncExternalStore } from "react";

import { Icon } from "./icon";
import { THEME_STORAGE_KEY } from "./theme-script";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * 生效主题是一份外部状态：它同时由 documentElement 上的 data-theme 属性
 * 和系统偏好决定，两者都在 React 之外变化。用 useSyncExternalStore 订阅，
 * 而不是在 effect 里 setState —— 后者会触发级联渲染，也读不到首帧前
 * 由内联脚本写入的属性。
 */
function subscribe(onChange: () => void) {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    media.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

function getSnapshot(): "light" | "dark" {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** 服务端与 hydration 首帧一律按浅色渲染，随后由客户端快照校正。 */
function getServerSnapshot(): "light" | "dark" {
  return "light";
}

/**
 * 主题切换。三态：显式浅色 / 显式暗色 / 跟随系统（不写 data-theme）。
 * 点击在浅↔暗之间切换并落盘，因此点击后始终是显式状态。
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const dark = theme === "dark";

  function toggle() {
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 隐私模式下 localStorage 不可写；本次会话内切换仍然生效。
    }
  }

  return <button
    className="rc-icon-btn"
    type="button"
    onClick={toggle}
    title={dark ? "切换到浅色" : "切换到暗色"}
    aria-label={dark ? "切换到浅色主题" : "切换到暗色主题"}
  ><Icon name={dark ? "sun" : "moon"} /></button>;
}
