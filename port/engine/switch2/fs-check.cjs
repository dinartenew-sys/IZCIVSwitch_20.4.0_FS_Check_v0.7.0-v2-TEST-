// SPDX-License-Identifier: GPL-2.0-only
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {Session,live}=require('./app/session.cjs');
const filesystem=require('./app/filesystem.cjs');
const mounted=require('./app/mounted-save.cjs');
const {backupSave}=require('./backup-save.cjs');
const {verifyProof}=require('./memory/verify-proof.cjs');
const check=(ok,message)=>{if(!ok)throw Error(message);};

function runScript(filename,{timeoutMs=120000,stopFile,env={}}={}) {
  const child=spawn(process.execPath,[filename],{cwd:__dirname,env:{...process.env,...env},
    windowsHide:true,stdio:['ignore','pipe','pipe']});
  let deadlineExceeded=false,killTimer;
  const timer=setTimeout(async()=>{
    deadlineExceeded=true;
    if(stopFile){
      try{await fs.writeFile(stopFile,'Stop at the next checkpoint and restore owned state.\n');}
      catch(e){console.error(e.message);}
      killTimer=setTimeout(()=>child.kill(),120000);
    } else child.kill();
  },timeoutMs);
  child.stdout.on('data',b=>process.stdout.write(b));
  child.stderr.on('data',b=>process.stderr.write(b));
  return new Promise((resolve,reject)=>{
    child.once('error',e=>{clearTimeout(timer);clearTimeout(killTimer);reject(e);});
    child.once('close',(code,signal)=>{
      clearTimeout(timer);clearTimeout(killTimer);resolve({code,signal,deadlineExceeded});
    });
  });
}
function acceptable(report,proof,sessionId) {
  return report.session===sessionId&&report.completed===true&&report.cleanedUp===true&&
    !report.error&&!report.cleanupError&&!report.cacheRestoreError&&!report.cloneMonitorCleanupError&&!report.placementUncertain&&
    report.cacheAddress?.completed===true&&report.cacheAddress.memoryRestored===true&&
    report.cacheAddress.retired===true&&report.cacheAddress.backingUnchanged===true&&
    report.cacheAlias?.completed===true&&report.cacheAlias.backingUnchanged===true&&
    proof?.readWriteRestoreVerified===true;
}
function summarize(report){
  const keys=['session','completed','cleanedUp','stopped','error','cleanupError','cacheRestoreError',
    'placementUncertain','failureSummary','freeSpace','storageSize','workerDelaysNs','pinRetries',
    'qualifiedReadSize','markerSelected','markerReproduced','canaryChanged','serveSkipped',
    'cacheAddress','cacheAlias','originalRom','scratchWritesStarted','cloneTopology','cloneMonitor',
    'cloneMonitorCleanupError','workerCaptureSkipped','diagTriggerEarly'];
  const summary=Object.fromEntries(keys.filter(k=>k in report).map(k=>[k,report[k]]));
  summary.caseCount=report.cases?.length||0;
  summary.lastCases=(report.cases||[]).slice(-3).map(row=>Object.fromEntries(
    ['profile','restored','newPersistentBytes','pinWindowOk','pinCostOk','allPending','nativeGuard',
      'receiveOrderMarginUs','triggerAborted','changedPaths','rows'].filter(k=>k in row).map(k=>[k,row[k]])));
  summary.retained={base:report.retained?.base,handles:report.retained?.handles,
    threads:report.retained?.threads,created:report.retained?.created,cacheNeedsRestore:report.retained?.cacheNeedsRestore};
  return summary;
}
async function main(){
  const result={schemaVersion:1,tool:'izcivswitch-fs-check',checkerVersion:'0.7.0',
    requestedFirmware:'20.4.0',session:live.session,started:new Date().toISOString(),
    attempted:false,attemptLimit:1,verified:false,cleanedUp:false,fullFilesystemSupport:'UNVERIFIED'};
  try {
    const disk=await fs.statfs(__dirname);
    check(BigInt(disk.bavail)*BigInt(disk.bsize)>=512n*1024n*1024n,'Keep at least 512 MiB free on the PC for backup and reports');
    console.log('Inspecting the current save mount.');
    const inspected=await runScript(path.join(__dirname,'app/inspect-mounts.cjs'));
    check(inspected.code===0&&!inspected.deadlineExceeded,'Fresh mount inspection failed');
    console.log('Backing up every file in the mounted Civ7 save before scratch writes.');
    const s=new Session('save-backup-'+Date.now(),0x80000);
    try {
      await s.initialize();
      const saved=await mounted.cloneMountedFilesystem(s,'save');
      result.backup=await backupSave({session:s,filesystem,handle:saved,
        directory:path.join(__dirname,'save-backup'),sessionId:live.session});
    } finally {
      await s.cleanup();
      result.backupCleanup={cleanedUp:!s.base&&!s.handles.size&&!s.threads.size&&!s.allocationUncertain};
    }
    check(result.backup?.complete&&result.backupCleanup.cleanedUp,'Backup or its native cleanup did not verify');
    const stopFile=path.join(__dirname,'STOP_FS_CHECK');
    let stopRequested=false;
    try{await fs.access(stopFile);stopRequested=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    check(!stopRequested,'Stopped after backup, before filesystem scratch writes');
    console.log('Backup verified. Starting ONE filesystem memory acquisition attempt.');
    result.attempted=true;
    await fs.writeFile(path.join(__dirname,'fs-check.json'),JSON.stringify(result,null,2)+'\n');
    const outcome=await runScript(path.join(__dirname,'memory/probe-reserved-gap.cjs'),{
      timeoutMs:600000,stopFile,env:{NS2_SKIP_SERVE:'1',NS2_SERVE_DELAY_MS:'0',NS2_STOP_FILE:stopFile}});
    result.outcome=outcome;
    const names=(await fs.readdir(path.join(__dirname,'memory'))).filter(n=>/^reserved-gap-\d+\.json$/.test(n));
    check(names.length===1,'Expected exactly one acquisition report from this fresh run');
    const reportFile=path.join(__dirname,'memory',names[0]);
    const report=JSON.parse(await fs.readFile(reportFile,'utf8'));result.acquisition=summarize(report);result.report=reportFile;
    result.cleanedUp=report.cleanedUp===true;
    check(outcome.code===0&&!outcome.deadlineExceeded,'Filesystem attempt stopped: '+(report.failureSummary?.message||report.error?.split('\n')[0]||'see acquisition report'));
    result.proof=await verifyProof(reportFile,live.session);
    check(acceptable(report,result.proof,live.session),'Filesystem proof, restoration or cleanup did not verify');
    result.verified=true;
  } catch(e) {result.error=e.stack;}
  finally {
    result.requiresRestart=!result.verified;result.completed=new Date().toISOString();
    await fs.writeFile(path.join(__dirname,'fs-check.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({tool:result.tool,verified:result.verified,cleanedUp:result.cleanedUp,
      attempted:result.attempted,error:result.error?.split('\n')[0],report:path.join(__dirname,'fs-check.json')}));
  }
  if(!result.verified)process.exitCode=2;
  return result;
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={acceptable,summarize,runScript,main};
