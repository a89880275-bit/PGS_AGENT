import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile,rm,rename,readdir } from 'node:fs/promises';
import { resolve,relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { samplePdf } from '../scripts/fixture.mjs';
import { requireLocal,agentId,day,sha } from '../apps/phase2/common.mjs';

const parent=resolve('.local/phase2-tests');
await mkdir(parent,{recursive:true});
const root=await mkdtemp(parent+'/run-');
const ca=resolve('.local/phase2/tls/cert.pem'),key=resolve('.local/phase2/tls/key.pem');
try {await readFile(ca);}
catch {
  const result=spawnSync('pwsh',['-NoProfile','-File','scripts/local-cert.ps1'],{stdio:'inherit'});
  assert.equal(result.status,0);
}
const web='http://127.0.0.1:4290', internal='http://127.0.0.1:4291', wss='wss://127.0.0.1:4493/api/v1/agent/connect';
const time=Date.now();
const clock=resolve(root,'clock.txt');
await writeFile(clock,String(time));
const env={...process.env,PGS_PHASE2:'1',PGS_TEST_AUTH:'1',PGS_PORT:'4290',PGS_AGENT_PORT:'4291',PGS_TLS_PORT:'4493',
  PGS_PGLITE_DIR:resolve(root,'catalog'),PGS_STORAGE_DIR:resolve(root,'agent'),PGS_TLS_CERT:ca,PGS_TLS_KEY:key,
  PGS_FIRST_MS:'450',PGS_TOTAL_MS:'5000',PGS_HEARTBEAT_MS:'250',PGS_OFFLINE_MS:'1200',PGS_TEST_CLOCK_FILE:clock,
  PGS_TEST_DROP_ACTIVATE_FOR:'lost-activate-response'};
delete env.PGS_DATABASE_URL;
for (const name of ['AGENT','PROOF','SUBJECT','LINK']) env['PGS_'+name+'_SECRET']=randomBytes(32).toString('hex');
const children=new Set();
const start=file=>{
  const child=spawn(process.execPath,[file],{env,stdio:['ignore','pipe','pipe']});
  children.add(child);
  child.stdout.on('data',data=>process.stdout.write(data));
  child.stderr.on('data',data=>process.stderr.write(data));
  return child;
};
async function stop(child) {
  if (!child || child.exitCode!==null || child.signalCode!==null) return;
  const exit=new Promise(resolve=>child.once('exit',resolve));
  child.kill();
  await exit;
}
const wait = ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,description) {
  for (let i=0;i<150;i++) {
    try { if (await check()) return; } catch {}
    await wait(80);
  }
  throw new Error('Timeout: '+description);
}
function request(origin,path,{data,cookie,signal,method}={}) {
  return fetch(origin+path,{signal,method:method??(data===undefined?'GET':'POST'),headers:{...(data===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},
    body:data===undefined?undefined:JSON.stringify(data)});
}
async function reply(response,status) {
  const data=await response.json();
  assert.equal(response.status,status,JSON.stringify(data));
  return data;
}
const cookie=response=>response.headers.get('set-cookie')?.split(';')[0];
const status=async()=> (await (await request(web,'/mock/health')).json());
const local=(path,opts)=>request(internal,path,opts);
const admin=(path,opts={})=>request(web,path,{...opts,cookie:adminCookie});
const reg=(requestId,bytes=samplePdf(),filename='0100111120261124a01.pdf')=>local('/internal/v1/requests',{data:{requestId,filename,pdf:bytes.toString('base64')}});
let relay,agent,adminCookie,stub;
try {
  relay=start('apps/api-server/mock/server.mjs');
  agent=start('apps/transfer-agent/phase2.mjs');
  await until(async()=> (await status()).relay.online,'agent-initiated WSS');
  assert.equal((await request(web,'/mock/state')).status,403);
  assert.equal((await request(web,'/api/v1/patient/pdf')).status,401);
  assert.equal((await request(web,'/api/v1/documents',{data:{file:'AAAA'}})).status,403);
  const adminPage=await request(web,'/admin');
  adminCookie=cookie(adminPage);
  assert.ok(adminCookie);
  const normal=await reply(await reg('first'),201);
  assert.equal(normal.status,'READY');
  assert.equal(Date.parse(normal.expiresAt)-Date.parse(normal.registeredAt),30*day);
  const {Storage}=Object.fromEntries((await readdir(resolve(root,'agent'))).map(name=>[name,resolve(root,'agent',name)]));
  const [year,month,date]=new Date(time).toISOString().slice(0,10).split('-');
  const localFile=resolve(Storage,year,month,date,normal.documentId+'.pdf');
  assert.equal(sha(await readFile(localFile)),sha(samplePdf()));
  assert.deepEqual(await reply(await reg('first'),201),normal);
  const [duplicateA,duplicateB]=await Promise.all([reg('concurrent-same'),reg('concurrent-same')]);
  assert.deepEqual(await reply(duplicateA,201),await reply(duplicateB,201));
  await reply(await reg('lost-activate-response'),503);
  await until(async()=> (await reply(await local('/internal/v1/requests/lost-activate-response'),200)).status==='READY',
    'activation response lost after catalog commit');
  const afterLost=await reply(await local('/internal/v1/requests/lost-activate-response'),200);
  assert.deepEqual(await reply(await reg('lost-activate-response'),201),afterLost);
  await reply(await reg('first',samplePdf(true)),409);
  await reply(await reg('bad-date',samplePdf(),'0100111120260231a01.pdf'),400);
  await reply(await reg('bad-name',samplePdf(),'../0100111120261124a01.pdf'),400);
  await reply(await reg('missing',samplePdf(),'9999999920261124a01.pdf'),400);
  await reply(await reg('bad-pdf',Buffer.from('not PDF')),415);
  await reply(await reg('broken-pdf',Buffer.from('%PDF-1.4\ninvalid')),415);
  const big=Buffer.alloc(10*1024*1024+1);
  await reply(await reg('too-large',big),413);
  await reply(await admin('/mock/policy',{data:{code:'G001',retentionDays:1,validityDays:1}}),200);
  await reply(await admin('/mock/policy',{data:{code:'DEFAULT',retentionDays:91,validityDays:30}}),400);
  const revised=await reply(await reg('revised',samplePdf(true)),201);
  assert.notEqual(revised.documentId,normal.documentId);
  assert.equal(Date.parse(revised.expiresAt)-Date.parse(revised.registeredAt),day);
  assert.equal((await reply(await local('/internal/v1/requests/first'),200)).expiresAt,normal.expiresAt);
  await reply(await admin('/mock/policy',{data:{code:'G001',retentionDays:30,validityDays:30}}),200);

  const session=async doc=> {
    const verified=await request(web,'/mock/patient/verify',{data:{token:new URL(doc.viewUrl).pathname.slice(3),birthDate:'19550203'}});
    assert.equal(verified.status,200);
    return cookie(verified);
  };
  const firstCookie=await session(normal);
  const revisedCookie=await session(revised);
  const regular=await request(web,'/api/v1/patient/pdf',{cookie:firstCookie});
  assert.equal(regular.status,200);
  assert.equal(regular.headers.get('cache-control'),'no-store');
  assert.equal(regular.headers.get('accept-ranges'),'none');
  assert.equal(sha(Buffer.from(await regular.arrayBuffer())),sha(samplePdf()));
  const revisionDownload=await request(web,'/api/v1/patient/download',{cookie:revisedCookie});
  assert.match(revisionDownload.headers.get('content-disposition'),/attachment/);
  assert.equal(sha(Buffer.from(await revisionDownload.arrayBuffer())),sha(samplePdf(true)));
  const preview=await admin('/mock/documents/'+normal.documentId+'/pdf');
  assert.equal(sha(Buffer.from(await preview.arrayBuffer())),sha(samplePdf()));
  await reply(await admin('/mock/documents/'+normal.documentId+'/replace',{data:{}}),200);
  assert.equal((await request(web,'/api/v1/patient/pdf',{cookie:firstCookie})).status,401);
  const replaced=await reply(await local('/internal/v1/requests/first'),200);
  assert.equal(replaced.deleteAt,normal.deleteAt);
  assert.notEqual(replaced.viewUrl,normal.viewUrl);
  const replacementCookie=await session(replaced);

  await stop(agent);
  await until(async()=> !(await status()).relay.online,'offline detection');
  const offline=await reply(await request(web,'/api/v1/patient/pdf',{cookie:replacementCookie}),503);
  assert.equal(offline.code,'AGENT_OFFLINE');
  const {Client}=requireLocal('faye-websocket');
  stub=new Client(wss,[],{tls:{ca:await readFile(ca),rejectUnauthorized:true},
    headers:{'x-agent-id':agentId,Authorization:'Bearer '+env.PGS_AGENT_SECRET}});
  stub.on('open',()=>stub.send(JSON.stringify({type:'HELLO',agentId})));
  await until(async()=> (await status()).relay.online,'timeout fixture HELLO');
  assert.equal((await reply(await request(web,'/api/v1/patient/pdf',{cookie:replacementCookie}),504)).code,'AGENT_TIMEOUT');
  assert.equal((await status()).relay.inFlight,0);
  const cancelled=new AbortController();
  const response=request(web,'/api/v1/patient/pdf',{cookie:replacementCookie,signal:cancelled.signal});
  const aborted=assert.rejects(response,error=>error.name==='AbortError');
  await until(async()=> (await status()).relay.inFlight===1,'in-flight request before cancel');
  cancelled.abort();
  await aborted;
  await until(async()=> (await status()).relay.inFlight===0,'cancel cleanup');
  stub.close();stub=null;
  agent=start('apps/transfer-agent/phase2.mjs');
  await until(async()=> (await status()).relay.online,'agent reconnect after restart');
  assert.deepEqual(await reply(await reg('first'),201),replaced);

  await stop(relay);
  const delayed=await reg('response-recovery');
  assert.equal(delayed.status,503);
  const timeFile=clock+'.next';
  await writeFile(timeFile,String(time+day));
  await rename(timeFile,clock);
  const purged=await reply(await local('/mock/purge',{data:{}}),200);
  assert.equal(purged.deleted,1);
  relay=start('apps/api-server/mock/server.mjs');
  await until(async()=> (await status()).relay.online,'offline deletion reconnect');
  await until(async()=> (await reply(await local('/internal/v1/requests/response-recovery'),200)).status==='READY','recovery without new ID');
  adminCookie=cookie(await request(web,'/admin'));
  await until(async()=> (await reply(await admin('/mock/state'),200)).documents.some(doc=>doc.id===revised.documentId&&doc.status==='DELETED'),'offline deletion acknowledgment');
  const recovered=await reply(await reg('response-recovery'),201);
  assert.equal(recovered.requestId,'response-recovery');

  if (process.env.PGS_RUN_LOAD==='1') {
    const synthetic=samplePdf(false,83503), offsets=[], documents=[];
    const loadStart=performance.now();
    const memory={relay:(await status()).rssBytes,agent:(await (await local('/mock/agent-state')).json()).rssBytes??0};
    let peakRelay=memory.relay, peakAgent=memory.agent, errors=0;
    for (let pass=0;pass<100;pass++) {
      await Promise.all(Array.from({length:10},async (_,index)=>{
        const start=performance.now();
        const result=await reg('batch-'+(pass*10+index),synthetic);
        if (result.status===201) documents.push(await result.json()); else {errors++; await result.text();}
        offsets.push(performance.now()-start);
      }));
      if (pass%5===0) {
        peakRelay=Math.max(peakRelay,(await status()).rssBytes);
        peakAgent=Math.max(peakAgent,(await (await local('/mock/agent-state')).json()).rssBytes??0);
      }
    }
    assert.equal(documents.length,1000);
    const sessions=await Promise.all(documents.slice(0,10).map(session));
    const streamStart=performance.now();
    const transfers=await Promise.all(sessions.map(async key=>{
      const start=performance.now();
      const response=await request(web,'/api/v1/patient/download',{cookie:key});
      assert.equal(response.status,200);
      assert.equal(sha(Buffer.from(await response.arrayBuffer())),sha(synthetic));
      return performance.now()-start;
    }));
    offsets.sort((a,b)=>a-b); transfers.sort((a,b)=>a-b);
    console.log('Phase 2 load',JSON.stringify({registrations:documents.length,bytesPerPdf:synthetic.length,errors,
      registrationElapsedMs:Math.round(streamStart-loadStart),registrationP95Ms:Math.round(offsets[949]),downloadP95Ms:Math.round(transfers[9]),
      peakRelayRssBytes:peakRelay,peakAgentRssBytes:peakAgent}));
  }
  const externalFiles=await readdir(resolve(root,'catalog'),{recursive:true});
  assert.ok(externalFiles.every(file=>!file.endsWith('.pdf')));
  for (const file of externalFiles) {
    const bytes=await readFile(resolve(root,'catalog',file)).catch(error=>{
      if (error.code==='EISDIR' || error.code==='EPERM') return null;
      throw error;
    });
    if (bytes) assert.equal(bytes.includes(Buffer.from('%PDF-1.4')),false);
  }
  const production=spawnSync(process.execPath,['apps/api-server/mock/server.mjs'],{env:{...env,NODE_ENV:'production'},encoding:'utf8'});
  assert.notEqual(production.status,0);
  assert.match(production.stderr,/development only/);
  console.log('Two-process local WSS integration passed: validation, 30 days, 1-day override, retry, stream hashes, offline, timeout, cancellation, restart and offline purge sync');
} finally {
  stub?.close();
  for (const child of children) await stop(child);
  const relativePath=relative(parent,root);
  if (/^run-[^\\/]+$/.test(relativePath)) await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
