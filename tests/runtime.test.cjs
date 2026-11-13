const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {validatePackage}=require('../validate-package.cjs');
const {createClients}=require('../port/engine/switch2/memory/compact-clients.cjs');

test('staged FS entrypoints and monitor dependencies load without opening a connection',async()=>{
  assert.deepEqual(await validatePackage(path.join(__dirname,'..')),{verified:true});
});
test('staged validation rejects a missing mount-session helper before console access',async t=>{
  const parent=path.resolve(os.tmpdir()),temp=await fs.mkdtemp(path.join(parent,'izciv-runtime-test-'));
  t.after(async()=>{const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),parent);
    assert.ok(path.basename(resolved).startsWith('izciv-runtime-test-'));
    await fs.rm(resolved,{recursive:true,force:true});});
  await fs.cp(path.join(__dirname,'../port'),path.join(temp,'port'),{recursive:true});
  await fs.unlink(path.join(temp,'port/engine/switch2/memory/session.cjs'));
  await assert.rejects(validatePackage(temp),/Runtime package dependency check failed/);
});

async function runProbeSetup(mode,env={}){
  let snapshot,normalCalls=0,cleanups=0,monitorCloses=0,runControlOptions;
  let nextHandle=10,handlesAtScratch;
  const s={base:0x30000000,bytes:0x2400000,label:'integration',handles:new Set(),threads:new Set(),metrics:{},
    openService:async()=>{s.handles.add(2);return 2;},
    ipc:async label=>label==='Initialize gap root'?{result:0}:{result:0,moves:[3]},
    close:async h=>s.handles.delete(h),closeUpload:async()=>{},ready:async()=>true,
    cleanup:async()=>{cleanups++;if(!s.threads.size){s.handles.clear();s.base=0;}},
    verifyCode:async()=>{},record:async()=>{}};
  class RunControl{constructor(options){runControlOptions=options;this.state={};}async start(){this.started=true;}
    async checkpoint(){}retire(){}async close(){}}
  class StopRequested extends Error{}
  const monitor={state:{pending:null,cleanedUp:false},initialize:async()=>{},
    request:async(source,command,label)=>{
      if(command===3)return {data:Buffer.from([0,8])};
      if(mode==='pending'){
        s.threads.add('clone-monitor:pending-IPC');monitor.state.pending={source,label};
        throw Error('Native batch did not terminate; resources retained');
      }
      return {result:0,moves:[nextHandle++]};
    },close:async()=>{monitorCloses++;if(mode!=='pending')monitor.state.cleanedUp=true;}};
  const domain={oneHandle:reply=>{s.handles.add(reply.moves[0]);return reply.moves[0];},
    storageSize:async()=>65536n};
  const modules={
    'node:fs/promises':{copyFile:async()=>{}},'node:path':path,'node:crypto':require('node:crypto'),
    'node:perf_hooks':require('node:perf_hooks'),
    './session.cjs':{connect:async()=>({s,live:{sdk:0x10000000,session:'boot'},directory:'/app'}),
      check:(ok,msg)=>{if(!ok)throw Error(msg);},u64:()=>Buffer.alloc(8)},
    './run-control.cjs':{RunControl,StopRequested,diagnosticStopPoint:require('../port/engine/switch2/memory/run-control.cjs').diagnosticStopPoint,reportWriter:(file,get)=>async()=>{snapshot=structuredClone(get());}},
    './session-tools.cjs':{packPages:()=>{}},'./paths.cjs':{paths:()=>({normal:async(handle,command)=>{
      normalCalls++;
      if(command===11){const data=Buffer.alloc(8);data.writeBigUInt64LE(0x4000000n);return {result:0,data};}
      if(command===7)return {canonicalResult:0x202};
      if(command===2){handlesAtScratch=[...s.handles];throw Error('SCRATCH_TEST_BOUNDARY');}
      throw Error('Unexpected path operation');
    },raw:async()=>{}})},
    './normalized-path.cjs':p=>p,'./wave-overlap.cjs':{},
    './wave-history.cjs':{failureSummary:()=>({message:'clone pending'})},'../../shared/ipc.cjs':{},
    '../../shared/sdk-functions.json':{},'../../shared/target.cjs':{
      loadTarget:()=>({thread:{mode:'raw-svc'}}),nativeEntry:()=>({offset:0,bytes:'00'})},
    './cache-address-plan.cjs':{},'./mounted-rom.cjs':{cloneMountedRom:async()=>{s.handles.add(4);return {handle:4};}},
    './monitored-clones.cjs':{createMonitor:()=>monitor},'./compact-clients.cjs':{createClients},'./wave-roles.cjs':require('../port/engine/switch2/memory/wave-roles.cjs'),
    '/app/domain.cjs':domain,'/app/mounted-save.cjs':{cloneMountedFilesystem:async()=>{s.handles.add(1);return 1;}},
    '/app/events.cjs':{verify:async()=>{}},'/app/timing.cjs':{verify:async()=>31250000},
    '/app/affinity.cjs':{available:async()=>4n,pinAll:async()=>{}},
    '/app/native-worker.cjs':{restartAll:async()=>{},joinAll:async()=>{}},'/app/bulk-transfer.cjs':{},
    '/app/worker.cjs':{verifyWorkerCode:async()=>{},code:{},rawSvc:{},directNnOs:{}},
  };
  const context={module:{exports:{}},require:name=>{
    const key=name.replaceAll('\\','/');if(!(key in modules))throw Error('Unexpected module '+name);return modules[key];
  },__dirname:'/memory',__filename:'/memory/probe.cjs',Buffer,console:{log:()=>{},error:()=>{}},
    process:{env:{...env},exitCode:0},setTimeout,clearTimeout};
  vm.runInNewContext(syncFs.readFileSync(path.join(__dirname,'../port/engine/switch2/memory/probe-reserved-gap.cjs'),'utf8'),context);
  await context.module.exports.main();
  return {snapshot,normalCalls,cleanups,monitorCloses,handlesAtScratch,runControlOptions};
}
test('the actual acquisition stops a blocked clone before any scratch path operation',async()=>{
  const {snapshot,normalCalls,cleanups,monitorCloses}=await runProbeSetup('pending');
  assert.equal(normalCalls,0);assert.equal(cleanups,0);assert.equal(monitorCloses,1);
  assert.equal(snapshot.scratchWritesStarted,false);assert.equal(snapshot.cleanedUp,false);
  assert.equal(snapshot.retained.base,0x30000000);assert.equal(snapshot.retained.handles.length,3);
  assert.ok(snapshot.workerCaptureSkipped);assert.ok(snapshot.error.includes('did not terminate'));
});
test('the actual acquisition reaches its first scratch write only after all ten sessions qualify',async()=>{
  const {snapshot,handlesAtScratch,cleanups}=await runProbeSetup('success');
  assert.equal(handlesAtScratch.length,10);assert.equal(new Set(handlesAtScratch).size,10);
  assert.equal(handlesAtScratch.includes(4),false);
  assert.equal(snapshot.cloneTopology.clones.length,7);assert.equal(snapshot.cloneMonitor.cleanedUp,true);
  assert.ok(snapshot.error.includes('SCRATCH_TEST_BOUNDARY'));assert.equal(snapshot.cleanedUp,true);
  assert.equal(cleanups,1);
});
test('the probe passes the stop switch to its run control, and only when it is set',async()=>{
  const off=await runProbeSetup('success');
  assert.equal(off.runControlOptions.stopAt,null);
  const on=await runProbeSetup('success',{NS2_DIAG_STOP_AT_SCRATCH:'1'});
  assert.equal(on.runControlOptions.stopAt,'before scratch writes');
});
