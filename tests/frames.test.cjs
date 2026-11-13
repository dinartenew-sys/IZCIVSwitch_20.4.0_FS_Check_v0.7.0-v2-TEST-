const test=require('node:test');
const assert=require('node:assert/strict');
const {build}=require('../port/engine/shared/frames.cjs');
const {loadTarget}=require('../port/engine/shared/target.cjs');
const table=require('../port/civ7-app/thread-code.json');
const target=loadTarget('civ7');
const code={...table.functions,rawExitContinuation:table.rawSvc.functions.exitThread};
test('dynamic u32 arguments use a preceding copy into the argument register slot',()=>{
  const sdk=0x10000000,base=0x30000000,length=base+0x4000;
  const {frame,proof}=build(base,sdk,[{function:sdk+0x5224e0,args:[base+0x50000,base+0x5000,{u32:length},0]}],code,false,target);
  assert.equal(proof.logicalCalls,1);assert.equal(proof.nativeCalls,2);assert.deepEqual(proof.logicalResultIndices,[1]);
  const word=at=>Number(frame.readBigUInt64LE(at));
  const stack=proof.stackOffset,tables=proof.tablesOffset;
  assert.equal(word(0x30),base+stack+0x140+0x20);
  assert.equal(word(stack+0x10),length);assert.equal(word(stack+0x20),4);
  assert.equal(word(tables+0x80),sdk+0x5224e0);
  assert.equal(word(tables+0x100+0x80),sdk+0x5224e0);
  assert.equal(word(stack+0x140+0x128),sdk+0x168b4c);
});
test('unaligned dynamic input and out-of-SDK worker functions fail before launch',()=>{
  const sdk=0x10000000,base=0x30000000;
  assert.throws(()=>build(base,sdk,[{function:sdk+4,args:[0,0,{u32:base+1},0]}],code,false,target));
  assert.throws(()=>build(base,sdk,[{function:0,args:[0,0,0,0]}],code,false,target));
});
