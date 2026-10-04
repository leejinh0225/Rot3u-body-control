import test from 'node:test';
import assert from 'node:assert/strict';
import {FollowReadiness,inputWaitReason} from '../body-control/follow-readiness.mjs';
import {advanceMotion} from '../body-control/motion-path.mjs';
import {createHardware} from '../body-control/hardware.mjs';
import {collisionAt,collisionExplanation,VIRTUAL_GEOMETRY,DEFAULT_GEOMETRY,MINIMAL_HARDWARE_CLEARANCE,BASIC_HARDWARE_GEOMETRY,validateGeometry} from '../body-control/collision.mjs';
import {emptyProfile} from '../viewer/calibration.mjs';
import {idleState} from '../viewer/protocol.mjs';

const upright={yaw:0,leg:90,torso:90,arm:90};
const input=()=>({mode:'camera',valid:true,moving:true,pose:{...upright},legAssumed:true,torsoAssumed:false});
function stable(gate,source,start,duration=1800){
  let result;for(let t=start;t<=start+duration;t+=50)result=gate.observe(source,t);
  return result;
}
test('physical anchor requires 1.8 seconds of continuously stable finite camera input',()=>{
  const gate=new FollowReadiness(),source=input();
  assert.match(gate.observe(source,0).message,/1.8초/);
  assert.equal(stable(gate,source,50,1700).ready,false);
  assert.equal(gate.observe(source,1800).ready,true);
  source.pose.arm=NaN;
  assert.match(gate.observe(source,1850).message,/각도.*오류/);
  source.pose.arm=90;
  assert.equal(gate.observe(source,1900).ready,false);
});
test('motion, source changes and missing frames restart the anchor countdown visibly',()=>{
  const gate=new FollowReadiness(),source=input();stable(gate,source,0,1000);
  source.pose.arm=100;
  assert.match(gate.observe(source,1050).message,/움직임.*다시/);
  source.legAssumed=false;
  assert.match(gate.observe(source,1100).message,/인식 범위/);
  assert.equal(gate.observe(source,3000).ready,false);
  assert.equal(stable(gate,source,3050).ready,true);
});
test('each input block reports its cause; hidden, synthetic and paused input cannot anchor',()=>{
  assert.match(inputWaitReason(input(),true),/숨겨/);
  assert.match(inputWaitReason({...input(),mode:'demo'}),/합성/);
  assert.match(inputWaitReason({...input(),valid:false,reason:'손목 가림'}),/손목 가림/);
  assert.match(inputWaitReason({...input(),moving:false}),/따라하기/);
  assert.equal(inputWaitReason({...input(),virtualCollision:'링크끼리 간섭',blocked:true}),'');
});
test('a collision-stopped concept model does not erase filtered body movement',()=>{
  const target={yaw:0,leg:90,torso:97,arm:-80};
  assert.ok(collisionAt(target,VIRTUAL_GEOMETRY));
  let body={...upright},virtual={...upright},result;
  for(let i=0;i<300;i++){
    result=advanceMotion(body,virtual,target,.02);body=result.body;virtual=result.virtual;
    assert.equal(collisionAt(virtual,VIRTUAL_GEOMETRY),'');
  }
  assert.ok(result.virtualCollision);
  assert.ok(Math.abs(body.arm-target.arm)<.01);
  assert.ok(Math.abs(body.arm-virtual.arm)>5);
});

// Exercise the actual UI controller and scheduled pump without a browser,
// camera or serial port. Commands have explicit ACKs; no motors are connected.
async function harness(t,{arm=true,fast=true,rate=1000}={}){
  const elements=new Map(),fields=new Map(),timers=new Map(),sent=[];
  const element=(id,value='')=>{
    if(!elements.has(id))elements.set(id,{value,checked:false,disabled:false,files:[],dataset:{},textContent:'',innerHTML:'',addEventListener(){}});
    return elements.get(id);
  };
  for(let i=0;i<5;i++)for(const [key,value] of Object.entries({ch:i,sign:1,scale:11.111,gain:1,span:1000}))
    fields.set(key+':'+i,{value:String(value),disabled:false,addEventListener(){}});
  for(const [id,value] of Object.entries({'hw-l1':105,'hw-l2':100,'hw-l3':100,'hw-tool':40,
    'hw-base-height':110,'hw-base-radius':30,'hw-radius':30,'hw-margin':15,'hw-a1':90,'hw-a2':0,'hw-a3':0}))element(id).value=String(value);
  const saved=new Map();
  for(const [key,value] of Object.entries({
    document:{hidden:false,getElementById:element,querySelector(selector){
      const match=selector.match(/data-hw="(\w+)".*data-role="(\d+)"/);return fields.get(match[1]+':'+match[2]);
    },querySelectorAll(){return [...fields.values()];}},
    window:{addEventListener(){}},fetch:async()=>({ok:false}),localStorage:{getItem:()=>null}
  })){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  t.after(()=>{for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  let time=0,source=input(),link;
  const controller=createHardware(()=>source,{
    now:()=>time,every:(fn,ms)=>timers.set(ms,fn),
    createLink(onChange,onFault){
      link={writer:null,state:null,capable:true,faulted:false,pending:null,bodyRate:fast?rate:100,
        fresh(){return !!this.state&&!this.faulted;},
        async connect(){this.writer={};this.state=idleState();onChange();},
        async command(text,accept){
          sent.push(text);const [verb,mask,...pulses]=text.split(' ');let reply='OK '+verb;
          if(verb==='LIMIT'){
            assert.equal(this.state.mask,0);this.state.lower[Number(mask)]=Number(pulses[0]);this.state.upper[Number(mask)]=Number(pulses[1]);
          }
          if(verb==='PING')reply='PONG';
          if(verb==='FREEZE'){this.state.target=[...this.state.applied];reply='FROZEN USER';}
          if(verb==='POSE'){
            this.state.mask=Number(mask);this.state.applied=pulses.map(Number);this.state.target=[...this.state.applied];reply='OK ARM';
          }
          if(verb==='MOVE')this.state.target=pulses.map(Number);
          if(accept)assert.ok(accept(reply),'controller must match the device ACK');
          onChange();return reply;
        },
        async waitState(predicate){assert.ok(predicate(this.state));return this.state;},
        async emergency(){sent.push('!');this.state.mask=0;onChange();},
        fail(error){this.faulted=true;onFault(error);onChange();}
      };return link;
    }
  });
  const profile=emptyProfile();profile.channels.slice(0,5).forEach(c=>c.recorded=true);
  element('hw-profile-file').files=[{text:async()=>JSON.stringify(profile)}];
  await element('hw-profile-file').onchange();
  for(const id of ['hw-supported','hw-power-off','hw-direction-checked'])element(id).checked=true;
  await element('hw-connect').onclick();
  if(arm){
    await element('hw-arm').onclick();assert.equal(link.state.mask,31);
    await element('hw-follow').onclick();
  }
  const h={element,fields,link,sent,controller,
    get source(){return source;},set source(value){source=value;},
    async run(ms){for(let end=time+ms;time<end;){time+=10;await timers.get(10)();timers.get(150)();}},
    settle(){link.state.applied=[...link.state.target];},
    moves:()=>sent.filter(x=>x.startsWith('MOVE '))
  };return h;
}
test('first stationary camera pose commands absolute angles; a virtual collision flag does not block readiness',async t=>{
  const h=await harness(t);
  h.source={...input(),pose:{yaw:0,leg:90,torso:90,arm:60},virtualCollision:'링크끼리 간섭',blocked:true};
  await h.run(1000);assert.equal(h.moves().length,0);assert.match(h.element('hw-follow-detail').textContent,/기준 자세.*초/);
  await h.run(1100);assert.equal(h.element('hw-status').textContent,'첫 자세 맞추는 중');
  const move=h.moves().at(-1).split(' ').slice(2).map(Number);
  assert.equal(move[3],1400);
  assert.equal(move[4],1500);assert.equal(move[5],1500);assert.equal(h.link.state.mask,31);
  assert.match(h.element('hw-command-status').textContent,/수신 확인 [1-9]/);
  assert.match(h.element('hw-body-goal').textContent,/1167/);
  assert.match(h.element('hw-speed-status').textContent,/1,000/);
  const n=h.moves().length;await h.run(200);assert.equal(h.moves().length,n,'wait until previous target has settled');
  assert.match(h.element('hw-follow-detail').textContent,/속도 제한/);
  for(let i=0;i<5;i++){h.settle();await h.run(200);}
  assert.equal(h.link.state.applied[3],1167);
  assert.equal(h.element('hw-status').textContent,'실물 절대 추종 중');
});
test('large human movement converges through small bounded steps instead of stopping at the first 8us',async t=>{
  const h=await harness(t);await h.run(2100);h.source.pose.arm=120;
  // Settle simulated hardware, then allow the next request; never bypass
  // the production guard or pretend a queued command is already applied.
  for(let i=0;i<5;i++){await h.run(200);h.settle();}
  assert.equal(h.link.state.applied[3],1833);
  let previous=1500;
  for(const command of h.moves()){
    const pulse=Number(command.split(' ')[5]);
    assert.ok(Math.abs(pulse-previous)<=100);previous=pulse;
  }
  assert.equal(h.link.state.mask,31);
});
test('brief tracking loss freezes once and immediately returns to absolute coordinates; manual pause stays stopped',async t=>{
  const h=await harness(t);await h.run(2100);
  h.source.pose.arm=110;await h.run(200);h.settle();
  h.source.valid=false;h.source.reason='손목이 가려졌습니다.';
  const beforeLoss=h.sent.length;await h.run(200);
  assert.deepEqual(h.sent.slice(beforeLoss).filter(command=>command!=='PING'),['FREEZE']);
  assert.match(h.element('hw-follow-detail').textContent,/손목이 가려/);
  const count=h.moves().length;h.source.valid=true;h.source.pose.arm=30;
  await h.run(20);assert.equal(h.moves().length,count+1);
  assert.equal(h.link.state.target[3],h.link.state.applied[3]-100);
  assert.match(h.element('hw-body-goal').textContent,/833/);
  const beforePause=h.moves().length;
  h.controller.pause('수동 일시정지');await h.run(3000);
  assert.equal(h.moves().length,beforePause);
  assert.match(h.element('hw-follow-detail').textContent,/추종 해제.*수동/);
  assert.equal(h.element('hw-follow').disabled,false);
});

test('long loss requires stable recovery; briefly missing legs do not restart following',async t=>{
  const h=await harness(t);await h.run(2100);
  h.source.legAssumed=false;h.source.pose.arm=110;
  const n=h.moves().length;await h.run(20);assert.equal(h.moves().length,n+1);h.settle();
  h.source.valid=false;await h.run(900);const count=h.moves().length;
  h.source.valid=true;await h.run(1500);assert.equal(h.moves().length,count);
  await h.run(500);assert.ok(h.moves().length>count);
});

test('V3 uses a 120us checked segment, and sends the next immediately after the completion state',async t=>{
  const h=await harness(t,{rate:1200});h.source.pose.arm=60;await h.run(2100);
  assert.equal(h.link.state.target[3],1380);
  assert.match(h.element('hw-speed-status').textContent,/1,200.*20%/);
  const count=h.moves().length;h.settle();await h.run(10);
  assert.equal(h.moves().length,count+1);assert.equal(h.link.state.target[3],1260);
  assert.equal(h.link.state.target[4],1500);assert.equal(h.link.state.mask,31);
});

test('short loss during initial hardware readiness pauses the countdown instead of clearing it',()=>{
  const r=new FollowReadiness(),source=input();stable(r,source,0,1500);
  r.observe({...source,valid:false},1550);
  assert.equal(r.observe(source,1650).ready,false);
  assert.equal(stable(r,source,1700,250).ready,true);
});

test('old firmware retains the small step and displays the required speed upgrade',async t=>{
  const h=await harness(t,{fast:false});h.source.pose.arm=0;await h.run(2100);
  assert.equal(h.link.state.target[3],1492);
  assert.match(h.element('hw-body-goal').textContent,/500/);
  assert.match(h.element('hw-speed-status').textContent,/현재 펌웨어.*100µs.*업로드/);
});

test('horizontal first pose reaches the wrist absolute -90 degree goal with no gripper activation',async t=>{
  const h=await harness(t);h.source.pose.arm=0;await h.run(2100);
  for(let i=0;i<11;i++){h.settle();await h.run(200);}
  assert.equal(h.link.state.applied[3],500);
  assert.deepEqual(h.sent.filter(s=>s.startsWith('LIMIT ')),[0,1,2,3,4].map(ch=>'LIMIT '+ch+' 500 2500'));
  assert.ok(h.moves().every(s=>s.startsWith('MOVE 31 ')&&s.endsWith(' 1500 1500')));
  h.source.pose.arm=-20;await h.run(200);
  assert.match(h.element('hw-body-goal').textContent,/범위 제한: CH3 손목 굽힘/);
});
test('physical collision still latches a stop before MOVE and cannot auto-resume',async t=>{
  const h=await harness(t);await h.run(1900);
  // Even with minimal radii, a physically modeled path through the floor
  // must be rejected. Reinterpret the current pulses as a lowered arm.
  h.element('hw-a1').value='20';h.element('hw-a2').value='-140';h.element('hw-a3').value='-30';
  const n=h.moves().length;await h.run(500);
  assert.equal(h.moves().length,n);
  assert.match(h.element('hw-follow-detail').textContent,/실물 충돌 검사 차단/);
  h.element('hw-a1').value='90';h.element('hw-a2').value='0';h.element('hw-a3').value='0';await h.run(3000);
  assert.equal(h.moves().length,n);assert.equal(h.element('hw-follow').disabled,false);
});
test('camera-only, finite input and visibility checks prevent MOVE in the UI pump',async t=>{
  const h=await harness(t);
  for(const source of [{...input(),mode:'demo'},{...input(),moving:false},{...input(),pose:{...upright,arm:NaN}}]){
    h.source=source;await h.run(2200);assert.equal(h.moves().length,0);
  }
  h.source=input();document.hidden=true;await h.run(2200);assert.equal(h.moves().length,0);
  assert.match(h.element('hw-follow-detail').textContent,/숨겨/);
});
test('reported 70mm upright conflict clears with fixed minimal radii; floor and angle guards remain',()=>{
  const g={...DEFAULT_GEOMETRY,lengths:[.105,.1,.07],tool:.03,baseHeight:.11,baseRadius:.03,radius:.03,margin:.015};
  assert.match(collisionExplanation(upright,g),/팔꿈치→손목.*부착점→도구 끝.*70mm < 필요 75mm/);
  const minimal={...g,...MINIMAL_HARDWARE_CLEARANCE};
  assert.equal(collisionAt(upright,minimal),'');
  assert.match(collisionAt({yaw:0,leg:20,torso:-120,arm:-150},minimal),/바닥/);
  assert.match(collisionAt({...upright,yaw:91},minimal),/각도/);
});
test('arming diagnostics identify cm/mm mistakes and missing confirmations before sending PWM',async t=>{
  const h=await harness(t,{arm:false});h.element('hw-l3').value='3';await h.run(50);
  assert.equal(h.element('hw-arm').disabled,true);
  assert.match(h.element('hw-arm-reason').textContent,/손목→도구 부착점: 30~600mm.*현재 3/);
  await h.element('hw-arm').onclick();assert.equal(h.link.state.mask,0);
  h.element('hw-l3').value='70';h.element('hw-tool').value='0';h.element('hw-supported').checked=false;await h.run(50);
  assert.match(h.element('hw-arm-reason').textContent,/받침/);
  h.element('hw-supported').checked=true;await h.run(50);assert.equal(h.element('hw-arm').disabled,false);
  await h.element('hw-arm').onclick();assert.equal(h.link.state.mask,31);
  assert.match(h.element('hw-arm-reason').textContent,/이미 켜져/);
});
test('old configuration imports retain dimensions but normalize fixed collision clearance',async t=>{
  const h=await harness(t,{arm:false}),p=emptyProfile();p.channels.slice(0,5).forEach(c=>c.recorded=true);
  const config={schema:'rot3u-body-v1',zeroProfile:p,mapping:Array.from({length:5},(_,ch)=>({ch,sign:1,usPerDegree:11.111,gain:.3,span:150})),
    geometry:{...DEFAULT_GEOMETRY,lengths:[.105,.1,.07],tool:.03,baseHeight:.11,baseRadius:.03,radius:.03,margin:.015}};
  h.element('hw-import-config').files=[{text:async()=>JSON.stringify(config)}];await h.element('hw-import-config').onchange();
  assert.equal(Number(h.element('hw-radius').value),10);assert.equal(Number(h.element('hw-margin').value),10);
  assert.equal(h.element('hw-radius').readOnly,true);assert.equal(Number(h.element('hw-l3').value),70);
  await h.run(50);assert.equal(h.element('hw-arm').disabled,false);
  await h.element('hw-arm').onclick();assert.equal(h.link.state.mask,31);
});
test('rough preset starts without dimensions entry or measurement claims and supports no scoop',async t=>{
  const h=await harness(t,{arm:false});
  assert.deepEqual(['hw-l1','hw-l2','hw-l3','hw-tool','hw-base-height','hw-base-radius'].map(id=>Number(h.element(id).value)),[105,100,70,0,110,20]);
  assert.equal(collisionAt(upright,validateGeometry(BASIC_HARDWARE_GEOMETRY)),'');
  assert.equal(h.element('hw-arm').disabled,false);
  h.element('hw-l3').value='3';h.element('hw-tool').value='3';await h.run(50);assert.equal(h.element('hw-arm').disabled,true);
  h.element('hw-reference').onclick();await h.run(50);
  assert.equal(h.element('hw-arm').disabled,false);
  assert.equal(Number(h.element('hw-tool').value),0);
  assert.match(h.element('hw-message').textContent,/임시 기본값.*스쿱 없음/);
  await h.element('hw-arm').onclick();assert.equal(h.link.state.mask,31);
});
