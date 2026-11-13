const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../port/engine/switch2/memory/probe-reserved-gap.cjs'),'utf8');

// The pinning check (abortControl.pinWindowOk) needs the canary to start before
// the pin and to stay pending past it. A 2.2 ms canary against a 2.0 ms pin
// failed on all 30 retries of the 2026-11-13 hardware run.
test('canary worker starts before the pin release in the wave schedule',()=>{
  const roles=source.match(/const roles = \[([^\]]+)\]/);
  const delays=source.match(/const delays = \(\[([^\]]+)\]\)/);
  const pin=source.match(/role === 'release'\) steps\.push\(sleep\((\d+)\)\)/);
  assert.ok(roles&&delays&&pin,'wave schedule not found');
  const roleList=roles[1].split(',').map(v=>v.trim().replace(/'/g,''));
  const delayList=delays[1].split(',').map(v=>Number(v.trim()));
  const canary=delayList[roleList.indexOf('canary')];
  const pinAt=Number(pin[1]);
  assert.equal(pinAt,2000000);
  assert.ok(Number.isFinite(canary),'canary delay missing');
  assert.ok(canary<pinAt,`canary ${canary} ns must start before pin ${pinAt} ns`);
});

// The wave reads beforeRelease.memory from the preRelease row. Without the
// release role sending it, the first wave throws a TypeError (2026-11-13 04:12 run).
test('release role sends clearReport and preRelease before the wave reads them',()=>{
  assert.ok(source.includes("if (role === 'release') steps.push(tick('clearStart'), send(clearReportBuffer, root, 'clearReport')"),
    'release clearReport send missing');
  assert.ok(source.includes("send(preReleaseBuffer, root, 'preRelease')"),'preRelease send missing');
  assert.ok(source.includes("rows.find(row => row.role === 'preRelease')"),'preRelease row read missing');
});

// The trigger must sample the spacing decision after the hole finishes, as in
// the original schedule. A fixed 4.5 ms sleep produced zero marker hits in the
// 2026-11-13 04:15 run (30 extent-present attempts, trigger never aborted).
test('trigger waits for group release, guard launch and hole completion before sampling',()=>{
  assert.ok(source.includes("else if (role === 'trigger') steps.push(sleep(2400000), wait(groupReleased), wait(guardLaunched), sleep(400000),"),
    'trigger wait schedule missing');
  assert.match(source,/copyWord\(spacingDecision, holeFinished, 'sampleMinimumSpacing'\),\r?\n\s+\.\.\.\(diagTriggerEarly \? \[\] : \[wait\(holeDone\)\]\)\);/,
    'trigger does not wait for holeDone by default');
  assert.ok(source.includes("const diagTriggerEarly = process.env.NS2_DIAG_TRIGGER_EARLY === '1';"),
    'diagnostic switch must default off');
  assert.ok(source.includes("if (role === 'hole') steps.push(setByte(holeFinished, 1, 'holeFinished'), signal(holeDone));"),
    'hole does not signal holeDone');
});
