#!/usr/bin/env bash
set +x
set -euo pipefail

secret_dir=${RIVERTON_SECRET_DIR:-/etc/agentnovas-riverton}
managed_email_secret_dir=${RIVERTON_EMAIL_SECRET_DIR:-$secret_dir/email-managed}
managed_payment_secret_dir=${RIVERTON_PAYMENT_SECRET_DIR:-$secret_dir/payment-managed}
repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
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

managed_email_manifest_valid() {
  local directory=$1
  command -v node >/dev/null 2>&1 || return 1
  node - "$directory" <<'NODE' >/dev/null 2>&1
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { basename, join } = require("node:path");

const directory = process.argv[2];
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
  || manifest.schemaVersion !== "1"
  || typeof manifest.version !== "string"
  || !/^email-[A-Za-z0-9-]{20,100}$/.test(manifest.version)) process.exit(1);
for (const [kind, key, pattern] of [
  ["notification", "RESEND_API_KEY", /^re_[A-Za-z0-9_-]{8,}$/],
  ["maintenance", "RESEND_WEBHOOK_SECRET", /^whsec_[A-Za-z0-9_-]{8,}$/],
]) {
  const entry = manifest[kind];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || typeof entry.file !== "string"
    || basename(entry.file) !== entry.file.split("/").at(-1)
    || !entry.file.startsWith(`versions/${manifest.version}.`)
    || typeof entry.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(entry.sha256)) process.exit(1);
  const content = readFileSync(join(directory, entry.file), "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  const lines = content.trimEnd().split("\n");
  if (digest !== entry.sha256 || lines.length !== 2
    || lines[0] !== `EMAIL_SECRET_CONFIGURATION_VERSION=${manifest.version}`
    || !lines[1].startsWith(`${key}=`)
    || !pattern.test(lines[1].slice(key.length + 1))) process.exit(1);
}
NODE
}

managed_payment_manifest_valid() {
  local directory=$1
  command -v node >/dev/null 2>&1 || return 1
  node - "$directory" <<'NODE' >/dev/null 2>&1
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const directory = process.argv[2];
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
  || manifest.schemaVersion !== "1" || typeof manifest.version !== "string"
  || !/^payment-[A-Za-z0-9-]{20,110}$/.test(manifest.version)) process.exit(1);
for (const kind of ["client", "maintenance"]) {
  const entry = manifest[kind];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || typeof entry.file !== "string" || basename(entry.file) !== entry.file.split("/").at(-1)
    || !entry.file.startsWith(`versions/${manifest.version}.`)
    || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) process.exit(1);
  const content = readFileSync(join(directory, entry.file), "utf8");
  if (createHash("sha256").update(content).digest("hex") !== entry.sha256) process.exit(1);
  const lines = content.trimEnd().split("\n");
  if (lines.length !== 6 || lines[0] !== `PAYMENT_SECRET_CONFIGURATION_VERSION=${manifest.version}`) process.exit(1);
  const values = Object.fromEntries(lines.slice(1).map(line => {
    const index = line.indexOf("=");
    if (index <= 0) process.exit(1);
    return [line.slice(0,index),line.slice(index+1)];
  }));
  if (Object.keys(values).sort().join(",") !== "UDUN_ADDRESS_REQUEST_COIN_FIELD,UDUN_API_KEY,UDUN_CALLBACK_URL,UDUN_GATEWAY_BASE_URL,UDUN_MERCHANT_ID"
    || !/^https:\/\/([A-Za-z0-9-]+\.)*udun\.io$/.test(values.UDUN_GATEWAY_BASE_URL)
    || !/^\d{1,32}$/.test(values.UDUN_MERCHANT_ID)
    || values.UDUN_API_KEY.length < 8 || values.UDUN_API_KEY.length > 256 || /\s/.test(values.UDUN_API_KEY)
    || !/^https:\/\/([A-Za-z0-9-]+\.)*agentnovas\.com\/api\/integrations\/payments\/udun\/webhook$/.test(values.UDUN_CALLBACK_URL)
    || !["mainCoinType","coinType"].includes(values.UDUN_ADDRESS_REQUEST_COIN_FIELD)) process.exit(1);
}
NODE
}

same_value() {
  local label=$1 left_file=$2 left_key=$3 right_file=$4 right_key=$5 left right
  left=$(value_of "$left_file" "$left_key" 2>/dev/null) || { fail "${label}:left_missing_or_duplicate"; return; }
  right=$(value_of "$right_file" "$right_key" 2>/dev/null) || { fail "${label}:right_missing_or_duplicate"; return; }
  if [ -z "$left" ] || [ "$left" != "$right" ]; then
    fail "${label}:mismatch"
  fi
}

for name in client operations maintenance notification configuration-activation release-control release-identity-verifier release-orchestrator-staging release-orchestrator-production release-auditor-staging release-auditor-production release-webhook research runtime ai-gateway ai-secret-broker demo migrator execution; do
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
configuration_activation="$secret_dir/configuration-activation.env"
release_orchestrator_staging="$secret_dir/release-orchestrator-staging.env"
release_orchestrator_production="$secret_dir/release-orchestrator-production.env"
release_auditor_staging="$secret_dir/release-auditor-staging.env"
release_auditor_production="$secret_dir/release-auditor-production.env"
release_control="$secret_dir/release-control.env"
release_identity_verifier="$secret_dir/release-identity-verifier.env"
release_webhook="$secret_dir/release-webhook.env"
runtime="$secret_dir/runtime.env"
research="$secret_dir/research.env"
ai_gateway="$secret_dir/ai-gateway.env"
ai_secret_broker="$secret_dir/ai-secret-broker.env"
demo="$secret_dir/demo.env"
migrator="$secret_dir/migrator.env"

if [ "$findings" -eq 0 ]; then
  for key in DATABASE_URL CLIENT_AUTH_DATABASE_URL TRUST_PROXY_HOPS MFA_TOTP_ENCRYPTION_KEY NOTIFICATION_TOKEN_ENCRYPTION_KEY AI_GATEWAY_ENABLED AI_GATEWAY_URL AI_GATEWAY_SHARED_SECRET; do
    required_value "$client" "$key" || true
  done
  required_boolean "$client" PAYMENT_PROVIDER_OUTBOUND_ENABLED || true
  for key in DATABASE_URL TRUST_PROXY_HOPS MFA_TOTP_ENCRYPTION_KEY NOTIFICATION_TOKEN_ENCRYPTION_KEY; do
    required_value "$operations" "$key" || true
  done
  for key in DATABASE_URL RELEASE_IDENTITY_VERIFIER_URL RELEASE_IDENTITY_VERIFIER_SHARED_SECRET RELEASE_CONTROL_GATEWAY_URL RELEASE_CONTROL_GATEWAY_SHARED_SECRET PAYMENT_WEBHOOK_DATABASE_URL TRUST_PROXY_HOPS MFA_TOTP_ENCRYPTION_KEY INTEGRATION_CREDENTIAL_ENCRYPTION_KEY AI_GATEWAY_ENABLED AI_GATEWAY_URL AI_GATEWAY_SHARED_SECRET; do
    required_value "$maintenance" "$key" || true
  done
  required_boolean "$maintenance" PAYMENT_PROVIDER_TESTS_ENABLED || true
  required_boolean "$maintenance" PAYMENT_PROVIDER_OUTBOUND_ENABLED || true
  if optional_present "$maintenance" RELEASE_CONTROL_DATABASE_URL; then
    fail "maintenance.env:RELEASE_CONTROL_DATABASE_URL:must_not_be_present"
  fi
  if optional_present "$maintenance" RELEASE_IDENTITY_VERIFIER_DATABASE_URL; then
    fail "maintenance.env:RELEASE_IDENTITY_VERIFIER_DATABASE_URL:must_not_be_present"
  fi
  for key in RIVERTON_RELEASE_CONTROL_SERVICE RELEASE_CONTROL_ENABLED RELEASE_CONTROL_DATABASE_URL RELEASE_CONTROL_GATEWAY_SHARED_SECRET; do
    required_value "$release_control" "$key" || true
  done
  required_boolean "$release_control" RELEASE_CONTROL_ENABLED || true
  required_boolean "$release_control" RIVERTON_RELEASE_CONTROL_SERVICE || true
  if [ "$(value_of "$release_control" RIVERTON_RELEASE_CONTROL_SERVICE 2>/dev/null || printf false)" != "true" ]; then
    fail "release-control.env:RIVERTON_RELEASE_CONTROL_SERVICE:must_be_true"
  fi
  release_control_database_url=$(value_of "$release_control" RELEASE_CONTROL_DATABASE_URL 2>/dev/null || printf 'missing')
  case "$release_control_database_url" in
    postgresql://agentnovas_release_control@*/*|postgresql://agentnovas_release_control:*@*/*|postgres://agentnovas_release_control@*/*|postgres://agentnovas_release_control:*@*/*) ;;
    *) fail "release-control.env:RELEASE_CONTROL_DATABASE_URL:dedicated_role_required" ;;
  esac
  same_value "release-control-gateway-shared-secret" "$maintenance" RELEASE_CONTROL_GATEWAY_SHARED_SECRET "$release_control" RELEASE_CONTROL_GATEWAY_SHARED_SECRET
  for key in RIVERTON_RELEASE_IDENTITY_VERIFIER_SERVICE RELEASE_IDENTITY_VERIFIER_ENABLED RELEASE_IDENTITY_VERIFIER_DATABASE_URL RELEASE_IDENTITY_VERIFIER_SHARED_SECRET RELEASE_IDENTITY_VERIFIER_WEBAUTHN_POLICY_FILE; do
    required_value "$release_identity_verifier" "$key" || true
  done
  required_boolean "$release_identity_verifier" RELEASE_IDENTITY_VERIFIER_ENABLED || true
  required_boolean "$release_identity_verifier" RIVERTON_RELEASE_IDENTITY_VERIFIER_SERVICE || true
  if [ "$(value_of "$release_identity_verifier" RIVERTON_RELEASE_IDENTITY_VERIFIER_SERVICE 2>/dev/null || printf false)" != "true" ]; then
    fail "release-identity-verifier.env:RIVERTON_RELEASE_IDENTITY_VERIFIER_SERVICE:must_be_true"
  fi
  release_identity_verifier_database_url=$(value_of "$release_identity_verifier" RELEASE_IDENTITY_VERIFIER_DATABASE_URL 2>/dev/null || printf 'missing')
  case "$release_identity_verifier_database_url" in
    postgresql://agentnovas_release_identity_verifier@*/*|postgresql://agentnovas_release_identity_verifier:*@*/*|postgres://agentnovas_release_identity_verifier@*/*|postgres://agentnovas_release_identity_verifier:*@*/*) ;;
    *) fail "release-identity-verifier.env:RELEASE_IDENTITY_VERIFIER_DATABASE_URL:dedicated_role_required" ;;
  esac
  same_value "release-identity-verifier-shared-secret" "$maintenance" RELEASE_IDENTITY_VERIFIER_SHARED_SECRET "$release_identity_verifier" RELEASE_IDENTITY_VERIFIER_SHARED_SECRET
  for file in "$client" "$operations" "$maintenance"; do
    required_boolean "$file" MFA_ENFORCEMENT_ENABLED || true
  done
  for key in DATABASE_URL NOTIFICATION_WORKER_ENABLED NOTIFICATION_EMAIL_SEND_ENABLED NOTIFICATION_TOKEN_ENCRYPTION_KEY; do
    required_value "$notification" "$key" || true
  done
  for key in CONFIGURATION_ACTIVATION_DATABASE_URL CONFIGURATION_ACTIVATION_WORKER_INTERVAL_MS CONFIGURATION_ACTIVATION_WORKER_BATCH_SIZE; do
    required_value "$configuration_activation" "$key" || true
  done
  configuration_activation_database_url=$(value_of "$configuration_activation" CONFIGURATION_ACTIVATION_DATABASE_URL 2>/dev/null || printf 'missing')
  case "$configuration_activation_database_url" in
    postgresql://agentnovas_configuration_activation_worker@*/*|postgresql://agentnovas_configuration_activation_worker:*@*/*|postgres://agentnovas_configuration_activation_worker@*/*|postgres://agentnovas_configuration_activation_worker:*@*/*) ;;
    *) fail "configuration-activation.env:CONFIGURATION_ACTIVATION_DATABASE_URL:dedicated_role_required" ;;
  esac
  required_boolean "$configuration_activation" CONFIGURATION_ACTIVATION_WORKER_ENABLED || true
  required_boolean "$maintenance" CONFIGURATION_ACTIVATION_WORKER_ENABLED || true
  for release_orchestrator in "$release_orchestrator_staging" "$release_orchestrator_production"; do
    for key in RELEASE_ORCHESTRATOR_DATABASE_URL RELEASE_ORCHESTRATOR_BINDING_FILE RELEASE_ORCHESTRATOR_WORKER_ID RELEASE_ORCHESTRATOR_INTERVAL_MS RELEASE_ORCHESTRATOR_LEASE_SECONDS; do
      required_value "$release_orchestrator" "$key" || true
    done
    release_orchestrator_database_url=$(value_of "$release_orchestrator" RELEASE_ORCHESTRATOR_DATABASE_URL 2>/dev/null || printf 'missing')
    case "$release_orchestrator_database_url" in
      postgresql://agentnovas_release_worker@*/*|postgresql://agentnovas_release_worker:*@*/*|postgres://agentnovas_release_worker@*/*|postgres://agentnovas_release_worker:*@*/*) ;;
      *) fail "$(basename "$release_orchestrator"):RELEASE_ORCHESTRATOR_DATABASE_URL:dedicated_role_required" ;;
    esac
    required_boolean "$release_orchestrator" RELEASE_ORCHESTRATOR_WORKER_ENABLED || true
  done
  for release_auditor in "$release_auditor_staging" "$release_auditor_production"; do
    for key in RELEASE_AUDITOR_DATABASE_URL RELEASE_AUDITOR_HOST RELEASE_AUDITOR_PORT; do
      required_value "$release_auditor" "$key" || true
    done
    release_auditor_database_url=$(value_of "$release_auditor" RELEASE_AUDITOR_DATABASE_URL 2>/dev/null || printf 'missing')
    case "$release_auditor_database_url" in
      postgresql://agentnovas_release_auditor@*/*|postgresql://agentnovas_release_auditor:*@*/*|postgres://agentnovas_release_auditor@*/*|postgres://agentnovas_release_auditor:*@*/*) ;;
      *) fail "$(basename "$release_auditor"):RELEASE_AUDITOR_DATABASE_URL:dedicated_role_required" ;;
    esac
    required_boolean "$release_auditor" RELEASE_AUDITOR_ENABLED || true
  done
  for key in RELEASE_WEBHOOK_DATABASE_URL RELEASE_WEBHOOK_BINDING_FILE RELEASE_WEBHOOK_HOST RELEASE_WEBHOOK_PORT; do
    required_value "$release_webhook" "$key" || true
  done
  release_webhook_database_url=$(value_of "$release_webhook" RELEASE_WEBHOOK_DATABASE_URL 2>/dev/null || printf 'missing')
  case "$release_webhook_database_url" in
    postgresql://agentnovas_release_ingress@*/*|postgresql://agentnovas_release_ingress:*@*/*|postgres://agentnovas_release_ingress@*/*|postgres://agentnovas_release_ingress:*@*/*) ;;
    *) fail "release-webhook.env:RELEASE_WEBHOOK_DATABASE_URL:dedicated_role_required" ;;
  esac
  required_boolean "$release_webhook" RELEASE_WEBHOOK_INGRESS_ENABLED || true
  for worker in "$research" "$runtime"; do
    for key in RESEARCH_DATABASE_URL AI_GATEWAY_ENABLED AI_GATEWAY_URL AI_GATEWAY_SHARED_SECRET; do
      required_value "$worker" "$key" || true
    done
    required_boolean "$worker" AI_GATEWAY_ENABLED || true
  done
  for web in "$client" "$maintenance"; do required_boolean "$web" AI_GATEWAY_ENABLED || true; done
  for file in "$client" "$maintenance" "$research" "$runtime"; do
    if optional_present "$file" LLM_PROFILE_ENCRYPTION_KEY; then
      fail "$(basename "$file"):LLM_PROFILE_ENCRYPTION_KEY:must_not_be_present"
    fi
  done
  for key in AI_GATEWAY_PROCESS AI_GATEWAY_ENABLED AI_GATEWAY_DATABASE_URL AI_GATEWAY_SHARED_SECRET AI_GATEWAY_PORT AI_GATEWAY_MAX_CONCURRENT AI_GATEWAY_MAX_PER_MINUTE AI_MANAGED_SECRET_DIRECTORY; do
    required_value "$ai_gateway" "$key" || true
  done
  required_boolean "$ai_gateway" AI_GATEWAY_PROCESS || true
  required_boolean "$ai_gateway" AI_GATEWAY_ENABLED || true
  ai_gateway_database_url=$(value_of "$ai_gateway" AI_GATEWAY_DATABASE_URL 2>/dev/null || printf 'missing')
  case "$ai_gateway_database_url" in
    postgresql://agentnovas_ai_gateway@*/*|postgresql://agentnovas_ai_gateway:*@*/*|postgres://agentnovas_ai_gateway@*/*|postgres://agentnovas_ai_gateway:*@*/*) ;;
    *) fail "ai-gateway.env:AI_GATEWAY_DATABASE_URL:dedicated_role_required" ;;
  esac
  for key in AI_SECRET_BROKER_PROCESS AI_SECRET_BROKER_ENABLED AI_SECRET_BROKER_DATABASE_URL AI_MANAGED_SECRET_DIRECTORY; do
    required_value "$ai_secret_broker" "$key" || true
  done
  if ! optional_present "$ai_secret_broker" AI_SECRET_BROKER_PRIVATE_KEY_FILE \
    && ! optional_present "$ai_secret_broker" AI_SECRET_BROKER_PRIVATE_KEY_DIRECTORY; then
    fail "ai-secret-broker.env:private_key_file_or_directory:required"
  fi
  required_boolean "$ai_secret_broker" AI_SECRET_BROKER_PROCESS || true
  required_boolean "$ai_secret_broker" AI_SECRET_BROKER_ENABLED || true
  ai_secret_broker_database_url=$(value_of "$ai_secret_broker" AI_SECRET_BROKER_DATABASE_URL 2>/dev/null || printf 'missing')
  case "$ai_secret_broker_database_url" in
    postgresql://agentnovas_ai_secret_broker@*/*|postgresql://agentnovas_ai_secret_broker:*@*/*|postgres://agentnovas_ai_secret_broker@*/*|postgres://agentnovas_ai_secret_broker:*@*/*) ;;
    *) fail "ai-secret-broker.env:AI_SECRET_BROKER_DATABASE_URL:dedicated_role_required" ;;
  esac
  for key in DATABASE_URL INTEGRATION_CREDENTIAL_ENCRYPTION_KEY; do required_value "$demo" "$key" || true; done
  for key in DATABASE_URL POSTGRES_MIGRATION_SCHEMA GIT_COMMIT_SHA; do required_value "$migrator" "$key" || true; done

  same_value "notification_token_client_worker" "$client" NOTIFICATION_TOKEN_ENCRYPTION_KEY "$notification" NOTIFICATION_TOKEN_ENCRYPTION_KEY
  same_value "notification_token_operations_worker" "$operations" NOTIFICATION_TOKEN_ENCRYPTION_KEY "$notification" NOTIFICATION_TOKEN_ENCRYPTION_KEY
  same_value "internal_mfa_operations_maintenance" "$operations" MFA_TOTP_ENCRYPTION_KEY "$maintenance" MFA_TOTP_ENCRYPTION_KEY
  same_value "mfa_enforcement_client_operations" "$client" MFA_ENFORCEMENT_ENABLED "$operations" MFA_ENFORCEMENT_ENABLED
  same_value "mfa_enforcement_client_maintenance" "$client" MFA_ENFORCEMENT_ENABLED "$maintenance" MFA_ENFORCEMENT_ENABLED
  same_value "ai_gateway_client_gateway" "$client" AI_GATEWAY_SHARED_SECRET "$ai_gateway" AI_GATEWAY_SHARED_SECRET
  same_value "ai_gateway_maintenance_gateway" "$maintenance" AI_GATEWAY_SHARED_SECRET "$ai_gateway" AI_GATEWAY_SHARED_SECRET
  same_value "ai_gateway_research_gateway" "$research" AI_GATEWAY_SHARED_SECRET "$ai_gateway" AI_GATEWAY_SHARED_SECRET
  same_value "ai_gateway_runtime_gateway" "$runtime" AI_GATEWAY_SHARED_SECRET "$ai_gateway" AI_GATEWAY_SHARED_SECRET
  same_value "ai_gateway_url_client_maintenance" "$client" AI_GATEWAY_URL "$maintenance" AI_GATEWAY_URL
  same_value "ai_gateway_url_client_research" "$client" AI_GATEWAY_URL "$research" AI_GATEWAY_URL
  same_value "ai_gateway_url_client_runtime" "$client" AI_GATEWAY_URL "$runtime" AI_GATEWAY_URL
  same_value "ai_managed_secret_directory" "$ai_gateway" AI_MANAGED_SECRET_DIRECTORY "$ai_secret_broker" AI_MANAGED_SECRET_DIRECTORY
  same_value "integration_demo_maintenance" "$demo" INTEGRATION_CREDENTIAL_ENCRYPTION_KEY "$maintenance" INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
  same_value "configuration_activation_worker_state" "$configuration_activation" CONFIGURATION_ACTIVATION_WORKER_ENABLED "$maintenance" CONFIGURATION_ACTIVATION_WORKER_ENABLED
  same_value "payment-provider-outbound-state" "$client" PAYMENT_PROVIDER_OUTBOUND_ENABLED "$maintenance" PAYMENT_PROVIDER_OUTBOUND_ENABLED
fi

if [ "$findings" -eq 0 ]; then
  printf 'core_configuration=ready\n'
else
  printf 'core_configuration=invalid\n'
fi

managed_email_configuration=false
email_secret_broker_configuration=false
broker_env="$secret_dir/email-secret-broker.env"
broker_public_key="$secret_dir/email-secret-broker-public.pem"
broker_private_key="$secret_dir/email-secret-broker-private.pem"
managed_manifest="$managed_email_secret_dir/manifest.json"
broker_artifacts_present=false
for item in "$broker_env" "$broker_public_key" "$broker_private_key" "$managed_manifest"; do
  [ -e "$item" ] && broker_artifacts_present=true
done

if [ "$broker_artifacts_present" = true ]; then
  broker_findings_before=$findings
  broker_valid=true
  for item in "$broker_env" "$broker_public_key" "$broker_private_key"; do
    if [ ! -f "$item" ]; then
      fail "$(basename "$item"):missing_for_email_secret_broker"
      broker_valid=false
    fi
  done
  if [ "$broker_valid" = true ]; then
    case "$(mode_of "$broker_env")" in 400|440|600|640) ;; *) fail "email-secret-broker.env:unsafe_permissions";broker_valid=false ;; esac
    case "$(mode_of "$broker_private_key")" in 400|440) ;; *) fail "email-secret-broker-private.pem:permissions_must_be_0400_or_0440";broker_valid=false ;; esac
    case "$(mode_of "$broker_public_key")" in 444) ;; *) fail "email-secret-broker-public.pem:permissions_must_be_0444";broker_valid=false ;; esac
    required_value "$broker_env" DATABASE_URL || broker_valid=false
    required_boolean "$broker_env" EMAIL_SECRET_BROKER_ENABLED || broker_valid=false
    required_value "$broker_env" EMAIL_SECRET_BROKER_KEY_ID || broker_valid=false
    required_value "$broker_env" EMAIL_SECRET_BROKER_PRIVATE_KEY_PATH || broker_valid=false
    required_value "$broker_env" EMAIL_SECRET_DIRECTORY || broker_valid=false
    broker_database_url=$(value_of "$broker_env" DATABASE_URL 2>/dev/null || printf 'missing')
    case "$broker_database_url" in
      postgresql://agentnovas_email_secret_broker@*/*|postgresql://agentnovas_email_secret_broker:*@*/*|postgres://agentnovas_email_secret_broker@*/*|postgres://agentnovas_email_secret_broker:*@*/*) ;;
      *) fail "email-secret-broker.env:DATABASE_URL:dedicated_role_required";broker_valid=false ;;
    esac
    if [ "$(value_of "$broker_env" EMAIL_SECRET_BROKER_ENABLED 2>/dev/null || printf false)" != "true" ]; then
      fail "email-secret-broker.env:EMAIL_SECRET_BROKER_ENABLED:must_be_true"
      broker_valid=false
    fi
    same_value "email-secret-broker-key-id" "$maintenance" EMAIL_SECRET_BROKER_KEY_ID "$broker_env" EMAIL_SECRET_BROKER_KEY_ID
    same_value "email-test-recipient-encryption-key" "$maintenance" EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY "$notification" EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY
    required_value "$maintenance" EMAIL_SECRET_BROKER_PUBLIC_KEY_PATH || broker_valid=false
    required_value "$maintenance" EMAIL_SECRET_DIRECTORY || broker_valid=false
    required_value "$notification" EMAIL_SECRET_DIRECTORY || broker_valid=false
    required_value "$maintenance" EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY || broker_valid=false
    required_value "$notification" EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY || broker_valid=false
    [ "$findings" -eq "$broker_findings_before" ] || broker_valid=false
  fi
  if [ "$broker_valid" = true ]; then
    email_secret_broker_configuration=true
  fi
  if [ -f "$managed_manifest" ]; then
    if managed_email_manifest_valid "$managed_email_secret_dir"; then
      managed_email_configuration=true
    else
      fail "email-managed:manifest_or_secret_files_invalid"
    fi
  fi
fi

if [ "$email_secret_broker_configuration" = true ]; then
  printf 'email_secret_broker_configuration=ready\n'
else
  printf 'email_secret_broker_configuration=incomplete\n'
fi

if [ "$managed_email_configuration" = true ] || { optional_present "$notification" RESEND_API_KEY \
  && optional_present "$maintenance" RESEND_WEBHOOK_SECRET \
  && optional_present "$notification" NOTIFICATION_EMAIL_ALLOWLIST; }; then
  printf 'resend_configuration=ready\n'
else
  printf 'resend_configuration=incomplete\n'
fi

managed_payment_configuration=false
payment_secret_broker_configuration=false
payment_broker_env="$secret_dir/payment-secret-broker.env"
payment_broker_public_key="$secret_dir/payment-secret-broker-public.pem"
payment_broker_private_key="$secret_dir/payment-secret-broker-private.pem"
payment_managed_manifest="$managed_payment_secret_dir/manifest.json"
payment_broker_artifacts_present=false
for item in "$payment_broker_env" "$payment_broker_public_key" "$payment_broker_private_key" "$payment_managed_manifest"; do
  [ -e "$item" ] && payment_broker_artifacts_present=true
done
if [ "$payment_broker_artifacts_present" = true ]; then
  payment_broker_findings_before=$findings
  payment_broker_valid=true
  for item in "$payment_broker_env" "$payment_broker_public_key" "$payment_broker_private_key"; do
    if [ ! -f "$item" ]; then fail "$(basename "$item"):missing_for_payment_secret_broker";payment_broker_valid=false;fi
  done
  if [ "$payment_broker_valid" = true ]; then
    case "$(mode_of "$payment_broker_env")" in 400|440|600|640) ;; *) fail "payment-secret-broker.env:unsafe_permissions";payment_broker_valid=false ;; esac
    case "$(mode_of "$payment_broker_private_key")" in 400|440) ;; *) fail "payment-secret-broker-private.pem:permissions_must_be_0400_or_0440";payment_broker_valid=false ;; esac
    case "$(mode_of "$payment_broker_public_key")" in 444) ;; *) fail "payment-secret-broker-public.pem:permissions_must_be_0444";payment_broker_valid=false ;; esac
    for key in DATABASE_URL PAYMENT_SECRET_BROKER_KEY_ID PAYMENT_SECRET_BROKER_PRIVATE_KEY_PATH PAYMENT_SECRET_DIRECTORY PAYMENT_ALLOWED_CALLBACK_HOSTS; do
      required_value "$payment_broker_env" "$key" || payment_broker_valid=false
    done
    required_boolean "$payment_broker_env" PAYMENT_SECRET_BROKER_ENABLED || payment_broker_valid=false
    payment_broker_database_url=$(value_of "$payment_broker_env" DATABASE_URL 2>/dev/null || printf missing)
    case "$payment_broker_database_url" in
      postgresql://agentnovas_payment_secret_broker@*/*|postgresql://agentnovas_payment_secret_broker:*@*/*|postgres://agentnovas_payment_secret_broker@*/*|postgres://agentnovas_payment_secret_broker:*@*/*) ;;
      *) fail "payment-secret-broker.env:DATABASE_URL:dedicated_role_required";payment_broker_valid=false ;;
    esac
    if [ "$(value_of "$payment_broker_env" PAYMENT_SECRET_BROKER_ENABLED 2>/dev/null || printf false)" != true ]; then
      fail "payment-secret-broker.env:PAYMENT_SECRET_BROKER_ENABLED:must_be_true";payment_broker_valid=false
    fi
    required_value "$maintenance" PAYMENT_SECRET_BROKER_KEY_ID || payment_broker_valid=false
    required_value "$maintenance" PAYMENT_SECRET_BROKER_PUBLIC_KEY_PATH || payment_broker_valid=false
    required_value "$maintenance" PAYMENT_SECRET_DIRECTORY || payment_broker_valid=false
    required_value "$client" PAYMENT_SECRET_DIRECTORY || payment_broker_valid=false
    required_value "$maintenance" PAYMENT_ALLOWED_CALLBACK_HOSTS || payment_broker_valid=false
    same_value "payment-secret-broker-key-id" "$maintenance" PAYMENT_SECRET_BROKER_KEY_ID "$payment_broker_env" PAYMENT_SECRET_BROKER_KEY_ID
    same_value "payment-callback-host-allowlist" "$maintenance" PAYMENT_ALLOWED_CALLBACK_HOSTS "$payment_broker_env" PAYMENT_ALLOWED_CALLBACK_HOSTS
    [ "$findings" -eq "$payment_broker_findings_before" ] || payment_broker_valid=false
  fi
  [ "$payment_broker_valid" = true ] && payment_secret_broker_configuration=true
  if [ -f "$payment_managed_manifest" ]; then
    if managed_payment_manifest_valid "$managed_payment_secret_dir"; then managed_payment_configuration=true
    else fail "payment-managed:manifest_or_secret_files_invalid";fi
  fi
fi

if [ "$payment_secret_broker_configuration" = true ]; then printf 'payment_secret_broker_configuration=ready\n'
else printf 'payment_secret_broker_configuration=incomplete\n';fi

udun_ready=true
for file in "$client" "$maintenance"; do
  for key in UDUN_GATEWAY_BASE_URL UDUN_MERCHANT_ID UDUN_API_KEY UDUN_CALLBACK_URL; do
    optional_present "$file" "$key" || udun_ready=false
  done
done
if [ "$managed_payment_configuration" = true ] || [ "$udun_ready" = true ]; then
  printf 'udun_configuration=ready\n'
else
  printf 'udun_configuration=incomplete\n'
fi

payment_provider_outbound=$(value_of "$client" PAYMENT_PROVIDER_OUTBOUND_ENABLED 2>/dev/null || printf unknown)
case "$payment_provider_outbound" in
  true) printf 'payment_provider_outbound=enabled\n' ;;
  false) printf 'payment_provider_outbound=disabled\n' ;;
  *) printf 'payment_provider_outbound=invalid\n';fail "payment_provider_outbound:invalid" ;;
esac

notification_send=$(value_of "$notification" NOTIFICATION_EMAIL_SEND_ENABLED 2>/dev/null || printf 'unknown')
case "$notification_send" in
  true) printf 'notification_email_send=enabled\n' ;;
  false) printf 'notification_email_send=disabled\n' ;;
  *) printf 'notification_email_send=invalid\n'; fail "notification_email_send:invalid" ;;
esac

release_identity_verifier_enabled=$(value_of "$release_identity_verifier" RELEASE_IDENTITY_VERIFIER_ENABLED 2>/dev/null || printf 'unknown')
case "$release_identity_verifier_enabled" in
  true)
    printf 'release_identity_verifier=enabled\n'
    item=release-identity-verifier-webauthn-policy.json
    if [ ! -f "$secret_dir/$item" ]; then
      fail "$item:missing_while_verifier_enabled"
    else
      mode=$(mode_of "$secret_dir/$item")
      case "$mode" in 400|440) ;; *) fail "$item:unsafe_permissions" ;; esac
    fi
    ;;
  false) printf 'release_identity_verifier=disabled\n' ;;
  *) printf 'release_identity_verifier=invalid\n'; fail "release_identity_verifier:invalid" ;;
esac

release_webhook_enabled=$(value_of "$release_webhook" RELEASE_WEBHOOK_INGRESS_ENABLED 2>/dev/null || printf 'unknown')
case "$release_webhook_enabled" in
  true)
    printf 'release_webhook_ingress=enabled\n'
    for item in release-webhook-binding.json release-webhook-secret; do
      if [ ! -f "$secret_dir/$item" ]; then
        fail "$item:missing_while_ingress_enabled"
        continue
      fi
      mode=$(mode_of "$secret_dir/$item")
      case "$item:$mode" in
        release-webhook-binding.json:400|release-webhook-binding.json:440|release-webhook-binding.json:600|release-webhook-binding.json:640) ;;
        release-webhook-secret:400|release-webhook-secret:440) ;;
        *) fail "$item:unsafe_permissions" ;;
      esac
    done
    ;;
  false) printf 'release_webhook_ingress=disabled\n' ;;
  *) printf 'release_webhook_ingress=invalid\n'; fail "release_webhook_ingress:invalid" ;;
esac

configuration_activation_enabled=$(value_of "$configuration_activation" CONFIGURATION_ACTIVATION_WORKER_ENABLED 2>/dev/null || printf 'unknown')
case "$configuration_activation_enabled" in
  true) printf 'configuration_activation_worker=enabled\n' ;;
  false) printf 'configuration_activation_worker=disabled\n' ;;
  *) printf 'configuration_activation_worker=invalid\n'; fail "configuration_activation_worker:invalid" ;;
esac

for environment in staging production; do
  if [ "$environment" = staging ]; then
    release_orchestrator=$release_orchestrator_staging
    release_auditor=$release_auditor_staging
  else
    release_orchestrator=$release_orchestrator_production
    release_auditor=$release_auditor_production
  fi
  release_orchestrator_enabled=$(value_of "$release_orchestrator" RELEASE_ORCHESTRATOR_WORKER_ENABLED 2>/dev/null || printf 'unknown')
  case "$release_orchestrator_enabled" in
    true)
      printf 'release_orchestrator_worker_%s=enabled\n' "$environment"
      for suffix in binding.json app.pem; do
        item="release-orchestrator-$environment-$suffix"
        if [ ! -f "$secret_dir/$item" ]; then fail "$item:missing_while_worker_enabled"; continue; fi
        mode=$(mode_of "$secret_dir/$item")
        case "$suffix:$mode" in
          binding.json:400|binding.json:440|binding.json:600|binding.json:640|app.pem:400|app.pem:440) ;;
          *) fail "$item:unsafe_permissions" ;;
        esac
      done
      ;;
    false) printf 'release_orchestrator_worker_%s=disabled\n' "$environment" ;;
    *) printf 'release_orchestrator_worker_%s=invalid\n' "$environment"; fail "release_orchestrator_worker_$environment:invalid" ;;
  esac

  release_auditor_enabled=$(value_of "$release_auditor" RELEASE_AUDITOR_ENABLED 2>/dev/null || printf 'unknown')
  case "$release_auditor_enabled" in
    true)
      printf 'release_provider_security_auditor_%s=enabled\n' "$environment"
      for suffix in policy.json app.pem attestation-ed25519.pem shared-secret; do
        item="release-auditor-$environment-$suffix"
        if [ ! -f "$secret_dir/$item" ]; then fail "$item:missing_while_auditor_enabled"; continue; fi
        mode=$(mode_of "$secret_dir/$item")
        case "$suffix:$mode" in
          policy.json:400|policy.json:440|policy.json:600|policy.json:640|app.pem:400|app.pem:440|attestation-ed25519.pem:400|attestation-ed25519.pem:440|shared-secret:400|shared-secret:440) ;;
          *) fail "$item:unsafe_permissions" ;;
        esac
      done
      ;;
    false) printf 'release_provider_security_auditor_%s=disabled\n' "$environment" ;;
    *) printf 'release_provider_security_auditor_%s=invalid\n' "$environment"; fail "release_provider_security_auditor_$environment:invalid" ;;
  esac
  if [ "$release_orchestrator_enabled" != "$release_auditor_enabled" ]; then
    fail "restricted_cicd_${environment}:worker_auditor_enablement_mismatch"
  elif [ "$release_orchestrator_enabled" = true ]; then
    if ! node --experimental-strip-types "$repository_root/scripts/release/restricted-cicd-instance-config.mjs" \
      "$environment" \
      "$secret_dir/release-orchestrator-$environment-binding.json" \
      "$secret_dir/release-auditor-$environment-policy.json"; then
      fail "restricted_cicd_${environment}:instance_config_invalid"
    fi
  fi
done

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
