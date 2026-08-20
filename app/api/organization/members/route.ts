import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { approvalRequests, auditLogs, authTokens, customerAttributions, customerProfiles, organizations, sessions, users } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { hashPassword, normalizeEmail, randomToken, sha256, validEmail } from "@/lib/auth";
import { canAccessCustomerAttribution, canAccessOrganization } from "@/lib/operations-access";
import { encryptNotificationToken } from "@/lib/notification-secrets";
import { provisionInternalMember } from "@/lib/internal-member-provisioning";
import { canManuallyActivateMember, childRole, roleLabels } from "@/lib/permissions";
import { getPostgresPool } from "@/lib/postgres";
import { responseError } from "@/lib/session";

type RelationshipNode = {
  id: string;
  subjectId: string;
  parentId: string | null;
  kind: "member" | "customer";
  displayName: string;
  email: string;
  role: string;
  roleLabel: string;
  status: string;
  organizationId: string | null;
  organizationName: string;
  createdAt: string;
  attributionStatus?: string;
  attributionSource?: string;
  effectiveAt?: string | null;
  canManuallyActivate?: boolean;
};

const customerStatusPriority: Record<string, number> = { active: 5, review_pending: 4, public_pool_pending: 3, rejected: 2, ended: 1 };
const maskEmail = (email: string) => email.replace(/^(.{2}).*(@.*)$/, "$1***$2");

async function relationshipTree(request: Request) {
  const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.organization.view");
  const db = getDb();
  const [allUsers, allOrganizations, attributionRows] = await Promise.all([
    db.select({
      id: users.id,
      email: users.email,
      nickname: users.nickname,
      username: users.username,
      role: users.role,
      status: users.status,
      organizationId: users.organizationId,
      reportsToUserId: users.reportsToUserId,
      createdAt: users.createdAt,
    }).from(users).orderBy(desc(users.createdAt)).limit(5000),
    db.select({ id: organizations.id, name: organizations.name, type: organizations.type }).from(organizations).limit(1000),
    db.select({
      id: customerAttributions.id,
      customerId: customerAttributions.customerId,
      source: customerAttributions.source,
      attributionStatus: customerAttributions.status,
      branchId: customerAttributions.branchId,
      managerId: customerAttributions.managerId,
      supervisorId: customerAttributions.supervisorId,
      employeeId: customerAttributions.employeeId,
      effectiveAt: customerAttributions.effectiveAt,
      attributionCreatedAt: customerAttributions.createdAt,
      email: users.email,
      nickname: users.nickname,
      username: users.username,
      userStatus: users.status,
      registeredAt: users.createdAt,
      profileName: customerProfiles.displayName,
    }).from(customerAttributions)
      .innerJoin(users, eq(users.id, customerAttributions.customerId))
      .leftJoin(customerProfiles, eq(customerProfiles.customerId, users.id))
      .orderBy(desc(customerAttributions.createdAt))
      .limit(5000),
  ]);

  const organizationNames = new Map(allOrganizations.map(row => [row.id, row.name]));
  const internal = allUsers.filter(row => row.role !== "customer");
  const visibleMemberIds = new Set<string>([actor.id]);

  if (scope === "PLATFORM") {
    internal.forEach(row => visibleMemberIds.add(row.id));
  } else if (scope === "ORGANIZATION" || scope === "ORGANIZATION_SET") {
    internal.filter(row => Boolean(row.organizationId) && canAccessOrganization(scope, { userId: actor.id, organizationId: actor.organizationId }, row.organizationId!, organizationIds)).forEach(row => visibleMemberIds.add(row.id));
  } else {
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of internal) {
        if (!visibleMemberIds.has(row.id) && row.reportsToUserId && visibleMemberIds.has(row.reportsToUserId)) {
          visibleMemberIds.add(row.id);
          changed = true;
        }
      }
    }
  }

  const visibleMembers = internal.filter(row => visibleMemberIds.has(row.id));
  const memberIds = new Set(visibleMembers.map(row => row.id));
  const branchAdminByOrganization = new Map(
    visibleMembers.filter(row => row.role === "branch_admin" && row.organizationId).map(row => [row.organizationId!, row.id]),
  );
  const rootId = actor.id;
  const nodes: RelationshipNode[] = visibleMembers.map(row => {
    let parentId: string | null = null;
    if (row.id !== rootId) {
      parentId = row.reportsToUserId && memberIds.has(row.reportsToUserId) && row.reportsToUserId !== row.id
        ? row.reportsToUserId
        : rootId;
    }
    return {
      id: row.id,
      subjectId: row.id,
      parentId,
      kind: "member",
      displayName: row.nickname || row.username || row.email.split("@")[0],
      email: row.email,
      role: row.role,
      roleLabel: roleLabels[row.role] || row.role,
      status: row.status,
      organizationId: row.organizationId,
      organizationName: row.organizationId ? organizationNames.get(row.organizationId) || "未命名组织" : row.role === "hq_admin" ? "Riverton Capital 总公司" : "总公司职能部门",
      createdAt: row.createdAt,
      canManuallyActivate: canManuallyActivateMember(actor, row),
    };
  });

  const memberNodes = new Map(nodes.map(node => [node.id, node]));
  const reachesRoot = (node: RelationshipNode) => {
    const seen = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId) {
      if (parentId === rootId) return true;
      if (seen.has(parentId)) return false;
      seen.add(parentId);
      parentId = memberNodes.get(parentId)?.parentId || null;
    }
    return node.id === rootId;
  };
  nodes.forEach(node => {
    if (node.id !== rootId && !reachesRoot(node)) node.parentId = rootId;
  });

  const preferredAttributions = new Map<string, typeof attributionRows[number]>();
  for (const row of attributionRows) {
    const current = preferredAttributions.get(row.customerId);
    const nextPriority = customerStatusPriority[row.attributionStatus] || 0;
    const currentPriority = current ? customerStatusPriority[current.attributionStatus] || 0 : -1;
    if (!current || nextPriority > currentPriority) preferredAttributions.set(row.customerId, row);
  }

  for (const row of preferredAttributions.values()) {
    if (!canAccessCustomerAttribution(scope, { userId: actor.id, organizationId: actor.organizationId }, row, organizationIds)) continue;
    const preferredParentIds = [row.employeeId, row.supervisorId, row.managerId, row.branchId ? branchAdminByOrganization.get(row.branchId) : null];
    const parentId = preferredParentIds.find(id => id && memberIds.has(id)) || rootId;
    nodes.push({
      id: `customer:${row.customerId}`,
      subjectId: row.customerId,
      parentId,
      kind: "customer",
      displayName: row.profileName || row.nickname || row.username || "平台用户",
      email: maskEmail(row.email),
      role: "customer",
      roleLabel: "用户",
      status: row.userStatus,
      organizationId: row.branchId,
      organizationName: row.branchId ? organizationNames.get(row.branchId) || "未命名组织" : "待归属用户",
      createdAt: row.registeredAt,
      attributionStatus: row.attributionStatus,
      attributionSource: row.source,
      effectiveAt: row.effectiveAt,
    });
  }

  return Response.json({
    rootId,
    scope: actor.role,
    nodes,
    summary: {
      organizations: new Set(nodes.filter(node => node.organizationId).map(node => node.organizationId)).size,
      members: nodes.filter(node => node.kind === "member").length,
      customers: nodes.filter(node => node.kind === "customer").length,
      active: nodes.filter(node => node.status === "active").length,
    },
  });
}

export async function GET(request:Request){try{if(new URL(request.url).searchParams.get("view")==="tree")return await relationshipTree(request);const{user,scope,organizationIds}=await requireAccessPermission(request,"ops.organization.view");const target=childRole[user.role];if(!target)return Response.json({members:[]});const db=getDb();const candidates=await db.select({id:users.id,email:users.email,role:users.role,status:users.status,organizationId:users.organizationId,createdAt:users.createdAt}).from(users).where(eq(users.role,target as typeof users.$inferSelect.role)).orderBy(desc(users.createdAt)).limit(200);const rows=candidates.filter(row=>row.organizationId?canAccessOrganization(scope,{userId:user.id,organizationId:user.organizationId},row.organizationId,organizationIds):scope==="PLATFORM");return Response.json({members:rows,nextRole:target});}catch(e){return responseError(e)}}

export async function POST(request: Request) {
  try {
    const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.organization.manage");
    const body = await request.json() as { email?: string; name?: string };
    const email = normalizeEmail(body.email ?? "");
    if (!validEmail(email)) return Response.json({ error: "请输入有效邮箱" }, { status: 400 });
    const role = childRole[actor.role] as typeof users.$inferInsert.role | undefined;
    if (!role || role === "customer") return Response.json({ error: "该角色不能创建内部成员" }, { status: 403 });
    if (!["branch_admin", "manager", "supervisor", "employee", "finance", "auditor", "hq_support"].includes(role)) {
      return Response.json({ error: "目标内部角色不受支持" }, { status: 403 });
    }
    const db = getDb();
    if ((await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]) {
      return Response.json({ error: "邮箱已存在" }, { status: 409 });
    }
    let organizationId = actor.organizationId;
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    if (role === "branch_admin") {
      if (scope !== "PLATFORM") return Response.json({ error: "仅平台范围授权可创建分公司管理员" }, { status: 403 });
      organizationId = null;
    }
    if (role !== "branch_admin" && (!organizationId || !canAccessOrganization(scope, { userId: actor.id, organizationId: actor.organizationId }, organizationId, organizationIds))) {
      return Response.json({ error: "无权在该组织创建成员" }, { status: 403 });
    }
    const disabledCredential = randomToken(32);
    const activationToken = randomToken();
    const encryptedToken = await encryptNotificationToken(activationToken);
    const provisioned = await provisionInternalMember(await getPostgresPool(), {
      actorUserId: actor.id,
      userId,
      email,
      passwordHash: await hashPassword(disabledCredential),
      role: role as Parameters<typeof provisionInternalMember>[1]["role"],
      organizationId,
      organizationName: body.name,
      reportsToUserId: actor.id,
      activationTokenHash: await sha256(activationToken),
      encryptedNotificationToken: encryptedToken,
      now: new Date(now),
    });
    return Response.json({
      member: { id: userId, email, role, organizationId: provisioned.organizationId, status: "pending" },
      deliveryStatus: "queued",
      message: "成员已创建；邀请邮件进入发送队列，未发送前账户保持待激活",
    }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
export async function DELETE(request:Request){try{const{user:actor,scope,organizationIds}=await requireAccessPermission(request,"ops.organization.manage");const body=await request.json() as {memberId?:string};if(!body.memberId)return Response.json({error:"请选择要删除的成员账户"},{status:400});if(body.memberId===actor.id)return Response.json({error:"不能删除当前账户"},{status:400});const db=getDb(),member=(await db.select({id:users.id,email:users.email,role:users.role,status:users.status,organizationId:users.organizationId}).from(users).where(eq(users.id,body.memberId)).limit(1))[0];if(!member)return Response.json({error:"成员不存在"},{status:404});if(member.organizationId?!canAccessOrganization(scope,{userId:actor.id,organizationId:actor.organizationId},member.organizationId,organizationIds):scope!=="PLATFORM")return Response.json({error:"无权删除授权范围外的成员"},{status:403});if(member.status==="closed")return Response.json({error:"该账户已经删除"},{status:409});const now=new Date().toISOString();await db.batch([db.update(users).set({status:"closed",updatedAt:now}).where(eq(users.id,member.id)),db.update(sessions).set({revokedAt:now}).where(eq(sessions.userId,member.id)),db.update(authTokens).set({usedAt:now}).where(eq(authTokens.userId,member.id)),db.insert(auditLogs).values({id:crypto.randomUUID(),actorUserId:actor.id,action:"organization.member_deleted",subjectType:"user",subjectId:member.id,beforeJson:JSON.stringify(member),afterJson:JSON.stringify({status:"closed",deletedAt:now})})]);return Response.json({message:"成员账户已删除，历史记录已保留"});}catch(e){return responseError(e)}}
export async function PATCH(request:Request){try{const{user:actor,scope,organizationIds}=await requireAccessPermission(request,"ops.organization.manage"),body=await request.json()as{memberId?:string,newReportsToUserId?:string,newRole?:string,reason?:string};if(!body.memberId||!body.newReportsToUserId||!body.reason?.trim())return Response.json({error:"成员、新上级和调整原因均为必填"},{status:400});const allowedRoles=["branch_admin","manager","supervisor","employee"] as const;if(body.newRole&&!allowedRoles.includes(body.newRole as typeof allowedRoles[number]))return Response.json({error:"职位必须从下拉选项中选择"},{status:400});const db=getDb(),member=(await db.select().from(users).where(eq(users.id,body.memberId)).limit(1))[0],leader=(await db.select().from(users).where(eq(users.id,body.newReportsToUserId)).limit(1))[0];if(!member||!leader||member.organizationId!==leader.organizationId||!member.organizationId||!canAccessOrganization(scope,{userId:actor.id,organizationId:actor.organizationId},member.organizationId,organizationIds))return Response.json({error:"成员或上级不属于授权分公司"},{status:403});const allowed=(member.role==="manager"&&leader.role==="branch_admin")||(member.role==="supervisor"&&leader.role==="manager")||(member.role==="employee"&&leader.role==="supervisor");if(!allowed)return Response.json({error:"上下级角色关系不符合组织层级"},{status:400});const id=crypto.randomUUID();await db.insert(approvalRequests).values({id,type:"reporting_line_change",branchId:member.organizationId,subjectType:"user",subjectId:member.id,payloadJson:JSON.stringify({previousReportsToUserId:member.reportsToUserId,newReportsToUserId:leader.id,newRole:body.newRole||undefined,reason:body.reason.trim()}),requestedBy:actor.id});return Response.json({approvalId:id,status:"pending",message:"上下级与职位调整已提交双人审批"},{status:201})}catch(e){return responseError(e)}}
