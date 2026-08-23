import { getPostgresPool } from "@/lib/postgres";
import { responseError } from "@/lib/session";
import { getCurrentCommercialLegalDocuments } from "@/lib/commercial-membership-service";

/**
 * 公开的法律文档读取。**不需要登录。**
 *
 * 此前唯一能读到条款的接口是 `/api/membership/legal-consent`，它需要登录——
 * 于是未注册的访客看不到任何条款内容，而落地页页脚却摆着「风险披露、隐私政策、
 * 服务条款」三个词（还是纯文本，点不动）。视觉上像入口、实际打不开，访客会认为
 * 平台把条款藏起来了。
 *
 * 只返回**已发布生效**的版本。草稿和待审批的不对外——那是双人复核流程的意义。
 */
export async function GET() {
  try {
    let documents: Awaited<ReturnType<typeof getCurrentCommercialLegalDocuments>>;
    try {
      documents = await getCurrentCommercialLegalDocuments(await getPostgresPool());
    } catch (error) {
      // 七项披露未配齐时，底层会抛 LEGAL_CONFIGURATION_INCOMPLETE 503——那是给业务
      // 闸门用的语义（没配齐就不许下单）。但对**公开页面**来说 503 是错的：
      // 访客该看到「条款尚未发布」，而不是一个看起来像平台故障的错误。
      //
      // 返回空列表，由页面告诉访客现状。这不是掩盖失败——页面上写的是
      // 「在此之前请勿注册或充值」，比一个 503 更能说明问题。
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code !== "LEGAL_CONFIGURATION_INCOMPLETE") throw error;
      return Response.json({ documents: [] }, {
        headers: { "cache-control": "no-store" },
      });
    }
    return Response.json({
      documents: documents.map((document) => ({
        documentType: document.document_type,
        version: document.version,
        locale: document.content_locale,
        // 内容哈希一并给出：客户可以核对自己当初同意的版本与现在展示的是否同一份。
        contentSha256: document.content_sha256,
        contentMarkdown: document.content_markdown,
      })),
    }, {
      headers: {
        // 条款是低频变更的公开内容，允许 CDN 短缓存；发布新版本时哈希会变。
        "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    return responseError(error);
  }
}
