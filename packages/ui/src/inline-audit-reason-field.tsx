export function InlineAuditReasonField({
  id,
  value,
  onChange,
  minLength = 3,
  label = "操作原因",
  hint = "原因会随本次操作写入审计记录。",
  className = "rc-wide-field",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
  label?: string;
  hint?: string;
  className?: string;
}) {
  const hintId = `${id}-hint`;
  return (
    <label className={className} htmlFor={id}>
      {label}
      <textarea
        aria-describedby={hintId}
        id={id}
        maxLength={500}
        minLength={minLength}
        onChange={(event) => onChange(event.target.value)}
        placeholder="请填写可审计的业务原因"
        required
        rows={2}
        value={value}
      />
      <small id={hintId}>{hint} 至少 {minLength} 个字符。</small>
    </label>
  );
}

export function hasValidAuditReason(value: string, minLength = 3) {
  const length = value.trim().length;
  return length >= minLength && length <= 500;
}
