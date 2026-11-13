const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {backupSave}=require('../port/engine/switch2/backup-save.cjs');
const {verifyProof}=require('../port/engine/switch2/memory/verify-proof.cjs');
const {RunControl,StopRequested}=require('../port/engine/switch2/memory/run-control.cjs');
const {requestStop}=require('../request_stop.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function temporary(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'izciv-fs-test-'));
  t.after(async()=>{const resolved=path.resolve(root);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('izciv-fs-test-'));
    await fs.rm(resolved,{recursive:true,force:true});});
  return root;
}
function fakeSave(mode='normal'){
  const contents=Buffer.from('Civ7 save bytes'),closed=[];let reads=0,opens=0;
  return {closed,opens:()=>opens,session:{close:async h=>closed.push(h)},filesystem:{
    listDirectory:async(s,h,dir)=>dir==='/'?[{name:mode==='bad-name'?'../save':'saves',type:0,size:'0'}]:
      [{name:'a.Civ7Save',type:1,size:mode==='too-large'?'10000000000':String(contents.length)}],
    openFile:async()=>{opens++;return {result:0,handle:11};},
    fileSize:async()=>BigInt(contents.length),
    readFile:async()=>{reads++;return mode==='changed'&&reads>1?Buffer.alloc(contents.length,0x55):Buffer.from(contents);}
  }};
}
test('backup persists exact bytes, paths, checksums and two matching console reads',async t=>{
  const root=await temporary(t),f=fakeSave();
  const r=await backupSave({...f,handle:7,directory:path.join(root,'backup'),sessionId:'boot'});
  assert.equal(r.complete,true);assert.equal(r.entries[1].path,'/saves/a.Civ7Save');
  const b=await fs.readFile(path.join(r.directory,r.entries[1].localFile));
  assert.equal(b.toString(),'Civ7 save bytes');assert.equal(hash(b),r.entries[1].sha256);
  assert.equal(r.entries[1].consoleReadPasses,2);assert.deepEqual(f.closed,[11]);
});
test('a changing save fails backup and preserves an incomplete manifest',async t=>{
  const root=await temporary(t),f=fakeSave('changed'),directory=path.join(root,'backup');
  await assert.rejects(backupSave({...f,handle:7,directory,sessionId:'boot'}),/changed during/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'manifest.json'))).complete,false);
  assert.deepEqual(f.closed,[11]);
});
test('backup rejects path traversal and size limits before opening a file',async t=>{
  const root=await temporary(t);
  for(const mode of ['bad-name','too-large']){
    const f=fakeSave(mode);await assert.rejects(backupSave({...f,handle:7,directory:path.join(root,mode),sessionId:'boot'}));
    assert.equal(f.opens(),0);
  }
});

function driver(overrides={}){
  const calls=[];
  class Session{constructor(){this.base=0;this.handles=new Set();this.threads=new Set();}
    async initialize(){this.base=0x30000000;}async cleanup(){this.base=0;}}
  const mocks={'node:fs/promises':{statfs:async()=>({bavail:1000000,bsize:4096}),writeFile:async()=>{},
      access:async()=>{throw Object.assign(Error(),{code:'ENOENT'});}},'node:path':path,
    'node:child_process':{spawn:(exec,args)=>{calls.push(args[0]);const c=new EventEmitter();
      c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>{};queueMicrotask(()=>c.emit('close',0,null));return c;}},
    './app/session.cjs':{Session,live:{session:'boot'}},'./app/filesystem.cjs':{},
    './app/mounted-save.cjs':{cloneMountedFilesystem:async()=>7},
    './backup-save.cjs':{backupSave:async()=>{throw Error('backup failed');}},
    './memory/verify-proof.cjs':{verifyProof:async()=>({readWriteRestoreVerified:true})},...overrides};
  const c={module:{exports:{}},require:n=>{if(!(n in mocks))throw Error(n);return mocks[n];},__dirname:'.',
    console:{log:()=>{},error:()=>{}},process:{env:{},execPath:'node',stdout:{write:()=>{}},stderr:{write:()=>{}},exitCode:0},setTimeout,clearTimeout};
  vm.runInNewContext(syncFs.readFileSync(path.join(__dirname,'../port/engine/switch2/fs-check.cjs'),'utf8'),c);
  return {...c.module.exports,calls};
}
test('backup failure prevents spawning the filesystem acquisition',async()=>{
  const d=driver(),r=await d.main();assert.equal(r.attempted,false);assert.equal(r.verified,false);
  assert.equal(d.calls.length,1);assert.ok(d.calls[0].endsWith('inspect-mounts.cjs'));
});
test('a backup that did not complete cannot authorize acquisition',async()=>{
  const d=driver({'./backup-save.cjs':{backupSave:async()=>({complete:false})}});
  const r=await d.main();assert.equal(r.attempted,false);assert.equal(d.calls.length,1);
});
test('filesystem success requires restored bytes, unchanged backing and complete cleanup',()=>{
  const {acceptable}=driver();
  const r={session:'boot',completed:true,cleanedUp:true,cacheAddress:{completed:true,memoryRestored:true,retired:true,backingUnchanged:true},
    cacheAlias:{completed:true,backingUnchanged:true}};
  const p={readWriteRestoreVerified:true};assert.equal(acceptable(r,p,'boot'),true);
  for(const change of [v=>v.cleanedUp=false,v=>v.placementUncertain=true,v=>v.cacheAddress.memoryRestored=false,
    v=>v.cacheAddress.backingUnchanged=false,v=>v.cacheAlias.backingUnchanged=false,v=>v.cleanupError='failed',v=>v.session='old']){
    const v=structuredClone(r);change(v);assert.equal(!!acceptable(v,p,'boot'),false);
  }
  assert.equal(!!acceptable(r,{readWriteRestoreVerified:false},'boot'),false);
});

async function proofFixture(t){
  const root=await temporary(t),original=Buffer.alloc(0x4000,0x11),ordinary=Buffer.alloc(0x4000,0x22);
  const marker=Buffer.from('46532d52572d323600ff11223344aa55','hex'),changed=Buffer.from(original);marker.copy(changed,0x108);
  const proof={target:0x200000000,readResults:[0,0],writeResult:0,restoreWriteResult:0,restoreReadResult:0,
    writeAddress:0x200000108,writeMarker:marker.toString('hex'),encoding:'signed-one-shot'};
  for(const [name,bytes,digest] of [['outputFile',original,'outputSha256'],['repeatOutputFile',original,'repeatSha256'],
    ['controlFile',ordinary,null],['writeOutputFile',changed,'writeOutputSha256'],['restoreOutputFile',original,'restoreSha256']]){
    proof[name]=path.join(root,name+'.bin');await fs.writeFile(proof[name],bytes);if(digest)proof[digest]=hash(bytes);
  }
  const file=path.join(root,'proof.json');await fs.writeFile(file,JSON.stringify({session:'boot',cacheAddress:proof}));
  return {root,proof,file};
}
test('independent proof verifier accepts a captured 16-byte change and exact full-block restoration',async t=>{
  const f=await proofFixture(t);assert.equal((await verifyProof(f.file,'boot')).readWriteRestoreVerified,true);
});
test('proof verifier rejects corruption of restored bytes',async t=>{
  const f=await proofFixture(t);await fs.writeFile(f.proof.restoreOutputFile,Buffer.alloc(0x4000,0x33));
  await assert.rejects(verifyProof(f.file,'boot'),/hash differs/);
});
test('proof verifier rejects a changed neighbor even when its claimed hash is updated',async t=>{
  const f=await proofFixture(t),b=await fs.readFile(f.proof.writeOutputFile);b[0x200]=0xff;
  await fs.writeFile(f.proof.writeOutputFile,b);f.proof.writeOutputSha256=hash(b);
  await fs.writeFile(f.file,JSON.stringify({session:'boot',cacheAddress:f.proof}));
  await assert.rejects(verifyProof(f.file,'boot'),/neighboring memory/);
});
test('stop request reaches the latest unfinished run and aborts at a checkpoint',async t=>{
  const root=await temporary(t),directory=path.join(root,'reports/run-20261112T020534009Z/engine/switch2');
  await fs.mkdir(directory,{recursive:true});assert.equal(await requestStop(root),true);
  const old=process.env.NS2_STOP_FILE;process.env.NS2_STOP_FILE=path.join(directory,'STOP_FS_CHECK');
  try{const control=new RunControl({id:'test',save:async()=>{}});
    await assert.rejects(control.checkpoint('test'),StopRequested);
    control.retire();await control.checkpoint('restoration');
  }finally{if(old===undefined)delete process.env.NS2_STOP_FILE;else process.env.NS2_STOP_FILE=old;}
});
