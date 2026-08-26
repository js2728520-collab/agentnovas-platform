/**
 * 跟单准入策略。
 *
 * 平台永不持有客户交易所账户的提现权限。跟单只需要读 + 交易权限；绩效分成从
 * 客户预充的服务余额扣除，走优盾充值 + ledger + performance_fee_receivables +
 * maker/checker 复核路径，不从交易所账户直接划走。
 *
 * 此前的设计相反：要求客户开通提现授权才能跟单，以便自动扣费。提现权限是交易所
 * API 密钥的最高权限，为 N 个客户保管这样的密钥意味着执行主机一旦失陷，全部客户
 * 资金可被直接转出。用灾难级风险换收款便利不成立，何况收款路径本就已经建好。
 *
 * 数据库层面由 exchange_accounts_no_withdrawal_authority 约束兜底（迁移 0045）。
 */

export type FollowPolicyInput = {
  /** 交易所账户是否被登记为持有提现权限。必须为 false，否则拒绝跟单。 */
  withdrawalAuthorized: boolean;
  /** 账户是否具备下单权限。跟单必需。 */
  canTrade?: boolean;
  publicationMode?: "marketplace" | "self_use" | string | null;
  strategyAuthorId?: string | null;
  customerId?: string | null;
};

export type FollowPolicyDecision = {
  allowed: boolean;
  /** 恒为 true：分成一律走应收 + 复核，平台不具备自动划扣能力。 */
  manualCollectionRequired: boolean;
  reason:
    | "withdrawal_authority_forbidden"
    | "trade_permission_required"
    | "private_self_use"
    | "prepaid_balance_collection";
};

export function evaluateFollowPolicy(input: FollowPolicyInput): FollowPolicyDecision {
  // 带提现权限的账户一律拒绝，先于任何豁免路径判断——自用策略也不例外，
  // 否则就留下了一条「平台持有提现密钥」的合法入口。
  if (input.withdrawalAuthorized) {
    return {
      allowed: false,
      manualCollectionRequired: true,
      reason: "withdrawal_authority_forbidden",
    };
  }

  const isPrivateSelfUse = input.publicationMode === "self_use"
    && Boolean(input.strategyAuthorId)
    && input.strategyAuthorId === input.customerId;

  // 自用策略跑在作者自己的账户上，仍然需要下单权限。
  if (input.canTrade === false) {
    return {
      allowed: false,
      manualCollectionRequired: true,
      reason: "trade_permission_required",
    };
  }

  if (isPrivateSelfUse) {
    return { allowed: true, manualCollectionRequired: true, reason: "private_self_use" };
  }

  return { allowed: true, manualCollectionRequired: true, reason: "prepaid_balance_collection" };
}
