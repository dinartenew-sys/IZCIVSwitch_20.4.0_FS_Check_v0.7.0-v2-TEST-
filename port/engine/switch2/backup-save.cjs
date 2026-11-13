// SPDX-License-Identifier: GPL-2.0-only
// Copy the mounted save into flat PC files; issue only read operations to it.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const check=(ok,message)=>{if(!ok)throw Error(message);};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');

async function backupSave({session:s,filesystem,handle,directory,sessionId,maxBytes=256*1024*1024}) {
  await fs.mkdir(directory,{recursive:false});
  const manifest={schemaVersion:1,kind:'civ7-mounted-save-backup',session:sessionId,
    started:new Date().toISOString(),complete:false,totalBytes:0,entries:[]};
  async function save(){
    const p=path.join(directory,'manifest.json');
    await fs.writeFile(p,JSON.stringify(manifest,null,2)+'\n');
    const f=await fs.open(p,'r+');try{await f.sync();}finally{await f.close();}
  }
  await save();
  async function readHash(fileHandle,size,consume) {
    const digest=crypto.createHash('sha256');
    for(let offset=0;offset<size;offset+=0x20000) {
      const count=Math.min(0x20000,size-offset);
      const b=await filesystem.readFile(s,fileHandle,offset,count);
      check(Buffer.isBuffer(b)&&b.length===count,'Backup read was truncated');
      digest.update(b);if(consume)await consume(b);
    }
    return digest.digest('hex');
  }
  async function visit(parent,depth) {
    check(depth<=32,'Save directory exceeds the backup depth bound');
    const children=await filesystem.listDirectory(s,handle,parent,4096);
    const names=new Set();
    for(const item of children) {
      check(typeof item.name==='string'&&item.name&&!/[\\/\0]/.test(item.name)&&
        !['.','..'].includes(item.name)&&!names.has(item.name),'Invalid or duplicate save entry');
      names.add(item.name);
      check(manifest.entries.length<10000,'Save exceeds the backup entry bound');
      const name=(parent==='/'?'':parent)+'/'+item.name;
      const row={path:name,type:item.type,size:String(item.size)};
      manifest.entries.push(row);
      if(item.type===0){await visit(name,depth+1);continue;}
      check(item.type===1,'Unknown save entry type');
      const size=Number(item.size);
      check(Number.isSafeInteger(size)&&size>=0&&manifest.totalBytes+size<=maxBytes,
        'Save exceeds the 256 MiB backup bound; no filesystem attempt will run');
      const opened=await filesystem.openFile(s,handle,name);
      check(!opened.result&&opened.handle,'Could not open a save file for backup');
      const filename=String(manifest.entries.length).padStart(5,'0')+'.bin';
      const target=path.join(directory,filename);
      let output;
      try {
        check(await filesystem.fileSize(s,opened.handle)===BigInt(size),'Save file size changed before backup');
        output=await fs.open(target,'wx');
        row.sha256=await readHash(opened.handle,size,async b=>{
          for(let at=0;at<b.length;){const r=await output.write(b,at,b.length-at,null);
            check(r.bytesWritten>0,'PC backup write made no progress');at+=r.bytesWritten;}
        });
        await output.sync();await output.close();output=null;
        check(hash(await fs.readFile(target))===row.sha256,'Saved PC backup checksum differs');
        check(await filesystem.fileSize(s,opened.handle)===BigInt(size),'Save file size changed during backup');
        check(await readHash(opened.handle,size)===row.sha256,'Save file changed during backup verification');
        row.localFile=filename;row.verified=true;row.consoleReadPasses=2;
        manifest.totalBytes+=size;
      } finally {if(output)await output.close();await s.close(opened.handle);}
      await save();
    }
  }
  try {
    await visit('/',0);
    check(manifest.entries.some(e=>e.type===1),'The mounted save has no files to back up');
    manifest.complete=true;manifest.completed=new Date().toISOString();await save();
    return {...manifest,directory,manifest:path.join(directory,'manifest.json')};
  } catch(e) {manifest.error=e.message;await save();throw e;}
}
module.exports={backupSave};
