import { requireAccessPermission } from "@/lib/access-control";
import {
  listAuditChainAnchors,
  recordAuditChainAnchor,
  verifyAuditChainAnchors,
} from "@/lib/audit-chain-anchor";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

/**
 * 审计链尾锚点。
 *
 * GET  列出已登记的锚点，并附上一次校验结果。
 * POST 登记一个新锚点（把当前链尾记下来）。
 *
 * 校验为什么必须暴露给人看：0044 的哈希链检不出截断链尾——把最后 N 行删掉，
 * 剩下的链依然自洽。锚点是唯一能发现这件事的机制，而它只有被定期查看
 * （或导出到库外）才有意义。
 */

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.audit.view");
    const pool = await getPostgresPool();
    const [anchors, violations] = await Promise.all([
      listAuditChainAnchors(pool, { limit: 50 }),
      verifyAuditChainAnchors(pool),
    ]);
    return Response.json(
      {
        anchors,
        violations,
        // 不用 violations.length === 0 直接叫「完好」：没有锚点时同样是空数组，
        // 但那代表「没有保护」而不是「验证通过」（INV-6）。
        status: anchors.length === 0
          ? "not_anchored"
          : violations.length === 0 ? "verified" : "violated",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "maint.audit.view");
    const pool = await getPostgresPool();
    const anchor = await recordAuditChainAnchor(pool, { anchoredBy: user.id });
    if (!anchor) {
      // 空审计表没有链尾可锚。不造零值锚点——假锚点会让「没有保护」
      // 看起来像「有保护」。
      return Response.json({ status: "no_audit_entries" }, { status: 409 });
    }
    return Response.json({ status: anchor.created ? "recorded" : "unchanged", anchor }, { status: 201 });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
