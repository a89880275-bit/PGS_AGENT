import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {randomBytes,randomUUID} from 'node:crypto';
import {samplePdf} from './fixture.mjs';
import {birthProof} from '../apps/phase3/crypto.mjs';
import {sha} from '../apps/phase2/common.mjs';

const root=resolve(process.argv.includes('--phase5b')?(process.env.PGS_PHASE5B_LOCAL_DIR??'.local/phase5b'):'.local/phase4');
const agentSecrets=parseEnv(await readFile(resolve(root,'agent-secrets.env'),'utf8'));
const shared=parseEnv(await readFile(resolve(root,'secrets.env'),'utf8'));
const folder=resolve(process.env.PGS_INTAKE_DIR??resolve(root,'agent/Incoming'));
await mkdir(folder,{recursive:true});
const documentId=randomUUID(),birthSalt=randomBytes(32).toString('hex');
const fileName='synthetic-'+documentId+'.pdf';
const pdf=samplePdf();
await writeFile(resolve(folder,fileName),pdf,{flag:'wx'});
const requestId='DELPHI-MOCK-'+documentId;
const keyVersion=Number(process.env.PGS_BIRTH_KEY_VERSION??2);
const birthKey=JSON.parse(process.env.PGS_BIRTH_KEYS??'{}')[keyVersion]??process.env.PGS_BIRTH_SECRET??shared.PGS_BIRTH_SECRET;
const payload=JSON.stringify({requestId,fileName,fileSha256:sha(pdf),documentType:process.env.PGS_MOCK_DOCUMENT_TYPE??'G001',patientNo:'01001111',
  birthVerifier:{documentId,salt:birthSalt,value:birthProof(birthKey,documentId,birthSalt,'19550203'),keyVersion}});
if(process.argv.includes('--prepare')){
  const file=resolve(root,'delphi-request.json');
  await writeFile(file,payload);
  console.log(JSON.stringify({requestId,documentId,file}));
  process.exit(0);
}
const response=await fetch('http://127.0.0.1:'+(process.env.PGS_AGENT_PORT??'4206')+'/api/v1/internal/documents',{
  method:'POST',headers:{'X-API-Key':process.env.PGS_INTERNAL_API_KEY??agentSecrets.PGS_HIS_SECRET,'Content-Type':'application/json'},
  body:payload,
});
const {status,resultCode,expiresAt}=await response.json();
console.log(JSON.stringify({httpStatus:response.status,requestId,documentId,status,resultCode,expiresAt}));
if(!response.ok)process.exitCode=1;
