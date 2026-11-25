import { isCalendarDate } from '../../packages/shared/policy.ts';
import { assert,epoch,equal,integer,iso,mac,sha,token } from '../phase2/common.mjs';
import { authPolicy,birthProof,opaque,readEnvelope,signEnvelope } from './crypto.mjs';

export function patientAuth(db,keys,clock=Date.now) {
  const minute=60000;
  const rates=[
    integer('PGS_AUTH_GLOBAL_PER_MINUTE',300,1,10000),
    integer('PGS_AUTH_IP_PER_MINUTE',60,1,10000),
    integer('PGS_AUTH_TOKEN_PER_MINUTE',15,5,10000),
  ];
  const one=async(tx,query,params)=>(await tx.query(query,params)).rows[0];
  const activeToken=(tx,id)=>one(tx,'SELECT * FROM pgs_access_token WHERE document_id=$1 AND revoked_at IS NULL',[id]);
  const rate=async(tx,ip,hash,now)=>{
    const cut=Math.floor(now/minute)*minute;
    const contexts=['global','ip:'+ip,'token:'+hash];
    for(let i=0;i<contexts.length;i++){
      const key=mac(keys.rate,contexts[i]);
      const result=await one(tx,`INSERT INTO pgs_auth_rate AS r(bucket,window_start,hits) VALUES($1,$2,1)
        ON CONFLICT(bucket,window_start) DO UPDATE SET hits=r.hits+1 WHERE r.hits<$3 RETURNING hits`,[key,cut,rates[i]]);
      if(!result) return false;
    }
    return true;
  };
  const reauth=(hash,expires)=>signEnvelope(keys.rate,{purpose:'reauth',hash,exp:expires});
  function reauthHash(cookie) {
    try{return readEnvelope(keys.rate,cookie,'reauth',clock()).hash;}
    catch{return null;}
  }
  async function verify(raw,birth,ip,prior) {
    const hash=typeof raw==='string'&&opaque.test(raw)?sha(raw):!raw?reauthHash(prior?.reauth):null;
    const now=clock(), timestamp=iso(now);
    const result=await db.sql.transaction(async tx=>{
      if (!await rate(tx,ip,hash??'invalid',now)) return ['AUTH_LIMIT',429];
      if (!hash) return ['LINK_UNAVAILABLE',410];
      const row=await one(tx,`SELECT d.*,t.token_id,t.token_hash,t.fail_count,t.locked_until,t.revoked_at,t.expires_at AS token_expiry
        FROM pgs_document d JOIN pgs_access_token t USING(document_id) WHERE t.token_hash=$1 FOR UPDATE OF d,t`,[hash]);
      if(!row||row.status!=='READY'||row.revoked_at||epoch(row.expires_at)<=now||epoch(row.token_expiry)<=now) return ['LINK_UNAVAILABLE',410];
      if(row.locked_until&&epoch(row.locked_until)>now) return ['LOCKED',429];
      const key=row.birth_salt?keys.birth.get(row.key_version):keys.legacySubject;
      const valid=typeof birth==='string'&&isCalendarDate(birth)&&key&&equal(row.birth_verify,
        row.birth_salt?birthProof(key,row.document_id,row.birth_salt,birth):mac(key,row.document_id+':'+birth));
      if(!valid){
        const n=row.locked_until?1:row.fail_count+1;
        await tx.query('UPDATE pgs_access_token SET fail_count=$1,locked_until=$2 WHERE token_hash=$3',
          [n,n>=authPolicy.maxAttempts?iso(now+authPolicy.lockMinutes*minute):null,hash]);
        await tx.query('INSERT INTO pgs_security_log(actor_key,event_type,result_code,occurred_at) VALUES($1,$2,$3,$4)',
          [mac(keys.rate,'audit:'+row.token_id),'DOB_VERIFY',n>=authPolicy.maxAttempts?'LOCKED':'MISMATCH',timestamp]);
        return n>=authPolicy.maxAttempts?['LOCKED',429]:['DATE_MISMATCH',401];
      }
      const expires=Math.min(epoch(row.expires_at),epoch(row.token_expiry));
      const sessionExpires=Math.min(now+authPolicy.sessionMinutes*minute,expires);
      const session=token();
      if(prior?.session) await tx.query('UPDATE pgs_session SET revoked_at=$1 WHERE session_hash=$2 AND revoked_at IS NULL',[timestamp,sha(prior.session)]);
      await tx.query('UPDATE pgs_access_token SET fail_count=0,locked_until=NULL WHERE token_hash=$1',[hash]);
      await tx.query('INSERT INTO pgs_session(session_hash,token_hash,token_id,document_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [sha(session),hash,row.token_id,row.document_id,timestamp,iso(sessionExpires)]);
      return {session,sessionExpires,reauth:reauth(hash,expires),reauthExpires:expires,name:row.doc_title,expiresAt:iso(expires),sessionExpiresAt:iso(sessionExpires)};
    });
    if(Array.isArray(result)) assert(false,...result);
    return result;
  }
  async function session(raw) {
    assert(typeof raw==='string'&&opaque.test(raw),'SESSION_REQUIRED',401);
    const row=await one(db.sql,`SELECT d.*,LEAST(s.expires_at,t.expires_at,d.expires_at) AS session_expires_at,s.session_hash
      FROM pgs_session s JOIN pgs_access_token t USING(token_id,document_id,token_hash) JOIN pgs_document d USING(document_id)
      WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND t.revoked_at IS NULL AND d.status='READY'
        AND LEAST(s.expires_at,t.expires_at,d.expires_at)>$2`,[sha(raw),iso(clock())]);
    assert(row,'SESSION_REQUIRED',401);
    return row;
  }
  async function logout(raw) {
    const hash=sha(raw);
    await db.sql.query('UPDATE pgs_session SET revoked_at=$1 WHERE session_hash=$2 AND revoked_at IS NULL',[iso(clock()),hash]);
    return hash;
  }
  async function rotate(id,generation,hash,revoke=false,recordChange) {
    return db.sql.transaction(async tx=>{
      const row=db.active(await one(tx,'SELECT * FROM pgs_document WHERE document_id=$1 FOR UPDATE',[id]));
      const current=await activeToken(tx,id);
      if(!revoke&&row.link_generation===generation&&current?.token_hash===hash) return row;
      assert(revoke||generation===row.link_generation+1,'LINK_CONFLICT',409);
      const time=iso(clock());
      await recordChange?.(tx);
      if(current){
        await tx.query('UPDATE pgs_session SET revoked_at=$1 WHERE token_id=$2 AND revoked_at IS NULL',[time,current.token_id]);
        await tx.query('UPDATE pgs_access_token SET revoked_at=$1 WHERE token_id=$2',[time,current.token_id]);
      }
      if(revoke){
        await tx.query("UPDATE pgs_document SET status='REVOKED',birth_verify=NULL,birth_salt=NULL,initial_token_hash=NULL WHERE document_id=$1",[id]);
        return {...row,status:'REVOKED'};
      }
      await tx.query('INSERT INTO pgs_access_token(token_hash,document_id,issued_at,expires_at) VALUES($1,$2,$3,$4)',[hash,id,time,iso(row.expires_at)]);
      await tx.query('UPDATE pgs_document SET link_generation=$2 WHERE document_id=$1',[id,generation]);
      return {...row,link_generation:generation};
    });
  }
  function cookie(name,value,maxAge,tls) {
    return name+'='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+Math.max(0,Math.ceil(maxAge/1000))+(tls?'; Secure':'');
  }
  return {verify,session,logout,rotate,cookie,activeToken};
}