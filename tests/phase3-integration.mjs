import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {request} from 'node:https';
import {mkdir,mkdtemp,readFile,writeFile,rename,readdir,rm} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {randomBytes} from 'node:crypto';
import {samplePdf} from '../scripts/fixture.mjs';
import {sha,day,agentId,requireLocal} from '../apps/phase2/common.mjs';

const parent=resolve('.local/phase3-tests');
await mkdir(parent,{recursive:true});
const root=await mkdtemp(parent+'/run-');
const cert=resolve('.local/phase3/tls/cert.pem');
try{await readFile(cert);}catch{
  assert.equal(spawnSync('pwsh',['-NoProfile','-File','scripts/local-cert.ps1','-Directory','.local/phase3/tls']).status,0);
}
const ca=await readFile(cert);
const web='https://127.0.0.1:4395', agent='http://127.0.0.1:4396';
const clock=resolve(root,'clock.txt');
let now=Date.now();
await writeFile(clock,String(now));
async function advance(ms) {
  now+=ms;
  await writeFile(clock+'.new',String(now));
  await rename(clock+'.new',clock);
}
const env={...process.env,PGS_PHASE2:'1',PGS_PHASE3:'1',PGS_TEST_AUTH:'1',PGS_WEB_TLS:'1',PGS_PORT:'4395',PGS_AGENT_PORT:'4396',PGS_TLS_PORT:'4495',
  PGS_PGLITE_DIR:resolve(root,'catalog'),PGS_STORAGE_DIR:resolve(root,'agent'),PGS_TLS_CERT:cert,PGS_TLS_KEY:resolve('.local/phase3/tls/key.pem'),
  PGS_TEST_CLOCK_FILE:clock,PGS_HEARTBEAT_MS:'250',PGS_OFFLINE_MS:'1200',PGS_FIRST_MS:'800',PGS_AUTH_IP_PER_MINUTE:'20',PGS_AUTH_GLOBAL_PER_MINUTE:'100',
  PGS_TEST_DROP_ACTIVATE_FOR:'lost'};
delete env.PGS_DATABASE_URL;
for(const name of ['AGENT','PROOF','SUBJECT','LINK','GRANT','RATE','BIRTH','VAULT','HIS']) env['PGS_'+name+'_SECRET']=randomBytes(32).toString('hex');
const processes=new Set(), logs=[];
function start(path){
  const child=spawn(process.execPath,[path],{env,stdio:['ignore','pipe','pipe']});
  processes.add(child);
  child.stdout.on('data',data=>logs.push(data.toString()));
  child.stderr.on('data',data=>logs.push(data.toString()));
  return child;
}
async function stop(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exit=new Promise(resolve=>child.once('exit',resolve)); child.kill(); await exit;
}
async function until(check,name){
  for(let i=0;i<120;i++){
    try{if(await check())return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,80));
  }
  throw new Error('Timeout '+name);
}
function api(path,{data,cookie,origin=web,method,range}={}){
  return new Promise((resolve,reject)=>{
    const raw=data===undefined?undefined:JSON.stringify(data);
    const req=request(web+path,{ca,method:method??(raw?'POST':'GET'),headers:{
      ...(origin?{Origin:origin}:{}),...(raw?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(range?{Range:range}:{})
    }},res=>{
      const chunks=[];res.on('data',value=>chunks.push(value));res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
    });
    req.on('error',reject);req.setTimeout(12000,()=>req.destroy(new Error('HTTP timeout')));req.end(raw);
  });
}
const local=(path,data,authenticated=true)=>fetch(agent+path,{method:data?'POST':'GET',headers:{Origin:web,
  ...(authenticated?{Authorization:'Bearer '+env.PGS_HIS_SECRET}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
const getCookies=res=>res.headers['set-cookie'].map(value=>value.split(';')[0]).join('; ');
const json=(res,status)=>{assert.equal(res.status,status,res.bytes.toString().slice(0,100));return JSON.parse(res.bytes.toString());};
async function localJson(response,status){const data=await response.json();assert.equal(response.status,status,data.code);return data;}
const routes='/api/v1/patient/';
const sample=samplePdf(), revision=samplePdf(true), bulk=samplePdf(false,83503);
const register=(id,bytes=sample)=>local('/internal/v1/requests',{requestId:id,filename:'0100111120261124a01.pdf',pdf:bytes.toString('base64')});
const raw=doc=>doc.viewUrl.split('/').at(-1);
const verify=(document,birth='19550203',cookies)=>api(routes+'verify',{data:{...(document?{token:raw(document)}:{}),birthDate:birth},cookie:cookies});
let relay,client,stub,ticker;
try{
  relay=start('apps/api-server/mock/server.mjs');
  client=start('apps/transfer-agent/phase2.mjs');
  await until(async()=>json(await api('/mock/health'),200).relay.online,'WSS');
  assert.equal((await local('/internal/v1/requests/first',undefined,false)).status,403);
  const doc=await localJson(await register('first',bulk),201);
  const revised=await localJson(await register('revision',revision),201);
  assert.notEqual(raw(doc),raw(revised));
  assert.match(doc.viewUrl,/\/g\/[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(raw(doc),'base64url').length,32);
  assert.equal(Date.parse(doc.expiresAt)-Date.parse(doc.registeredAt),30*day);
  assert.deepEqual(await localJson(await register('first',bulk),201),doc);
  await localJson(await register('first',revision),409);
  await localJson(await register('lost'),503);
  await until(async()=> (await localJson(await local('/internal/v1/requests/lost'),200)).status==='READY','lost response recovery');
  const lost=await localJson(await local('/internal/v1/requests/lost'),200);
  assert.deepEqual(await localJson(await register('lost'),201),lost);
  assert.equal((await api(routes+'pdf')).status,401);
  assert.equal((await api('/mock/patient/pdf')).status,404);
  assert.equal((await api(routes+'verify',{origin:'https://other.invalid',data:{token:raw(doc),birthDate:'19550203'}})).status,403);
  assert.equal((await verify({viewUrl:web+'/g/'+randomBytes(32).toString('base64url')})).status,410);
  for(let i=0;i<4;i++) assert.equal((await api(new URL(doc.viewUrl).pathname,{method:i%2?'HEAD':'GET'})).status,200);
  const attempts=await Promise.all(Array.from({length:5},()=>verify(doc,'19550231')));
  assert.deepEqual(attempts.map(r=>r.status).sort(),[401,401,401,401,429]);
  assert.equal(json(await verify(doc),429).code,'LOCKED');
  await advance(30*60000-1);
  assert.equal(json(await verify(doc),429).code,'LOCKED');
  await advance(1);
  const verified=await verify(doc);
  assert.equal(json(verified,200).sessionExpiresAt,new Date(now+15*60000).toISOString());
  assert.ok(verified.headers['set-cookie'].every(value=>/Secure/.test(value)&&/HttpOnly/.test(value)&&/SameSite=Strict/.test(value)));
  const cookies=getCookies(verified);
  assert.equal((await api(routes+'pdf?documentId='+revised.documentId,{cookie:cookies})).status,403);
  const different=getCookies(await verify(revised));
  const downloads=await Promise.all(Array.from({length:10},(_,i)=>api(routes+(i%2?'download':'pdf'),{cookie:i%2?different:cookies,range:'bytes=0-100'})));
  for(const [i,result] of downloads.entries()){
    assert.equal(result.status,200);
    assert.equal(result.headers['accept-ranges'],'none');
    assert.equal(result.headers['cache-control'],'no-store');
    assert.equal(sha(result.bytes),sha(i%2?revision:bulk));
  }
  await advance(15*60000-1);
  assert.equal((await api(routes+'session',{cookie:cookies})).status,200);
  await advance(1);
  assert.equal((await api(routes+'pdf',{cookie:cookies})).status,401);
  const reauth=getCookies(await verify(null,'19550203',cookies));
  assert.equal((await api(routes+'session',{cookie:reauth})).status,200);
  assert.equal((await api(routes+'logout',{cookie:reauth,data:{}})).status,200);
  assert.equal((await api(routes+'pdf',{cookie:reauth})).status,401);
  const admin=getCookies(await api('/admin'));
  const issuePath='/api/v1/documents/'+doc.documentId;
  assert.equal((await api(issuePath+'/reissue',{data:{}})).status,403);
  const oldSession=getCookies(await verify(doc));
  const grant=json(await api(issuePath+'/reissue',{cookie:admin,data:{}}),200);
  const replacement=await localJson(await local('/mock/link',grant),200);
  assert.equal(replacement.expiresAt,doc.expiresAt);
  assert.notEqual(replacement.viewUrl,doc.viewUrl);
  assert.equal((await verify(doc)).status,410);
  assert.equal((await api(routes+'pdf',{cookie:oldSession})).status,401);
  assert.deepEqual(await localJson(await local('/mock/link',grant),200),replacement);
  const after=getCookies(await verify(replacement));
  await stop(client);
  await until(async()=>!json(await api('/mock/health'),200).relay.online,'offline');
  assert.equal((await api(routes+'download',{cookie:after})).status,503);
  const {Client}=requireLocal('faye-websocket');
  stub=new Client('wss://127.0.0.1:4495/api/v1/agent/connect',[],{tls:{ca},
    headers:{'x-agent-id':agentId,Authorization:'Bearer '+env.PGS_AGENT_SECRET}});
  let partial=false;
  stub.on('open',()=>{
    stub.send(JSON.stringify({type:'HELLO',agentId}));
    ticker=setInterval(()=>stub.send(JSON.stringify({type:'HEARTBEAT',agentId})),250).unref();
  });
  stub.on('message',event=>{
    const frame=JSON.parse(event.data);
    if(frame.type==='FETCH'&&partial)stub.send(JSON.stringify({type:'META',requestId:frame.requestId,size:bulk.length,contentType:'application/pdf'}));
    if(frame.type==='ACK'&&frame.sequence===-1){
      const chunk=Buffer.alloc(40+1024);
      chunk.write(frame.requestId,0,36,'ascii');
      bulk.copy(chunk,40,0,1024);
      stub.send(chunk);
    }
    if(frame.type==='ACK'&&frame.sequence===0)stub.close();
  });
  await until(async()=>json(await api('/mock/health'),200).relay.online,'fault fixture WSS');
  assert.equal((await api(routes+'pdf',{cookie:after})).status,504);
  partial=true;
  await assert.rejects(api(routes+'pdf',{cookie:after}));
  clearInterval(ticker);
  stub=null;
  await until(async()=>{const {relay}=json(await api('/mock/health'),200);return !relay.online&&relay.inFlight===0;},'midstream disconnect cleanup');
  client=start('apps/transfer-agent/phase2.mjs');
  await until(async()=>json(await api('/mock/health'),200).relay.online,'reconnect');
  assert.deepEqual(await localJson(await local('/internal/v1/requests/first'),200),replacement);
  assert.equal(sha((await api(routes+'download',{cookie:after})).bytes),sha(bulk));
  assert.equal((await api(issuePath+'/revoke',{cookie:admin,data:{}})).status,200);
  assert.equal((await api(routes+'pdf',{cookie:after})).status,401);
  assert.equal((await api(issuePath+'/reissue',{cookie:admin,data:{}})).status,410);

  await advance(60000);
  for(let i=0;i<20;i++) await verify({viewUrl:web+'/g/'+randomBytes(32).toString('base64url')});
  assert.equal(json(await verify(revised),429).code,'AUTH_LIMIT');
  await advance(60000);
  assert.equal((await verify(revised)).status,200);
  const remaining=Date.parse(revised.expiresAt)-now;
  await advance(remaining-1);
  assert.equal((await verify(revised)).status,200);
  await advance(1);
  assert.equal((await verify(revised)).status,410);
  const needle=[raw(doc),raw(revised),raw(replacement),'19550203','%PDF-1.4'];
  for(const file of await readdir(resolve(root,'catalog'),{recursive:true})){
    const bytes=await readFile(resolve(root,'catalog',file)).catch(error=>{
      if(['EISDIR','EPERM'].includes(error.code)) return null;
      throw error;
    });
    if(bytes) for(const value of needle) assert.ok(!bytes.includes(Buffer.from(value)));
  }
  for(const name of ['agent.sqlite','agent.sqlite-wal']){
    const sqlite=await readFile(resolve(root,'agent/Data',name)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(sqlite)for(const value of needle) assert.ok(!sqlite.includes(Buffer.from(value)));
  }
  for(const value of needle) assert.ok(!logs.join('').includes(value));
  const disabled=spawnSync(process.execPath,['apps/api-server/mock/server.mjs'],{env:{...env,NODE_ENV:'production'},encoding:'utf8'});
  assert.notEqual(disabled.status,0);
  console.log('Phase 3 HTTPS/WSS integration passed: CSPRNG, encrypted Agent vault, retries, lock, IP rate, session edge, reauth, logout, reissue, revoke, 10 streams, no PDF/secret persistence');
}catch(error){
  console.error(logs.join(''));
  throw error;
}finally{
  clearInterval(ticker);
  stub?.close();
  for(const child of processes) await stop(child);
  if(/^run-[^\\/]+$/.test(relative(parent,root)))await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
