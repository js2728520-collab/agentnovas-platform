import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertProvisionalParametersAllowed,
  PROVISIONAL_PARAMETER_ENV,
  PROVISIONAL_PRODUCT_PARAMETERS,
  provisionalDisclosure,
} from "../packages/contracts/src/provisional-product-parameters.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("P-01–P-12 全部有占位项，且每项都标注 provisional 与理由", () => {
  const keys = Object.keys(PROVISIONAL_PRODUCT_PARAMETERS);
  assert.equal(keys.length, 12);
  for (let index = 1; index <= 12; index += 1) {
    const key = `P-${String(index).padStart(2, "0")}`;
    const entry = PROVISIONAL_PRODUCT_PARAMETERS[key];
    assert.ok(entry, `${key} 必须有占位项`);
    assert.equal(entry.parameter, key);
    // provisional 恒为 true：占位值不能在任何路径上把自己表述成已确认配置（INV-6）。
    assert.equal(entry.provisional, true);
    // 理由是给后来者看的——没有它，占位值三个月后会被当成调研结论。
    assert.ok(entry.rationale.length >= 20, `${key} 必须说明占位值的来由`);
  }
});

test("生产失败关闭：未显式开启时任何占位参数都不可用", () => {
  // 只有精确值 "true" 放行，与 MFA_ENFORCEMENT_ENABLED 的判定方式一致。
  for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) {
    assert.throws(
      () => assertProvisionalParametersAllowed("P-07", { [PROVISIONAL_PARAMETER_ENV]: value }),
      (error) => {
        assert.equal(error.code, "PROVISIONAL_PARAMETER_NOT_ALLOWED");
        return true;
      },
      `环境值 ${JSON.stringify(value)} 不应放行占位参数`,
    );
  }
  const allowed = assertProvisionalParametersAllowed("P-07", { [PROVISIONAL_PARAMETER_ENV]: "true" });
  assert.equal(allowed.parameter, "P-07");
});

test("对外投影必须带未确认标记", () => {
  const disclosure = provisionalDisclosure("P-05");
  assert.equal(disclosure.provisional, true);
  assert.equal(disclosure.confirmed, false);
  assert.match(disclosure.notice, /未经需求方确认/);
});

test("高风险参数的占位值保持关闭，而不是先放行", () => {
  // 资金出站：即使功能开发完成，没有真实结论前也必须固定拒绝（PRD 7.3、G5）。
  assert.equal(PROVISIONAL_PRODUCT_PARAMETERS["P-09"].value.enabled, false);
  assert.equal(PROVISIONAL_PRODUCT_PARAMETERS["P-09"].value.dailyLimitUsdt, "0");
  assert.deepEqual(PROVISIONAL_PRODUCT_PARAMETERS["P-09"].value.networks, []);

  // 外汇/贵金属：没有场所与牌照结论时只读，不能由行情存在推导可交易。
  assert.equal(PROVISIONAL_PRODUCT_PARAMETERS["P-02"].value.tradable, false);
  assert.equal(PROVISIONAL_PRODUCT_PARAMETERS["P-02"].value.readOnlyQuotes, true);

  // MetaMask 不参与下单与资金出站——占位期不把签名能力引进执行链路。
  const metamask = PROVISIONAL_PRODUCT_PARAMETERS["P-01"].value.metamask;
  assert.equal(metamask.allowsOrderSigning, false);
  assert.equal(metamask.allowsFundsMovement, false);
});

test("不编造无法验证的外部事实", () => {
  // 假 URL 比空引用危险：它会被当成真地址去访问或写进文档。
  assert.equal(PROVISIONAL_PRODUCT_PARAMETERS["P-04"].value.repositoryUrl, null);
  assert.equal(PROVISIONAL_PRODUCT_PARAMETERS["P-04"].value.demoUrl, null);
  // 假日期会把未经估算的目标伪装成承诺（路线图第 13 节）。
  assert.equal(PROVISIONAL_PRODUCT_PARAMETERS["P-11"].value.freezeDate, null);
  for (const milestone of PROVISIONAL_PRODUCT_PARAMETERS["P-12"].value.milestones) {
    assert.equal(milestone.targetDate, null, `${milestone.id} 不得填占位日期`);
  }
});

test("占位价格沿用当前生产快照，不另造一套数字", () => {
  // 与 packages/contracts 已在跑的 v1 四档一致，替换真值时差异最小。
  const plans = PROVISIONAL_PRODUCT_PARAMETERS["P-07"].value.plans;
  assert.deepEqual(plans.map((plan) => plan.code), ["monthly_v1", "quarterly_v1", "annual_v1", "lifetime_v1"]);
  assert.equal(plans.find((plan) => plan.code === "lifetime_v1").performanceFeeRate, "0.16");
  assert.equal(plans.find((plan) => plan.code === "monthly_v1").performanceFeeRate, "0.20");
});

test("占位参数集中在唯一真源，不散落成硬编码", async () => {
  const source = await read("packages/contracts/src/provisional-product-parameters.ts");
  assert.match(source, /P-01/);
  assert.match(source, /P-12/);
  // 补真值时改这一个文件；这条断言防止有人在别处再复制一份占位常量。
  assert.match(source, /单一真源/);
  assert.match(source, /生产失败关闭/);
});
