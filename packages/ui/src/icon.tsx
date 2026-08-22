/**
 * 控制台图标集。
 *
 * 取代导航里的 Unicode 字符与汉字占位（"⌂" "◈" "客" "组"）——那些在
 * macOS / Windows / Android 上字形差异极大，无法统一尺寸与线宽，也没有
 * 可访问的语义。此处统一为 24×24 viewBox、1.7px 线宽的描边图标。
 *
 * 图标是装饰性的：始终 aria-hidden，语义由相邻文字承担。
 */

export type IconName =
  | "dashboard" | "hall" | "paper" | "lab" | "chart" | "store"
  | "crown" | "coins" | "receipt" | "wallet" | "deposit" | "book"
  | "users" | "org" | "database" | "file" | "percent" | "calculator"
  | "check-square" | "key" | "audit" | "shield" | "bell" | "inbox"
  | "activity" | "cpu" | "plug" | "pause" | "settings" | "tag"
  | "chevron-right" | "check" | "alert" | "info" | "menu" | "sun" | "moon" | "logout";

const paths: Record<IconName, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  hall: <><circle cx="12" cy="12" r="2.5" /><path d="M16.5 7.5a6.4 6.4 0 0 1 0 9M7.5 16.5a6.4 6.4 0 0 1 0-9" /><path d="M19.8 4.2a11 11 0 0 1 0 15.6M4.2 19.8a11 11 0 0 1 0-15.6" /></>,
  paper: <><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6M3 12h18" /></>,
  lab: <><path d="M9.5 3v6.2L4.3 18a2 2 0 0 0 1.7 3h12a2 2 0 0 0 1.7-3l-5.2-8.8V3" /><path d="M8.5 3h7M7.2 14.5h9.6" /></>,
  chart: <><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="m7 15 3.5-4 3 2.5L21 6" /></>,
  store: <><path d="M3.5 10v9A1.5 1.5 0 0 0 5 20.5h14a1.5 1.5 0 0 0 1.5-1.5v-9" /><path d="M2.5 7.2 4.2 3.6A1 1 0 0 1 5.1 3h13.8a1 1 0 0 1 .9.6l1.7 3.6a2.6 2.6 0 0 1-4.75 2.1 2.6 2.6 0 0 1-4.75 0 2.6 2.6 0 0 1-4.75 0A2.6 2.6 0 0 1 2.5 7.2Z" /></>,
  crown: <path d="M3 7.5 6.5 13 12 4.5 17.5 13 21 7.5V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  coins: <><circle cx="9" cy="9" r="6" /><path d="M15.5 4.2a6 6 0 0 1 0 15.6M12 15.6A6 6 0 0 0 18 21" /></>,
  receipt: <><path d="M5 21V4a1 1 0 0 1 1.5-.87L9 4.5l2.5-1.4a1 1 0 0 1 1 0L15 4.5l2.5-1.37A1 1 0 0 1 19 4v17l-2.5-1.37a1 1 0 0 0-1 0L13 21l-2.5-1.37a1 1 0 0 0-1 0Z" /><path d="M9 8.5h6M9 12.5h6" /></>,
  wallet: <><path d="M20 8V6.5A1.5 1.5 0 0 0 18.5 5H5a2 2 0 0 0 0 4h14.5A1.5 1.5 0 0 1 21 10.5v7A1.5 1.5 0 0 1 19.5 19H5a2 2 0 0 1-2-2V7" /><circle cx="16.5" cy="14" r="1.1" fill="currentColor" stroke="none" /></>,
  deposit: <><path d="M12 3v11m0 0 4-4m-4 4-4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>,
  book: <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5Z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v4H6.5A2.5 2.5 0 0 1 4 19.5Z" /></>,
  users: <><circle cx="9" cy="8" r="3.4" /><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0M16.5 5.2a3.4 3.4 0 0 1 0 6.6M18 14.4a6.2 6.2 0 0 1 3.2 5.6" /></>,
  org: <><rect x="9" y="2.5" width="6" height="5" rx="1" /><rect x="2.5" y="16.5" width="6" height="5" rx="1" /><rect x="15.5" y="16.5" width="6" height="5" rx="1" /><path d="M12 7.5v4M5.5 16.5v-2a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v2" /></>,
  database: <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M8.5 13h7M8.5 17h4" /></>,
  percent: <><path d="M19 5 5 19" /><circle cx="7.5" cy="7.5" r="2.8" /><circle cx="16.5" cy="16.5" r="2.8" /></>,
  calculator: <><rect x="4" y="2.5" width="16" height="19" rx="2" /><path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16.5h.01M12 16.5h.01M16 16.5h.01" /></>,
  "check-square": <><path d="M20 11.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /><path d="m8.5 11.5 3 3L21 5" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8 2.5 2.5M17 6l2 2" /></>,
  audit: <><circle cx="11" cy="11" r="7" /><path d="m20.5 20.5-4.2-4.2M8.5 11l1.8 1.8 3.5-3.6" /></>,
  shield: <><path d="M12 21s7-3.2 7-9V5.6L12 3 5 5.6V12c0 5.8 7 9 7 9Z" /><path d="m9.2 12 2 2 3.6-3.8" /></>,
  bell: <><path d="M18 8.5a6 6 0 1 0-12 0c0 5-2.2 6.5-2.2 6.5h16.4S18 13.5 18 8.5" /><path d="M13.7 19a2 2 0 0 1-3.4 0" /></>,
  inbox: <><path d="M20 12h-5l-1.5 2.5h-3L9 12H4" /><path d="M6.2 4.5h11.6a2 2 0 0 1 1.85 1.24L21 12v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l1.35-6.26A2 2 0 0 1 6.2 4.5Z" /></>,
  activity: <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>,
  plug: <><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6Z" /><path d="M12 17v5" /></>,
  pause: <><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>,
  settings: <><circle cx="12" cy="12" r="3.2" /><circle cx="12" cy="12" r="7.4" /><path d="M12 1.6v3M12 19.4v3M22.4 12h-3M4.6 12h-3M19.35 4.65l-2.12 2.12M6.77 17.23l-2.12 2.12M19.35 19.35l-2.12-2.12M6.77 6.77 4.65 4.65" /></>,
  tag: <><path d="M3 12.4V4a1 1 0 0 1 1-1h8.4a2 2 0 0 1 1.4.6l6.6 6.6a2 2 0 0 1 0 2.8l-8.4 8.4a2 2 0 0 1-2.8 0L3.6 13.8a2 2 0 0 1-.6-1.4Z" /><circle cx="7.8" cy="7.8" r="1.3" /></>,
  "chevron-right": <path d="m9 5 7 7-7 7" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  alert: <><path d="M10.3 3.8 2.5 17.2a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4.5M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 8 6 12l4 4M6 12h10" /></>,
};

export function isIconName(value: string): value is IconName {
  return Object.prototype.hasOwnProperty.call(paths, value);
}

export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  return <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >{paths[name]}</svg>;
}
