import type { Pool } from "pg";

import { decideMembershipOrder } from "./commercial-membership-service.ts";
import { decidePerformanceAssessment, decidePerformancePayment } from "./performance-fee-service.ts";

type Decision="approve"|"reject";
export type CommercialApprovalCommand=
  | {kind:"membership_order";subjectId:string;reviewerUserId:string;decision:Decision;note:string;idempotencyKey:string;requestId:string}
  | {kind:"performance_assessment";subjectId:string;reviewerUserId:string;decision:Decision;note:string;idempotencyKey:string}
  | {kind:"performance_payment";subjectId:string;reviewerUserId:string;decision:Decision;note:string;idempotencyKey:string;requestId:string};

/** Explicit boundary: legacy generic approvals never dispatch commercial side effects. */
export function executeCommercialApproval(pool:Pool,command:CommercialApprovalCommand){
  if(command.kind==="membership_order")return decideMembershipOrder(pool,{orderId:command.subjectId,reviewerUserId:command.reviewerUserId,decision:command.decision,note:command.note,idempotencyKey:command.idempotencyKey,requestId:command.requestId});
  if(command.kind==="performance_assessment")return decidePerformanceAssessment(pool,{statementId:command.subjectId,reviewerUserId:command.reviewerUserId,decision:command.decision,note:command.note,idempotencyKey:command.idempotencyKey});
  return decidePerformancePayment(pool,{statementId:command.subjectId,reviewerUserId:command.reviewerUserId,decision:command.decision,note:command.note,idempotencyKey:command.idempotencyKey,requestId:command.requestId});
}
