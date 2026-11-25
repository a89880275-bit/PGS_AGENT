import {randomBytes,scrypt as derive} from 'node:crypto';
import {promisify} from 'node:util';
import {assert,body,equal,getCookie,json,sha,token,integer,epoch} from './common.mjs';
const scrypt=promisify(derive);
const namePattern=/^[a-z][a-z0-9_-]{1,29}$/;
const roles=['SYSTEM','OPERATOR','VIEWER'];
const cookieName='pgs_manager';
const encode=async(password,salt)=>Buffer.from(await scrypt(password,salt,32)).toString('hex');

export async function managerAuth(db,origin){
  assert(origin.startsWith('https:'),'MANAGER_HTTPS_REQUIRED');
  const run=(sql,params)=>db.sql.query(sql,params);
  const one=async(sql,params)=>(await run(sql,params)).rows[0];
  const audit=(actor,event,subject=null,tx=db.sql)=>tx.query('INSERT INTO pgs_manager_audit(actor,event,subject) VALUES($1,$2,$3)',[actor,event,subject]);
  const bootstrap=JSON.parse(process.env.PGS_MANAGER_BOOTSTRAP??'[]');
  for(const user of bootstrap){
    assert(namePattern.test(user.username)&&roles.includes(user.role)&&typeof user.password==='string'&&user.password.length>=16&&user.password.length<=128,'INVALID_MANAGER_BOOTSTRAP');
    if(await one('SELECT 1 FROM pgs_manager_user WHERE username=$1',[user.username]))continue;
    const salt=randomBytes(16).toString('hex');
    await run('INSERT INTO pgs_manager_user VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[user.username,user.role,salt+':'+await encode(user.password,salt)]);
  }
  assert(await one("SELECT 1 FROM pgs_manager_user WHERE role='SYSTEM' LIMIT 1"),'MANAGER_BOOTSTRAP_REQUIRED');
  const lifetime=integer('PGS_MANAGER_SESSION_SECONDS',1800,60,28800);
  const cookie=(value,age)=>cookieName+'='+value+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age='+age;
  let loginWindow=0,attempts=0;
  async function session(req,required){
    const raw=getCookie(req,cookieName);
    assert(/^[\w-]{43}$/.test(raw),'ADMIN_REQUIRED',403);
    const row=await one('SELECT u.username,u.role,s.expires_at FROM pgs_manager_session s JOIN pgs_manager_user u USING(username) WHERE token_hash=$1',[sha(raw)]);
    assert(row&&epoch(row.expires_at)>Date.now(),'ADMIN_REQUIRED',403);
    assert(!required||required.includes(row.role),'ADMIN_ROLE_REQUIRED',403);
    return {username:row.username,role:row.role};
  }
  async function handle(req,res,path){
    if(req.method==='GET'&&path==='/api/v1/manager/session')return json(res,await session(req));
    assert(req.method==='POST'&&req.headers.origin===origin,'FORBIDDEN',403);
    const input=await body(req,4096);
    if(path==='/api/v1/manager/login'){
      const now=Date.now();
      if(now-loginWindow>=60000){loginWindow=now;attempts=0;}
      assert(++attempts<=30,'ADMIN_LOGIN_LIMIT',429);
      assert(typeof input.password==='string'&&input.password.length<=128&&typeof input.username==='string'&&namePattern.test(input.username),'ADMIN_LOGIN_FAILED',401);
      const row=await one('SELECT * FROM pgs_manager_user WHERE username=$1',[input.username]);
      const [salt,hash]=(row?.password_hash??'00000000000000000000000000000000:'+sha('missing')).split(':');
      if(!equal(await encode(input.password,salt),hash)||!row){await audit('anonymous','LOGIN_FAILED');assert(false,'ADMIN_LOGIN_FAILED',401);}
      const raw=token();
      await run('DELETE FROM pgs_manager_session WHERE expires_at<=CURRENT_TIMESTAMP');
      await run('INSERT INTO pgs_manager_session VALUES($1,$2,$3)',[sha(raw),row.username,new Date(now+lifetime*1000).toISOString()]);
      await audit(row.username,'LOGIN');
      res.setHeader('Set-Cookie',cookie(raw,lifetime));
      return json(res,{username:row.username,role:row.role});
    }
    if(path==='/api/v1/manager/logout'){
      const who=await session(req);
      await run('DELETE FROM pgs_manager_session WHERE token_hash=$1',[sha(getCookie(req,cookieName))]);
      await audit(who.username,'LOGOUT');
      res.setHeader('Set-Cookie',cookie('',0));
      return json(res,{ok:true});
    }
    if(path==='/api/v1/manager/roles'){
      const who=await session(req,['SYSTEM']);
      assert(namePattern.test(input.username??'')&&roles.includes(input.role),'INVALID_ROLE');
      await db.sql.transaction(async tx=>{
        await tx.query('LOCK TABLE pgs_manager_user IN SHARE ROW EXCLUSIVE MODE');
        const old=(await tx.query('SELECT role FROM pgs_manager_user WHERE username=$1',[input.username])).rows[0];
        assert(old,'ADMIN_NOT_FOUND',404);
        if(old.role==='SYSTEM'&&input.role!=='SYSTEM'){
          const {n}=(await tx.query("SELECT count(*) n FROM pgs_manager_user WHERE role='SYSTEM'")).rows[0];
          assert(Number(n)>1,'LAST_SYSTEM_ADMIN',409);
        }
        await tx.query('UPDATE pgs_manager_user SET role=$1 WHERE username=$2',[input.role,input.username]);
        await tx.query('DELETE FROM pgs_manager_session WHERE username=$1',[input.username]);
        await tx.query("INSERT INTO pgs_manager_audit(actor,event,subject) VALUES($1,'ROLE_CHANGED',$2)",[who.username,input.username]);
      });
      return json(res,{ok:true});
    }
    assert(false,'NOT_FOUND',404);
  }
  return {session,handle,audit,users:async()=> (await run('SELECT username,role FROM pgs_manager_user ORDER BY username')).rows,
    events:async()=> (await run('SELECT actor,event,subject,occurred_at FROM pgs_manager_audit ORDER BY id DESC LIMIT 100')).rows};
}