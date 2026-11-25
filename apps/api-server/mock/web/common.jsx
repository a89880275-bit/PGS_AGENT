import { useEffect, useRef, useState } from 'react';

export const base = '/mock/internal/v1/requests';
export let phaseProfile = null;
export async function loadProfile() {
  const response = await fetch('/mock/profile');
  if (response.ok) phaseProfile = await response.json();
  return phaseProfile;
}
export const agentPath = path => (phaseProfile?.agentOrigin ?? '') + path;
export const agentApi = (path,data) => api(agentPath(path),data);
export const date = value => value ? new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value)) : '—';
export const statusLabel = {
  READY:'발급 완료', PENDING:'대기', PROCESSING:'처리 중', RETRY_WAIT:'재시도 대기', FAILED:'실패',
  ACTIVE:'보관 중', EXPIRED:'만료', REVOKED:'차단', DELETED:'삭제',
};
export const messages = {
  AUTH_LIMIT:'확인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  AGENT_FILE_UNAVAILABLE:'안내문 파일을 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.',
  AGENT_OFFLINE:'내부 문서 연결이 끊어졌습니다. 잠시 후 다시 시도해 주세요.',
  AGENT_TIMEOUT:'문서 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.',
  AGENT_BUSY:'문서 조회가 많습니다. 잠시 후 다시 시도해 주세요.',
  INVALID_PDF:'유효한 PDF 파일을 선택해 주세요.',
  TOO_LARGE:'PDF 크기 제한을 초과했습니다.',
  INVALID_POLICY:'보관 기간과 링크 기간을 확인해 주세요.',
  INVALID_FILENAME:'파일명 규칙 또는 생성일을 확인해 주세요.', PATIENT_NOT_FOUND:'합성 환자 일치 기록이 없습니다.',
  ORACLE_UNAVAILABLE:'Oracle Mock 연결 오류', TRANSFER_UNAVAILABLE:'전송 Mock 연결 오류',
  UNMAPPED_SUFFIX:'접미부에 연결된 문서 종류가 없습니다.', USE_SYNTHETIC_PDF:'제공된 합성 PDF만 선택할 수 있습니다.',
  LINK_UNAVAILABLE:'안내문 확인 기간이 끝났거나 링크가 변경되었습니다.',
  DATE_MISMATCH:'생년월일이 일치하지 않습니다. 입력한 날짜를 확인해 주세요.',
  LOCKED:'확인 시도 횟수를 초과했습니다. 30분 뒤 다시 시도해 주세요.',
  SESSION_REQUIRED:'확인 시간이 종료되었습니다. 받은 링크에서 다시 시작해 주세요.',
  SERVICE_UNAVAILABLE:'서비스에 연결할 수 없습니다. 잠시 후 다시 이용해 주세요.',
};
export const explain = error => messages[error?.message ?? error] ?? '요청을 처리할 수 없습니다.';
export async function api(path, data) {
  let response;
  try {
    response = await fetch(path, data === undefined ? undefined : {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data),
    });
  } catch { throw new Error('SERVICE_UNAVAILABLE'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.code);
  return result;
}
export const kstDay = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0,10);
export function Badge({status}) { return <span className={'badge ' + status}>{statusLabel[status] ?? status}</span>; }
export function Notice({children}) { return children ? <p className="notice" role="status">{children}</p> : null; }
export function Panel({title, action, children}) {
  return <section className="panel"><div className="panel-title"><h2>{title}</h2>{action}</div>{children}</section>;
}
let pdfLibrary;
async function pdfjs() {
  pdfLibrary ??= import('/pdf.mjs').then(pdf => {
    pdf.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
    return pdf;
  });
  return pdfLibrary;
}
export function PdfViewer({url, data, onSessionExpired}) {
  const [doc,setDoc] = useState(null);
  const [page,setPage] = useState(1);
  const [zoom,setZoom] = useState(100);
  const [failed,setFailed] = useState('');
  const [attempt,setAttempt] = useState(0);
  const [width,setWidth] = useState(0);
  const canvas = useRef(null);
  const container = useRef(null);
  useEffect(() => {
    let active = true;
    let task;
    const abort=new AbortController();
    setDoc(null); setPage(1); setZoom(100); setFailed('');
    pdfjs().then(async pdf => {
      let source=data?{data:data.slice()}:{url};
      if (url&&onSessionExpired) {
        const response=await fetch(url,{signal:abort.signal});
        if(!response.ok) {
          const payload=await response.json();
          throw Object.assign(new Error(payload.code),{status:response.status});
        }
        source={data:new Uint8Array(await response.arrayBuffer())};
      }
      if (!active) return;
      task = pdf.getDocument({...source,standardFontDataUrl:'/pdfjs/standard_fonts/',isEvalSupported:false,disableRange:true});
      return task.promise;
    }).then(result => { if (active && result) setDoc(result); })
      .catch(error => {
        if (!active) return;
        if(error?.status===401&&onSessionExpired){onSessionExpired();return;}
        if(error?.message==='AGENT_FILE_UNAVAILABLE'){setFailed(error.message);return;}
        setFailed(error?.status===504?'AGENT_TIMEOUT':error?.status===503?'AGENT_OFFLINE':error?.status===410?'LINK_UNAVAILABLE':'PDF_UNAVAILABLE');
      });
    return () => { active = false; abort.abort(); task?.destroy().catch(() => {}); };
  }, [url,data,attempt]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!doc || !width) return;
    let active = true;
    let render;
    doc.getPage(page).then(pdfPage => {
      if (!active) return;
      const original = pdfPage.getViewport({scale:1});
      const scale = Math.min(1, width / original.width) * zoom / 100;
      const viewport = pdfPage.getViewport({scale});
      const density = Math.min(devicePixelRatio || 1, 2);
      const element = canvas.current;
      element.width = Math.ceil(viewport.width * density);
      element.height = Math.ceil(viewport.height * density);
      element.style.width = viewport.width + 'px';
      element.style.height = viewport.height + 'px';
      render = pdfPage.render({canvas:element, viewport, transform:[density,0,0,density,0,0]});
      return render.promise;
    }).catch(error => { if (active && error?.status===401 && onSessionExpired) {onSessionExpired();return;} if (active) setFailed(error?.status===504?'AGENT_TIMEOUT':error?.status===503?'AGENT_OFFLINE':error?.status===410?'LINK_UNAVAILABLE':'PDF_UNAVAILABLE'); });
    return () => { active = false; render?.cancel(); };
  }, [doc,page,zoom,width]);
  return <div className="viewer">
    <div className="viewer-controls" aria-label="PDF 보기 도구">
      <button disabled={page <= 1} onClick={() => setPage(page-1)}>이전</button>
      <output aria-live="polite">{page} / {doc?.numPages ?? '—'}</output>
      <button disabled={!doc || page >= doc.numPages} onClick={() => setPage(page+1)}>다음</button>
      <button aria-label="축소" disabled={!doc || zoom <= 75} onClick={() => setZoom(zoom-25)}>−</button>
      <output>{zoom}%</output><button aria-label="확대" disabled={!doc || zoom >= 200} onClick={() => setZoom(zoom+25)}>+</button>
    </div>
    {failed ? <div><Notice>{failed==='PDF_UNAVAILABLE'?'PDF를 열 수 없습니다.':explain(failed)}</Notice><button onClick={() => setAttempt(attempt+1)}>PDF 다시 불러오기</button></div> : !doc && <p role="status">PDF 불러오는 중…</p>}
    <div className="paper" ref={container} tabIndex={0} aria-label="PDF 페이지 영역">
      <canvas ref={canvas} aria-label={'PDF ' + page + '페이지'} hidden={!doc || failed} />
    </div>
  </div>;
}
