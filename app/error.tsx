"use client";

export default function ErrorState({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="riverton-system-state" role="alert">
      <p className="riverton-system-kicker">请求未完成</p>
      <h1>页面暂时不可用</h1>
      <p>数据没有被修改。请重试；如果问题持续，请联系当前应用管理员。</p>
      <button className="riverton-system-action" type="button" onClick={() => reset()}>
        重新加载
      </button>
    </main>
  );
}
