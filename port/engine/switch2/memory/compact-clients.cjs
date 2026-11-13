// SPDX-License-Identifier: GPL-2.0-only
// Distinct concurrent roles; host save operations finish before the wave starts.
// triggerFrom: 'saved' (default) or 'root'. Diagnostic: 'root' sends the trigger
// from a different source object without adding a session.
// temporary (Layout C, diagnostic): a separate filesystem copy that is the trigger
// source. No trigger clone is made, so the setup count stays at ten.
async function createClients({saved,root,storage,base,clone,triggerFrom='saved',temporary=null}) {
  if(triggerFrom!=='saved'&&triggerFrom!=='root') throw Error('Unsupported trigger source '+triggerFrom);
  if(temporary!==null&&triggerFrom!=='saved') throw Error('Layout C sends the trigger from the temporary copy; trigger source override is not allowed');
  const layoutC=temporary!==null;
  const clients=[saved,storage],clones=[];
  async function copy(source,role){
    const handle=await clone(source,'Clone '+role);
    clones.push({source,role,handle});return handle;
  }
  
  // Restored 4 tails
  for(let i=0;i<4;i++)clients.push(await copy(root,'tail'+i));
  
  // Removed 'filler0'
  for(const role of ['canary'])clients.push(await copy(saved,role));
  
  clients.push({u32:base+0x2a00},await copy(saved,'guard1'),{u32:base+0x2a04});
  
  const savedTrigger=layoutC?temporary:await copy(triggerFrom==='root'?root:saved,'trigger'),tmpTrigger=savedTrigger;
  const distinct=[saved,root,storage,...clones.map(row=>row.handle)];
  if(layoutC) distinct.push(temporary);

  // Changed to 10
  if(distinct.some(h=>!Number.isInteger(h)||h<=0||h>=0xffff8000)||new Set(distinct).size!==10)
    throw Error('Concurrent filesystem roles require ten distinct owned sessions');

  return {clients,savedTrigger,tmpTrigger,report:{name:'COMPACT_DISTINCT_WORKER_SESSIONS',
    baseSaveIsCommit:true,temporaryIsBaseSave:!layoutC,temporaryIsSeparateCopy:layoutC,
    sessionLayout:layoutC?'C':'A',triggerSharedAcrossSequentialWaves:true,
    releasedMetadataCopyBeforeClones:true,requiredSetupSessions:10,clones,
    triggerSource:layoutC?'temporary':triggerFrom,
    roles:['commit','hole','tail0','tail1','tail2','tail3','canary','release','guard1','trigger']}};
}
module.exports={createClients};