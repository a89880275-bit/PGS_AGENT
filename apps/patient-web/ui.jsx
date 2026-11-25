import { useEffect, useState } from 'react';
import { api, loadProfile, date, explain, PdfViewer } from '../api-server/mock/web/common.jsx';

export function Patient() {
  const initialToken = /^\/(?:v|g)\/([\w-]+)$/.exec(location.pathname)?.[1] ?? '';
  const resume=location.pathname==='/patient/reauth';
  const view = location.pathname === '/patient/view';
  const [birth,setBirth] = useState('');
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [detail,setDetail] = useState(null);
  const [mode,setMode] = useState(null);
  const [downloadError,setDownloadError] = useState('');
  const secure=mode==='phase3';
  const patientApi=secure?'/api/v1/patient':'/mock/patient';
  useEffect(() => {
    document.title = '안내문 확인 | PGS';
    let active=true;
    loadProfile().then(async profile=>{
      if(!active) return;
      const phase3=profile?.mode==='phase3';
      setMode(phase3?'phase3':'legacy');
      if(view) setDetail(await api(phase3?'/api/v1/patient/session':'/mock/patient/detail'));
      if(location.hash==='#outage'&&!phase3) await api('/mock/patient/outage');
    }).catch(error=>{if(active) setError(error.message);});
    return ()=>{active=false;};
  }, [view]);
  function expired(){setDetail(null); setError('SESSION_REQUIRED');}
  useEffect(()=>{
    if(!detail?.sessionExpiresAt) return;
    const timer=setTimeout(expired,Math.max(0,Date.parse(detail.sessionExpiresAt)-Date.now()));
    return ()=>clearTimeout(timer);
  },[detail]);
  async function logout(){
    try {await api(patientApi+'/logout',{}); location.replace('/patient');}
    catch(error){setDownloadError(error.message);}
  }
  async function download(event){
    if(!secure) return;
    event.preventDefault();
    setDownloadError('');
    try {
      const response=await fetch(patientApi+'/download');
      if(response.status===401){expired();return;}
      if(!response.ok) throw new Error((await response.json()).code);
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');
      link.href=url; link.download='pgs-guide.pdf'; link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(error){setDownloadError(error.message);}
  }
  const terminal = ['LINK_UNAVAILABLE','LOCKED','AUTH_LIMIT','SERVICE_UNAVAILABLE','SESSION_REQUIRED'].includes(error);
  async function verify(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await api(patientApi+'/verify', { ...(initialToken?{token:initialToken}:{}), birthDate:birth });
      location.replace('/patient/view');
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <div className="patient"><header><span className="mark" aria-hidden="true">+</span><div>환자 안내문<small>PGS · 합성 데이터 시연</small></div></header>
    <main className="patient-main">
      {terminal ? <section className="patient-card"><p className="eyebrow">안내문 확인</p><h1>{({LINK_UNAVAILABLE:'링크를 사용할 수 없어요',LOCKED:'잠시 후 다시 시도해 주세요',AUTH_LIMIT:'잠시 후 다시 시도해 주세요',SERVICE_UNAVAILABLE:'서비스 연결이 지연되고 있어요',SESSION_REQUIRED:'확인 시간이 끝났어요'})[error]}</h1><p role="alert">{explain(error)}</p><p>도움이 필요하면 안내문을 보낸 병원에 문의해 주세요.</p>{secure&&error==='SESSION_REQUIRED'&&<a className="button primary" href="/patient/reauth">다시 인증</a>}{error === 'SERVICE_UNAVAILABLE' && <button className="primary" onClick={() => location.reload()}>다시 확인</button>}</section>
      : detail ? <section className="patient-card"><p className="eyebrow">본인 확인 완료</p><h1>{detail.name}</h1><p className="expiry">확인 기한 {date(detail.expiresAt)} (한국 시간)</p>
                <PdfViewer url={patientApi+'/pdf'} onSessionExpired={secure?expired:undefined}/><a className="button primary patient-action" href={patientApi+'/download'} download onClick={download}>PDF 다운로드</a>
        {downloadError&&<p role="alert">{explain(downloadError)}</p>}
        {secure&&<button onClick={logout}>조회 종료</button>}
        <p>기기에 저장한 PDF는 서버에서 회수할 수 없습니다.</p>
      </section> : view ? <section className="patient-card"><p role="status">안내문을 확인하고 있습니다.</p></section>
      : (initialToken || resume) ? <section className="patient-card"><p className="eyebrow">본인 확인</p><h1>생년월일을<br/>입력해 주세요</h1><p>안내문을 보려면 생년월일 숫자 8자리가 필요합니다.</p>
        <form onSubmit={verify}><label htmlFor="pgs-birth">생년월일 <small>입력 형식 예시 19600101</small></label>
          <input id="pgs-birth" inputMode="numeric" autoComplete="off" maxLength={8} pattern="[0-9]{8}" required value={birth} onChange={e => setBirth(e.target.value.replace(/\D/g,''))} aria-invalid={Boolean(error)} aria-describedby={error ? 'birth-error' : undefined}/>
          {error && <p id="birth-error" role="alert" className="patient-error">{explain(error)}</p>}
          <button className="primary patient-action" disabled={!mode || busy || birth.length !== 8}>{busy ? '확인 중…' : '확인'}</button>
        </form><p>안내문별 확인 기한은 본인 확인 후 표시됩니다.</p>
      </section> : <section className="patient-card"><h1>받은 링크를 열어 주세요</h1><p>안내문마다 별도의 확인 링크가 제공됩니다.</p></section>}
    </main><footer>확인에 어려움이 있으면 안내문을 보낸 병원에 문의해 주세요.</footer>
  </div>;
}