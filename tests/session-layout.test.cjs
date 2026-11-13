const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createClients}=require('../port/engine/switch2/memory/compact-clients.cjs');

// Fake owned sessions: every clone request returns a new handle.
function fixture(){
  let next=100;const requests=[];
  const clone=async(source,label)=>{requests.push({source,label});return next++;};
  return {clone,requests,saved:1,root:2,storage:3,temporary:4,base:0x30000000};
}

test('layout A keeps the trigger as a clone of saved and makes seven clones',async()=>{
  const f=fixture();
  const topology=await createClients({saved:f.saved,root:f.root,storage:f.storage,base:f.base,clone:f.clone});
  assert.equal(f.requests.length,7);
  assert.equal(topology.savedTrigger,topology.tmpTrigger);
  assert.notEqual(topology.savedTrigger,f.saved);
  assert.equal(topology.report.sessionLayout,'A');
  assert.equal(topology.report.temporaryIsBaseSave,true);
});

test('layout C uses the separate temporary copy as the trigger with no trigger clone',async()=>{
  const f=fixture();
  const topology=await createClients({saved:f.saved,root:f.root,storage:f.storage,base:f.base,clone:f.clone,
    temporary:f.temporary});
  assert.equal(f.requests.length,6);
  assert.ok(!f.requests.some(r=>r.label==='Clone trigger'));
  assert.equal(topology.savedTrigger,f.temporary);
  assert.equal(topology.tmpTrigger,f.temporary);
  assert.equal(topology.report.sessionLayout,'C');
  assert.equal(topology.report.temporaryIsSeparateCopy,true);
  assert.equal(topology.report.temporaryIsBaseSave,false);
  assert.equal(topology.report.triggerSource,'temporary');
});

test('layout C keeps ten distinct sessions at setup',async()=>{
  const f=fixture();
  const topology=await createClients({saved:f.saved,root:f.root,storage:f.storage,base:f.base,clone:f.clone,
    temporary:f.temporary});
  const handles=[f.saved,f.root,f.storage,...topology.clients.filter(h=>Number.isInteger(h)),f.temporary];
  assert.equal(new Set(handles).size,10);
});

test('layout C rejects a temporary copy that duplicates another role',async()=>{
  const f=fixture();
  await assert.rejects(createClients({saved:f.saved,root:f.root,storage:f.storage,base:f.base,clone:f.clone,
    temporary:f.root}),/ten distinct owned sessions/);
});

test('layout C rejects the root trigger override',async()=>{
  const f=fixture();
  await assert.rejects(createClients({saved:f.saved,root:f.root,storage:f.storage,base:f.base,clone:f.clone,
    temporary:f.temporary,triggerFrom:'root'}),/trigger source override/);
});

test('session layout switch defaults to A and only accepts A or C',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../port/engine/switch2/memory/probe-reserved-gap.cjs'),'utf8');
  assert.ok(source.includes("const diagSessionLayout = process.env.NS2_DIAG_SESSION_LAYOUT || 'A';"),
    'layout switch must default to A');
  assert.ok(source.includes("if (!['A', 'C'].includes(diagSessionLayout))"),'unsupported layouts must be rejected');
  assert.ok(source.includes("temporary = diagSessionLayout === 'C' ? await mounted.cloneMountedFilesystem(s, 'save') : saved;"),
    'layout C must open a separate copy');
});

// runChild strips NS2_* variables outside an allowlist before spawning fs-check.cjs,
// which spawns the probe. Without the allowlist entry the switch never reaches the probe.
const DIAG_ALLOWLIST=['NS2_DIAG_TRIGGER_EARLY','NS2_DIAG_TRIGGER_SOURCE','NS2_DIAG_SESSION_LAYOUT','NS2_DIAG_STOP_AT_SCRATCH','NS2_DIAG_FILLER_ROLES'];
const LAUNCHER_SET=['NS2_TARGET','NS2_PORT_ROOT','NS2_TARGET_ROOT'];

function sourceFiles(dir){
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
    const p=path.join(dir,e.name);
    return e.isDirectory()?sourceFiles(p):(/\.c?js$/.test(e.name)?[p]:[]);
  });
}

function restoreEnv(name,value){
  if(value===undefined) delete process.env[name];
  else process.env[name]=value;
}

test('brute force: every NS2_ name the engine reads is forwarded only if allowlisted',()=>{
  const {childEnvironment}=require('../run_fs_check.cjs');
  // Names come from the engine source, so a new NS2_ variable is covered without editing this test.
  const names=new Set(['NS2_DIAG_TRIGGER','NS2_DIAG_SESSION','NS2_DIAG_SESSION_LAYOUT_X','NS2_NOT_A_SWITCH']);
  for(const file of sourceFiles(path.join(__dirname,'../port')))
    for(const m of fs.readFileSync(file,'utf8').matchAll(/NS2_[A-Z0-9_]+/g)) names.add(m[0]);
  for(const name of DIAG_ALLOWLIST) assert.ok(names.has(name),name+' is not read by the engine');
  const values=['1','0','A','C','','x y'];
  for(const name of names) for(const value of values){
    const env=childEnvironment({PATH:'C:\\bin',KEEP:'k',[name]:value},'D:\\staged','R:\\root');
    assert.equal(env.KEEP,'k');
    assert.equal(env.PATH,'C:\\bin');
    assert.equal(env.NS2_TARGET,'civ7');
    assert.equal(env.NS2_PORT_ROOT,path.join('R:\\root','port'));
    assert.equal(env.NS2_TARGET_ROOT,'D:\\staged');
    if(DIAG_ALLOWLIST.includes(name)) assert.equal(env[name],value,name+' must be forwarded');
    else if(!LAUNCHER_SET.includes(name)) assert.ok(!(name in env),name+' must be stripped');
  }
});

test('the launcher spawns the child with the layout switch and strips unlisted NS2_ variables',async()=>{
  const {runChild}=require('../run_fs_check.cjs');
  const staged=fs.mkdtempSync(path.join(os.tmpdir(),'layout-forward-'));
  const set={NS2_DIAG_SESSION_LAYOUT:'C',NS2_DIAG_TRIGGER_EARLY:'1',NS2_SKIP_SERVE:'1',NS2_STOP_FILE:'unused'};
  const previous={};
  try{
    fs.mkdirSync(path.join(staged,'switch2'));
    fs.writeFileSync(path.join(staged,'switch2','fs-check.cjs'),
      "require('node:fs').writeFileSync(require('node:path').join(__dirname,'env.json'),JSON.stringify(process.env));");
    for(const k of Object.keys(set)){previous[k]=process.env[k];process.env[k]=set[k];}
    const outcome=await runChild(staged,()=>{});
    assert.equal(outcome.code,0);
    const env=JSON.parse(fs.readFileSync(path.join(staged,'switch2','env.json'),'utf8'));
    assert.equal(env.NS2_DIAG_SESSION_LAYOUT,'C');
    assert.equal(env.NS2_DIAG_TRIGGER_EARLY,'1');
    assert.equal(env.NS2_SKIP_SERVE,undefined);
    assert.equal(env.NS2_STOP_FILE,undefined);
    assert.equal(env.NS2_TARGET,'civ7');
  }finally{
    for(const k of Object.keys(set)) restoreEnv(k,previous[k]);
    fs.rmSync(staged,{recursive:true,force:true});
  }
});

test('brute force: the probe rejects every layout value other than A or C before it connects',async()=>{
  const net=require('node:net');
  const previousTarget=process.env.NS2_TARGET, previousLayout=process.env.NS2_DIAG_SESSION_LAYOUT;
  const previousSource=process.env.NS2_DIAG_TRIGGER_SOURCE;
  const originals={connect:net.connect,createConnection:net.createConnection};
  let attempts=0;
  const blocked=()=>{attempts++;throw Error('connection attempted');};
  try{
    process.env.NS2_TARGET='civ7';
    const {main}=require('../port/engine/switch2/memory/probe-reserved-gap.cjs');
    net.connect=blocked;net.createConnection=blocked;
    const invalid=['a','c',' C','C ','AC','CC','A,C','B','0','1','root','saved','None','null'];
    for(const value of invalid){
      process.env.NS2_DIAG_SESSION_LAYOUT=value;
      const error=await main().then(()=>null,e=>e);
      assert.ok(error,JSON.stringify(value)+' was not rejected');
      assert.equal(error.message,'Unsupported session layout '+value);
    }
    process.env.NS2_DIAG_SESSION_LAYOUT='C';
    process.env.NS2_DIAG_TRIGGER_SOURCE='root';
    const combined=await main().then(()=>null,e=>e);
    assert.equal(combined&&combined.message,'Layout C does not support NS2_DIAG_TRIGGER_SOURCE=root');
    assert.equal(attempts,0,'a connection was attempted before the layout check');
  }finally{
    net.connect=originals.connect;net.createConnection=originals.createConnection;
    restoreEnv('NS2_TARGET',previousTarget);
    restoreEnv('NS2_DIAG_SESSION_LAYOUT',previousLayout);
    restoreEnv('NS2_DIAG_TRIGGER_SOURCE',previousSource);
  }
});

// Every set partition of n slots, as restricted growth strings (Bell(10) = 115,975).
// Each partition is one equality pattern among the handles, so this covers every arrangement once.
function* partitions(n){
  const labels=new Array(n).fill(0);
  function* grow(i,max){
    if(i===n){yield labels.slice();return;}
    for(let v=0;v<=max+1;v++){labels[i]=v;yield* grow(i+1,Math.max(max,v));}
  }
  yield* grow(1,0);
}

test('brute force: createClients accepts only the all-distinct arrangement, in both layouts',async()=>{
  for(const layoutC of [false,true]){
    let count=0,accepted=0;
    for(const labels of partitions(10)){
      count++;
      const handle=slot=>labels[slot]+1;
      let cloneCall=0;
      const clone=async()=>handle(3+cloneCall++);
      const options={saved:handle(0),root:handle(1),storage:handle(2),base:0x30000000,clone,
        ...(layoutC?{temporary:handle(9)}:{})};
      let error=null;
      try{await createClients(options);}catch(e){error=e;}
      if(new Set(labels).size===10){
        assert.equal(error,null,'all-distinct arrangement '+labels+' rejected: '+(error&&error.message));
        assert.equal(cloneCall,layoutC?6:7,'unexpected clone request count');
        accepted++;
      }else{
        assert.ok(error&&/ten distinct owned sessions/.test(error.message),'duplicate arrangement '+labels+' was accepted');
      }
    }
    assert.equal(count,115975);
    assert.equal(accepted,1);
  }
});

test('brute force: createClients rejects every invalid handle value in every role, in both layouts',async()=>{
  for(const layoutC of [false,true])
    for(const bad of [0,-1,1.5,NaN,0xffff8000,0xffffffff,null])
      for(let slot=0;slot<10;slot++){
        const values=Array.from({length:10},(_,i)=>i+1);
        values[slot]=bad;
        let cloneCall=0;
        const clone=async()=>values[3+cloneCall++];
        const options={saved:values[0],root:values[1],storage:values[2],base:0x30000000,clone,
          ...(layoutC?{temporary:values[9]}:{})};
        await assert.rejects(createClients(options),/ten distinct owned sessions/,
          String(bad)+' in slot '+slot+' was accepted (layoutC='+layoutC+')');
      }
});
