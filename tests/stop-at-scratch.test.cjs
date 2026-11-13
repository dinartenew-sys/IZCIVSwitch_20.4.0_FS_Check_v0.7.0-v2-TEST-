const test=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const {RunControl,StopRequested,diagnosticStopPoint}=require('../port/engine/switch2/memory/run-control.cjs');

function restoreEnv(name,value){
  if(value===undefined) delete process.env[name];
  else process.env[name]=value;
}

const CHECKPOINTS=['before setup','before scratch writes','before scratch writes ','before scratch',
  'Before scratch writes','after before scratch writes','before wave','after setup',''];

test('brute force: the stop switch accepts only unset, empty, 0 and 1',()=>{
  assert.equal(diagnosticStopPoint(undefined),null);
  assert.equal(diagnosticStopPoint(''),null);
  assert.equal(diagnosticStopPoint('0'),null);
  assert.equal(diagnosticStopPoint('1'),'before scratch writes');
  for(const value of ['2','true','yes','on',' 1','1 ','01','-1','TRUE','1.0','null'])
    assert.throws(()=>diagnosticStopPoint(value),{message:'Unsupported stop-at-scratch value '+value});
});

test('a run with a stop point stops only at that checkpoint and records where',async()=>{
  const previous=process.env.NS2_STOP_FILE;
  delete process.env.NS2_STOP_FILE;
  try{
    const control=new RunControl({id:'stop-test',save:async()=>{},stopAt:'before scratch writes'});
    await control.checkpoint('before setup');
    assert.equal(control.state.mode,'running');
    await assert.rejects(control.checkpoint('before scratch writes'),StopRequested);
    assert.equal(control.state.mode,'stopping');
    assert.equal(control.state.checkpoint,'before scratch writes');
  }finally{restoreEnv('NS2_STOP_FILE',previous);}
});

test('brute force: only the exact stop-point name stops the run',async()=>{
  const previous=process.env.NS2_STOP_FILE;
  delete process.env.NS2_STOP_FILE;
  try{
    for(const name of CHECKPOINTS){
      const control=new RunControl({id:'stop-test',save:async()=>{},stopAt:'before scratch writes'});
      const outcome=await control.checkpoint(name).then(()=>'continued',
        error=>error instanceof StopRequested?'stopped':'error');
      assert.equal(outcome,name==='before scratch writes'?'stopped':'continued',JSON.stringify(name));
    }
  }finally{restoreEnv('NS2_STOP_FILE',previous);}
});

test('a run without a stop point never stops at any checkpoint',async()=>{
  const previous=process.env.NS2_STOP_FILE;
  delete process.env.NS2_STOP_FILE;
  try{
    const control=new RunControl({id:'no-stop',save:async()=>{}});
    for(const name of CHECKPOINTS) await control.checkpoint(name);
    assert.equal(control.state.mode,'running');
    assert.equal(control.state.stopAt,null);
  }finally{restoreEnv('NS2_STOP_FILE',previous);}
});

test('the probe rejects an invalid stop switch before connecting',async()=>{
  const previous={target:process.env.NS2_TARGET,layout:process.env.NS2_DIAG_SESSION_LAYOUT,
    source:process.env.NS2_DIAG_TRIGGER_SOURCE,stop:process.env.NS2_DIAG_STOP_AT_SCRATCH};
  const originals={connect:net.connect,createConnection:net.createConnection};
  let attempts=0;
  const blocked=()=>{attempts++;throw Error('connection attempted');};
  try{
    process.env.NS2_TARGET='civ7';
    delete process.env.NS2_DIAG_SESSION_LAYOUT;
    delete process.env.NS2_DIAG_TRIGGER_SOURCE;
    const {main}=require('../port/engine/switch2/memory/probe-reserved-gap.cjs');
    net.connect=blocked;net.createConnection=blocked;
    for(const value of ['2','true','yes','01']){
      process.env.NS2_DIAG_STOP_AT_SCRATCH=value;
      const error=await main().then(()=>null,e=>e);
      assert.equal(error&&error.message,'Unsupported stop-at-scratch value '+value);
    }
    assert.equal(attempts,0,'a connection was attempted before the stop switch check');
  }finally{
    net.connect=originals.connect;net.createConnection=originals.createConnection;
    restoreEnv('NS2_TARGET',previous.target);
    restoreEnv('NS2_DIAG_SESSION_LAYOUT',previous.layout);
    restoreEnv('NS2_DIAG_TRIGGER_SOURCE',previous.source);
    restoreEnv('NS2_DIAG_STOP_AT_SCRATCH',previous.stop);
  }
});
