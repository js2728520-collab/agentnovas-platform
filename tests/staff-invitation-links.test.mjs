import assert from "node:assert/strict";
import test from "node:test";

import {
  STAFF_INVITATION_TTL_MS,
  isStaffInvitationUsable,
  staffInvitationExpiry,
} from "../lib/invitation-links.ts";

const NOW = new Date("2026-08-23T00:00:00.000Z");

test("员工链接 48 小时有效", () => {
  assert.equal(staffInvitationExpiry(NOW), "2026-08-25T00:00:00.000Z");
  assert.equal(STAFF_INVITATION_TTL_MS, 48 * 3600_000);
});

test("有效期只能收紧，不能放宽", () => {
  // 一个能被配置成无限的期限等于没有期限。
  assert.equal(staffInvitationExpiry(NOW, 3600_000), "2026-08-23T01:00:00.000Z");
  assert.throws(() => staffInvitationExpiry(NOW, STAFF_INVITATION_TTL_MS + 1), /STAFF_INVITATION_TTL_INVALID/);
  assert.throws(() => staffInvitationExpiry(NOW, 0), /STAFF_INVITATION_TTL_INVALID/);
  assert.throws(() => staffInvitationExpiry(NOW, Number.POSITIVE_INFINITY), /STAFF_INVITATION_TTL_INVALID/);
});

test("有效期内可用", () => {
  const link = { status: "active", expiresAt: "2026-08-25T00:00:00.000Z" };
  assert.deepEqual(isStaffInvitationUsable(link, NOW), { usable: true, reason: null });
});

test("过期即不可用", () => {
  const link = { status: "active", expiresAt: "2026-08-22T23:59:59.000Z" };
  assert.equal(isStaffInvitationUsable(link, NOW).reason, "STAFF_LINK_EXPIRED");
});

test("已撤销的链接不可用，哪怕还没到期", () => {
  const link = { status: "revoked", expiresAt: "2026-08-25T00:00:00.000Z" };
  assert.equal(isStaffInvitationUsable(link, NOW).reason, "STAFF_LINK_NOT_ACTIVE");
});

test("缺期限或期限损坏一律判为不可用", () => {
  // 默认放行才是危险的方向：一条没有期限的员工链接就是永久入口。
  assert.equal(isStaffInvitationUsable({ status: "active", expiresAt: null }, NOW).reason, "STAFF_LINK_MISSING_EXPIRY");
  assert.equal(isStaffInvitationUsable({ status: "active", expiresAt: "not-a-date" }, NOW).reason, "STAFF_LINK_EXPIRY_INVALID");
});

test("恰好在到期时刻仍然可用", () => {
  // 边界写成 > 而不是 >=：链接在标注的到期时刻之前都算有效。
  const link = { status: "active", expiresAt: "2026-08-23T00:00:00.000Z" };
  assert.equal(isStaffInvitationUsable(link, NOW).usable, true);
});
