import { mkdir, readFile } from 'node:fs/promises';
import { day, agentId, clientId, iso, epoch, mac, sha, assert, requireLocal, types, equal, token } from './common.mjs';

const migrations = ['001_metadata.sql','002_legacy_compat.sql'];
export async function openDatabase(options = {}) {
  const url = options.url ?? process.env.PGS_DATABASE_URL;
  let sql;
  if (url) {
    const parsed = new URL(url);
    assert(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname),'LOCAL_DB_ONLY');
    const {Pool} = requireLocal('pg','PGS_DB_MODULES');
    const pool = new Pool({connectionString:url});
    const run = client => ({
      query:(text,params) => client.query(text,params),
      exec:text => client.query(text),
    });
    sql = {...run(pool),close:() => pool.end(),transaction:async work => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await work(run(client)); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }};
  } else {
    const {PGlite} = requireLocal('@electric-sql/pglite','PGS_DB_MODULES');
    const directory = options.dir ?? process.env.PGS_PGLITE_DIR ?? '.local/phase2/catalog';
    if (directory !== 'memory://') await mkdir(directory, { recursive: true });
    const db = new PGlite(directory);
    sql = db;
  }
  const query = async (db,text,params=[]) => (await db.query(text,params)).rows;
  const one = async (db,text,params=[]) => (await query(db,text,params))[0];
  async function migrate() {
    for (const name of [...migrations,...(options.phase3?['003_patient_auth.sql']:[]),...(options.manager?['004_manager.sql']:[])]) {
      const contents = await readFile(new URL('../../database/migrations/' + name,import.meta.url),'utf8');
      await sql.transaction(tx => tx.exec(contents));
    }
    await sql.query('INSERT INTO pgs_agent(agent_id,client_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[agentId,clientId]);
  }
  await migrate();
  const clock = options.clock ?? Date.now;
  const keys = options.keys;
  const linkFor = doc => Buffer.from(mac(keys.link,doc.document_id+':'+doc.link_generation),'hex').toString('base64url');
  const docById = id => one(sql,'SELECT * FROM pgs_document WHERE document_id=$1',[id]);
  const request = id => one(sql,'SELECT * FROM pgs_document WHERE client_id=$1 AND request_id=$2',[clientId,id]);
  async function setAgent(online) {
    await sql.query('UPDATE pgs_agent SET status=$1,last_seen_at=CASE WHEN $1=\'ONLINE\' THEN $2 ELSE last_seen_at END WHERE agent_id=$3 AND enabled',
      [online?'ONLINE':'OFFLINE',iso(clock()),agentId]);
  }
  async function policies() {
    return {
      policies:await query(sql,'SELECT * FROM pgs_retention_policy ORDER BY code'),
      history:await query(sql,'SELECT * FROM pgs_policy_history ORDER BY id DESC LIMIT 30'),
    };
  }
  async function savePolicy(tx,code,retention,validity,actor) {
    assert(Number.isInteger(retention) && Number.isInteger(validity) && retention >= 1 && retention <= 90 && validity >= 1 && validity <= retention,'INVALID_POLICY');
      await tx.query('LOCK TABLE pgs_retention_policy IN SHARE ROW EXCLUSIVE MODE');
      const old = await one(tx,'SELECT * FROM pgs_retention_policy WHERE code=$1',[code]);
      const {version} = await one(tx,"SELECT nextval('pgs_policy_version') AS version");
      await tx.query(`INSERT INTO pgs_retention_policy(code,retention_days,link_validity_days,policy_version) VALUES($1,$2,$3,$4)
        ON CONFLICT(code) DO UPDATE SET retention_days=$2,link_validity_days=$3,policy_version=$4`,[code,retention,validity,version]);
      await tx.query(`INSERT INTO pgs_policy_history(actor,code,old_retention,old_validity,new_retention,new_validity,changed_at)
        VALUES($7,$1,$2,$3,$4,$5,$6)`,[code,old?.retention_days??null,old?.link_validity_days??null,retention,validity,iso(clock()),actor]);
  }
  async function changePolicy(code,retention,validity,actor='local-test-admin') {
    assert(code==='DEFAULT'||(options.manager?await one(sql,'SELECT 1 FROM pgs_document_type WHERE code=$1',[code]):types.some(type=>type.code===code)),'INVALID_POLICY');
    return sql.transaction(async tx=>{
      await savePolicy(tx,code,retention,validity,actor);
      if(options.manager)await tx.query("INSERT INTO pgs_manager_audit(actor,event,subject) VALUES($1,'POLICY_CHANGED',$2)",[actor,code]);
    });
  }
  const catalog=()=>options.manager?query(sql,'SELECT * FROM pgs_document_type ORDER BY code'):types;
  async function saveType(input,actor){
    const {code,name,title,description,enabled,retentionDays,validityDays}=input;
    assert(typeof code==='string'&&/^G[0-9]{3}$/.test(code)&&typeof enabled==='boolean'&&
      [name,title].every(value=>typeof value==='string'&&value.trim()&&value.length<=80)&&typeof description==='string'&&description.length<=500,'INVALID_DOCUMENT_TYPE');
    return sql.transaction(async tx=>{
      await tx.query(`INSERT INTO pgs_document_type(code,name,title,description,enabled) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(code) DO UPDATE SET name=$2,title=$3,description=$4,enabled=$5`,[code,name.trim(),title.trim(),description,enabled]);
      await savePolicy(tx,code,retentionDays,validityDays,actor);
      await tx.query("INSERT INTO pgs_manager_audit(actor,event,subject) VALUES($1,'DOCUMENT_TYPE_CHANGED',$2)",[actor,code]);
    });
  }
  async function filterDocuments({from,to,type,status,document,agent,page}){
    return query(sql,`SELECT * FROM pgs_document WHERE
      ($1::date IS NULL OR registered_at>=($1::date::timestamp AT TIME ZONE 'Asia/Seoul')) AND
      ($2::date IS NULL OR registered_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Seoul')) AND
      ($3::text IS NULL OR doc_type=$3) AND
      ($4::text IS NULL OR (CASE WHEN status='READY' THEN
        CASE WHEN expires_at>$8::timestamptz THEN 'ACTIVE' ELSE 'EXPIRED' END ELSE status END)=$4) AND
      ($5::text IS NULL OR strpos(document_id::text,$5)>0) AND
      ($6::uuid IS NULL OR agent_id=$6)
      ORDER BY registered_at DESC, document_id LIMIT 51 OFFSET $7`,
      [from,to,type,status,document,agent,page*50,iso(clock())]);
  }
  async function dashboard(){
    const at=iso(clock()), start=iso(Math.floor((clock()+9*3600000)/day)*day-9*3600000);
    const totals=await one(sql,`SELECT count(*) FILTER(WHERE status='READY' AND expires_at>$1) active,
      count(*) FILTER(WHERE registered_at>=$2) today,
      count(*) FILTER(WHERE status='READY' AND expires_at>$1 AND expires_at<=($1::timestamptz+interval '7 days')) expiring,
      count(*) FILTER(WHERE status='EXPIRED' OR (status='READY' AND expires_at<=$1)) expired,
      count(*) FILTER(WHERE status='REVOKED') revoked,
      count(*) FILTER(WHERE status IN ('FAILED','DELETE_FAILED')) failed,
      count(*) FILTER(WHERE status='REGISTERING') pending FROM pgs_document`,[at,start]);
    const byType=await query(sql,'SELECT doc_type code,count(*) total FROM pgs_document GROUP BY doc_type ORDER BY doc_type');
    const daily=await query(sql,`SELECT to_char(registered_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "day",count(*) total
      FROM pgs_document WHERE registered_at>=($1::timestamptz-interval '13 days') GROUP BY 1 ORDER BY 1`,[start]);
    return {totals,byType,daily};
  }
  async function register(input) {
    const {documentId,requestId,documentCode,fileSize,fileHash,createdAt,patientKey,birthVerify,tokenHash,birthSalt,keyVersion} = input;
    return sql.transaction(async tx => {
      const agent = await one(tx,'SELECT enabled FROM pgs_agent WHERE agent_id=$1 AND client_id=$2 FOR UPDATE',[agentId,clientId]);
      assert(agent?.enabled,'AGENT_FORBIDDEN',403);
      const old = await one(tx,'SELECT * FROM pgs_document WHERE client_id=$1 AND request_id=$2',[clientId,requestId]);
      if (old) {
        assert(old.document_id === documentId && old.agent_id === agentId && old.file_hash === fileHash && Number(old.file_size) === fileSize &&
          old.doc_type === documentCode && iso(old.created_at) === iso(createdAt) &&
          (old.patient_key === patientKey || old.patient_key === null) && (old.birth_verify === birthVerify || old.birth_verify === null),'REQUEST_CONFLICT',409);
        if (options.phase3 && old.initial_token_hash) assert(old.initial_token_hash===tokenHash && old.birth_salt===birthSalt && old.key_version===keyVersion,'REQUEST_CONFLICT',409);
        return {doc:old,created:false};
      }
      assert(!await one(tx,'SELECT 1 FROM pgs_document WHERE document_id=$1',[documentId]),'REQUEST_CONFLICT',409);
      const kind=options.manager?await one(tx,'SELECT * FROM pgs_document_type WHERE code=$1 FOR SHARE',[documentCode]):types.find(type=>type.code===documentCode);
      assert(kind&&kind.enabled!==false,'INVALID_DOCUMENT_CODE',400);
      const policy = await one(tx,"SELECT * FROM pgs_retention_policy WHERE code IN ($1,'DEFAULT') ORDER BY (code=$1) DESC LIMIT 1",[documentCode]);
      const retentionDays=Math.min(input.requestedRetentionDays??policy.retention_days,policy.retention_days);
      const validityDays=Math.min(policy.link_validity_days,retentionDays);
      const now = clock();
      const doc = await one(tx,`INSERT INTO pgs_document(document_id,agent_id,client_id,request_id,patient_key,birth_verify,doc_type,doc_title,file_size,file_hash,
        created_at,registered_at,expires_at,delete_at,retention_days,link_validity_days,policy_version,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'REGISTERING') RETURNING *`,
        [documentId,agentId,clientId,requestId,patientKey,birthVerify,documentCode,kind.title??kind.name,fileSize,fileHash,createdAt,
          iso(now),iso(now+day*validityDays),iso(now+day*retentionDays),retentionDays,validityDays,policy.policy_version]);
      if (options.phase3) {
        await tx.query('UPDATE pgs_document SET birth_salt=$1,initial_token_hash=$2,key_version=$3 WHERE document_id=$4',[birthSalt,tokenHash,keyVersion,documentId]);
        Object.assign(doc,{birth_salt:birthSalt,initial_token_hash:tokenHash,key_version:keyVersion});
      }
      return {doc,created:true};
    });
  }
  async function activate(id) {
    return sql.transaction(async tx => {
      const doc = await one(tx,'SELECT * FROM pgs_document WHERE document_id=$1 AND agent_id=$2 FOR UPDATE',[id,agentId]);
      assert(doc,'DOCUMENT_NOT_FOUND',404);
      assert(['REGISTERING','READY'].includes(doc.status) && epoch(doc.expires_at)>clock(),'LINK_UNAVAILABLE',410);
      await tx.query("UPDATE pgs_document SET status='READY' WHERE document_id=$1",[id]);
      if (options.phase3) {
        if (doc.status==='REGISTERING') await tx.query('INSERT INTO pgs_access_token(token_hash,document_id,issued_at,expires_at) VALUES($1,$2,$3,$4)',
          [doc.initial_token_hash??sha(linkFor(doc)),id,iso(clock()),iso(doc.expires_at)]);
      } else {
        await tx.query('INSERT INTO pgs_access_token(token_hash,document_id,expires_at) VALUES($1,$2,$3) ON CONFLICT(document_id) DO NOTHING',
          [sha(linkFor(doc)),id,iso(doc.expires_at)]);
      }
      return {...doc,status:'READY'};
    });
  }
  const active = doc => {
    assert(doc?.status === 'READY' && epoch(doc.expires_at)>clock(),'LINK_UNAVAILABLE',410);
    return doc;
  };
  async function modify(id,action) {
    return sql.transaction(async tx => {
      const doc = active(await one(tx,'SELECT * FROM pgs_document WHERE document_id=$1 FOR UPDATE',[id]));
      await tx.query('DELETE FROM pgs_access_token WHERE document_id=$1',[id]);
      if (action === 'revoke') {
        await tx.query("UPDATE pgs_document SET status='REVOKED',birth_verify=NULL WHERE document_id=$1",[id]);
      } else {
        const changed = await one(tx,'UPDATE pgs_document SET link_generation=link_generation+1 WHERE document_id=$1 RETURNING *',[id]);
        await tx.query('INSERT INTO pgs_access_token(token_hash,document_id,expires_at) VALUES($1,$2,$3)',[sha(linkFor(changed)),id,iso(doc.expires_at)]);
      }
    });
  }
  async function verify(raw,birth) {
    const outcome = await sql.transaction(async tx => {
      const record = await one(tx,`SELECT d.*,t.fail_count,t.locked_until FROM pgs_access_token t JOIN pgs_document d USING(document_id)
        WHERE t.token_hash=$1 FOR UPDATE OF d,t`,[sha(raw)]);
      active(record);
      const now = clock();
      if (record.locked_until && epoch(record.locked_until)>now) return 'LOCKED';
      const key = sha(raw);
      if (!/^\d{8}$/.test(birth) || !equal(mac(keys.subject,record.document_id+':'+birth), record.birth_verify)) {
        const attempts = record.locked_until ? 1 : record.fail_count+1;
        await tx.query('UPDATE pgs_access_token SET fail_count=$1,locked_until=$2 WHERE token_hash=$3',
          [attempts,attempts>=5?iso(now+30*60000):null,key]);
        return attempts>=5?'LOCKED':'DATE_MISMATCH';
      }
      await tx.query('UPDATE pgs_access_token SET fail_count=0,locked_until=NULL WHERE token_hash=$1',[key]);
      const session = token();
      await tx.query('INSERT INTO pgs_session(session_hash,token_hash,expires_at) VALUES($1,$2,$3)',
        [sha(session),key,iso(Math.min(now+900000,epoch(record.expires_at)))]);
      return {session};
    });
    assert(typeof outcome !== 'string',outcome, outcome==='LOCKED'?429:401);
    return outcome.session;
  }
  async function patient(session) {
    const record = await one(sql,`SELECT d.*,s.expires_at AS session_expires_at FROM pgs_session s JOIN pgs_access_token t USING(token_hash) JOIN pgs_document d USING(document_id)
      WHERE s.session_hash=$1 AND s.expires_at>$2`,[sha(session),iso(clock())]);
    assert(record,'SESSION_REQUIRED',401);
    return active(record);
  }
  async function cleanup() {
    await sql.transaction(async tx => {
      const now=iso(clock());
      if (options.phase3) { await tx.query('DELETE FROM pgs_auth_rate WHERE window_start < $1',[clock()-120000]); await tx.query('UPDATE pgs_document SET birth_salt=NULL,initial_token_hash=NULL WHERE expires_at<=$1',[now]); }
      await tx.query('DELETE FROM pgs_session WHERE expires_at <= $1',[now]);
      await tx.query('DELETE FROM pgs_access_token WHERE expires_at <= $1',[now]);
      await tx.query(`UPDATE pgs_document SET birth_verify=NULL,status=CASE WHEN status IN ('READY','REGISTERING') THEN 'EXPIRED' ELSE status END
        WHERE expires_at <= $1 AND status != 'DELETED'`,[now]);
    });
  }
  async function deletion(id,ok) {
    await sql.transaction(async tx => {
      const doc = await one(tx,'SELECT * FROM pgs_document WHERE document_id=$1 AND agent_id=$2 FOR UPDATE',[id,agentId]);
      if (!doc || doc.status === 'DELETED') return;
      assert(epoch(doc.delete_at)<=clock(),'DELETE_NOT_DUE',409);
      await tx.query('DELETE FROM pgs_access_token WHERE document_id=$1',[id]);
      await tx.query(`UPDATE pgs_document SET status=$2,birth_verify=NULL,
        patient_key=CASE WHEN $3 THEN NULL ELSE patient_key END,file_hash=CASE WHEN $3 THEN NULL ELSE file_hash END,
        deleted_at=CASE WHEN $3 THEN $4::timestamptz ELSE NULL END WHERE document_id=$1`,[id,ok?'DELETED':'DELETE_FAILED',ok,iso(clock())]);
      await tx.query('INSERT INTO pgs_delete_log(document_id,result_code,occurred_at) VALUES($1,$2,$3)',[id,ok?'DELETED':'DELETE_FAILED',iso(clock())]);
    });
  }
  return {
    sql,migrate,request,register,activate,docById,changePolicy,policies,catalog,saveType,filterDocuments,dashboard,modify,verify,patient,cleanup,deletion,active,linkFor,setAgent,
    agent:()=>one(sql,'SELECT * FROM pgs_agent WHERE agent_id=$1',[agentId]),
    search:key=>query(sql,'SELECT document_id FROM pgs_document WHERE patient_key=$1',[key]),
    list:()=>query(sql,'SELECT * FROM pgs_document ORDER BY registered_at DESC LIMIT 250'),
  };
}
