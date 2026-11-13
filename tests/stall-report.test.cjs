const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const path=require('node:path');

// Offline load: session.cjs reads the staged connection.json and worker.cjs/filesystem.cjs
// read materialized JSON, so those three modules are replaced in the test's module cache.
// The join logic under test is the real native-worker.cjs code.
const appDir=path.resolve(__dirname,'../port/engine/switch2/app');
const SENTINEL=0xfffffffffffffffen;
function stub(file,exports){
  const m=new Module(file);
  m.filename=file;
  m.loaded=true;
  m.exports=exports;
  require.cache[file]=m;
}
stub(path.join(appDir,'session.cjs'),{live:{sdk:0x1000000},check:(ok,message)=>{if(!ok) throw Error(message);}});
stub(path.join(appDir,'filesystem.cjs'),{nativeHash:async()=>''});
stub(path.join(appDir,'worker.cjs'),{SENTINEL,rawSvc:{waitTimeoutResult:0x6401},
  code:{tryWait:{offset:0x10}},directNnOs:{},managerListRecovery:{}});

const {join,joinAll,stallReport}=require('../port/engine/switch2/app/native-worker.cjs');
const {failureSummary}=require('../port/engine/switch2/memory/wave-history.cjs');

// Four result slots for three logical calls; logical call 2 uses slot 3 because call 1
// expanded into an extra native argument load in slot 2.
function fakeSession(slots){
  const buffer=Buffer.alloc(slots.length*8);
  slots.forEach((value,i)=>buffer.writeBigUInt64LE(value,i*8));
  return {
    threads:new Set([77,78]),
    base:0x1000,
    write:async()=>{},
    readOwned:async(address,bytes)=>buffer.subarray(0,bytes),
    rpc:{call3:async()=>0,call4:async()=>rawSvc.waitTimeoutResult},
  };
}

function workerFor(label,thread,slots){
  return {label,base:0x1000,thread,slot:0x2000,resultOffsets:slots.map((_,i)=>i*8),
    logicalResultIndices:[0,1,3],calls:[{name:'start'},{name:'send'},{name:'end'}]};
}

test('a stalled worker reports the first logical call whose result is still pending',async()=>{
  // Logical call 2 writes slot 3. Slot 2 holds call 1's extra argument load, so an
  // unmapped lookup would read slot 2 and miss the stall.
  const slots=[1n,5n,7n,SENTINEL];
  const s=fakeSession(slots);
  const worker=workerFor('probe-3',77,slots);
  await assert.rejects(join(s,worker,20),error=>{
    assert.equal(error.message,'Native batch did not terminate; resources retained');
    assert.equal(error.workerFailure.observed,'not-terminated');
    assert.equal(error.workerFailure.label,'probe-3');
    assert.equal(error.workerFailure.steps,3);
    assert.equal(error.workerFailure.completedSteps,2);
    assert.deepEqual(error.workerFailure.stuckStep,{index:2,name:'end'});
    return true;
  });
  assert.equal(worker.joined,undefined);
});

test('a worker whose results are all stored has no stuck step',async()=>{
  const slots=[1n,2n,5n,7n];
  const report=await stallReport(fakeSession(slots),workerFor('probe-9',77,slots),20);
  assert.equal(report.completedSteps,3);
  assert.equal(report.stuckStep,null);
});

test('joinAll names every worker still unjoined when a join fails',async()=>{
  const slots=[1n,SENTINEL,5n,SENTINEL];
  const s=fakeSession(slots);
  const first=workerFor('probe-3',77,slots), second=workerFor('probe-4',78,slots);
  const error=await joinAll(s,[first,second],20).then(()=>null,e=>e);
  assert.ok(error&&error.workerFailure,'joinAll did not report the failure');
  assert.deepEqual(error.workerFailure.unjoined,['probe-3','probe-4']);
});

test('the failure summary names the stuck step and the unjoined workers',()=>{
  const error={message:'Native batch did not terminate; resources retained',workerFailure:{
    observed:'not-terminated',label:'probe-3',timeoutMs:2500,steps:3,completedSteps:1,
    stuckStep:{index:1,name:'send'},unjoined:['probe-3','probe-4']}};
  const summary=failureSummary({active:{profile:'extent-present'},retained:{threads:[]}},error);
  assert.equal(summary.kind,'native-worker-timeout');
  assert.match(summary.message,/stuck at step 1 \(send\) after 1 of 3 steps/);
  assert.match(summary.message,/unjoined workers: probe-3, probe-4/);
  assert.doesNotMatch(summary.message,/executing step unknown/);
});

test('the failure summary still says the step is unknown when no stall detail was read',()=>{
  const error={message:'Native batch did not terminate; resources retained',workerFailure:{
    observed:'not-terminated',label:'probe-3',timeoutMs:2500,steps:3,completedSteps:null,stuckStep:null}};
  const summary=failureSummary({active:{profile:'extent-present'},retained:{threads:[]}},error);
  assert.match(summary.message,/executing step unknown/);
});
