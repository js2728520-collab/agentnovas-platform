import type { PoolClient } from "pg";

import { ResearchApiError } from "./research-errors.ts";

export type OfficialThreeCardPortfolioScope={strategyIds:[string,string,string];scopeVersion:string;source:"official_three_card_portfolio"};
export type OfficialThreeCardPortfolioScopeResolver=(client:PoolClient,input:{userId:string;weekStart:string;weekEnd:string})=>Promise<OfficialThreeCardPortfolioScope>;

export const unresolvedOfficialThreeCardPortfolioScope:OfficialThreeCardPortfolioScopeResolver=async()=>{
  throw new ResearchApiError("OFFICIAL_PORTFOLIO_SCOPE_NOT_CONFIGURED","官方三卡组合范围解析器尚未接入",503);
};
