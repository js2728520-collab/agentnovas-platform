/**
 * 开通实盘的前置条件。
 *
 * 「能不能给这个客户开实盘」是一个判定，不是一串散落在 API 里的 if。
 * 放在域层的理由是它必须可以被单测穷举——每一条都对应一种把客户真钱置于风险中的
 * 具体方式，而其中大多数不会报错，只会算错。
 *
 * 这不替代任何一道运行时闸门：实盘路由授权（逐交易所灰度）、三维度熔断、对账未决
 * 准入仍然各自在下单路径上生效。这里判的是「这个部署本身能不能存在」。
 */

export type LiveActivationInput = {
  /** 交易所账户当前状态。 */
  account: {
    status: string;
    environment: string;
    exchange: string;
    canTrade: boolean;
    /** 平台永不持有提现权限（INV-11）。这里必须是 false。 */
    withdrawalAuthorized: boolean;
    /** 凭证最近一次校验通过的时间。从未校验为 null。 */
    verifiedAt: string | null;
  };
  /** 客户投入这张策略卡的资金，USDT。 */
  declaredPrincipalUsdt: number;
  /** 交易所账户里实际可用的 USDT。取不到时为 null。 */
  observedBalanceUsdt: number | null;
  /** 会员是否允许新增持仓。 */
  membershipAllowsNewEntries: boolean;
  /** 客户是否已确认实盘风险声明。 */
  riskAcknowledged: boolean;
  /** 该交易所是否已获得实盘路由授权。 */
  liveRoutingGranted: boolean;
  /** 同一张卡上是否还有在跑的模拟部署。 */
  hasActivePaperDeploymentOnCard: boolean;
};

export type LiveActivationBlocker = { code: string; detail: string };

/** 本金下限。低于这个数，交易所的最小下单额会让大部分决策无法执行。 */
export const MIN_LIVE_PRINCIPAL_USDT = 100;

/**
 * 申报本金允许超出实际余额的比例。
 *
 * 设为 0：申报多少就必须有多少。百分比风控（单资产上限、回撤、日亏）全部以本金为
 * 分母，申报得比实际多，等于把所有风控上限按同一个比例放大，而没有任何一步会报错。
 */
const PRINCIPAL_OVER_DECLARATION_TOLERANCE = 0;

export function checkLiveActivation(input: LiveActivationInput): LiveActivationBlocker[] {
  const blockers: LiveActivationBlocker[] = [];
  const { account } = input;

  if (account.status !== "active") {
    blockers.push({ code: "ACCOUNT_NOT_ACTIVE", detail: `交易所账户状态为 ${account.status}` });
  }
  if (account.environment !== "live") {
    // 把 demo 账户挂上实盘部署，客户会以为自己在真实交易，而订单全部落在模拟盘。
    blockers.push({ code: "ACCOUNT_NOT_LIVE_ENVIRONMENT", detail: "该账户是模拟盘账户" });
  }
  if (!account.canTrade) {
    blockers.push({ code: "ACCOUNT_CANNOT_TRADE", detail: "该账户的 API Key 没有交易权限" });
  }
  if (account.withdrawalAuthorized) {
    // INV-11：平台永不持有提现权限。带提现权限的 Key 一旦泄露，损失不是交易亏损，
    // 是本金直接被转走。这条没有例外，也不接受客户授权。
    blockers.push({ code: "ACCOUNT_HAS_WITHDRAWAL_PERMISSION", detail: "该 API Key 带提现权限，必须先在交易所关闭" });
  }
  if (!account.verifiedAt) {
    // 没验过的凭证等于不知道它能不能下单。第一次发现是在真实下单失败的时候。
    blockers.push({ code: "ACCOUNT_NOT_VERIFIED", detail: "该账户的凭证从未校验通过" });
  }

  const principal = Number(input.declaredPrincipalUsdt);
  if (!Number.isFinite(principal) || principal < MIN_LIVE_PRINCIPAL_USDT) {
    blockers.push({
      code: "PRINCIPAL_BELOW_MINIMUM",
      detail: `投入资金需要至少 ${MIN_LIVE_PRINCIPAL_USDT} USDT`,
    });
  } else if (input.observedBalanceUsdt === null) {
    // 读不到余额时不放行。放行意味着用一个无法核对的数字当作所有百分比风控的分母。
    blockers.push({ code: "BALANCE_UNAVAILABLE", detail: "读取不到交易所账户余额，无法核对投入资金" });
  } else if (principal > input.observedBalanceUsdt * (1 + PRINCIPAL_OVER_DECLARATION_TOLERANCE)) {
    blockers.push({
      code: "PRINCIPAL_EXCEEDS_BALANCE",
      detail: `申报投入 ${principal} USDT，账户实际可用 ${input.observedBalanceUsdt} USDT`,
    });
  }

  if (!input.membershipAllowsNewEntries) {
    blockers.push({ code: "MEMBERSHIP_NOT_ACTIVE", detail: "会员状态不允许新增持仓" });
  }
  if (!input.riskAcknowledged) {
    blockers.push({ code: "RISK_NOT_ACKNOWLEDGED", detail: "客户尚未确认实盘风险声明" });
  }
  if (!input.liveRoutingGranted) {
    // 逐交易所灰度。没授权的交易所即使建了部署，订单也会在下发前被拒——
    // 在这里先说清楚，好过让客户建完之后每一轮都失败而看不出原因。
    blockers.push({
      code: "LIVE_ROUTING_NOT_GRANTED",
      detail: `${account.exchange} 尚未获得实盘路由授权`,
    });
  }
  if (input.hasActivePaperDeploymentOnCard) {
    // 同一张卡上两个部署会在同一批 K 线上各自产出决策，客户会看到同一张卡给出两套
    // 互相矛盾的叙述，而「可解释」是这个产品的全部卖点。
    blockers.push({
      code: "PAPER_DEPLOYMENT_STILL_ACTIVE",
      detail: "这张卡上还有在跑的模拟部署，需要先停掉",
    });
  }

  return blockers;
}

export function canActivateLive(input: LiveActivationInput): boolean {
  return checkLiveActivation(input).length === 0;
}
