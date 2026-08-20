"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="zh-CN">
      <body>
        <main className="riverton-system-state" role="alert">
          <p className="riverton-system-kicker">应用错误</p>
          <h1>应用暂时无法打开</h1>
          <p>未执行任何外部支付或交易操作。请重试。</p>
          <button className="riverton-system-action" type="button" onClick={() => reset()}>
            重试
          </button>
        </main>
      </body>
    </html>
  );
}
