import { useEffect, useState } from 'react';
import { agentApi as api, agentPath, phaseProfile, base, date, kstDay, Badge, Notice, Panel, explain, PdfViewer } from '../api-server/mock/web/common.jsx';

const scenarios = [
  ['normal','정상 감지'], ['bad-name','잘못된 파일명'], ['missing','환자 없음'],
  ['oracle','Oracle 장애'], ['transfer','전송 실패'], ['revision','동일 파일명 수정본'], ['expired','만료 사례'],
];
const stages = ['파일 감지','파일명 파싱','Oracle Mock 조회 · 등록 대기','전송 중','READY · URL 반환'];
const steps = ['파일 감지','파일명 분석','환자 확인','등록 및 발급'];

function Registration({onStart, busy, maxPdf = 10000}) {
  const [file,setFile] = useState(null);
  const [checked,setChecked] = useState(null);
  const [notice,setNotice] = useState('');
  const [checking,setChecking] = useState(false);
  async function select(event) {
    const selected = event.target.files[0];
    setFile(null); setChecked(null); setNotice('');
    if (!selected) return;
    if (selected.size > maxPdf) { setNotice(explain('TOO_LARGE')); return; }
    const data = new Uint8Array(await selected.arrayBuffer());
    const chunks = [];
    for (let index = 0; index < data.length; index += 8192) chunks.push(String.fromCharCode(...data.subarray(index,index+8192)));
    setFile({ filename:selected.name, requestId:crypto.randomUUID(), data, pdf:btoa(chunks.join('')) });
  }
  async function inspect() {
    setChecking(true); setNotice('');
    try { setChecked(await api('/mock/inspect', { filename:file.filename, pdf:file.pdf })); }
    catch (error) { setNotice(explain(error)); }
    finally { setChecking(false); }
  }
  return <Panel title="합성 PDF 수동 등록">
    <p>샘플 다운로드 후 파일을 선택하고 환자 일치 여부를 확인하세요.</p>
    <div className="line"><a className="button" href={agentPath("/mock/sample")}>합성 PDF 받기</a><a className="button" href={agentPath("/mock/sample-revision")}>수정본 받기</a></div>
    <label className="field file">테스트 PDF 선택<input type="file" accept=".pdf,application/pdf" onChange={select} disabled={checking || busy} /></label>
    <div className="line"><button disabled={!file || checking || busy} onClick={inspect}>파일명 분석 및 환자 확인</button>
    <button className="primary" disabled={!checked || busy} onClick={() => onStart('normal', {filename:file.filename,pdf:file.pdf,requestId:file.requestId})}>{phaseProfile ? "내부 저장 및 등록" : "등록 대기열에 추가"}</button></div>
    <Notice>{notice}</Notice>
    {checked && <><dl className="facts"><div><dt>합성 환자번호</dt><dd>{checked.patientNo}</dd></div>{checked.birthDate && <div><dt>합성 생년월일</dt><dd>{checked.birthDate}</dd></div>}<div><dt>파일 생성일</dt><dd>{checked.createdDate}</dd></div><div><dt>접미부 · 문서 코드</dt><dd>{checked.suffix} · {checked.documentCode}</dd></div></dl><PdfViewer data={file.data}/></>}
  </Panel>;
}
export function Agent({tab, state, reload, run, busy}) {
  const [scenario,setScenario] = useState('normal');
  const [tracked,setTracked] = useState(null);
  const [result,setResult] = useState(null);
  const [query,setQuery] = useState('');
  const [filter,setFilter] = useState('');
  const [from,setFrom] = useState('');
  const [to,setTo] = useState('');
  const item = state.requests.find(row => row.id === tracked);
  const today = state.requests.filter(row => kstDay(row.at) === kstDay(new Date().toISOString()));
  const failed = rows => rows.filter(row => ['FAILED','RETRY_WAIT'].includes(row.status)).length;
  const pending = rows => rows.filter(row => ['PROCESSING','PENDING'].includes(row.status)).length;
  async function start(value, selection) {
    await run(async () => {
      setResult(null);
      if (phaseProfile && selection) {
        setTracked(selection.requestId);
        const job = await api(phaseProfile.mode==='phase3'?'/mock/manual':'/internal/v1/requests', selection);
        setResult(job);
      } else {
        const job = await api(base, {scenario:value,...selection});
        setTracked(job.requestId);
      }
    });
  }
  async function task(id, action) {
    await run(async () => {
      setTracked(id);
      const response = await api(base + '/' + id + (action ? '/' + action : ''), action ? {} : undefined);
      setResult(response);
    });
  }
  useEffect(() => { if (result?.requestId !== tracked) setResult(null); }, [tracked]);
  const shown = state.requests.filter(row =>
    (!filter || row.status === filter) && (!from || kstDay(row.at) >= from) && (!to || kstDay(row.at) <= to) &&
    [row.id,row.patientNo,row.type,state.types.find(type => type.code === row.type)?.name].some(value => value?.toLowerCase().includes(query.toLowerCase())));
  const metrics = [['감지',today.length],['완료',today.filter(row => row.status === 'READY').length],['대기',pending(today)],['실패',failed(today)]];
  return <>
    {tab === 'home' && <>
      <section className="hero"><div><p className="eyebrow">전송 작업 공간</p><h2>파일 전송 현황</h2><p>내부 안내문 등록 대기열과 Mock 연동 상태를 확인합니다.</p></div><div className="connection"><span>● Oracle Mock</span><span>● API Mock</span></div></section>
      <div className="metrics">{metrics.map(([label,count]) => <article key={label}><span>금일 {label}</span><strong>{count}<small>건</small></strong></article>)}</div>
      <Panel title="감시 시뮬레이션" action={<span className="chip">Mock 감지</span>}>
        <p className="path">{state.settings.folder}</p>
        <div className="line"><label className="field">감지 사례<select value={scenario} onChange={e => setScenario(e.target.value)}>{scenarios.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <button className="primary" disabled={busy} onClick={() => start(scenario)}>파일 감지</button></div>
      </Panel>
    </>}
    {tab==='home'&&state.automationSummary&&<Panel title="자동 등록 · 알림톡">
      <dl className="facts">{Object.entries({'감지':state.automationSummary.detected,'PDF 등록 · URL 발급':state.automationSummary.ready,
        '등록실패':state.automationSummary.failed,'환자 조회 실패':state.automationSummary.patientErrors,'메타 · URL 오류':state.automationSummary.publishErrors,
        '발송대기':state.automationSummary.notifications.WAITING??0,'발송요청 완료':state.automationSummary.notifications.SUBMITTED??0,
        '발송실패':state.automationSummary.notifications.FAILED??0,'결과 미확인':state.automationSummary.notifications.UNKNOWN??0,
        '24시간 내 만료 예정':state.automationSummary.expiring}).map(([label,count])=><div key={label}><dt>{label}</dt><dd>{count}건</dd></div>)}</dl>
    </Panel>}
    {tab === 'home' && state.profile && <Panel title="내부 저장소 및 중계">
      <dl className="facts"><div><dt>WSS 연결</dt><dd>{state.connection.online?'연결됨':'오프라인'}</dd></div>
      <div><dt>최근 heartbeat</dt><dd>{date(state.connection.lastSeenAt)}</dd></div>
      <div><dt>보관 건수 / PDF 용량</dt><dd>{state.storage.count}건 / {(state.storage.bytes/1048576).toFixed(2)} MB</dd></div>
      <div><dt>디스크 사용률</dt><dd>{state.storage.utilization}%</dd></div>
      <div><dt>기본 보관 / 링크</dt><dd>{state.policy.retention_days}일 / {state.policy.link_validity_days}일</dd></div></dl>
      {state.storage.warning && <Notice>디스크 사용률이 80% 이상입니다.</Notice>}
      <button onClick={reload}>상태 새로고침</button>
    </Panel>}
    {tab === 'manual' && <Registration onStart={start} busy={busy} maxPdf={state.settings.maxPdf}/>}
    {tab === 'history' && <Panel title="요청 목록" action={<button onClick={reload}>새로고침</button>}>
      <div className="filters"><label>시작일<input type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>종료일<input type="date" value={to} onChange={e => setTo(e.target.value)}/></label>
      <label>상태<select value={filter} onChange={e => setFilter(e.target.value)}><option value="">전체</option>
      {['PENDING','READY','FAILED','RETRY_WAIT','PROCESSING'].map(value => <option key={value} value={value}>{({PENDING:'대기',READY:'완료',FAILED:'실패',RETRY_WAIT:'재시도 대기',PROCESSING:'처리 중'})[value]}</option>)}</select></label>
      <label>요청 ID · 문서 종류 검색<input value={query} onChange={e => setQuery(e.target.value)}/></label></div>
      <div className="table-wrap"><table><thead><tr>{['요청 ID','환자번호','종류','감지 시각','전송 상태','URL','조치'].map(s => <th key={s}>{s}</th>)}</tr></thead>
      <tbody>{shown.map(row => <tr key={row.id}><td title={row.id}>{row.id}</td><td>{row.patientNo}</td><td>{row.type ?? '—'}</td><td>{date(row.at)}</td><td><Badge status={row.status}/>{row.error && <small>{explain(row.error)}</small>}</td>
      <td>{row.urlReady ? '발급 완료' : '—'}</td><td><button disabled={busy} onClick={() => task(row.id,row.status === 'RETRY_WAIT' ? 'retry' : '')}>{row.status === 'RETRY_WAIT' ? '재시도' : '결과 확인'}</button></td></tr>)}</tbody></table>{!shown.length && <p>검색 조건에 맞는 요청이 없습니다.</p>}</div>
    </Panel>}
    {tab === 'settings' && <Panel title="Mock 구성" action={<span className="chip">읽기 전용</span>}><dl className="facts">
      {Object.entries({'감시 폴더':state.settings.folder,'파일명 규칙':state.settings.format,'접미부 매핑':Object.entries(state.settings.mapping).map(pair => pair.join(' → ')).join(', '),'내부 API':state.settings.api,'재시도 설정':state.settings.retry,'서비스 상태':'브라우저 시뮬레이션'}).map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></Panel>}
    {tab !== 'settings' && item && <Panel title="요청 처리" action={<Badge status={item.status}/>}>
      <p className="path">{item.id}</p>{item.storageState && <p>{item.storageState} · 링크 {date(item.expiresAt)} · 삭제 {date(item.deleteAt)}</p>}<ol className="steps">{steps.map((label,index) => <li key={label} className={index < item.stage ? 'done' : index === item.stage ? 'current' : ''}>{label}</li>)}</ol>
      <p>{stages[item.stage]}{item.error && ' · ' + explain(item.error)}</p>
      <div className="line">
        {item.status === 'PENDING' && <button className="primary" disabled={busy} onClick={() => task(item.id,'step')}>다음 처리</button>}
        {item.status === 'RETRY_WAIT' && <button className="primary" disabled={busy} onClick={() => task(item.id,'retry')}>재시도</button>}
        <button disabled={busy} onClick={() => task(item.id,'')}>내부 API 결과 조회</button>
      </div>
      {result?.requestId === item.id && <div className="result"><p>내부 API · {result.status}</p>{result.viewUrl && item.urlReady && <><a href={result.viewUrl} target="_blank" rel="noreferrer">환자 시연 링크 열기</a>{state.profile?.mode==="phase3" ? <button onClick={() => run(async()=>navigator.clipboard.writeText(result.viewUrl))}>보안 링크 복사</button> : <p className="path">{result.viewUrl}</p>}<p>만료 {date(result.expiresAt)} · HIS 전달 가능</p></>}</div>}
    </Panel>}
  </>;
}
