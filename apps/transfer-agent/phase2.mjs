import {acquireAgentInstance,registration,internalRegistration,internalResponse,readIntake} from './delphi.mjs';
import {resolve} from 'node:path';
import { phase3,birthProof,linkVault,readEnvelope } from '../phase3/crypto.mjs';
import { createServer } from 'node:http';
import { request,createServer as createHttpsServer } from 'node:https';
import { isIPv4 } from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomUUID,randomBytes } from 'node:crypto';
import { openStorage } from './storage.mjs';
import { connectAgent } from '../phase2/relay.mjs';
import { parseFilename,defaultRules } from './filename.ts';
import { MockPatientProvider,currentPatientNo } from './patient.ts';
import { samplePdf } from '../../scripts/fixture.mjs';
import { agentId,agentPort,agentOrigin,relayOrigin,webOrigin,publicOrigin,assert,body,errorResponse,headers,json,mac,sha,maxPdf,requestPattern,
  requireLocal,secret,localGuard,localClock,iso,PhaseError,integer,token,equal,bearer,uuid } from '../phase2/common.mjs';

localGuard();
const phase4=phase3&&process.env.PGS_PHASE4==='1';
const managed=phase4&&process.env.PGS_PHASE5B==='1';
const {PDFDocument}=requireLocal('pdf-lib');
const storage=await openStorage(process.env.PGS_STORAGE_DIR ?? '.local/phase2/agent',localClock,phase3,phase4,managed);
if(phase4)acquireAgentInstance(storage.db);
const intake=phase4&&process.env.PGS_INTAKE_DIR?resolve(process.env.PGS_INTAKE_DIR):resolve(storage.root,'Incoming');
function record(event,code){
  if(!phase4)return;
  storage.db.prepare('INSERT INTO pgs_intake_event(at,event,code) VALUES(?,?,?)').run(iso(localClock()),event,code);
  storage.db.exec('DELETE FROM pgs_intake_event WHERE id<=(SELECT max(id)-1000 FROM pgs_intake_event)');
}
record('AGENT','STARTED');
const birthKeyVersions=new Set(JSON.parse(process.env.PGS_BIRTH_KEY_VERSIONS??'[]'));
const ca=await readFile(process.env.PGS_TLS_CERT ?? '.local/phase2/tls/cert.pem');
const keys={agent:secret('PGS_AGENT_SECRET'),proof:secret('PGS_PROOF_SECRET'),subject:secret('PGS_SUBJECT_SECRET')};
const vault=phase3?linkVault(storage,secret('PGS_VAULT_SECRET')):null;
const grantKey=phase3?secret('PGS_GRANT_SECRET'):null;
const hisToken=phase3?secret('PGS_HIS_SECRET'):null;
const internalKey=phase4?(process.env.PGS_INTERNAL_API_KEY?secret('PGS_INTERNAL_API_KEY'):hisToken):null;
const birthVersion=phase3?integer('PGS_BIRTH_KEY_VERSION',2,2):1;
const birthKey=phase3&&!phase4?(JSON.parse(process.env.PGS_BIRTH_KEYS??'{}')[birthVersion]??secret('PGS_BIRTH_SECRET')):null;
if(phase3)birthKeyVersions.add(birthVersion);
const legacyKey=phase3?secret('PGS_LINK_SECRET'):null;
const sample=samplePdf(), revised=samplePdf(true);
const approved=new Set([sha(sample),sha(revised),sha(samplePdf(false,83503))]);
const parser={
  ...defaultRules,
  patientDigits:integer('PGS_FILENAME_PATIENT_DIGITS',defaultRules.patientDigits,1,32),
  suffix:process.env.PGS_FILENAME_SUFFIX_PATTERN??defaultRules.suffix,
  mapping:JSON.parse(process.env.PGS_FILENAME_TYPE_MAP??'{"a01":"G001","a02":"G002"}'),
};
assert(parser.mapping && typeof parser.mapping==='object' && !Array.isArray(parser.mapping),'INVALID_RULE');
new RegExp(parser.suffix);
const fixtures={
  normal:'0100111120261124a01.pdf','bad-name':'bad.pdf',missing:'9999999920261124a01.pdf',
  oracle:'0100111120261124a01.pdf',transfer:'0100111120261124a01.pdf',revision:'0100111120261124a01.pdf',
};
const jobs=new Map();
const locks=new Set();
const registrations=new Map();
const base='/mock/internal/v1/requests';

function call(path,data) {
  const payload=data===undefined?undefined:Buffer.from(JSON.stringify(data));
  return new Promise((resolve,reject)=>{
    const req=request(relayOrigin+path,{ca,method:payload?'POST':'GET',headers:{Authorization:'Bearer '+keys.agent,'X-Agent-Id':agentId,
      ...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{})}},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('error',reject);
      res.on('end',()=>{
        try {
          const response=JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode>=400) reject(new PhaseError(response.code,res.statusCode));
          else resolve(response);
        } catch { reject(new PhaseError('TRANSFER_UNAVAILABLE',503)); }
      });
    });
    req.setTimeout(8000,()=>req.destroy(new PhaseError('TRANSFER_UNAVAILABLE',503)));
    req.on('error',error=>reject(error instanceof PhaseError?error:new PhaseError('TRANSFER_UNAVAILABLE',503)));
    req.end(payload);
  });
}
function metadata(item) {
  return {
    documentId:item.document_id,agentId,requestId:item.request_id,documentCode:item.doc_type,
    fileSize:item.size,fileHash:item.hash,createdAt:item.created_at,patientKey:item.patient_key,birthVerify:item.birth_verify,
    ...(phase3?{tokenHash:vault.hash(item.document_id,1),birthSalt:item.birth_salt,keyVersion:item.birth_key_version}:{}),
    ...(item.requested_retention_days?{requestedRetentionDays:item.requested_retention_days}:{}),
  };
}
function recoverUrl(data) {
  if (!phase3) return data;
  const {tokenHash,generation,legacyLink,...safe}=data;
  if(data.status!=='READY') return safe;
  let raw=vault.read(data.documentId,generation);
  const legacy=!raw && legacyLink;
  if(legacy) raw=Buffer.from(mac(legacyKey,data.documentId+':'+generation),'hex').toString('base64url');
  assert(raw&&equal(sha(raw),tokenHash),'LINK_SYNC_PENDING',503);
  return {...safe,viewUrl:publicOrigin+(legacy?'/v/':'/g/')+raw};
}
async function setupLink(item){
  if(!item.birth_salt){
    assert(!phase4,'AUTH_PROOF_REQUIRED',409);
    const {birthDate}=await inspectPatient(item.original_filename);
    const salt=randomBytes(32).toString('hex');
    storage.db.prepare('UPDATE document SET birth_verify=?, birth_salt=?,birth_key_version=? WHERE document_id=?')
      .run(birthProof(birthKey,item.document_id,salt,birthDate),salt,birthVersion,item.document_id);
    item=storage.byId(item.document_id);
  }
  vault.prepare(item.document_id,1,token);
  return item;
}
async function publish(item) {
  const current=storage.byId(item.document_id);
  if(current?.state==='READY')return result(current.request_id);
  if(current)item=current;
  try {
    let policy;
    if(phase3&&!item.birth_salt){
      try {policy=await call('/api/v1/requests/'+item.request_id);}
      catch(error){if(error.status!==404) throw error;}
    }
    if(!policy){
      if(phase3) item=await setupLink(item);
      policy=await call('/api/v1/documents',metadata(item));
    }
    storage.setPolicy(item.document_id,policy);
    const result=await call('/api/v1/documents/'+item.document_id+'/activate',{});
    const outcome=recoverUrl(result);
    storage.ready(item.document_id);
    return outcome;
  } catch(error) {
    storage.retry(item.document_id,error.message);
    throw error;
  }
}
async function syncDeleted() {
  for (const item of storage.pending()) {
    await call('/api/v1/documents/'+item.document_id+'/deleted',{ok:item.state==='DELETED'});
    storage.synced(item.document_id);
  }
}
let syncing=false;
async function recoverPending(forceId) {
  if (syncing) return;
  syncing=true;
  try {
    await syncDeleted();
    for (const item of storage.recoverable()) {
      if (phase4&&!item.birth_salt) continue;
      if (item.request_id!==forceId && jobs.get(item.request_id)?.scenario==='transfer') continue;
      if (!['LOCAL_SAVED','REGISTERING','RETRY_PENDING'].includes(item.state) || !item.local_path || locks.has(item.request_id)) continue;
      if (item.last_error_code==='LOCAL_WRITE_FAILED' || item.last_error_code==='LOCAL_FILE_UNAVAILABLE') continue;
      locks.add(item.request_id);
      try {
        let file;
        try {file=await storage.readChecked(item);await file.close();}
        catch {storage.retry(item.document_id,'LOCAL_FILE_UNAVAILABLE');continue;}
        await publish(item);
      }
      catch(error) {
        if(!phase4)throw error;
        record('RECOVERY',error instanceof PhaseError&&/^[A-Z_]+$/.test(error.message)?error.message:'SERVICE_UNAVAILABLE');
      }
      finally {locks.delete(item.request_id);}
    }
  } finally {syncing=false;}
}
await storage.recover();
const connection=connectAgent({url:relayOrigin.replace('https:','wss:')+'/api/v1/agent/connect',ca,keys,storage,clock:localClock,onReady:recoverPending});
async function inspectPatient(filename) {
  const parsed=parseStoredFilename(filename);
  return new MockPatientProvider().find(currentPatientNo(parsed.patientNo));
}
function parseStoredFilename(filename) {
  try { return parseFilename(filename,parser); }
  catch(error) {
    if(parser.patientDigits!==8) throw error;
    const old=parseFilename(filename,{...parser,patientDigits:7});
    if(currentPatientNo(old.patientNo)===old.patientNo) throw error;
    return old;
  }
}
async function inspect(filename,buffer,outage=false) {
  let parsed;
  try { assert(typeof filename==='string','INVALID_FILENAME'); parsed=parseFilename(filename,parser); } catch { throw new PhaseError('INVALID_FILENAME'); }
  assert(parsed.documentCode,'UNMAPPED_SUFFIX');
  await validatePdf(buffer);
  try { return {...parsed,...await new MockPatientProvider(outage?'outage':'default').find(parsed.patientNo)}; }
  catch(error) { throw new PhaseError(error.message,error.message==='ORACLE_UNAVAILABLE'?503:400); }
}
async function validatePdf(buffer){
  assert(buffer.length<=maxPdf,'TOO_LARGE',413);
  assert(buffer.length>0 && buffer.subarray(0,5).toString()==='%PDF-','INVALID_PDF',415);
  try { const pdf=await PDFDocument.load(buffer,{throwOnInvalidObject:true,updateMetadata:false}); assert(pdf.getPageCount()>0,'INVALID_PDF',415); }
  catch { throw new PhaseError('INVALID_PDF',415); }
  assert(approved.has(sha(buffer)),'USE_SYNTHETIC_PDF',415);
}
function bufferFrom(value) {
  assert(typeof value==='string' && value.length<=Math.ceil(maxPdf/3)*4,'TOO_LARGE',413);
  assert(/^[\w+/]*={0,2}$/.test(value) && value.length%4===0,'INVALID_PDF',415);
  return Buffer.from(value,'base64');
}
async function register({id,filename,file,oracle=false,transfer=false}) {
  const fingerprint=sha(file);
  const matching=registrations.get(id);
  if (matching) {
    assert(matching.filename===filename && matching.fingerprint===fingerprint,'REQUEST_CONFLICT',409);
    return matching.work;
  }
  const work=registerOnce({id,filename,file,oracle,transfer,fingerprint});
  registrations.set(id,{filename,fingerprint,work});
  try { return await work; }
  finally { registrations.delete(id); }
}
async function registerOnce({id,filename,file,oracle,transfer,fingerprint}) {
  assert(!locks.has(id),'REQUEST_BUSY',409);
  locks.add(id);
  try {
    let item=storage.get(id);
    if (item) {
      assert(item.hash===fingerprint && item.original_filename===filename,'REQUEST_CONFLICT',409);
      if (item.state==='READY') return result(id);
      assert(!['DELETED','DELETING','DELETE_FAILED'].includes(item.state),'LINK_UNAVAILABLE',410);
      if (['LOCAL_WRITE_FAILED','LOCAL_FILE_UNAVAILABLE'].includes(item.last_error_code)) item=await storage.write(item,file);
    } else {
      const parsed=await inspect(filename,file,oracle);
      const documentId=randomUUID();
      // File name contains only a calendar date. Registration uses its own clock.
      item=await storage.save({documentId,requestId:id,filename,fileHash:fingerprint,documentCode:parsed.documentCode,
        createdAt:iso(localClock()),patientKey:mac(keys.subject,'patient:'+parsed.patientNo),birthVerify:mac(keys.subject,documentId+':'+parsed.birthDate)},file);
    }
    if (transfer) {storage.retry(item.document_id,'TRANSFER_UNAVAILABLE'); throw new PhaseError('TRANSFER_UNAVAILABLE',503);}
    return publish(item);
  } finally {locks.delete(id);}
}
async function registerDelphi(input){
  const id=input.requestId;
  const descriptor=[input.documentId,input.fileName,input.fileSha256,input.documentCode,input.patientNo??null,input.birthSalt,input.birthVerify,input.keyVersion];
  if(input.retentionDays!==undefined)descriptor.push(input.retentionDays);
  const fingerprint=sha(JSON.stringify(descriptor));
  const pending=registrations.get(id);
  if(pending){
    assert(pending.fingerprint===fingerprint,'REQUEST_CONFLICT',409);
    return {created:false,data:(await pending.work).data};
  }
  assert(!locks.has(id),'REQUEST_BUSY',409);
  locks.add(id);
  const work=(async()=>{
    let existing=storage.get(id);
    const created=!existing;
    if(existing){
      assert(existing.integration_fingerprint===fingerprint,'REQUEST_CONFLICT',409);
      if(existing.state==='READY'||['DELETED','DELETING','DELETE_FAILED'].includes(existing.state))return {created,data:await result(id)};
    }else{
      assert(!storage.byId(input.documentId),'DOCUMENT_CONFLICT',409);
      if(managed){
        let catalog;
        try {catalog=(await call('/api/v1/agent/catalog')).types;}
        catch(error){if(error.status!==503||!['G001','G002'].includes(input.documentCode))throw error;}
        if(catalog)assert(catalog.some(type=>type.code===input.documentCode&&type.enabled),'INVALID_DOCUMENT_CODE');
      }
    }
    if(!existing||['WRITING'].includes(existing.state)||['LOCAL_WRITE_FAILED','LOCAL_FILE_UNAVAILABLE'].includes(existing.last_error_code)){
      const file=await readIntake(intake,input.fileName,input.fileSha256);
      await validatePdf(file);
      if(existing)existing=await storage.write(existing,file);
      else{
        assert(!storage.byId(input.documentId),'DOCUMENT_CONFLICT',409);
        existing=await storage.save({documentId:input.documentId,requestId:id,filename:input.fileName,fileHash:input.fileSha256,
          documentCode:input.documentCode,createdAt:iso(localClock()),patientKey:mac(keys.subject,input.patientNo?'patient:'+input.patientNo:'document:'+input.documentId),
          birthVerify:input.birthVerify,birthSalt:input.birthSalt,keyVersion:input.keyVersion,retentionDays:input.retentionDays,integrationFingerprint:fingerprint},file);
      }
    }
    try{return {created,data:await publish(existing)};}
    catch(error){
      if(error.status!==503)throw error;
      return {created,data:{requestId:id,status:'RETRY_WAIT'}};
    }
  })();
  registrations.set(id,{fingerprint,work});
  try{return await work;}
  finally{registrations.delete(id);locks.delete(id);}
}
async function result(id) {
  const item=storage.get(id), work=jobs.get(id);
  if (item?.state==='READY') return recoverUrl(await call('/api/v1/requests/'+id));
  if (work?.status==='FAILED') return {requestId:id,status:'FAILED',errorCode:work.error};
  if (item && ['DELETED','DELETING','DELETE_FAILED'].includes(item.state)) return {requestId:id,status:'FAILED',errorCode:'LINK_UNAVAILABLE'};
  if (item?.state==='RETRY_PENDING' || work?.status==='RETRY_WAIT') return {requestId:id,status:'RETRY_WAIT'};
  if (item || work) return {requestId:id,status:'PENDING'};
  throw new PhaseError('REQUEST_NOT_FOUND',404);
}
function list() {
  const persisted=storage.list();
  const ids=new Set(persisted.map(item=>item.request_id));
  const durable=persisted.map(item=>{
    let parsed;
    try {parsed=parseStoredFilename(item.original_filename??'');} catch {}
    const status=item.state==='READY' && Date.parse(item.expires_at)<=localClock() ? 'EXPIRED' : {READY:'READY',RETRY_PENDING:'RETRY_WAIT',FAILED:'FAILED',DELETED:'FAILED',DELETING:'PROCESSING',DELETE_FAILED:'FAILED'}[item.state]??'PENDING';
    return {id:item.request_id,documentId:item.document_id,type:item.doc_type,patientNo:parsed?'••••'+parsed.patientNo.slice(-3):'—',
      status,storageState:item.state,stage:status==='READY'?4:2,error:item.last_error_code,at:item.staged_at,
      ...(managed?{fileLabel:item.original_filename?'••••.pdf':null,size:item.size,sha256:item.hash,retries:item.retry_count,
        registeredAt:item.registered_at,processingMs:item.registered_at?Math.max(0,Date.parse(item.registered_at)-Date.parse(item.staged_at)):null,
        fileStatus:item.last_error_code==='LOCAL_FILE_UNAVAILABLE'?'ERROR':item.local_path&&item.state!=='WRITING'?'VERIFIED':item.state==='DELETED'?'DELETED':'PENDING'}:{}),
      expiresAt:item.expires_at,deleteAt:item.delete_at,urlReady:status==='READY'&&Date.parse(item.expires_at)>localClock()};
  });
  const transient=[...jobs.values()].filter(job=>!ids.has(job.id)).map(job=>({
    id:job.id,status:job.status,stage:job.stage,error:job.error,at:job.at,patientNo:'—',
  }));
  return [...transient,...durable].sort((a,b)=>b.at.localeCompare(a.at));
}
async function manageDocument(req,res){
  assert(req.headers.origin===webOrigin,'FORBIDDEN',403);
  const {grant}=await body(req,2048);
  const claim=readEnvelope(grantKey,grant,'agent-maintenance',localClock());
  assert(['retry','inspect'].includes(claim.operation)&&typeof claim.requestId==='string'&&requestPattern.test(claim.requestId),'FORBIDDEN',403);
  const item=storage.get(claim.requestId);
  assert(item,'REQUEST_NOT_FOUND',404);
  if(claim.operation==='retry'){
    assert(item.integration_fingerprint&&['RETRY_PENDING','LOCAL_SAVED','REGISTERING'].includes(item.state),'REQUEST_NOT_RETRYABLE',409);
    assert(!locks.has(item.request_id),'REQUEST_BUSY',409);
    locks.add(item.request_id);
    try{
      const file=await storage.readChecked(item);
      await file.close();
      const result=await publish(item);
      record('MANUAL_RETRY',result.status);
      return json(res,{status:result.status});
    }finally{locks.delete(item.request_id);}
  }
  let fileStatus,remoteStatus,issuedAt,consistent=null;
  try {const file=await storage.readChecked(item);await file.close();fileStatus='VERIFIED';}
  catch(error){fileStatus=error.code==='ENOENT'?'MISSING':'INTEGRITY_ERROR';}
  try{
    const remote=await call('/api/v1/requests/'+item.request_id);
    remoteStatus=remote.status;
    issuedAt=remote.issuedAt;
    consistent=remote.documentId===item.document_id&&remote.expiresAt===item.expires_at&&
      (item.state==='READY'?remote.status==='READY':remote.status!=='READY');
  }catch(error){remoteStatus=error.status===404?'NOT_REGISTERED':'UNAVAILABLE';if(error.status===404&&item.state==='READY')consistent=false;}
  record('DOCUMENT_INSPECT',fileStatus);
  return json(res,{fileStatus,remoteStatus,issuedAt,consistent});
}
function metricsForAgent(){
  const now=localClock(),today=iso(Math.floor((now+9*3600000)/86400000)*86400000-9*3600000);
  return storage.db.prepare(`SELECT
    coalesce((SELECT requests FROM pgs_intake_daily WHERE day=date(?, '+9 hours')),0) today,
    coalesce((SELECT errors FROM pgs_intake_daily WHERE day=date(?, '+9 hours')),0) failed,
    count(*) FILTER(WHERE staged_at>=? AND state='READY') completed,
    count(*) FILTER(WHERE state IN ('LOCAL_SAVED','REGISTERING','WRITING','RETRY_PENDING')) pending,
    count(*) FILTER(WHERE state='READY' AND expires_at>?) active,
    count(*) FILTER(WHERE state='READY' AND expires_at>? AND expires_at<=?) expiring
    FROM document`).get(today,today,today,iso(now),iso(now),iso(now+7*86400000));
}
function startScenario(input) {
  const id=input.requestId??randomUUID();
  assert(typeof id==='string' && requestPattern.test(id),'INVALID_REQUEST');
  assert(Object.hasOwn(fixtures,input.scenario),'INVALID_SCENARIO');
  const filename=input.filename??fixtures[input.scenario];
  const file=input.pdf===undefined?(input.scenario==='revision'?revised:sample):bufferFrom(input.pdf);
  const old=jobs.get(id);
  if (old) {
    assert(old.filename===filename && sha(old.file)===sha(file) && old.scenario===input.scenario,'REQUEST_CONFLICT',409);
  } else {
    const prior=storage.get(id);
    if (prior) assert(prior.original_filename===filename&&prior.hash===sha(file),'REQUEST_CONFLICT',409);
    else jobs.set(id,{id,filename,file,scenario:input.scenario,stage:0,status:'PENDING',at:iso(localClock())});
  }
  return id;
}
async function advance(id,retry) {
  const job=jobs.get(id);
  const item=storage.get(id);
  if (retry) {
    if (job?.status==='RETRY_WAIT') {job.status='PENDING';job.error=undefined;job.retried=true; return;}
    if (item?.state==='RETRY_PENDING') return recoverPending(id);
    throw new PhaseError('NOT_RETRYABLE',409);
  }
  if (!job || job.status!=='PENDING' || job.advancing) return;
  job.advancing=true;
  try {
    if (job.stage===0) {parseFilename(job.filename,parser);job.stage=1;return;}
    if (job.stage===1) {
      await inspect(job.filename,job.file,job.scenario==='oracle'&&!job.retried);
      job.stage=2;
      return;
    }
    if (job.stage===2) {
      await register({id,filename:job.filename,file:job.file,transfer:job.scenario==='transfer'&&!job.retried});
      jobs.delete(id);
    }
  } catch(error) {
    job.error=error.message;
    job.status=error.status===503?'RETRY_WAIT':'FAILED';
  } finally {job.advancing=false;}
}
function fixture(res,bytes) {
  res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':bytes.length,
    'Content-Disposition':'attachment; filename="0100111120261124a01.pdf"'});
  res.end(bytes);
}
const internalPrefix='/api/v1/internal/';
async function handleInternal(req,res,path,host){
  headers(res);
  let identifiers={};
  let registering=false;
  try {
    assert(req.headers.host===host&&!req.headers.origin,'FORBIDDEN',403);
    assert(equal(req.headers['x-api-key']??'',internalKey),'AUTH_REQUIRED',401);
    const route=path.slice(internalPrefix.length);
    if(route==='health'){
      assert(req.method==='GET','METHOD_NOT_ALLOWED',405);
      return json(res,internalResponse({agent:'ONLINE',relay:connection.report().online?'ONLINE':'OFFLINE'}));
    }
    let data,created=false;
    if(route==='documents'){
      assert(req.method==='POST','METHOD_NOT_ALLOWED',405);
      registering=true;
      const input=internalRegistration(await body(req,4096),birthKeyVersions,parser.patientDigits);
      identifiers={requestId:input.requestId,documentId:input.documentId};
      ({data,created}=await registerDelphi(input));
    }else{
      const parts=/^(requests|documents)\/([^/]+)$/.exec(route);
      assert(parts,'NOT_FOUND',404);
      assert(req.method==='GET','METHOD_NOT_ALLOWED',405);
      if(parts[1]==='documents'){
        assert(uuid.test(parts[2]),'INVALID_REQUEST');
        identifiers={documentId:parts[2]};
        const doc=storage.byId(parts[2]);
        assert(doc,'REQUEST_NOT_FOUND',404);
        identifiers.requestId=doc.request_id;
      }else{
        assert(requestPattern.test(parts[2]),'INVALID_REQUEST');
        identifiers={requestId:parts[2],documentId:storage.get(parts[2])?.document_id};
      }
      data=await result(identifiers.requestId);
    }
    if(registering)record('REGISTER',data.status);
    const pending=['PENDING','PROCESSING','RETRY_WAIT'].includes(data.status);
    const failed=data.status==='FAILED';
    if(pending)res.setHeader('Retry-After','3');
    return json(res,internalResponse({...identifiers,...data},failed?'LINK_UNAVAILABLE':pending?'ACCEPTED':'OK',!failed),
      failed?410:pending?202:created?201:200);
  }catch(error){
    const known=error instanceof PhaseError;
    const code=known?error.message:'SERVICE_UNAVAILABLE';
    if(registering)record('REGISTER',code);
    if(!res.destroyed&&!res.headersSent)json(res,internalResponse(identifiers,code,false),known?error.status:503);
  }
}
const server=createServer(async (req,res)=>{
  headers(res);
  let intakeRequest=false;
  try {
    const path=new URL(req.url,agentOrigin).pathname;
    if(phase4&&path.startsWith(internalPrefix))return await handleInternal(req,res,path,new URL(agentOrigin).host);
    assert(req.headers.host===new URL(agentOrigin).host && (!req.headers.origin || req.headers.origin===webOrigin),'LOCAL_ONLY',403);
    if (req.headers.origin===webOrigin) {
      res.setHeader('Access-Control-Allow-Origin',webOrigin);
      res.setHeader('Vary','Origin');
    }
    if(req.method==='OPTIONS'){
      if(phase4&&req.url.startsWith('/internal/v1/'))throw new PhaseError('FORBIDDEN',403);
      res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type');
      res.writeHead(204);res.end();return;
    }
    const post=req.method==='POST', get=req.method==='GET';
    if(managed&&post&&path==='/mock/agent-document')return await manageDocument(req,res);
    if (get&&path==='/mock/agent-state') return json(res,{requests:list(),connection:connection.report(),storage:await storage.metrics(),
      ...(managed?{dashboard:metricsForAgent()}:{}),
      events:phase4?storage.db.prepare('SELECT * FROM pgs_intake_event ORDER BY id DESC LIMIT 100').all():undefined,
      rssBytes:process.memoryUsage().rss,settings:{maxPdf,intake,folder:storage.root,format:parser.patientDigits+'자리 + YYYYMMDD + '+parser.suffix,mapping:parser.mapping,api:'/internal/v1/requests',retry:'영속 요청 ID로 재시도'}});
    if (get&&path==='/mock/agent-transfers') return json(res,{requests:list().map(({id,status,error,at})=>({id,status,error,at}))});
    if (get&&path==='/mock/sample') return fixture(res,sample);
    if (get&&path==='/mock/sample-revision') return fixture(res,revised);
    if (!phase4&&post&&path==='/mock/inspect') {
      const data=await body(req,Math.ceil(maxPdf/3)*4+2048);
      const {birthDate,...safe}=await inspect(data.filename,bufferFrom(data.pdf));
      return json(res,phase3?safe:{...safe,birthDate});
    }
    if(phase4 && path.startsWith('/internal/v1/')){
      intakeRequest=post&&path==='/internal/v1/documents';
      assert(!req.headers.origin&&equal(bearer(req),hisToken),'FORBIDDEN',403);
      if(get&&path==='/internal/v1/health')return json(res,{agent:'ONLINE',relay:connection.report().online?'ONLINE':'OFFLINE'});
      if(post&&path==='/internal/v1/documents'){
        const input=registration(await body(req,4096),birthKeyVersions,parser.patientDigits);
        const {created,data}=await registerDelphi(input);
        record('REGISTER',data.status);
        return json(res,data,data.status==='READY'?(created?201:200):202);
      }
      const lookup=/^\/internal\/v1\/requests\/([\w-]{1,100})$/.exec(path);
      if(get&&lookup){
        const data=await result(lookup[1]);
        return json(res,data,['PENDING','PROCESSING','RETRY_WAIT'].includes(data.status)?202:200);
      }
      throw new PhaseError('NOT_FOUND',404);
    }
    if(phase3&&path.startsWith('/internal/v1/')) assert(equal(bearer(req),hisToken),'FORBIDDEN',403);
    if(phase3&&post&&path==='/mock/link'){
      assert(req.headers.origin===webOrigin,'FORBIDDEN',403);
      const input=await body(req,2048);
      const info=readEnvelope(grantKey,input.grant,input.operation,localClock());
      assert(['link','reissue'].includes(info.purpose)&&uuid.test(info.id)&&Number.isSafeInteger(info.generation),'FORBIDDEN',403);
      const item=storage.byId(info.id);
      assert(item?.state==='READY','DOCUMENT_NOT_FOUND',404);
      if(info.purpose==='link'){
        const existing=await call('/api/v1/requests/'+item.request_id);
        assert(existing.generation===info.generation,'LINK_CONFLICT',409);
        return json(res,recoverUrl(existing));
      }
      const raw=vault.prepare(info.id,info.generation,token);
      const next=await call('/api/v1/documents/'+info.id+'/reissue',{grant:input.grant,tokenHash:sha(raw)});
      const result=recoverUrl(next);
      vault.forgetBefore(info.id,info.generation);
      return json(res,result);
    }
    if (!phase4&&post&&['/internal/v1/requests','/mock/manual'].includes(path)) {
      if(phase3&&path==='/mock/manual') assert(req.headers.origin===webOrigin,'FORBIDDEN',403);
      const {requestId,filename,pdf}=await body(req,Math.ceil(maxPdf/3)*4+2048);
      assert(typeof requestId==='string'&&requestPattern.test(requestId),'INVALID_REQUEST');
      const registered=await register({id:requestId,filename,file:bufferFrom(pdf)});
      return json(res,registered,201);
    }
    if (!phase4&&post&&path===base) {
      if(phase3) assert(req.headers.origin===webOrigin,'FORBIDDEN',403);
      const input=await body(req,Math.ceil(maxPdf/3)*4+2048);
      const id=startScenario(input);
      return json(res,await result(id),202);
    }
    if (post&&path==='/mock/purge') {
      if(phase4){
        assert(req.headers.origin===webOrigin,'FORBIDDEN',403);
        const claim=readEnvelope(grantKey,(await body(req,2048)).grant,'agent-maintenance',localClock());
        assert(!managed||claim.operation==='purge','FORBIDDEN',403);
      }
      await call('/api/v1/cleanup',{}).catch(()=>{});
      const deleted=await storage.purge();
      for (const [id,job] of jobs) {if (Date.parse(job.at)<=localClock()-30*86400000) jobs.delete(id);}
      await syncDeleted().catch(()=>{});
      return json(res,{deleted});
    }
    if(phase3&&path.startsWith(base)) assert(req.headers.origin===webOrigin,'FORBIDDEN',403);
    const match=/^\/(?:mock\/)?internal\/v1\/requests\/([\w-]{1,100})(?:\/(step|retry))?$/.exec(path);
    if (!phase4&&match && (get&&!match[2] || post&&match[2])) {
      if (post) await advance(match[1],match[2]==='retry');
      const current=await result(match[1]);
      return json(res,current,['PENDING','PROCESSING','RETRY_WAIT'].includes(current.status)?202:200);
    }
    throw new PhaseError('NOT_FOUND',404);
  } catch(error) {
    if(intakeRequest)record('REGISTER',error instanceof PhaseError&&/^[A-Z_]+$/.test(error.message)?error.message:'SERVICE_UNAVAILABLE');
    errorResponse(res,error);
  }
});
let internalTls;
if(phase4&&process.env.PGS_INTERNAL_TLS_HOST){
  const ip=process.env.PGS_INTERNAL_TLS_HOST;
  const port=integer('PGS_INTERNAL_TLS_PORT',4246);
  const allowed=(process.env.PGS_INTERNAL_TLS_ALLOWLIST??'').split(',').map(value=>value.trim()).filter(Boolean);
  const privateIpv4=value=>isIPv4(value)&&/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
  assert(privateIpv4(ip)&&allowed.length>0&&allowed.every(privateIpv4),'INVALID_INTERNAL_TLS_BIND');
  const [cert,key,clientCa]=await Promise.all(['PGS_INTERNAL_TLS_CERT','PGS_INTERNAL_TLS_KEY','PGS_INTERNAL_TLS_CLIENT_CA']
    .map(name=>readFile(process.env[name])));
  internalTls=createHttpsServer({cert,key,ca:clientCa,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'},(req,res)=>{
    let path;
    try {path=new URL(req.url,'https://'+ip+':'+port).pathname;}
    catch {headers(res);return json(res,internalResponse({},'INVALID_REQUEST',false),400);}
    const peer=req.socket.remoteAddress?.replace(/^::ffff:/,'');
    if(!allowed.includes(peer)||!req.socket.authorized||!path.startsWith(internalPrefix)){
      headers(res);
      return json(res,internalResponse({},'FORBIDDEN',false),403);
    }
    return handleInternal(req,res,path,ip+':'+port);
  });
  internalTls.listen(port,ip);
}
server.listen(agentPort,'127.0.0.1',()=>console.log('PGS Agent: '+agentOrigin));
process.on('SIGTERM',()=>{connection.stop();internalTls?.close();server.close(async()=>{if(phase4) storage.db.prepare('DELETE FROM pgs_agent_instance WHERE pid=?').run(process.pid);storage.db.close();process.exit(0);});});
