import type { Pool, PoolClient } from "pg";

import { decideMembershipOrder } from "./commercial-membership-service.ts";
import { decidePerformanceAssessment, decidePerformancePayment } from "./performance-fee-service.ts";

type Decision="approve"|"reject";
type CommercialMutationAuthorization=(client:PoolClient,customerId:string)=>Promise<void>;
export type CommercialApprovalCommand=
  | {kind:"membership_order";subjectId:string;reviewerUserId:string;decision:Decision;note:string;paymentEvidenceId:string;idempotencyKey:string;requestId:string;authorize?:CommercialMutationAuthorization}
  | {kind:"performance_assessment";subjectId:string;reviewerUserId:string;decision:Decision;note:string;idempotencyKey:string;authorize?:CommercialMutationAuthorization}
  | {kind:"performance_payment";subjectId:string;reviewerUserId:string;decision:Decision;note:string;paymentEvidenceId:string;idempotencyKey:string;requestId:string;authorize?:CommercialMutationAuthorization};

/** Explicit boundary: legacy generic approvals never dispatch commercial side effects. */
export function executeCommercialApproval(pool:Pool,command:CommercialApprovalCommand){
  if(command.kind==="membership_order")return decideMembershipOrder(pool,{orderId:command.subjectId,reviewerUserId:command.reviewerUserId,decision:command.decision,note:command.note,paymentEvidenceId:command.paymentEvidenceId,idempotencyKey:command.idempotencyKey,requestId:command.requestId,authorize:command.authorize});
  if(command.kind==="performance_assessment")return decidePerformanceAssessment(pool,{statementId:command.subjectId,reviewerUserId:command.reviewerUserId,decision:command.decision,note:command.note,idempotencyKey:command.idempotencyKey,authorize:command.authorize});
  return decidePerformancePayment(pool,{statementId:command.subjectId,reviewerUserId:command.reviewerUserId,decision:command.decision,note:command.note,paymentEvidenceId:command.paymentEvidenceId,idempotencyKey:command.idempotencyKey,requestId:command.requestId,authorize:command.authorize});
}
