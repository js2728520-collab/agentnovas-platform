"use client";

import { useEffect, useState } from "react";

type PublicConfig = {
  providerName: string;
  baseUrl: string;
  model: string;
  maskedApiKey: string;
  hasApiKey: boolean;
  enabled: boolean;
  updatedAt?: string | null;
};

type FormState = PublicConfig & { apiKey: string };

const emptyForm: FormState = {
  providerName: "Custom OpenAI Compatible",
  baseUrl: "",
  model: "",
  apiKey: "",
  maskedApiKey: "",
  hasApiKey: false,
  enabled: true,
};

const presets = [
  { name: "Custom OpenAI Compatible", url: "", model: "" },
  { name: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  { name: "DeepSeek", url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "Qwen", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { name: "Gemini OpenAI Compatible", url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" },
];

function useChinese(){
  const [chinese,setChinese]=useState(false);
  useEffect(()=>{
    const sync=()=>setChinese(document.documentElement.lang.startsWith("zh"));
    sync();
    const observer=new MutationObserver(sync);
    observer.observe(document.documentElement,{attributes:true,attributeFilter:["lang"]});
    return()=>observer.disconnect();
  },[]);
  return chinese;
}

function ConfigForm({endpoint,admin,onClose}:{endpoint:string;admin:boolean;onClose?:()=>void}){
  const zh=useChinese();
  const [form,setForm]=useState<FormState>(emptyForm);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState("");

  useEffect(()=>{
    let active=true;
    setLoading(true);
    fetch(endpoint,{cache:"no-store"}).then(async response=>{
      const payload=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(payload.error||payload.message||(response.status===401?(zh?"请先登录":"Please sign in"):(zh?"读取配置失败":"Unable to load configuration")));
      if(active&&payload.config)setForm({...emptyForm,...payload.config,apiKey:""});
    }).catch(error=>active&&setMessage(error.message)).finally(()=>active&&setLoading(false));
    return()=>{active=false};
  },[endpoint,zh]);

  const choosePreset=(name:string)=>{
    const preset=presets.find(item=>item.name===name)||presets[0];
    setForm(current=>({...current,providerName:preset.name,baseUrl:preset.url,model:preset.model||current.model}));
  };

  const save=async()=>{
    setSaving(true);setMessage("");
    try{
      const response=await fetch(endpoint,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({providerName:form.providerName,baseUrl:form.baseUrl,model:form.model,apiKey:form.apiKey||undefined,enabled:form.enabled})});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload.error||payload.message||(zh?"保存失败":"Save failed"));
      setForm(current=>({...current,...payload.config,apiKey:""}));
      setMessage(zh?"保存成功，密钥已加密存储。":"Saved. The API key is encrypted at rest.");
    }catch(error){setMessage(error instanceof Error?error.message:String(error))}finally{setSaving(false)}
  };

  return <div className={`llm-config-form ${admin?"is-admin":"is-user"}`}>
    <div className="llm-config-copy">
      <span className="eyebrow">{admin?"SYSTEM LLM GATEWAY":"PERSONAL LLM CONNECTION"}</span>
      <h3>{admin?(zh?"系统默认大模型接口":"System default LLM API"):(zh?"自定义 API 接口":"Custom API connection")}</h3>
      <p>{admin
        ?(zh?"供平台策略助手与 Agent 工作流调用。用户自己的接口不会覆盖此系统配置。":"Used by platform strategy assistants and Agent workflows. Personal connections never overwrite this system configuration.")
        :(zh?"绑定你自己的兼容大模型接口，用于本人在策略创建页中的 AI 对话与策略生成；不会提供给其他用户，也不会替换平台系统接口。":"Connect your own compatible LLM for your private strategy conversations and generation. It is never shared with other users or used as the platform system connection.")}</p>
    </div>
    {loading?<div className="llm-loading">{zh?"正在读取配置…":"Loading configuration…"}</div>:<>
      <div className="llm-config-grid">
        <label><span>{zh?"供应商预设":"Provider preset"}</span><select value={form.providerName} onChange={event=>choosePreset(event.target.value)}>{presets.map(item=><option key={item.name}>{item.name}</option>)}</select></label>
        <label><span>{zh?"模型名称":"Model"}</span><input value={form.model} onChange={event=>setForm({...form,model:event.target.value})} placeholder="gpt-4.1-mini"/></label>
        <label className="llm-wide"><span>{zh?"接口基础地址":"Base URL"}</span><input value={form.baseUrl} onChange={event=>setForm({...form,baseUrl:event.target.value})} placeholder="https://api.example.com/v1"/></label>
        <label className="llm-wide"><span>API Key</span><input type="password" value={form.apiKey} onChange={event=>setForm({...form,apiKey:event.target.value})} placeholder={form.hasApiKey?(zh?`已保存 ${form.maskedApiKey}；留空则不更换`:`Saved ${form.maskedApiKey}; leave blank to keep`):(zh?"输入服务商提供的 API Key":"Enter the API key from your provider")}/></label>
      </div>
      <div className="llm-config-footer">
        <label className="llm-enable"><input type="checkbox" checked={form.enabled} onChange={event=>setForm({...form,enabled:event.target.checked})}/><span>{zh?"启用此接口":"Enable this connection"}</span></label>
        <div className="llm-actions">{onClose&&<button className="soft" onClick={onClose}>{zh?"取消":"Cancel"}</button>}<button className="primary" onClick={save} disabled={saving}>{saving?(zh?"保存中…":"Saving…"):(zh?"保存接口":"Save connection")}</button></div>
      </div>
      {message&&<div className="llm-message">{message}</div>}
      <div className="llm-help"><b>{zh?"使用方法":"How to use"}</b><span>{zh?"先在模型服务商创建 Key，选择预设或填写兼容 OpenAI 的基础地址与模型名称，保存后即可在策略创建页选择此连接。密钥不会回显。":"Create a key with your model provider, choose a preset or enter an OpenAI-compatible base URL and model, then save. The key is never displayed again."}</span></div>
    </>}
  </div>
}

export function SystemLlmConfigPanel(){return <section className="llm-config-panel"><ConfigForm endpoint="/api/admin/llm-config" admin/></section>}

export function CustomLlmButton(){
  const [open,setOpen]=useState(false);
  const zh=useChinese();
  return <><button className="llm-custom-button" onClick={()=>setOpen(true)}>{zh?"自定义API接口":"Custom API"}</button>{open&&<div className="dialog-backdrop" role="presentation" onMouseDown={event=>{if(event.currentTarget===event.target)setOpen(false)}}><div className="dialog-card llm-dialog" role="dialog" aria-modal="true"><button className="dialog-close" aria-label="Close" onClick={()=>setOpen(false)}>×</button><ConfigForm endpoint="/api/account/llm-config" admin={false} onClose={()=>setOpen(false)}/></div></div>}</>
}
