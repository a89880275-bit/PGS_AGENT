import { assert,body,epoch,getCookie,iso,json,localClock,PhaseError,sha } from '../phase2/common.mjs';
import { authPolicy,readEnvelope,signEnvelope } from './crypto.mjs';

const sessionName='pgs_patient';
const reauthName='pgs_patient_resume';
const pathRoot='/api/v1/patient/';
export function phase3Routes({db,auth,relay,keys,origin,adminHeader,audit}) {
  const tls=origin.startsWith('https:');
  const secure=(req)=>assert(req.headers.origin===origin,'FORBIDDEN',403);
  const now=localClock;
  const grant=(id,generation,purpose,actor)=>signEnvelope(keys.grant,{purpose,id,generation,actor,exp:now()+120000});
  const claim=(raw,id,purpose)=>{
    const info=readEnvelope(keys.grant,raw,purpose,now());
    assert(info.id===id&&Number.isSafeInteger(info.generation)&&info.generation>0,'FORBIDDEN',403);
    return info;
  };
  async function handle(req,res,path) {
    const post=req.method==='POST';
    if (path.startsWith(pathRoot)) {
      const route=path.slice(pathRoot.length);
      const raw=getCookie(req,sessionName);
      if (post&&route==='verify') {
        secure(req);
        const input=await body(req,1024);
        const verified=await auth.verify(input.token,input.birthDate,req.socket.remoteAddress??'unknown',
          {reauth:getCookie(req,reauthName),session:raw});
        if(raw) relay.cancelSession(sha(raw));
        res.setHeader('Set-Cookie',[auth.cookie(sessionName,verified.session,verified.sessionExpires-now(),tls),
          auth.cookie(reauthName,verified.reauth,verified.reauthExpires-now(),tls)]);
        return json(res,{name:verified.name,expiresAt:verified.expiresAt,sessionExpiresAt:verified.sessionExpiresAt});
      }
      if (post&&route==='logout'){
        secure(req);
        await body(req,1024);
        const key=await auth.logout(raw);
        relay.cancelSession(key);
        res.setHeader('Set-Cookie',[auth.cookie(sessionName,'',0,tls),auth.cookie(reauthName,'',0,tls)]);
        return json(res,{ok:true});
      }
      if (req.method==='GET'&&['session','pdf','download'].includes(route)){
        assert(!new URL(req.url,origin).searchParams.has('documentId'),'FORBIDDEN',403);
        const doc=await auth.session(raw);
        if(route==='session') return json(res,{name:doc.doc_title,expiresAt:iso(doc.expires_at),sessionExpiresAt:iso(doc.session_expires_at)});
        return relay.stream(doc,res,route==='download',epoch(doc.session_expires_at),doc.session_hash,route==='download'?'DOWNLOAD':'VIEW');
      }
      throw new PhaseError('NOT_FOUND',404);
    }
    const action=/^\/api\/v1\/documents\/([a-f0-9-]{36})\/(reissue|revoke|link)$/.exec(path);
    if(post&&action) {
      secure(req);
      const who=await adminHeader(req,['SYSTEM','OPERATOR']);
      await body(req,1024);
      const [,id,operation]=action;
      const doc=db.active(await db.docById(id));
      if(operation==='revoke'){
        await auth.rotate(id,null,null,true,audit?tx=>audit(who.username,'LINK_REVOKED',id,tx):undefined);
        relay.cancelDocument(id);
        return json(res,{status:'REVOKED'});
      }
      return json(res,{documentId:id,operation,grant:grant(id,doc.link_generation+(operation==='reissue'?1:0),operation,who.username)});
    }
    if(path.startsWith('/mock/patient/') || /^\/mock\/documents\/[^/]+\/(replace|revoke)$/.test(path)) throw new PhaseError('NOT_FOUND',404);
  }
  return {handle,claim};
}
