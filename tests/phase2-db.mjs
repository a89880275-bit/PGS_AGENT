import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../apps/phase2/db.mjs';
import { sign,verifyFetch } from '../apps/phase2/relay.mjs';
import { agentId,clientId,day,iso,epoch,mac,sha } from '../apps/phase2/common.mjs';

const keys={link:'test-link-key',subject:'test-subject-key'};
let now=Date.parse('2026-03-07T23:00:00.123-05:00');
const db=await openDatabase({dir:'memory://',keys,clock:()=>now});
function input(requestId,code='G001') {
  const documentId=randomUUID();
  return {documentId,requestId,documentCode:code,fileSize:85000,fileHash:sha('synthetic '+requestId),
    createdAt:iso(now),patientKey:mac(keys.subject,'patient:01001111'),birthVerify:mac(keys.subject,documentId+':19550203')};
}
try {
  await db.migrate();
  const legacy=input('legacy-seven');
  const fixture=await db.register(legacy);
  await db.sql.query(`UPDATE pgs_document SET retention_days=7,link_validity_days=7,expires_at=$1,delete_at=$1 WHERE document_id=$2`,[iso(now+day*7),legacy.documentId]);
  const old=await db.activate(legacy.documentId);
  await db.migrate();
  assert.equal(iso((await db.request('legacy-seven')).expires_at),iso(old.expires_at));
  assert.equal(fixture.doc.retention_days,30);
  const original=input('default-30');
  const current=(await db.register(original)).doc;
  assert.equal(epoch(current.expires_at)-now,30*day);
  const registered=await db.activate(original.documentId);
  const originalToken=db.linkFor(registered);
  const session=await db.verify(originalToken,'19550203');
  await db.changePolicy('DEFAULT',90,90);
  await db.changePolicy('G001',1,1);
  await db.changePolicy('G002',90,30);
  for (const invalid of [[91,30],[0,1],[1,2],[1.5,1]]) await assert.rejects(db.changePolicy('DEFAULT',...invalid),/INVALID_POLICY/);
  await assert.rejects(db.sql.query("UPDATE pgs_retention_policy SET retention_days=91 WHERE code='DEFAULT'"));
  const retry=await db.register(original);
  assert.equal(retry.created,false);
  assert.equal(iso(retry.doc.expires_at),iso(registered.expires_at));
  await assert.rejects(db.register({...original,fileHash:sha('changed')}),/REQUEST_CONFLICT/);
  const revised=(await db.register(input('revision-one'))).doc;
  assert.notEqual(revised.document_id,current.document_id);
  assert.equal(epoch(revised.expires_at)-now,day);
  const different=(await db.register(input('retention-90','G002'))).doc;
  assert.equal(epoch(different.expires_at)-now,30*day);
  assert.equal(epoch(different.delete_at)-now,90*day);
  await db.modify(original.documentId,'replace');
  const changed=await db.request(original.requestId);
  assert.notEqual(db.linkFor(changed),originalToken);
  assert.equal(iso(changed.delete_at),iso(registered.delete_at));
  await assert.rejects(db.patient(session),/SESSION_REQUIRED/);
  for(let i=0;i<4;i++) await assert.rejects(db.verify(db.linkFor(changed),'19550204'),/DATE_MISMATCH/);
  await assert.rejects(db.verify(db.linkFor(changed),'19550204'),/LOCKED/);
  await assert.rejects(db.verify(db.linkFor(changed),'19550203'),/LOCKED/);
  now+=30*day-1;
  const last=await db.verify(db.linkFor(changed),'19550203');
  assert.equal((await db.patient(last)).document_id,original.documentId);
  now++;
  await assert.rejects(db.verify(db.linkFor(changed),'19550203'),/LINK_UNAVAILABLE/);
  await db.cleanup();
  assert.equal((await db.request(original.requestId)).birth_verify,null);
  await db.deletion(original.documentId,false);
  assert.equal((await db.request(original.requestId)).status,'DELETE_FAILED');
  await db.deletion(original.documentId,true);
  const erased=await db.request(original.requestId);
  assert.equal(erased.status,'DELETED');
  assert.equal(erased.patient_key,null);
  assert.equal(erased.file_hash,null);
  assert.equal((await db.request('legacy-seven')).retention_days,7);
  const list=await db.sql.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_name IN ('pgs_document','pgs_access_token','pgs_session')");
  assert.ok(list.rows.every(row=>row.data_type!=='bytea'&&!/original_filename|local_path|storage_key|birth_date|patient_no|token_raw/.test(row.column_name)));

  const used=new Map();
  const frame={requestId:randomUUID(),documentId:original.documentId,agentId,deadline:now+1000};
  const proof=sign('test-proof',frame);
  for (const invalid of [{...frame,proof:'bad'},{...frame,agentId:clientId,proof},{...frame,deadline:now,proof},{...frame,documentId:randomUUID(),proof}]) {
    assert.throws(()=>verifyFetch('test-proof',invalid,now,used),/FETCH_FORBIDDEN/);
  }
  verifyFetch('test-proof',{...frame,proof},now,used);
  assert.throws(()=>verifyFetch('test-proof',{...frame,proof},now,used),/FETCH_FORBIDDEN/);

  const start=performance.now();
  await db.sql.query(`INSERT INTO pgs_document(document_id,agent_id,client_id,request_id,doc_type,doc_title,file_size,file_hash,
      created_at,registered_at,expires_at,delete_at,retention_days,link_validity_days,policy_version,status)
    SELECT gen_random_uuid(),$1,$2,'load-'||n,'G001','Synthetic load fixture',85000,repeat('a',64),now(),now(),
      now()+interval '720 hours',now()+interval '720 hours',30,30,1,'READY' FROM generate_series(1,30000) AS g(n)`,[agentId,clientId]);
  const {rows:[size]}=await db.sql.query(`SELECT count(*) AS documents,pg_relation_size('pgs_document') AS table_bytes,
      pg_indexes_size('pgs_document') AS index_bytes,pg_total_relation_size('pgs_document') AS total_bytes
    FROM pgs_document WHERE request_id LIKE 'load-%'`);
  assert.equal(Number(size.documents),30000);
  console.log('PostgreSQL migration, policy, metadata, proof, expiry and 30k benchmark',JSON.stringify({...size,ms:Math.round(performance.now()-start)}));
} finally { await db.sql.close(); }