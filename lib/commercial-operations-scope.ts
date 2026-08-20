import type { Pool } from "pg";

import { customerScopePredicate, type OperationsIdentity } from "./operations-access.ts";
import type { DataScope } from "./rbac.ts";
import { ResearchApiError } from "./research-errors.ts";

export async function assertOperationsCustomerScope(pool:Pool,scope:DataScope,identity:OperationsIdentity,customerId:string){
  const values:unknown[]=[customerId];
  const scoped=customerScopePredicate(scope,identity,"scope_customer","target.id",2);
  values.push(...scoped.values);
  const result=await pool.query(`SELECT 1 FROM users target
    LEFT JOIN (SELECT id AS customer_id,organization_id AS branch_id FROM users) scope_customer ON scope_customer.customer_id=target.id
    WHERE target.id=$1 AND ${scoped.clause}`,values);
  if(!result.rows[0])throw new ResearchApiError("RESOURCE_NOT_FOUND","资源不存在或不在当前数据范围",404);
}

export async function assertOperationsOrderScope(pool:Pool,scope:DataScope,identity:OperationsIdentity,orderId:string){
  const result=await pool.query<{user_id:string}>(`SELECT user_id FROM commercial_membership_orders WHERE id=$1`,[orderId]);
  if(!result.rows[0])throw new ResearchApiError("ORDER_NOT_FOUND","会员订单不存在",404);
  await assertOperationsCustomerScope(pool,scope,identity,result.rows[0].user_id);
}

export async function assertOperationsStatementScope(pool:Pool,scope:DataScope,identity:OperationsIdentity,statementId:string){
  const result=await pool.query<{user_id:string}>(`SELECT user_id FROM performance_fee_statements WHERE id=$1`,[statementId]);
  if(!result.rows[0])throw new ResearchApiError("STATEMENT_NOT_FOUND","分成结算单不存在",404);
  await assertOperationsCustomerScope(pool,scope,identity,result.rows[0].user_id);
}
