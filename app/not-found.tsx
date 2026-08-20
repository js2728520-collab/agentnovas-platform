import Link from "next/link";

export default function NotFound() {
  return (
    <main className="riverton-system-state">
      <p className="riverton-system-kicker">404</p>
      <h1>页面不存在</h1>
      <p>当前应用没有这个页面，或你的入口域名不正确。</p>
      <Link className="riverton-system-action" href="/">
        返回当前应用
      </Link>
    </main>
  );
}
