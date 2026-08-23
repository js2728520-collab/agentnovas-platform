#!/usr/bin/env bash
set +x
set -euo pipefail

secret_dir=${RIVERTON_SECRET_DIR:-/etc/agentnovas-riverton}
findings=0

fail() {
  printf 'finding=%s\n' "$1" >&2
  findings=$((findings + 1))
}

mode_of() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

value_of() {
  local file=$1 key=$2
  awk -v target="$key" '
    index($0, target "=") == 1 {
      count += 1
      if (count == 1) print substr($0, length(target) + 2)
    }
    END { if (count != 1) exit 2 }
  ' "$file"
}

required_value() {
  local file=$1 key=$2 value
  if ! value=$(value_of "$file" "$key"); then
    fail "$(basename "$file"):${key}:missing_or_duplicate"
    return 1
  fi
  if [ -z "$value" ]; then
    fail "$(basename "$file"):${key}:empty"
    return 1
  fi
}

required_boolean() {
  local file=$1 key=$2 value
  if ! value=$(value_of "$file" "$key"); then
    fail "$(basename "$file"):${key}:missing_or_duplicate"
    return 1
  fi
  case "$value" in
    true|false) ;;
    *)
      fail "$(basename "$file"):${key}:must_be_true_or_false"
      return 1
      ;;
  esac
}

optional_present() {
  local file=$1 key=$2 value
  value=$(value_of "$file" "$key" 2>/dev/null) || return 1
  [ -n "$value" ]
}

same_value() {
  local label=$1 left_file=$2 left_key=$3 right_file=$4 right_key=$5 left right
  left=$(value_of "$left_file" "$left_key" 2>/dev/null) || { fail "${label}:left_missing_or_duplicate"; return; }
  right=$(value_of "$right_file" "$right_key" 2>/dev/null) || { fail "${label}:right_missing_or_duplicate"; return; }
  if [ -z "$left" ] || [ "$left" != "$right" ]; then
    fail "${label}:mismatch"
  fi
}

for name in client operations maintenance notification runtime demo migrator execution; do
  file="$secret_dir/$name.env"
  if [ ! -f "$file" ]; then
    fail "$name.env:missing"
    continue
  fi
  mode=$(mode_of "$file")
  case "$mode" in
    400|440|600|640) ;;
    *) fail "$name.env:permissions_must_be_0400_0440_0600_or_0640" ;;
  esac
done

client="$secret_dir/client.env"
operations="$secret_dir/operations.env"
maintenance="$secret_dir/maintenance.env"
notification="$secret_dir/notification.env"
runtime="$secret_dir/runtime.env"
demo="$secret_dir/demo.env"
migrator="$secret_dir/migrator.env"

if [ "$findings" -eq 0 ]; then
  for key in DATABASE_URL CLIENT_AUTH_DATABASE_URL TRUST_PROXY_HOPS LLM_PROFILE_ENCRYPTION_KEY MFA_TOTP_ENCRYPTION_KEY NOTIFICATION_TOKEN_ENCRYPTION_KEY; do
    required_value "$client" "$key" || true
  done
  for key in DATABASE_URL TRUST_PROXY_HOPS MFA_TOTP_ENCRYPTION_KEY NOTIFICATION_TOKEN_ENCRYPTION_KEY; do
    required_value "$operations" "$key" || true
  done
  for key in DATABASE_URL PAYMENT_WEBHOOK_DATABASE_URL TRUST_PROXY_HOPS MFA_TOTP_ENCRYPTION_KEY INTEGRATION_CREDENTIAL_ENCRYPTION_KEY LLM_PROFILE_ENCRYPTION_KEY; do
    required_value "$maintenance" "$key" || true
  done
  for file in "$client" "$operations" "$maintenance"; do
    required_boolean "$file" MFA_ENFORCEMENT_ENABLED || true
  done
  for key in DATABASE_URL NOTIFICATION_WORKER_ENABLED NOTIFICATION_EMAIL_SEND_ENABLED NOTIFICATION_TOKEN_ENCRYPTION_KEY; do
    required_value "$notification" "$key" || true
  done
  for key in RESEARCH_DATABASE_URL LLM_PROFILE_ENCRYPTION_KEY; do required_value "$runtime" "$key" || true; done
  for key in DATABASE_URL INTEGRATION_CREDENTIAL_ENCRYPTION_KEY; do required_value "$demo" "$key" || true; done
  for key in DATABASE_URL POSTGRES_MIGRATION_SCHEMA GIT_COMMIT_SHA; do required_value "$migrator" "$key" || true; done

  same_value "notification_token_client_worker" "$client" NOTIFICATION_TOKEN_ENCRYPTION_KEY "$notification" NOTIFICATION_TOKEN_ENCRYPTION_KEY
  same_value "notification_token_operations_worker" "$operations" NOTIFICATION_TOKEN_ENCRYPTION_KEY "$notification" NOTIFICATION_TOKEN_ENCRYPTION_KEY
  same_value "internal_mfa_operations_maintenance" "$operations" MFA_TOTP_ENCRYPTION_KEY "$maintenance" MFA_TOTP_ENCRYPTION_KEY
  same_value "mfa_enforcement_client_operations" "$client" MFA_ENFORCEMENT_ENABLED "$operations" MFA_ENFORCEMENT_ENABLED
  same_value "mfa_enforcement_client_maintenance" "$client" MFA_ENFORCEMENT_ENABLED "$maintenance" MFA_ENFORCEMENT_ENABLED
  same_value "llm_client_maintenance" "$client" LLM_PROFILE_ENCRYPTION_KEY "$maintenance" LLM_PROFILE_ENCRYPTION_KEY
  same_value "llm_runtime_maintenance" "$runtime" LLM_PROFILE_ENCRYPTION_KEY "$maintenance" LLM_PROFILE_ENCRYPTION_KEY
  same_value "integration_demo_maintenance" "$demo" INTEGRATION_CREDENTIAL_ENCRYPTION_KEY "$maintenance" INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
fi

if [ "$findings" -eq 0 ]; then
  printf 'core_configuration=ready\n'
else
  printf 'core_configuration=invalid\n'
fi

if optional_present "$notification" RESEND_API_KEY \
  && optional_present "$maintenance" RESEND_WEBHOOK_SECRET \
  && optional_present "$notification" NOTIFICATION_EMAIL_ALLOWLIST; then
  printf 'resend_configuration=ready\n'
else
  printf 'resend_configuration=incomplete\n'
fi

udun_ready=true
for file in "$client" "$maintenance"; do
  for key in UDUN_GATEWAY_BASE_URL UDUN_MERCHANT_ID UDUN_API_KEY UDUN_CALLBACK_URL; do
    optional_present "$file" "$key" || udun_ready=false
  done
done
if [ "$udun_ready" = true ]; then
  printf 'udun_configuration=ready\n'
else
  printf 'udun_configuration=incomplete\n'
fi

notification_send=$(value_of "$notification" NOTIFICATION_EMAIL_SEND_ENABLED 2>/dev/null || printf 'unknown')
case "$notification_send" in
  true) printf 'notification_email_send=enabled\n' ;;
  false) printf 'notification_email_send=disabled\n' ;;
  *) printf 'notification_email_send=invalid\n'; fail "notification_email_send:invalid" ;;
esac

for item in \
  "$client:PAYMENT_WORKER_ENABLED" \
  "$maintenance:PAYMENT_WORKER_ENABLED" \
  "$client:PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED" \
  "$maintenance:PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED" \
  "$demo:PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED"; do
  file=${item%:*}
  key=${item##*:}
  value=$(value_of "$file" "$key" 2>/dev/null || printf 'missing')
  if [ "$value" != false ]; then fail "$(basename "$file"):${key}:must_remain_false"; fi
done

if [ "$findings" -gt 0 ]; then exit 1; fi
