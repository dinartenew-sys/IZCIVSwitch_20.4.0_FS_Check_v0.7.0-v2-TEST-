const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const vm=require('node:vm');
const {buildPayload,localIPv4,LoaderChannel,passed,options}=require('../run_fs_check.cjs');
const COMMIT='6466918d6346aa0b5965fa0d44729235c4d94b14';
function channel(){const socket=new EventEmitter();socket.destroy=()=>socket.emit('close');return {socket,c:new LoaderChannel(socket)};}
function sdk(){return {tool:'izcivswitch-sdk-check',upstreamCommit:COMMIT,status:'SDK_FINGERPRINT_MATCH',applicationSdkMatch:true};}
test('builds a complete SDK-gated payload without opening a connection',async()=>{
  const b=await buildPayload('192.168.77.2');
  assert.ok(b.length<500*1024);new vm.Script(b.toString());
  assert.ok(!b.includes('__REFERENCE_PROFILE__')&&!b.includes('__CONSOLE_HOST__'));
  const s=b.toString();assert.ok(s.indexOf('result.status')<s.indexOf('const CONFIG'));
  assert.ok(s.includes("PC_IP: '192.168.77.2'"));
  assert.ok(s.includes("checkerVersion:'0.7.0'"));
});
test('host input remains a numeric local address',()=>{
  for(const s of ['192.168.77.2','10.0.0.2','172.16.0.1','127.0.0.1'])assert.equal(localIPv4(s),s);
  for(const s of ['8.8.8.8','example.com','0.0.0.0','192.168.1.2\n','192.168.1.2;test'])assert.throws(()=>localIPv4(s));
  assert.throws(()=>options(['--dump-firmware']));assert.throws(()=>options(['--rpc']));
});
test('fragmented SDK and ready lines resolve readiness only after valid preflight',async()=>{
  const {socket,c}=channel();const p=c.wait(()=>c.ready,500,'test');
  const b=Buffer.from('IZ20_REPORT '+JSON.stringify(sdk())+'\nIZ20_ENGINE_READY\n');
  for(let i=0;i<b.length;i+=7)socket.emit('data',b.subarray(i,i+7));
  await p;assert.equal(c.sdk.upstreamCommit,COMMIT);assert.equal(c.ready,true);
});
test('readiness without SDK proof fails',async()=>{
  const {socket,c}=channel();const p=c.wait(()=>c.ready,500,'test');
  socket.emit('data',Buffer.from('IZ20_ENGINE_READY\n'));await assert.rejects(p,/without a passing/);
});
test('an early EOF preserves a fragmented partial log and fails readiness',async()=>{
  const {socket,c}=channel();const p=c.wait(()=>c.ready,500,'test');
  socket.emit('data',Buffer.from('SDK progress: 12'));socket.emit('end');
  await assert.rejects(p,/ended/);assert.equal(c.log,'SDK progress: 12');
});
test('bridge cleanup after readiness can be awaited despite closed log stream',async()=>{
  const {socket,c}=channel();const report={tool:'izcivswitch-engine-bridge',checkerVersion:'0.7.0',requestedFirmware:'20.4.0',terminated:true,cleanupComplete:true};
  socket.emit('data',Buffer.from('IZ20_ENGINE_BRIDGE_REPORT '+JSON.stringify(report)+'\n'));
  socket.emit('end');await c.wait(()=>!!c.bridgeReport,50,'cleanup');assert.equal(c.bridgeReport.terminated,true);
});
test('foreign firmware cleanup reports are rejected',async()=>{
  const {socket,c}=channel();const p=c.wait(()=>!!c.bridgeReport,500,'test');
  socket.emit('data',Buffer.from('IZ20_ENGINE_BRIDGE_REPORT '+JSON.stringify({tool:'bad'})+'\n'));
  await assert.rejects(p,/Unexpected bridge/);
});
test('log limit rejects an interrupted session',async()=>{
  const {socket,c}=channel();const p=c.wait(()=>c.ready,500,'test');
  socket.emit('data',Buffer.alloc(2*1024*1024+1));await assert.rejects(p,/2 MiB/);
});
test('passing requires engine cleanup and clean bridge termination',()=>{
  const r={sdk:sdk(),bootstrap:{verified:true,scratchRestored:true},fs:{verified:true,cleanedUp:true,backup:{complete:true},proof:{readWriteRestoreVerified:true}},
    bridge:{terminated:true,cleanupComplete:true},cleanupErrors:[]};
  assert.equal(passed(r),true);
  for(const edit of [x=>x.fs.cleanedUp=false,x=>x.bridge.terminated=false,x=>x.cleanupErrors.push('failed'),x=>x.error='bad',x=>x.bootstrap.scratchRestored=false]) {
    const v=structuredClone(r);edit(v);assert.equal(!!passed(v),false);
  }
});
