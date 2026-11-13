const fs=require('node:fs/promises');
const path=require('node:path');
async function requestStop(root=__dirname){
  const reports=path.join(root,'reports');
  const entries=await fs.readdir(reports,{withFileTypes:true});
  const runs=entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&/^run-\d{8}T\d{9}Z$/.test(e.name))
    .map(e=>e.name).sort().reverse();
  for(const name of runs){
    let directory=path.join(reports,name),valid=true;
    for(const part of ['engine','switch2']){
      directory=path.join(directory,part);
      const stat=await fs.lstat(directory).catch(()=>null);
      if(!stat||!stat.isDirectory()||stat.isSymbolicLink()){valid=false;break;}
    }
    if(!valid)continue;
    let report;
    try{report=JSON.parse(await fs.readFile(path.join(directory,'fs-check.json'),'utf8'));}
    catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    if(report?.completed)continue;
    await fs.writeFile(path.join(directory,'STOP_FS_CHECK'),'Stop at the next checkpoint and restore owned state.\n');
    console.log('Stop requested. Keep the main checker open while it reaches a checkpoint and cleans up.');
    return true;
  }
  console.log('No unfinished filesystem run was found.');return false;
}
if(require.main===module)requestStop().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={requestStop};
