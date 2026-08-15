"use client";

import { useRef, useState } from "react";

const plans = [
  { name: "月卡", price: 28, period: "30 天", fee: "20%", credits: 1_000 },
  { name: "季卡", price: 58, period: "90 天", fee: "20%", credits: 3_000 },
  { name: "年卡", price: 198, period: "365 天", fee: "20%", credits: 12_000 },
  { name: "终身会员", price: 588, period: "永久有效", fee: "16%", credits: 36_000 },
];
const topups = [[50, 5_000, ""], [100, 10_500, "赠送 5%"], [250, 27_500, "赠送 10%"], [500, 60_000, "赠送 20%"], [1_000, 130_000, "赠送 30%"]];

export default function MembershipCenter() {
  const [selected, setSelected] = useState("季卡");
  const [network, setNetwork] = useState("TRON (TRC20)");
  const [order, setOrder] = useState(false);
  const [message, setMessage] = useState("");
  const paymentRef = useRef<HTMLElement>(null);
  const price = plans.find((plan) => plan.name === selected)?.price ?? 0;
  const choosePlan = (name: string) => {
    if (name === selected) {
      paymentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setSelected(name);
    setOrder(false);
  };
  return <div className="membership-v2">
    <div className="page-head"><div><h1>会员中心</h1><p>会员权益、AI 积分配额和周盈利分成规则</p></div></div>
    <div className="membership-notice">积分不是现金，也不代表收益承诺。1 积分 = 1,000 tokens 预算单位；实际扣减按模型供应商返回的输入、输出 token 和固定安全开销记录。</div>
    <section className="membership-v2-plans"><header><div><small>MEMBERSHIP PLANS</small><h2>选择会员周期</h2></div></header><div className="membership-plans">{plans.map((plan, index) => <button key={plan.name} className={selected === plan.name ? "active" : ""} onClick={() => choosePlan(plan.name)}>{index === 1 && <em>推荐</em>}<small>{plan.name}</small><h2><i>$</i>{plan.price}<span> USD</span></h2><p>{plan.period}</p><div className="membership-plan-fee">周盈利分成 {plan.fee}</div><div>✓ AI 策略研究与结构化生成</div><div>✓ 真实历史回测与审计记录</div><div>✓ {plan.credits.toLocaleString()} 积分配额</div><b>{selected === plan.name ? "已选择 · 前往支付" : "选择套餐"}</b></button>)}</div></section>
    <section className="credits-panel"><header><div><small>AI CREDIT WALLET</small><h2>积分充值</h2></div><span>当前余额：待账户账本接入</span></header><p>建议按 100 积分 ≈ 1 美元内部 AI 预算估算；充值档位只增加积分赠送，不改变积分现金属性。付款接口接入前不会创建真实订单或扣款。</p><div className="credit-topup-grid">{topups.map(([amount, credits, label]) => <button key={amount} onClick={() => setMessage(`已选择 $${amount} 积分档位：${Number(credits).toLocaleString()} 积分。支付接口接入后才会创建订单。`)}><b>${amount}</b><span>{Number(credits).toLocaleString()} 积分</span><small>{label || "起步档"}</small></button>)}</div>{message && <div className="admin-notice">{message}</div>}<div className="credit-rules"><span><b>对话计量</b>按真实 token 用量扣减</span><span><b>策略生成</b>包含规则校验和结构化输出</span><span><b>用完后</b>需充值或等待会员赠送配额</span><span><b>成本核算</b>以后端账本和供应商账单为准</span></div></section>
    <section className="chain-payment" ref={paymentRef} id="membership-payment"><div className="payment-config"><span>ON-CHAIN PAYMENT</span><h2>链上支付</h2><p>选择与转出平台一致的网络。网络选错可能造成资产无法找回。</p><label>支付资产<select><option>USDT</option><option>USDC</option></select></label><label>支付网络<select value={network} onChange={(event) => { setNetwork(event.target.value); setOrder(false); }}><option>TRON (TRC20)</option><option>Ethereum (ERC20)</option><option>BNB Smart Chain (BEP20)</option></select></label><div className="payment-summary"><span>所选套餐<b>{selected}</b></span><span>应付金额<b>{price} USDT</b></span><span>网络费用<b>由付款钱包收取</b></span></div><button className="primary" onClick={() => setOrder(true)}>生成链上支付订单</button></div><div className={`payment-order ${order ? "ready" : ""}`}>{order ? <><header><span>订单等待付款</span><time>14:59</time></header><div className="qr-demo"><i/><i/><i/><i/><i/><i/><i/><i/><i/></div><small>请支付</small><h2>{price}.00 USDT</h2><p>{network}</p><label>演示收款地址<div>TDemoAddress_Not_For_Payment_8X2K<button type="button" onClick={() => setMessage("演示地址已复制；当前不会产生真实扣款。")}>复制</button></div></label><footer><i/> 正在监听链上确认 · 需要 1 次确认</footer></>: <><div className="empty-order">◎</div><h3>尚未生成支付订单</h3><p>选择套餐和网络后生成订单，此处将显示金额、唯一收款地址、二维码与链上确认状态。</p></>}</div></section>
    <section className="payment-steps"><div><i>01</i><b>创建订单</b><span>锁定套餐、金额和支付网络</span></div><div><i>02</i><b>链上转账</b><span>按订单金额向唯一地址付款</span></div><div><i>03</i><b>等待确认</b><span>后台监听交易哈希与到账金额</span></div><div><i>04</i><b>自动开通</b><span>确认到账后立即激活会员</span></div></section>
  </div>;
}
