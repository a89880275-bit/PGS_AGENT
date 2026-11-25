import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openDatabase} from '../apps/phase2/db.mjs';
import {openStorage} from '../apps/transfer-agent/storage.mjs';
import {linkVault} from '../apps/phase3/crypto.mjs';
import {patientAuth} from '../apps/phase3/auth.mjs';
import {day,iso,epoch,mac,sha,token} from '../apps/phase2/common.mjs';

const parent=resolve('.local/phase3-migration');
await mkdir(parent,{recursive:true});
const folder=await mkdtemp(parent+'/run-');
const now=Date.now();
const keys={link:'legacy-link-fixture',subject:'legacy-subject-fixture',legacySubject:'legacy-subject-fixture',
  birth:new Map([[2,'new-test-key']]),rate:'test-rate-key'};
delete process.env.PGS_DATABASE_URL;
const options={dir:resolve(folder,'catalog'),keys,clock:()=>now};
let db=await openDatabase(options);
let storage;
const documentId=randomUUID();
const filename='100111120261124a01.pdf',bytes=Buffer.from('synthetic file');
const input={documentId,requestId:'legacy-seven',filename,documentCode:'G001',createdAt:iso(now),
  fileSize:bytes.length,fileHash:sha(bytes),patientKey:mac(keys.subject,'patient:1001111'),birthVerify:mac(keys.subject,documentId+':19550203')};
try{
  await db.register(input);
  await db.sql.query('UPDATE pgs_document SET retention_days=7,link_validity_days=7,expires_at=$1,delete_at=$1 WHERE document_id=$2',[iso(now+7*day),documentId]);
  const legacy=await db.activate(documentId);
  const raw=db.linkFor(legacy), oldSession=await db.verify(raw,'19550203');
  await db.sql.close();
  db=await openDatabase({...options,phase3:true});
  await db.migrate();
  assert.equal(epoch((await db.request(input.requestId)).expires_at),now+7*day);
  const auth=patientAuth(db,keys,()=>now);
  assert.equal((await auth.session(oldSession)).document_id,documentId);
  assert.ok((await auth.verify(raw,'19550203','127.0.0.1')).session);
  await assert.rejects(db.sql.query('UPDATE pgs_session SET document_id=$1 WHERE session_hash=$2',[randomUUID(),sha(oldSession)]));
  storage=await openStorage(resolve(folder,'agent'),()=>now);
  await storage.save(input,bytes);
  storage.setPolicy(documentId,{documentId,retentionDays:7,validityDays:7,policyVersion:1,registeredAt:iso(now),expiresAt:iso(now+7*day),deleteAt:iso(now+7*day)});
  storage.ready(documentId);
  storage.db.close();
  storage=await openStorage(resolve(folder,'agent'),()=>now,true);
  assert.equal(storage.get(input.requestId).expires_at,iso(now+7*day));
  const vault=linkVault(storage,'separate-vault-key');
  const issued=vault.prepare(documentId,2,token);
  assert.equal(vault.prepare(documentId,2,()=>{throw new Error('unexpected reissue');}),issued);
  assert.throws(()=>linkVault(storage,'wrong-key').read(documentId,2));
  storage.db.close();
  storage=await openStorage(resolve(folder,'agent'),()=>now,true);
  assert.equal(linkVault(storage,'separate-vault-key').read(documentId,2),issued);
  console.log('PostgreSQL/SQLite migrations repeated; legacy 7-day expiry, composite session FK and AES-GCM verified');
}finally{storage?.db.close();await db.sql.close();}
