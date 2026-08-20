import { requireCurrentAccessAssignmentAdmin } from "@/lib/access-control";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireCurrentAccessAssignmentAdmin(request);
    const { id } = await context.params;
    throw new ResearchApiError("SENSITIVE_APPROVAL_REQUIRED", "角色撤销必须提交权限变更申请", 409, { assignmentId: id });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
