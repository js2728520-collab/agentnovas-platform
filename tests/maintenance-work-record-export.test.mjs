import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAINTENANCE_WORK_RECORD_EXPORT_MAX_DAYS,
  MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS,
  maintenanceWorkRecordExportQueryHash,
  parseMaintenanceWorkRecordExportRequest,
} from "../lib/maintenance-work-record-export.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function rejects(body, fields) {
  assert.throws(() => parseMaintenanceWorkRecordExportRequest(body), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "VALIDATION_ERROR");
    if (fields) assert.deepEqual(error.details?.fields, fields);
    return true;
  });
}

test("导出请求体严格：只允许 from、to 和 reason", () => {
  const parsed = parseMaintenanceWorkRecordExportRequest({
    from: "2026-08-01", to: "2026-08-31", reason: "季度合规抽查",
  });
  assert.deepEqual(parsed, { from: "2026-08-01", to: "2026-08-31", reason: "季度合规抽查", days: 31 });

  // 多余字段一律拒绝。放行未知字段等于给以后的人留一个「隐藏参数扩大导出范围」的口子。
  rejects({ from: "2026-08-01", to: "2026-08-02", reason: "抽查", limit: 99999 }, ["limit"]);
  rejects({ from: "2026-08-01", to: "2026-08-02", reason: "抽查", customerId: "customer-a" }, ["customerId"]);
  rejects([], undefined);
  rejects("2026-08-01", undefined);
});

test("日期必须是存在的 UTC 日历日", () => {
  rejects({ from: "2026-8-1", to: "2026-08-02", reason: "抽查" }, ["from"]);
  rejects({ from: "2026-08-01", to: "20260802", reason: "抽查" }, ["to"]);
  // Date.parse 会把 2026-02-30 归一到 3 月，静默改变导出范围。
  rejects({ from: "2026-02-30", to: "2026-03-01", reason: "抽查" }, ["from"]);
  rejects({ from: "2026-13-01", to: "2026-13-02", reason: "抽查" }, ["from"]);
  rejects({ from: "2026-08-05", to: "2026-08-04", reason: "抽查" }, ["from", "to"]);

  // 闰日必须接受——按「30 天一个月」硬算会把它算掉。
  const leap = parseMaintenanceWorkRecordExportRequest({
    from: "2028-02-28", to: "2028-03-01", reason: "闰日边界抽查",
  });
  assert.equal(leap.days, 3);
});

test("区间上限是 31 天且两端包含", () => {
  const exact = parseMaintenanceWorkRecordExportRequest({
    from: "2026-08-01", to: "2026-08-31", reason: "上限边界",
  });
  assert.equal(exact.days, MAINTENANCE_WORK_RECORD_EXPORT_MAX_DAYS);

  // 同一天导出是 1 天而不是 0 天：写成半开区间会让当天导出返回空集。
  const singleDay = parseMaintenanceWorkRecordExportRequest({
    from: "2026-08-01", to: "2026-08-01", reason: "单日导出",
  });
  assert.equal(singleDay.days, 1);

  rejects({ from: "2026-08-01", to: "2026-09-01", reason: "超出上限" }, ["from", "to"]);
});

test("审计原因必填 3–500 字，且被幂等绑定", () => {
  rejects({ from: "2026-08-01", to: "2026-08-02", reason: "  " }, ["reason"]);
  rejects({ from: "2026-08-01", to: "2026-08-02", reason: "ab" }, ["reason"]);
  rejects({ from: "2026-08-01", to: "2026-08-02", reason: "x".repeat(501) }, ["reason"]);
  assert.equal(
    parseMaintenanceWorkRecordExportRequest({ from: "2026-08-01", to: "2026-08-02", reason: "  合规抽查  " }).reason,
    "合规抽查",
  );

  const route = "app/api/maintenance/work-records/export/route.maintenance.ts";
  return read(route).then((source) => {
    // 换一个原因就是另一次导出，必须重新留审计——因此 reason 进入幂等 payload。
    assert.match(source, /payload: \{ from: input\.from, to: input\.to, reason: input\.reason \}/);
  });
});

test("查询摘要只覆盖日期范围，不含导出正文", () => {
  const first = maintenanceWorkRecordExportQueryHash({ from: "2026-08-01", to: "2026-08-31" });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, maintenanceWorkRecordExportQueryHash({ from: "2026-08-01", to: "2026-08-31" }));
  assert.notEqual(first, maintenanceWorkRecordExportQueryHash({ from: "2026-08-01", to: "2026-08-30" }));
});

test("导出路由是敏感、同源、幂等的 Maintenance-only 写操作", async () => {
  const inventory = await read("lib/api-route-inventory.ts");
  const entry = inventory.slice(inventory.indexOf('"route": "/api/maintenance/work-records/export"'));
  // 条目内部有嵌套对象（permissionMfa），不能用第一个 "}," 收尾——那会把
  // requiresSameOrigin / idempotency 切掉，断言就变成永远只看前半段。
  const block = entry.slice(0, entry.indexOf("\n  },"));
  assert.match(block, /"audiences": \[\s*"maintenance"\s*\]/);
  assert.match(block, /"maint\.work_records\.export"/);
  assert.match(block, /"requiresSameOrigin": true/);
  assert.match(block, /"idempotency": true/);
  assert.match(block, /"sensitivity": "sensitive"/);
  // 独立敏感权限：能看聚合用量不等于能导出逐条客户决策记录。
  assert.doesNotMatch(block, /maint\.ai_usage\.view|maint\.audit\.view/);
});

test("导出响应不落盘、不缓存，并如实标注上限", async () => {
  const source = await read("app/api/maintenance/work-records/export/route.maintenance.ts");
  assert.match(source, /"content-disposition": `attachment;/);
  assert.match(source, /"x-export-retention": "none"/);
  assert.match(source, /"cache-control": "private, no-store, max-age=0"/);
  // 审计写查询摘要与条数，不写导出正文。
  assert.match(source, /queryHash: maintenanceWorkRecordExportQueryHash\(input\)/);
  assert.doesNotMatch(source, /rows: result\.rows/);

  const library = await read("lib/maintenance-work-record-export.ts");
  assert.match(library, new RegExp(`MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS = ${MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS.toLocaleString("en-US").replace(",", "_")}`));
  // 只读安全视图。join 回业务原表就等于把原表读权限还给运维端。
  assert.match(library, /FROM maintenance_strategy_work_records_safe/);
  assert.doesNotMatch(library, /JOIN\s+(strategy_|official_paper_|users)/);
});
