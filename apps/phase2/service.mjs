import { signEnvelope } from '../phase3/crypto.mjs';
import { phase3,authPolicy } from '../phase3/crypto.mjs';
import { patientAuth } from '../phase3/auth.mjs';
import { phase3Routes } from '../phase3/routes.mjs';
import { defaultRules } from '../transfer-agent/filename.ts';
import { legacyPatientNo } from '../transfer-agent/patient.ts';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { openDatabase } from './db.mjs';
import { attachRelay } from './relay.mjs';
import { managerAuth } from './manager.mjs';
import { agentId,agentOrigin,assert,body,bearer,equal,errorResponse,getCookie,hashPattern,headers,integer,iso,epoch,json,localGuard,localClock,mac,
  maxPdf,PhaseError,requestPattern,secret,tlsPort,token,types,uuid } from './common.mjs';

const documentPattern=/^\/api\/v1\/documents\/([a-f0-9-]{36})\/(activate|deleted|reissue)$/;
const adminPattern=/^\/mock\/documents\/([a-f0-9-]{36})\/(pdf|replace|revoke)$/;
const pathFields=['agentId','documentId','requestId','documentCode','fileSize','fileHash','createdAt','patientKey','birthVerify'];
function validate(input,delphi,managed) {
  const fields=phase3?[...pathFields,'tokenHash','birthSalt','keyVersion']:pathFields;
  if(delphi&&Object.hasOwn(input,'requestedRetentionDays')){
    assert(Number.isInteger(input.requestedRetentionDays)&&input.requestedRetentionDays>=1&&input.requestedRetentionDays<=90,'INVALID_METADATA');
    fields.push('requestedRetentionDays');
  }
  if (phase3) assert(hashPattern.test(input.tokenHash??'')&&hashPattern.test(input.birthSalt??'')&&Number.isInteger(input.keyVersion)&&input.keyVersion>=2,'INVALID_METADATA');
  assert(Object.keys(input).length===fields.length && Object.keys(input).every(key=>fields.includes(key)),'METADATA_ONLY',415);
  assert(input.agentId===agentId,'AGENT_FORBIDDEN',403);
  assert(typeof input.documentId==='string'&&uuid.test(input.documentId)&&typeof input.requestId==='string'&&requestPattern.test(input.requestId),'INVALID_METADATA');
  assert((managed?/^G[0-9]{3}$/.test(input.documentCode):types.some(type=>type.code===input.documentCode))&&Number.isInteger(input.fileSize)&&input.fileSize>0&&input.fileSize<=maxPdf,'INVALID_METADATA');
  assert([input.fileHash,input.patientKey,input.birthVerify].every(value=>typeof value==='string'&&hashPattern.test(value)),'INVALID_METADATA');
  assert(typeof input.createdAt==='string'&&Number.isFinite(Date.parse(input.createdAt))&&iso(input.createdAt)===input.createdAt,'INVALID_METADATA');
}

export async function makePhase({origin}) {
  localGuard();
  const delphi=phase3&&process.env.PGS_PHASE4==='1';
  const managed=delphi&&process.env.PGS_PHASE5B==='1';
  const patientDigits=integer('PGS_FILENAME_PATIENT_DIGITS',defaultRules.patientDigits,1,32);
  const patientPattern=new RegExp('^\\d{'+patientDigits+'}$');
  const keys={agent:secret('PGS_AGENT_SECRET'),proof:secret('PGS_PROOF_SECRET'),subject:secret('PGS_SUBJECT_SECRET'),link:secret('PGS_LINK_SECRET')};
  if(phase3){
    keys.grant=secret('PGS_GRANT_SECRET');
    keys.rate=secret('PGS_RATE_SECRET');
    keys.legacySubject=keys.subject;
    keys.birth=new Map(Object.entries(JSON.parse(process.env.PGS_BIRTH_KEYS??'{}')).map(([version,key])=>[Number(version),key]));
    const version=integer('PGS_BIRTH_KEY_VERSION',2,2);
    if(!keys.birth.has(version)) keys.birth.set(version,secret('PGS_BIRTH_SECRET'));
    for(const [number,key] of keys.birth) assert(Number.isInteger(number)&&number>=2&&typeof key==='string'&&key.length>=32,'INVALID_BIRTH_KEY');
  }
  const db=await openDatabase({keys,clock:localClock,phase3,manager:managed});
  const manager=managed?await managerAuth(db,origin):null;
  const auth=phase3?patientAuth(db,keys,localClock):null;
  await db.setAgent(false);
  const admin=token();
  let droppedTestResponse=false;
  const agentHeader=req=>assert(req.headers['x-agent-id']===agentId&&equal(bearer(req),keys.agent),'AGENT_FORBIDDEN',401);
  async function adminHeader(req,roles){
    if(manager)return manager.session(req,roles);
    assert(equal(getCookie(req,'pgs_local_admin'),admin),'ADMIN_REQUIRED',403);
    return {username:'local-test-admin',role:'SYSTEM'};
  }
  const link=doc=>'/v/'+db.linkFor(doc);
  const active=doc=>doc?.status==='READY'&&epoch(doc.expires_at)>localClock();
  const dto=doc=>({
    documentId:doc.document_id,requestId:doc.request_id,status:active(doc)?'READY':doc.status==='REGISTERING'?'PENDING':'FAILED',
    registeredAt:iso(doc.registered_at),expiresAt:iso(doc.expires_at),deleteAt:iso(doc.delete_at),
    retentionDays:doc.retention_days,validityDays:doc.link_validity_days,policyVersion:Number(doc.policy_version),
    ...(phase3 ? {generation:doc.link_generation,legacyLink:!doc.initial_token_hash && !doc.birth_salt} : active(doc)?{viewUrl:origin+link(doc)}:{}),
  });
  const agentDto=async doc=>{
    const current=phase3&&active(doc)?await auth.activeToken(db.sql,doc.document_id):null;
    return {...dto(doc),...(current?{tokenHash:current.token_hash,...(managed?{issuedAt:iso(current.issued_at)}:{})}:{})};
  };
  const tls=createServer({
    cert:await readFile(process.env.PGS_TLS_CERT??'.local/phase2/tls/cert.pem'),
    key:await readFile(process.env.PGS_TLS_KEY??'.local/phase2/tls/key.pem'),
  },async(req,res)=>{
    headers(res);
    try {
      agentHeader(req);
      const path=new URL(req.url,'https://127.0.0.1').pathname;
      const post=req.method==='POST';
      if(managed&&req.method==='GET'&&path==='/api/v1/agent/catalog')return json(res,{types:await db.catalog()});
      if (post&&path==='/api/v1/documents') {
        const input=await body(req);
        validate(input,delphi,managed);
        if(phase3) assert(keys.birth.has(input.keyVersion),'INVALID_METADATA');
        const {doc,created}=await db.register(input);
        // Initial handoff contains policy only, even on retry.
        const {viewUrl,...result}=dto(doc);
        return json(res,result,created?201:200);
      }
      if (post&&path==='/api/v1/cleanup') { await body(req); await db.cleanup(); return json(res,{ok:true}); }
      const action=documentPattern.exec(path);
      if (post&&action) {
        assert(uuid.test(action[1]),'DOCUMENT_NOT_FOUND',404);
        const input=await body(req);
        if (action[2]==='activate') {
          const activated=await db.activate(action[1]);
          if (!droppedTestResponse && activated.request_id===process.env.PGS_TEST_DROP_ACTIVATE_FOR) {
            droppedTestResponse=true;
            res.destroy();
            return;
          }
          return json(res,await agentDto(activated));
        }
        if(action[2]==='reissue'){
          assert(phase3&&typeof input.tokenHash==='string'&&hashPattern.test(input.tokenHash),'INVALID_METADATA');
          const permission=secureRoutes.claim(input.grant,action[1],'reissue');
          const doc=await auth.rotate(action[1],permission.generation,input.tokenHash,false,
            manager?tx=>manager.audit(permission.actor,'LINK_REISSUED',action[1],tx):undefined);
          relay.cancelDocument(action[1]);
          return json(res,await agentDto(doc));
        }
        assert(typeof input.ok==='boolean','INVALID_INPUT');
        relay.cancelDocument(action[1]);
        await db.deletion(action[1],input.ok);
        return json(res,{ok:true});
      }
      const match=/^\/api\/v1\/requests\/([\w-]{1,100})$/.exec(path);
      if (req.method==='GET'&&match) {
        const doc=await db.request(match[1]);
        assert(doc&&doc.agent_id===agentId,'REQUEST_NOT_FOUND',404);
        const result=await agentDto(doc);
        return json(res,result,result.status==='PENDING'?202:200);
      }
      throw new PhaseError('NOT_FOUND',404);
    } catch(error) { errorResponse(res,error); }
  });
  const relay=attachRelay(tls,{db,keys,clock:localClock});
  const secureRoutes=phase3?phase3Routes({db,auth,relay,keys,origin,adminHeader,audit:manager?.audit}):null;
  await new Promise((resolve,reject)=>{tls.once('error',reject);tls.listen(tlsPort,'127.0.0.1',resolve);});
  // Local PoC cleanup is invoked on startup and on the Agent test job.
  await db.cleanup();
  const testDelay=integer('PGS_LOCAL_ADMIN_SECONDS',900,60,3600);
  async function state() {
    const [records,agent,policy,documentTypes,dashboard]=await Promise.all([db.list(),db.agent(),db.policies(),db.catalog(),managed?db.dashboard():null]);
    return {types:documentTypes,policy,dashboard,patientDigits,authPolicy:phase3?authPolicy:undefined,agent:{id:agentId,online:relay.stats().online,lastSeenAt:agent.last_seen_at?iso(agent.last_seen_at):null},
      documents:records.map(managerDocument)};
  }
  const managerDocument=doc=>({
        id:doc.document_id,requestId:doc.request_id,name:doc.doc_title,type:doc.doc_type,size:Number(doc.file_size),agentId:doc.agent_id,
        ...(!managed?{patientNo:doc.patient_key?'•••••••':'—'}:{}),
        registeredAt:iso(doc.registered_at),expiresAt:iso(doc.expires_at),deleteAt:iso(doc.delete_at),
        status:active(doc)?'ACTIVE':doc.status==='READY'?'EXPIRED':doc.status,
        viewUrl:!phase3&&active(doc)?link(doc):undefined,urlReady:active(doc),available:active(doc)&&relay.stats().online,
      });
  async function route(req,res,path) {
    const get=req.method==='GET',post=req.method==='POST';
    if(get&&path==='/mock/profile') {json(res,{mode:phase3?'phase3':'phase2',agentOrigin,delphi,managed});return true;}
    if(manager&&path.startsWith('/api/v1/manager/')){
      if(get&&path==='/api/v1/manager/documents'){
        await adminHeader(req);
        const params=new URL(req.url,origin).searchParams;
        const read=key=>params.get(key)||null;
        const from=read('from'),to=read('to'),type=read('type'),status=read('status'),
          document=read('document')?.toLowerCase()??null,agent=read('agent'),page=Number(params.get('page')??0);
        const validDate=value=>!value||(/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&iso(Date.parse(value)).slice(0,10)===value&&value>='0001-01-01');
        assert(validDate(from)&&validDate(to)&&(!from||!to||from<=to)&&(!type||/^G\d{3}$/.test(type))&&
          (!status||['ACTIVE','EXPIRED','REVOKED','DELETED','REGISTERING','FAILED','DELETE_FAILED'].includes(status))&&
          (!document||/^[a-f0-9-]{1,36}$/.test(document))&&(!agent||uuid.test(agent))&&
          Number.isSafeInteger(page)&&page>=0&&page<=1000000,'INVALID_INPUT');
        const rows=await db.filterDocuments({from,to,type,status,document,agent,page});
        json(res,{documents:rows.slice(0,50).map(managerDocument),more:rows.length>50});return true;
      }
      if(get&&path==='/api/v1/manager/audit'){
        await adminHeader(req,['SYSTEM']);json(res,{events:await manager.events(),users:await manager.users()});return true;
      }
      if(post&&path==='/api/v1/manager/types'){
        assert(req.headers.origin===origin,'FORBIDDEN',403);
        const who=await adminHeader(req,['SYSTEM']);
        await db.saveType(await body(req,4096),who.username);
        json(res,{ok:true});return true;
      }
      await manager.handle(req,res,path);return true;
    }
    if(delphi&&post&&path==='/api/v1/agent/maintenance-grant'){
      assert(req.headers.origin===origin,'FORBIDDEN',403);
      const who=await adminHeader(req,['SYSTEM','OPERATOR']);
      const input=await body(req,1024);
      const operation=input.operation??'purge';
      assert(['purge','retry','inspect'].includes(operation)&&(operation==='purge'||typeof input.requestId==='string'&&requestPattern.test(input.requestId)),'INVALID_REQUEST');
      json(res,{grant:signEnvelope(keys.grant,{purpose:'agent-maintenance',operation,requestId:input.requestId,actor:who.username,exp:localClock()+120000})});return true;
    }
    if(phase3&&(path.startsWith('/api/v1/patient/')||path.startsWith('/mock/patient/')||/^\/(?:api\/v1|mock)\/documents\/[^/]+\/(?:reissue|replace|revoke|link)$/.test(path))){ await secureRoutes.handle(req,res,path);return true; }
    if(get&&path==='/mock/health') {json(res,{mode:'phase2',relay:relay.stats(),rssBytes:process.memoryUsage().rss});return true;}
    if(get&&path==='/mock/state') {const user=await adminHeader(req);json(res,{...await state(),...(manager?{user}:{})});return true;}
    if(get&&path==='/mock/config') {
      json(res,{policy:(await db.policies()).policies.find(policy=>policy.code==='DEFAULT'),maxRetentionDays:90,deleteIntervalMinutes:10});
      return true;
    }
    if (post&&path==='/mock/policy') {
      if(phase3) assert(req.headers.origin===origin,'FORBIDDEN',403);
      const who=await adminHeader(req,['SYSTEM']);
      const data=await body(req);
      await db.changePolicy(data.code,data.retentionDays,data.validityDays,who.username);
      json(res,await db.policies());return true;
    }
    if (post&&path==='/mock/search') {
      if(phase3) assert(req.headers.origin===origin,'FORBIDDEN',403);
      assert(!managed,'NOT_FOUND',404);
      await adminHeader(req);
      const {patientNo}=await body(req);
      assert(typeof patientNo==='string'&&patientPattern.test(patientNo),'INVALID_INPUT');
      const legacy=legacyPatientNo(patientNo);
      const matches=await Promise.all((legacy?[patientNo,legacy]:[patientNo]).map(number=>db.search(mac(keys.subject,'patient:'+number))));
      json(res,{ids:matches.flat().map(row=>row.document_id)});return true;
    }
    const adminAction=adminPattern.exec(path);
    if (adminAction) {
      await adminHeader(req,['SYSTEM','OPERATOR']);
      const [,id,action]=adminAction;
      assert(uuid.test(id),'DOCUMENT_NOT_FOUND',404);
      if (get&&action==='pdf') {
        const doc=await db.docById(id);
        assert(doc,'DOCUMENT_NOT_FOUND',404);
        await relay.stream(db.active(doc),res,false,undefined,undefined,phase3?'ADMIN_PREVIEW':undefined);return true;
      }
      if (post&&action!=='pdf') {
        await body(req);
        await db.modify(id,action);
        relay.cancelDocument(id);
        json(res,{status:'OK'});return true;
      }
    }
    if (post&&path==='/mock/patient/verify') {
      const {token:raw,birthDate}=await body(req);
      assert(typeof raw==='string'&&typeof birthDate==='string','INVALID_INPUT');
      const session=await db.verify(raw,birthDate);
      res.setHeader('Set-Cookie','pgs_phase2_patient='+session+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=900');
      json(res,{status:'VERIFIED'});return true;
    }
    if (get&&path==='/mock/patient/outage') throw new PhaseError('SERVICE_UNAVAILABLE',503);
    if (get&&path==='/mock/patient/detail') {
      const doc=await db.patient(getCookie(req,'pgs_phase2_patient'));
      json(res,{name:doc.doc_title,expiresAt:iso(doc.expires_at)});return true;
    }
    if(get&&['/api/v1/patient/pdf','/api/v1/patient/download','/mock/patient/pdf','/mock/patient/download'].includes(path)){
      const doc=await db.patient(getCookie(req,'pgs_phase2_patient'));
      await relay.stream(doc,res,path.endsWith('/download'),epoch(doc.session_expires_at));return true;
    }
    if (path.startsWith('/mock/')||path.startsWith('/api/')) throw new PhaseError(path==='/api/v1/documents'?'AGENT_TLS_REQUIRED':'NOT_FOUND',path==='/api/v1/documents'?403:404);
    return false;
  }
  return {route,agentOrigin,adminCookie:manager?null:'pgs_local_admin='+admin+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+testDelay+(origin.startsWith('https:')?'; Secure':''),
    close:async()=>{tls.closeAllConnections();tls.close(); await db.sql.close();}};
}
