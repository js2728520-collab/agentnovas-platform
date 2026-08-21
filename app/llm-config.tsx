export function SystemLlmConfigPanel() {
  return (
    <section className="llm-config-panel" aria-labelledby="legacy-llm-config-title">
      <div className="llm-config-copy">
        <span className="eyebrow">LEGACY MODEL CONFIGURATION</span>
        <h3 id="legacy-llm-config-title">旧系统模型配置已停用</h3>
        <p>平台模型由 Maintenance 的模型 Profile 与 Agent 绑定统一管理；此处不再接受端点或密钥。</p>
      </div>
    </section>
  );
}
