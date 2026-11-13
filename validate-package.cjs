// Check the staged runtime before opening any console connection.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {loadTarget,materializeTarget}=require('./port/engine/shared/target.cjs');
const LOAD=String.raw`
const fs=require('node:fs'),path=require('node:path');
const root=process.argv[1];
const blocked=()=>{throw Error('Unexpected network request during runtime import check');};
require('node:http').request=blocked;
require('node:net').connect=blocked;require('node:net').createConnection=blocked;
for(const entry of ['switch2/fs-check.cjs','switch2/app/inspect-mounts.cjs','switch2/memory/mounted-rom.cjs',
  'switch2/memory/probe-reserved-gap.cjs','switch2/memory/monitored-clones.cjs','switch2/memory/compact-clients.cjs',
  'switch2/memory/native-links.cjs','switch2/memory/fs-memory-control.cjs',
  'switch2/memory/capture-workers.cjs','switch2/memory/verify-proof.cjs','switch2/retained/lower-window.cjs'])
  require(path.join(root,entry));
require(path.join(root,'switch2/memory/monitored-clones.cjs')).createMonitor({
  label:'offline-import-test',handles:new Set(),threads:new Set()});
`;
async function validatePackage(root=__dirname){
  const tempParent=path.resolve(os.tmpdir());
  const staged=await fs.mkdtemp(path.join(tempParent,'izciv-runtime-check-'));
  try{
    await fs.cp(path.join(root,'port/engine/shared'),path.join(staged,'shared'),{recursive:true});
    await fs.cp(path.join(root,'port/engine/switch2'),path.join(staged,'switch2'),{recursive:true});
    await materializeTarget(loadTarget('civ7',{portRoot:path.join(root,'port')}),staged);
    await fs.writeFile(path.join(staged,'connection.json'),JSON.stringify({port:1,addresses:{
      platform:2,scratch:0x30000000,sdk:0x10000000,main:0x20000000,session:'offline-import-test',target:'civ7'}}));
    // inspect-mounts generates this file on hardware before any mount helper runs.
    await fs.writeFile(path.join(staged,'switch2/app/mounts.json'),JSON.stringify({session:'offline-import-test',mounts:[]}));
    const run=spawnSync(process.execPath,['-e',LOAD,staged],{env:{...process.env,NS2_TARGET:'civ7',
      NS2_PORT_ROOT:path.join(root,'port'),NS2_TARGET_ROOT:staged},encoding:'utf8',timeout:10000,windowsHide:true});
    if(run.error||run.status!==0)throw Error('Runtime package dependency check failed:\n'+(run.error?.message||run.stderr));
    return {verified:true};
  }finally{
    const resolved=path.resolve(staged),stat=await fs.lstat(resolved);
    if(path.dirname(resolved)!==tempParent||!path.basename(resolved).startsWith('izciv-runtime-check-')||
      !stat.isDirectory()||stat.isSymbolicLink())throw Error('Refusing to remove an unexpected runtime-check path');
    await fs.rm(resolved,{recursive:true,force:true});
  }
}
module.exports={validatePackage};
