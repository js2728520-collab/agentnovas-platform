export default function Loading() {
  return (
    <main className="riverton-system-state" role="status" aria-live="polite" aria-busy="true">
      <span className="riverton-system-spinner" aria-hidden="true" />
      <h1>正在加载</h1>
      <p>正在读取当前应用与权限，请稍候。</p>
    </main>
  );
}
