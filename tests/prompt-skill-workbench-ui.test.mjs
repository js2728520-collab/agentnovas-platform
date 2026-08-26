import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PROMPT_CONFIGURATION_KEYS,
  SKILL_CONFIGURATION_KEY,
} from "../lib/prompt-skill-configuration.ts";
import {
  agentRolesForSkills,
  forbiddenInstructionReasons,
  instructionLengthState,
  promptRoleGroups,
  promptSafetyEnvelope,
  promptSkillLimits,
  skillConfigurationKey,
} from "../apps/maintenance/ui/prompt-skill-ui.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const uiKeys = promptRoleGroups.flatMap((group) => group.roles.map(([role]) => `${group.keyPrefix}.${role}`));

test("工作台的角色列表与登记的 10 个 Prompt key 一致", () => {
  // 下拉框少一个角色，那个角色就永远无法被配置；多一个，运维能创建一份没有任何消费者
  // 的配置，而它照样能走完审批与激活，看起来像生效了。
  assert.deepEqual([...uiKeys].sort(), [...PROMPT_CONFIGURATION_KEYS].sort());
  assert.equal(uiKeys.length, 10);
  assert.equal(skillConfigurationKey, SKILL_CONFIGURATION_KEY);
});

test("限值与合同一致——浏览器不能比服务端宽松", async () => {
  const contract = await read("lib/prompt-skill-configuration.ts");
  const numeric = (name) => {
    const match = contract.match(new RegExp(`const ${name} = ([\\d_]+);`));
    assert.ok(match, `未能在合同里找到常量 ${name}`);
    return Number(match[1].replace(/_/g, ""));
  };
  assert.equal(promptSkillLimits.instructionMin, numeric("INSTRUCTION_MIN"));
  assert.equal(promptSkillLimits.instructionMax, numeric("INSTRUCTION_MAX"));
  assert.equal(promptSkillLimits.instructionMaxBytes, numeric("INSTRUCTION_MAX_BYTES"));
  assert.equal(promptSkillLimits.skillNameMax, numeric("SKILL_NAME_MAX"));
  assert.equal(promptSkillLimits.skillDescriptionMax, numeric("SKILL_DESCRIPTION_MAX"));
  assert.equal(promptSkillLimits.maxSkills, numeric("MAX_SKILLS"));
});

test("展示的安全包络必须是代码里那几行，不是复述", async () => {
  // 这块展示的全部价值在于「你看到的就是你改不了的那几行」。写成近似的复述，它就成了
  // 装饰——包络改了而展示没改时，运维依据的是一段已经不存在的文字。
  const research = await read("lib/research-prompt-registry.ts");
  for (const line of promptSafetyEnvelope.research) {
    assert.ok(research.includes(line), `研发包络展示与源码不一致：${line}`);
  }
  const runtime = await read("lib/runtime-explanations.ts");
  for (const line of promptSafetyEnvelope.runtime) {
    assert.ok(runtime.includes(line), `运行时包络展示与源码不一致：${line}`);
  }
});

test("提前告知的拒绝原因与合同里的原因一致", async () => {
  const contract = await read("lib/prompt-skill-configuration.ts");
  const reasons = [...contract.matchAll(/reason: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...forbiddenInstructionReasons].sort(), [...reasons].sort());
});

test("适用角色列表覆盖全部 10 个 Agent 角色", async () => {
  const contract = await read("lib/prompt-skill-configuration.ts");
  assert.match(contract, /const ALL_AGENT_ROLES/);
  const fromKeys = PROMPT_CONFIGURATION_KEYS.map((key) => key.split(".")[1]);
  assert.deepEqual([...agentRolesForSkills].sort(), [...fromKeys].sort());
});

test("长度预检按字节与字符各自判定", () => {
  assert.equal(instructionLengthState("").valid, false);
  assert.equal(instructionLengthState("太短").tooShort, true);
  assert.equal(instructionLengthState("a".repeat(19)).valid, false);
  assert.equal(instructionLengthState("a".repeat(20)).valid, true);
  assert.equal(instructionLengthState("a".repeat(4_001)).tooLong, true);

  // 中文一个字符三字节：4,000 字符以内也可能越过 10,000 字节。两条限制必须分别判定，
  // 否则字节上限在中文正文上永远够不着，成了一条永不生效的规则。
  const chinese = instructionLengthState("策".repeat(3_400));
  assert.equal(chinese.characters, 3_400);
  assert.equal(chinese.bytes, 10_200);
  assert.equal(chinese.tooLong, false);
  assert.equal(chinese.tooManyBytes, true);
  assert.equal(chinese.valid, false);
});

test("Skill 面板明说尚无运行时消费者", async () => {
  const editor = await read("apps/maintenance/ui/prompt-skill-editor.tsx");
  // 不说清楚，运维激活之后会理所当然地认为它生效了（框架规则：active ≠ 业务已生效）。
  assert.match(editor, /Skill 尚无运行时消费者/);
  assert.match(editor, /不代表它已经生效/);

  // PS-06：停用是逻辑归档，不是删除。
  assert.match(editor, /归档（停用，不删除）/);
  assert.match(editor, /历史任务仍能说清自己用了什么/);

  // PS-02：五个字段，没有代码执行面。
  assert.match(editor, /没有 code、command、url、permissions、tools、secrets/);
});

test("Prompt 的 key 用下拉而不是自由输入", async () => {
  const editor = await read("apps/maintenance/ui/prompt-skill-editor.tsx");
  const panel = await read("apps/maintenance/ui/configuration-version-create-panel.tsx");
  assert.match(editor, /<select value=\{configurationKey\}/);
  // 自由输入的 key 会创建一份没有任何消费者的配置，而它照样能走完审批与激活。
  assert.match(panel, /\{!registeredPrompt && !registeredSkill && <label>配置 key/);
  // audience 与 schemaVersion 由合同固定，不给运维选。
  assert.match(panel, /if \(next === "prompt"\) \{\s*\n\s*setAudience\("shared"\)/);
  assert.match(panel, /if \(next === "skill"\) \{\s*\n\s*setAudience\("shared"\)/);
});

test("任务固定情况读不到时明说，不显示 0", async () => {
  const detail = await read("apps/maintenance/ui/configuration-version-detail-panel.tsx");
  // 「没有任务固定在这一版」与「查不到」是两个不同的结论。
  assert.match(detail, /pinnedForVersion\?\.error \? <p className="rc-warning">/);
  assert.match(detail, /激活与回滚只影响随后创建的新任务/);
  // 只对 prompt 族请求，其它族没有任务固定这个概念。
  assert.match(detail, /version\.kind === "prompt" \? version\.id : null/);
});
