"use client";

import { useState } from "react";

import {
  agentRolesForSkills,
  forbiddenInstructionReasons,
  instructionLengthState,
  promptRoleGroups,
  promptSafetyEnvelope,
  promptSkillLimits,
} from "./prompt-skill-ui";

type SkillDraft = {
  name: string;
  description: string;
  instruction: string;
  agentRoles: string[];
  enabled: boolean;
};

export const emptySkill = (): SkillDraft => ({
  name: "", description: "", instruction: "", agentRoles: [], enabled: true,
});

function LengthHint({ value }: { value: string }) {
  const state = instructionLengthState(value);
  const problem = state.tooShort ? `至少 ${promptSkillLimits.instructionMin} 个字符`
    : state.tooLong ? `超出 ${promptSkillLimits.instructionMax} 个字符上限`
    : state.tooManyBytes ? `超出 ${promptSkillLimits.instructionMaxBytes} 字节上限` : null;
  return <small data-invalid={problem ? "true" : undefined}>
    {state.characters} 字符 · {state.bytes} 字节{problem ? ` · ${problem}` : ""}
  </small>;
}

/** 展示配置改不动的那部分（PS-03）。运维要能看见边界在哪，才不会试图用 payload 覆盖它。 */
function SafetyEnvelope({ family }: { family: "research" | "runtime" }) {
  return <div className="rc-callout rc-wide-field">
    <b>以下内容由代码固定，配置无法覆盖</b>
    <ul>{promptSafetyEnvelope[family].map((line) => <li key={line}>{line}</li>)}</ul>
    <p className="rc-muted">
      你编辑的只是角色职责那一段。安全包络不在 payload 里，因此审批也无法放行一份删掉它的
      Prompt——审批管不住运行时行为。
    </p>
  </div>;
}

export function PromptConfigurationEditor({ configurationKey, onKeyChange, instruction, onInstructionChange }: {
  configurationKey: string;
  onKeyChange: (key: string) => void;
  instruction: string;
  onInstructionChange: (value: string) => void;
}) {
  const family = configurationKey.startsWith("runtime.") ? "runtime" : "research";
  return <>
    {/* key 用下拉而不是自由输入：拼错的 key 会创建一份没有任何消费者的配置，
        而它照样能走完审批与激活，看起来像生效了。 */}
    <label>Prompt 角色
      <select value={configurationKey} onChange={(event) => onKeyChange(event.target.value)}>
        {promptRoleGroups.map((entry) => <optgroup key={entry.group} label={entry.group}>
          {entry.roles.map(([role, label]) => <option key={role} value={`${entry.keyPrefix}.${role}`}>
            {label}（{entry.keyPrefix}.{role}）
          </option>)}
        </optgroup>)}
      </select>
      <small>只能选已登记的 10 个角色；Client 通用 AI 助手 Prompt 不在首期范围内。</small>
    </label>
    <label className="rc-wide-field">角色职责指令
      <textarea
        spellCheck={false}
        rows={8}
        value={instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
        placeholder="描述这个角色负责解释或产出什么，不要写安全约束——那部分由代码固定。"
      />
      <LengthHint value={instruction} />
    </label>
    <SafetyEnvelope family={family} />
    <div className="rc-callout rc-wide-field">
      <b>以下写法会被直接拒绝</b>
      <ul>{forbiddenInstructionReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <p className="rc-muted">服务端判定为准；这里只是提前告知，浏览器的检查不算数。</p>
    </div>
  </>;
}

export function SkillConfigurationEditor({ skills, onChange }: {
  skills: SkillDraft[];
  onChange: (skills: SkillDraft[]) => void;
}) {
  const [expanded, setExpanded] = useState(0);
  const update = (index: number, patch: Partial<SkillDraft>) =>
    onChange(skills.map((skill, position) => position === index ? { ...skill, ...patch } : skill));
  const toggleRole = (index: number, role: string) => {
    const current = skills[index].agentRoles;
    update(index, {
      agentRoles: current.includes(role) ? current.filter((item) => item !== role) : [...current, role],
    });
  };

  return <>
    {/* Skill 已有合同与确定性测试器，但没有任何 Agent 会加载技能包。不说清楚，
        运维激活之后会理所当然地认为它生效了（框架规则：active ≠ 业务已生效）。 */}
    <div className="rc-callout rc-callout-warning rc-wide-field">
      <b>Skill 尚无运行时消费者</b>
      <p>
        合同与确定性测试器已就位，但目前没有任何 Agent 会加载技能包。
        把某个版本激活<strong>不代表它已经生效</strong>。
      </p>
    </div>
    <div className="rc-wide-field">
      {skills.map((skill, index) => <fieldset key={index} className="rc-subpanel">
        <legend>
          <button type="button" className="rc-link" onClick={() => setExpanded(expanded === index ? -1 : index)}>
            {skill.name.trim() || `技能 ${index + 1}`}
          </button>
          {!skill.enabled && <span className="rc-status">已归档</span>}
        </legend>
        {expanded === index && <div className="rc-form rc-form-grid">
          <label>名称
            <input maxLength={promptSkillLimits.skillNameMax} value={skill.name}
              onChange={(event) => update(index, { name: event.target.value })} />
          </label>
          <label>用途说明
            <input maxLength={promptSkillLimits.skillDescriptionMax} value={skill.description}
              onChange={(event) => update(index, { description: event.target.value })} />
          </label>
          <label className="rc-wide-field">技能指令
            <textarea spellCheck={false} rows={5} value={skill.instruction}
              onChange={(event) => update(index, { instruction: event.target.value })} />
            <LengthHint value={skill.instruction} />
          </label>
          <div className="rc-wide-field">
            <span>适用角色</span>
            <div className="rc-chip-row">
              {agentRolesForSkills.map((role) => <label key={role} className="rc-chip">
                <input type="checkbox" checked={skill.agentRoles.includes(role)}
                  onChange={() => toggleRole(index, role)} />
                {role}
              </label>)}
            </div>
          </div>
          {/* PS-06：停用是逻辑归档，不是删除。物理删除会让历史任务无法解释自己当时
              用了什么，与已确认的版本历史要求冲突。 */}
          <label>状态
            <select value={skill.enabled ? "enabled" : "archived"}
              onChange={(event) => update(index, { enabled: event.target.value === "enabled" })}>
              <option value="enabled">启用</option>
              <option value="archived">归档（停用，不删除）</option>
            </select>
            <small>归档只阻止新任务选用；条目本身保留，历史任务仍能说清自己用了什么。</small>
          </label>
        </div>}
      </fieldset>)}
      <div className="rc-action-row">
        <button type="button" disabled={skills.length >= promptSkillLimits.maxSkills}
          onClick={() => { onChange([...skills, emptySkill()]); setExpanded(skills.length); }}>
          添加技能（{skills.length}/{promptSkillLimits.maxSkills}）
        </button>
      </div>
      <p className="rc-muted">
        v1 声明式技能包只有名称、说明、指令、适用角色和启用状态五个字段。
        <strong>没有 code、command、url、permissions、tools、secrets</strong>——
        不是暂时不做，而是一旦允许就把代码执行、供应链和凭证攻击面引进来。
      </p>
    </div>
  </>;
}

export type { SkillDraft };
