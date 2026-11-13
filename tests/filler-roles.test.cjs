const test=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const {waveRoles,diagnosticFillerRoles,BASE_ROLES,FILLER_ROLES}=require('../port/engine/switch2/memory/wave-roles.cjs');
const {createClients}=require('../port/engine/switch2/memory/compact-clients.cjs');

function restoreEnv(name,value){
  if(value===undefined) delete process.env[name];
  else process.env[name]=value;
}

function fixture(){
  let next=100;const labels=[];
  const clone=async(source,label)=>{labels.push(label);return next++;};
  return {clone,labels,saved:1,root:2,storage:3,temporary:4,base:0x30000000};
}

test('the filler switch accepts only unset, empty, 0 and 1, and only on Layout A',()=>{
  assert.equal(diagnosticFillerRoles(undefined,false),false);
  assert.equal(diagnosticFillerRoles('',false),false);
  assert.equal(diagnosticFillerRoles('0',false),false);
  assert.equal(diagnosticFillerRoles('1',false),true);
  assert.throws(()=>diagnosticFillerRoles('1',true),{message:'Filler roles are tested on Layout A only'});
  for(const value of ['2','true','yes','01',' 1','1 ','-1'])
    assert.throws(()=>diagnosticFillerRoles(value,false),{message:'Unsupported filler-roles value '+value});
});

test('the role schedule keeps the base order and adds upstream filler positions when enabled',()=>{
  assert.deepEqual(waveRoles(false),[...BASE_ROLES]);
  assert.equal(BASE_ROLES.indexOf('release'),7);
  assert.deepEqual(waveRoles(true),[...FILLER_ROLES]);
  assert.equal(FILLER_ROLES.length,13);
  assert.equal(FILLER_ROLES.indexOf('filler0'),7);
  assert.equal(FILLER_ROLES.indexOf('filler1'),8);
  assert.equal(FILLER_ROLES.indexOf('release'),9);
  assert.equal(FILLER_ROLES.indexOf('guard0'),10);
  assert.equal(FILLER_ROLES.indexOf('guard1'),11);
  assert.equal(new Set(FILLER_ROLES).size,FILLER_ROLES.length);
});

test('the base setup still makes seven clones and ten sessions',async()=>{
  const f=fixture();
  const topology=await createClients({saved:f.saved,root:f.root,storage:f.storage,base:f.base,clone:f.clone});
  assert.equal(f.labels.length,7);
  assert.equal(topology.clients.length,BASE_ROLES.length);
  assert.equal(topology.report.requiredSetupSessions,10);
  assert.equal(topology.report.fillerRoles,false);
});

test('filler setup makes ten clones in upstream order and one client slot per role',async()=>{
  const f=fixture();
  const topology=await createClients({saved:f.saved,root:f.root,storage:f.storage,base:f.base,clone:f.clone,
    fillerRoles:true});
  assert.deepEqual(f.labels,['Clone tail0','Clone tail1','Clone tail2','Clone tail3','Clone canary',
    'Clone filler0','Clone filler1','Clone guard0','Clone guard1','Clone trigger']);
  const {clients}=topology;
  assert.equal(clients.length,FILLER_ROLES.length);
  // Index i of clients is the slot of FILLER_ROLES[i]; the release and trigger slots are pointer words.
  assert.deepEqual(clients[FILLER_ROLES.indexOf('release')],{u32:f.base+0x2a00});
  assert.deepEqual(clients[FILLER_ROLES.indexOf('trigger')],{u32:f.base+0x2a04});
  for(const role of ['tail0','tail1','tail2','tail3','canary','filler0','filler1','guard0','guard1'])
    assert.ok(Number.isInteger(clients[FILLER_ROLES.indexOf(role)]),role+' must be a session');
  assert.equal(topology.report.requiredSetupSessions,13);
  assert.equal(topology.report.fillerRoles,true);
  assert.deepEqual(topology.report.roles,[...FILLER_ROLES]);
});

test('base setup places the release and trigger pointer words at the base role indices',async()=>{
  const f=fixture();
  const {clients}=await createClients({saved:f.saved,root:f.root,storage:f.storage,base:f.base,clone:f.clone});
  assert.deepEqual(clients[BASE_ROLES.indexOf('release')],{u32:f.base+0x2a00});
  assert.deepEqual(clients[BASE_ROLES.indexOf('trigger')],{u32:f.base+0x2a04});
});

test('filler setup rejects any duplicate among its thirteen sessions',async()=>{
  const f=fixture();
  for(let dup=0;dup<10;dup++){
    let call=0;
    const clone=async()=>call++===dup?f.saved:100+call;
    await assert.rejects(createClients({saved:f.saved,root:f.root,storage:f.storage,base:f.base,clone,
      fillerRoles:true}),{message:'Concurrent filesystem roles require thirteen distinct owned sessions'},
      'duplicate at clone '+dup+' was accepted');
  }
});

test('filler setup is rejected under Layout C before any clone',async()=>{
  const f=fixture();
  await assert.rejects(createClients({saved:f.saved,root:f.root,storage:f.storage,base:f.base,clone:f.clone,
    temporary:f.temporary,fillerRoles:true}),{message:'Filler roles are tested on Layout A only'});
  assert.equal(f.labels.length,0);
});

test('the probe rejects an invalid filler switch before connecting',async()=>{
  const previous={target:process.env.NS2_TARGET,layout:process.env.NS2_DIAG_SESSION_LAYOUT,
    source:process.env.NS2_DIAG_TRIGGER_SOURCE,stop:process.env.NS2_DIAG_STOP_AT_SCRATCH,
    filler:process.env.NS2_DIAG_FILLER_ROLES};
  const originals={connect:net.connect,createConnection:net.createConnection};
  let attempts=0;
  const blocked=()=>{attempts++;throw Error('connection attempted');};
  try{
    process.env.NS2_TARGET='civ7';
    delete process.env.NS2_DIAG_SESSION_LAYOUT;
    delete process.env.NS2_DIAG_TRIGGER_SOURCE;
    delete process.env.NS2_DIAG_STOP_AT_SCRATCH;
    const {main}=require('../port/engine/switch2/memory/probe-reserved-gap.cjs');
    net.connect=blocked;net.createConnection=blocked;
    for(const value of ['2','true','yes','01']){
      process.env.NS2_DIAG_FILLER_ROLES=value;
      const error=await main().then(()=>null,e=>e);
      assert.equal(error&&error.message,'Unsupported filler-roles value '+value);
    }
    process.env.NS2_DIAG_FILLER_ROLES='1';
    process.env.NS2_DIAG_SESSION_LAYOUT='C';
    const combined=await main().then(()=>null,e=>e);
    assert.equal(combined&&combined.message,'Filler roles are tested on Layout A only');
    assert.equal(attempts,0,'a connection was attempted before the filler switch check');
  }finally{
    net.connect=originals.connect;net.createConnection=originals.createConnection;
    restoreEnv('NS2_TARGET',previous.target);
    restoreEnv('NS2_DIAG_SESSION_LAYOUT',previous.layout);
    restoreEnv('NS2_DIAG_TRIGGER_SOURCE',previous.source);
    restoreEnv('NS2_DIAG_STOP_AT_SCRATCH',previous.stop);
    restoreEnv('NS2_DIAG_FILLER_ROLES',previous.filler);
  }
});
