import { requireAccessPermission } from "@/lib/access-control";
import { assertOperationsCustomerScope } from "@/lib/commercial-operations-scope";
import {
  availableCustomerPiiCategories,
  CUSTOMER_PII_PERMISSION_KEYS,
  customerPiiAccessRequest,
  projectOperationsCustomerPii,
  restrictCustomerPiiScope,
} from "@/lib/operations-customer-pii";
import {
  loadOperationsCustomerPii,
  operationsCustomerPiiOrEmpty,
  recordOperationsCustomerPiiAudit,
} from "@/lib/operations-customer-pii-service";
import { maskOperationsEmail } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, access, scope, organizationIds } = await requireAccessPermission(request, "ops.customers.view");
    const piiAccess = customerPiiAccessRequest(request, access.permissions);
    await Promise.all(piiAccess.categories.map((category) => requireAccessPermission(request, CUSTOMER_PII_PERMISSION_KEYS[category])));
    const effectiveScope = piiAccess.categories.length ? restrictCustomerPiiScope({
      base: { scope, organizationIds }, categories: piiAccess.categories, grants: access.grants,
      identityOrganizationId: user.organizationId,
    }) : { scope, organizationIds };
    const { id } = await params;
    const pool = await getPostgresPool();
    await assertOperationsCustomerScope(pool, effectiveScope.scope, { userId: user.id, organizationId: user.organizationId }, id, effectiveScope.organizationIds);
    const customer = (await pool.query(`
      SELECT customer.id,customer.email,customer.status,customer.created_at,customer.updated_at,
             profile.display_name,profile.contact_note,profile.archived_at,
             attribution.id AS attribution_id,attribution.branch_id,attribution.manager_id,
             attribution.supervisor_id,attribution.employee_id,attribution.effective_at,
             organization.name AS organization_name,
             manager.email AS manager_email,supervisor.email AS supervisor_email,employee.email AS employee_email
        FROM users customer
        LEFT JOIN customer_profiles profile ON profile.customer_id=customer.id
        LEFT JOIN LATERAL (
          SELECT * FROM customer_attributions WHERE customer_id=customer.id
          ORDER BY (status='active') DESC,effective_at DESC NULLS LAST,created_at DESC LIMIT 1
        ) attribution ON TRUE
        LEFT JOIN organizations organization ON organization.id=attribution.branch_id
        LEFT JOIN users manager ON manager.id=attribution.manager_id
        LEFT JOIN users supervisor ON supervisor.id=attribution.supervisor_id
        LEFT JOIN users employee ON employee.id=attribution.employee_id
       WHERE customer.id=$1 AND customer.role='customer'
    `, [id])).rows[0];
    if (!customer) throw new ResearchApiError("CUSTOMER_NOT_FOUND", "客户不存在或不在当前数据范围", 404);
    const [membership, credits, creditLedger, portfolios, orders, statements, notes, candidates] = await Promise.all([
      pool.query(`SELECT id,plan_code,status,starts_at,expires_at,grace_ends_at,updated_at FROM memberships WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`, [id]),
      pool.query(`SELECT id,available_credits::text,reserved_credits::text,version::text,updated_at FROM ai_credit_accounts WHERE user_id=$1 LIMIT 1`, [id]),
      pool.query(`SELECT entry_type,available_delta::text,reserved_delta::text,balance_available::text,balance_reserved::text,source_type,source_id,created_at FROM ai_credit_ledger_entries WHERE account_id=(SELECT id FROM ai_credit_accounts WHERE user_id=$1) ORDER BY created_at DESC,id DESC LIMIT 20`, [id]),
      pool.query(`SELECT portfolio.id,portfolio.strategy_code,portfolio.principal_usdt::text,portfolio.cash_usdt::text,portfolio.realized_net_pnl_usdt::text,portfolio.fees_usdt::text,portfolio.access_status,portfolio.updated_at,count(position.id) FILTER(WHERE position.quantity>0)::int AS open_positions FROM official_paper_portfolios portfolio LEFT JOIN official_paper_positions position ON position.portfolio_id=portfolio.id WHERE portfolio.customer_id=$1 GROUP BY portfolio.id ORDER BY portfolio.strategy_code`, [id]),
      pool.query(`SELECT orders.id,orders.order_no,plan.plan_code,orders.status,orders.price_amount::text,orders.price_currency,orders.created_at,orders.reviewed_at FROM commercial_membership_orders orders JOIN commercial_plan_versions plan ON plan.id=orders.plan_version_id WHERE orders.user_id=$1 ORDER BY orders.created_at DESC,orders.id DESC LIMIT 10`, [id]),
      pool.query(`SELECT statement.id,statement.week_start,statement.week_end,statement.status,statement.week_net_pnl::text,statement.fee_amount::text,receivable.status AS payment_status,statement.created_at FROM performance_fee_statements statement LEFT JOIN performance_fee_receivables receivable ON receivable.statement_id=statement.id WHERE statement.user_id=$1 ORDER BY statement.week_start DESC,statement.id DESC LIMIT 10`, [id]),
      pool.query(`SELECT note.id,note.content,note.created_at,note.author_user_id,author.email AS author_email FROM customer_handover_notes note LEFT JOIN users author ON author.id=note.author_user_id WHERE note.customer_id=$1 ORDER BY note.created_at DESC,note.id DESC LIMIT 50`, [id]),
      customer.branch_id ? pool.query(`SELECT id,email,role,reports_to_user_id FROM users WHERE organization_id=$1 AND role IN('manager','supervisor','employee') AND status='active' ORDER BY role,email LIMIT 500`, [customer.branch_id]) : Promise.resolve({ rows: [] }),
    ]);
    const piiRows = await loadOperationsCustomerPii(pool, [id]);
    const pii = projectOperationsCustomerPii(operationsCustomerPiiOrEmpty(piiRows, id), piiAccess.categories);
    if (piiAccess.categories.length) {
      await recordOperationsCustomerPiiAudit(pool, {
        actorUserId: user.id, action: "customer.pii_viewed", subjectType: "customer", subjectId: id,
        categories: piiAccess.categories, reason: piiAccess.reason!, scope: effectiveScope.scope, organizationIds: effectiveScope.organizationIds,
        resultCount: 1, requestId: request.headers.get("x-request-id"),
      });
    }
    return Response.json({
      customer: {
        customerId: customer.id,
        email: pii.contact.email ?? "***",
        status: customer.status,
        displayName: customer.display_name || null,
        contactNote: customer.contact_note || null,
        registeredAt: new Date(customer.created_at).toISOString(),
        updatedAt: new Date(customer.updated_at).toISOString(),
        archivedAt: customer.archived_at ? new Date(customer.archived_at).toISOString() : null,
        pii,
      },
      attribution: customer.attribution_id ? {
        id: customer.attribution_id, branchId: customer.branch_id, organizationName: customer.organization_name,
        managerId: customer.manager_id, managerEmail: maskOperationsEmail(customer.manager_email),
        supervisorId: customer.supervisor_id, supervisorEmail: maskOperationsEmail(customer.supervisor_email),
        employeeId: customer.employee_id, employeeEmail: maskOperationsEmail(customer.employee_email),
        effectiveAt: customer.effective_at ? new Date(customer.effective_at).toISOString() : null,
      } : null,
      membership: membership.rows[0] ? {
        id: membership.rows[0].id, planCode: membership.rows[0].plan_code, status: membership.rows[0].status,
        startsAt: membership.rows[0].starts_at ? new Date(membership.rows[0].starts_at).toISOString() : null,
        expiresAt: membership.rows[0].expires_at ? new Date(membership.rows[0].expires_at).toISOString() : null,
        graceEndsAt: membership.rows[0].grace_ends_at ? new Date(membership.rows[0].grace_ends_at).toISOString() : null,
      } : null,
      credits: credits.rows[0] ? {
        id: credits.rows[0].id, available: credits.rows[0].available_credits, reserved: credits.rows[0].reserved_credits,
        version: credits.rows[0].version, updatedAt: new Date(credits.rows[0].updated_at).toISOString(),
      } : null,
      creditLedger: creditLedger.rows.map((entry) => ({
        entryType: entry.entry_type, availableDelta: entry.available_delta, reservedDelta: entry.reserved_delta,
        balanceAvailable: entry.balance_available, balanceReserved: entry.balance_reserved,
        sourceType: entry.source_type, sourceId: entry.source_id, createdAt: new Date(entry.created_at).toISOString(),
      })),
      portfolios: portfolios.rows.map((portfolio) => ({
        id: portfolio.id, strategyCode: portfolio.strategy_code, principalUsdt: portfolio.principal_usdt,
        cashUsdt: portfolio.cash_usdt, realizedNetPnlUsdt: portfolio.realized_net_pnl_usdt, feesUsdt: portfolio.fees_usdt,
        accessStatus: portfolio.access_status, openPositions: Number(portfolio.open_positions), updatedAt: new Date(portfolio.updated_at).toISOString(),
      })),
      membershipOrders: orders.rows.map((order) => ({
        id: order.id, orderNo: order.order_no, planCode: order.plan_code, status: order.status,
        priceAmount: order.price_amount, priceCurrency: order.price_currency, createdAt: new Date(order.created_at).toISOString(),
        reviewedAt: order.reviewed_at ? new Date(order.reviewed_at).toISOString() : null,
      })),
      performanceStatements: statements.rows.map((statement) => ({
        id: statement.id, weekStart: new Date(statement.week_start).toISOString(), weekEnd: new Date(statement.week_end).toISOString(),
        status: statement.status, weekNetPnl: statement.week_net_pnl, feeAmount: statement.fee_amount,
        paymentStatus: statement.payment_status ?? null, createdAt: new Date(statement.created_at).toISOString(),
      })),
      notes: notes.rows.map((note) => ({
        id: note.id, content: note.content, createdAt: new Date(note.created_at).toISOString(),
        authorUserId: note.author_user_id, authorEmail: maskOperationsEmail(note.author_email),
      })),
      assignmentCandidates: candidates.rows.map((candidate) => ({
        id: candidate.id, email: maskOperationsEmail(candidate.email), role: candidate.role, reportsToUserId: candidate.reports_to_user_id,
      })),
      capabilities: {
        canManage: Boolean(access.permissions["ops.customers.manage"]),
        canTransfer: Boolean(access.permissions["ops.attributions.manage"]),
        canAdjustCredits: Boolean(access.permissions["ops.credits.adjust"]),
      },
      piiAccess: { available: availableCustomerPiiCategories(access.permissions), revealed: piiAccess.categories },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
