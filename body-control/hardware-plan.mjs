import {validateProfile,zeroPose} from '../viewer/calibration.mjs';
import {collisionAt,validateGeometry,DEFAULT_GEOMETRY} from './collision.mjs?v=basic-preset-6';
export const CAPABILITY='CAPS BODY_STREAM_V1';
export const SPEED_CAPABILITY='CAPS BODY_SPEED_V2';
export const RESPONSIVE_CAPABILITY='CAPS BODY_SPEED_V3';
export const ROLES=['베이스 회전','어깨','팔꿈치','손목 굽힘','손목 회전 고정'];
export const defaultMapping=()=>Array.from({length:5},(_,ch)=>({ch,sign:1,usPerDegree:11.111,gain:1,span:1000}));
export function validateMapping(rows){
  if(!Array.isArray(rows)||rows.length!==5||new Set(rows.map(r=>r.ch)).size!==5||
    rows.some(r=>!Number.isInteger(r.ch)||r.ch<0||r.ch>4||![1,-1].includes(r.sign)||
    !Number.isFinite(r.usPerDegree)||r.usPerDegree<2||r.usPerDegree>25||
    !Number.isFinite(r.gain)||r.gain<.1||r.gain>1||!Number.isInteger(r.span)||r.span<20||r.span>1000))
    throw Error('CH0~4를 중복 없이 배정하고 방향·환산·배율·범위를 확인하십시오.');
  return structuredClone(rows);
}
export function jointPose(p){return [p.yaw,p.leg,p.torso-p.leg,p.arm-p.torso,0];}
export function checkSetup(profile,rows,state){
  const p=validateProfile(profile),mapping=validateMapping(rows),zero=zeroPose(p,31,false);
  if(!state?.ready||!state.outputKnown)throw Error('장치 출력 상태를 확인할 수 없습니다.');
  if(p.pcaChannels.some((v,i)=>v!==state.map[i]))throw Error('PCA 포트 매핑이 원점 기록과 다릅니다. 전원 OFF에서 포트 동기화를 하십시오.');
  if(zero.slice(0,5).some((v,ch)=>v<state.lower[ch]||v>state.upper[ch]))throw Error('저장 원점이 장치의 관절 한계 밖입니다. 서보 벤치에서 한계를 확인하십시오.');
  return {profile:p,mapping,zero};
}
export function targetPulses(body,anchor,origin,profile,rows,state){
  const {zero,mapping}=checkSetup(profile,rows,state),j=jointPose(body),a=jointPose(anchor);
  if([...j,...a,...origin].some(v=>!Number.isFinite(v))||origin.length!==6)throw Error('자세 또는 기준 펄스 오류');
  const pulses=[...origin];pulses[5]=zero[5];
  mapping.forEach((r,role)=>{
    const raw=role===4?zero[r.ch]:origin[r.ch]+(j[role]-a[role])*r.sign*r.usPerDegree*r.gain;
    const lo=Math.max(state.lower[r.ch],zero[r.ch]-r.span),hi=Math.min(state.upper[r.ch],zero[r.ch]+r.span);
    pulses[r.ch]=Math.round(Math.max(lo,Math.min(hi,raw)));
  });
  return pulses;
}
export function absoluteTarget(body,profile,rows,state,geometry=DEFAULT_GEOMETRY){
  const {zero,mapping}=checkSetup(profile,rows,state);
  const zeroPose=poseFromPulses(zero,profile,mapping,geometry);
  const pulses=targetPulses(body,zeroPose,zero,profile,mapping,state);
  const input=jointPose(body),reference=jointPose(zeroPose),limited=[];
  mapping.forEach((r,role)=>{
    if(role===4)return;
    const raw=zero[r.ch]+(input[role]-reference[role])*r.sign*r.usPerDegree*r.gain;
    if(Math.abs(raw-pulses[r.ch])>.51)limited.push('CH'+r.ch+' '+ROLES[role]);
  });
  return {pulses,limited};
}
export function poseFromPulses(pulses,profile,rows,geometry=DEFAULT_GEOMETRY){
  const zero=zeroPose(profile,31,false),mapping=validateMapping(rows);
  const delta=mapping.map(r=>(pulses[r.ch]-zero[r.ch])/r.usPerDegree/r.sign);
  const shoulder=geometry.zeroAngles[0]+delta[1],elbow=geometry.zeroAngles[1]+delta[2],wrist=geometry.zeroAngles[2]+delta[3];
  return {yaw:delta[0],leg:shoulder,torso:shoulder+elbow,arm:shoulder+elbow+wrist};
}
export function guardedStep(desired,state,profile,rows,geometry,maxStepUs=8){
  validateGeometry(geometry);checkSetup(profile,rows,state);
  if(state.mask!==31||desired.length!==6||desired.some(x=>!Number.isInteger(x)))throw Error('CH0~4 유지 상태와 정수 펄스가 필요합니다.');
  if(state.applied.slice(0,5).some((v,ch)=>v!==state.target[ch]))throw Error('직전 목표의 출력 완료 응답을 기다립니다.');
  if(!Number.isInteger(maxStepUs)||maxStepUs<1||maxStepUs>120)throw Error('한 번에 보낼 출력 범위 오류');
  // The negotiated rate changes time, not this independent-joint path.
  // Check every 1us slice even when firmware advances 24us per PWM frame.
  const next=desired.map((v,ch)=>ch===5?state.applied[5]:state.applied[ch]+Math.max(-maxStepUs,Math.min(maxStepUs,v-state.applied[ch])));
  if(next.slice(0,5).some((v,ch)=>v<state.lower[ch]||v>state.upper[ch]))throw Error('관절 한계 밖 목표');
  const travel=Math.max(...next.slice(0,5).map((v,ch)=>Math.abs(v-state.applied[ch])));
  for(let t=0;t<=travel;t++){
    const sample=state.applied.map((v,ch)=>v+Math.sign(next[ch]-v)*Math.min(Math.abs(next[ch]-v),t));
    const reason=collisionAt(poseFromPulses(sample,profile,rows,geometry),geometry);
    if(reason)return {safe:false,reason,pulses:[...state.applied]};
  }
  return {safe:true,reason:'',pulses:next};
}
export function moveCommand(pulses){
  if(pulses.length!==6||pulses.some(p=>!Number.isInteger(p)||p<500||p>2500))throw Error('이동 펄스 오류');
  return 'MOVE 31 '+pulses.join(' ');
}
export function planRemap(current,wanted){
  if(current.length!==6||wanted.length!==6||new Set(wanted).size!==6||wanted.some(p=>!Number.isInteger(p)||p<0||p>15))throw Error('PCA 포트 오류');
  const map=[...current],commands=[];
  for(let ch=0;ch<6;ch++){
    if(map[ch]===wanted[ch])continue;
    const occupied=map.indexOf(wanted[ch]);
    if(occupied!==-1){
      const free=Array.from({length:16},(_,i)=>i).find(p=>!map.includes(p)&&!wanted.includes(p));
      commands.push('MAP '+occupied+' '+free);map[occupied]=free;
    }
    commands.push('MAP '+ch+' '+wanted[ch]);map[ch]=wanted[ch];
  }
  return commands;
}
