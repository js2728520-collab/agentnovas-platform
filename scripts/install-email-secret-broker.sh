#!/usr/bin/env bash
set +x
set -euo pipefail

usage() { printf 'usage: %s --check|--apply /absolute/path/to/email-secret-broker-bootstrap.answers\n' "$0" >&2;exit 64; }
[ "$#" -eq 2 ] || usage
action=$1
answer_file=$2
case "$action" in --check|--apply) ;; *) usage ;; esac
[ "${answer_file#/}" != "$answer_file" ] || { printf 'answer file must use an absolute path\n' >&2;exit 64; }
[ -f "$answer_file" ] || { printf 'answer file does not exist\n' >&2;exit 66; }

mode_of() { if stat -c '%a' "$1" >/dev/null 2>&1;then stat -c '%a' "$1";else stat -f '%Lp' "$1";fi; }
case "$(mode_of "$answer_file")" in 400|600) ;; *) printf 'answer file permissions must be 0400 or 0600\n' >&2;exit 77 ;; esac

database_url=
while IFS= read -r line || [ -n "$line" ];do
  line=${line%$'\r'}
  case "$line" in ''|'#'*) continue ;; EMAIL_SECRET_BROKER_DATABASE_URL=*)
    [ -z "$database_url" ] || { printf 'duplicate database URL\n' >&2;exit 65; }
    database_url=${line#*=} ;;
    *) printf 'unsupported answer-file key\n' >&2;exit 65 ;;
  esac
done < "$answer_file"
[[ "$database_url" =~ ^postgresql://agentnovas_email_secret_broker:[^[:space:]@]+@[^[:space:]/]+(:[0-9]+)?/agentnovas([?][^[:space:]]*)?$ ]] \
  || { printf 'broker database URL is invalid or uses the wrong role/database\n' >&2;exit 65; }
command -v openssl >/dev/null 2>&1 || { printf 'openssl is required\n' >&2;exit 69; }

secret_dir=${RIVERTON_SECRET_DIR:-/etc/agentnovas-riverton}
managed_dir=${RIVERTON_EMAIL_SECRET_DIR:-$secret_dir/email-managed}
service_uid=${RIVERTON_SERVICE_UID:-1000}
service_gid=${RIVERTON_SERVICE_GID:-1000}
[[ "$service_uid" =~ ^[0-9]+$ ]] && [[ "$service_gid" =~ ^[0-9]+$ ]] \
  || { printf 'service uid and gid must be numeric\n' >&2;exit 65; }
if [ "$secret_dir" = /etc/agentnovas-riverton ] && [ "$(id -u)" -ne 0 ];then
  printf 'default secret directory requires root\n' >&2;exit 77
fi
for file in "$secret_dir/maintenance.env" "$secret_dir/notification.env";do
  [ -f "$file" ] || { printf 'required service environment file is missing\n' >&2;exit 66; }
done
printf 'broker_bootstrap=valid\n'
[ "$action" = --apply ] || { printf 'configuration_update=not_applied\n';exit 0; }

ownership_of() { if stat -c '%u:%g' "$1" >/dev/null 2>&1;then stat -c '%u:%g' "$1";else stat -f '%u:%g' "$1";fi; }
env_value=
read_env_value() {
  local file=$1 requested_key=$2 line current_key found=false
  env_value=
  while IFS= read -r line || [ -n "$line" ];do
    case "$line" in *=*)
      current_key=${line%%=*}
      if [ "$current_key" = "$requested_key" ];then
        [ "$found" = false ] || { printf 'duplicate key in target environment file\n' >&2;exit 65; }
        env_value=${line#*=};found=true
      fi ;;
    esac
  done < "$file"
}
update_env_file() {
  local file=$1 target_ownership tmp line current_key replacement_index index
  shift
  local update_keys=() update_values=() seen=()
  while [ "$#" -gt 0 ];do
    update_keys[${#update_keys[@]}]=$1;update_values[${#update_values[@]}]=$2;shift 2
  done
  target_ownership=$(ownership_of "$file")
  tmp=$(mktemp "${file}.tmp.XXXXXX");chmod 0600 "$tmp"
  while IFS= read -r line || [ -n "$line" ];do
    case "$line" in *=*)
      current_key=${line%%=*};replacement_index=-1;index=0
      while [ "$index" -lt "${#update_keys[@]}" ];do
        if [ "${update_keys[$index]}" = "$current_key" ];then replacement_index=$index;break;fi
        index=$((index+1))
      done
      if [ "$replacement_index" -ge 0 ];then
        [ "${seen[$replacement_index]:-false}" != true ] || { rm -f "$tmp";printf 'duplicate key in target environment file\n' >&2;exit 65; }
        printf '%s=%s\n' "$current_key" "${update_values[$replacement_index]}" >> "$tmp"
        seen[$replacement_index]=true
      else printf '%s\n' "$line" >> "$tmp";fi ;;
      *) printf '%s\n' "$line" >> "$tmp" ;;
    esac
  done < "$file"
  index=0
  while [ "$index" -lt "${#update_keys[@]}" ];do
    [ "${seen[$index]:-false}" = true ] || printf '%s=%s\n' "${update_keys[$index]}" "${update_values[$index]}" >> "$tmp"
    index=$((index+1))
  done
  chown "$target_ownership" "$tmp";chmod 0440 "$tmp";mv -f "$tmp" "$file";chmod 0440 "$file"
}

private_key="$secret_dir/email-secret-broker-private.pem"
public_key="$secret_dir/email-secret-broker-public.pem"
if [ ! -e "$private_key" ] && [ ! -e "$public_key" ];then
  umask 077
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$private_key" >/dev/null 2>&1
  openssl pkey -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1
elif [ ! -f "$private_key" ] || [ ! -f "$public_key" ];then
  printf 'broker key pair is partial; refusing to overwrite\n' >&2;exit 65
fi
if [ "$(id -u)" -eq 0 ];then
  chown "0:$service_gid" "$private_key"
  chmod 0440 "$private_key"
else
  chown "$service_uid:$service_gid" "$private_key"
  chmod 0400 "$private_key"
fi
chmod 0444 "$public_key"
key_id="email-broker-$(openssl pkey -pubin -in "$public_key" -outform DER 2>/dev/null | openssl dgst -sha256 -r | awk '{print substr($1,1,20)}')"
read_env_value "$secret_dir/maintenance.env" EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY
maintenance_recipient_key=$env_value
read_env_value "$secret_dir/notification.env" EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY
notification_recipient_key=$env_value
if [ -n "$maintenance_recipient_key" ] && [ -n "$notification_recipient_key" ] \
  && [ "$maintenance_recipient_key" != "$notification_recipient_key" ];then
  printf 'recipient encryption keys differ between Maintenance and Notification\n' >&2;exit 65
fi
recipient_key=${maintenance_recipient_key:-$notification_recipient_key}
if [ -z "$recipient_key" ];then recipient_key=$(openssl rand -base64 48 | tr -d '\n');fi
[ "${#recipient_key}" -ge 32 ] && [[ "$recipient_key" != *[[:space:]]* ]] \
  || { printf 'recipient encryption key is invalid\n' >&2;exit 65; }

mkdir -p "$managed_dir/versions";chown -R "$service_uid:$service_gid" "$managed_dir";chmod 0700 "$managed_dir" "$managed_dir/versions"
update_env_file "$secret_dir/maintenance.env" \
  EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY "$recipient_key" \
  EMAIL_SECRET_BROKER_KEY_ID "$key_id" \
  EMAIL_SECRET_BROKER_PUBLIC_KEY_PATH /run/secrets/email-secret-broker-public.pem \
  EMAIL_SECRET_DIRECTORY /run/email-secrets
update_env_file "$secret_dir/notification.env" \
  EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY "$recipient_key" \
  EMAIL_SECRET_DIRECTORY /run/email-secrets

broker_env="$secret_dir/email-secret-broker.env"
umask 077
tmp=$(mktemp "${broker_env}.tmp.XXXXXX")
{
  printf 'NODE_ENV=production\n'
  printf 'DATABASE_URL=%s\n' "$database_url"
  printf 'EMAIL_SECRET_BROKER_ENABLED=true\n'
  printf 'EMAIL_SECRET_BROKER_KEY_ID=%s\n' "$key_id"
  printf 'EMAIL_SECRET_BROKER_PRIVATE_KEY_PATH=/run/secrets/email-secret-broker-private.pem\n'
  printf 'EMAIL_SECRET_DIRECTORY=/run/email-secrets\n'
  printf 'GIT_COMMIT_SHA=\n'
} > "$tmp"
if [ "$(id -u)" -eq 0 ];then chown "0:$service_gid" "$tmp";else chown "$service_uid:$service_gid" "$tmp";fi
chmod 0440 "$tmp";mv -f "$tmp" "$broker_env";chmod 0440 "$broker_env"
recipient_key=
maintenance_recipient_key=
notification_recipient_key=
database_url=
printf 'configuration_update=applied\n'
printf 'provider_secrets=unchanged\n'
printf 'service_restart=not_performed\n'
