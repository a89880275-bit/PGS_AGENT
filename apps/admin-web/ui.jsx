import { PolicySettings } from './policy.jsx';
import { TypeCatalog,ManagerAudit } from './ManagerPanels.jsx';
import { useEffect, useState } from 'react';
import { api, agentApi, date, kstDay, explain, Badge, Notice, Panel, PdfViewer, statusLabel } from '../api-server/mock/web/common.jsx';

export function Admin({tab,state,reload,run,busy}) {
  const [from,setFrom] = useState('');
  const [to,setTo] = useState('');
  const [type,setType] = useState('');
  const [status,setStatus] = useState('');
  const [query,setQuery] = useState('');
  const [patient,setPatient] = useState('');
  const [matched,setMatched] = useState(null);
  const [preview,setPreview] = useState('');
  const [confirm,setConfirm] = useState(null);
  const [info,setInfo] = useState('');
  const [shownLink,setShownLink] = useState(null);
  const [agentFilter,setAgentFilter]=useState('');
  const managed=state.profile?.managed;
  const writable=!managed||state.user?.role!=='VIEWER';
  const metrics=state.dashboard?.totals;
  const [page,setPage]=useState(0);
  const [results,setResults]=useState(null);
  const [searchError,setSearchError]=useState('');
  const queryString=new URLSearchParams({from,to,type,status,document:query.trim(),agent:agentFilter,page}).toString();
  useEffect(()=>{
    if(!managed||tab!=='documents')return;
    let current=true;
    setResults(null);
    setSearchError('');
    const timer=setTimeout(async()=>{
      try{
        const data=await api('/api/v1/manager/documents?'+queryString);
        if(current)setResults(data);
      }catch(error){if(current)setSearchError(explain(error));}
    },170);
    return ()=>{current=false;clearTimeout(timer);};
  },[managed,tab,queryString,state]);
  const docs=managed&&tab==='documents'?(results?.documents??[]):state.documents;
  const patientDigits = state.patientDigits ?? 8;
  const phase3=state.profile?.mode==='phase3';
  const count = status => docs.filter(doc => doc.status === status).length;
  const failures = state.requests.filter(item => ['FAILED','RETRY_WAIT'].includes(item.status));
  const due = docs.filter(doc => doc.status !== 'DELETED' && Date.parse(doc.deleteAt ?? doc.expiresAt) <= Date.now());
  const selected = docs.find(doc => doc.id === preview && doc.status !== 'DELETED');
  const visible = managed?docs:docs.filter(doc => (!from || kstDay(doc.registeredAt) >= from) &&
    (!to || kstDay(doc.registeredAt) <= to) && (!type || doc.type === type) && (!status || doc.status === status) &&
    (!matched || matched.includes(doc.id)) && (managed?doc.id:doc.requestId).toLowerCase().includes(query.toLowerCase())&&(!agentFilter||agentFilter===doc.agentId));
  async function copy(link) {
    setInfo('');
    try { await navigator.clipboard.writeText(new URL(link,location.origin).href); setInfo('링크를 복사했습니다.'); }
    catch { setInfo('자동 복사를 사용할 수 없습니다. 링크 열기 메뉴를 이용해 주세요.'); }
  }
  async function privateLink(id,operation) {
    const result=await api('/api/v1/documents/'+id+'/'+operation,{});
    return operation==='revoke'?result:agentApi('/mock/link',result);
  }
  async function copyPrivate(id) {
    await run(async()=>copy((await privateLink(id,'link')).viewUrl));
  }
  async function showPrivate(id) {
    await run(async()=>setShownLink({id,url:(await privateLink(id,'link')).viewUrl}));
  }
  async function apply() {
    await run(async () => {
      if (phase3) await privateLink(confirm.id,confirm.action==='replace'?'reissue':'revoke');
      else await api('/mock/documents/' + confirm.id + '/' + confirm.action, {});
      setShownLink(null);
      setInfo(confirm.action === 'replace' ? '링크를 교체했습니다. 기존 만료 시각은 유지됩니다.' : '링크 접근을 차단했습니다.');
      setConfirm(null);
    });
  }
  return <>
    {tab === 'home' && <>
      <section className="hero"><div><p className="eyebrow">안내문 운영 현황</p><h2>등록부터 만료까지</h2><p>합성 안내문의 보관 상태와 전송 오류를 확인합니다.</p>{state.agent && <p>Agent {state.agent.online?'연결됨':'오프라인'} · 최근 통신 {date(state.agent.lastSeenAt)}</p>}</div><div className="connection"><span>문서별 확정 보관 정책</span></div></section>
      <div className="metrics">{(metrics?[['활성 문서',metrics.active],['금일 등록',metrics.today],['7일 내 만료',metrics.expiring],['만료',metrics.expired],['폐기',metrics.revoked],['등록 대기',metrics.pending],['등록·삭제 오류',metrics.failed]]:[['등록',docs.length],['보관',count('ACTIVE')],['만료',count('EXPIRED')],['삭제',count('DELETED')]]).map(([label,n]) => <article key={label}><span>{label}</span><strong>{n}<small>건</small></strong></article>)}</div>
      {managed&&<><Panel title="문서 종류별 등록"><ul className="rows">{state.dashboard.byType.map(row=><li key={row.code}>{row.code} · {row.total}건</li>)}</ul></Panel>
      <Panel title="최근 14일 등록 추이"><ul className="rows">{state.dashboard.daily.map(row=><li key={row.day}>{row.day} · {row.total}건</li>)}</ul></Panel></>}
      <Panel title="전송 실패 현황" action={<button onClick={reload}>새로고침</button>}>
        {managed?<p>외부 카탈로그 실패 {metrics.failed}건 · 로컬 인수 오류는 Agent에서 확인</p>:failures.length ? <ul className="rows">{failures.map(item => <li key={item.id}><div><strong>{explain(item.error)}</strong><small>{item.id}</small></div><Badge status={item.status}/></li>)}</ul> : <p>현재 확인할 전송 오류가 없습니다.</p>}
      </Panel>
    </>}
    {tab === 'documents' && <Panel title="안내문 목록" action={<button onClick={reload}>새로고침</button>}>
      <div className="filters">
        <label>등록 시작일<input type="date" value={from} onChange={e => {setPage(0);setFrom(e.target.value);}}/></label>
        <label>등록 종료일<input type="date" value={to} onChange={e => {setPage(0);setTo(e.target.value);}}/></label>
        <label>종류<select value={type} onChange={e => {setPage(0);setType(e.target.value);}}><option value="">전체</option>{state.types.map(type => <option key={type.code} value={type.code}>{type.name}</option>)}</select></label>
        <label>상태<select value={status} onChange={e => {setPage(0);setStatus(e.target.value);}}><option value="">전체</option>{['ACTIVE','EXPIRED','REVOKED','DELETED'].map(value => <option key={value} value={value}>{statusLabel[value]}</option>)}</select></label>
        <label>{managed?'문서 UUID':'요청 ID'}<input value={query} onChange={e => {setPage(0);setQuery(e.target.value);}}/></label>
        {managed&&<label>Agent<select value={agentFilter} onChange={e=>{setPage(0);setAgentFilter(e.target.value);}}><option value="">전체</option><option value={state.agent.id}>{state.agent.id}</option></select></label>}
      </div>
      {!managed&&<form className="line filters" onSubmit={e => { e.preventDefault(); run(async () => setMatched((await api('/mock/search', { patientNo:patient })).ids)); }}>
        <label>합성 환자번호<input type="text" inputMode="numeric" value={patient} onChange={e => {setPatient(e.target.value); setMatched(null);}} required pattern={'[0-9]{'+patientDigits+'}'} maxLength={patientDigits}/></label>
        <button disabled={busy}>환자번호 검색</button><button type="button" onClick={() => {setPatient('');setMatched(null);}}>검색 해제</button>
      </form>}
      <Notice>{info}</Notice>
      <div className="table-wrap"><table><thead><tr>{(managed?['문서 UUID','종류 · 크기 · Agent','등록 · 만료 (KST)','상태','작업']:['문서 · 요청 ID','환자번호','등록 · 만료 (KST)','상태','작업']).map(label => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{visible.map(doc => <tr key={doc.id}><td><strong>{doc.name}</strong><small title={managed?doc.id:doc.requestId}>{managed?doc.id:doc.requestId}</small></td>
      <td>{managed?<>{doc.type} · {doc.size} B<small>{doc.agentId}</small></>:doc.patientNo}</td><td>{date(doc.registeredAt)}<small>링크 {date(doc.expiresAt)}</small>{doc.deleteAt && <small>삭제 {date(doc.deleteAt)}</small>}</td><td><Badge status={doc.status}/>{state.profile && <small>{doc.available?'조회 가능':'조회 불가'}</small>}{phase3 && <small>{doc.urlReady?'보안 링크 발급됨':'발급 링크 없음'}</small>}</td>
      <td><div className="line actions"><button disabled={!writable||doc.status === 'DELETED'} onClick={() => setPreview(doc.id)}>미리보기</button>
      {doc.viewUrl && <a className="button" href={doc.viewUrl} target="_blank" rel="noreferrer">링크 열기</a>}
      {phase3&&doc.urlReady&&<button disabled={!writable||busy} onClick={()=>showPrivate(doc.id)}>링크 확인</button>}
      <button disabled={!writable||doc.status !== 'ACTIVE' || busy || !(phase3?doc.urlReady:doc.viewUrl)} onClick={() => phase3?copyPrivate(doc.id):copy(doc.viewUrl)}>복사</button>
      <button disabled={!writable||doc.status !== 'ACTIVE' || busy} onClick={() => setConfirm({id:doc.id,action:'replace'})}>교체</button>
      <button disabled={!writable||doc.status !== 'ACTIVE' || busy} onClick={() => setConfirm({id:doc.id,action:'revoke'})}>차단</button></div></td></tr>)}</tbody></table>
      {searchError&&<Notice>{searchError}</Notice>}
      {managed&&!results&&!searchError&&<p role="status">안내문 목록을 불러오는 중…</p>}
      {!visible.length&&(!managed||results)&&<p>조건에 맞는 안내문이 없습니다.</p>}</div>
      {managed&&<div className="line"><button disabled={!page} onClick={()=>setPage(page-1)}>이전</button>
        <span>{page+1} 페이지</span><button disabled={!results?.more} onClick={()=>setPage(page+1)}>다음</button></div>}
    </Panel>}
    {tab==='documents'&&shownLink&&docs.some(doc=>doc.id===shownLink.id&&doc.urlReady)&&
      <Panel title="발급 링크" action={<button onClick={()=>setShownLink(null)}>닫기</button>}>
        <a href={shownLink.url} target="_blank" rel="noreferrer">보안 링크 열기</a>
      </Panel>}
    {tab === 'documents' && confirm && <Panel title={confirm.action === 'replace' ? '링크 교체 확인' : '링크 차단 확인'}>
      <p>기존 링크와 환자 확인 세션이 즉시 종료됩니다.</p><div className="line"><button className="primary" disabled={busy} onClick={apply}>확인</button><button onClick={() => setConfirm(null)}>취소</button></div>
    </Panel>}
    {tab === 'documents' && selected && <Panel title={selected.name + ' 미리보기'} action={<button onClick={() => setPreview('')}>닫기</button>}><PdfViewer url={'/mock/documents/' + selected.id + '/pdf'}/></Panel>}
    {tab === 'manual' && <Panel title="내부 Agent 수동 등록">{state.profile?.delphi ? <><p>등록은 Delphi가 내부 API로 요청합니다.</p><a className="button primary" href="/agent#history">Delphi 연동 요청내역</a></> : <><p>파일명과 환자정보 일치 검사를 위해 내부 Agent에서 등록하세요.</p><a className="button primary" href="/agent#manual">Agent 수동등록 열기</a></>}</Panel>}
    {tab === 'types' && managed && <TypeCatalog state={state} run={run} busy={busy}/>}
    {tab === 'types' && !managed && state.policy && <PolicySettings key='type' state={state} run={run} busy={busy} byType/>}
    {tab === 'types' && !state.policy && <Panel title="합성 안내문 종류" action={<button disabled>종류 편집 · 운영 승인 필요</button>}><ul className="rows">{state.types.map(type => <li key={type.code}><div><strong>{type.name}</strong><small>{type.code} · 다운로드 가능</small></div><span className="chip">문서별 보관 정책</span></li>)}</ul></Panel>}
    {tab === 'api' && <Panel title="API 연동 현황" action={<button onClick={reload}>새로고침</button>}><dl className="facts"><div><dt>시연 클라이언트</dt><dd>내부 Agent Mock</dd></div><div><dt>요청 조회 API</dt><dd>{state.settings?.api ?? "/api/v1/requests"}/:requestId</dd></div><div><dt>처리 오류</dt><dd>{failures.length}건</dd></div></dl><button disabled>클라이언트 발급 · 운영 승인 필요</button></Panel>}
    {tab === 'deletion' && <Panel title="삭제 관리" action={<span className="chip">문서별 확정 삭제 시각</span>}><p>삭제 대기 {due.length}건 · 처리 완료 {count('DELETED')}건</p>
      <button className="primary" disabled={!writable||busy || (!state.profile && !due.length)} onClick={() => run(async () => {const result = await agentApi('/mock/purge', state.profile?.delphi ? await api('/api/v1/agent/maintenance-grant',{}) : {}); setInfo('삭제 처리 ' + result.deleted + '건');})}>만료 합성 PDF 삭제</button>
      <Notice>{info}</Notice><ul className="rows">{due.map(doc => <li key={doc.id}><div><strong>{doc.name}</strong><small>링크 {date(doc.expiresAt)}</small>{doc.deleteAt && <small>삭제 {date(doc.deleteAt)}</small>}</div><Badge status={doc.status}/></li>)}</ul>
      <button disabled>삭제 실패 재처리 · 저장소 연동 후 사용</button></Panel>}
    {tab==='settings'&&managed&&<Panel title="관리자 세션"><p>{state.user.username} · {state.user.role}</p><button onClick={()=>run(()=>api('/api/v1/manager/logout',{}))}>로그아웃</button></Panel>}
    {tab==='settings'&&managed&&state.user.role==='SYSTEM'&&<ManagerAudit run={run} busy={busy}/>}
    {tab === 'settings' && state.authPolicy && <Panel title="환자 인증 및 세션">
      <dl className="facts"><div><dt>잠금 기준</dt><dd>{state.authPolicy.maxAttempts}회 실패</dd></div>
      <div><dt>잠금 시간</dt><dd>{state.authPolicy.lockMinutes}분</dd></div>
      <div><dt>세션 유효시간</dt><dd>{state.authPolicy.sessionMinutes}분</dd></div></dl>
    </Panel>}
    {tab === 'settings' && state.policy && <PolicySettings key='default' state={state} run={run} busy={busy}/>}
    {tab === 'settings' && !state.policy && <Panel title="운영 설정" action={<span className="chip">읽기 전용</span>}><dl className="facts"><div><dt>보관 및 링크</dt><dd>재발급 시 원래 기한 유지</dd></div><div><dt>표시 시간</dt><dd>한국 표준시</dd></div><div><dt>권한 · MFA · 보안 로그</dt><dd>운영 인증 구성 전 비활성</dd></div></dl><button disabled>설정 저장</button></Panel>}
  </>;
}
