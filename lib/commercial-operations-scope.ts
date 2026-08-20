import type { Pool } from "pg";

import type { OperationsIdentity } from "./operations-access.ts";
import type { DataScope } from "./rbac.ts";
import { ResearchApiError } from "./research-errors.ts";

export type CommercialOperationsScopeResolver=(input:{scope:DataScope;identity:OperationsIdentity;customerId:string})=>Promise<boolean>;
const unresolvedScope:CommercialOperationsScopeResolver=async()=>{throw new ResearchApiError("COMMERCIAL_SCOPE_RESOLVER_NOT_CONFIGURED","商业数据范围解析器尚未接入安全策略",503);};

export function commercialCustomerScopePredicate(...args:unknown[]){void args;return {clause:"FALSE",values:[] as unknown[]};}
export async function assertOperationsCustomerScope(_pool:Pool,scope:DataScope,identity:OperationsIdentity,customerId:string,resolver:CommercialOperationsScopeResolver=unresolvedScope){if(!await resolver({scope,identity,customerId}))throw new ResearchApiError("RESOURCE_NOT_FOUND","资源不存在或不在当前数据范围",404);}
export async function assertOperationsOrderScope(pool:Pool,scope:DataScope,identity:OperationsIdentity,orderId:string,resolver?:CommercialOperationsScopeResolver){const result=await pool.query<{user_id:string}>(`SELECT user_id FROM commercial_membership_orders WHERE id=$1`,[orderId]);if(!result.rows[0])throw new ResearchApiError("ORDER_NOT_FOUND","会员订单不存在",404);await assertOperationsCustomerScope(pool,scope,identity,result.rows[0].user_id,resolver);}
export async function assertOperationsStatementScope(pool:Pool,scope:DataScope,identity:OperationsIdentity,statementId:string,resolver?:CommercialOperationsScopeResolver){const result=await pool.query<{user_id:string}>(`SELECT user_id FROM performance_fee_statements WHERE id=$1`,[statementId]);if(!result.rows[0])throw new ResearchApiError("STATEMENT_NOT_FOUND","分成结算单不存在",404);await assertOperationsCustomerScope(pool,scope,identity,result.rows[0].user_id,resolver);}
