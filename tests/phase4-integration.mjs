import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,unlink,link,rm} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {request} from 'node:https';
import {createServer} from 'node:http';
import {internalRegistration} from '../apps/transfer-agent/delphi.mjs';
import {DatabaseSync} from 'node:sqlite';
import {samplePdf} from '../scripts/fixture.mjs';
import {birthProof} from '../apps/phase3/crypto.mjs';
import {sha,day} from '../apps/phase2/common.mjs';

const parent=resolve('.local/delphi-tests');
await mkdir(parent,{recursive:true});
const root=await mkdtemp(parent+'/run-');
const dir=resolve(root,'agent'),incoming=resolve(dir,'Incoming');
await mkdir(incoming,{recursive:true});
const web='http://127.0.0.1:4505',agent='http://127.0.0.1:4506';
const env={...process.env,PGS_PHASE2:'1',PGS_PHASE3:'1',PGS_PHASE4:'1',PGS_TEST_AUTH:'1',PGS_WEB_TLS:'0',PGS_PORT:'4505',
 PGS_AGENT_PORT:'4506',PGS_TLS_PORT:'4545',PGS_PGLITE_DIR:resolve(root,'catalog'),PGS_STORAGE_DIR:dir,PGS_HEARTBEAT_MS:'250',
 PGS_TLS_CERT:resolve('.local/phase4/tls/cert.pem'),PGS_TLS_KEY:resolve('.local/phase4/tls/key.pem'),PGS_TEST_DROP_ACTIVATE_FOR:'lost'};
delete env.PGS_DATABASE_URL;
for(const key of ['AGENT','PROOF','SUBJECT','LINK','GRANT','RATE','BIRTH','VAULT','HIS'])env['PGS_'+key+'_SECRET']=randomBytes(32).toString('hex');
env.PGS_INTERNAL_API_KEY=randomBytes(32).toString('hex');
try{await readFile(env.PGS_TLS_CERT);}catch{
 assert.equal(spawnSync('pwsh',['-NoProfile','-File','scripts/local-cert.ps1','-Directory','.local/phase4/tls']).status,0);
}
const children=new Set(),logs=[];
const start=file=>{
 const config={...env};
 if(file.includes('transfer-agent')){
  delete config.PGS_BIRTH_SECRET;delete config.PGS_BIRTH_KEYS;
  Object.assign(config,{PGS_INTERNAL_TLS_HOST:'127.0.0.1',PGS_INTERNAL_TLS_PORT:'4546',PGS_INTERNAL_TLS_ALLOWLIST:'127.0.0.1',
    PGS_INTERNAL_TLS_CERT:env.PGS_TLS_CERT,PGS_INTERNAL_TLS_KEY:env.PGS_TLS_KEY,PGS_INTERNAL_TLS_CLIENT_CA:env.PGS_TLS_CERT});
 }
 const child=spawn(process.execPath,[file],{env:config,stdio:['ignore','pipe','pipe']});
 children.add(child);
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>logs.push(String(chunk)));
 return child;
};
const stop=async child=>{
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;
};
async function until(check){
 for(let i=0;i<150;i++){try{if(await check())return;}catch{}await new Promise(resolve=>setTimeout(resolve,80));}
 throw new Error('Service or recovery timeout');
}
const req=(base,path,{input,headers={}}={})=>fetch(base+path,{method:input===undefined?'GET':'POST',
 headers:{...(input===undefined?{}:{'Content-Type':'application/json'}),...headers},body:input===undefined?undefined:JSON.stringify(input)});
const auth={Authorization:'Bearer '+env.PGS_HIS_SECRET};
const key={'X-API-Key':env.PGS_INTERNAL_API_KEY};
const internal='/api/v1/internal/';
const submit=input=>req(agent,'/internal/v1/documents',{input,headers:auth});
const status=id=>req(agent,'/internal/v1/requests/'+id,{headers:auth});
const online=async()=> (await (await req(agent,'/internal/v1/health',{headers:auth})).json()).relay==='ONLINE';
const bytes=samplePdf();
const input=(requestId,fileName='document.pdf')=>{
 const documentId=randomUUID(),birthSalt=randomBytes(32).toString('hex');
 return {requestId,documentId,fileName,fileSha256:sha(bytes),documentCode:'G001',patientNo:'01001111',birthSalt,
 birthVerify:birthProof(env.PGS_BIRTH_SECRET,documentId,birthSalt,'19550203'),keyVersion:2};
};
const reply=async(response,code)=>{const data=await response.json();assert.equal(response.status,code,data.code);return data;};
const toContract=(source,extra={})=>({requestId:source.requestId,fileName:source.fileName,fileSha256:source.fileSha256,
 documentType:source.documentCode,patientNo:source.patientNo,birthVerifier:{documentId:source.documentId,salt:source.birthSalt,value:source.birthVerify,keyVersion:source.keyVersion},...extra});
const secure=async credentials=>{
 const ca=await readFile(env.PGS_TLS_CERT),privateKey=await readFile(env.PGS_TLS_KEY);
 return new Promise((resolve,reject)=>{
  const req=request('https://127.0.0.1:4546'+internal+'health',{ca,headers:key,...(credentials?{cert:ca,key:privateKey}:{})},
    res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
  req.on('error',reject);req.end();
 });
};
let relay,worker;
try{
 relay=start('apps/api-server/mock/server.mjs');worker=start('apps/transfer-agent/phase2.mjs');
 await until(online);
 await assert.rejects(secure(false));
 assert.equal(await secure(true),200);
 assert.equal((await reply(await req(agent,internal+'health'),401)).resultCode,'AUTH_REQUIRED');
 assert.equal((await reply(await req(agent,internal+'health',{headers:auth}),401)).success,false);
 assert.equal((await reply(await req(agent,internal+'health',{headers:key}),200)).relay,'ONLINE');
 await reply(await req(web,internal+'health',{headers:key}),404);
 await writeFile(resolve(incoming,'document.pdf'),bytes);
 const one=input('normal');
 const standard=input('standard');
 const contract=toContract(standard,{retentionDays:7});
 assert.throws(()=>internalRegistration(contract,new Set([2]),9),/INVALID_PATIENT_NO/);
 assert.equal(internalRegistration({...contract,patientNo:'001001111'},new Set([2]),9).patientNo,'001001111');
 const absent=await reply(await req(agent,internal+'requests/unknown-delphi-request',{headers:key}),404);
 assert.equal(absent.resultCode,'REQUEST_NOT_FOUND');
 assert.equal(absent.guideUrl,null);
 await reply(await req(agent,internal+'documents/'+randomUUID(),{headers:key}),404);
 await reply(await req(agent,internal+'documents',{headers:key,input:{...contract,retentionDays:91}}),400);
 await reply(await req(agent,internal+'documents',{headers:{...key,'Content-Type':'application/json; charset=utf-16'},input:contract}),415);
 const newDoc=await reply(await req(agent,internal+'documents',{headers:{...key,'Content-Type':'application/json; charset=UTF-8'},input:contract}),201);
 assert.equal(newDoc.resultCode,'OK');
 assert.equal(newDoc.success,true);
 assert.equal(newDoc.retentionDays,7);
 assert.equal(Date.parse(newDoc.expiresAt)-Date.parse(newDoc.deleteAt),0);
 const byRequest=await reply(await req(agent,internal+'requests/'+standard.requestId,{headers:key}),200);
 assert.deepEqual(byRequest,newDoc);
 assert.deepEqual(await reply(await req(agent,internal+'documents/'+standard.documentId,{headers:key}),200),newDoc);
 assert.deepEqual(await reply(await req(agent,internal+'documents',{headers:key,input:contract}),200),newDoc);
 await reply(await req(agent,internal+'documents',{headers:key,input:{...contract,retentionDays:8}}),409);
 const standardVerify=await req(web,'/api/v1/patient/verify',{input:{token:newDoc.guideUrl.split('/').at(-1),birthDate:'19550203'},headers:{Origin:web}});
 assert.equal(standardVerify.status,200);
 await reply(await req(agent,'/internal/v1/documents',{input:one}),403);
 await reply(await req(agent,'/internal/v1/documents',{input:one,headers:{...auth,Origin:web}}),403);
 await reply(await req(web,'/internal/v1/documents',{input:one,headers:auth}),404);
 await reply(await req(web,'/internal/v1/health',{headers:auth}),404);
 await reply(await req(agent,'/mock/manual',{input:one}),404);
 await reply(await req(agent,'/mock/automation',{input:one}),404);
 await reply(await submit({...one,birthDate:'19550203'}),400);
 await reply(await submit({...one,keyVersion:999}),400);
 for(const bad of ['../document.pdf','C:\\document.pdf','document.pdf:other','CON.pdf','..\\document.pdf'])await reply(await submit(input('bad-path',bad)),400);
 await writeFile(resolve(root,'outside.pdf'),bytes);
 await link(resolve(root,'outside.pdf'),resolve(incoming,'hardlink.pdf'));
 await reply(await submit(input('unsafe','hardlink.pdf')),403);
 await reply(await submit(input('missing','missing.pdf')),404);
 await reply(await submit({...one,fileSha256:'a'.repeat(64)}),409);
 await writeFile(resolve(incoming,'bad.pdf'),Buffer.from('not a pdf'));
 await reply(await submit({...input('bad','bad.pdf'),fileSha256:sha('not a pdf')}),415);
 const first=await reply(await submit(one),201);
 assert.equal(first.status,'READY');
 assert.equal(first.documentId,one.documentId);
 assert.equal(Date.parse(first.expiresAt)-Date.parse(first.registeredAt),30*day);
 assert.equal(first.deleteAt,first.expiresAt);
 const [year,month,date]=new Date(first.registeredAt).toISOString().slice(0,10).split('-');
 assert.deepEqual(await readFile(resolve(dir,'Storage',year,month,date,first.documentId+'.pdf')),bytes);
 await unlink(resolve(incoming,'document.pdf'));
 assert.deepEqual(await reply(await submit(one),200),first);
 assert.deepEqual(await reply(await status(one.requestId),200),first);
 await reply(await submit({...one,birthVerify:'b'.repeat(64)}),409);
 await reply(await submit({...input('different'),documentId:one.documentId}),409);
 const raw=first.viewUrl.split('/').at(-1);
 assert.match(raw,/^[A-Za-z0-9_-]{43}$/);
 const verify=await req(web,'/api/v1/patient/verify',{input:{token:raw,birthDate:'19550203'},headers:{Origin:web}});
 assert.equal(verify.status,200);
 const cookie=verify.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 await reply(await req(web,'/api/v1/patient/pdf'),401);
 for(const endpoint of ['pdf','download']){
  const response=await req(web,'/api/v1/patient/'+endpoint,{headers:{Cookie:cookie}});
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 }
 await writeFile(resolve(incoming,'document.pdf'),bytes);
 const lost=input('lost');
 const pending=await req(agent,internal+'documents',{headers:key,input:toContract(lost)});
 assert.equal(pending.headers.get('retry-after'),'3');
 assert.equal((await reply(pending,202)).resultCode,'ACCEPTED');
 await until(async()=> (await status('lost')).status===200);
 const recovered=await reply(await status('lost'),200);
 assert.deepEqual(await reply(await submit(lost),200),recovered);
 const timed=toContract(input('client-read-timeout'));
 let forwarded;
 const proxy=createServer((_req,_res)=>{
   forwarded=req(agent,internal+'documents',{headers:key,input:timed});
   // A test-only proxy forwards the request but deliberately withholds the reply.
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 try{
   await assert.rejects(fetch('http://127.0.0.1:'+proxy.address().port+'/',{
     method:'POST',signal:AbortSignal.timeout(500),
   }),error=>error.name==='TimeoutError');
   const committed=await reply(await forwarded,201);
   const reloaded=await reply(await req(agent,internal+'requests/'+timed.requestId,{headers:key}),200);
   assert.deepEqual(reloaded,committed);
   assert.deepEqual(await reply(await req(agent,internal+'documents',{headers:key,input:timed}),200),committed);
 }finally{proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
 await stop(relay);
 const damaged=input('damaged-local-copy');
 await reply(await submit(damaged),202);
 const offline=input('outage');
 await reply(await submit(offline),202);
 await unlink(resolve(incoming,'document.pdf'));
 const pendingDb=new DatabaseSync(resolve(dir,'Data/agent.sqlite'),{readOnly:true});
 try{
  const {local_path}=pendingDb.prepare('SELECT local_path FROM document WHERE request_id=?').get(damaged.requestId);
  await unlink(resolve(dir,local_path));
 }finally{pendingDb.close();}
 relay=start('apps/api-server/mock/server.mjs');
 await until(online);
 await until(async()=> (await status(offline.requestId)).status===200);
 const final=await reply(await status(offline.requestId),200);
 assert.equal(final.documentId,offline.documentId);
 await stop(worker);
 worker=start('apps/transfer-agent/phase2.mjs');
 await until(online);
 assert.deepEqual(await reply(await status(offline.requestId),200),final);
 const admin=(await req(web,'/admin')).headers.get('set-cookie').split(';')[0];
 await reply(await req(web,'/api/v1/documents/'+standard.documentId+'/revoke',{input:{},headers:{Origin:web,Cookie:admin}}),200);
 const revoked=await reply(await req(agent,internal+'documents/'+standard.documentId,{headers:key}),410);
 assert.equal(revoked.guideUrl,null);
 const db=new DatabaseSync(resolve(dir,'Data/agent.sqlite'),{readOnly:true});
 try{
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);
  assert.equal(db.prepare('SELECT count(*) n FROM document').get().n,6);
  assert.equal(db.prepare('SELECT last_error_code FROM document WHERE request_id=?').get(damaged.requestId).last_error_code,'LOCAL_FILE_UNAVAILABLE');
  assert.equal(db.prepare('SELECT birth_verify FROM document WHERE request_id=?').get('normal').birth_verify,one.birthVerify);
  assert.ok(db.prepare("SELECT count(*) n FROM pgs_intake_event WHERE event='REGISTER'").get().n>0);
 }finally{db.close();}
 assert.ok(!logs.join('').includes('19550203')&&!logs.join('').includes(raw));
 console.log('Delphi intake: four endpoints, 202/404/409/410, client timeout, proof/auth, same-ID retry, offline restart, path isolation and WSS passed');
}catch(error){console.error(logs.join(''));throw error;}
finally{
 for(const child of children)await stop(child);
 if(/^run-[^\\/]+$/.test(relative(parent,root)))await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
