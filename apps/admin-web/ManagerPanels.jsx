import {useState} from 'react';
import {api,date,explain,Panel,Notice} from '../api-server/mock/web/common.jsx';

export function ManagerLogin({onLogin}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function login(event){
    event.preventDefault();
    const data=new FormData(event.currentTarget);
    setBusy(true);setError('');
    try{await api('/api/v1/manager/login',{username:data.get('username'),password:data.get('password')});await onLogin();}
    catch(error){setError(error.message==='ADMIN_LOGIN_LIMIT'?'잠시 후 다시 시도하세요.':'계정과 비밀번호를 확인하세요.');}
    finally{setBusy(false);}
  }
  return <Panel title="Web Manager 로그인"><form className="line filters" onSubmit={login}>
    <label>계정<input name="username" autoComplete="username" required/></label>
    <label>비밀번호<input name="password" type="password" autoComplete="current-password" required/></label>
    <button className="primary" disabled={busy}>로그인</button>
  </form><Notice>{error}</Notice></Panel>;
}
export function TypeCatalog({state,run,busy}){
  const base=state.policy.policies.find(row=>row.code==='DEFAULT');
  const blank={code:'',name:'',title:'',description:'',enabled:true,retentionDays:base.retention_days,validityDays:base.link_validity_days};
  const [form,setForm]=useState(blank);
  const policyFor=code=>state.policy.policies.find(row=>row.code===code)??base;
  const can=state.user?.role==='SYSTEM';
  function edit(row){
    const policy=policyFor(row.code);
    setForm({...row,retentionDays:policy.retention_days,validityDays:policy.link_validity_days});
  }
  function save(event){
    event.preventDefault();
    run(async()=>{await api('/api/v1/manager/types',{...form,retentionDays:Number(form.retentionDays),validityDays:Number(form.validityDays)});setForm(blank);});
  }
  return <Panel title="문서 종류 관리">
    <ul className="rows">{state.types.map(row=>{const policy=policyFor(row.code);return <li key={row.code}>
      <div><strong>{row.code} · {row.name}</strong><small>{row.title} · {row.enabled?'사용':'중지'} · PDF {policy.retention_days}일 / 링크 {policy.link_validity_days}일</small>
        {row.description&&<small>{row.description}</small>}</div>{can&&<button onClick={()=>edit(row)}>편집</button>}</li>;})}</ul>
    {can&&<form className="line filters" onSubmit={save}>
      {[['code','문서 코드'],['name','문서명'],['title','환자 제목'],['description','설명']].map(([key,label])=><label key={key}>{label}
        <input value={form[key]} maxLength={key==='description'?500:80} required={key!=='description'} pattern={key==='code'?'G[0-9]{3}':undefined}
          onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}
      <label>보관일<input type="number" required min="1" max="90" value={form.retentionDays} onChange={e=>setForm({...form,retentionDays:e.target.value})}/></label>
      <label>링크일<input type="number" required min="1" max={form.retentionDays} value={form.validityDays} onChange={e=>setForm({...form,validityDays:e.target.value})}/></label>
      <label>사용<input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/></label>
      <button disabled={busy} className="primary">문서 종류 저장</button><button type="button" onClick={()=>setForm(blank)}>입력 초기화</button>
    </form>}
  </Panel>;
}
export function ManagerAudit({run,busy}){
  const [record,setRecord]=useState(null),[username,setUser]=useState(''),[role,setRole]=useState('VIEWER');
  const load=()=>run(async()=>setRecord(await api('/api/v1/manager/audit')));
  return <Panel title="관리자 권한 및 감사 기록" action={<button disabled={busy} onClick={load}>조회</button>}>
    {record&&<><form className="line filters" onSubmit={event=>{event.preventDefault();run(async()=>{
      await api('/api/v1/manager/roles',{username,role});setRecord(await api('/api/v1/manager/audit'));
    });}}>
      <label>계정<select required value={username} onChange={e=>setUser(e.target.value)}><option value="">선택</option>
        {record.users.map(user=><option key={user.username} value={user.username}>{user.username} · {user.role}</option>)}</select></label>
      <label>권한<select value={role} onChange={e=>setRole(e.target.value)}>{['SYSTEM','OPERATOR','VIEWER'].map(value=><option key={value}>{value}</option>)}</select></label>
      <button disabled={busy}>권한 변경</button></form>
      <ul className="rows">{record.events.map((entry,index)=><li key={index}>{date(entry.occurred_at)} · {entry.actor} · {entry.event} {entry.subject??''}</li>)}</ul></>}
  </Panel>;
}