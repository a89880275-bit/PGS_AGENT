import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {requireLocal} from '../apps/phase2/common.mjs';
import {parseEnv} from 'node:util';
import {createServer} from 'node:net';
import {request} from 'node:https';
await mkdir('.local/phase5b-tests',{recursive:true});
const profile=await mkdtemp('.local/phase5b-tests/run-');
const reservations=Array.from({length:3},()=>createServer());
const [webPort,agentPort,relayPort]=await Promise.all(reservations.map(server=>new Promise((resolve,reject)=>{
 server.once('error',reject);
 server.listen(0,'127.0.0.1',()=>resolve(server.address().port));
})));
await Promise.all(reservations.map(server=>new Promise(resolve=>server.close(resolve))));
const env={...process.env,PGS_PHASE5B_LOCAL_DIR:profile,PGS_PORT:String(webPort),PGS_AGENT_PORT:String(agentPort),PGS_TLS_PORT:String(relayPort),PGS_WEB_TLS:'1'};
for(const name of ['PGS_DATABASE_URL','PGS_PGLITE_DIR','PGS_STORAGE_DIR','PGS_INTAKE_DIR','PGS_MANAGER_BOOTSTRAP','PGS_PUBLIC_ORIGIN','PGS_RELAY_ORIGIN'])delete env[name];
const child=spawn(process.execPath,['scripts/phase2.mjs','--phase5b'],{env,stdio:['ignore','inherit','inherit','ipc']});
const origin='https://127.0.0.1:'+webPort;
let ca;
const call=(path,body,cookie)=>new Promise((resolve,reject)=>{
 const req=request(origin+path,{ca,method:body?'POST':'GET',headers:{Origin:origin,Cookie:cookie??'','Content-Type':'application/json'}},res=>{
  const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
  res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
 });
 req.on('error',reject);req.setTimeout(8000,()=>req.destroy(new Error('timeout')));req.end(body&&JSON.stringify(body));
});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 for(let i=0;;i++){
  try{ca=await readFile(profile+'/tls/cert.pem');const health=await call('/mock/health');if(health.status===200&&JSON.parse(health.body).relay.online)break;}catch{}
  assert.ok(i<120,'5-B startup timeout');await pause(250);
 }
 const users=JSON.parse(await readFile(profile+'/manager-bootstrap.json','utf8'));
 async function login(role){
  const {username,password}=users.find(u=>u.role===role);
  const res=await call('/api/v1/manager/login',{username,password});
  assert.equal(res.status,200,res.body);return res.headers['set-cookie'][0].split(';')[0];
 }
 async function expect(status,path,body,cookie){
  const res=await call(path,body,cookie);assert.equal(res.status,status,res.body);return JSON.parse(res.body);
 }
 await expect(403,'/mock/state');
 const viewer=await login('VIEWER'),operator=await login('OPERATOR'),system=await login('SYSTEM');
 const policy={code:'DEFAULT',retentionDays:30,validityDays:30};
 for(const c of [viewer,operator])await expect(403,'/mock/policy',policy,c);
 await expect(200,'/mock/policy',policy,system);
 await expect(403,'/api/v1/manager/audit',undefined,viewer);
 await expect(403,'/api/v1/agent/maintenance-grant',{},viewer);
 const type={code:'G099',name:'Synthetic test guide',description:'',title:'Synthetic test PDF',enabled:true,retentionDays:10,validityDays:5};
 await expect(200,'/api/v1/manager/types',type,system);
 const mock=spawnSync(process.execPath,['scripts/mock-delphi.mjs','--phase5b'],{env,encoding:'utf8'});
 assert.equal(mock.status,0,mock.stderr);
 const outcome=JSON.parse(mock.stdout);
 assert.equal(outcome.httpStatus,201,mock.stdout);
 const state=await expect(200,'/mock/state',undefined,viewer);
 assert.ok(state.types.some(entry=>entry.code===type.code));
 assert.ok(state.documents.some(row=>row.id===outcome.documentId&&!('patientNo' in row)));
 assert.ok(Number(state.dashboard.totals.today)>=1);
 const filtered=await expect(200,'/api/v1/manager/documents?status=ACTIVE&type=G001&document='+outcome.documentId,undefined,viewer);
 assert.deepEqual(filtered.documents.map(doc=>doc.id),[outcome.documentId]);
 const variant=spawnSync(process.execPath,['scripts/mock-delphi.mjs','--phase5b'],{env:{...env,PGS_MOCK_DOCUMENT_TYPE:type.code},encoding:'utf8'});
 assert.equal(variant.status,0,variant.stderr);
 const variantOutcome=JSON.parse(variant.stdout);
 assert.equal(variantOutcome.httpStatus,201,variant.stdout);
 const audit=await expect(200,'/api/v1/manager/audit',undefined,system);
 for(const event of ['LOGIN','POLICY_CHANGED','DOCUMENT_TYPE_CHANGED'])assert.ok(audit.events.some(entry=>entry.event===event),event);
 const secret=parseEnv(await readFile(profile+'/agent-secrets.env','utf8')).PGS_HIS_SECRET;
 const agent='http://127.0.0.1:'+agentPort;
 const requestPath='/api/v1/internal/requests/'+outcome.requestId;
 const lookup=()=>fetch(agent+requestPath,{headers:{'X-API-Key':secret}});
 const initial=await (await lookup()).json();
 const row=await (await fetch(agent+'/api/v1/internal/documents/'+outcome.documentId,{headers:{'X-API-Key':secret}})).json();
 assert.deepEqual(row,initial);
 const policyResult=await fetch(agent+'/api/v1/internal/requests/'+variantOutcome.requestId,{headers:{'X-API-Key':secret}});
 const applied=await policyResult.json();
 assert.equal(applied.retentionDays,10);
 assert.equal(Date.parse(applied.deleteAt)-Date.parse(applied.expiresAt),5*86400000);
 await expect(404,'/api/v1/internal/health');
 const inspectionGrant=await expect(200,'/api/v1/agent/maintenance-grant',{requestId:outcome.requestId,operation:'inspect'},operator);
 const inspection=await fetch(agent+'/mock/agent-document',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(inspectionGrant)});
 assert.equal(inspection.status,200);
 const inspected=await inspection.json();
 assert.equal(inspected.fileStatus,'VERIFIED');
 assert.equal(inspected.consistent,true);
 assert.ok(Number.isFinite(Date.parse(inspected.issuedAt)));
 const path='/api/v1/documents/'+outcome.documentId;
 await expect(403,path+'/reissue',{},viewer);
 const grant=await expect(200,path+'/reissue',{},operator);
 const issue=await fetch(agent+'/mock/link',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(grant)});
 assert.equal(issue.status,200,await issue.clone().text());
 const updated=await (await lookup()).json();
 assert.notEqual(updated.guideUrl,initial.guideUrl);assert.equal(updated.expiresAt,initial.expiresAt);
 const verify=async url=>call('/api/v1/patient/verify',{token:url.split('/').at(-1),birthDate:'19550203'});
 assert.ok([404,410].includes((await verify(initial.guideUrl)).status));
 const auth=await verify(updated.guideUrl);
 assert.equal(auth.status,200,auth.body);
 const session=auth.headers['set-cookie'][0].split(';')[0];
 const pdf=await call('/api/v1/patient/download',undefined,session);
 assert.equal(pdf.status,200,pdf.body);assert.match(pdf.headers['cache-control'],/no-store/);assert.ok(pdf.body.startsWith('%PDF'));
 if(process.env.PGS_BROWSER_EXE){
  const {chromium}=requireLocal('playwright-core','PGS_BROWSER_MODULES');
  const browser=await chromium.launch({executablePath:process.env.PGS_BROWSER_EXE,args:['--disable-background-networking']});
  try{
   const desktop=await browser.newContext({ignoreHTTPSErrors:true});
   const mobile=await browser.newContext({ignoreHTTPSErrors:true,isMobile:true,hasTouch:true,viewport:{width:320,height:800}});
   for(const context of [desktop,mobile]){
    context.setDefaultTimeout(12000);
    await context.route('**/*',route=>[origin+'/',agent+'/','blob:'].some(base=>route.request().url().startsWith(base))?route.continue():route.abort());
   }
   const manager=await desktop.newPage();
   await manager.goto(origin+'/admin#documents');
   await manager.getByLabel('계정').fill(users.find(user=>user.role==='VIEWER').username);
   await manager.getByLabel('비밀번호').fill(users.find(user=>user.role==='VIEWER').password);
   await manager.getByRole('button',{name:'로그인'}).click();
   await manager.getByText(outcome.documentId,{exact:true}).waitFor();
   assert.equal(await manager.getByRole('row').filter({hasText:outcome.documentId}).getByRole('button',{name:'교체'}).isDisabled(),true);
   const agentPage=await desktop.newPage();
   await agentPage.goto(origin+'/agent#history');
   await agentPage.getByText(outcome.requestId,{exact:true}).waitFor();
   const patient=await mobile.newPage();
   await patient.goto(updated.guideUrl);
   await patient.getByLabel('생년월일').fill('19550203');
   await patient.getByRole('button',{name:'확인',exact:true}).click();
   await patient.getByText('1 / 2',{exact:true}).waitFor();
   await patient.getByRole('button',{name:'다음',exact:true}).click();
   await patient.getByText('2 / 2',{exact:true}).waitFor();
   await patient.getByRole('button',{name:'확대',exact:true}).click();
   await patient.getByText('125%',{exact:true}).waitFor();
   assert.equal(await patient.evaluate(()=>document.documentElement.scrollWidth),320);
   console.log('Phase 5-B manager, Agent, and 320px patient browser checks verified');
  }finally{await browser.close();}
 }
 await expect(403,path+'/revoke',{},viewer);
 await expect(200,path+'/revoke',{},operator);
 assert.equal((await lookup()).status,410);
 const viewerUsername=users.find(user=>user.role==='VIEWER').username;
 await expect(403,'/api/v1/manager/roles',{username:viewerUsername,role:'OPERATOR'},operator);
 await expect(200,'/api/v1/manager/roles',{username:viewerUsername,role:'OPERATOR'},system);
 await expect(403,'/api/v1/manager/session',undefined,viewer);
 const finalAudit=await expect(200,'/api/v1/manager/audit',undefined,system);
 for(const event of ['LINK_REISSUED','LINK_REVOKED','ROLE_CHANGED'])assert.ok(finalAudit.events.some(entry=>entry.event===event),event);
 console.log('Phase 5-B manager controls verified');
}finally{if(child.exitCode===null&&child.signalCode===null){const done=new Promise(resolve=>child.once('exit',resolve));if(child.connected)child.disconnect();await done;}}
