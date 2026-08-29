import pg from "pg";
import { pathToFileURL } from "node:url";

import { assertLoopbackPostgresUrl } from "./postgres-recovery-rehearsal.mjs";

export const EXPECTED_RELEASE_DATABASE_ROLES = Object.freeze([
  "agentnovas_migrator",
  "agentnovas_client_auth",
  "agentnovas_client_web",
  "agentnovas_ops_web",
  "agentnovas_maint_web",
  "agentnovas_execution_service",
  "agentnovas_payment_webhook",
  "agentnovas_notification_worker",
  "agentnovas_configuration_activation_worker",
  "agentnovas_demo_execution_worker",
  "agentnovas_runtime_worker",
  "agentnovas_payment_worker",
  "agentnovas_research_worker",
  "agentnovas_release_worker",
  "agentnovas_release_control",
  "agentnovas_release_identity_verifier",
  "agentnovas_release_ingress",
  "agentnovas_release_auditor",
  "agentnovas_release_target_gateway",
]);

const DISABLED_ROLES = new Set([
  "agentnovas_payment_worker",
  "agentnovas_research_worker",
]);

export const EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES = Object.freeze([
  "agentnovas_payment_worker",
  "agentnovas_research_worker",
]);

const NOLOGIN_ROLES = new Set(EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES);

const RESTRICTED_CICD_ROUTINE_ALLOWLIST = new Map([
  ["agentnovas_maint_web", new Set([
    "release_workflow_read_maintenance_control",
    "release_workflow_issue_human_action_authority",
  ])],
  ["agentnovas_release_control", new Set(["release_workflow_execute_human_action"])],
  ["agentnovas_release_identity_verifier", new Set([
    "release_workflow_record_human_action_assertion",
    "release_workflow_resolve_human_action_assertion",
  ])],
  ["agentnovas_release_worker", new Set([
    "release_workflow_recover_expired_dispatch_v2",
    "release_workflow_claim_next_reconciliation_v2",
    "release_workflow_claim_next_command_v2",
    "release_workflow_begin_dispatch",
    "release_workflow_record_dispatch_unknown",
    "release_workflow_bind_provider_run",
    "release_workflow_reject_bound_run",
    "release_workflow_append_provider_event",
    "release_workflow_worker_heartbeat",
  ])],
  ["agentnovas_release_ingress", new Set(["release_workflow_append_delivery"])],
  ["agentnovas_release_auditor", new Set(["release_workflow_append_run_policy_attestation"])],
  ["agentnovas_release_target_gateway", new Set([
    "release_workflow_reserve_workflow_target_request_v4",
    "release_workflow_validate_target_authority_v2",
    "release_workflow_validate_target_cutover_v2",
    "release_workflow_recover_target_operation_v2",
    "release_workflow_list_recoverable_target_operations_v2",
    "release_workflow_assert_migration_registry",
    "release_workflow_takeover_target_operation",
    "release_workflow_append_target_receipt",
    "release_workflow_target_request_stop",
    "release_workflow_prepare_target_clear_ack_v2",
    "release_workflow_validate_target_stop_cleared_v2",
    "release_workflow_append_stop_receipt_v2",
  ])],
]);

const RESTRICTED_CICD_GATEWAY_ROLES = new Set([
  "agentnovas_release_control",
  "agentnovas_release_identity_verifier",
  "agentnovas_release_worker",
  "agentnovas_release_ingress",
  "agentnovas_release_auditor",
  "agentnovas_release_target_gateway",
]);

const RESTRICTED_CICD_ROUTINE_EXPECTED_GRANTEES = new Map();
for (const [roleName,routines] of RESTRICTED_CICD_ROUTINE_ALLOWLIST) {
  for (const routineName of routines) {
    const grantees = RESTRICTED_CICD_ROUTINE_EXPECTED_GRANTEES.get(routineName)
      ?? new Set(["agentnovas_migrator"]);
    grantees.add(roleName);
    RESTRICTED_CICD_ROUTINE_EXPECTED_GRANTEES.set(routineName,grantees);
  }
}

const CLIENT_IDENTITY_RLS_TABLES = Object.freeze([
  "users",
  "sessions",
  "auth_tokens",
  "user_mfa_totp_credentials",
  "user_mfa_recovery_codes",
]);

const CLIENT_IDENTITY_GATEWAY_ROUTINES = Object.freeze([
  "client_registration_attribution(text,text)",
  "client_login_identity(text,text,text)",
  "client_session_identity(text,timestamp with time zone)",
  "client_self_password_identity(text,timestamp with time zone)",
  "client_touch_session(text,timestamp with time zone,timestamp with time zone)",
  "client_complete_login(text,text,text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)",
  "client_complete_login_v3(text,text,text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,text,text)",
  "client_registration_conflicts(text,text)",
  "client_registration_invitation(text)",
  "client_insert_invited_customer(text,text,text,text,text,text)",
  "client_claim_registration_invitation(text,text,text,timestamp with time zone)",
  // 可复用邀请链接的使用计数。收进 client_ 网关是因为 invitations 表对客户端角色
  // REVOKE ALL——那张表存着全部邀请码，公网进程不该碰得到（见迁移 0063）。
  "client_record_reusable_invitation_use(text,timestamp with time zone)",
  "client_profile_conflicts(text,text,text,text)",
  "client_update_profile(text,text,text,text,text,text,text,text,text,timestamp with time zone)",
  "client_change_password(text,text,text,timestamp with time zone)",
  "client_list_sessions(text,timestamp with time zone)",
  "client_revoke_session(text,text,timestamp with time zone)",
  "client_revoke_current_session(text,timestamp with time zone)",
  "client_revoke_all_sessions(text,timestamp with time zone)",
  "client_mfa_start(text,text,timestamp with time zone)",
  "client_mfa_credential(text,text)",
  "client_mfa_accept_totp(text,bigint,timestamp with time zone)",
  "client_mfa_consume_recovery(text,text,timestamp with time zone)",
  "client_mfa_replace_recovery(text,jsonb,timestamp with time zone)",
  "client_mfa_complete_enrollment(text,bigint,timestamp with time zone,jsonb,timestamp with time zone)",
  "client_mfa_mark_session_verified(text,text,timestamp with time zone,timestamp with time zone)",
  "client_mfa_recovery_status(text)",
  "client_queue_password_reset(text,text,text,timestamp with time zone,text,text,timestamp with time zone)",
  "client_queue_registration_email_verification(text,text,text,timestamp with time zone,text,text,timestamp with time zone)",
  "client_queue_email_verification_by_email(text,text,text,timestamp with time zone,text,text,timestamp with time zone)",
  "client_consume_password_reset(text,text,timestamp with time zone)",
  "client_verify_email(text,timestamp with time zone)",
]);

const IDENTITY_TABLE_ALLOWED_GRANTEES = new Map([
  ["users", new Set(["agentnovas_migrator", "agentnovas_ops_web", "agentnovas_maint_web", "agentnovas_notification_worker"])],
  ["sessions", new Set(["agentnovas_migrator", "agentnovas_ops_web", "agentnovas_maint_web"])],
  ["auth_tokens", new Set(["agentnovas_migrator", "agentnovas_ops_web", "agentnovas_maint_web"])],
  ["user_mfa_totp_credentials", new Set(["agentnovas_migrator", "agentnovas_ops_web", "agentnovas_maint_web"])],
  ["user_mfa_recovery_codes", new Set(["agentnovas_migrator", "agentnovas_ops_web", "agentnovas_maint_web"])],
  ["invitations", new Set(["agentnovas_migrator", "agentnovas_ops_web", "agentnovas_maint_web"])],
  ["internal_registration_links", new Set(["agentnovas_migrator", "agentnovas_ops_web"])],
  ["internal_registration_link_uses", new Set(["agentnovas_migrator", "agentnovas_ops_web"])],
]);

const identityGatewayGrantee = (signature) => signature.startsWith("client_login_identity(")
  || signature.startsWith("client_self_password_identity(")
  || signature.startsWith("client_queue_password_reset(")
  || signature.startsWith("client_queue_email_verification_by_email(")
  ? "agentnovas_client_auth"
  : "agentnovas_client_web";

function agentnovasRolesInExpression(expression) {
  return new Set(Array.from(
    String(expression ?? "").matchAll(/'(agentnovas_[a-z0-9_]+)'/gi),
    (match) => match[1].toLowerCase(),
  ));
}

function quotedValuesInExpression(expression) {
  return new Set(Array.from(
    String(expression ?? "").matchAll(/'((?:''|[^'])*)'/g),
    (match) => match[1].replaceAll("''", "'").toLowerCase(),
  ));
}

function sameStringSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function normalizedRoutineSetting(value) {
  return String(value).replaceAll('"', "").replace(/\s+/g, "").trim().toLowerCase();
}

const WEB_SECRET_TABLES = new Map([
  ["agentnovas_client_web", new Set([
    "llm_configurations",
    "llm_profile_revisions",
    "notification_provider_configs",
    "payment_provider_configs",
    "platform_demo_accounts",
    "resend_webhook_events",
  ])],
  ["agentnovas_ops_web", new Set([
    "llm_configurations",
    "llm_profile_revisions",
    "notification_provider_configs",
    "payment_provider_configs",
    "platform_demo_accounts",
    "resend_webhook_events",
  ])],
]);

const RELEASE_CONTROL_TABLES = new Set([
  "release_versions",
  "release_verifications",
  "release_deployments",
]);

const RESTRICTED_CICD_BASE_TABLES = new Set([
  "release_workflow_commands",
  "release_workflow_provider_bindings",
  "release_workflow_approvals",
  "release_workflow_activations",
  "release_workflow_first_production_enablements",
  "release_workflow_environment_generations",
  "release_workflow_attempts",
  "release_workflow_authorizations",
  "release_workflow_target_operations",
  "release_workflow_target_owner_epochs",
  "release_workflow_run_policy_attestations",
  "release_workflow_events",
  "release_workflow_deliveries",
  "release_workflow_receipts",
  "release_workflow_stop_receipts",
  "release_workflow_stops",
  "release_workflow_artifact_manifests",
  "release_workflow_control_bundles",
  "release_workflow_actor_authorities",
  "release_workflow_restore_capabilities",
  "release_workflow_human_action_assertions",
  "release_workflow_human_action_authorities",
  "release_workflow_human_action_assertion_consumptions",
  "release_workflow_command_requests",
  "release_workflow_command_request_reviews",
  "release_workflow_activation_requests",
  "release_workflow_activation_request_reviews",
  "release_workflow_stop_release_requests",
  "release_workflow_stop_release_reviews",
  "release_workflow_command_states",
  "release_workflow_environment_states",
]);

const CONFIGURATION_CONTROL_TABLES = new Set([
  "configuration_versions",
  "configuration_test_results",
  "configuration_approvals",
  "configuration_schedules",
  "configuration_activations",
]);

const MAINTENANCE_WORK_RECORD_RAW_TABLES = new Set([
  "strategy_subscription_periods",
  "strategy_decision_rounds",
  "strategy_runtime_events",
  "strategy_runtime_cycles",
  "market_data_snapshots",
]);

const WORKER_TABLES = new Map([
  ["agentnovas_payment_webhook", new Set([
    "deposit_orders",
    "deposit_provider_events",
    "payment_webhook_provider_configs_safe",
  ])],
  ["agentnovas_notification_worker", new Set([
    "audit_logs",
    "membership_access_events",
    "memberships",
    "notification_deliveries",
    "notification_email_suppressions",
    "notification_provider_configs",
    "official_paper_portfolios",
    "official_paper_positions",
    "users",
    "worker_instances",
  ])],
  ["agentnovas_configuration_activation_worker", new Set([
    "configuration_activations",
    "configuration_approvals",
    "configuration_schedules",
    "configuration_test_results",
    "configuration_versions",
    "worker_instances",
  ])],
  ["agentnovas_demo_execution_worker", new Set([
    "platform_demo_accounts",
    "platform_demo_card_controls",
    "platform_demo_execution_receipts",
    "platform_demo_fill_receipts",
    "platform_demo_order_intents",
    "worker_instances",
  ])],
  ["agentnovas_runtime_worker", new Set([
    "llm_profile_revisions",
    "llm_profiles",
    "market_data_snapshots",
    "memberships",
    "official_paper_fill_receipts",
    "official_paper_ledger_entries",
    "official_paper_order_intents",
    "official_paper_portfolios",
    "official_paper_positions",
    "platform_demo_accounts",
    "platform_demo_card_controls",
    "platform_demo_order_intents",
    "runtime_explanation_bindings",
    // 共享决策轮（0046–0048）：同一张卡、同一根 K 线只算一次。
    "strategy_decision_rounds",
    "strategy_deployments",
    // 实盘部署要判断绑定的账户是否可用。授权是**列级**的
    // （least-privilege-roles.sql），encrypted_credential_ref 不在其中——
    // Worker 拿不到凭证密文，解密只发生在执行服务里（ADR-0019）。
    "exchange_accounts",
    "strategy_runtime_cycles",
    "strategy_runtime_events",
    "strategy_runtime_explanation_jobs",
    "strategy_versions",
    "worker_instances",
  ])],
  // 执行服务：全系统唯一能解密交易所凭证的进程。
  //
  // 它不在这里的话，即使角色建出来了，拿到任何越权 GRANT 也不会被检查器发现
  // ——一个不在白名单里的角色等于不受这条闸门约束。
  ["agentnovas_execution_service", new Set([
    "audit_logs",
    "exchange_accounts",
    "execution_kill_switches",
    "execution_live_routing",
    "execution_reconciliations",
    "live_execution_receipts",
    "official_paper_portfolios",
    "platform_decisions",
    "strategy_deployments",
    "trades",
    "worker_instances",
  ])],
]);

const WORKER_TABLE_PRIVILEGES = new Map([
  ["agentnovas_configuration_activation_worker", new Map([
    ["configuration_activations", new Set(["SELECT"])],
    ["configuration_approvals", new Set(["SELECT"])],
    ["configuration_schedules", new Set(["SELECT"])],
    ["configuration_test_results", new Set(["SELECT"])],
    ["configuration_versions", new Set(["SELECT"])],
    ["worker_instances", new Set(["SELECT", "INSERT", "UPDATE"])],
  ])],
]);

function finding(code, message, roleName = null) {
  return { code, message, roleName };
}

export function evaluatePostgresRolePolicy({
  roles,
  grants,
  schemaGrants,
  sequenceGrants = [],
  routineGrants = [],
  memberships = [],
  identityTables,
  identityPolicies,
  identityRoutines,
  configurationActivationRoutines,
  configurationConsumerRoutines,
  restrictedCicdRoutines,
  triggerReadGaps = [],
}) {
  const findings = [];
  const byName = new Map(roles.map((role) => [role.roleName, role]));

  for (const roleName of EXPECTED_RELEASE_DATABASE_ROLES) {
    const role = byName.get(roleName);
    if (!role) {
      findings.push(finding("MISSING_ROLE", `Required release role is missing: ${roleName}`, roleName));
      continue;
    }
    if (role.superuser || role.createRole || role.createDatabase || role.replication || role.bypassRls) {
      findings.push(finding("ELEVATED_ROLE", `Release role has prohibited cluster privileges: ${roleName}`, roleName));
    }
    const shouldLogin = !NOLOGIN_ROLES.has(roleName);
    if (Boolean(role.canLogin) !== shouldLogin) {
      findings.push(finding(
        "ROLE_LOGIN_STATE",
        shouldLogin ? `Active release role cannot login: ${roleName}` : `Disabled worker role can login: ${roleName}`,
        roleName,
      ));
    }
  }

  for (const grant of grants) {
    if (grant.grantee === "PUBLIC") {
      findings.push(finding("PUBLIC_TABLE_GRANT", `PUBLIC has ${grant.privilegeType} on ${grant.tableName}`, "PUBLIC"));
      continue;
    }
    if (DISABLED_ROLES.has(grant.grantee)) {
      findings.push(finding("DISABLED_WORKER_ACCESS", `Disabled worker has table access: ${grant.grantee}`, grant.grantee));
      continue;
    }
    if (RESTRICTED_CICD_GATEWAY_ROLES.has(grant.grantee)) {
      findings.push(finding(
        "RESTRICTED_CICD_DIRECT_TABLE_GRANT",
        `${grant.grantee} has prohibited direct table access: ${grant.tableName}`,
        grant.grantee,
      ));
      continue;
    }
    if (RESTRICTED_CICD_BASE_TABLES.has(grant.tableName) && grant.grantee!=="agentnovas_migrator") {
      findings.push(finding(
        "RESTRICTED_CICD_BASE_TABLE_GRANT",
        `${grant.grantee} bypasses the restricted CI/CD gateway on ${grant.tableName}`,
        grant.grantee,
      ));
    }
    if (grant.tableName==="release_workflow_safe_status"
      && !["agentnovas_migrator","agentnovas_maint_web"].includes(grant.grantee)) {
      findings.push(finding(
        "RESTRICTED_CICD_SAFE_VIEW_GRANT",
        `${grant.grantee} can read the restricted CI/CD Maintenance view`,
        grant.grantee,
      ));
    }
    const allowlist = WORKER_TABLES.get(grant.grantee);
    if (allowlist && !allowlist.has(grant.tableName)) {
      findings.push(finding(
        "WORKER_TABLE_GRANT",
        `${grant.grantee} has access outside its table allowlist: ${grant.tableName}`,
        grant.grantee,
      ));
    }
    const privilegeAllowlist = WORKER_TABLE_PRIVILEGES.get(grant.grantee)?.get(grant.tableName);
    if (privilegeAllowlist && !privilegeAllowlist.has(String(grant.privilegeType).toUpperCase())) {
      findings.push(finding(
        "WORKER_TABLE_PRIVILEGE",
        `${grant.grantee} has prohibited ${grant.privilegeType} access on ${grant.tableName}`,
        grant.grantee,
      ));
    }
    const deniedSecrets = WEB_SECRET_TABLES.get(grant.grantee);
    if (deniedSecrets?.has(grant.tableName)) {
      findings.push(finding(
        "WEB_SECRET_GRANT",
        `${grant.grantee} can access a Maintenance-only secret-bearing table: ${grant.tableName}`,
        grant.grantee,
      ));
    }
    const identityAllowlist = IDENTITY_TABLE_ALLOWED_GRANTEES.get(grant.tableName);
    if (identityAllowlist && !identityAllowlist.has(grant.grantee)) {
      findings.push(finding(
        "IDENTITY_TABLE_GRANT",
        `${grant.grantee} has direct access to protected identity table ${grant.tableName}`,
        grant.grantee,
      ));
    }
    if (RELEASE_CONTROL_TABLES.has(grant.tableName)
      && !["agentnovas_migrator", "agentnovas_maint_web"].includes(grant.grantee)) {
      findings.push(finding(
        "RELEASE_CONTROL_TABLE_GRANT",
        `${grant.grantee} can access Maintenance-only release evidence table ${grant.tableName}`,
        grant.grantee,
      ));
    }
    if (CONFIGURATION_CONTROL_TABLES.has(grant.tableName)
      && !["agentnovas_migrator", "agentnovas_maint_web", "agentnovas_configuration_activation_worker"].includes(grant.grantee)) {
      findings.push(finding(
        "CONFIGURATION_CONTROL_TABLE_GRANT",
        `${grant.grantee} can access Maintenance-only versioned configuration table ${grant.tableName}`,
        grant.grantee,
      ));
    }
    if (grant.grantee === "agentnovas_maint_web" && MAINTENANCE_WORK_RECORD_RAW_TABLES.has(grant.tableName)) {
      findings.push(finding(
        "MAINTENANCE_WORK_RECORD_RAW_GRANT",
        `${grant.grantee} can access raw Client work-record table ${grant.tableName}`,
        grant.grantee,
      ));
    }
  }

  for (const grant of schemaGrants) {
    if (grant.privilegeType === "CREATE" && grant.grantee !== "agentnovas_migrator") {
      findings.push(finding("SCHEMA_CREATE_GRANT", `${grant.grantee} can create objects in the application schema`, grant.grantee));
    }
  }

  for (const grant of sequenceGrants) {
    if (grant.grantee === "PUBLIC") {
      findings.push(finding("PUBLIC_SEQUENCE_GRANT", `PUBLIC has ${grant.privilegeType} on ${grant.sequenceName}`, "PUBLIC"));
      continue;
    }
    if (DISABLED_ROLES.has(grant.grantee)) {
      findings.push(finding("DISABLED_WORKER_ACCESS", `Disabled worker has sequence access: ${grant.grantee}`, grant.grantee));
      continue;
    }
    if (RESTRICTED_CICD_GATEWAY_ROLES.has(grant.grantee)) {
      findings.push(finding(
        "RESTRICTED_CICD_DIRECT_SEQUENCE_GRANT",
        `${grant.grantee} has prohibited direct sequence access: ${grant.sequenceName}`,
        grant.grantee,
      ));
      continue;
    }
    if (grant.grantee === "agentnovas_configuration_activation_worker") {
      findings.push(finding(
        "WORKER_SEQUENCE_GRANT",
        `${grant.grantee} has prohibited ${grant.privilegeType} access on ${grant.sequenceName}`,
        grant.grantee,
      ));
    }
  }

  for (const grant of routineGrants) {
    if (grant.grantee==="agentnovas_migrator" && String(grant.routineName).startsWith("release_workflow_")) {
      continue;
    }
    const restrictedCicdAllowlist = RESTRICTED_CICD_ROUTINE_ALLOWLIST.get(grant.grantee);
    if (String(grant.routineName).startsWith("release_workflow_")
      || RESTRICTED_CICD_GATEWAY_ROLES.has(grant.grantee)) {
      if (!restrictedCicdAllowlist?.has(grant.routineName)
        || String(grant.privilegeType).toUpperCase()!=="EXECUTE") {
        findings.push(finding(
          "RESTRICTED_CICD_ROUTINE_GRANT",
          `${grant.grantee} has prohibited ${grant.privilegeType} access on ${grant.routineName}`,
          grant.grantee,
        ));
      }
      continue;
    }
    if (grant.grantee === "PUBLIC") {
      findings.push(finding(
        "PUBLIC_ROUTINE_GRANT",
        `PUBLIC can ${grant.privilegeType} ${grant.routineName}`,
        "PUBLIC",
      ));
    } else if (DISABLED_ROLES.has(grant.grantee)) {
      findings.push(finding(
        "DISABLED_WORKER_ACCESS",
        `Disabled worker can ${grant.privilegeType} ${grant.routineName}`,
        grant.grantee,
      ));
    } else if (grant.grantee === "agentnovas_configuration_activation_worker"
      && (grant.routineName !== "configuration_activation_worker_activate"
        || String(grant.privilegeType).toUpperCase() !== "EXECUTE")) {
      findings.push(finding(
        "WORKER_ROUTINE_GRANT",
        `${grant.grantee} has prohibited ${grant.privilegeType} access on ${grant.routineName}`,
        grant.grantee,
      ));
    } else if (grant.grantee === "agentnovas_client_web"
      && String(grant.routineName).startsWith("configuration_")
      && (grant.routineName !== "configuration_client_active_feature_flag"
        || String(grant.privilegeType).toUpperCase() !== "EXECUTE")) {
      findings.push(finding(
        "CONFIGURATION_CONSUMER_ROUTINE_GRANT",
        `${grant.grantee} has prohibited ${grant.privilegeType} access on ${grant.routineName}`,
        grant.grantee,
      ));
    }
  }

  for (const membership of memberships) {
    const controlledRole = EXPECTED_RELEASE_DATABASE_ROLES.includes(membership.memberRole)
      ? membership.memberRole
      : EXPECTED_RELEASE_DATABASE_ROLES.includes(membership.grantedRole)
        ? membership.grantedRole
        : null;
    if (controlledRole) {
      findings.push(finding(
        "ROLE_MEMBERSHIP",
        `Prohibited role membership connects ${membership.memberRole} to ${membership.grantedRole}`,
        controlledRole,
      ));
    }
  }

  if (identityTables && identityPolicies) {
    const tablesByName = new Map(identityTables.map((table) => [table.tableName, table]));
    const policiesByName = new Map(identityPolicies.map((policy) => [`${policy.tableName}:${policy.policyName}`, policy]));
    for (const tableName of CLIENT_IDENTITY_RLS_TABLES) {
      const table = tablesByName.get(tableName);
      if (!table?.rlsEnabled) {
        findings.push(finding("IDENTITY_RLS_DISABLED", `Client identity table has no RLS: ${tableName}`, "agentnovas_client_web"));
      }
      if (!table?.forceRlsEnabled) {
        findings.push(finding("IDENTITY_RLS_NOT_FORCED", `Client identity table owner can bypass RLS: ${tableName}`, "agentnovas_client_web"));
      }
      if (table && table.ownerName !== "agentnovas_migrator") {
        findings.push(finding("IDENTITY_TABLE_OWNER", `Identity table is not owned by the migrator: ${tableName}`, table.ownerName));
      }
      const policyName = `${tableName}_client_identity_partition`;
      const policy = policiesByName.get(`${tableName}:${policyName}`);
      if (!policy) {
        findings.push(finding("IDENTITY_POLICY_MISSING", `Restrictive Client identity policy is missing: ${tableName}`, "agentnovas_client_web"));
        continue;
      }
      const usingExpression = String(policy.usingExpression ?? "");
      const checkExpression = String(policy.checkExpression ?? "");
      const expression = `${usingExpression} ${checkExpression}`;
      const roles = Array.isArray(policy.policyRoles) ? policy.policyRoles : [];
      const expectedPolicyRoles = IDENTITY_TABLE_ALLOWED_GRANTEES.get(tableName) ?? new Set();
      const usingRoles = agentnovasRolesInExpression(usingExpression);
      const checkRoles = agentnovasRolesInExpression(checkExpression);
      const usingValues = quotedValuesInExpression(usingExpression);
      const checkValues = quotedValuesInExpression(checkExpression);
      if (!policy.restrictive || policy.command !== "*"
        || roles.length !== 1 || roles[0] !== "PUBLIC"
        || !/current_user/i.test(usingExpression) || !/current_user/i.test(checkExpression)
        || !sameStringSet(usingRoles, expectedPolicyRoles)
        || !sameStringSet(checkRoles, expectedPolicyRoles)
        || !sameStringSet(usingValues, expectedPolicyRoles)
        || !sameStringSet(checkValues, expectedPolicyRoles)
        || /agentnovas_client_(?:web|auth)|\bor\b|current_setting|set_config|request\.|jwt|session_user/i.test(expression)) {
        findings.push(finding("IDENTITY_POLICY_UNSAFE", `Client identity policy does not fail closed to gateway-only access: ${tableName}`, "agentnovas_client_web"));
      }
      const basePolicy = policiesByName.get(`${tableName}:${tableName.replace(/^user_mfa_totp_credentials$/, "mfa_totp").replace(/^user_mfa_recovery_codes$/, "mfa_recovery")}_identity_base_access`);
      if (!basePolicy || basePolicy.restrictive || basePolicy.command !== "*"
        || (basePolicy.policyRoles ?? []).length !== 1 || basePolicy.policyRoles[0] !== "PUBLIC"
        || String(basePolicy.usingExpression).trim() !== "true"
        || String(basePolicy.checkExpression).trim() !== "true") {
        findings.push(finding("IDENTITY_BASE_POLICY_MISSING", `Identity base policy is missing or malformed: ${tableName}`, "agentnovas_client_web"));
      }
    }
  }

  // 触发器函数如果不是 SECURITY DEFINER，函数体里的查询跑在**调用方**权限下。
  //
  // 客户注册就是这样炸掉的：0044 给 audit_logs 加了防篡改哈希链，接链要先读出链尾，
  // 而写审计日志的进程角色只有 INSERT——审计表存着全平台的操作记录，公网进程本就
  // 不该读得到。于是任何「插一条审计日志」的动作都 42501，而注册的最后一步正是它。
  //
  // 这一类在开发机上完全看不见：本地用超级用户跑，读一路放行。只有配了最小权限
  // 角色的环境才会暴露，也就是生产。所以必须由闸门在发布前查出来。
  for (const gap of triggerReadGaps) {
    findings.push(finding(
      "TRIGGER_READ_PRIVILEGE_GAP",
      `${gap.grantee} can write ${gap.writeTable} but the non-SECURITY DEFINER trigger `
      + `${gap.functionName}() reads ${gap.readTable}, which it cannot ${gap.privilege}`,
      gap.grantee,
    ));
  }

  if (identityRoutines) {
    const bySignature = new Map(identityRoutines.map((routine) => [routine.signature, routine]));
    const expectedSignatures = new Set(CLIENT_IDENTITY_GATEWAY_ROUTINES);
    for (const routine of identityRoutines) {
      const executeGrantees = Array.isArray(routine.executeGrantees) ? routine.executeGrantees : [];
      if (!expectedSignatures.has(routine.signature)
        && executeGrantees.some((grantee) => grantee !== "agentnovas_migrator")) {
        findings.push(finding(
          "IDENTITY_GATEWAY_UNREGISTERED",
          `Unregistered Client routine is executable by a runtime role: ${routine.signature}`,
          "agentnovas_client_web",
        ));
      }
    }
    for (const signature of CLIENT_IDENTITY_GATEWAY_ROUTINES) {
      const routine = bySignature.get(signature);
      if (!routine) {
        findings.push(finding("IDENTITY_GATEWAY_MISSING", `Client identity gateway is missing: ${signature}`, "agentnovas_client_web"));
        continue;
      }
      const config = Array.isArray(routine.config) ? routine.config : [];
      const executeGrantees = Array.isArray(routine.executeGrantees) ? routine.executeGrantees : [];
      const expectedGrantee = identityGatewayGrantee(signature);
      const expectedExecuteGrantees = new Set(["agentnovas_migrator", expectedGrantee]);
      const searchPathIsPinned = config.some((value) => (
        normalizedRoutineSetting(value) === "search_path=pg_catalog,public"
      ));
      if (routine.ownerName !== "agentnovas_migrator" || !routine.securityDefiner
        || !searchPathIsPinned
        || executeGrantees.length !== expectedExecuteGrantees.size
        || executeGrantees.some((grantee) => !expectedExecuteGrantees.has(grantee))) {
        findings.push(finding("IDENTITY_GATEWAY_UNSAFE", `Client identity gateway contract drifted: ${signature}`, "agentnovas_client_web"));
      }
    }
  }

  if (configurationActivationRoutines) {
    const gateway = configurationActivationRoutines.find((routine) => (
      routine.signature === "configuration_activation_worker_activate(text)"
    ));
    const executeGrantees = new Set(gateway?.executeGrantees ?? []);
    const expectedExecuteGrantees = new Set([
      "agentnovas_configuration_activation_worker",
      "agentnovas_migrator",
    ]);
    const config = Array.isArray(gateway?.config) ? gateway.config : [];
    const pinnedPath = config.some((value) => (
      normalizedRoutineSetting(value) === "search_path=public,pg_catalog"
    ));
    if (!gateway
      || gateway.ownerName !== "agentnovas_migrator"
      || !gateway.securityDefiner
      || !pinnedPath
      || !sameStringSet(executeGrantees, expectedExecuteGrantees)) {
      findings.push(finding(
        "CONFIGURATION_ACTIVATION_GATEWAY_UNSAFE",
        "Configuration activation Worker gateway is missing or unsafe",
        "agentnovas_configuration_activation_worker",
      ));
    }
  }

  if (configurationConsumerRoutines) {
    const gateway = configurationConsumerRoutines.find((routine) => (
      routine.signature === "configuration_client_active_feature_flag(text)"
    ));
    const executeGrantees = new Set(gateway?.executeGrantees ?? []);
    const expectedExecuteGrantees = new Set(["agentnovas_client_web", "agentnovas_migrator"]);
    const config = Array.isArray(gateway?.config) ? gateway.config : [];
    const pinnedPath = config.some((value) => (
      normalizedRoutineSetting(value) === "search_path=public,pg_catalog"
    ));
    if (!gateway
      || gateway.ownerName !== "agentnovas_migrator"
      || !gateway.securityDefiner
      || !pinnedPath
      || !sameStringSet(executeGrantees, expectedExecuteGrantees)) {
      findings.push(finding(
        "CONFIGURATION_CONSUMER_GATEWAY_UNSAFE",
        "Client feature flag gateway is missing or unsafe",
        "agentnovas_client_web",
      ));
    }
  }

  if (restrictedCicdRoutines) {
    const routinesByName = new Map(restrictedCicdRoutines.map((routine) => [routine.routineName,routine]));
    for (const [routineName,expectedGrantees] of RESTRICTED_CICD_ROUTINE_EXPECTED_GRANTEES) {
      const routine = routinesByName.get(routineName);
      const actualGrantees = new Set(routine?.executeGrantees ?? []);
      const pinnedPath = (routine?.config ?? []).some((entry) => (
        normalizedRoutineSetting(entry)==="search_path=pg_catalog,public"
      ));
      if (!routine || routine.ownerName!=="agentnovas_migrator" || !routine.securityDefiner
        || !pinnedPath || !sameStringSet(actualGrantees,expectedGrantees)) {
        findings.push(finding(
          "RESTRICTED_CICD_GATEWAY_UNSAFE",
          `Restricted CI/CD gateway is missing, unpinned, or broadly granted: ${routineName}`,
          routineName,
        ));
      }
    }
  }

  return findings;
}

async function verifyConfiguredDatabase() {
  const rawUrl = process.env.RELEASE_ROLE_POLICY_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error("RELEASE_ROLE_POLICY_DATABASE_URL is required");
  const url = assertLoopbackPostgresUrl(rawUrl, { requireRehearsalSource: false });
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 1,
    application_name: "agentnovas-release-role-policy",
  });
  try {
    const [
      rolesResult,
      routineGrantsResult,
      grantsResult,
      sequenceGrantsResult,
      schemaGrantsResult,
      membershipsResult,
      identityTablesResult,
      identityPoliciesResult,
      identityRoutinesResult,
      configurationActivationRoutinesResult,
      configurationConsumerRoutinesResult,
      restrictedCicdRoutinesResult,
      triggerReadGapsResult,
    ] = await Promise.all([
      pool.query(`
        SELECT rolname AS "roleName", rolcanlogin AS "canLogin", rolsuper AS superuser,
               rolcreaterole AS "createRole", rolcreatedb AS "createDatabase",
               rolreplication AS replication, rolbypassrls AS "bypassRls"
        FROM pg_roles
        WHERE rolname = ANY($1::text[])
      `, [EXPECTED_RELEASE_DATABASE_ROLES]),
      pool.query(`
        SELECT grantee, routine_name AS "routineName", privilege_type AS "privilegeType"
        FROM information_schema.routine_privileges
        WHERE routine_schema='public'
      `),
      pool.query(`
        SELECT grantee, table_name AS "tableName", privilege_type AS "privilegeType"
        FROM information_schema.table_privileges
        WHERE table_schema='public'
      `),
      pool.query(`
        SELECT COALESCE(grantee.rolname,'PUBLIC') AS grantee,
               sequence.relname AS "sequenceName",acl.privilege_type AS "privilegeType"
          FROM pg_class AS sequence
          JOIN pg_namespace AS namespace ON namespace.oid=sequence.relnamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(sequence.relacl,acldefault('S',sequence.relowner))
          ) AS acl
          LEFT JOIN pg_roles AS grantee ON grantee.oid=acl.grantee
         WHERE namespace.nspname='public' AND sequence.relkind='S'
           AND (COALESCE(grantee.rolname,'PUBLIC')='PUBLIC'
                OR grantee.rolname=ANY($1::text[]))
      `, [EXPECTED_RELEASE_DATABASE_ROLES]),
      pool.query(`
        SELECT COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
               acl.privilege_type AS "privilegeType"
        FROM pg_namespace AS namespace
        CROSS JOIN LATERAL aclexplode(
          COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
        ) AS acl
        LEFT JOIN pg_roles AS grantee ON grantee.oid=acl.grantee
        WHERE namespace.nspname='public'
          AND (COALESCE(grantee.rolname, 'PUBLIC') = 'PUBLIC'
               OR grantee.rolname = ANY($1::text[]))
      `, [EXPECTED_RELEASE_DATABASE_ROLES]),
      pool.query(`
        SELECT member.rolname AS "memberRole", granted.rolname AS "grantedRole"
        FROM pg_auth_members AS membership
        JOIN pg_roles AS member ON member.oid=membership.member
        JOIN pg_roles AS granted ON granted.oid=membership.roleid
        WHERE member.rolname = ANY($1::text[])
           OR granted.rolname = ANY($1::text[])
      `, [EXPECTED_RELEASE_DATABASE_ROLES]),
      pool.query(`
        SELECT class.relname AS "tableName",class.relrowsecurity AS "rlsEnabled",
               class.relforcerowsecurity AS "forceRlsEnabled",owner.rolname AS "ownerName"
          FROM pg_class AS class
          JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
          JOIN pg_roles AS owner ON owner.oid=class.relowner
         WHERE namespace.nspname='public'
           AND class.relname=ANY($1::text[])
      `, [CLIENT_IDENTITY_RLS_TABLES]),
      pool.query(`
        SELECT class.relname AS "tableName",policy.polname AS "policyName",
               NOT policy.polpermissive AS restrictive,
               policy.polcmd AS command,
               ARRAY(
                 SELECT CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE role.rolname::text END
                 FROM unnest(policy.polroles) AS role_oid
                 LEFT JOIN pg_roles AS role ON role.oid=role_oid
               )::text[] AS "policyRoles",
               pg_get_expr(policy.polqual,policy.polrelid) AS "usingExpression",
               pg_get_expr(policy.polwithcheck,policy.polrelid) AS "checkExpression"
          FROM pg_policy AS policy
          JOIN pg_class AS class ON class.oid=policy.polrelid
          JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
         WHERE namespace.nspname='public'
           AND class.relname=ANY($1::text[])
      `, [CLIENT_IDENTITY_RLS_TABLES]),
      pool.query(`
        SELECT procedure.oid::regprocedure::text AS signature,
               owner.rolname AS "ownerName",procedure.prosecdef AS "securityDefiner",
               COALESCE(procedure.proconfig,'{}'::text[]) AS config,
               ARRAY(
                 SELECT COALESCE(grantee.rolname,'PUBLIC')
                   FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) AS acl
                   LEFT JOIN pg_roles AS grantee ON grantee.oid=acl.grantee
                  WHERE acl.privilege_type='EXECUTE'
                  ORDER BY COALESCE(grantee.rolname,'PUBLIC')
               )::text[] AS "executeGrantees"
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
          JOIN pg_roles AS owner ON owner.oid=procedure.proowner
         WHERE namespace.nspname='public'
           AND procedure.proname LIKE 'client_%'
      `),
      pool.query(`
        SELECT procedure.oid::regprocedure::text AS signature,
               owner.rolname AS "ownerName",procedure.prosecdef AS "securityDefiner",
               COALESCE(procedure.proconfig,'{}'::text[]) AS config,
               ARRAY(
                 SELECT COALESCE(grantee.rolname,'PUBLIC')
                   FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) AS acl
                   LEFT JOIN pg_roles AS grantee ON grantee.oid=acl.grantee
                  WHERE acl.privilege_type='EXECUTE'
                  ORDER BY COALESCE(grantee.rolname,'PUBLIC')
               )::text[] AS "executeGrantees"
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
          JOIN pg_roles AS owner ON owner.oid=procedure.proowner
         WHERE namespace.nspname='public'
           AND procedure.proname='configuration_activation_worker_activate'
      `),
      pool.query(`
        SELECT procedure.oid::regprocedure::text AS signature,
               owner.rolname AS "ownerName",procedure.prosecdef AS "securityDefiner",
               COALESCE(procedure.proconfig,'{}'::text[]) AS config,
               ARRAY(
                 SELECT COALESCE(grantee.rolname,'PUBLIC')
                   FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) AS acl
                   LEFT JOIN pg_roles AS grantee ON grantee.oid=acl.grantee
                  WHERE acl.privilege_type='EXECUTE'
                  ORDER BY COALESCE(grantee.rolname,'PUBLIC')
               )::text[] AS "executeGrantees"
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
          JOIN pg_roles AS owner ON owner.oid=procedure.proowner
         WHERE namespace.nspname='public'
           AND procedure.proname='configuration_client_active_feature_flag'
      `),
      pool.query(`
        SELECT procedure.proname AS "routineName",
               owner.rolname AS "ownerName",procedure.prosecdef AS "securityDefiner",
               COALESCE(procedure.proconfig,'{}'::text[]) AS config,
               ARRAY(
                 SELECT COALESCE(grantee.rolname,'PUBLIC')
                   FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) AS acl
                   LEFT JOIN pg_roles AS grantee ON grantee.oid=acl.grantee
                  WHERE acl.privilege_type='EXECUTE'
                  ORDER BY COALESCE(grantee.rolname,'PUBLIC')
               )::text[] AS "executeGrantees"
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
          JOIN pg_roles AS owner ON owner.oid=procedure.proowner
         WHERE namespace.nspname='public'
           AND procedure.proname LIKE 'release_workflow_%'
      `),
      // 非 SECURITY DEFINER 的触发器函数，函数体里读到的表 × 能写触发表的角色。
      // 从 pg_proc.prosrc 里抽表名是启发式的，宁可多报——多报一条要人看一眼，
      // 漏报一条是生产上一个功能整体不可用。
      pool.query(`
        WITH trigger_functions AS (
          SELECT DISTINCT
                 target.relname AS "writeTable",
                 procedure.proname AS "functionName",
                 procedure.prosrc AS body
            FROM pg_trigger AS trg
            JOIN pg_class AS target ON target.oid = trg.tgrelid
            JOIN pg_proc AS procedure ON procedure.oid = trg.tgfoid
            JOIN pg_namespace AS namespace ON namespace.oid = target.relnamespace
           WHERE NOT trg.tgisinternal
             AND namespace.nspname = 'public'
             AND NOT procedure.prosecdef
        ), reads AS (
          SELECT "writeTable", "functionName", lower(match[1]) AS "readTable"
            FROM trigger_functions,
                 LATERAL regexp_matches(body, '(?:FROM|JOIN)\\s+([a-zA-Z_][a-zA-Z0-9_]*)', 'gi') AS match
        ), real_reads AS (
          SELECT DISTINCT reads.*
            FROM reads
            JOIN pg_class AS source ON source.relname = reads."readTable"
            JOIN pg_namespace AS ns ON ns.oid = source.relnamespace AND ns.nspname = 'public'
           WHERE source.relkind IN ('r', 'v', 'm', 'p')
        )
        SELECT grantee AS grantee, "writeTable", "functionName", "readTable", 'SELECT' AS privilege
          FROM real_reads
          CROSS JOIN unnest($1::text[]) AS grantee
         WHERE has_table_privilege(grantee, 'public.' || "writeTable", 'INSERT')
           AND NOT has_table_privilege(grantee, 'public.' || "readTable", 'SELECT')
      `, [EXPECTED_RELEASE_DATABASE_ROLES]),
    ]);
    const findings = evaluatePostgresRolePolicy({
      triggerReadGaps: triggerReadGapsResult.rows,
      roles: rolesResult.rows,
      grants: grantsResult.rows,
      sequenceGrants: sequenceGrantsResult.rows,
      schemaGrants: schemaGrantsResult.rows,
      routineGrants: routineGrantsResult.rows,
      memberships: membershipsResult.rows,
      identityTables: identityTablesResult.rows,
      identityPolicies: identityPoliciesResult.rows,
      identityRoutines: identityRoutinesResult.rows,
      configurationActivationRoutines: configurationActivationRoutinesResult.rows,
      configurationConsumerRoutines: configurationConsumerRoutinesResult.rows,
      restrictedCicdRoutines: restrictedCicdRoutinesResult.rows,
    });
    process.stdout.write(`${JSON.stringify({ database: url.pathname.slice(1), findings }, null, 2)}\n`);
    if (findings.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyConfiguredDatabase().catch((error) => {
    process.stderr.write(`PostgreSQL role policy verification failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
