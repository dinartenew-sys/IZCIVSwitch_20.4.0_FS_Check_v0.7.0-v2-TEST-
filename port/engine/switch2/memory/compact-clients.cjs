// SPDX-License-Identifier: GPL-2.0-only
// Distinct concurrent roles; host save operations finish before the wave starts.
async function createClients({saved,root,storage,base,clone}) {
  const clients=[saved,storage],clones=[];
  async function copy(source,role){
    const handle=await clone(source,'Clone '+role);
    clones.push({source,role,handle});return handle;
  }
  for(let i=0;i<4;i++)clients.push(await copy(root,'tail'+i));
  for(const role of ['canary','filler0','filler1'])clients.push(await copy(saved,role));
  clients.push({u32:base+0x2a00},await copy(saved,'guard0'),await copy(saved,'guard1'),{u32:base+0x2a04});
  const savedTrigger=await copy(saved,'trigger'),tmpTrigger=savedTrigger;
  const distinct=[saved,root,storage,...clones.map(row=>row.handle)];
  if(distinct.some(h=>!Number.isInteger(h)||h<=0||h>=0xffff8000)||new Set(distinct).size!==13)
    throw Error('Concurrent filesystem roles require thirteen distinct owned sessions');
  return {clients,savedTrigger,tmpTrigger,report:{name:'COMPACT_DISTINCT_WORKER_SESSIONS',
    baseSaveIsCommit:true,temporaryIsBaseSave:true,triggerSharedAcrossSequentialWaves:true,
    releasedMetadataCopyBeforeClones:true,requiredSetupSessions:13,clones,
    roles:['commit','hole','tail0','tail1','tail2','tail3','canary','filler0','filler1',
      'release','guard0','guard1','trigger']}};
}
module.exports={createClients};
