import test from 'node:test';
import assert from 'node:assert/strict';
import {parseState, armCommand, holdCommand, setCommand, mapCommand, limitCommand, idleState, activeChannels} from '../viewer/protocol.mjs';
const off = idleState();
const line = (mask=0) => `STATE4 1 ${mask} 500 2500 2000 1 ${Array(12).fill(1500).join(' ')} 0 1 2 3 4 5 ${Array(6).fill(1000).join(' ')} ${Array(6).fill(2000).join(' ')}`;
test('strict device protocol: reject incompatible limits and corrupt telemetry', () => {
  assert.deepEqual(parseState(line()),off);
  assert.deepEqual(activeChannels(parseState(line(63))),[0,1,2,3,4,5]);
  assert.deepEqual(activeChannels(parseState(line(31))),[0,1,2,3,4]);
  for (const corrupt of [line(64),line(-1),line(2).replace('STATE4 1','STATE4 0'),line().replace('500 ','499 '),
    line().replace('2500','2501'),line().replace('2000 1','2000 0'),line().replace('1500','1500x'),
    line().replace('1500','2600'),line()+' extra',line().replace('STATE4','STATE3')])
    assert.equal(parseState(corrupt),null,corrupt);
});
test('arming requires explicit acknowledgement, healthy idle state and valid channel', () => {
  assert.equal(armCommand(5,off,true),'ARM 5 1500');
  assert.throws(() => armCommand(5,off,false));
  assert.throws(() => armCommand(5,{...off,ready:false},true));
  assert.throws(() => armCommand(5,{...off,mask:1},true));
  assert.throws(() => armCommand(5,{...off,outputKnown:false},true));
  for (const ch of [-1,6,0.5,NaN]) assert.throws(() => armCommand(ch,off,true));
});
test('movement obeys expanded joint limits and never targets inactive channels', () => {
  const on = {...off,mask:32};
  assert.equal(setCommand(5,1000,on),'SET 5 1000');
  assert.equal(setCommand(5,2000,on),'SET 5 2000');
  for (const us of [999,2001,Infinity,NaN,1500.5]) assert.throws(() => setCommand(5,us,on));
  assert.throws(() => setCommand(4,1500,on));
  assert.throws(() => setCommand(5,1500,off));
});
test('a failed I2C stop remains unknown, never a confirmed stopped state', () => {
  const unknown = parseState(line().replace('STATE4 1','STATE4 0').replace('2000 1','2000 0'));
  assert.equal(unknown.outputKnown,false);
  assert.equal(unknown.ready,false);
  assert.throws(() => armCommand(5,unknown,true));
});
test('group holding requires idle acknowledgement and supports only explicit 5/6 groups', () => {
  assert.equal(holdCommand(31,off,true),'HOLD 31');
  assert.equal(holdCommand(63,off,true),'HOLD 63');
  for (const mask of [0,1,32,64,255,31.5]) assert.throws(()=>holdCommand(mask,off,true));
  assert.throws(()=>holdCommand(63,off,false));
  assert.throws(()=>holdCommand(63,{...off,mask:31},true));
  assert.throws(()=>setCommand(5,1505,{...off,mask:31}));
  assert.equal(setCommand(4,1505,{...off,mask:31}),'SET 4 1505');
});
test('saved pose validates all six entries before generating an activation command', () => {
  assert.equal(holdCommand(31,off,true,[1500,1505,1510,1495,1485,1500]),'POSE 31 1500 1505 1510 1495 1485 1500');
  for (const pose of [[1500],Array(6).fill(2001),[1500,1500,1500,1500,1500,NaN]])
    assert.throws(()=>holdCommand(31,off,true,pose));
});
test('remapping requires OFF, explicit PSU confirmation and an unused physical port', () => {
  assert.equal(mapCommand(5,6,off,true),'MAP 5 6');
  assert.equal(mapCommand(5,15,off,true),'MAP 5 15');
  assert.throws(()=>mapCommand(5,4,off,true));
  assert.throws(()=>mapCommand(5,6,off,false));
  assert.throws(()=>mapCommand(5,6,{...off,mask:1},true));
  for(const p of [-1,16,1.5,NaN]) assert.throws(()=>mapCommand(5,p,off,true));
  const mapped = parseState(line(63).replace('0 1 2 3 4 5','0 1 2 3 4 15'));
  assert.equal(mapped.map[5],15);
  assert.equal(setCommand(5,1505,mapped),'SET 5 1505');
  assert.equal(parseState(line().replace('0 1 2 3 4 5','0 1 2 3 4 4')),null);
  assert.equal(parseState(line().replace('0 1 2 3 4 5','0 1 2 3 4 16')),null);
});
test('limit configuration is OFF-only, centered and independently applied per joint', () => {
  assert.equal(limitCommand(5,500,2500,off),'LIMIT 5 500 2500');
  for (const [ch,lo,hi] of [[6,500,2500],[5,499,2500],[5,500,2501],[5,1501,2000],[5,1000,1499],[5,1500,1500],[5,NaN,2000]])
    assert.throws(()=>limitCommand(ch,lo,hi,off));
  assert.throws(()=>limitCommand(5,500,2500,{...off,mask:1}));
  const wide=idleState(); wide.lower[5]=500; wide.upper[5]=2500;
  assert.equal(setCommand(5,2450,{...wide,mask:32}),'SET 5 2450');
  assert.throws(()=>setCommand(4,2450,{...wide,mask:63}));
  assert.throws(()=>holdCommand(63,off,true,[1500,1500,1500,1500,1500,2450]));
  assert.equal(holdCommand(63,wide,true,[1500,1500,1500,1500,1500,2450]),'POSE 63 1500 1500 1500 1500 1500 2450');
});
test('telemetry rejects active targets outside joint limits, but permits old OFF values after narrowing', () => {
  assert.equal(parseState(line(1).replace('1500','2100')),null);
  assert.equal(parseState(line(0).replace('1500','2100')).applied[0],2100);
  assert.equal(parseState(line().replace('1000','1501')),null);
  assert.equal(parseState(line().replace('1000','499')),null);
});
