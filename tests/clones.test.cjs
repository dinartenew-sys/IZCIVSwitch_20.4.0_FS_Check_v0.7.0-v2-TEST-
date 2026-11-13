const test=require('node:test');
const assert=require('node:assert/strict');
const {createMonitor}=require('../port/engine/switch2/memory/monitored-clones.cjs');
const {createClients}=require('../port/engine/switch2/memory/compact-clients.cjs');

function fixture(mode='success'){
  let worker,reads=0,lastCommand=0,nextHandle=20;const trace=[];
  const owner={label:'test',handles:new Set([1,2,3]),threads:new Set()};
  class Session{
    constructor(label,bytes){this.label=label;this.bytes=bytes;this.base=0;
      this.handles=new Set();this.threads=new Set();}
    async initialize(){this.base=0x30000000;}
    async write(address,packet){lastCommand=packet[0];}
    async readOwned(){assert.equal(worker.joined,true);reads++;trace.push('read');return Buffer.alloc(256);}
    async cleanup(){trace.push('cleanup');if(!this.threads.size)this.base=0;}
  }
  const dependencies={Session,live:{sdk:0x10000000},verifyWorkerCode:async()=>{},
    functions:{send:{offset:0x123}},
    events:{code:{wait:{offset:0x111}},verify:async()=>{},initialize:async()=>{},clear:async()=>{},
      signal:async()=>trace.push('signal'),finalize:async()=>trace.push('finalize')},
    domain:{wire:{control:n=>Buffer.from([n]),response:()=>({result:mode==='reply-error'?5:0,
      moves:lastCommand===2?[nextHandle++]:[],copies:[],data:Buffer.from([0,8])})}},
    native:{start:async(s,base,limit,slot,calls,label,snapshot,memory)=>{
      assert.equal(owner.threads.size,1);assert.equal(calls[1].args[2],1);
      assert.equal(calls[1].args[0],s.base+0x80000);assert.equal(memory.stackBytes,0x14000);
      if(mode==='refused-start')throw Error('Launch refused before thread creation');
      if(mode==='uncertain-start'){s.threads.add('creating');throw Error('Creation result unavailable');}
      worker={thread:31,joined:false,results:[0n,mode==='transport-error'?7n:0n]};
      s.threads.add(worker.thread);trace.push('start');return worker;
    },join:async(s,w,timeout)=>{
      assert.equal(timeout,2500);trace.push('join');
      if(mode==='timeout')throw Error('Native batch did not terminate; resources retained');
      w.joined=true;s.threads.delete(w.thread);
    }},
  };
  const monitor=createMonitor(owner,{dependencies});
  return {monitor,owner,trace,reads:()=>reads};
}
test('completed clone and pointer query transfer only returned FS handles to the owner',async()=>{
  const f=fixture();await f.monitor.initialize();
  const reply=await f.monitor.request(1,2,'clone');assert.deepEqual(reply.moves,[20]);
  assert.deepEqual([...f.owner.handles],[1,2,3,20]);assert.equal(f.owner.threads.size,0);
  assert.equal((await f.monitor.request(1,3,'query')).data.readUInt16LE(),2048);
  await f.monitor.close();assert.equal(f.monitor.state.cleanedUp,true);
  assert.equal(f.monitor.state.pending,null);assert.equal(f.monitor.state.requests.length,2);
  assert.deepEqual(f.monitor.state.retained.handles,[]);
  assert.ok(f.trace.indexOf('join')<f.trace.indexOf('read'));
  assert.ok(f.trace.indexOf('finalize')<f.trace.indexOf('cleanup'));
});
test('pending clone retains both allocations and source resources without reading IPC replies',async()=>{
  const f=fixture('timeout');await f.monitor.initialize();
  await assert.rejects(f.monitor.request(1,2,'clone'),/did not terminate/);
  await f.monitor.close();assert.equal(f.reads(),0);assert.equal(f.owner.threads.size,1);
  assert.equal(f.monitor.state.cleanedUp,false);assert.equal(f.monitor.state.requiresRestart,true);
  assert.equal(f.monitor.state.retained.base,0x30000000);
  assert.deepEqual(f.monitor.state.retained.threads,[31]);assert.deepEqual([...f.owner.handles],[1,2,3]);
  assert.ok(!f.trace.includes('finalize')&&!f.trace.includes('cleanup'));
  await assert.rejects(f.monitor.request(1,2,'again'),/busy/);
});
test('uncertain thread launch retains its source and worker allocation',async()=>{
  const f=fixture('uncertain-start');await f.monitor.initialize();
  await assert.rejects(f.monitor.request(1,2,'clone'),/unavailable/);await f.monitor.close();
  assert.equal(f.owner.threads.size,1);assert.deepEqual(f.monitor.state.retained.threads,['creating']);
  assert.equal(f.monitor.state.cleanedUp,false);assert.equal(f.reads(),0);
});
test('a refused launch with no thread permits cleanup',async()=>{
  const f=fixture('refused-start');await f.monitor.initialize();
  await assert.rejects(f.monitor.request(1,2,'clone'),/Launch refused/);await f.monitor.close();
  assert.equal(f.owner.threads.size,0);assert.equal(f.monitor.state.cleanedUp,true);
});
test('a joined transport failure does not inspect the IPC reply',async()=>{
  const f=fixture('transport-error');await f.monitor.initialize();
  await assert.rejects(f.monitor.request(1,2,'clone'),/transport/);await f.monitor.close();
  assert.equal(f.reads(),0);assert.equal(f.owner.threads.size,0);assert.equal(f.monitor.state.cleanedUp,true);
});
test('returned owned handles remain tracked even when the IPC result reports an error',async()=>{
  const f=fixture('reply-error');await f.monitor.initialize();
  await assert.rejects(f.monitor.request(1,2,'clone'),/returned an error/);await f.monitor.close();
  assert.equal(f.owner.handles.has(20),true);assert.equal(f.monitor.state.cleanedUp,true);
});
test('unowned sources and non-control requests are rejected before launching a worker',async()=>{
  const f=fixture();await f.monitor.initialize();
  await assert.rejects(f.monitor.request(9,2,'clone'),/not owned/);
  await assert.rejects(f.monitor.request(1,5,'request'),/only accepts/);
  assert.ok(!f.trace.includes('start'));await f.monitor.close();
});
test('compact FS setup supplies separate sessions to every concurrent native role',async()=>{
  let next=10;const calls=[];
  const r=await createClients({saved:1,root:2,storage:3,base:0x40000000,
    clone:async(source,label)=>{calls.push({source,label});return next++;}});
  assert.equal(calls.length,7);assert.deepEqual(calls.map(c=>c.source),[2,2,2,2,1,1,1]);
  assert.equal(r.clients[0],1);assert.equal(r.clients[1],3);assert.equal(r.clients.length,10);
  assert.deepEqual(r.clients[7],{u32:0x40002a00});assert.deepEqual(r.clients[9],{u32:0x40002a04});
  const concurrent=[...r.clients.filter(Number.isInteger),r.savedTrigger];
  assert.equal(new Set(concurrent).size,9);assert.equal(concurrent.includes(2),false);
  assert.equal(r.tmpTrigger,r.savedTrigger);assert.equal(r.report.requiredSetupSessions,10);
});
test('compact setup rejects an alias between concurrent sessions',async()=>{
  await assert.rejects(createClients({saved:1,root:2,storage:3,base:0x40000000,clone:async()=>1}),/distinct/);
});
test('diagnostic trigger source can come from the root without adding a session',async()=>{
  let next=20;const calls=[];
  const r=await createClients({saved:1,root:2,storage:3,base:0x40000000,triggerFrom:'root',
    clone:async(source,label)=>{calls.push({source,label});return next++;}});
  assert.equal(calls.length,7);assert.deepEqual(calls.map(c=>c.source),[2,2,2,2,1,1,1].slice(0,6).concat([2]));
  assert.equal(r.report.triggerSource,'root');assert.equal(r.report.clones.length,7);
  assert.equal(new Set([1,2,3,...r.report.clones.map(c=>c.handle)]).size,10);
  await assert.rejects(createClients({saved:1,root:2,storage:3,base:0x40000000,triggerFrom:'other',clone:async()=>1}),/Unsupported/);
});
