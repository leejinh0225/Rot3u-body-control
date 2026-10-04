import test from 'node:test';
import assert from 'node:assert/strict';
import {SerialLink} from '../body-control/serial-link.mjs';
import {idleState,FIRMWARE} from '../viewer/protocol.mjs';
import {CAPABILITY,SPEED_CAPABILITY,RESPONSIVE_CAPABILITY} from '../body-control/hardware-plan.mjs';
const pause=()=>new Promise(r=>setImmediate(r));
function harness(){
  let incoming;const sent=[],faults=[],link=new SerialLink(()=>{},e=>faults.push(e.message));
  link.port={readable:new ReadableStream({start(c){incoming=c;}})};
  link.writer={write(bytes){sent.push(new TextDecoder().decode(bytes));return Promise.resolve();}};
  const task=link.readLoop(link.epoch);
  return {link,sent,faults,send(text){incoming.enqueue(new TextEncoder().encode(text));},async done(){link.epoch++;incoming.close();await task;}};
}
function frame(s=idleState()){
  return ['STATE4',+s.ready,s.mask,s.min,s.max,s.watchdog,+s.outputKnown,...s.applied,...s.target,...s.map,...s.lower,...s.upper].join(' ')+'\n';
}
test('split serial frames verify version/capability and parse actual command state',async()=>{
  const h=harness();
  h.send('HELLO '+FIRMWARE+'\n'+CAPABILITY.slice(0,8));await pause();
  assert.equal(h.link.capable,false);
  h.send(CAPABILITY.slice(8)+'\n'+frame());await pause();
  assert.equal(h.link.capable,true);assert.equal(h.link.firmware,FIRMWARE);assert.equal(h.link.fresh(),true);
  const pending=h.link.command('PING',line=>line==='PONG');h.send('PO');await pause();
  h.send('NG\n');assert.equal(await pending,'PONG');assert.deepEqual(h.sent,['PING\n']);
  await h.done();
});
test('only one command can be in flight; immediate OFF cancels it without a latent timeout',async()=>{
  const h=harness(),first=h.link.command('MOVE 31 1500 1500 1500 1500 1500 1500');
  await assert.rejects(h.link.command('PING'),/이전 명령/);
  const cancelled=assert.rejects(first,/취소/);await h.link.emergency();await cancelled;
  assert.equal(h.sent.length,2);assert.equal(h.sent[1],'!\n');assert.equal(h.link.pending,null);
  h.send('OK MOVE\nOFF EMERGENCY\n'+frame());await pause();
  assert.equal(h.link.faulted,false);await h.done();
});
test('stream timeout and device fault latch instead of resuming on later healthy frames',async()=>{
  for(const line of ['FROZEN STREAM_TIMEOUT','OFF TIMEOUT','FAULT PCA_MOVE_FAILED']){
    const h=harness();h.send(frame()+line+'\n');await pause();
    assert.equal(h.link.faulted,true);assert.deepEqual(h.faults,[line]);
    h.send(frame());await pause();assert.equal(h.link.fresh(),false);
    await assert.rejects(h.link.command('PING'),/USB/);await h.done();
  }
});
test('missing acknowledgement faults the link instead of building a command queue',async()=>{
  const h=harness();await assert.rejects(h.link.command('PING'),/시간 초과/);
  assert.equal(h.link.faulted,true);assert.equal(h.sent.length,1);await h.done();
});
test('stale or corrupt status cannot keep hardware enabled',async()=>{
  const h=harness();h.send(frame());await pause();
  h.link.lastStateAt=performance.now()-800;assert.equal(h.link.fresh(),false);
  h.send('STATE4 1 garbage\n');await pause();assert.equal(h.link.fresh(),false);await h.done();
});

test('fast rate is negotiated only while OFF and only an exact speed ACK enables it',async()=>{
  const h=harness();h.send(SPEED_CAPABILITY+'\n'+frame());await pause();
  const configured=h.link.configureBodySpeed();
  assert.deepEqual(h.sent,['SPEED 1000\n']);assert.equal(h.link.bodyRate,100);
  h.send('OK SPEED 100\n');await pause();assert.equal(h.link.bodyRate,100);assert.ok(h.link.pending);
  h.send('OK SPEED 1000\n');await configured;assert.equal(h.link.bodyRate,1000);
  h.send(frame({...idleState(),mask:31}));await pause();
  await assert.rejects(h.link.configureBodySpeed(),/출력 OFF/);
  assert.equal(h.sent.length,1);await h.done();
});

test('old stream firmware remains compatible without sending an unsupported SPEED command',async()=>{
  const h=harness();h.send(CAPABILITY+'\n'+frame());await pause();
  await h.link.configureBodySpeed();assert.equal(h.link.bodyRate,100);assert.deepEqual(h.sent,[]);await h.done();
});

test('V3 alone negotiates the 20 percent increase; a V2 ACK cannot approve it',async()=>{
  const h=harness();h.send(RESPONSIVE_CAPABILITY+'\n'+frame());await pause();
  const configured=h.link.configureBodySpeed();assert.deepEqual(h.sent,['SPEED 1200\n']);
  h.send('OK SPEED 1000\n');await pause();assert.equal(h.link.bodyRate,100);assert.ok(h.link.pending);
  h.send('OK SPEED 1200\n');await configured;assert.equal(h.link.bodyRate,1200);await h.done();
});

test('rejected speed configuration cannot silently enable fast streaming',async()=>{
  const h=harness();h.send(SPEED_CAPABILITY+'\n'+frame());await pause();
  const configured=h.link.configureBodySpeed();
  h.send('ERR SPEED_REQUIRES_OFF_100_1000_MULTIPLE_50\n');
  await assert.rejects(configured,/SPEED_REQUIRES_OFF/);assert.equal(h.link.bodyRate,100);
  assert.equal(h.link.faulted,true);await h.done();
});
