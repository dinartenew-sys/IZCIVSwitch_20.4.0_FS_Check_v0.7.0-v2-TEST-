const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../port/engine/switch2/app/session.cjs'),'utf8');
function session(){
  let frees=0;const fsMock={appendFile:async()=>{}};
  const mocks={'node:fs/promises':fsMock,'node:path':path,
    './rpc.cjs':{live:{platform:2,sdk:0x10000000},client:()=>{}},
    '../../shared/rpc.cjs':{request:async()=>({ready:true})},
    '../../shared/sdk-functions.json':{free:{offset:4}},'../../shared/ipc.cjs':{}};
  const c={module:{exports:{}},require:n=>{if(!(n in mocks))throw Error(n);return mocks[n];},__dirname:'.',Buffer};
  vm.runInNewContext(source,c);const s=new c.module.exports.Session('test');
  s.base=0x30000000;s.rpc={call3:async()=>{frees++;return 0;}};return {s,frees:()=>frees};
}
test('an unverified SDK allocation is retained during cleanup',async()=>{
  const {s,frees}=session();await s.cleanup();assert.equal(frees(),0);assert.ok(s.base);
});
test('verified SDK memory stays allocated while a worker is live or uncertain',async()=>{
  const {s,frees}=session();s.allocationVerified=true;s.threads.add('creating');
  await s.cleanup();assert.equal(frees(),0);assert.ok(s.base);
});
test('verified SDK allocation is freed when all workers and handles are gone',async()=>{
  const {s,frees}=session();s.allocationVerified=true;await s.cleanup();assert.equal(frees(),1);assert.equal(s.base,0);
});
