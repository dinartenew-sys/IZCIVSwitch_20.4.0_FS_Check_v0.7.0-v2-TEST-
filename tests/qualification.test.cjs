const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const SENTINEL=0xfedcba9876543210n;
const source=fs.readFileSync(path.join(__dirname,'../port/engine/switch2/app/qualify-20.4.0.cjs'),'utf8');
async function simulate(mode='pass') {
  const memory=Buffer.alloc(0x2400000),base=0x30000000,sdk=0x10000000;
  const facts={started:0,joined:0,pins:0,freed:false,finalized:false,signaled:false,copies:[]};
  let session;
  class Session {
    constructor(label,bytes){session=this;Object.assign(this,{label,bytes,base:0,threads:new Set(),handles:new Set(),rpc:{query:async()=>({type:5,permissions:3,attributes:0,ipcReferences:0,deviceReferences:0,address:base,size:memory.length})}});}
    async initialize(){if(mode==='unknown-allocation'){this.allocationUncertain=true;throw Error('Allocation response lost');}this.base=base;this.rawScheduling={priority:43,cores:[2],borrowedCores:[2]};}
    async write(a,b){assert.ok(a>=base&&a+b.length<=base+memory.length);b.copy(memory,a-base);}
    async read(a,n){assert.ok(a>=base&&a+n<=base+memory.length);return Buffer.from(memory.subarray(a-base,a-base+n));}
    async readOwned(a,n){return this.read(a,n);}
    async ready(){return true;}
    async cleanup(){if(!this.threads.size){if(mode==='free-fails')throw Error('free failed');this.base=0;facts.freed=true;}}
  }
  const events={code:{wait:{offset:4}},verify:async()=>{},initialize:async()=>{facts.signaled=false;},
    clear:async()=>{facts.signaled=false;},signal:async()=>{facts.signaled=true;},
    finalize:async()=>{assert.equal(session.threads.size,0);facts.finalized=true;}};
  const native={
    start:async(s,region,limit,slot,calls,label,snapshot,threadMemory)=>{
      assert.ok(threadMemory.stack>=region+limit&&threadMemory.stack+threadMemory.stackBytes<=region+0x50000);
      facts.started++;
      if(mode==='partial-launch'&&facts.started===4){s.threads.add('creating-unknown');throw Error('uncertain launch');}
      assert.equal(facts.signaled,false);assert.equal(calls[3].args[2].u32,base+0x4000);
      const w={base:region,resultOffset:0x800,thread:100+facts.started,joined:false,calls};
      memory.writeBigUInt64LE(SENTINEL,region-base+0x800);s.threads.add(w.thread);return w;
    },
    join:async(s,w)=>{
      assert.equal(facts.signaled,true);assert.ok(s.threads.has(w.thread));
      const copy=w.calls[3].args[0],n=memory.readUInt32LE(0x4000);
      memory.copy(memory,copy-base,0x5000,0x5000+n);
      if(mode==='bad-copy'&&facts.joined===0)memory[copy-base]=memory[copy-base]^1;
      w.results=[0n,2n,BigInt(0x500000+w.thread*0x1000),BigInt(copy)];
      w.joined=true;s.threads.delete(w.thread);facts.joined++;facts.copies.push(n);
    }
  };
  const mocks={
    'node:fs/promises':{writeFile:async()=>{}},'node:path':path,'node:crypto':crypto,
    './session.cjs':{Session,live:{sdk,session:'test'},check:(x,m)=>{if(!x)throw Error(m);},u32:n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;}},
    './filesystem.cjs':{nativeHash:async(s,a,n)=>crypto.createHash('sha256').update(await s.read(a,n)).digest('hex')},
    './worker.cjs':{verifyWorkerCode:async()=>{},rawSvc:{functions:{readTpidrro:{offset:8}}},SENTINEL},
    './native-worker.cjs':native,'./events.cjs':events,
    './affinity.cjs':{available:async()=>4n,currentCoreCall:()=>({function:sdk+12,args:[0,0,0,0]}),pin:async(s,w,m)=>{assert.equal(m,4n);facts.pins++;}},
    './timing.cjs':{verify:async()=>31250000},
    '../../shared/target.cjs':{loadTarget:()=>({name:'civ7',thread:{mode:'raw-svc',stackBytes:0x14000}}),nativeOffset:()=>16}
  };
  const context={module:{exports:{}},require:n=>{if(!(n in mocks))throw Error('Unexpected module '+n);return mocks[n];},
    __dirname:'.',Buffer,console:{log:()=>{}},process:{exitCode:0}};
  vm.runInNewContext(source,context);
  const proof=await context.module.exports.main();return {proof,facts,session};
}
test('one worker and 13 workers use changed arguments and free only after joins',async()=>{
  const {proof,facts}=await simulate();
  assert.equal(proof.verified,true);assert.equal(proof.cleanup.cleanedUp,true);
  assert.equal(facts.started,14);assert.equal(facts.joined,14);assert.equal(facts.pins,14);
  assert.equal(facts.freed,true);assert.equal(facts.finalized,true);
  assert.deepEqual(facts.copies,[48,...Array(13).fill(32)]);
});
test('uncertain partial launch releases known workers and retains shared allocation',async()=>{
  const {proof,facts}=await simulate('partial-launch');
  assert.equal(proof.verified,false);assert.equal(proof.requiresRestart,true);
  assert.equal(facts.joined,3);assert.equal(facts.freed,false);assert.equal(facts.finalized,false);
  assert.ok(proof.cleanup.retainedThreads.includes('creating-unknown'));
});
test('copy mismatch is a failed check even when cleanup succeeds',async()=>{
  const {proof,facts}=await simulate('bad-copy');
  assert.equal(proof.verified,false);assert.equal(proof.cleanup.cleanedUp,true);
  assert.equal(facts.started,1);assert.equal(facts.freed,true);
});
test('allocator cleanup failure cannot report a passing check',async()=>{
  const {proof}=await simulate('free-fails');
  assert.equal(proof.verified,false);assert.equal(proof.requiresRestart,true);
  assert.ok(proof.cleanup.errors.includes('free failed'));assert.ok(proof.cleanup.retainedBase);
});
test('a lost allocation response cannot claim cleanup even without a returned pointer',async()=>{
  const {proof}=await simulate('unknown-allocation');
  assert.equal(proof.cleanup.cleanedUp,false);assert.equal(proof.cleanup.allocationUncertain,true);
  assert.equal(proof.requiresRestart,true);assert.equal(proof.verified,false);
});
