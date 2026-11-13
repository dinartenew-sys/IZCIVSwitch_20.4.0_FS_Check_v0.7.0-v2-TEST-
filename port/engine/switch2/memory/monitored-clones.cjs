// SPDX-License-Identifier: GPL-2.0-only
// Only CMIF clone and pointer-buffer controls run here, before FS scratch writes.
// A pending worker retains both its own memory and the source session's resources.
function createMonitor(owner,{save=async()=>{},dependencies,timeoutMs=2500}={}) {
  const d=dependencies||{
    ...require('../app/session.cjs'),native:require('../app/native-worker.cjs'),
    events:require('../app/events.cjs'),domain:require('../app/domain.cjs'),
    functions:require('../../shared/sdk-functions.json'),
    verifyWorkerCode:require('../app/worker.cjs').verifyWorkerCode,
  };
  const q=new d.Session(owner.label+'-clone-monitor',0x100000);
  const state={requests:[],pending:null,initialized:false,cleanedUp:false,peakOwnedFsHandles:owner.handles.size};
  let gateInitialized=false,closed=false,active=false,sequence=0;
  const token=q.label+':pending-IPC';
  const refresh=()=>{state.retained={base:q.base,bytes:q.bytes,handles:[...q.handles],
    threads:[...q.threads],allocationUncertain:!!q.allocationUncertain};
    state.peakOwnedFsHandles=Math.max(state.peakOwnedFsHandles,owner.handles.size);};
  const record=async()=>{refresh();await save();};
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  async function initialize(){
    check(!state.initialized&&!closed,'Clone monitor already initialized or closed');
    await q.initialize();await d.verifyWorkerCode(q);await d.events.verify(q);
    await d.events.initialize(q,q.base+0x3000);gateInitialized=true;
    state.initialized=true;await record();
  }
  async function request(source,command,label){
    check(state.initialized&&!closed&&!active&&!q.threads.size,'Clone monitor is unavailable or busy');
    check(command===2||command===3,'Clone monitor only accepts control 2 or 3');
    check(owner.handles.has(source),'Clone source is not owned');
    active=true;
    const index=++sequence,gate=q.base+0x3000,buffer=q.base+0x80000;
    state.pending={index,label,source,command,ownedFsHandles:owner.handles.size,at:new Date().toISOString()};
    try{
      await record();console.log(label+' (owned FS sessions: '+owner.handles.size+')');
      await d.events.clear(q,gate);
      const packet=Buffer.alloc(4096);d.domain.wire.control(command).copy(packet);
      await q.write(buffer,packet);
      // Set this before launch: an uncertain thread creation must retain its source too.
      owner.threads.add(token);
      const worker=await d.native.start(q,q.base+0x20000,0x30000,q.base+0x2000,[
        {function:d.live.sdk+d.events.code.wait.offset,args:[gate,0,0,0]},
        {function:d.live.sdk+d.functions.send.offset,args:[buffer,4096,source,0]},
      ],q.label+'-'+index,0,{stack:q.base+0x61000,stackBytes:0x14000});
      state.pending.thread=worker.thread;await record();
      await d.events.signal(q,gate);
      await d.native.join(q,worker,timeoutMs);
      // join verifies kernel termination before inspecting results or the reply page.
      check(worker.joined&&!q.threads.size,'Clone worker termination did not verify');
      check(worker.results[1]===0n,'Clone control transport returned '+worker.results[1]);
      const bytes=await q.readOwned(buffer,256),reply=d.domain.wire.response(bytes);
      for(const handle of [...reply.moves,...reply.copies]){
        check(Number.isInteger(handle)&&handle>0&&handle<0xffff8000&&!owner.handles.has(handle),
          'Invalid or duplicate returned session handle');
        owner.handles.add(handle);
      }
      state.requests.push({index,label,source,command,result:reply.result,
        moves:reply.moves,copies:reply.copies,ownedFsHandles:owner.handles.size,joined:true});
      state.pending=null;await record();
      check(!reply.result,label+' returned an error');return reply;
    }catch(error){
      state.error=error.stack;await record();throw error;
    }finally{
      if(!q.threads.size)owner.threads.delete(token);
      active=false;refresh();
    }
  }
  async function close(){
    if(closed)return;
    if(q.threads.size){
      state.cleanedUp=false;state.requiresRestart=true;await record();return;
    }
    owner.threads.delete(token);
    if(gateInitialized){await d.events.finalize(q,q.base+0x3000);gateInitialized=false;}
    await q.cleanup();
    state.cleanedUp=!q.base&&!q.handles.size&&!q.threads.size&&!q.allocationUncertain;
    state.requiresRestart=!state.cleanedUp;state.scheduling=q.rawScheduling;
    closed=state.cleanedUp;await record();
  }
  return {state,initialize,request,close};
}
module.exports={createMonitor};
