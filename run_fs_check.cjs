#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
const fs=require('node:fs/promises');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {StringDecoder}=require('node:string_decoder');
const ROOT=__dirname, COMMIT='6466918d6346aa0b5965fa0d44729235c4d94b14';
const VERSION='0.7.0', MAX_LOG=2*1024*1024;
const {Connection,parseHello,HELLO_BYTES}=require('./port/engine/lib/connection.cjs');
const {NativeClient}=require('./port/engine/lib/native.cjs');
const {qualify}=require('./port/engine/lib/qualify.cjs');
const {serve}=require('./port/engine/lib/bridge.cjs');
const {loadTarget,assertAppSupported,materializeTarget}=require('./port/engine/shared/target.cjs');

function localIPv4(value) {
  if(!net.isIPv4(value))throw Error('Use the console numeric private IPv4 address');
  const [a,b]=value.split('.').map(Number);
  if(!(a===10 || a===192&&b===168 || a===172&&b>=16&&b<=31 || a===169&&b===254 || a===127))
    throw Error('Use the console private LAN address');
  return value;
}
function options(args) {
  const o={host:'192.168.77.2',buildOnly:false};
  while(args.length) {
    const a=args.shift();
    if(a==='--build-only'&&!o.buildOnly)o.buildOnly=true;
    else if(a==='--host'&&args.length)o.host=localIPv4(args.shift());
    else throw Error('Usage: node run_fs_check.cjs [--host 192.168.77.2] [--build-only]');
  }
  return o;
}
async function buildPayload(host,root=ROOT) {
  localIPv4(host);
  const profile=JSON.parse(await fs.readFile(path.join(root,'reference-profile.json'),'utf8'));
  if(profile.schemaVersion!==1 || profile.upstream?.commit!==COMMIT || profile.requestedFirmware!=='20.4.0')
    throw Error('Wrong SDK reference revision or requested firmware');
  const template=await fs.readFile(path.join(root,'probe-template.js'),'utf8');
  if(template.split('__REFERENCE_PROFILE__').length!==2)throw Error('Incomplete SDK probe template');
  const sdk=template.replace('__REFERENCE_PROFILE__',JSON.stringify(profile));
  const bridgeTemplate=await fs.readFile(path.join(root,'engine-bridge-template.js'),'utf8');
  if(bridgeTemplate.split('__CONSOLE_HOST__').length!==2)throw Error('Incomplete bridge template');
  const bridge=bridgeTemplate.replace('__CONSOLE_HOST__',host).trim().replace(/;$/,'');
  const payload=Buffer.from(`(async function(){const result=await ${sdk};\n`+
    `if(result.status!=='SDK_FINGERPRINT_MATCH'||result.applicationSdkMatch!==true)return result;\n`+
    `return await ${bridge};})()`);
  if(payload.length>500*1024)throw Error('Payload exceeds the existing loader size limit');
  return payload;
}

// The loader needs EOF to delimit the source. Its read direction remains open
// for logs; binary RPC uses a second, temporary console connection on TCP 9027.
class LoaderChannel {
  constructor(socket,onLine=()=>{}) {
    this.socket=socket;this.log='';this.tail='';this.bytes=0;
    this.decoder=new StringDecoder('utf8');this.waiters=[];this.onLine=onLine;
    this.closed=new Promise(resolve=>{this.resolveClosed=resolve;});
    socket.on('data',b=>this.consume(b));
    socket.on('error',e=>this.fail(e));
    socket.on('end',()=>{
      this.tail+=this.decoder.end();if(this.tail)this.line(this.tail);this.tail='';
      this.fail(Error('Loader log stream ended'));
    });
    socket.on('close',()=>{this.resolveClosed();this.fail(Error('Loader connection closed'));});
  }
  consume(b) {
    this.bytes+=b.length;
    if(this.bytes>MAX_LOG){this.fail(Error('Loader log exceeds 2 MiB'));this.socket.destroy();return;}
    const s=this.decoder.write(b);this.log+=s;this.tail+=s;
    let i;while((i=this.tail.indexOf('\n'))>=0){const l=this.tail.slice(0,i).replace(/\r$/,'');this.tail=this.tail.slice(i+1);this.line(l);}
  }
  line(line) {
    try {
      if(line.startsWith('IZ20_REPORT ')) {
        this.sdk=JSON.parse(line.slice(12));
        if(this.sdk.tool!=='izcivswitch-sdk-check'||this.sdk.upstreamCommit!==COMMIT)
          throw Error('Unexpected SDK report');
      }
      if(line==='IZ20_ENGINE_READY') {
        if(this.sdk?.status!=='SDK_FINGERPRINT_MATCH'||this.sdk?.applicationSdkMatch!==true)
          throw Error('Bridge became ready without a passing SDK preflight');
        this.ready=true;
      }
      const marker='IZ20_ENGINE_BRIDGE_REPORT ';
      if(line.startsWith(marker)) {
        this.bridgeReport=JSON.parse(line.slice(marker.length));
        if(this.bridgeReport.tool!=='izcivswitch-engine-bridge'||this.bridgeReport.checkerVersion!==VERSION ||
          this.bridgeReport.requestedFirmware!=='20.4.0')throw Error('Unexpected bridge cleanup report');
      }
      this.onLine(line);
      for(const waiter of [...this.waiters])if(waiter.test())waiter.finish();
    } catch(e) {this.fail(e);}
  }
  fail(error) {
    this.error||=error;
    for(const w of [...this.waiters])w.finish(this.error);
  }
  wait(test,timeout,label) {
    if(test())return Promise.resolve();
    if(this.error)return Promise.reject(this.error);
    return new Promise((resolve,reject)=>{
      const w={test,finish:e=>{clearTimeout(w.timer);this.waiters=this.waiters.filter(x=>x!==w);e?reject(e):resolve();}};
      w.timer=setTimeout(()=>w.finish(Error(label+' timed out; restart the console')),timeout);
      this.waiters.push(w);
    });
  }
}
async function connectSocket(host,port,timeout=10000) {
  return new Promise((resolve,reject)=>{
    const s=net.createConnection({host,port,allowHalfOpen:true});
    const timer=setTimeout(()=>s.destroy(Error('Connection timed out')),timeout);
    const fail=e=>{clearTimeout(timer);reject(e);};
    s.once('error',fail);
    s.once('connect',()=>{clearTimeout(timer);s.removeListener('error',fail);resolve(s);});
  });
}
async function startLoader(host,payload,onLine) {
  const socket=await connectSocket(host,9026);
  const channel=new LoaderChannel(socket,onLine);
  socket.end(payload); // half-close PC->console; keep console->PC logs open
  return channel;
}
// Only allowlisted NS2_* variables reach the child checker; any other NS2_ name is stripped.
function childEnvironment(source,directory,root=ROOT) {
  const env={...source,NS2_TARGET:'civ7',NS2_PORT_ROOT:path.join(root,'port'),NS2_TARGET_ROOT:directory};
  for(const k of Object.keys(env))if(k.startsWith('NS2_')&&!['NS2_TARGET','NS2_PORT_ROOT','NS2_TARGET_ROOT','NS2_DIAG_TRIGGER_EARLY','NS2_DIAG_TRIGGER_SOURCE','NS2_DIAG_SESSION_LAYOUT','NS2_DIAG_STOP_AT_SCRATCH','NS2_DIAG_FILLER_ROLES'].includes(k))delete env[k];
  return env;
}
async function runChild(directory,append) {
  const env=childEnvironment(process.env,directory);
  const child=spawn(process.execPath,[path.join(directory,'switch2/fs-check.cjs')],
    {cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},1020000);
    child.stdout.on('data',b=>{append(b.toString());process.stdout.write(b);});
    child.stderr.on('data',b=>{append(b.toString());process.stderr.write(b);});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',(code,signal)=>{clearTimeout(timer);timedOut?reject(Error('Engine deadline expired; restart the console')):resolve({code,signal});});
  });
}
function passed(result) {
  return result.sdk?.status==='SDK_FINGERPRINT_MATCH' && result.sdk.applicationSdkMatch===true &&
    result.bootstrap?.verified===true && result.bootstrap?.scratchRestored===true &&
    result.fs?.verified===true && result.fs.cleanedUp===true && result.fs.backup?.complete===true &&
    result.fs.proof?.readWriteRestoreVerified===true &&
    result.bridge?.terminated===true && result.bridge.cleanupComplete===true &&
    !result.cleanupErrors?.length && !result.error;
}
async function main(args=process.argv.slice(2)) {
  const o=options([...args]);
  const target=assertAppSupported(loadTarget('civ7'));
  await require('./validate-package.cjs').validatePackage(ROOT);
  const payload=await buildPayload(o.host);
  if(o.buildOnly){console.log('Filesystem checker '+VERSION+' builds: '+payload.length+' bytes. No connection opened.');return 0;}
  console.log('Filesystem checker '+VERSION+': Switch 2 firmware target 20.4.0.');
  console.log('This backs up the save, then attempts FS memory access and restoration. It can freeze the game.');
  console.log('It uses the existing loader on 9026 and a temporary console RPC listener on 9027.');
  console.log('The run creates and removes dedicated Civ7 save scratch files. Keep the backup. No firmware update or firewall change is made.');
  const stamp=new Date().toISOString().replace(/[-:.]/g,'');
  const reports=path.join(ROOT,'reports');await fs.mkdir(reports,{recursive:true});
  const directory=path.join(reports,'run-'+stamp,'engine');await fs.mkdir(directory,{recursive:true});
  await fs.cp(path.join(ROOT,'port/engine/shared'),path.join(directory,'shared'),{recursive:true});
  await fs.cp(path.join(ROOT,'port/engine/switch2'),path.join(directory,'switch2'),{recursive:true});
  await materializeTarget(target,directory);
  const result={schemaVersion:1,tool:'izcivswitch-fs-check',checkerVersion:VERSION,requestedFirmware:'20.4.0',
    firmwareEvidence:'user-reported; not detected by this check',upstreamCommit:COMMIT,
    startedUtc:new Date().toISOString(),consoleHost:o.host,consolePort:9026,rpcPort:9027,
    verified:false,fullFilesystemSupport:'UNVERIFIED',filesystemAcquisition:'NOT_STARTED',saveChanges:'DEDICATED_SCRATCH_FILES_AFTER_VERIFIED_BACKUP'};
  let loader,native,bridge,rpcConnection,childLog='';
  try {
    loader=await startLoader(o.host,payload,line=>{if(!line.startsWith('IZ20_'))console.log(line);});
    await loader.wait(()=>loader.ready||!!loader.bridgeReport||loader.sdk&&loader.sdk.status!=='SDK_FINGERPRINT_MATCH',
      120000,'SDK preflight and temporary console listener');
    result.sdk=loader.sdk;
    if(!loader.ready)throw Error(loader.sdk?.message||'Console bridge did not become ready');
    const socket=await connectSocket(o.host,9027);
    const connection=rpcConnection=new Connection(socket,120000);
    const addresses=parseHello(await connection.read(HELLO_BYTES),target);
    native=new NativeClient(connection,addresses,target);
    result.bootstrap=await qualify(native);
    bridge=await serve(native);
    await fs.writeFile(path.join(directory,'connection.json'),JSON.stringify({port:bridge.port,
      addresses:{...addresses,session:path.basename(path.dirname(directory)),target:'civ7'}})+'\n');
    const outcome=await runChild(directory,s=>{childLog+=s;});
    result.fs=JSON.parse(await fs.readFile(path.join(directory,'switch2/fs-check.json'),'utf8'));
    result.filesystemAcquisition=result.fs.attempted?'ATTEMPTED':'NOT_ATTEMPTED';
    result.saveChanges=result.fs.acquisition?.scratchWritesStarted?'DEDICATED_SCRATCH_FILES_ATTEMPTED':'NOT_ATTEMPTED';
    if(outcome.code!==0||!result.fs.verified||!result.fs.cleanedUp)
      throw Error(result.fs.error?.split('\n')[0]||'Filesystem memory and restoration did not pass');
  } catch(e) {result.error=e.stack;}
  finally {
    result.cleanupErrors=[];
    if(bridge)try{await bridge.close();}catch(e){result.cleanupErrors.push('bridge close: '+e.message);}
    if(native)try{await native.stop();}catch(e){result.cleanupErrors.push('native stop: '+e.message);}
    else if(rpcConnection)rpcConnection.close();
    if(loader) {
      try{await loader.wait(()=>!!loader.bridgeReport,10000,'Console bridge cleanup');}
      catch(e){result.cleanupErrors.push('loader bridge report: '+e.message);}
      result.sdk=loader.sdk;result.bridge=loader.bridgeReport;
      loader.socket.destroy();
    }
    result.verified=passed(result);
    result.status=result.verified?'FS_MEMORY_CHECK_PASSED':'FS_MEMORY_CHECK_INCOMPLETE';
    result.requiresRestart=!result.verified;
    result.finishedUtc=new Date().toISOString();
    const reportPath=path.join(reports,'fs-check-'+stamp+'.json');
    await fs.writeFile(reportPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    await fs.writeFile(reportPath.replace(/\.json$/,'.log'),(loader?.log||'')+'\n--- PC engine ---\n'+childLog);
    console.log('\nResult: '+result.status+'\nReport: '+reportPath);
    if(result.requiresRestart)console.log('Restart the console before another check. Keep both report files.');
    console.log('Full filesystem support remains unverified.');
  }
  return result.verified?0:2;
}
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={main,options,localIPv4,buildPayload,LoaderChannel,passed,connectSocket,childEnvironment,runChild};
