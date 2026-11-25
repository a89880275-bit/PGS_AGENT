import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Agent } from '../../../transfer-agent/ui.jsx';
import { DelphiAgent, delphiMenu } from '../../../transfer-agent/DelphiAgent.jsx';
import { Admin } from '../../../admin-web/ui.jsx';
import { ManagerLogin } from '../../../admin-web/ManagerPanels.jsx';
import { Patient } from '../../../patient-web/ui.jsx';
import { api, agentApi, loadProfile, explain, Notice } from './common.jsx';

const agentMenu = [['home','대시보드','◫'],['history','전송내역','≡'],['manual','수동등록','＋'],['settings','환경설정','⚙']];
const adminMenu = [['home','대시보드','◫'],['documents','안내문 관리','▤'],['manual','수동등록','＋'],['types','안내문 종류','◇'],['api','API 관리','↔'],['deletion','삭제 관리','⊘'],['settings','환경설정','⚙']];
function Console({admin}) {
  const [tab,setTab] = useState(location.hash.slice(1) || 'home');
  const [state,setState] = useState(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [loginRequired,setLoginRequired]=useState(false);
  const menu = admin ? adminMenu : state?.profile?.delphi ? delphiMenu : agentMenu;
  const active = menu.find(([id]) => id === tab) ?? menu[0];
  const reload = async () => {
    try {
      const profile = await loadProfile();
      if (!profile) { setState(await api('/mock/state')); return; }
      if (admin) {
        if(profile.managed){
          try{await api('/api/v1/manager/session');}
          catch(error){if(error.message!=='ADMIN_REQUIRED')throw error;setState(null);setLoginRequired(true);return;}
        }
        const [catalog, local] = await Promise.all([api('/mock/state'),profile.managed?{requests:[]}:agentApi('/mock/agent-transfers').catch(() => ({requests:[]}))]);
        setLoginRequired(false);
        setState({...catalog,...local,profile});
      } else {
        const [local, config] = await Promise.all([agentApi('/mock/agent-state'),api('/mock/config')]);
        setState({...local,...config,types:[{code:'G001',name:'외래 안내문'},{code:'G002',name:'검사 안내문'}],profile});
      }
    } catch (error) {setError(explain(error));}
  };
  useEffect(() => {
    reload();
    const onHash = () => {setTab(location.hash.slice(1)); setError('');};
    const onFocus = () => reload();
    addEventListener('hashchange',onHash);
    addEventListener('focus',onFocus);
    return () => {removeEventListener('hashchange',onHash); removeEventListener('focus',onFocus);};
  }, []);
  async function run(action) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError(explain(error)); }
    finally { await reload(); setBusy(false); }
  }
  const Page = admin ? Admin : state?.profile?.delphi ? DelphiAgent : Agent;
  return <div className={'workspace ' + (admin ? 'admin' : 'agent')}>
    <aside className="sidebar"><a className="brand" href={admin ? '/admin' : '/agent'}><span className="mark" aria-hidden="true">+</span><div>PGS<small>{admin ? '웹 관리자' : 'Transfer Agent'}</small></div></a>
      <nav aria-label="업무 메뉴">{menu.map(([id,label,icon]) => <a key={id} href={'#'+id} aria-current={active[0] === id ? 'page' : undefined}><span aria-hidden="true">{icon}</span>{label}</a>)}</nav>
      <div className="side-bottom"><span className="chip">LOCAL MOCK</span><a href={admin ? '/agent' : '/admin'}>{admin ? '내부 Agent 열기' : '관리자 웹 열기'}</a></div>
    </aside>
    <main className="console-main"><header className="top"><div><p>{admin ? '환자 안내문 관리' : '내부 전송 Agent'}</p><h1>{active[1]}</h1></div><span className="chip">합성 데이터</span></header>
      <Notice>{error}</Notice>
      {loginRequired ? <ManagerLogin onLogin={reload}/> : state ? <Page key={active[0]&&state.profile?.delphi&&!admin?active[0]:undefined} tab={active[0]} state={state} reload={reload} run={run} busy={busy}/>
        : <p role="status">{error ? '새로고침하여 다시 연결하세요.' : '로컬 데이터를 불러오는 중…'}</p>}
    </main>
  </div>;
}
const path = location.pathname;
createRoot(document.getElementById('root')).render(path.startsWith('/g/') || path.startsWith('/v/') || path.startsWith('/patient') ? <Patient/> : <Console admin={path === '/admin'}/>);
