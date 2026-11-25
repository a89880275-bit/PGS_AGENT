import { DatabaseSync } from 'node:sqlite';
import { mkdir, lstat, realpath, open, readFile, rename, unlink, readdir, statfs } from 'node:fs/promises';
import { resolve, dirname, isAbsolute, relative, sep } from 'node:path';
import { constants } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { assert, PhaseError, day, iso, uuid } from '../phase2/common.mjs';

const inside = (root,path) => {
  const part = relative(root,path);
  return part !== '..' && !part.startsWith('..'+sep) && !isAbsolute(part);
};
export async function openStorage(directory,clock=Date.now,withLinks=false,withAutomation=false,withMetrics=false) {
  const root = resolve(directory);
  await mkdir(root,{recursive:true,mode:0o700});
  assert(await realpath(root) === root && !(await lstat(root)).isSymbolicLink(),'UNSAFE_STORAGE');
  async function checked(path,create=false,allowMissing=false) {
    assert(inside(root,path),'UNSAFE_STORAGE');
    let parent=root;
    const parts=relative(root,path).split(sep).filter(Boolean);
    for (const [index,part] of parts.entries()) {
      parent=resolve(parent,part);
      try {
        const stat=await lstat(parent);
        assert(!stat.isSymbolicLink() && await realpath(parent) === parent,'UNSAFE_STORAGE');
        if (index<parts.length-1) assert(stat.isDirectory(),'UNSAFE_STORAGE');
      } catch(error) {
        if (error.code !== 'ENOENT') throw error;
        if (create) {
          try { await mkdir(parent,{mode:0o700}); } catch (cause) { if (cause.code!=='EEXIST') throw cause; }
          assert(!(await lstat(parent)).isSymbolicLink() && await realpath(parent) === parent,'UNSAFE_STORAGE');
        } else if (allowMissing && index===parts.length-1) { return path; }
        else throw error;
      }
    }
    return path;
  }
  for (const item of ['Storage','Processing','Failed','Data','Logs','Incoming']) await checked(resolve(root,item),true);
  const db = new DatabaseSync(await checked(resolve(root,'Data','agent.sqlite'),false,true));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const {user_version}=db.prepare('PRAGMA user_version').get();
  if (user_version===0) db.exec(await readFile(new URL('../../database/migrations/sqlite/001_agent.sql',import.meta.url),'utf8'));
  else assert(user_version===1 || user_version===2&&withLinks || [3,4,5,6].includes(user_version)&&withAutomation,'UNSUPPORTED_SQLITE_SCHEMA',503);
  if(withLinks && user_version<2) db.exec(await readFile(new URL('../../database/migrations/sqlite/002_agent_links.sql',import.meta.url),'utf8'));
  if(withAutomation && user_version<4) db.exec(await readFile(new URL('../../database/migrations/sqlite/004_delphi_intake.sql',import.meta.url),'utf8'));
  if(withAutomation && user_version<5) db.exec(await readFile(new URL('../../database/migrations/sqlite/005_internal_contract.sql',import.meta.url),'utf8'));
  if(withMetrics && user_version<6) db.exec(await readFile(new URL('../../database/migrations/sqlite/006_agent_metrics.sql',import.meta.url),'utf8'));
  const get = key=>db.prepare('SELECT * FROM document WHERE request_id=?').get(key);
  const byId=id=>db.prepare('SELECT * FROM document WHERE document_id=?').get(id);
  const list=()=>db.prepare('SELECT * FROM document ORDER BY staged_at DESC LIMIT 250').all();
  const active = new Map();
  const filePath = item => {
    const [year,month,date]=item.staged_at.slice(0,10).split('-');
    assert(uuid.test(item.document_id),'UNSAFE_STORAGE');
    const expected=resolve(root,'Storage',year,month,date,item.document_id+'.pdf');
    assert(item.local_path===relative(root,expected),'UNSAFE_STORAGE');
    return expected;
  };
  async function readChecked(item) {
    const path=await checked(filePath(item));
    assert((await lstat(path)).isFile(),'UNSAFE_STORAGE');
    const file=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      assert(await realpath(path)===path && !(await lstat(path)).isSymbolicLink(),'UNSAFE_STORAGE');
      const [info,pathInfo]=await Promise.all([file.stat(),lstat(path)]);
      assert(info.isFile() && info.size===item.size && info.ino===pathInfo.ino && info.dev===pathInfo.dev,'FILE_UNAVAILABLE',503);
      const digest=createHash('sha256'), chunk=Buffer.alloc(Math.min(64*1024,item.size));
      let position=0;
      while (position<item.size) {
        const {bytesRead}=await file.read(chunk,0,Math.min(chunk.length,item.size-position),position);
        assert(bytesRead>0,'FILE_UNAVAILABLE',503);
        digest.update(chunk.subarray(0,bytesRead)); position+=bytesRead;
      }
      assert(digest.digest('hex')===item.hash,'FILE_HASH_MISMATCH',503);
      return file;
    } catch(error) { await file.close(); throw error; }
  }
  async function save(input,buffer) {
    const when=iso(clock()), id=input.documentId;
    const [year,month,date]=when.slice(0,10).split('-');
    const path=resolve(root,'Storage',year,month,date,id+'.pdf');
    assert(uuid.test(id),'UNSAFE_STORAGE');
    if(input.integrationFingerprint) db.prepare(`INSERT INTO document(document_id,request_id,local_path,original_filename,hash,size,state,doc_type,patient_key,birth_verify,created_at,staged_at,birth_salt,birth_key_version,integration_fingerprint,requested_retention_days)
      VALUES(?,?,?,?,?,?,'WRITING',?,?,?,?,?,?,?,?,?)`).run(id,input.requestId,relative(root,path),input.filename,input.fileHash,buffer.length,input.documentCode,input.patientKey,input.birthVerify,input.createdAt,when,input.birthSalt,input.keyVersion,input.integrationFingerprint,input.retentionDays??null);
    else db.prepare(`INSERT INTO document(document_id,request_id,local_path,original_filename,hash,size,state,doc_type,patient_key,birth_verify,created_at,staged_at)
      VALUES(?,?,?,?,?,?,'WRITING',?,?,?,?,?)`).run(id,input.requestId,relative(root,path),input.filename,input.fileHash,buffer.length,input.documentCode,input.patientKey,input.birthVerify,input.createdAt,when);
    return write(get(input.requestId),buffer);
  }
  async function write(item,buffer) {
    const path=filePath(item);
    const tmp=path+'.part-'+randomUUID();
    await checked(dirname(path),true);
    try {
      const handle=await open(tmp,'wx',0o600);
      try { await handle.writeFile(buffer); await handle.sync(); } finally { await handle.close(); }
      await checked(path,false,true);
      await rename(tmp,path);
      db.prepare("UPDATE document SET state='LOCAL_SAVED',last_error_code=NULL WHERE document_id=?").run(item.document_id);
    } catch(error) {
      await unlink(tmp).catch(()=>{});
      db.prepare("UPDATE document SET state='RETRY_PENDING',last_error_code='LOCAL_WRITE_FAILED' WHERE document_id=?").run(item.document_id);
      throw new PhaseError('LOCAL_WRITE_FAILED',503);
    }
    return byId(item.document_id);
  }
  function setPolicy(id,doc) {
    assert(doc.documentId===id && Number.isInteger(doc.retentionDays) && Number.isInteger(doc.validityDays) && doc.retentionDays>=1 && doc.retentionDays<=90 && doc.validityDays>=1 && doc.validityDays<=doc.retentionDays &&
      Date.parse(doc.deleteAt)-Date.parse(doc.registeredAt)===day*doc.retentionDays &&
      Date.parse(doc.expiresAt)-Date.parse(doc.registeredAt)===day*doc.validityDays,'POLICY_SYNC_FAILED',503);
    const changed=db.prepare(`UPDATE document SET state='REGISTERING',registered_at=?,expires_at=?,delete_at=?,retention_days=?,link_validity_days=?,policy_version=?
      WHERE document_id=? AND state NOT IN ('DELETING','DELETED','DELETE_FAILED')`).run(doc.registeredAt,doc.expiresAt,doc.deleteAt,doc.retentionDays,doc.validityDays,Number(doc.policyVersion),id);
    assert(changed.changes===1,'POLICY_SYNC_FAILED',503);
  }
  function ready(id) {
    const changed=db.prepare("UPDATE document SET state='READY',last_error_code=NULL WHERE document_id=? AND state='REGISTERING' AND expires_at>?").run(id,iso(clock()));
    assert(changed.changes===1,'POLICY_SYNC_FAILED',503);
  }
  function retry(id,code) {
    db.prepare("UPDATE document SET state='RETRY_PENDING',retry_count=retry_count+1,last_error_code=? WHERE document_id=? AND state NOT IN ('DELETING','DELETED','DELETE_FAILED')").run(code,id);
  }
  async function handle(id,controller) {
    const item=byId(id);
    assert(item?.state==='READY' && Date.parse(item.expires_at)>clock(),'LINK_UNAVAILABLE',410);
    const file=await readChecked(item);
    if (controller.signal.aborted || byId(id)?.state!=='READY' || Date.parse(item.expires_at)<=clock()) {
      await file.close(); throw new PhaseError('LINK_UNAVAILABLE',410);
    }
    const readers=active.get(id) ?? new Map();
    active.set(id,readers);
    let done;
    const settled=new Promise(resolve=>{done=resolve;});
    readers.set(controller,settled);
    return {file,item,finish:async()=>{
      try { await file.close(); }
      finally { readers.delete(controller); if (!readers.size) active.delete(id); done(); }
    }};
  }
  async function purge() {
    db.prepare('UPDATE document SET birth_verify=NULL WHERE expires_at<=? AND birth_verify IS NOT NULL').run(iso(clock()));
    if(withLinks) {
      db.prepare('DELETE FROM document_link WHERE document_id IN (SELECT document_id FROM document WHERE expires_at<=?)').run(iso(clock()));
      db.prepare('UPDATE document SET birth_salt=NULL WHERE expires_at<=?').run(iso(clock()));
    }
    const pending=db.prepare(`SELECT * FROM document WHERE state!='DELETED' AND
      (delete_at<=? OR (delete_at IS NULL AND staged_at<=?))`).all(iso(clock()),iso(clock()-30*day));
    for (const item of pending) {
      const id=item.document_id;
      db.prepare("UPDATE document SET state='DELETING' WHERE document_id=?").run(id);
      const readers=active.get(id);
      if (readers) {
        for (const controller of readers.keys()) controller.abort();
        await Promise.all(readers.values());
      }
      let ok=true;
      try { await unlink(await checked(filePath(item),false,true)); }
      catch(error) { ok=error.code==='ENOENT'; }
      if (ok) {
        if(withLinks) db.prepare('DELETE FROM document_link WHERE document_id=?').run(id);
        db.prepare(`UPDATE document SET state='DELETED',sync_pending=?,local_path=NULL,original_filename=NULL,patient_key=NULL,birth_verify=NULL,
          last_error_code=NULL WHERE document_id=?`).run(item.delete_at?1:0,id);
      } else {
        db.prepare("UPDATE document SET state='DELETE_FAILED',sync_pending=?,last_error_code='DELETE_FAILED' WHERE document_id=?").run(item.delete_at?1:0,id);
      }
    }
    return pending.length;
  }
  async function recover() {
    for (const item of db.prepare("SELECT * FROM document WHERE state NOT IN ('DELETED','DELETING','DELETE_FAILED')").all()) {
      try {
        const file=await readChecked(item);
        await file.close();
        if (item.state==='WRITING') db.prepare("UPDATE document SET state='LOCAL_SAVED' WHERE document_id=?").run(item.document_id);
      } catch {
        if (item.state!=='RETRY_PENDING') retry(item.document_id,'LOCAL_FILE_UNAVAILABLE');
      }
    }
    async function scan(folder) {
      for (const entry of await readdir(folder,{withFileTypes:true})) {
        const path=resolve(folder,entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await checked(path); await scan(path); continue; }
        if (!entry.isFile() || !/\.pdf(?:\.part-[a-f0-9-]+)?$/.test(entry.name)) continue;
        const owner=db.prepare('SELECT state FROM document WHERE local_path=?').get(relative(root,path));
        if (!owner && (await lstat(path)).mtimeMs<=clock()-30*day) await unlink(await checked(path));
      }
    }
    await scan(resolve(root,'Storage'));
    await purge();
  }
  async function metrics() {
    const data=db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM document WHERE state IN ('LOCAL_SAVED','REGISTERING','READY','RETRY_PENDING','DELETE_FAILED')").get();
    const info=await statfs(root);
    const utilization=info.blocks ? Math.round(100*(1-info.bavail/info.blocks)) : 0;
    return {...data,utilization,warning:utilization>=80};
  }
  return {root,db,get,byId,list,save,write,readChecked,setPolicy,ready,retry,handle,purge,recover,metrics,
    recoverable:()=>db.prepare("SELECT * FROM document WHERE state IN ('LOCAL_SAVED','REGISTERING','RETRY_PENDING') ORDER BY staged_at").all(),
    pending:()=>db.prepare('SELECT * FROM document WHERE sync_pending=1').all(),
    synced:id=>db.prepare('UPDATE document SET sync_pending=0 WHERE document_id=?').run(id)};
}
