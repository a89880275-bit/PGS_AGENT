import { useEffect,useState } from 'react';
import { api,date,Panel,Notice } from '../api-server/mock/web/common.jsx';

export function PolicySettings({state,run,busy,byType}) {
  const options=byType?state.types:[{code:'DEFAULT',name:'시스템 기본값'}];
  const [code,setCode]=useState(options[0].code);
  const selected=options.some(type=>type.code===code)?code:options[0].code;
  const policy=state.policy.policies.find(entry=>entry.code===selected)??state.policy.policies.find(entry=>entry.code==='DEFAULT');
  const [retention,setRetention]=useState(policy.retention_days);
  const [validity,setValidity]=useState(policy.link_validity_days);
  const [notice,setNotice]=useState('');
  useEffect(()=>{
    setRetention(policy.retention_days);
    setValidity(policy.link_validity_days);
    setNotice('');
  },[selected,policy.retention_days,policy.link_validity_days]);
  function save(event){
    event.preventDefault();
    run(async()=>{
      await api('/mock/policy',{code:selected,retentionDays:Number(retention),validityDays:Number(validity)});
      setNotice('정책을 저장했습니다. 이후 새로 등록하는 문서에 적용됩니다.');
    });
  }
  const rows=state.policy.history.filter(row=>byType?row.code!=='DEFAULT':row.code==='DEFAULT');
  return <Panel title={byType?'문서 종류별 보관 정책':'기본 보관 정책'} action={<span className="chip">최대 90일</span>}>
    <p>기간은 1~90일입니다. 링크 기간은 PDF 보관기간 이내여야 합니다. 이미 등록한 문서의 기한은 유지됩니다.</p>
    <form onSubmit={save} className="line filters">
      {byType&&<label>안내문 종류<select value={selected} onChange={event=>setCode(event.target.value)}>{options.map(type=><option key={type.code} value={type.code}>{type.name}</option>)}</select></label>}
      <label>PDF 보관일<input type="number" min="1" max="90" required value={retention} onChange={event=>setRetention(event.target.value)}/></label>
      <label>링크 유효일<input type="number" min="1" max={retention||90} required value={validity} onChange={event=>setValidity(event.target.value)}/></label>
      <button className="primary" disabled={busy||Boolean(state.user&&state.user.role!=='SYSTEM')}>정책 저장</button>
    </form>
    <Notice>{notice}</Notice>
    <h3>변경 이력</h3>
    {rows.length?<ul className="rows">{rows.map(row=><li key={row.id}><div><strong>{row.code} · {row.new_retention}일 / {row.new_validity}일</strong>
      <small>이전 {row.old_retention??'기본값'} / {row.old_validity??'기본값'} · {row.actor}</small></div><time>{date(row.changed_at)}</time></li>)}</ul>:<p>정책 변경 이력이 없습니다.</p>}
  </Panel>;
}
