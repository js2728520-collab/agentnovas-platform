import { requireAccessPermission } from "@/lib/access-control";
import { responseError } from "@/lib/session";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "ops.team.view");
    const url = new URL(request.url), month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    const internalUrl = new URL("/api/team/monthly-targets", request.url); internalUrl.searchParams.set("month", month);
    const response = await fetch(internalUrl, { headers: { cookie: request.headers.get("cookie") || "" } });
    if (!response.ok) return response;
    const data = await response.json() as { staff?: Array<Record<string, unknown>> };
    const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const header = ["排名", "成员", "角色", "是否设置目标", "综合完成率", "新增客户完成/目标", "月卡完成/目标", "季卡完成/目标", "年卡完成/目标", "备注"];
    const lines = (data.staff || []).map(row => { const actual = row.actual as Record<string, number>, goals = row.goals as Record<string, number>; return [row.rank, row.email, row.role, row.assigned ? "是" : "否", `${row.overallProgress}%`, `${actual.newCustomers}/${goals.newCustomers}`, `${actual.monthlyCards}/${goals.monthlyCards}`, `${actual.quarterlyCards}/${goals.quarterlyCards}`, `${actual.annualCards}/${goals.annualCards}`, row.note].map(quote).join(","); });
    return new Response(`\uFEFF${header.map(quote).join(",")}\n${lines.join("\n")}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="team-targets-${month}.csv"` } });
  } catch (error) { return responseError(error); }
}
