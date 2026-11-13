// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the pinned upstream app/qualify.cjs. No filesystem stages run.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {Session, live, check, u32} = require('./session.cjs');
const {nativeHash} = require('./filesystem.cjs');
const {verifyWorkerCode, rawSvc, SENTINEL} = require('./worker.cjs');
const native = require('./native-worker.cjs');
const events = require('./events.cjs');
const affinity = require('./affinity.cjs');
const timing = require('./timing.cjs');
const {loadTarget, nativeOffset} = require('../../shared/target.cjs');
const target = loadTarget();

async function main() {
  const s = new Session('engine-' + Date.now(), 0x2400000);
  const proof = {schemaVersion:1, tool:'izcivswitch-engine-check', checkerVersion:'0.5.0',
    requestedFirmware:'20.4.0', firmwareEvidence:'user-reported; not detected by this check',
    session:live.session, started:new Date().toISOString(), verified:false,
    filesystemAcquisition:'NOT_ATTEMPTED', saveChanges:'NOT_ATTEMPTED',
    systemFilesystemSupport:'UNTESTED', stages:[], workers:[]};
  const workers = [];
  let gate = 0, gateInitialized = false;
  const stage = async (name, action) => {
    console.log(name);
    proof.stage = name;
    const row={name,started:new Date().toISOString()}; proof.stages.push(row);
    try {row.result=await action();row.verified=true;return row.result;}
    catch(e){row.error=e.message;throw e;}
    finally {row.completed=new Date().toISOString();}
  };
  try {
    check(target.name==='civ7' && target.thread.mode==='raw-svc','Civ7 raw-svc target is required');
    await stage('SDK allocator: 36 MiB', async()=>{
      await s.initialize();
      const end = await s.rpc.query(s.base+s.bytes-1);
      check(end.type===5 && end.permissions===3 && !end.attributes && !end.ipcReferences &&
        !end.deviceReferences && end.address<=s.base && end.address+end.size>=s.base+s.bytes,
        'Last SDK allocation page is not in the same ordinary owned span');
      const marker=crypto.randomBytes(32), at=s.base+s.bytes-32;
      await s.write(at,marker);
      check((await s.readOwned(at,32)).equals(marker),'SDK allocation last-page challenge failed');
      await s.write(at,Buffer.alloc(32));
      return {bytes:s.bytes,base:s.base,lastPageVerified:true};
    });
    await stage('Verify native worker and event instructions', async()=>{
      await verifyWorkerCode(s); await events.verify(s); return {verified:true};
    });
    proof.frequency=await stage('Measure native counter frequency (10 seconds)',()=>timing.verify(s));
    const allowed = await affinity.available(s), mask=allowed & -allowed;
    proof.scheduling={allowedMask:allowed.toString(),selectedMask:mask.toString(),...s.rawScheduling};
    const source=crypto.randomBytes(0x10002), base=s.base, lengthAt=base+0x4000;
    await stage('Bulk transfer and native SHA-256',async()=>{
      await s.write(base+0x5000,source);
      check((await s.read(base+0x5000,source.length)).equals(source),'Multipart transfer differs');
      const sha256=crypto.createHash('sha256').update(source).digest('hex');
      check(await nativeHash(s,base+0x5000,source.length)===sha256,'Native SHA-256 differs');
      return {bytes:source.length,sha256};
    });
    gate=base+0x3000; await events.initialize(s,gate); gateInitialized=true;
    async function launch(index,label) {
      const region=base+0x20000+index*0x60000;
      const copy=region+0x50000;
      await s.write(copy,Buffer.alloc(80,0xa5));
      const calls=[
        {function:live.sdk+events.code.wait.offset,args:[gate,0,0,0]},
        affinity.currentCoreCall(),
        {function:live.sdk+rawSvc.functions.readTpidrro.offset,args:[0,0,0,0]},
        {function:live.sdk+nativeOffset('memcpy',target),args:[copy,base+0x5000,{u32:lengthAt},0]},
      ];
      const w=await native.start(s,region,0x30000,base+0x2000+index*16,calls,label,0,
        {stack:region+0x30000,stackBytes:target.thread.stackBytes});
      workers.push(w); w.copy=copy;
      check((await s.readOwned(w.base+w.resultOffset,8)).readBigUInt64LE()===SENTINEL,
        'Worker passed its unsignaled gate');
      await affinity.pin(s,w,mask);
      return w;
    }
    async function validate(w,count) {
      const b=await s.readOwned(w.copy,80);
      check((1n<<w.results[1])===mask && w.results[2]>0n && w.results[2]<1n<<39n &&
        w.results[2]%8n===0n && w.results[3]===BigInt(w.copy) &&
        b.subarray(0,count).equals(source.subarray(0,count)) && b.subarray(count).every(x=>x===0xa5),
        'Worker core, TLS pointer, dynamic argument or bounded copy differs');
      const row={handle:w.thread,core:Number(w.results[1]),tpidrro:'0x'+w.results[2].toString(16),
        copiedBytes:count,joined:w.joined};
      proof.workers.push(row); return row;
    }
    await stage('One gated worker with a dynamic argument',async()=>{
      await s.write(lengthAt,u32(64));
      const w=await launch(0,s.label+'-single');
      await s.write(lengthAt,u32(48));
      await events.signal(s,gate); await native.join(s,w);
      return validate(w,48);
    });
    await stage('13 gated workers with a shared dynamic argument',async()=>{
      await events.clear(s,gate);
      await s.write(lengthAt,u32(64));
      const group=[];
      for(let i=0;i<13;i++) group.push(await launch(i,s.label+'-group-'+i));
      // The length changes after every worker has started and parked.
      await s.write(lengthAt,u32(32));
      await events.signal(s,gate);
      for(const w of group) {await native.join(s,w);await validate(w,32);}
      return {workerCount:group.length,copiedBytesPerWorker:32,allJoined:true};
    });
    proof.verified=true;
  } catch(e) {proof.error=e.stack;}
  finally {
    const cleanupErrors=[];
    try {
      if(await s.ready()) {
        if(gateInitialized && s.threads.size) {
          try {await events.signal(s,gate);} catch(e) {cleanupErrors.push(e.message);}
          for(const w of workers) if(!w.joined && s.threads.has(w.thread)) {
            try {await native.join(s,w);} catch(e) {cleanupErrors.push(e.message);}
          }
        }
        if(gateInitialized && !s.threads.size) {
          try {await events.finalize(s,gate);} catch(e) {cleanupErrors.push(e.message);}
        }
        try {await s.cleanup();} catch(e) {cleanupErrors.push(e.message);}
      }
    } catch(e) {cleanupErrors.push(e.message);}
    proof.cleanup={cleanedUp:!s.base && !s.handles.size && !s.threads.size && !s.allocationUncertain && !cleanupErrors.length,
      retainedBase:s.base,allocationUncertain:!!s.allocationUncertain,
      retainedHandles:[...s.handles],retainedThreads:[...s.threads],errors:cleanupErrors};
    proof.requiresRestart=!proof.cleanup.cleanedUp;
    proof.verified=proof.verified && proof.cleanup.cleanedUp;
    proof.completed=new Date().toISOString();
    await fs.writeFile(path.join(__dirname,'qualification.json'),JSON.stringify(proof,null,2)+'\n');
    console.log(JSON.stringify(proof));
  }
  if(!proof.verified)process.exitCode=2;
  return proof;
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={main};
