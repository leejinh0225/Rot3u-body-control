import {TRACKING_GRACE_MS} from './motion.mjs?v=continuity-11';
const KEYS=['yaw','leg','torso','arm'];

export function inputWaitReason(input,hidden=false){
  if(hidden)return '화면이 숨겨져 있습니다. 조종 화면으로 돌아오십시오.';
  if(input.mode!=='camera')return '실제 카메라를 켜십시오. 합성 자세는 실물에 보내지 않습니다.';
  if(!input.valid)return input.reason||'어깨·손목 인식 또는 새 카메라 입력을 기다립니다.';
  if(!input.moving)return input.reason||'카메라의 자동 방향 잡기·따라하기 시작을 기다립니다.';
  if(KEYS.some(k=>!Number.isFinite(input.pose?.[k])))return '자세 각도에 오류가 있어 입력을 기다립니다.';
  return '';
}

export const inputShape=input=>String(input.legAssumed)+':'+String(input.torsoAssumed);

// The displayed concept arm has different dimensions and a different origin.
// Its collision flag must not gate hardware; guardedStep checks the physical path.
export class FollowReadiness{
  constructor(){this.reset();}
  reset(){this.started=null;this.pose=null;this.shape=null;this.lastTime=null;this.missing=false;}
  observe(input,time,hidden=false){
    const reason=inputWaitReason(input,hidden);
    if(reason){
      if(!hidden&&input.mode==='camera'&&input.moving&&!input.valid&&this.lastTime!==null&&time-this.lastTime<TRACKING_GRACE_MS)
        this.missing=true;
      else this.reset();
      return {ready:false,message:reason};
    }
    const shape=inputShape(input);
    const gap=this.lastTime!==null&&(time<=this.lastTime||time-this.lastTime>=TRACKING_GRACE_MS);
    const changed=this.pose&&KEYS.some(k=>Math.abs(input.pose[k]-this.pose[k])>5);
    const sourceChanged=this.shape!==null&&this.shape!==shape;
    if(this.started===null||gap||changed||sourceChanged){
      this.started=time;this.pose={...input.pose};this.shape=shape;
    }else if(this.missing||time-this.lastTime>=350)this.started+=time-this.lastTime;
    this.missing=false;
    this.lastTime=time;
    const remaining=Math.max(0,1800-(time-this.started));
    return {ready:remaining===0,message:remaining===0?'기준 자세를 잡았습니다. 이제 천천히 움직이십시오.':
      (sourceChanged?'다리·허리 인식 범위가 바뀌었습니다. ':changed?'움직임이 커서 기준을 다시 잡습니다. ':'')+
      '기준 자세 잡는 중 · '+(remaining/1000).toFixed(1)+'초 동안 잠시 멈추십시오.'};
  }
}
