import { checkServerIdentity } from 'node:tls';
import { phase3 } from '../phase3/crypto.mjs';
import { randomUUID } from 'node:crypto';
import { assert, PhaseError, agentId, equal, integer, iso, epoch, mac, maxPdf, requireLocal, uuid } from './common.mjs';

const chunkMax = 64 * 1024;
const headerBytes = 40;
const signingText = frame => [frame.requestId,frame.documentId,frame.agentId,frame.deadline,frame.purpose??'LEGACY'].join(':');
export const sign = (key,frame) => mac(key,signingText(frame));
export function verifyFetch(key,frame,now,used) {
  if(phase3) assert(['VIEW','DOWNLOAD','ADMIN_PREVIEW'].includes(frame.purpose),'FETCH_FORBIDDEN',403);
  assert(uuid.test(frame.requestId) && uuid.test(frame.documentId) && frame.agentId===agentId && [undefined,'VIEW','DOWNLOAD','ADMIN_PREVIEW'].includes(frame.purpose) &&
    Number.isSafeInteger(frame.deadline) && frame.deadline>now && frame.deadline-now<=integer('PGS_TOTAL_MS',30000) &&
    equal(sign(key,frame),frame.proof) && !used.has(frame.requestId),'FETCH_FORBIDDEN',403);
  used.set(frame.requestId,frame.deadline);
}
const encode = obj => JSON.stringify(obj);
const send = (ws,obj) => ws.send(encode(obj));

export function attachRelay(server,{db,keys,clock=Date.now}) {
  const WebSocket=requireLocal('faye-websocket');
  const offline=integer('PGS_OFFLINE_MS',45000);
  const first=integer('PGS_FIRST_MS',10000);
  const total=integer('PGS_TOTAL_MS',30000);
  const maxConcurrent=integer('PGS_CONCURRENT',10,1,10);
  const transfers=new Map();
  let connection=null;
  function terminate(job,error) {
    if (!transfers.delete(job.id)) return;
    clearTimeout(job.firstTimer); clearTimeout(job.totalTimer);
    job.response.off('close',job.cancel);
    if (error) {
      send(job.conn.ws,{type:'CANCEL',requestId:job.id});
      job.reject(error);
    } else { job.response.end(); job.resolve(); }
  }
  function failConnection(conn) {
    if (connection===conn) {
      connection=null;
      db.setAgent(false).catch(()=>{});
    }
    for (const job of transfers.values()) if (job.conn===conn) terminate(job,new PhaseError('AGENT_OFFLINE',503));
    conn.ws.close(1000);
  }
  async function onText(conn,message) {
    const frame=JSON.parse(message);
    if (!conn.ready) {
      assert(!conn.handshaking && frame.type==='HELLO' && frame.agentId===agentId,'AGENT_FORBIDDEN',403);
      conn.handshaking=true;
      await db.setAgent(true);
      if (connection!==conn) return;
      send(conn.ws,{type:'HELLO',agentId});
      conn.ready=true;
      conn.seen=performance.now();
      return;
    }
    if (frame.type==='HEARTBEAT') {
      conn.seen=performance.now(); await db.setAgent(true); send(conn.ws,{type:'HEARTBEAT_ACK'}); return;
    }
    const job=transfers.get(frame.requestId);
    if (!job || job.conn!==conn || job.closed) return;
    if (frame.type==='META') {
      assert(!job.meta && frame.size===Number(job.doc.file_size) && frame.size>0 && frame.size<=maxPdf && frame.contentType==='application/pdf','INVALID_RELAY_FRAME',503);
      job.meta=true;
      clearTimeout(job.firstTimer);
      job.response.writeHead(200,{'Content-Type':'application/pdf','Content-Length':frame.size,'Accept-Ranges':'none',
        'Content-Disposition':(job.download?'attachment':'inline')+'; filename="pgs-test.pdf"'});
      send(conn.ws,{type:'ACK',requestId:job.id,sequence:-1});
    } else if (frame.type==='END') {
      assert(job.meta && !job.writing && job.bytes===Number(job.doc.file_size),'INVALID_RELAY_FRAME',503);
      terminate(job);
    } else if (frame.type==='ERROR') {
      const unavailable=frame.code==='LINK_UNAVAILABLE';
      terminate(job,new PhaseError(unavailable?'LINK_UNAVAILABLE':'AGENT_FILE_UNAVAILABLE',unavailable?410:503));
    } else throw new PhaseError('INVALID_RELAY_FRAME',503);
  }
  function onBinary(conn,data) {
    assert(data.length>headerBytes && data.length<=headerBytes+chunkMax,'INVALID_RELAY_FRAME',503);
    const id=data.toString('ascii',0,36);
    const job=transfers.get(id);
    if (!job || job.conn!==conn) return;
    const sequence=data.readUInt32BE(36);
    const count=data.length-headerBytes;
    assert(job.meta && !job.writing && sequence===job.sequence && job.bytes+count<=Number(job.doc.file_size),'INVALID_RELAY_FRAME',503);
    job.writing=true;
    job.bytes+=count;
    job.sequence++;
    job.response.write(data.subarray(headerBytes),error=>{
      if (!transfers.has(id)) return;
      job.writing=false;
      if (error) terminate(job,new PhaseError('CLIENT_CANCELLED',499));
      else send(conn.ws,{type:'ACK',requestId:id,sequence});
    });
  }
  server.on('upgrade',async (req,socket,head)=>{
    socket.on('error',()=>{});
    if (req.url!=='/api/v1/agent/connect' || !WebSocket.isWebSocket(req) ||
       req.headers['x-agent-id']!==agentId || !equal(req.headers.authorization,'Bearer '+keys.agent)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    try {
      assert((await db.agent())?.enabled,'AGENT_FORBIDDEN',403);
      if (connection) failConnection(connection);
      const ws=new WebSocket(req,socket,head,[],{maxLength:headerBytes+chunkMax});
      const conn={ws,ready:false,seen:performance.now()};
      connection=conn;
      ws.on('message',event=>{
        if (connection!==conn) return;
        try {
          if (typeof event.data==='string') onText(conn,event.data).catch(()=>failConnection(conn));
          else onBinary(conn,Buffer.from(event.data));
        } catch { failConnection(conn); }
      });
      ws.on('close',()=>failConnection(conn));
      ws.on('error',()=>failConnection(conn));
    } catch { socket.destroy(); }
  });
  const timer=setInterval(()=>{
    if (connection && performance.now()-connection.seen>=offline) failConnection(connection);
  },Math.min(offline,1000)).unref();
  server.on('close',()=>{clearInterval(timer); if (connection) failConnection(connection);});
  function stream(doc,response,download,accessUntil,sessionKey,purpose) {
    const conn=connection;
    assert(conn?.ready && performance.now()-conn.seen<offline && doc.agent_id===agentId,'AGENT_OFFLINE',503);
    assert(transfers.size<maxConcurrent,'AGENT_BUSY',503);
    const id=randomUUID();
    const now=clock();
    const remaining=epoch(doc.expires_at)-now;
    assert(remaining>0,'LINK_UNAVAILABLE',410);
    const limit=Math.min(total,remaining,accessUntil===undefined?total:accessUntil-now);
    assert(limit>0,'LINK_UNAVAILABLE',410);
    return new Promise((resolve,reject)=>{
      const job={id,conn,doc,response,download,sessionKey,resolve,reject,bytes:0,sequence:0,meta:false,writing:false};
      job.firstTimer=setTimeout(()=>terminate(job,new PhaseError('AGENT_TIMEOUT',504)),Math.min(first,limit));
      job.totalTimer=setTimeout(()=>terminate(job,new PhaseError('AGENT_TIMEOUT',504)),limit);
      job.cancel=()=>terminate(job,new PhaseError('CLIENT_CANCELLED',499));
      response.once('close',job.cancel);
      transfers.set(id,job);
      const frame={type:'FETCH',requestId:id,documentId:doc.document_id,agentId,deadline:now+limit,purpose};
      send(conn.ws,{...frame,proof:sign(keys.proof,frame)});
    });
  }
  return {stream,stats:()=>({online:Boolean(connection?.ready),inFlight:transfers.size}),
    cancelSession:key=>{for (const job of transfers.values()) if (job.sessionKey===key) terminate(job,new PhaseError('SESSION_REQUIRED',401));},
    cancelDocument:id=>{
      for (const job of transfers.values()) if (job.doc.document_id===id) terminate(job,new PhaseError('LINK_UNAVAILABLE',410));
    }};
}

export function connectAgent({url,ca,keys,storage,onReady=()=>{},clock=Date.now}) {
  const {Client}=requireLocal('faye-websocket');
  const heartbeat=integer('PGS_HEARTBEAT_MS',15000);
  const used=new Map(), requests=new Map();
  let ws,timer,reconnect,stopped=false,attempt=0,seen=null,connectedAt=null,disconnectedAt=null,errorAt=null,lastError=null,reconnections=0;
  const report=()=>({online:ws?.readyState===1 && seen!==null,lastSeenAt:seen===null?null:iso(seen),
    connectedAt,disconnectedAt,errorAt,lastError,reconnecting:Boolean(reconnect),reconnections});
  function schedule() {
    if (stopped || reconnect) return;
    const delay=Math.min(15000,250*2**Math.min(attempt++,6));
    reconnect=setTimeout(()=>{reconnect=null; connect();},delay+Math.random()*delay*.3);
  }
  function connect() {
    if (stopped) return;
    const host=new URL(url).hostname;
    assert(host==='127.0.0.1'||process.env.PGS_PHASE5B==='1','LOCAL_ONLY');
    ws=new Client(url,[],{tls:{ca,servername:host==='127.0.0.1'?'localhost':host,rejectUnauthorized:true,checkServerIdentity:(_name,cert)=>checkServerIdentity(host,cert)},headers:{'x-agent-id':agentId,Authorization:'Bearer '+keys.agent},maxLength:4096});
    const current=ws;
    function lost() {
      if (current!==ws) return;
      disconnectedAt=iso(clock());seen=null;clearInterval(timer);
      for (const request of requests.values()) request.controller.abort();
      schedule();
    }
    current.on('open',()=>send(current,{type:'HELLO',agentId}));
    current.on('error',()=>{lastError='RELAY_CONNECTION_ERROR';errorAt=iso(clock());current.close();});
    current.on('close',lost);
    current.on('message',event=>{
      let frame;
      try { frame=JSON.parse(event.data); } catch { current.close(); return; }
      if (frame.type==='HELLO' && frame.agentId===agentId) {
        if(connectedAt)reconnections++;
        connectedAt=iso(clock()); seen=clock(); attempt=0;
        clearInterval(timer);
        timer=setInterval(()=>{
          for (const [id,deadline] of used) if (deadline<=clock()) used.delete(id);
          send(current,{type:'HEARTBEAT',agentId});
          Promise.resolve(onReady()).catch(()=>{});
        },heartbeat);
        Promise.resolve(onReady()).catch(()=>{});
      } else if(frame.type==='HEARTBEAT_ACK'){
        seen=clock();
      } else if (frame.type==='ACK') {
        const flow=requests.get(frame.requestId);
        if (flow?.sequence===frame.sequence) flow.ack?.();
      } else if (frame.type==='CANCEL') requests.get(frame.requestId)?.controller.abort();
      else if (frame.type==='FETCH') transmit(current,frame).catch(()=>{});
    });
  }
  async function transmit(current,frame) {
    const id=frame.requestId;
    try {
      const now=clock();
      verifyFetch(keys.proof,frame,now,used);
      assert(requests.size<10,'AGENT_BUSY',503);
    } catch {
      if (!requests.has(id)) send(current,{type:'ERROR',requestId:id,code:'FETCH_FORBIDDEN'});
      return;
    }
    const controller=new AbortController();
    const flow={controller};
    requests.set(id,flow);
    const timer=setTimeout(()=>controller.abort(),Math.max(1,frame.deadline-clock()));
    let opened;
    function ack(sequence,write) {
      return new Promise((resolve,reject)=>{
        const fail=()=>reject(new PhaseError('CANCELLED'));
        if (controller.signal.aborted) return fail();
        controller.signal.addEventListener('abort',fail,{once:true});
        flow.sequence=sequence;
        flow.ack=()=>{
          flow.ack=null;
          controller.signal.removeEventListener('abort',fail);
          resolve();
        };
        if (current.readyState!==1) {
          controller.signal.removeEventListener('abort',fail);
          fail();
          return;
        }
        // A false send result signals a full transport buffer, and the frame is still queued.
        write();
      });
    }
    try {
      opened=await storage.handle(frame.documentId,controller);
      await ack(-1,()=>send(current,{type:'META',requestId:id,size:opened.item.size,contentType:'application/pdf'}));
      let cursor=0;
      let sequence=0;
      while (cursor<opened.item.size) {
        assert(clock()<Date.parse(opened.item.expires_at),'LINK_UNAVAILABLE',410);
        const size=Math.min(chunkMax,opened.item.size-cursor);
        const chunk=Buffer.allocUnsafe(headerBytes+size);
        chunk.write(id,0,36,'ascii'); chunk.writeUInt32BE(sequence,36);
        const {bytesRead}=await opened.file.read(chunk,headerBytes,size,cursor);
        assert(bytesRead>0,'FILE_UNAVAILABLE',503);
        await ack(sequence,()=>current.send(chunk.subarray(0,headerBytes+bytesRead)));
        cursor+=bytesRead; sequence++;
      }
      send(current,{type:'END',requestId:id});
    } catch(error) {
      if (!controller.signal.aborted) send(current,{type:'ERROR',requestId:id,code:error.message==='LINK_UNAVAILABLE'?'LINK_UNAVAILABLE':'FILE_UNAVAILABLE'});
    } finally {
      clearTimeout(timer);
      requests.delete(id);
      await opened?.finish();
    }
  }
  connect();
  return {report,stop:()=>{stopped=true; clearInterval(timer); clearTimeout(reconnect); ws?.close();}};
}
