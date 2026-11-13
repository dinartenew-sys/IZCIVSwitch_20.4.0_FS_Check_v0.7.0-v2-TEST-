// SPDX-License-Identifier: GPL-2.0-only
const {waveRoles} = require('./wave-roles.cjs');
// Distinct concurrent roles; host save operations finish before the wave starts.
// triggerFrom: 'saved' (default) or 'root'. Diagnostic: 'root' sends the trigger
// from a different source object without adding a session.
// temporary (Layout C, diagnostic): a separate filesystem copy that is the trigger
// source. No trigger clone is made, so the setup count stays at ten.
async function createClients({saved,root,storage,base,clone,triggerFrom='saved',temporary=null,fillerRoles=false}) {
  if(triggerFrom!=='saved'&&triggerFrom!=='root') throw Error('Unsupported trigger source '+triggerFrom);
  if(temporary!==null&&triggerFrom!=='saved') throw Error('Layout C sends the trigger from the temporary copy; trigger source override is not allowed');
  const layoutC=temporary!==null;
  if(fillerRoles&&layoutC) throw Error('Filler roles are tested on Layout A only');
  const clients=[saved,storage],clones=[];
  async function copy(source,role){
    const handle=await clone(source,'Clone '+role);
    clones.push({source,role,handle});return handle;
  }
  
  // Restored 4 tails
  for(let i=0;i<4;i++)clients.push(await copy(root,'tail'+i));
  
  // Removed 'filler0'
  for(const role of ['canary'])clients.push(await copy(saved,role));
  
  // Diagnostic filler roles (upstream order): filler0, filler1 before release; guard0 before guard1.
  if(fillerRoles) clients.push(await copy(saved,'filler0'),await copy(saved,'filler1'));
  clients.push({u32:base+0x2a00});
  if(fillerRoles) clients.push(await copy(saved,'guard0'));
  clients.push(await copy(saved,'guard1'),{u32:base+0x2a04});

  const savedTrigger=layoutC?temporary:await copy(triggerFrom==='root'?root:saved,'trigger'),tmpTrigger=savedTrigger;
  const distinct=[saved,root,storage,...clones.map(row=>row.handle)];
  if(layoutC) distinct.push(temporary);

  const required=fillerRoles?13:10, word=fillerRoles?'thirteen':'ten';
  if(distinct.some(h=>!Number.isInteger(h)||h<=0||h>=0xffff8000)||new Set(distinct).size!==required)
    throw Error('Concurrent filesystem roles require '+word+' distinct owned sessions');

  return {clients,savedTrigger,tmpTrigger,report:{name:'COMPACT_DISTINCT_WORKER_SESSIONS',
    baseSaveIsCommit:true,temporaryIsBaseSave:!layoutC,temporaryIsSeparateCopy:layoutC,
    sessionLayout:layoutC?'C':'A',triggerSharedAcrossSequentialWaves:true,
    releasedMetadataCopyBeforeClones:true,requiredSetupSessions:required,clones,
    fillerRoles,triggerSource:layoutC?'temporary':triggerFrom,
    roles:waveRoles(fillerRoles)}};
}
module.exports={createClients};