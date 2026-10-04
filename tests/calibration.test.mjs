import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyProfile,validateProfile,recordZero,zeroPose} from '../viewer/calibration.mjs';
import {idleState} from '../viewer/protocol.mjs';
test('record only the selected settled command without changing the device or other zeros', () => {
  const state = {...idleState(),mask:31}; state.applied[1] = state.target[1] = 1515;
  const oldState = structuredClone(state), profile = emptyProfile();
  const result = recordZero(profile,1,state,false,'링크 수직, + 앞으로');
  assert.deepEqual(state,oldState);
  assert.equal(profile.channels[1].recorded,false);
  assert.equal(result.channels[1].zeroUs,1515);
  assert.equal(result.channels[0].recorded,false);
  assert.throws(()=>recordZero(profile,5,state,false,''));
  state.target[1] = 1520;
  assert.throws(()=>recordZero(profile,1,state,false,''));
});
test('incomplete zeros cannot activate a group; excluded CH5 need not be recorded', () => {
  let p = emptyProfile(); const state = {...idleState(),mask:31};
  assert.throws(()=>zeroPose(p,31,false));
  for(let ch=0;ch<5;ch++) p = recordZero(p,ch,state,false,'');
  assert.deepEqual(zeroPose(p,31,false),Array(6).fill(1500));
  assert.throws(()=>zeroPose(p,63,false));
  assert.deepEqual(validateProfile(JSON.parse(JSON.stringify(p))),p);
});
test('demo zeros never pass as real hardware calibration', () => {
  let p = {...emptyProfile(),source:'demo'}; const state = {...idleState(),mask:63};
  for(let ch=0;ch<6;ch++) p = recordZero(p,ch,state,true,'');
  assert.throws(()=>zeroPose(p,63,false));
  assert.deepEqual(zeroPose(p,63,true),Array(6).fill(1500));
  assert.throws(()=>recordZero(p,0,state,false,''));
});
test('import rejects wrong units, unsafe widths, swapped mapping and corrupt records', () => {
  for(const mutate of [p=>p.units='deg',p=>p.channels[0].zeroUs=499,p=>p.channels[0].ch=1,
    p=>p.channels[0].recorded='yes',p=>p.channels[1].zeroUs=1510,p=>p.channels.pop(),p=>p.pcaChannels[5]=4]) {
    const p=emptyProfile(); mutate(p); assert.throws(()=>validateProfile(p));
  }
});
test('remapping preserves logical zero and stores the physical map as context', () => {
  const state={...idleState(),mask:32,map:[0,1,2,3,4,6]};
  state.applied[5]=state.target[5]=1495;
  const p=recordZero(emptyProfile(),5,state,false,'그리퍼, PCA6 시험');
  assert.equal(p.channels[5].zeroUs,1495);
  assert.equal(p.pcaChannels[5],6);
  assert.equal(p.channels[0].recorded,false);
});
