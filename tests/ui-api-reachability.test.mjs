import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { API_ROUTE_INVENTORY } from "../lib/api-route-inventory.ts";

/**
 * 界面调的接口必须在该端的构建里真的可用。
 *
 * 由来：T4.4 的策略广场与客户暂停/恢复界面上线后才发现，它们调的两条接口都在 Beta 停用
 * 清单里，运行时返回 503。**类型检查与测试全绿**——路由文件存在、函数签名对、UI 契约测试
 * 也过，但客户点下去只会看到错误。这类问题没有任何现有闸门能发现。
 */

/**
 * 已知调用停用接口的界面。
 *
 * 这些是**既有**的、刻意关闭的 Beta 面：研发运行时与交易所凭证在 ADR-0019 的密钥托管
 * 完成前保持关闭。策略实验室有入口指向它们，客户点进去会看到「接口尚未启用」——诚实但
 * 不优雅，是独立的 UX 问题，不在本守卫的职责内。
 *
 * **这个清单只减不增。** 新界面调停用接口一律视为缺陷：T4.4 的策略广场与客户暂停/恢复
 * 就是这么上线的，类型检查与测试全绿而运行时 503。
 */
const KNOWN_DISABLED_CALLS = new Set([
  "apps/client/ui/strategy-studio.tsx|/api/exchange-accounts",
  "apps/client/ui/strategy-studio.tsx|/api/exchange-accounts/:param/perpetual-instruments",
  "apps/client/ui/strategy-studio.tsx|/api/strategy-research/runs",
  "apps/client/ui/strategy-studio.tsx|/api/strategy-research/runs/:param",
  "apps/client/ui/strategy-studio.tsx|/api/strategy-research/runs/:param/events",
  "apps/client/ui/strategy-studio.tsx|/api/strategy-deployments/:param",
  "apps/client/ui/strategy-studio.tsx|/api/strategy-deployments/:param/cycles",
  "apps/client/ui/strategy-studio.tsx|/api/strategy-deployments/:param/:param",
  "apps/client/ui/strategy-studio.tsx|/api/strategy-research/runs/:param/cancel",
  "apps/client/ui/strategy-studio.tsx|/api/strategy-research/runs/:param/answer",
  "apps/client/ui/strategy-studio.tsx|/api/strategy-research/runs/:param/candidates/:param/save",
  "apps/client/ui/strategy-studio.tsx|/api/strategies/:param/versions/:param/deployments",
]);

const AUDIENCE_BY_DIRECTORY = {
  "apps/client": "client",
  "apps/operations": "operations",
  "apps/maintenance": "maintenance",
};

/** 路径参数替换成 :param，与 inventory 的写法对齐。 */
function toPattern(path) {
  return path
    .replace(/\$\{[^}]*\}/g, ":param")
    .replace(/\/:param(?=\/|$)/g, "/:param");
}

function matches(inventoryRoute, called) {
  const expected = inventoryRoute.split("/").filter(Boolean);
  const actual = called.split("/").filter(Boolean);
  if (expected.length !== actual.length) return false;
  return expected.every((part, index) => part.startsWith(":") || actual[index].startsWith(":") || part === actual[index]);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

test("界面调用的每条接口都在该端可用，且未被停用", async () => {
  const problems = [];
  for (const [directory, audience] of Object.entries(AUDIENCE_BY_DIRECTORY)) {
    for (const file of await walk(new URL(`../${directory}/`, import.meta.url).pathname)) {
      const source = await readFile(file, "utf8");
      // 只看字符串字面量里的 /api/ 路径；动态拼出来的地址这条守卫覆盖不到。
      const called = [...source.matchAll(/["'`](\/api\/[^"'`\s]*)["'`]/g)].map((match) => toPattern(match[1]));
      for (const path of new Set(called)) {
        const route = path.split("?")[0];
        const entries = API_ROUTE_INVENTORY.filter((item) => matches(item.route, route));
        const relative = file.slice(file.indexOf(directory));
        if (entries.length === 0) {
          // 字面量若是某条已登记路由的**前缀**，多半是用来拼子路径的 base 变量，不是端点
          // 本身（例如 `const base = \`/api/x/${id}\`` 之后再拼 /approval）。正则扫不出
          // 这个区别，因此跳过——本守卫真正要抓的是「调了停用接口」，不是路由登记。
          // 参数名不一定相同（登记里是 :id，扫出来是 :param），因此按段比较而不是字符串前缀。
          const segments = route.split("/").filter(Boolean);
          const isBasePath = API_ROUTE_INVENTORY.some((item) => {
            const target = item.route.split("/").filter(Boolean);
            if (target.length <= segments.length) return false;
            return segments.every((part, index) =>
              part.startsWith(":") || target[index].startsWith(":") || part === target[index]);
          });
          if (!isBasePath) problems.push(`${relative} 调用了未登记的接口 ${route}`);
          continue;
        }
        if (!entries.some((item) => item.audiences.includes(audience))) {
          problems.push(`${relative} 调用的 ${route} 不在 ${audience} 构建里`);
        }
        // 全部方法都停用才算不可达；部分方法停用是正常的（例如广场只开了 GET）。
        if (entries.every((item) => item.authentication === "disabled")
          && !KNOWN_DISABLED_CALLS.has(`${relative}|${route}`)) {
          problems.push(`${relative} 调用的 ${route} 在当前构建里被停用，运行时返回 503`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], `界面调用了不可达的接口：\n${problems.join("\n")}`);
});

test("已知清单只减不增——修好的条目要从清单里拿掉", async () => {
  // 一个已经启用的接口留在清单里，会让守卫对它永远失明。
  const stale = [];
  for (const entry of KNOWN_DISABLED_CALLS) {
    const route = entry.split("|")[1];
    const entries = API_ROUTE_INVENTORY.filter((item) => matches(item.route, route));
    if (entries.length > 0 && entries.some((item) => item.authentication !== "disabled")) {
      stale.push(`${route} 已启用，应从 KNOWN_DISABLED_CALLS 移除`);
    }
  }
  assert.deepEqual(stale, []);
});
