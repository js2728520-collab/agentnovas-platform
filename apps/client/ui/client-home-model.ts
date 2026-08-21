import type { MembershipEntitlement, MembershipOrderStatus, PaperPortfolio } from "@/packages/contracts/src/commercial-beta";

export type ClientHomeTask = {
  title: string;
  description: string;
  href: string | null;
  action: string | null;
  state: "LOADING" | "ERROR" | "ACTION_REQUIRED" | "IN_REVIEW" | "READY" | "LIMITED_ACCESS";
};

type ClientHomeTaskInput = {
  canViewMembership: boolean;
  membership: MembershipEntitlement | null | undefined;
  membershipError?: string;
  latestOrder: { status: MembershipOrderStatus } | null | undefined;
  latestOrderError?: string;
  canViewPaper: boolean;
  portfolios: Array<Pick<PaperPortfolio, "status">> | undefined;
  portfolioError?: string;
};

export function deriveClientHomeTask(input: ClientHomeTaskInput): ClientHomeTask {
  if (!input.canViewMembership) return {
    title: "当前账户使用受限",
    description: "当前角色没有查看会员与法务状态的权限；工作台只展示已授权模块。",
    href: null,
    action: null,
    state: "LIMITED_ACCESS",
  };
  if (input.membershipError || input.latestOrderError) return {
    title: "会员状态暂时无法核对",
    description: input.membershipError || input.latestOrderError || "会员状态读取失败，请重试。",
    href: "/membership",
    action: "打开会员中心",
    state: "ERROR",
  };
  if (input.membership === undefined || input.latestOrder === undefined) return {
    title: "正在核对账户状态",
    description: "正在分别读取会员权益与最近申请，不会用缓存值代替服务端结果。",
    href: null,
    action: null,
    state: "LOADING",
  };
  if (!input.membership) {
    if (!input.latestOrder) return {
      title: "选择会员计划",
      description: "当前法务版本已确认，但没有有效会员或待处理申请。可在会员中心选择计划并提交人工付款申请。",
      href: "/membership",
      action: "进入会员中心",
      state: "ACTION_REQUIRED",
    };
    if (input.latestOrder.status === "SUBMITTED") return {
      title: "会员申请正在人工复核",
      description: "付款凭证已进入运营审核；该状态不代表付款确认或会员激活，请等待双人复核结果。",
      href: "/membership/orders",
      action: "查看申请记录",
      state: "IN_REVIEW",
    };
    if (input.latestOrder.status === "AWAITING_EVIDENCE") return {
      title: "会员申请等待凭证记录",
      description: "订单已创建，但尚未由运营人员记录外部付款凭证；系统没有自动扣款或生成链上地址。",
      href: "/membership/orders",
      action: "查看申请记录",
      state: "ACTION_REQUIRED",
    };
    if (input.latestOrder.status === "ACTIVATED") return {
      title: "会员权益正在同步",
      description: "最近申请已通过激活，但当前权益尚未返回；请刷新状态，持续异常时联系支持团队。",
      href: "/membership",
      action: "核对会员状态",
      state: "IN_REVIEW",
    };
    return {
      title: "重新核对会员申请",
      description: `最近申请状态为 ${input.latestOrder.status}，没有有效会员权益；请阅读原因后再决定是否重新申请。`,
      href: "/membership/orders",
      action: "查看申请记录",
      state: "ACTION_REQUIRED",
    };
  }
  if (["READ_ONLY", "EXPIRED", "CANCELLED"].includes(input.membership.status)) return {
    title: "会员当前为只读或已到期",
    description: "系统不会再启动新的模拟开仓。可查看历史记录，并在会员中心核对续费或到期边界。",
    href: "/membership",
    action: "查看会员状态",
    state: "ACTION_REQUIRED",
  };
  if (!input.canViewPaper) return {
    title: "会员权益已生效",
    description: "当前角色没有模拟组合查看权限；工作台不会请求或展示组合数据。",
    href: "/membership",
    action: "查看会员权益",
    state: "LIMITED_ACCESS",
  };
  if (input.portfolioError) return {
    title: "模拟组合暂时无法核对",
    description: input.portfolioError,
    href: "/paper",
    action: "打开模拟组合",
    state: "ERROR",
  };
  if (input.portfolios === undefined) return {
    title: "正在核对模拟组合",
    description: "会员权益已读取，正在从服务端确认三张官方 paper 组合。",
    href: null,
    action: null,
    state: "LOADING",
  };
  if (input.portfolios.length !== 3) return {
    title: "官方模拟组合尚未完整初始化",
    description: `服务端当前返回 ${input.portfolios.length} / 3 张组合。组合不完整时不会补写收益或使用占位数据。`,
    href: "/paper",
    action: "核对模拟组合",
    state: "IN_REVIEW",
  };
  const activeCount = input.portfolios.filter((portfolio) => portfolio.status === "ACTIVE").length;
  const restrictedCount = input.portfolios.length - activeCount;
  return {
    title: "查看三卡模拟执行证据",
    description: `${activeCount} 张允许新开仓 · ${restrictedCount} 张只读或仅平仓。该状态是账户权限边界，不代表 Worker 正在运行。`,
    href: "/trading-hall",
    action: "进入交易大厅",
    state: "READY",
  };
}
