"use client";

import { useState } from "react";

import type { ConfigurationAudience, ConfigurationKind } from "@/lib/versioned-configuration-domain";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import {
  configurationAudiences,
  configurationKinds,
  localDateTimeWithOffset,
  offsetForLocalDateTime,
  parseConfigurationPayload,
  splitTargetValues,
} from "./configuration-version-ui";
import { emptySkill, PromptConfigurationEditor, SkillConfigurationEditor, type SkillDraft } from "./prompt-skill-editor";
import { instructionLengthState, promptSkillLimits, skillConfigurationKey } from "./prompt-skill-ui";

type DraftCommand = {
  kind: ConfigurationKind;
  key: string;
  audience: ConfigurationAudience;
  schemaVersion: number;
  payload: Record<string, unknown>;
  reason: string;
};

const STRATEGY_RESEARCH_FLAG = {
  key: "client.strategy_research",
  audience: "client" as const,
};
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RELEASE_VERSION = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function validTargetList(value: string, pattern: RegExp, maximum: number) {
  const values = splitTargetValues(value);
  return values.length <= maximum && values.every((item) => pattern.test(item));
}

export function ConfigurationVersionCreatePanel({ busy, onCreate, report }: {
  busy: boolean;
  onCreate: (command: DraftCommand) => Promise<void>;
  report: (message: string) => void;
}) {
  const [kind, setKind] = useState<ConfigurationKind>("feature_flag");
  const [audience, setAudience] = useState<ConfigurationAudience>(STRATEGY_RESEARCH_FLAG.audience);
  const [key, setKey] = useState(STRATEGY_RESEARCH_FLAG.key);
  const [schemaVersion, setSchemaVersion] = useState(1);
  const [featureEnabled, setFeatureEnabled] = useState(false);
  const [featureScope, setFeatureScope] = useState<"global" | "targeted">("global");
  const [defaultEnabled, setDefaultEnabled] = useState(false);
  const [targetEnabled, setTargetEnabled] = useState(true);
  const [userIds, setUserIds] = useState("");
  const [organizationIds, setOrganizationIds] = useState("");
  const [applicationVersions, setApplicationVersions] = useState("");
  const [rolloutPercentage, setRolloutPercentage] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [payload, setPayload] = useState("{}");
  const [reason, setReason] = useState("");
  const [instruction, setInstruction] = useState("");
  const [skills, setSkills] = useState<SkillDraft[]>([emptySkill()]);
  const registeredFeatureFlag = kind === "feature_flag";
  // Prompt 与 Skill 走结构化编辑而不是裸 JSON：payload 只有一两个字段，让运维手写
  // JSON 只会把「引号打错」变成一次失败的草稿创建。
  const registeredPrompt = kind === "prompt";
  const registeredSkill = kind === "skill";
  const targetedFeatureFlag = registeredFeatureFlag && featureScope === "targeted";

  function changeKind(next: ConfigurationKind) {
    setKind(next);
    if (next === "feature_flag") {
      setAudience(STRATEGY_RESEARCH_FLAG.audience);
      setKey(STRATEGY_RESEARCH_FLAG.key);
      setSchemaVersion(1);
      setFeatureScope("global");
    }
    // Prompt / Skill 两族的 audience 与 schemaVersion 由合同固定，不给运维选：
    // 选错了会创建一份没有任何消费者的配置，而它照样能走完审批与激活。
    if (next === "prompt") {
      setAudience("shared");
      setKey("research.requirements");
      setSchemaVersion(1);
    }
    if (next === "skill") {
      setAudience("shared");
      setKey(skillConfigurationKey);
      setSchemaVersion(1);
    }
  }

  function targetedPayload() {
    const target: Record<string, unknown> = { enabled: targetEnabled };
    const users = splitTargetValues(userIds);
    const organizations = splitTargetValues(organizationIds);
    const versions = splitTargetValues(applicationVersions);
    if (users.length) target.userIds = users;
    if (organizations.length) target.organizationIds = organizations;
    if (versions.length) target.applicationVersions = versions;
    if (rolloutPercentage.trim()) target.rolloutPercentage = Number(rolloutPercentage);
    if (startsAt) target.startsAt = localDateTimeWithOffset(startsAt, offsetForLocalDateTime(startsAt));
    if (endsAt) target.endsAt = localDateTimeWithOffset(endsAt, offsetForLocalDateTime(endsAt));
    return { defaultEnabled, target };
  }

  function structuredPayload(): Record<string, unknown> {
    if (registeredFeatureFlag) return targetedFeatureFlag ? targetedPayload() : { enabled: featureEnabled };
    if (registeredPrompt) return { instruction: instruction.trim() };
    if (registeredSkill) {
      return {
        skills: skills.map((skill) => ({
          name: skill.name.trim(),
          description: skill.description.trim(),
          instruction: skill.instruction.trim(),
          agentRoles: [...skill.agentRoles].sort(),
          enabled: skill.enabled,
        })),
      };
    }
    return parseConfigurationPayload(payload);
  }

  async function submit() {
    try {
      const command: DraftCommand = {
        kind,
        key,
        audience,
        schemaVersion: registeredFeatureFlag && targetedFeatureFlag ? 2
          : registeredFeatureFlag || registeredPrompt || registeredSkill ? 1
          : schemaVersion,
        payload: structuredPayload(),
        reason,
      };
      await onCreate(command);
      setReason("");
    } catch (error) {
      report(error instanceof Error ? error.message : "配置草稿创建失败");
    }
  }

  const validKey = /^[a-z][a-z0-9_.-]{2,120}$/.test(key.trim());
  const percentage = rolloutPercentage.trim() ? Number(rolloutPercentage) : null;
  const percentageValid = percentage === null || (Number.isInteger(percentage) && percentage >= 0 && percentage <= 100);
  const hasTargetCondition = Boolean(
    splitTargetValues(userIds).length
    || splitTargetValues(organizationIds).length
    || splitTargetValues(applicationVersions).length
    || rolloutPercentage.trim()
    || startsAt
    || endsAt,
  );
  const startInstant = startsAt ? Date.parse(localDateTimeWithOffset(startsAt, offsetForLocalDateTime(startsAt))) : null;
  const endInstant = endsAt ? Date.parse(localDateTimeWithOffset(endsAt, offsetForLocalDateTime(endsAt))) : null;
  const timeRangeValid = startInstant === null || endInstant === null || startInstant < endInstant;
  // Prompt / Skill 的提交前判定。服务端仍是唯一判定方——这里只是不让一份必然被 422
  // 拒绝的草稿白跑一趟。
  const promptValid = !registeredPrompt || instructionLengthState(instruction).valid;
  const skillValid = !registeredSkill || (
    skills.length > 0
    && skills.length <= promptSkillLimits.maxSkills
    && skills.every((skill) =>
      skill.name.trim().length > 0
      && skill.name.trim().length <= promptSkillLimits.skillNameMax
      && skill.description.trim().length > 0
      && skill.description.trim().length <= promptSkillLimits.skillDescriptionMax
      && skill.agentRoles.length > 0
      && instructionLengthState(skill.instruction).valid)
  );
  const targetingValid = !targetedFeatureFlag || (
    hasTargetCondition
    && percentageValid
    && validTargetList(userIds, TARGET_ID, 100)
    && validTargetList(organizationIds, TARGET_ID, 100)
    && validTargetList(applicationVersions, RELEASE_VERSION, 20)
    && timeRangeValid
  );

  return <section className="rc-panel">
    <header><div><small>IMMUTABLE DRAFT</small><h2>创建配置草稿</h2><p>普通草稿会直接创建并记录原因；内容创建后不可覆盖，修改请创建下一版本。</p></div></header>
    <div className="rc-form rc-form-grid">
      <label>配置类型<select value={kind} onChange={(event) => changeKind(event.target.value as ConfigurationKind)}>{configurationKinds.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>作用端<select value={audience} disabled={registeredFeatureFlag} onChange={(event) => setAudience(event.target.value as ConfigurationAudience)}>{configurationAudiences.map((value) => <option key={value}>{value}</option>)}</select></label>
      {!registeredPrompt && !registeredSkill && <label>配置 key<input spellCheck={false} value={key} readOnly={registeredFeatureFlag} onChange={(event) => setKey(event.target.value)} placeholder="prompt.research_system" /><small>{registeredFeatureFlag ? "注册族固定接入 Client 策略研究入口。" : "小写字母开头，可使用数字、点、下划线和连字符。"}</small></label>}
      {!registeredPrompt && !registeredSkill && <label>Schema 版本<input type="number" min={1} max={1_000_000} value={registeredFeatureFlag ? targetedFeatureFlag ? 2 : 1 : schemaVersion} readOnly={registeredFeatureFlag} onChange={(event) => setSchemaVersion(Number(event.target.value))} /></label>}
      {registeredFeatureFlag ? <>
        <label>发布范围<select value={featureScope} onChange={(event) => setFeatureScope(event.target.value as "global" | "targeted")}><option value="global">全局开关 v1</option><option value="targeted">定向规则 v2</option></select></label>
        {!targetedFeatureFlag
          ? <label>模块状态<select value={featureEnabled ? "enabled" : "disabled"} onChange={(event) => setFeatureEnabled(event.target.value === "enabled")}><option value="disabled">关闭</option><option value="enabled">开启</option></select><small>环境变量 Gate 仍是上限；current 版本只能进一步关闭，不能越权开启。</small></label>
          : <>
            <label>未命中状态<select value={defaultEnabled ? "enabled" : "disabled"} onChange={(event) => setDefaultEnabled(event.target.value === "enabled")}><option value="disabled">关闭</option><option value="enabled">开启</option></select></label>
            <label>命中状态<select value={targetEnabled ? "enabled" : "disabled"} onChange={(event) => setTargetEnabled(event.target.value === "enabled")}><option value="enabled">开启</option><option value="disabled">关闭</option></select></label>
            <label className="rc-wide-field">指定用户 ID<textarea rows={3} spellCheck={false} value={userIds} onChange={(event) => setUserIds(event.target.value)} placeholder="customer-id-1, customer-id-2" /><small>只接受内部不可变 ID，不接受邮箱、手机号或其他 PII；最多 100 个。</small></label>
            <label className="rc-wide-field">指定组织 ID<textarea rows={3} spellCheck={false} value={organizationIds} onChange={(event) => setOrganizationIds(event.target.value)} placeholder="branch-id-1" /><small>用户或组织命中任一即可通过主体条件；最多 100 个。</small></label>
            <label className="rc-wide-field">指定应用版本<textarea rows={2} spellCheck={false} value={applicationVersions} onChange={(event) => setApplicationVersions(event.target.value)} placeholder="v1.0.0-beta.6" /><small>匹配服务端部署的精确 SemVer；未提供部署版本时不命中。</small></label>
            <label>灰度百分比<input type="number" min={0} max={100} step={1} value={rolloutPercentage} onChange={(event) => setRolloutPercentage(event.target.value)} placeholder="留空表示不限制" /><small>按 flag key + 用户 ID 稳定分桶，不按请求随机。</small></label>
            <label>独立开始时间<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /><small>包含该时刻；按浏览器时区提交明确 offset。</small></label>
            <label>独立结束时间<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /><small>不包含该时刻；必须晚于开始时间。</small></label>
            <p className="rc-muted rc-wide-field">主体（用户/组织任一）与版本、百分比、独立时窗各维度必须同时满足。环境 Gate 始终拥有最终上限。</p>
          </>}
      </> : registeredPrompt ? <PromptConfigurationEditor
        configurationKey={key}
        onKeyChange={setKey}
        instruction={instruction}
        onInstructionChange={setInstruction}
      /> : registeredSkill ? <SkillConfigurationEditor skills={skills} onChange={setSkills} />
      : <label className="rc-wide-field">非秘密 JSON payload<textarea spellCheck={false} rows={9} value={payload} onChange={(event) => setPayload(event.target.value)} /><small>不能保存 secret、password、token、API key、private key 或凭证字段，最大 64 KiB。</small></label>}
      <InlineAuditReasonField id="configuration-draft-reason" value={reason} onChange={setReason} label="草稿创建原因" />
      <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !validKey || !targetingValid || !promptValid || !skillValid || !hasValidAuditReason(reason)} onClick={() => void submit()}>{busy ? "正在创建…" : "直接创建草稿"}</button></div>
    </div>
  </section>;
}
