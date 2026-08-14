export function splitStrategyPerformanceFee(grossPerformanceFeeUsdt:number,collectionStatus:"confirmed"|"pending"|"failed"|"reversed"="confirmed"){
  const gross=Math.round(grossPerformanceFeeUsdt*1e6)/1e6;
  if(!Number.isFinite(gross)||gross<0)throw new Error("绩效分成金额无效");
  if(collectionStatus!=="confirmed")return{grossPerformanceFeeUsdt:gross,platformFeeUsdt:0,authorAmountUsdt:0,eligibleRevenueUsdt:0};
  const platformFeeUsdt=Math.round(gross*.5*1e6)/1e6;
  return{grossPerformanceFeeUsdt:gross,platformFeeUsdt,authorAmountUsdt:Math.round((gross-platformFeeUsdt)*1e6)/1e6,eligibleRevenueUsdt:platformFeeUsdt};
}
