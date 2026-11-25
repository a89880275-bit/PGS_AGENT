import { createCipheriv,createDecipheriv,randomBytes,createHash } from 'node:crypto';
import { assert,equal,mac,sha } from '../phase2/common.mjs';
export const phase3=process.env.PGS_PHASE3==='1';
export const authPolicy=Object.freeze({maxAttempts:5,lockMinutes:30,sessionMinutes:15});
export const opaque=/^[A-Za-z0-9_-]{43}$/;
export const birthProof=(key,id,salt,birth)=>mac(key,JSON.stringify(['pgs-birth-v2',id,salt,birth]));
const keyOf=key=>createHash('sha256').update('pgs-agent-link-storage\0').update(key).digest();
const context=(id,generation)=>Buffer.from(JSON.stringify([id,generation]));
export function seal(key,id,generation,raw) {
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',keyOf(key),iv);
  cipher.setAAD(context(id,generation));
  return Buffer.concat([iv,cipher.update(raw,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64url');
}
export function unseal(key,id,generation,value) {
  const data=Buffer.from(value,'base64url');
  const cipher=createDecipheriv('aes-256-gcm',keyOf(key),data.subarray(0,12));
  cipher.setAAD(context(id,generation));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([cipher.update(data.subarray(12,-16)),cipher.final()]).toString('utf8');
}
export function signEnvelope(key,payload) {
  const data=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return data+'.'+mac(key,data);
}
export function readEnvelope(key,raw,purpose,now) {
  assert(typeof raw==='string'&&raw.length<1024,'FORBIDDEN',403);
  const parts=raw.split('.');
  assert(parts.length===2&&equal(mac(key,parts[0]),parts[1]),'FORBIDDEN',403);
  const payload=JSON.parse(Buffer.from(parts[0],'base64url').toString());
  assert(payload.purpose===purpose&&Number.isSafeInteger(payload.exp)&&payload.exp>now,'FORBIDDEN',403);
  return payload;
}
export function linkVault(storage,key) {
  const get=(id,generation)=>storage.db.prepare('SELECT sealed_token FROM document_link WHERE document_id=? AND generation=?').get(id,generation);
  const read=(id,generation)=> {
    const row=get(id,generation);
    return row?unseal(key,id,generation,row.sealed_token):null;
  };
  function prepare(id,generation,rawFactory) {
    const prior=read(id,generation);
    if (prior) return prior;
    const raw=rawFactory();
    storage.db.prepare('INSERT INTO document_link(document_id,generation,sealed_token) VALUES(?,?,?)').run(id,generation,seal(key,id,generation,raw));
    return raw;
  }
  return {read,prepare,forgetBefore:(id,generation)=>storage.db.prepare('DELETE FROM document_link WHERE document_id=? AND generation<?').run(id,generation),
    hash:(id,generation)=>{const raw=read(id,generation);return raw?sha(raw):null;}};
}