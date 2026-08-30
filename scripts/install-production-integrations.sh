#!/usr/bin/env bash
set +x
set -euo pipefail

usage() {
  printf 'usage: %s --check|--apply /absolute/path/to/production-integrations.answers\n' "$0" >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
action=$1
answer_file=$2
case "$action" in --check|--apply) ;; *) usage ;; esac
[ "${answer_file#/}" != "$answer_file" ] || { printf 'answer file must use an absolute path\n' >&2; exit 64; }
[ -f "$answer_file" ] || { printf 'answer file does not exist\n' >&2; exit 66; }

mode_of() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi
}

ownership_of() {
  if stat -c '%u:%g' "$1" >/dev/null 2>&1; then stat -c '%u:%g' "$1"; else stat -f '%u:%g' "$1"; fi
}

mode=$(mode_of "$answer_file")
case "$mode" in
  400|600) ;;
  *) printf 'answer file permissions must be 0400 or 0600\n' >&2; exit 77 ;;
esac

secret_dir=${RIVERTON_SECRET_DIR:-/etc/agentnovas-riverton}
if [ "$secret_dir" = /etc/agentnovas-riverton ] && [ "$(id -u)" -ne 0 ]; then
  printf 'default production secret directory requires root\n' >&2
  exit 77
fi

keys=()
values=()

index_of_key() {
  local target=$1 index=0
  while [ "$index" -lt "${#keys[@]}" ]; do
    if [ "${keys[$index]}" = "$target" ]; then printf '%s' "$index"; return 0; fi
    index=$((index + 1))
  done
  return 1
}

allowed_key() {
  case "$1" in
    RESEND_API_KEY|RESEND_WEBHOOK_SECRET|NOTIFICATION_EMAIL_ALLOWLIST|UDUN_GATEWAY_BASE_URL|UDUN_MERCHANT_ID|UDUN_API_KEY|UDUN_CALLBACK_URL) return 0 ;;
    *) return 1 ;;
  esac
}

while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) ;; *) printf 'invalid answer-file line\n' >&2; exit 65 ;; esac
  key=${line%%=*}
  value=${line#*=}
  allowed_key "$key" || { printf 'unsupported key: %s\n' "$key" >&2; exit 65; }
  if index_of_key "$key" >/dev/null 2>&1; then printf 'duplicate key: %s\n' "$key" >&2; exit 65; fi
  keys[${#keys[@]}]=$key
  values[${#values[@]}]=$value
done < "$answer_file"

answer_value() {
  local index
  index=$(index_of_key "$1") || return 1
  printf '%s' "${values[$index]}"
}

present() {
  local value
  value=$(answer_value "$1" 2>/dev/null) || return 1
  [ -n "$value" ]
}

group_status() {
  local present_count=0 total_count=$# key
  for key in "$@"; do present "$key" && present_count=$((present_count + 1)); done
  if [ "$present_count" -eq 0 ]; then printf 'empty'; return; fi
  if [ "$present_count" -ne "$total_count" ]; then printf 'partial'; return; fi
  printf 'complete'
}

resend_status=$(group_status RESEND_API_KEY RESEND_WEBHOOK_SECRET NOTIFICATION_EMAIL_ALLOWLIST)
udun_status=$(group_status UDUN_GATEWAY_BASE_URL UDUN_MERCHANT_ID UDUN_API_KEY UDUN_CALLBACK_URL)
[ "$resend_status" != partial ] || { printf 'Resend input is partial\n' >&2; exit 65; }
[ "$udun_status" != partial ] || { printf 'Udun input is partial\n' >&2; exit 65; }
[ "$resend_status" != empty ] || [ "$udun_status" != empty ] || { printf 'no provider configuration supplied\n' >&2; exit 65; }

if [ "$resend_status" = complete ]; then
  resend_api_key=$(answer_value RESEND_API_KEY)
  resend_webhook_secret=$(answer_value RESEND_WEBHOOK_SECRET)
  email_allowlist=$(answer_value NOTIFICATION_EMAIL_ALLOWLIST)
  [[ "$resend_api_key" =~ ^re_[A-Za-z0-9_-]{8,}$ ]] || { printf 'RESEND_API_KEY format is invalid\n' >&2; exit 65; }
  [[ "$resend_webhook_secret" =~ ^whsec_[A-Za-z0-9_-]{8,}$ ]] || { printf 'RESEND_WEBHOOK_SECRET format is invalid\n' >&2; exit 65; }
  old_ifs=$IFS
  IFS=,
  for email in $email_allowlist; do
    [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { printf 'NOTIFICATION_EMAIL_ALLOWLIST contains an invalid email\n' >&2; exit 65; }
  done
  IFS=$old_ifs
fi

if [ "$udun_status" = complete ]; then
  udun_gateway=$(answer_value UDUN_GATEWAY_BASE_URL)
  udun_merchant=$(answer_value UDUN_MERCHANT_ID)
  udun_api_key=$(answer_value UDUN_API_KEY)
  udun_callback=$(answer_value UDUN_CALLBACK_URL)
  [[ "$udun_gateway" =~ ^https://([A-Za-z0-9-]+\.)*udun\.io/?$ ]] || { printf 'UDUN_GATEWAY_BASE_URL must be a dedicated HTTPS udun.io host\n' >&2; exit 65; }
  [[ "$udun_merchant" =~ ^[0-9]{1,32}$ ]] || { printf 'UDUN_MERCHANT_ID format is invalid\n' >&2; exit 65; }
  [ "${#udun_api_key}" -ge 8 ] && [ "${#udun_api_key}" -le 256 ] \
    && [[ ! "$udun_api_key" =~ [[:space:]] ]] \
    || { printf 'UDUN_API_KEY format is invalid\n' >&2; exit 65; }
  [ "$udun_callback" = "https://xm.agentnovas.com/api/integrations/payments/udun/webhook" ] || { printf 'UDUN_CALLBACK_URL is not the production callback\n' >&2; exit 65; }
fi

printf 'resend_input=%s\n' "$resend_status"
printf 'udun_input=%s\n' "$udun_status"
if [ "$action" = --check ]; then
  printf 'configuration_update=not_applied\n'
  exit 0
fi

for name in client maintenance notification; do
  file="$secret_dir/$name.env"
  [ -f "$file" ] || { printf 'required secret file is missing: %s.env\n' "$name" >&2; exit 66; }
done

update_env_file() {
  local file=$1 target_ownership
  shift
  local update_keys=() update_values=() seen=() key value index line current_key replacement_index tmp
  target_ownership=$(ownership_of "$file")
  while [ "$#" -gt 0 ]; do
    update_keys[${#update_keys[@]}]=$1
    update_values[${#update_values[@]}]=$2
    shift 2
  done
  tmp=$(mktemp "${file}.tmp.XXXXXX")
  chmod 0600 "$tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *=*)
        current_key=${line%%=*}
        replacement_index=-1
        index=0
        while [ "$index" -lt "${#update_keys[@]}" ]; do
          if [ "${update_keys[$index]}" = "$current_key" ]; then replacement_index=$index; break; fi
          index=$((index + 1))
        done
        if [ "$replacement_index" -ge 0 ]; then
          if [ "${seen[$replacement_index]:-false}" = true ]; then
            rm -f "$tmp"
            printf 'duplicate key in target secret file: %s\n' "$current_key" >&2
            exit 65
          fi
          printf '%s=%s\n' "$current_key" "${update_values[$replacement_index]}" >> "$tmp"
          seen[$replacement_index]=true
        else
          printf '%s\n' "$line" >> "$tmp"
        fi
        ;;
      *) printf '%s\n' "$line" >> "$tmp" ;;
    esac
  done < "$file"
  index=0
  while [ "$index" -lt "${#update_keys[@]}" ]; do
    if [ "${seen[$index]:-false}" != true ]; then
      printf '%s=%s\n' "${update_keys[$index]}" "${update_values[$index]}" >> "$tmp"
    fi
    index=$((index + 1))
  done
  if ! chown "$target_ownership" "$tmp"; then
    rm -f "$tmp"
    printf 'failed to preserve target secret-file ownership: %s\n' "$file" >&2
    exit 77
  fi
  chmod 0440 "$tmp"
  mv -f "$tmp" "$file"
  chmod 0440 "$file"
}

client_updates=(
  PAYMENT_WORKER_ENABLED false
  NOTIFICATION_EMAIL_SEND_ENABLED false
  PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED false
)
maintenance_updates=(
  PAYMENT_WORKER_ENABLED false
  PAYMENT_PROVIDER_TESTS_ENABLED false
  NOTIFICATION_EMAIL_SEND_ENABLED false
  PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED false
)
notification_updates=(NOTIFICATION_EMAIL_SEND_ENABLED false)

if [ "$resend_status" = complete ]; then
  maintenance_updates+=(RESEND_WEBHOOK_SECRET "$resend_webhook_secret")
  notification_updates+=(RESEND_API_KEY "$resend_api_key" NOTIFICATION_EMAIL_ALLOWLIST "$email_allowlist")
fi
if [ "$udun_status" = complete ]; then
  for key in UDUN_GATEWAY_BASE_URL UDUN_MERCHANT_ID UDUN_API_KEY UDUN_CALLBACK_URL; do
    value=$(answer_value "$key")
    client_updates+=("$key" "$value")
    maintenance_updates+=("$key" "$value")
  done
fi

update_env_file "$secret_dir/client.env" "${client_updates[@]}"
update_env_file "$secret_dir/maintenance.env" "${maintenance_updates[@]}"
update_env_file "$secret_dir/notification.env" "${notification_updates[@]}"
printf 'configuration_update=applied\n'
printf 'external_effect_switches=retained_disabled\n'
printf 'service_restart=not_performed\n'
