"use client";

import OrganizationRelationshipTree from "@/app/organization-relationship-tree";
import { PageHeading } from "@/packages/ui/src/page-state";

export function OrganizationWorkspace() {
  return <><PageHeading eyebrow="ORGANIZATION" title="组织架构" description="成员、上下级关系、客户归属和待审批调整。" /><section className="rc-panel rc-legacy-embed"><OrganizationRelationshipTree /></section></>;
}
