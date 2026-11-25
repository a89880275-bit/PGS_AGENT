import {lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {assert,PhaseError,sha,maxPdf,requestPattern,uuid,hashPattern} from '../phase2/common.mjs';

const filePattern=/^[a-z0-9][a-z0-9_-]{0,119}\.pdf$/i;
const device=/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])\./i;
const codes=new Set(['G001','G002']);
export function registration(input,keyVersions,patientDigits) {
  const fields=['requestId','documentId','fileName','fileSha256','documentCode','patientNo','birthSalt','birthVerify','keyVersion','retentionDays'];
  assert(Object.keys(input).every(key=>fields.includes(key)),'INVALID_REQUEST');
  for (const [name,pattern] of [['requestId',requestPattern],['documentId',uuid],['fileSha256',hashPattern],['birthSalt',hashPattern],['birthVerify',hashPattern]]) {
    assert(typeof input[name]==='string'&&pattern.test(input[name]),'INVALID_REQUEST');
  }
  assert(typeof input.fileName==='string'&&filePattern.test(input.fileName)&&!device.test(input.fileName),'INVALID_FILE_NAME');
  assert(process.env.PGS_PHASE5B==='1'?typeof input.documentCode==='string'&&/^G[0-9]{3}$/.test(input.documentCode):codes.has(input.documentCode),'INVALID_DOCUMENT_CODE');
  assert(input.patientNo===undefined||typeof input.patientNo==='string'&&new RegExp('^\\d{'+patientDigits+'}$').test(input.patientNo),'INVALID_PATIENT_NO');
  assert(Number.isInteger(input.keyVersion)&&input.keyVersion>=2&&keyVersions.has(input.keyVersion),'UNKNOWN_KEY_VERSION');
  assert(input.retentionDays===undefined||Number.isInteger(input.retentionDays)&&input.retentionDays>=1&&input.retentionDays<=90,'INVALID_RETENTION_DAYS');
  return input;
}
export function internalRegistration(input,keyVersions,patientDigits){
  const {requestId,fileName,fileSha256,documentType,birthVerifier,retentionDays,patientNo}=input;
  assert(Object.keys(input).every(key=>['requestId','fileName','fileSha256','documentType','birthVerifier','retentionDays','patientNo'].includes(key)),'INVALID_REQUEST');
  assert(birthVerifier&&typeof birthVerifier==='object'&&!Array.isArray(birthVerifier)&&
    Object.keys(birthVerifier).every(key=>['documentId','salt','value','keyVersion'].includes(key)),'INVALID_REQUEST');
  return registration({requestId,fileName,fileSha256,documentCode:documentType,retentionDays,patientNo,
    documentId:birthVerifier.documentId,birthSalt:birthVerifier.salt,birthVerify:birthVerifier.value,keyVersion:birthVerifier.keyVersion},keyVersions,patientDigits);
}
const messages={
 OK:'처리가 완료되었습니다.', ACCEPTED:'등록 결과를 요청 ID로 다시 조회하세요.', AUTH_REQUIRED:'유효한 API Key가 필요합니다.',
 FORBIDDEN:'허용된 내부 호출만 가능합니다.', INVALID_REQUEST:'요청 형식이 올바르지 않습니다.', INVALID_FILE_NAME:'허용된 PDF 파일명만 사용할 수 있습니다.',
 INVALID_DOCUMENT_CODE:'지원하지 않는 문서 종류입니다.', INVALID_PATIENT_NO:'환자번호 형식을 확인하세요.', INVALID_RETENTION_DAYS:'보관기간은 1~90일 정수여야 합니다.',
 UNKNOWN_KEY_VERSION:'지원하지 않는 검증 키 버전입니다.', UNSAFE_INTAKE:'지정된 공유 폴더의 일반 파일만 인수할 수 있습니다.',
 INTAKE_NOT_FOUND:'인수 폴더에서 파일을 찾을 수 없습니다.', REQUEST_NOT_FOUND:'등록 요청 또는 문서를 찾을 수 없습니다.',
 REQUEST_BUSY:'처리 중입니다. 요청 ID로 결과를 조회하세요.', REQUEST_CONFLICT:'동일 요청 ID의 등록 내용이 다릅니다.',
 DOCUMENT_CONFLICT:'이미 사용된 문서 ID입니다.', FILE_CHANGED:'인수 중 파일이 변경되었습니다.', FILE_HASH_MISMATCH:'PDF 해시가 일치하지 않습니다.',
 LINK_UNAVAILABLE:'조회 링크가 만료되었거나 사용할 수 없습니다.', INVALID_FILE_SIZE:'PDF 크기 제한을 확인하세요.',
 TOO_LARGE:'요청 또는 파일 크기 제한을 초과했습니다.', JSON_ONLY:'JSON 요청만 지원합니다.', INVALID_JSON:'유효한 JSON이 필요합니다.',
 INVALID_PDF:'유효한 PDF가 필요합니다.', USE_SYNTHETIC_PDF:'로컬 시험에서 승인된 합성 PDF만 인수할 수 있습니다.',
 METHOD_NOT_ALLOWED:'허용된 메서드를 사용하세요.', NOT_FOUND:'존재하지 않는 내부 API입니다.', SERVICE_UNAVAILABLE:'일시적으로 처리할 수 없습니다. 요청 ID로 결과를 조회하세요.',
};
export function internalResponse(data={},code='OK',success=true){
  const {requestId=null,documentId=null,viewUrl=null,expiresAt=null,status,...fields}=data;
  return {success,resultCode:code,message:messages[code]??messages.SERVICE_UNAVAILABLE,requestId,documentId,guideUrl:viewUrl,expiresAt,
    ...(status?{status}:{}),...(fields.agent?{agent:fields.agent,relay:fields.relay}:{}),
    ...(fields.retentionDays?{retentionDays:fields.retentionDays}:{}),...(fields.deleteAt?{deleteAt:fields.deleteAt}:{})};
}
export async function readIntake(root,name,expectedHash) {
  assert(filePattern.test(name)&&!device.test(name),'INVALID_FILE_NAME');
  const path=join(root,name);
  let handle;
  try{
    const folder=await lstat(root);
    assert(folder.isDirectory()&&!folder.isSymbolicLink()&&await realpath(root)===root,'UNSAFE_INTAKE',403);
    const before=await lstat(path);
    assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&await realpath(path)===path,'UNSAFE_INTAKE',403);
    assert(before.size>0&&before.size<=maxPdf,'INVALID_FILE_SIZE',413);
    handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const matches=info=>info.isFile()&&info.nlink===1&&info.ino===before.ino&&info.dev===before.dev&&info.size===before.size&&info.mtimeMs===before.mtimeMs&&info.ctimeMs===before.ctimeMs;
    assert(matches(await handle.stat())&&await realpath(path)===path,'FILE_CHANGED',409);
    const bytes=Buffer.alloc(before.size);
    let offset=0;
    while(offset<bytes.length){
      const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
      assert(bytesRead>0,'FILE_CHANGED',409);
      offset+=bytesRead;
    }
    assert(matches(await handle.stat())&&matches(await lstat(path))&&await realpath(path)===path,'FILE_CHANGED',409);
    assert(sha(bytes)===expectedHash,'FILE_HASH_MISMATCH',409);
    return bytes;
  }catch(error){
    if(error.code==='ENOENT')throw new PhaseError('INTAKE_NOT_FOUND',404);
    if(error.code==='ELOOP')throw new PhaseError('UNSAFE_INTAKE',403);
    throw error;
  }finally{await handle?.close();}
}
export function acquireAgentInstance(db){
  db.exec('CREATE TABLE IF NOT EXISTS pgs_agent_instance (singleton INTEGER PRIMARY KEY CHECK(singleton=1),pid INTEGER NOT NULL)');
  db.exec('BEGIN IMMEDIATE');
  try{
    const old=db.prepare('SELECT pid FROM pgs_agent_instance WHERE singleton=1').get();
    if(old){
      let running=true;
      try{process.kill(old.pid,0);}catch(error){running=error.code!=='ESRCH';}
      assert(!running,'AGENT_ALREADY_RUNNING',409);
    }
    db.prepare('INSERT OR REPLACE INTO pgs_agent_instance VALUES(1,?)').run(process.pid);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
