const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
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
