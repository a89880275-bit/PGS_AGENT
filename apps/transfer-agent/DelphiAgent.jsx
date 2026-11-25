import {useState} from 'react';
import {api,agentApi,date,kstDay,Panel,Notice,PdfViewer} from '../api-server/mock/web/common.jsx';

export const delphiMenu=[
  ['home','대시보드','◫'],['history','Delphi 연동 요청내역','≡'],['documents','PDF 문서관리','▤'],
  ['links','URL 발급관리','↔'],['connection','외부 서버 연결관리','◎'],['deletion','만료 및 삭제관리','⊘'],
  ['settings','환경설정','⚙'],['logs','시스템 로그','≡'],
];
export function DelphiAgent({tab,state,reload,run,busy}){
  const [query,setQuery]=useState(''),[preview,setPreview]=useState(null),[notice,setNotice]=useState('');
  const [issued,setIssued]=useState(null);
  const [filters,setFilters]=useState({from:'',to:'',type:'',status:'',doc:''});
  const [detail,setDetail]=useState(null);
  const managed=state.profile?.managed;
  const stats=state.dashboard;
  const rows=state.requests.filter(row=>row.id.toLowerCase().includes(query.toLowerCase())&&(!filters.doc||row.documentId?.includes(filters.doc))&&
    (!filters.from||kstDay(row.at)>=filters.from)&&(!filters.to||kstDay(row.at)<=filters.to)&&(!filters.type||row.type===filters.type)&&(!filters.status||row.status===filters.status));
  const due=state.requests.filter(row=>row.storageState!=='DELETED'&&row.deleteAt&&Date.parse(row.deleteAt)<=Date.now());
  async function link(id,operation){
    const grant=await api('/api/v1/documents/'+id+'/'+operation,{});
    return operation==='revoke'?grant:agentApi('/mock/link',grant);
  }
  function act(row,operation){
    void run(async()=>{
      const value=await link(row.documentId,operation);
      setIssued(operation==='revoke'?null:value);
      setNotice(operation==='revoke'?'링크를 폐기했습니다.':operation==='reissue'?'새 링크를 발급했습니다. 기존 만료일을 유지합니다.':'');
    });
  }
  function check(row,operation){
    void run(async()=>{
      const grant=await api('/api/v1/agent/maintenance-grant',{requestId:row.id,operation});
      const result=await agentApi('/mock/agent-document',grant);
      if(operation==='retry')setNotice('재처리 결과 '+result.status);
      else setDetail({...row,...result});
    });
  }
  return <>
    {notice&&<Notice>{notice}</Notice>}
    {tab==='home'&&<>
      <section className="hero"><div><p className="eyebrow">Delphi 내부 연동</p><h2>PDF 전송 현황</h2><p>내부 인수 폴더와 외부 중계 연결을 확인합니다.</p></div><div className="connection"><span>● {state.connection.online?'중계 연결됨':'중계 오프라인'}</span></div></section>
      <div className="metrics">{(stats?[['금일 등록 요청',stats.today],['금일 완료',stats.completed],['등록 대기',stats.pending],['금일 실패',stats.failed],['활성 PDF',stats.active],['7일 내 만료',stats.expiring]]:
        [['등록 요청',state.requests.length],['등록 완료',state.requests.filter(row=>row.status==='READY').length],
        ['등록 대기',state.requests.filter(row=>['PENDING','RETRY_WAIT'].includes(row.status)).length],['내부 보관',state.storage.count]]).map(([label,value])=>
        <article key={label}><span>{label}</span><strong>{value}<small>건</small></strong></article>)}</div>
      {managed&&<Panel title="서비스 상태"><dl className="facts"><div><dt>내부 REST</dt><dd>응답 중</dd></div>
        <div><dt>내부 PDF 사용량</dt><dd>{(state.storage.bytes/1048576).toFixed(2)} MB</dd></div>
        <div><dt>마지막 연결</dt><dd>{date(state.connection.connectedAt)}</dd></div>
        <div><dt>마지막 연결 오류</dt><dd>{date(state.connection.errorAt)}</dd></div></dl></Panel>}
    </>}
    {['history','documents','links'].includes(tab)&&<Panel title={delphiMenu.find(item=>item[0]===tab)[1]} action={<button onClick={reload}>새로고침</button>}>
      <label className="field">요청 ID 검색<input value={query} onChange={event=>setQuery(event.target.value)}/></label>
      {managed&&<div className="filters">
        {['from','to','doc'].map((key,index)=><label key={key}>{['시작일','종료일','문서 ID'][index]}<input type={key==='doc'?'text':'date'} value={filters[key]} onChange={e=>setFilters({...filters,[key]:e.target.value})}/></label>)}
        {['type','status'].map((key,index)=><label key={key}>{['문서 종류','처리 상태'][index]}<select value={filters[key]} onChange={e=>setFilters({...filters,[key]:e.target.value})}><option value="">전체</option>
          {[...new Set(state.requests.map(item=>item[key]).filter(Boolean))].map(value=><option key={value}>{value}</option>)}</select></label>)}
      </div>}
      {(tab!=='history'||managed)&&<a href="/admin" target="_blank" rel="noreferrer">관리자 세션 열기</a>}
      <div className="table-wrap"><table><thead><tr>{['요청 ID','문서 ID','종류','상태','등록 요청','링크 만료','결과','작업'].map(label=><th key={label}>{label}</th>)}</tr></thead>
      <tbody>{rows.map(row=><tr key={row.id}><td>{row.id}</td><td>{row.documentId??'—'}</td><td>{row.type??'—'}</td><td>{row.status}</td>
      <td>{date(row.at)}</td><td>{date(row.expiresAt)}</td><td>{row.error??'—'}</td>
      <td><div className="line actions">{tab==='documents'&&<button disabled={!row.urlReady} onClick={()=>setPreview(row.documentId)}>PDF 미리보기</button>}
        {managed&&tab!=='links'&&<button disabled={busy} onClick={()=>check(row,'inspect')}>상세 · 정합성 확인</button>}
        {managed&&tab==='history'&&<button disabled={busy||!['LOCAL_SAVED','RETRY_PENDING','REGISTERING'].includes(row.storageState)} onClick={()=>check(row,'retry')}>등록 재처리</button>}
        {tab==='links'&&<><button disabled={!row.urlReady||busy} onClick={()=>act(row,'link')}>링크 확인</button>
        <button disabled={!row.urlReady||busy} onClick={()=>{if(window.confirm('이전 링크를 폐기하고 새 링크를 발급할까요?'))act(row,'reissue');}}>재발급</button>
        <button disabled={!row.urlReady||busy} onClick={()=>{if(window.confirm('이 문서의 조회 링크를 폐기할까요?'))act(row,'revoke');}}>폐기</button></>}</div></td></tr>)}</tbody></table></div>
      {!rows.length&&<p>표시할 요청이 없습니다.</p>}
      {tab==='links'&&issued&&<div className="line"><a href={issued.viewUrl} target="_blank" rel="noreferrer">환자 화면 열기</a>{issued.issuedAt&&<small>발급 {date(issued.issuedAt)} · 만료 {date(issued.expiresAt)}</small>}<button onClick={()=>run(async()=>{await navigator.clipboard.writeText(issued.viewUrl);setNotice('링크를 복사했습니다.');})}>링크 복사</button></div>}
    </Panel>}
    {managed&&detail&&['history','documents'].includes(tab)&&<Panel title="요청 및 파일 검증" action={<button onClick={()=>setDetail(null)}>닫기</button>}>
      <dl className="facts">{Object.entries({'마스킹 파일명':detail.fileLabel,'PDF 크기':detail.size+' B','SHA-256':detail.sha256,'처리시간':detail.processingMs==null?'—':detail.processingMs+' ms','재시도':detail.retries,
        '파일 확인':detail.fileStatus,'링크 발급':date(detail.issuedAt),'외부 등록':detail.remoteStatus,'정합성':detail.consistent===null?'확인 불가':detail.consistent?'일치':'불일치','오류코드':detail.error??'—'}).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
    </Panel>}
    {tab==='documents'&&preview&&<Panel title="PDF 미리보기" action={<button onClick={()=>setPreview(null)}>닫기</button>}><PdfViewer url={'/mock/documents/'+preview+'/pdf'}/></Panel>}
    {tab==='connection'&&<Panel title="외부 중계 연결" action={<button onClick={reload}>새로고침</button>}><dl className="facts">
      <div><dt>Agent 시작 WSS</dt><dd>{state.connection.online?'연결됨':'오프라인'}</dd></div>
      <div><dt>최근 통신</dt><dd>{date(state.connection.lastSeenAt)}</dd></div>
      {managed&&<><div><dt>마지막 종료</dt><dd>{date(state.connection.disconnectedAt)}</dd></div>
        <div><dt>재연결</dt><dd>{state.connection.reconnecting?'대기 중 · ':''}{state.connection.reconnections}회</dd></div>
        <div><dt>연결 오류</dt><dd>{state.connection.lastError??'—'}</dd></div>
        <div><dt>등록 미처리</dt><dd>{stats?.pending??0}건</dd></div></>}</dl></Panel>}
    {tab==='deletion'&&<Panel title="만료 및 삭제" action={<button disabled={busy} onClick={()=>run(async()=>{
      const grant=await api('/api/v1/agent/maintenance-grant',{});const result=await agentApi('/mock/purge',grant);setNotice('삭제 처리 '+result.deleted+'건');
    })}>기한이 지난 PDF 정리</button>}><p>삭제 기한 도래 {due.length}건</p><a href="/admin" target="_blank" rel="noreferrer">관리자 세션 열기</a></Panel>}
    {tab==='settings'&&<Panel title="내부 등록 설정"><dl className="facts"><div><dt>인수 폴더</dt><dd>{state.settings.intake}</dd></div>
      <div><dt>등록 API</dt><dd>{state.profile.agentOrigin}/api/v1/internal/documents</dd></div>
      <div><dt>PDF 크기 상한</dt><dd>{state.settings.maxPdf/1048576} MB</dd></div>
      <div><dt>기본 보관 / 링크</dt><dd>{state.policy.retention_days}일 / {state.policy.link_validity_days}일</dd></div></dl>
      <a href={state.profile.agentOrigin+'/mock/sample'}>합성 PDF 받기</a></Panel>}
    {tab==='logs'&&<Panel title="시스템 로그" action={<button onClick={reload}>새로고침</button>}>
      <ul className="rows">{state.events?.map(event=><li key={event.id}>{date(event.at)} · {event.event} · {event.code}</li>)}</ul>
    </Panel>}
  </>;
}
