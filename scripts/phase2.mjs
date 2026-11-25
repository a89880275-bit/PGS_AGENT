import { spawn,spawnSync } from 'node:child_process';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

if (process.env.NODE_ENV==='production') throw new Error('Phase 2 PoC cannot start in production');
const managed=process.argv.includes('--phase5b');
const phase4=managed||process.argv.includes('--phase4');
const phase3=phase4||process.argv.includes('--phase3');
const profile=managed?(process.env.PGS_PHASE5B_LOCAL_DIR??'.local/phase5b'):phase4?'.local/phase4':phase3?'.local/phase3':'.local/phase2';
const local=resolve(profile);
await mkdir(local,{recursive:true});
const secrets=resolve(local,'secrets.env');
const names=['PGS_AGENT_SECRET','PGS_PROOF_SECRET','PGS_SUBJECT_SECRET','PGS_LINK_SECRET'];
if(phase3) names.push('PGS_GRANT_SECRET','PGS_RATE_SECRET','PGS_BIRTH_SECRET');
try {await writeFile(secrets,names.map(name=>name+'='+randomBytes(32).toString('hex')).join('\n'),{flag:'wx',mode:0o600});}
catch(error) {if(error.code!=='EEXIST') throw error;}
const agentSecrets=resolve(local,'agent-secrets.env');
if(phase3){
  try{await writeFile(agentSecrets,['PGS_VAULT_SECRET','PGS_HIS_SECRET'].map(name=>name+'='+randomBytes(32).toString('hex')).join('\n'),{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST') throw error;}
}
const cert=process.env.PGS_TLS_CERT??resolve(local,'tls/cert.pem');
const key=process.env.PGS_TLS_KEY??resolve(local,'tls/key.pem');
try {await Promise.all([readFile(cert),readFile(key)]);}
catch {
  if (process.env.PGS_TLS_CERT || process.env.PGS_TLS_KEY) throw new Error('Local TLS key/certificate are missing');
  const generated=spawnSync('pwsh',['-NoProfile','-File','scripts/local-cert.ps1','-Directory',profile+'/tls'],{stdio:'inherit'});
  if (generated.status!==0) throw new Error('Provide loopback PEM certificate and key or install PowerShell 7');
}
const env={...process.env,PGS_PORT:process.env.PGS_PORT??(phase4?'4205':phase3?'4195':'4180'),PGS_PHASE2:'1',PGS_TEST_AUTH:'1',PGS_TLS_CERT:cert,PGS_TLS_KEY:key};
if(phase3) Object.assign(env,{
  PGS_PHASE3:'1',PGS_PHASE4:phase4?'1':'0',PGS_PHASE5B:managed?'1':'0',PGS_WEB_TLS:process.env.PGS_WEB_TLS??'1',
  PGS_AGENT_PORT:process.env.PGS_AGENT_PORT??(phase4?'4206':'4196'),PGS_TLS_PORT:process.env.PGS_TLS_PORT??(phase4?'4445':'4444'),
  PGS_PGLITE_DIR:process.env.PGS_PGLITE_DIR??resolve(local,'catalog'),
  PGS_STORAGE_DIR:process.env.PGS_STORAGE_DIR??resolve(local,'agent'),
});
const managerFile=resolve(local,'manager-bootstrap.json');
if(managed&&!env.PGS_MANAGER_BOOTSTRAP){
  const accounts=[['system','SYSTEM'],['operator','OPERATOR'],['viewer','VIEWER']].map(([username,role])=>({username,role,password:randomBytes(24).toString('base64url')}));
  try{await writeFile(managerFile,JSON.stringify(accounts,null,2),{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;}
  env.PGS_MANAGER_BOOTSTRAP=await readFile(managerFile,'utf8');
}
const build=spawnSync(process.execPath,['scripts/build-ui.mjs'],{env,stdio:'inherit'});
if(build.status!==0) process.exit(build.status??1);
const files=['apps/api-server/mock/server.mjs','apps/transfer-agent/phase2.mjs'];
const shared=phase4?parseEnv(await readFile(secrets,'utf8')):{};
const children=files.map((file,index)=>{
  const childEnv={...env};
  if(index!==0)delete childEnv.PGS_MANAGER_BOOTSTRAP;
  if(phase3&&index===0){delete childEnv.PGS_VAULT_SECRET;delete childEnv.PGS_HIS_SECRET;}
  if(phase4&&index===0)for(const key of Object.keys(childEnv)){
    if(key.startsWith('PGS_INTERNAL_')||key==='PGS_INTAKE_DIR')delete childEnv[key];
  }
  if(phase4&&index===1){
    for(const name of ['PGS_AGENT_SECRET','PGS_PROOF_SECRET','PGS_SUBJECT_SECRET','PGS_LINK_SECRET','PGS_GRANT_SECRET']){
      childEnv[name]??=shared[name];
    }
    childEnv.PGS_BIRTH_KEY_VERSIONS=JSON.stringify(Object.keys(JSON.parse(childEnv.PGS_BIRTH_KEYS??'{}')).map(Number));
    delete childEnv.PGS_BIRTH_SECRET;
    delete childEnv.PGS_BIRTH_KEYS;
  }
  return spawn(process.execPath,[...(phase4&&index===1?[]:['--env-file='+secrets]),...(phase3&&index===1?['--env-file='+agentSecrets]:[]),file],
    {env:childEnv,stdio:'inherit'});
});
let stopping=false;
function stop(code) {
  if(stopping) return;
  stopping=true;
  for(const child of children) if(child.exitCode===null) child.kill();
  process.exitCode=code;
}
for(const child of children) {
  child.once('exit',code=>stop(code??1));
  child.once('error',()=>stop(1));
}
process.once('SIGINT',()=>stop(0));
process.once('SIGTERM',()=>stop(0));

if(process.connected)process.once('disconnect',()=>stop(0));
