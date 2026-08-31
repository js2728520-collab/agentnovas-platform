import { hash as argon2Hash } from "@node-rs/argon2";
import { pathToFileURL } from "node:url";

import pg from "pg";

const CONFIRMATION = "seed-agentnovas-test-sites";
const EXPECTED_DATABASE = "agentnovas";
const MOCK_PREFIX = "mock-v1";
const STRATEGY_CODES = ["ai_conservative", "ai_balanced", "ai_aggressive"];
const TERMINAL_IN_APP_NOTIFICATION = { channel: "in_app", status: "delivered" };

const riskByStrategy = {
  ai_conservative: {
    maxAssetAllocationPct: 15,
    maxTotalAllocationPct: 25,
    riskPerTradePct: 0.3,
    dailyLossHaltPct: 1,
    maxDrawdownPct: 6,
    maxNewEntriesPerDay: 2,
    maxConcurrentAssets: 2,
  },
  ai_balanced: {
    maxAssetAllocationPct: 25,
    maxTotalAllocationPct: 50,
    riskPerTradePct: 0.5,
    dailyLossHaltPct: 2,
    maxDrawdownPct: 10,
    maxNewEntriesPerDay: 4,
    maxConcurrentAssets: 2,
  },
  ai_aggressive: {
    maxAssetAllocationPct: 35,
    maxTotalAllocationPct: 70,
    riskPerTradePct: 0.8,
    dailyLossHaltPct: 3,
    maxDrawdownPct: 15,
    maxNewEntriesPerDay: 6,
    maxConcurrentAssets: 2,
  },
};

function isoDaysAgo(now, days, hours = 0) {
  return new Date(now.getTime() - (days * 24 + hours) * 60 * 60 * 1000).toISOString();
}

function isoDaysFrom(now, days) {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function monthOf(now) {
  return now.toISOString().slice(0, 7);
}

export function assertPreviewMockSeedEnvironment({ databaseUrl, environment, execute }) {
  if (!execute) throw new Error("An explicit --apply or --verify mode is required");
  if (environment.PREVIEW_MOCK_DATA_CONFIRMATION !== CONFIRMATION) {
    throw new Error(`Preview MOCK confirmation must equal ${CONFIRMATION}`);
  }
  const expectedHost = String(environment.PREVIEW_MOCK_DATABASE_HOST ?? "").trim();
  if (!expectedHost) throw new Error("PREVIEW_MOCK_DATABASE_HOST is required");
  let url;
  try {
    url = new URL(String(databaseUrl));
  } catch {
    throw new Error("Preview MOCK database URL is invalid");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !url.username
    || url.hash
    || url.search
    || databaseName !== EXPECTED_DATABASE) {
    throw new Error("Preview MOCK database URL is not an explicit agentnovas PostgreSQL target");
  }
  if (url.hostname !== expectedHost) {
    throw new Error("Preview MOCK database host does not match PREVIEW_MOCK_DATABASE_HOST");
  }
  return url;
}

async function passwordHash() {
  return argon2Hash(`unpublished-${crypto.randomUUID()}-${crypto.randomUUID()}`, {
    algorithm: 2,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
}

async function resolvePreviewSentinels(client) {
  const database = await client.query("SELECT current_database() AS database_name");
  if (database.rows[0]?.database_name !== EXPECTED_DATABASE) {
    throw new Error("Preview MOCK seed reached the wrong database");
  }
  const migration = await client.query(`
    SELECT count(*)::int AS count,
           max(name) FILTER (WHERE name ~ '^[0-9]{4}_') AS latest
      FROM _agentnovas_migrations
  `);
  if (Number(migration.rows[0]?.count ?? 0) < 95 || String(migration.rows[0]?.latest ?? "") < "0094_") {
    throw new Error("Preview MOCK seed requires the current preview schema");
  }
  const headquarters = await client.query(`
    SELECT id FROM organizations
     WHERE type='headquarters' AND status='active'
     ORDER BY created_at,id
     FOR SHARE
  `);
  if (headquarters.rowCount !== 1) throw new Error("Preview headquarters sentinel is not unique");
  const administrators = await client.query(`
    SELECT id FROM users WHERE role='hq_admin' AND status='active'
    ORDER BY created_at,id FOR SHARE
  `);
  if (administrators.rowCount !== 1) throw new Error("Preview headquarters administrator sentinel is not unique");
  const assignments = await client.query(`
    SELECT role.code,user_account.id,user_account.role,user_account.status
      FROM roles role
      JOIN user_role_assignments assignment
        ON assignment.role_id=role.id
       AND assignment.application_id=role.application_id
       AND assignment.status='active'
      JOIN users user_account ON user_account.id=assignment.user_id
     WHERE role.code=ANY($1::text[])
       AND role.status='published'
       AND user_account.status='active'
     ORDER BY role.code,user_account.id
     FOR SHARE OF role,assignment,user_account
  `, [[
    "acceptance_client_admin_v1",
    "acceptance_operations_admin_v1",
    "acceptance_maintenance_admin_v1",
  ]]);
  const byCode = new Map();
  for (const row of assignments.rows) {
    if (byCode.has(row.code)) throw new Error(`Preview acceptance sentinel is not unique: ${row.code}`);
    byCode.set(row.code, row);
  }
  for (const code of [
    "acceptance_client_admin_v1",
    "acceptance_operations_admin_v1",
    "acceptance_maintenance_admin_v1",
  ]) {
    if (!byCode.has(code)) throw new Error(`Preview acceptance sentinel is missing: ${code}`);
  }
  if (byCode.get("acceptance_client_admin_v1").role !== "customer") {
    throw new Error("Preview client acceptance sentinel has an unexpected legacy role");
  }
  return {
    headquartersId: headquarters.rows[0].id,
    hqAdministratorId: administrators.rows[0].id,
    clientAcceptanceId: byCode.get("acceptance_client_admin_v1").id,
    operationsAcceptanceId: byCode.get("acceptance_operations_admin_v1").id,
    maintenanceAcceptanceId: byCode.get("acceptance_maintenance_admin_v1").id,
  };
}

function fixture(sentinels, now, mockPasswordHash) {
  const east = `${MOCK_PREFIX}-org-east`;
  const south = `${MOCK_PREFIX}-org-south`;
  const staff = [
    { id: `${MOCK_PREFIX}-east-branch-admin`, email: "east.branch.admin@fixture.invalid", role: "branch_admin", organizationId: east, reportsToUserId: sentinels.hqAdministratorId, nickname: "[MOCK] 华东分公司负责人" },
    { id: `${MOCK_PREFIX}-east-manager`, email: "east.manager@fixture.invalid", role: "manager", organizationId: east, reportsToUserId: `${MOCK_PREFIX}-east-branch-admin`, nickname: "[MOCK] 华东业务主管" },
    { id: `${MOCK_PREFIX}-east-supervisor`, email: "east.supervisor@fixture.invalid", role: "supervisor", organizationId: east, reportsToUserId: `${MOCK_PREFIX}-east-manager`, nickname: "[MOCK] 华东团队主管" },
    { id: `${MOCK_PREFIX}-east-employee-a`, email: "east.employee.a@fixture.invalid", role: "employee", organizationId: east, reportsToUserId: `${MOCK_PREFIX}-east-supervisor`, nickname: "[MOCK] 华东员工 A" },
    { id: `${MOCK_PREFIX}-east-employee-b`, email: "east.employee.b@fixture.invalid", role: "employee", organizationId: east, reportsToUserId: `${MOCK_PREFIX}-east-supervisor`, nickname: "[MOCK] 华东员工 B" },
    { id: `${MOCK_PREFIX}-south-branch-admin`, email: "south.branch.admin@fixture.invalid", role: "branch_admin", organizationId: south, reportsToUserId: sentinels.hqAdministratorId, nickname: "[MOCK] 华南分公司负责人" },
    { id: `${MOCK_PREFIX}-south-manager`, email: "south.manager@fixture.invalid", role: "manager", organizationId: south, reportsToUserId: `${MOCK_PREFIX}-south-branch-admin`, nickname: "[MOCK] 华南业务主管" },
    { id: `${MOCK_PREFIX}-south-supervisor`, email: "south.supervisor@fixture.invalid", role: "supervisor", organizationId: south, reportsToUserId: `${MOCK_PREFIX}-south-manager`, nickname: "[MOCK] 华南团队主管" },
    { id: `${MOCK_PREFIX}-south-employee-a`, email: "south.employee.a@fixture.invalid", role: "employee", organizationId: south, reportsToUserId: `${MOCK_PREFIX}-south-supervisor`, nickname: "[MOCK] 华南员工 A" },
    { id: `${MOCK_PREFIX}-south-employee-b`, email: "south.employee.b@fixture.invalid", role: "employee", organizationId: south, reportsToUserId: `${MOCK_PREFIX}-south-supervisor`, nickname: "[MOCK] 华南员工 B" },
  ];
  const customers = [
    { key: "acceptance", id: sentinels.clientAcceptanceId, displayName: "[MOCK] 客户端验收客户", branchId: east, managerId: `${MOCK_PREFIX}-east-manager`, supervisorId: `${MOCK_PREFIX}-east-supervisor`, employeeId: `${MOCK_PREFIX}-east-employee-a`, createdAt: isoDaysAgo(now, 32), status: "active", existing: true },
    { key: "customer-a", id: `${MOCK_PREFIX}-customer-a`, email: "customer.a@fixture.invalid", displayName: "[MOCK] 客户 A", branchId: east, managerId: `${MOCK_PREFIX}-east-manager`, supervisorId: `${MOCK_PREFIX}-east-supervisor`, employeeId: `${MOCK_PREFIX}-east-employee-a`, createdAt: isoDaysAgo(now, 2), status: "active" },
    { key: "customer-b", id: `${MOCK_PREFIX}-customer-b`, email: "customer.b@fixture.invalid", displayName: "[MOCK] 客户 B", branchId: east, managerId: `${MOCK_PREFIX}-east-manager`, supervisorId: `${MOCK_PREFIX}-east-supervisor`, employeeId: `${MOCK_PREFIX}-east-employee-b`, createdAt: isoDaysAgo(now, 8), status: "active" },
    { key: "customer-c", id: `${MOCK_PREFIX}-customer-c`, email: "customer.c@fixture.invalid", displayName: "[MOCK] 客户 C", branchId: south, managerId: `${MOCK_PREFIX}-south-manager`, supervisorId: `${MOCK_PREFIX}-south-supervisor`, employeeId: `${MOCK_PREFIX}-south-employee-a`, createdAt: isoDaysAgo(now, 18), status: "active" },
    { key: "customer-d", id: `${MOCK_PREFIX}-customer-d`, email: "customer.d@fixture.invalid", displayName: "[MOCK] 客户 D", branchId: south, managerId: `${MOCK_PREFIX}-south-manager`, supervisorId: `${MOCK_PREFIX}-south-supervisor`, employeeId: `${MOCK_PREFIX}-south-employee-b`, createdAt: isoDaysAgo(now, 44), status: "frozen" },
    { key: "customer-e", id: `${MOCK_PREFIX}-customer-e`, email: "customer.e@fixture.invalid", displayName: "[MOCK] 客户 E", branchId: east, managerId: `${MOCK_PREFIX}-east-manager`, supervisorId: `${MOCK_PREFIX}-east-supervisor`, employeeId: `${MOCK_PREFIX}-east-employee-a`, createdAt: isoDaysAgo(now, 76), status: "active" },
    { key: "customer-f", id: `${MOCK_PREFIX}-customer-f`, email: "customer.f@fixture.invalid", displayName: "[MOCK] 客户 F", branchId: south, managerId: `${MOCK_PREFIX}-south-manager`, supervisorId: `${MOCK_PREFIX}-south-supervisor`, employeeId: `${MOCK_PREFIX}-south-employee-a`, createdAt: isoDaysAgo(now, 125), status: "active" },
  ];
  return {
    now,
    nowIso: now.toISOString(),
    passwordHash: mockPasswordHash,
    organizations: [
      { id: east, parentId: sentinels.headquartersId, name: "[MOCK] 华东测试分公司" },
      { id: south, parentId: sentinels.headquartersId, name: "[MOCK] 华南测试分公司" },
    ],
    staff,
    customers,
  };
}

async function seedOrganizations(client, data) {
  for (const organization of data.organizations) {
    await client.query(`
      INSERT INTO organizations(id,parent_id,type,name,status,created_at,updated_at)
      VALUES($1,$2,'branch',$3,'active',$4,$4)
      ON CONFLICT(id) DO UPDATE SET parent_id=EXCLUDED.parent_id,name=EXCLUDED.name,status='active',updated_at=EXCLUDED.updated_at
    `, [organization.id, organization.parentId, organization.name, data.nowIso]);
  }
}

async function seedPeople(client, data) {
  for (const person of data.staff) {
    await client.query(`
      INSERT INTO users(
        id,email,password_hash,role,organization_id,status,locale,timezone,
        reports_to_user_id,username,nickname,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,'active','zh-CN','Asia/Shanghai',$6,$7,$8,$9,$9)
      ON CONFLICT(id) DO UPDATE SET
        email=EXCLUDED.email,password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,
        organization_id=EXCLUDED.organization_id,status='active',reports_to_user_id=EXCLUDED.reports_to_user_id,
        username=EXCLUDED.username,nickname=EXCLUDED.nickname,updated_at=EXCLUDED.updated_at
    `, [person.id, person.email, data.passwordHash, person.role, person.organizationId,
      person.reportsToUserId, person.id.replaceAll("-", "_"), person.nickname, isoDaysAgo(data.now, 180)]);
  }
  for (const customer of data.customers.filter((item) => !item.existing)) {
    await client.query(`
      INSERT INTO users(
        id,email,password_hash,role,status,locale,timezone,username,nickname,created_at,updated_at
      ) VALUES($1,$2,$3,'customer',$4,'zh-CN','Asia/Shanghai',$5,$6,$7,$8)
      ON CONFLICT(id) DO UPDATE SET
        email=EXCLUDED.email,password_hash=EXCLUDED.password_hash,status=EXCLUDED.status,
        username=EXCLUDED.username,nickname=EXCLUDED.nickname,updated_at=EXCLUDED.updated_at
    `, [customer.id, customer.email, data.passwordHash, customer.status,
      customer.id.replaceAll("-", "_"), customer.displayName, customer.createdAt, data.nowIso]);
  }
}

async function seedCustomerDirectory(client, data) {
  for (const customer of data.customers) {
    await client.query(`
      INSERT INTO customer_profiles(id,customer_id,display_name,contact_note,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(customer_id) DO UPDATE SET
        display_name=EXCLUDED.display_name,contact_note=EXCLUDED.contact_note,updated_at=EXCLUDED.updated_at
    `, [`${MOCK_PREFIX}-profile-${customer.key}`, customer.id, customer.displayName,
      "[MOCK] 测试资料，不含真实联系方式或个人信息。", customer.createdAt, data.nowIso]);
    await client.query(`
      INSERT INTO customer_attributions(
        id,customer_id,source,status,branch_id,manager_id,supervisor_id,employee_id,
        effective_at,reason,is_internal,created_at,updated_at
      ) VALUES($1,$2,'mock_seed','active',$3,$4,$5,$6,$7,$8,false,$7,$9)
      ON CONFLICT(id) DO UPDATE SET
        status='active',branch_id=EXCLUDED.branch_id,manager_id=EXCLUDED.manager_id,
        supervisor_id=EXCLUDED.supervisor_id,employee_id=EXCLUDED.employee_id,
        effective_at=EXCLUDED.effective_at,reason=EXCLUDED.reason,ended_at=NULL,updated_at=EXCLUDED.updated_at
    `, [`${MOCK_PREFIX}-attribution-${customer.key}`, customer.id, customer.branchId,
      customer.managerId, customer.supervisorId, customer.employeeId, customer.createdAt,
      "[MOCK] 三端验收数据归属", data.nowIso]);
  }
}

async function seedTeamTargets(client, data, sentinels) {
  const currentMonth = monthOf(data.now);
  const targets = [
    { key: "ops-acceptance", branchId: sentinels.headquartersId, assigneeId: sentinels.operationsAcceptanceId, newCustomers: 6, monthly: 2, quarterly: 1, annual: 1 },
    { key: "east-supervisor", branchId: `${MOCK_PREFIX}-org-east`, assigneeId: `${MOCK_PREFIX}-east-supervisor`, newCustomers: 8, monthly: 4, quarterly: 2, annual: 1 },
    { key: "east-employee-a", branchId: `${MOCK_PREFIX}-org-east`, assigneeId: `${MOCK_PREFIX}-east-employee-a`, newCustomers: 5, monthly: 2, quarterly: 1, annual: 0 },
    { key: "south-supervisor", branchId: `${MOCK_PREFIX}-org-south`, assigneeId: `${MOCK_PREFIX}-south-supervisor`, newCustomers: 7, monthly: 3, quarterly: 2, annual: 1 },
  ];
  for (const target of targets) {
    await client.query(`
      INSERT INTO monthly_team_targets(
        id,month,branch_id,assigned_by_user_id,assignee_user_id,
        new_customers_target,monthly_cards_target,quarterly_cards_target,annual_cards_target,note,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
      ON CONFLICT(assignee_user_id,month) DO UPDATE SET
        branch_id=EXCLUDED.branch_id,assigned_by_user_id=EXCLUDED.assigned_by_user_id,
        new_customers_target=EXCLUDED.new_customers_target,monthly_cards_target=EXCLUDED.monthly_cards_target,
        quarterly_cards_target=EXCLUDED.quarterly_cards_target,annual_cards_target=EXCLUDED.annual_cards_target,
        note=EXCLUDED.note,updated_at=EXCLUDED.updated_at
    `, [`${MOCK_PREFIX}-target-${target.key}-${currentMonth}`, currentMonth, target.branchId,
      sentinels.hqAdministratorId, target.assigneeId, target.newCustomers, target.monthly,
      target.quarterly, target.annual, "[MOCK] 月度目标，仅用于测试统计和排版", data.nowIso]);
  }
  await client.query(`
    INSERT INTO target_follow_ups(
      id,month,branch_id,subject_user_id,alert_type,status,note,
      handled_by_user_id,handled_at,created_at,updated_at
    ) VALUES($1,$2,$3,$4,'behind_schedule','resolved',$5,$6,$7,$7,$7)
    ON CONFLICT(subject_user_id,month,alert_type) DO UPDATE SET
      status='resolved',note=EXCLUDED.note,handled_by_user_id=EXCLUDED.handled_by_user_id,
      handled_at=EXCLUDED.handled_at,updated_at=EXCLUDED.updated_at
  `, [`${MOCK_PREFIX}-follow-up-east-a-${currentMonth}`, currentMonth, `${MOCK_PREFIX}-org-east`,
    `${MOCK_PREFIX}-east-employee-a`, "[MOCK] 已完成一次目标复盘，用于测试跟进历史。",
    `${MOCK_PREFIX}-east-manager`, isoDaysAgo(data.now, 1)]);
}

function membershipRows(data) {
  const byKey = new Map(data.customers.map((customer) => [customer.key, customer]));
  return [
    { key: "acceptance", plan: "membership_monthly_v1", status: "active", starts: isoDaysAgo(data.now, 7), expires: isoDaysFrom(data.now, 23) },
    { key: "customer-a", plan: "membership_quarterly_v1", status: "active", starts: isoDaysAgo(data.now, 5), expires: isoDaysFrom(data.now, 85) },
    { key: "customer-b", plan: "membership_annual_v1", status: "active", starts: isoDaysAgo(data.now, 12), expires: isoDaysFrom(data.now, 353) },
    { key: "customer-c", plan: "membership_monthly_v1", status: "grace", starts: isoDaysAgo(data.now, 34), expires: isoDaysAgo(data.now, 4), grace: isoDaysFrom(data.now, 3) },
    { key: "customer-d", plan: "membership_monthly_v1", status: "expired", starts: isoDaysAgo(data.now, 80), expires: isoDaysAgo(data.now, 50) },
  ].map((row) => ({ ...row, customerId: byKey.get(row.key).id, id: `${MOCK_PREFIX}-membership-${row.key}` }));
}

async function seedMembershipsAndOrders(client, data, sentinels) {
  const memberships = membershipRows(data);
  for (const membership of memberships) {
    await client.query(`
      INSERT INTO memberships(
        id,customer_id,plan_code,status,starts_at,expires_at,grace_ends_at,
        max_exchange_accounts,max_active_strategies,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,1,3,$5,$8)
      ON CONFLICT(id) DO UPDATE SET
        plan_code=EXCLUDED.plan_code,status=EXCLUDED.status,starts_at=EXCLUDED.starts_at,
        expires_at=EXCLUDED.expires_at,grace_ends_at=EXCLUDED.grace_ends_at,
        max_active_strategies=3,updated_at=EXCLUDED.updated_at
    `, [membership.id, membership.customerId, membership.plan, membership.status,
      membership.starts, membership.expires, membership.grace ?? null, data.nowIso]);
  }
  const customers = new Map(data.customers.map((customer) => [customer.key, customer.id]));
  const orders = [
    { key: "activated", customerId: customers.get("acceptance"), plan: "membership_monthly_v1", amount: "28", duration: 30, credits: "1000", status: "activated", membershipId: `${MOCK_PREFIX}-membership-acceptance`, created: isoDaysAgo(data.now, 7) },
    { key: "review", customerId: customers.get("customer-e"), plan: "membership_quarterly_v1", amount: "58", duration: 90, credits: "3000", status: "pending_review", membershipId: null, created: isoDaysAgo(data.now, 1) },
    { key: "rejected", customerId: customers.get("customer-f"), plan: "membership_annual_v1", amount: "198", duration: 365, credits: "12000", status: "rejected", membershipId: null, created: isoDaysAgo(data.now, 4) },
  ];
  for (const order of orders) {
    const reviewed = order.status === "pending_review" ? null : isoDaysFrom(new Date(order.created), 1);
    await client.query(`
      INSERT INTO commercial_membership_orders(
        id,order_no,user_id,plan_version_id,price_amount,price_currency,duration_days,
        ai_credit_grant,performance_fee_bps,legal_snapshot_json,status,idempotency_key,request_id,
        approved_membership_id,submitted_by_user_id,submitted_at,reviewed_by_user_id,reviewed_at,
        activated_at,rejection_reason,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,'USDT',$6,$7,1500,$8::jsonb,$9,$10,$11,$12,$3,$13,$14,$15,$16,$17,$13,$18)
      ON CONFLICT(id) DO NOTHING
    `, [`${MOCK_PREFIX}-membership-order-${order.key}`, `MOCK-${order.key.toUpperCase()}-001`,
      order.customerId, order.plan, order.amount, order.duration, order.credits,
      JSON.stringify({ synthetic: true, label: "[MOCK] 测试订单，不代表真实协议确认或付款" }),
      order.status, `${MOCK_PREFIX}:membership-order:${order.key}`, `${MOCK_PREFIX}-request-membership-${order.key}`,
      order.membershipId, order.created, reviewed ? sentinels.hqAdministratorId : null, reviewed,
      order.status === "activated" ? reviewed : null,
      order.status === "rejected" ? "[MOCK] 测试驳回原因" : null, data.nowIso]);
  }
  return memberships;
}

async function seedCredits(client, data, sentinels) {
  const balances = new Map([
    ["acceptance", { grant: "9000", consumed: "650" }],
    ["customer-a", { grant: "3000", consumed: "0" }],
    ["customer-b", { grant: "12000", consumed: "0" }],
    ["customer-c", { grant: "1000", consumed: "600" }],
    ["customer-e", { grant: "1000", consumed: "0" }],
  ]);
  for (const customer of data.customers.filter((item) => balances.has(item.key))) {
    const balance = balances.get(customer.key);
    const available = String(Number(balance.grant) - Number(balance.consumed));
    const accountId = `${MOCK_PREFIX}-credit-account-${customer.key}`;
    await client.query(`
      INSERT INTO ai_credit_accounts(id,user_id,available_credits,reserved_credits,version,updated_at)
      VALUES($1,$2,$3,0,1,$4)
      ON CONFLICT(user_id) DO UPDATE SET
        available_credits=EXCLUDED.available_credits,reserved_credits=0,
        version=ai_credit_accounts.version+1,updated_at=EXCLUDED.updated_at
    `, [accountId, customer.id, available, data.nowIso]);
    const actual = await client.query("SELECT id FROM ai_credit_accounts WHERE user_id=$1", [customer.id]);
    const actualAccountId = actual.rows[0].id;
    await client.query(`
      INSERT INTO ai_credit_ledger_entries(
        id,account_id,entry_type,available_delta,reserved_delta,balance_available,balance_reserved,
        source_type,source_id,idempotency_key,request_id,created_by_user_id,created_at
      ) VALUES($1,$2,'grant',$3,0,$3,0,'mock_membership',$4,$5,$6,$7,$8)
      ON CONFLICT(idempotency_key) DO NOTHING
    `, [`${MOCK_PREFIX}-credit-grant-${customer.key}`, actualAccountId, balance.grant,
      `${MOCK_PREFIX}-credit-source-${customer.key}`, `${MOCK_PREFIX}:credit:grant:${customer.key}`,
      `${MOCK_PREFIX}-request-credit-grant-${customer.key}`, sentinels.hqAdministratorId,
      isoDaysAgo(data.now, 6)]);
    if (Number(balance.consumed) > 0) {
      await client.query(`
        INSERT INTO ai_credit_ledger_entries(
          id,account_id,entry_type,available_delta,reserved_delta,balance_available,balance_reserved,
          source_type,source_id,cost_model_version,usage_json,idempotency_key,request_id,created_by_user_id,created_at
        ) VALUES($1,$2,'settle',$3,0,$4,0,'mock_ai_usage',$5,'mock-v1',$6::jsonb,$7,$8,$9,$10)
        ON CONFLICT(idempotency_key) DO NOTHING
      `, [`${MOCK_PREFIX}-credit-settle-${customer.key}`, actualAccountId, `-${balance.consumed}`,
        available, `${MOCK_PREFIX}-ai-usage-${customer.key}`,
        JSON.stringify({ synthetic: true, label: "[MOCK] 静态 AI 用量" }),
        `${MOCK_PREFIX}:credit:settle:${customer.key}`, `${MOCK_PREFIX}-request-credit-settle-${customer.key}`,
        customer.id, isoDaysAgo(data.now, 2)]);
    }
  }
}

async function seedWalletAndDeposits(client, data, sentinels) {
  const wallets = new Map([
    ["acceptance", "3200"],
    ["customer-a", "1200"],
    ["customer-b", "5800"],
  ]);
  const clearingId = "ledger-platform-platform_deposit_clearing-usdt";
  await client.query(`
    INSERT INTO ledger_accounts(id,account_type,currency,status)
    VALUES($1,'platform_deposit_clearing','USDT','active')
    ON CONFLICT(id) DO NOTHING
  `, [clearingId]);
  for (const customer of data.customers.filter((item) => wallets.has(item.key))) {
    const amount = wallets.get(customer.key);
    const accountId = `ledger-user-${customer.id}-available-usdt`;
    const walletId = `${MOCK_PREFIX}-wallet-${customer.key}`;
    const transactionId = `${MOCK_PREFIX}-ledger-deposit-${customer.key}`;
    const orderId = `${MOCK_PREFIX}-deposit-credited-${customer.key}`;
    await client.query(`
      INSERT INTO ledger_accounts(id,owner_user_id,account_type,currency,status)
      VALUES($1,$2,'user_available','USDT','active')
      ON CONFLICT(id) DO NOTHING
    `, [accountId, customer.id]);
    await client.query(`
      INSERT INTO ledger_transactions(
        id,transaction_type,source_type,source_id,currency,status,idempotency_key,
        metadata_json,created_by_user_id,created_at,request_id,ledger_version
      )
      SELECT $1,'deposit_credit','mock_deposit',$2,'USDT','pending',$3,$4::jsonb,$5,$6,$7,1
      WHERE NOT EXISTS (SELECT 1 FROM ledger_transactions WHERE id=$1)
    `, [transactionId, orderId, `${MOCK_PREFIX}:ledger:deposit:${customer.key}`,
      JSON.stringify({ synthetic: true, label: "[MOCK] 测试充值入账" }), sentinels.hqAdministratorId,
      isoDaysAgo(data.now, 5), `${MOCK_PREFIX}-request-deposit-${customer.key}`]);
    await client.query(`
      INSERT INTO ledger_postings(id,transaction_id,account_id,side,amount,currency)
      SELECT $1,$2,$3,'debit',$4::numeric,'USDT'
      WHERE NOT EXISTS (SELECT 1 FROM ledger_postings WHERE id=$1)
      UNION ALL
      SELECT $5,$2,$6,'credit',$4::numeric,'USDT'
      WHERE NOT EXISTS (SELECT 1 FROM ledger_postings WHERE id=$5)
    `, [`${MOCK_PREFIX}-posting-clearing-${customer.key}`, transactionId, clearingId, amount,
      `${MOCK_PREFIX}-posting-user-${customer.key}`, accountId]);
    await client.query(`
      INSERT INTO wallet_balances(id,user_id,currency,available_amount,frozen_amount,version,updated_at)
      VALUES($1,$2,'USDT',$3,0,1,$4)
      ON CONFLICT(user_id,currency) DO UPDATE SET
        available_amount=EXCLUDED.available_amount,frozen_amount=0,
        version=1,updated_at=EXCLUDED.updated_at
    `, [walletId, customer.id, amount, data.nowIso]);
    const actualWallet = await client.query("SELECT id,version FROM wallet_balances WHERE user_id=$1 AND currency='USDT'", [customer.id]);
    await client.query(`
      INSERT INTO wallet_balance_versions(
        id,wallet_balance_id,ledger_transaction_id,available_amount,frozen_amount,version,created_at
      )
      SELECT $1,$2,$3,$4::numeric,0::numeric,$5::bigint,$6::timestamptz
      WHERE NOT EXISTS (SELECT 1 FROM wallet_balance_versions WHERE id=$1)
    `, [`${MOCK_PREFIX}-wallet-version-${customer.key}`, actualWallet.rows[0].id,
      transactionId, amount, actualWallet.rows[0].version, data.nowIso]);
    await client.query(`
      UPDATE ledger_transactions SET status='posted'
      WHERE id=$1 AND status='pending'
    `, [transactionId]);
    await client.query(`
      INSERT INTO deposit_orders(
        id,platform_order_no,user_id,branch_id,currency,network,expected_amount,actual_amount,
        usdt_value,fee_amount,credited_amount,channel,order_status,funds_status,risk_status,
        risk_reasons_json,ledger_transaction_id,external_received_at,credited_at,metadata_json,
        created_at,updated_at,idempotency_key,request_id
      ) VALUES($1,$2,$3,$4,'USDT','TRC20',$5,$5,$5,0,$5,'manual','CREDITED','AVAILABLE','PASS',
        '[]'::jsonb,$6,$7,$7,$8::jsonb,$7,$9,$10,$11)
      ON CONFLICT(id) DO NOTHING
    `, [orderId, `MOCK-CREDIT-${customer.key.toUpperCase()}`, customer.id, customer.branchId,
      amount, transactionId, isoDaysAgo(data.now, 5),
      JSON.stringify({ synthetic: true, label: "[MOCK] 测试充值；无 provider 调用" }),
      data.nowIso, `${MOCK_PREFIX}:deposit:${customer.key}`, `${MOCK_PREFIX}-request-deposit-${customer.key}`]);
  }
  const stateOrders = [
    { key: "failed", customer: data.customers.find((item) => item.key === "customer-c"), amount: "500", orderStatus: "FAILED", riskStatus: "PASS", reasons: [] },
    { key: "review", customer: data.customers.find((item) => item.key === "customer-d"), amount: "800", orderStatus: "MANUAL_REVIEW", riskStatus: "REVIEW", reasons: ["[MOCK] 需要人工复核的测试样例"] },
  ];
  for (const order of stateOrders) {
    await client.query(`
      INSERT INTO deposit_orders(
        id,platform_order_no,user_id,branch_id,currency,network,expected_amount,actual_amount,
        fee_amount,credited_amount,channel,order_status,funds_status,risk_status,risk_reasons_json,
        metadata_json,created_at,updated_at,idempotency_key,request_id
      ) VALUES($1,$2,$3,$4,'USDT','TRC20',$5,$6,0,0,'manual',$7,'NOT_CREDITED',$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
      ON CONFLICT(id) DO NOTHING
    `, [`${MOCK_PREFIX}-deposit-${order.key}`, `MOCK-${order.key.toUpperCase()}-001`,
      order.customer.id, order.customer.branchId, order.amount, order.key === "review" ? order.amount : "0",
      order.orderStatus, order.riskStatus, JSON.stringify(order.reasons),
      JSON.stringify({ synthetic: true, label: `[MOCK] ${order.key} deposit state` }),
      isoDaysAgo(data.now, order.key === "review" ? 1 : 3), data.nowIso,
      `${MOCK_PREFIX}:deposit:${order.key}`, `${MOCK_PREFIX}-request-deposit-${order.key}`]);
  }
}

function portfolioId(membershipId, strategyCode) {
  return `official-paper:${membershipId}:${strategyCode}`;
}

async function seedPaperPortfolio(client, input) {
  const id = portfolioId(input.membershipId, input.strategyCode);
  await client.query(`
    INSERT INTO official_paper_portfolios(
      id,membership_id,customer_id,strategy_code,principal_usdt,cash_usdt,
      realized_pnl_usdt,realized_gross_pnl_usdt,realized_net_pnl_usdt,fees_usdt,
      access_status,risk_json,book,created_at,updated_at
    ) VALUES($1,$2,$3,$4,10000,$5,$6,$7,$6,$8,'active',$9::jsonb,'paper',$10,$11)
    ON CONFLICT(id) DO UPDATE SET
      cash_usdt=EXCLUDED.cash_usdt,realized_pnl_usdt=EXCLUDED.realized_pnl_usdt,
      realized_gross_pnl_usdt=EXCLUDED.realized_gross_pnl_usdt,
      realized_net_pnl_usdt=EXCLUDED.realized_net_pnl_usdt,fees_usdt=EXCLUDED.fees_usdt,
      access_status='active',risk_json=EXCLUDED.risk_json,updated_at=EXCLUDED.updated_at
  `, [id, input.membershipId, input.customerId, input.strategyCode, input.cash,
    input.realizedNet, input.realizedGross, input.fees, JSON.stringify(riskByStrategy[input.strategyCode]),
    input.createdAt, input.updatedAt]);
  await client.query(`
    INSERT INTO official_paper_ledger_entries(
      id,portfolio_id,entry_type,amount_usdt,balance_after_usdt,trace_id,occurred_at
    ) VALUES($1,$2,'initial_cash',10000,10000,$3,$4)
    ON CONFLICT(id) DO NOTHING
  `, [`${MOCK_PREFIX}-paper-initial-${input.key}-${input.strategyCode}`, id,
    `${MOCK_PREFIX}:paper:initial:${input.key}:${input.strategyCode}`, input.createdAt]);
  return id;
}

async function seedPaperExecution(client, data, input) {
  const deploymentId = `${MOCK_PREFIX}-deployment-${input.strategyCode}`;
  await client.query(`
    INSERT INTO strategy_deployments(
      id,owner_user_id,strategy_id,strategy_version_id,exchange_account_id,mode,status,
      validation_label,unverified_warning,position_size_pct,idempotency_key,next_cycle_at,
      last_cycle_sequence,last_candle_close_at,risk_state_json,created_at,updated_at,
      execution_product,platform_strategy_code,membership_id,paper_portfolio_id
    ) VALUES($1,$2,$3,$4,NULL,'paper','ended','UNVERIFIED',true,$5,$6,'2099-01-01T00:00:00.000Z',$7,$8,$9::jsonb,$10,$11,
      'spot_usdt',$12,$13,$14)
    ON CONFLICT(id) DO UPDATE SET
      status='ended',lease_owner=NULL,lease_expires_at=NULL,next_cycle_at='2099-01-01T00:00:00.000Z',
      last_cycle_sequence=EXCLUDED.last_cycle_sequence,last_candle_close_at=EXCLUDED.last_candle_close_at,
      risk_state_json=EXCLUDED.risk_state_json,updated_at=EXCLUDED.updated_at
  `, [deploymentId, input.customerId, `platform:${input.strategyCode}`,
    `platform:${input.strategyCode}:mock-v1`, input.positionSizePct,
    `${MOCK_PREFIX}:deployment:${input.strategyCode}`, input.fills.length,
    input.fills.at(-1).filledAt, JSON.stringify({ drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0, halted: false, synthetic: true }),
    input.fills[0].filledAt, data.nowIso, input.strategyCode, input.membershipId, input.portfolioId]);
  for (const [index, fill] of input.fills.entries()) {
    const sequence = index + 1;
    const cycleId = `${MOCK_PREFIX}-cycle-${input.strategyCode}-${sequence}`;
    const intentId = `${MOCK_PREFIX}-intent-${input.strategyCode}-${sequence}`;
    const receiptId = `${MOCK_PREFIX}-receipt-${input.strategyCode}-${sequence}`;
    const traceId = `${MOCK_PREFIX}:paper:${input.strategyCode}:${sequence}`;
    const close = new Date(fill.filledAt);
    const open = new Date(close.getTime() - 60 * 60 * 1000);
    await client.query(`
      INSERT INTO strategy_runtime_cycles(
        id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,
        decision_json,order_intent_json,trace_id,started_at,completed_at
      ) VALUES($1,$2,$3,0,$4,$5,'completed',$6::jsonb,$7::jsonb,$8,$4,$5)
      ON CONFLICT(id) DO NOTHING
    `, [cycleId, deploymentId, sequence, open.toISOString(), close.toISOString(),
      JSON.stringify({ synthetic: true, label: "[MOCK] 确定性模拟决策", action: fill.action, symbol: fill.symbol }),
      JSON.stringify({ synthetic: true, action: fill.action, symbol: fill.symbol }), traceId]);
    await client.query(`
      INSERT INTO official_paper_order_intents(
        id,portfolio_id,deployment_id,runtime_cycle_id,idempotency_key,symbol,action,
        execution_timing,requested_price,status,payload_json,created_at,filled_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,'next_candle_open',$8,'filled',$9::jsonb,$10,$10)
      ON CONFLICT(id) DO NOTHING
    `, [intentId, input.portfolioId, deploymentId, cycleId,
      `${MOCK_PREFIX}:intent:${input.strategyCode}:${sequence}`, fill.symbol, fill.action,
      fill.fillPrice, JSON.stringify({ synthetic: true, label: "[MOCK] Paper order intent" }), fill.filledAt]);
    await client.query(`
      INSERT INTO official_paper_fill_receipts(
        id,intent_id,portfolio_id,position_id,symbol,action,quantity,fill_price,notional_usdt,
        fee_usdt,allocated_entry_fee_usdt,realized_pnl_usdt,realized_gross_pnl_usdt,
        realized_net_pnl_usdt,trace_id,filled_at,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$12,$14,$15,$15)
      ON CONFLICT(id) DO NOTHING
    `, [receiptId, intentId, input.portfolioId, fill.positionId, fill.symbol, fill.action,
      fill.quantity, fill.fillPrice, fill.notional, fill.fee, fill.allocatedEntryFee,
      fill.realizedNet, fill.realizedGross, traceId, fill.filledAt]);
    await client.query(`
      INSERT INTO official_paper_ledger_entries(
        id,portfolio_id,fill_receipt_id,entry_type,amount_usdt,balance_after_usdt,
        symbol,trace_id,occurred_at,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
      ON CONFLICT(id) DO NOTHING
    `, [`${MOCK_PREFIX}-paper-ledger-${input.strategyCode}-${sequence}`, input.portfolioId,
      receiptId, fill.action, fill.cashDelta, fill.balanceAfter, fill.symbol, traceId, fill.filledAt]);
  }
}

async function seedPaperData(client, data, memberships) {
  const membershipsByKey = new Map(memberships.map((membership) => [membership.key, membership]));
  const portfolioOwners = ["acceptance", "customer-a", "customer-b"];
  const portfolioIds = new Map();
  for (const ownerKey of portfolioOwners) {
    const membership = membershipsByKey.get(ownerKey);
    for (const strategyCode of STRATEGY_CODES) {
      const acceptance = ownerKey === "acceptance";
      const state = acceptance && strategyCode === "ai_conservative"
        ? { cash: "7747.75", realizedNet: "0", realizedGross: "0", fees: "2.25" }
        : acceptance && strategyCode === "ai_balanced"
          ? { cash: "6246.25", realizedNet: "0", realizedGross: "0", fees: "3.75" }
          : acceptance && strategyCode === "ai_aggressive"
            ? { cash: "10195.8", realizedNet: "195.8", realizedGross: "200", fees: "4.2" }
            : { cash: "10000", realizedNet: "0", realizedGross: "0", fees: "0" };
      const id = await seedPaperPortfolio(client, {
        key: ownerKey,
        membershipId: membership.id,
        customerId: membership.customerId,
        strategyCode,
        ...state,
        createdAt: membership.starts,
        updatedAt: data.nowIso,
      });
      portfolioIds.set(`${ownerKey}:${strategyCode}`, id);
    }
  }
  const conservativePosition = `${MOCK_PREFIX}-position-conservative-btc`;
  const balancedPosition = `${MOCK_PREFIX}-position-balanced-eth`;
  const aggressivePosition = `${MOCK_PREFIX}-position-aggressive-sol`;
  const positions = [
    { id: conservativePosition, portfolioId: portfolioIds.get("acceptance:ai_conservative"), symbol: "BTCUSDT", status: "open", quantity: "0.03", entry: "75000", cost: "2250", entryFee: "2.25", mark: "77000", unrealized: "60", realizedGross: "0", realizedNet: "0", opened: isoDaysAgo(data.now, 5), closed: null },
    { id: balancedPosition, portfolioId: portfolioIds.get("acceptance:ai_balanced"), symbol: "ETHUSDT", status: "open", quantity: "1.5", entry: "2500", cost: "3750", entryFee: "3.75", mark: "2600", unrealized: "150", realizedGross: "0", realizedNet: "0", opened: isoDaysAgo(data.now, 3), closed: null },
    { id: aggressivePosition, portfolioId: portfolioIds.get("acceptance:ai_aggressive"), symbol: "SOLUSDT", status: "closed", quantity: "20", entry: "100", cost: "2000", entryFee: "2", mark: "110", unrealized: "0", realizedGross: "200", realizedNet: "195.8", opened: isoDaysAgo(data.now, 6), closed: isoDaysAgo(data.now, 2) },
  ];
  for (const position of positions) {
    await client.query(`
      INSERT INTO official_paper_positions(
        id,portfolio_id,symbol,side,status,quantity,average_entry_price,cost_basis_usdt,
        entry_fees_usdt,last_mark_price,unrealized_pnl_usdt,realized_pnl_usdt,
        realized_gross_pnl_usdt,realized_net_pnl_usdt,opened_at,closed_at,created_at,updated_at
      ) VALUES($1,$2,$3,'long',$4,$5,$6,$7,$8,$9,$10,$11,$12,$11,$13,$14,$13,$15)
      ON CONFLICT(id) DO UPDATE SET
        status=EXCLUDED.status,last_mark_price=EXCLUDED.last_mark_price,
        unrealized_pnl_usdt=EXCLUDED.unrealized_pnl_usdt,realized_pnl_usdt=EXCLUDED.realized_pnl_usdt,
        realized_gross_pnl_usdt=EXCLUDED.realized_gross_pnl_usdt,
        realized_net_pnl_usdt=EXCLUDED.realized_net_pnl_usdt,closed_at=EXCLUDED.closed_at,
        updated_at=EXCLUDED.updated_at
    `, [position.id, position.portfolioId, position.symbol, position.status, position.quantity,
      position.entry, position.cost, position.entryFee, position.mark, position.unrealized,
      position.realizedNet, position.realizedGross, position.opened, position.closed, data.nowIso]);
  }
  const membership = membershipsByKey.get("acceptance");
  await seedPaperExecution(client, data, {
    customerId: membership.customerId,
    membershipId: membership.id,
    portfolioId: portfolioIds.get("acceptance:ai_conservative"),
    strategyCode: "ai_conservative",
    positionSizePct: 15,
    fills: [{ action: "buy", symbol: "BTCUSDT", quantity: "0.03", fillPrice: "75000", notional: "2250", fee: "2.25", allocatedEntryFee: "0", realizedNet: "0", realizedGross: "0", cashDelta: "-2252.25", balanceAfter: "7747.75", positionId: conservativePosition, filledAt: isoDaysAgo(data.now, 5) }],
  });
  await seedPaperExecution(client, data, {
    customerId: membership.customerId,
    membershipId: membership.id,
    portfolioId: portfolioIds.get("acceptance:ai_balanced"),
    strategyCode: "ai_balanced",
    positionSizePct: 25,
    fills: [{ action: "buy", symbol: "ETHUSDT", quantity: "1.5", fillPrice: "2500", notional: "3750", fee: "3.75", allocatedEntryFee: "0", realizedNet: "0", realizedGross: "0", cashDelta: "-3753.75", balanceAfter: "6246.25", positionId: balancedPosition, filledAt: isoDaysAgo(data.now, 3) }],
  });
  await seedPaperExecution(client, data, {
    customerId: membership.customerId,
    membershipId: membership.id,
    portfolioId: portfolioIds.get("acceptance:ai_aggressive"),
    strategyCode: "ai_aggressive",
    positionSizePct: 30,
    fills: [
      { action: "buy", symbol: "SOLUSDT", quantity: "20", fillPrice: "100", notional: "2000", fee: "2", allocatedEntryFee: "0", realizedNet: "0", realizedGross: "0", cashDelta: "-2002", balanceAfter: "7998", positionId: aggressivePosition, filledAt: isoDaysAgo(data.now, 6) },
      { action: "sell", symbol: "SOLUSDT", quantity: "20", fillPrice: "110", notional: "2200", fee: "2.2", allocatedEntryFee: "2", realizedNet: "195.8", realizedGross: "200", cashDelta: "2197.8", balanceAfter: "10195.8", positionId: aggressivePosition, filledAt: isoDaysAgo(data.now, 2) },
    ],
  });
}

async function seedClientActivity(client, data, sentinels) {
  const customerId = sentinels.clientAcceptanceId;
  const conversationId = `${MOCK_PREFIX}-conversation-market-risk`;
  await client.query(`
    INSERT INTO ai_conversations(id,user_id,title,purpose,status,last_message_at,created_at,updated_at)
    VALUES($1,$2,'[MOCK] 市场与风险咨询','consultation','active',$3,$4,$3)
    ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,last_message_at=EXCLUDED.last_message_at,updated_at=EXCLUDED.updated_at
  `, [conversationId, customerId, isoDaysAgo(data.now, 3), isoDaysAgo(data.now, 3, 1)]);
  const messages = [
    { id: `${MOCK_PREFIX}-message-user`, role: "user", content: "[MOCK] 请概括三张模拟策略卡当前的风险差异。", createdAt: isoDaysAgo(data.now, 3, 1) },
    { id: `${MOCK_PREFIX}-message-assistant`, role: "assistant", content: "[MOCK] 稳健、平衡和激进组合的仓位与回撤预算依次增加；这些内容仅供测试界面，不构成投资建议。", createdAt: isoDaysAgo(data.now, 3) },
  ];
  for (const message of messages) {
    await client.query(`
      INSERT INTO ai_messages(
        id,conversation_id,user_id,role,content,generation_mode,provider_name,model,metadata_json,created_at
      ) VALUES($1,$2,$3,$4,$5,'deterministic_fixture',NULL,NULL,$6,$7)
      ON CONFLICT(id) DO UPDATE SET content=EXCLUDED.content,metadata_json=EXCLUDED.metadata_json
    `, [message.id, conversationId, customerId, message.role, message.content,
      JSON.stringify({ synthetic: true, label: "[MOCK] 静态对话，不调用模型" }), message.createdAt]);
  }
  const notifications = [
    { key: "membership", category: "membership", templateKey: "membership_activated", payload: { membershipId: `${MOCK_PREFIX}-membership-acceptance`, status: "ACTIVE" }, readAt: isoDaysAgo(data.now, 4), createdAt: isoDaysAgo(data.now, 7) },
    { key: "deposit", category: "wallet", templateKey: "deposit_credited", payload: { orderId: `${MOCK_PREFIX}-deposit-credited-acceptance`, amount: "3200", currency: "USDT" }, readAt: null, createdAt: isoDaysAgo(data.now, 5) },
    { key: "security", category: "login_security", templateKey: "security_new_device", payload: { reason: "[MOCK] 测试安全提醒" }, readAt: null, createdAt: isoDaysAgo(data.now, 1) },
  ];
  for (const notification of notifications) {
    await client.query(`
      INSERT INTO notification_deliveries(
        id,user_id,channel,category,template_key,payload_json,status,attempts,scheduled_at,
        sent_at,created_at,updated_at,dedupe_key,read_at
      ) VALUES($1,$2,$10,$3,$4,$5,$11,0,$6,$6,$6,$7,$8,$9)
      ON CONFLICT(id) DO UPDATE SET payload_json=EXCLUDED.payload_json,status='delivered',updated_at=EXCLUDED.updated_at
    `, [`${MOCK_PREFIX}-notification-${notification.key}`, customerId, notification.category,
      notification.templateKey, JSON.stringify(notification.payload), notification.createdAt,
      data.nowIso, `${MOCK_PREFIX}:notification:${notification.key}`, notification.readAt,
      TERMINAL_IN_APP_NOTIFICATION.channel, TERMINAL_IN_APP_NOTIFICATION.status]);
  }
}

async function seedMaintenanceEvidence(client, data, sentinels) {
  await client.query(`
    INSERT INTO audit_logs(
      id,actor_user_id,action,subject_type,subject_id,after_json,request_id,trace_id,created_at
    ) VALUES($1,$2,'maintenance.mock_dataset.seeded','test_fixture',$3,$4,$5,$6,$7)
    ON CONFLICT(id) DO NOTHING
  `, [`${MOCK_PREFIX}-audit-seed`, sentinels.maintenanceAcceptanceId, `${MOCK_PREFIX}-dataset`,
    JSON.stringify({ synthetic: true, label: "[MOCK] 三端测试数据", status: "succeeded", externalCalls: false }),
    `${MOCK_PREFIX}-request-seed`, `${MOCK_PREFIX}-trace-seed`, data.nowIso]);
}

export async function seedPreviewMockData(pool, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Preview MOCK seed time is invalid");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agentnovas:preview-mock-data:v1',0))");
    const sentinels = await resolvePreviewSentinels(client);
    const data = fixture(sentinels, now, options.passwordHash ?? await passwordHash());
    await seedOrganizations(client, data);
    await seedPeople(client, data);
    await seedCustomerDirectory(client, data);
    await seedTeamTargets(client, data, sentinels);
    const memberships = await seedMembershipsAndOrders(client, data, sentinels);
    await seedCredits(client, data, sentinels);
    await seedWalletAndDeposits(client, data, sentinels);
    await seedPaperData(client, data, memberships);
    await seedClientActivity(client, data, sentinels);
    await seedMaintenanceEvidence(client, data, sentinels);
    await client.query("COMMIT");
    return verifyPreviewMockData(pool);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyPreviewMockData(pool) {
  const sentinels = await resolvePreviewSentinels(pool);
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM organizations WHERE id LIKE $1) AS organizations,
      (SELECT count(*)::int FROM users WHERE id LIKE $1 AND email LIKE '%@fixture.invalid') AS synthetic_users,
      (SELECT count(*)::int FROM users WHERE id LIKE $1 AND email NOT LIKE '%@fixture.invalid') AS unsafe_user_emails,
      (SELECT count(*)::int FROM customer_profiles WHERE id LIKE $1) AS customer_profiles,
      (SELECT count(*)::int FROM customer_attributions WHERE id LIKE $1 AND status='active') AS customer_attributions,
      (SELECT count(*)::int FROM memberships WHERE id LIKE $1) AS memberships,
      (SELECT count(*)::int FROM official_paper_portfolios WHERE membership_id LIKE $1 AND book='paper') AS paper_portfolios,
      (SELECT count(*)::int FROM official_paper_portfolios WHERE membership_id LIKE $1 AND book<>$2) AS unsafe_portfolio_books,
      (SELECT count(*)::int FROM official_paper_fill_receipts WHERE id LIKE $1) AS paper_fills,
      (SELECT count(*)::int FROM strategy_deployments WHERE id LIKE $1 AND status<>'ended') AS runnable_deployments,
      (SELECT count(*)::int FROM deposit_orders WHERE id LIKE $1) AS deposit_orders,
      (SELECT count(*)::int FROM deposit_orders WHERE id LIKE $1 AND provider IS NOT NULL) AS provider_bound_deposits,
      (SELECT count(*)::int FROM notification_deliveries WHERE id LIKE $1 AND (channel<>$3 OR status<>$4)) AS unsafe_notifications,
      (SELECT count(*)::int FROM audit_logs WHERE id=$5) AS maintenance_audit
  `, [`${MOCK_PREFIX}%`, "paper", "in_app", "delivered", `${MOCK_PREFIX}-audit-seed`]);
  const ledger = await pool.query(`
    SELECT count(*)::int AS unbalanced
      FROM (
        SELECT transaction.id
          FROM ledger_transactions transaction
          JOIN ledger_postings posting ON posting.transaction_id=transaction.id
         WHERE transaction.id LIKE $1
         GROUP BY transaction.id
        HAVING sum(CASE WHEN posting.side='debit' THEN posting.amount ELSE -posting.amount END)<>0
      ) broken
  `, [`${MOCK_PREFIX}%`]);
  const acceptancePortfolios = await pool.query(`
    SELECT count(*)::int AS count
      FROM official_paper_portfolios
     WHERE customer_id=$1 AND membership_id=$2 AND book=$3
  `, [sentinels.clientAcceptanceId, `${MOCK_PREFIX}-membership-acceptance`, "paper"]);
  const summary = {
    ...result.rows[0],
    unbalanced_ledger_transactions: ledger.rows[0].unbalanced,
    client_acceptance_portfolios: acceptancePortfolios.rows[0].count,
  };
  const expected = {
    organizations: 2,
    synthetic_users: 16,
    unsafe_user_emails: 0,
    customer_profiles: 7,
    customer_attributions: 7,
    memberships: 5,
    paper_portfolios: 9,
    paper_fills: 4,
    runnable_deployments: 0,
    deposit_orders: 5,
    provider_bound_deposits: 0,
    unsafe_notifications: 0,
    maintenance_audit: 1,
    unsafe_portfolio_books: 0,
    unbalanced_ledger_transactions: 0,
    client_acceptance_portfolios: 3,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (Number(summary[key]) !== value) {
      throw new Error(`Preview MOCK verification failed: ${key}=${summary[key]} expected ${value}`);
    }
  }
  return { status: "verified", marker: "[MOCK]", counts: summary };
}

async function run() {
  const apply = process.argv.includes("--apply");
  const verify = process.argv.includes("--verify");
  if (apply === verify) throw new Error("Choose exactly one of --apply or --verify");
  const databaseUrl = process.env.PREVIEW_MOCK_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  const url = assertPreviewMockSeedEnvironment({
    databaseUrl,
    environment: process.env,
    execute: apply || verify,
  });
  const pool = new pg.Pool({ connectionString: url.href, max: 2 });
  try {
    const result = apply ? await seedPreviewMockData(pool) : await verifyPreviewMockData(pool);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`Preview MOCK data failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
