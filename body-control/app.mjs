import {NEUTRAL,HEADING_ZERO,TRACKING_GRACE_MS,features,makeBaseline,mapBody,demoLandmarks,TrackingGate} from './motion.mjs?v=continuity-11';
import {headingFeatures,HeadingContinuity,angleDelta,demoBody3D} from './body-heading.mjs?v=continuity-11';
import {AutoFollow} from './auto-follow.mjs?v=continuity-11';
import {advanceMotion} from './motion-path.mjs?v=continuity-11';
import {createHardware} from './hardware.mjs?v=continuity-11';
import {checkEngineSource} from './engine-source.mjs?v=camera-10';

const $=id=>document.getElementById(id);
const video=$('camera'),canvas=$('skeleton'),ctx=canvas.getContext('2d');
const gate=new TrackingGate();
const autoFollow=new AutoFollow();
const headingContinuity=new HeadingContinuity();
let autoState={phase:'waiting'};
let scene,mode='off',stream=null,worker=null,enginePromise=null,engineReady=false;
let session=0,busy=false,frameAt=0,lastVideoTime=-1,lastDemoAt=0,demoLost=false;
let current={...NEUTRAL},target={...NEUTRAL},latest=null,baseline=null,calibration=null;
let bodyPose={...NEUTRAL};
let lastDraw=performance.now(),lastUi=0,starting=false,lastPoseAt=0,frameMs=0;
let cameraIssue='',pauseReason='',engineSerial=0;
let collisionReason='',hardware=null;
let poseTimes=[];
const connections=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,31],[28,32]];
const headingMode=()=>$('base-mode').value==='heading';
const options=()=>({reverse:$('reverse').checked,baseEnabled:headingMode(),baseReverse:$('base-reverse').checked,headingGain:Number($('base-gain').value)});
const help=text=>$('tracking-help').textContent=text;
function pause(reason='수동으로 멈췄습니다. 자동 시작 대기를 누르면 다시 손대지 않고 시작할 수 있습니다.',{manual=true}={}) {
  gate.stop();target={...bodyPose};pauseReason=reason;
  if(manual)autoFollow.pause();else autoFollow.clear();
  if(manual)hardware?.pause('화면 일시정지 · 실물 PWM 유지');else hardware?.interrupt('자세 입력 대기 · 실물 PWM 유지');
  autoState={phase:manual?'paused':'waiting'};
  if(!calibration)$('countdown').hidden=true;
  if(reason)help(reason);
}
function cancelCalibration(){calibration=null;$('countdown').hidden=true;}
function clearInput(){
  headingContinuity.reset();
  pause('');baseline=null;latest=null;gate.seen(false,performance.now());cancelCalibration();
  autoFollow.arm();autoState={phase:'waiting'};
}
function endCamera(){
  session++;busy=false;starting=false;poseTimes=[];
  if(stream)stream.getTracks().forEach(track=>{track.onended=null;track.stop();});
  stream=null;video.srcObject=null;mode='off';cameraIssue='';clearInput();
  ctx.clearRect(0,0,canvas.width,canvas.height);
  $('camera-placeholder').hidden=false;$('demo-label').hidden=true;$('demo-loss').textContent='인식 끊김 시험';
}
function friendlyCameraError(e){
  return ({
    NotAllowedError:'카메라 권한이 허용되지 않았습니다. 브라우저의 이 페이지 카메라 권한을 허용한 뒤 다시 켜십시오.',
    NotFoundError:'카메라를 찾지 못했습니다. 노트북의 카메라 스위치와 Windows 카메라 설정을 확인하십시오.',
    NotReadableError:'카메라를 열지 못했습니다. 다른 카메라 앱을 닫거나 노트북 카메라 스위치를 확인하십시오.',
    OverconstrainedError:'선택한 카메라를 사용할 수 없습니다. 장치를 다시 선택하십시오.',
  })[e.name] ?? '카메라 오류: '+e.message;
}
async function listDevices(){
  const selected=stream?.getVideoTracks()[0]?.getSettings().deviceId ?? $('device').value;
  const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
  $('device').replaceChildren(new Option('기본 카메라',''));
  devices.forEach((d,i)=>$('device').add(new Option(d.label || '카메라 '+(i+1),d.deviceId)));
  if(devices.some(d=>d.deviceId===selected))$('device').value=selected;
}
async function startCamera(){
  if(starting)return;
  const device=$('device').value;
  endCamera();starting=true;cameraIssue='';const ticket=session;
  let stage='engine';
  help('자세 인식 엔진을 먼저 준비합니다. 준비가 끝나면 카메라를 엽니다.');
  setTimeout(()=>{if(ticket===session&&starting&&stage==='camera'&&!stream)help('카메라 권한을 기다리고 있습니다. 허용 창을 확인하십시오. 창이 뜨지 않으면 이 주소를 Chrome/Edge에서 열어 카메라를 켜십시오.');},10000);
  try{
    await ensureEngine();
    if(ticket!==session)return;
    stage='camera';help('카메라 권한을 확인하고 있습니다. 허용 후 내장 카메라를 선택하십시오.');
    if(!navigator.mediaDevices?.getUserMedia)throw Error('이 브라우저에서 카메라 API를 사용할 수 없습니다. Chrome 또는 Edge에서 localhost 주소를 여십시오.');
    const opened=await navigator.mediaDevices.getUserMedia({audio:false,video:{
      ...(device?{deviceId:{exact:device}}:{facingMode:'user'}),width:{ideal:640},height:{ideal:480},frameRate:{ideal:30,max:30}
    }});
    if(ticket!==session){opened.getTracks().forEach(t=>t.stop());return;}
    stream=opened;video.srcObject=opened;await video.play();
    if(ticket!==session)return;
    canvas.width=video.videoWidth||640;canvas.height=video.videoHeight||480;
    // Match preview and landmark coordinates even on a widescreen webcam.
    canvas.parentElement.style.aspectRatio=canvas.width+'/'+canvas.height;
    opened.getTracks().forEach(track=>track.onended=()=>{
      endCamera();cameraIssue='카메라 연결이 끝났습니다.';help(cameraIssue);
    });
    mode='camera';lastVideoTime=-1;$('camera-placeholder').hidden=true;
    await listDevices();
    if(ticket===session)help('팔을 뻗고 잠시 멈추면 자동으로 시작합니다. 다리가 보이면 반영하고, 안 보이면 90°로 가정합니다.');
  }catch(e){
    if(ticket!==session)return;
    endCamera();cameraIssue=stage==='engine'?'자세 인식 준비 실패: '+e.message:friendlyCameraError(e);help(cameraIssue);
  }finally{if(ticket===session)starting=false;}
}
function ensureEngine(){
  if(enginePromise)return enginePromise;
  const serial=++engineSerial;
  $('engine-status').textContent='인식 엔진: 불러오는 중…';
  enginePromise=new Promise((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>fail(Error('인식 엔진 준비 시간이 초과되었습니다.')),45000);
    function fail(error){
      if(serial!==engineSerial)return;
      clearTimeout(timer);engineReady=false;busy=false;worker?.terminate();worker=null;enginePromise=null;
      $('engine-status').textContent='인식 엔진: 오류';
      pause('인식 엔진 오류: '+error.message+' 로컬 자산 설치 및 Chrome/Edge 사용을 확인하십시오.');
      if(!settled){settled=true;reject(error);}
    }
    const workerUrl=new URL('./pose-worker.mjs?v=heading-9',import.meta.url);
    checkEngineSource(workerUrl).then(()=>{
      if(serial!==engineSerial||settled)return;
      worker=new Worker(workerUrl);
      worker.onerror=e=>fail(Error((e.message||'작업 스레드를 열지 못했습니다.')+' ['+(e.filename?.split('/').at(-1)||'worker')+':'+e.lineno+']'));
      worker.onmessage=({data})=>{
        if(serial!==engineSerial)return;
        if(data.type==='ready'){
          clearTimeout(timer);settled=true;engineReady=true;
          $('engine-status').textContent='인식 엔진: 준비 완료 · 기기 내 처리';resolve();
        }else if(data.type==='error'){fail(Error(data.message));}
        else if(data.type==='pose'){
          if(data.session!==session)return;
          busy=false;frameMs=data.ms;
          if(mode==='camera' && !document.hidden && performance.now()-data.time<350)receivePose(data.landmarks,data.time,data.worldLandmarks);
        }
      };
      worker.postMessage({type:'init'});
    }).catch(fail);
  });
  // Synchronous failures inside the executor must not leave a cached rejected promise.
  enginePromise.catch(()=>{if(!engineReady)enginePromise=null;});
  return enginePromise;
}
function drawSkeleton(points){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!points)return;
  const visible=i=>points[i] && points[i].visibility>=.35;
  const xy=i=>[(1-points[i].x)*canvas.width,points[i].y*canvas.height];
  ctx.lineWidth=Math.max(2,canvas.width/220);ctx.strokeStyle='#cad9d590';
  ctx.shadowColor='#103c32';ctx.shadowBlur=3;
  connections.forEach(([a,b])=>{if(!visible(a)||!visible(b))return;ctx.beginPath();ctx.moveTo(...xy(a));ctx.lineTo(...xy(b));ctx.stroke();});
  const ids=new Set(connections.flat());ids.add(0);
  for(const i of ids){if(!visible(i))continue;ctx.beginPath();ctx.arc(...xy(i),i===0?9:4,0,Math.PI*2);ctx.fillStyle=i===0?'#ffdf94':'#e5ffe9';ctx.fill();}
  if(latest?.valid){
    const chain=latest.points.map(p=>[p.x/(canvas.width/canvas.height)*canvas.width,-p.y*canvas.height]);
    const colors=['#7fe1a6','#f4be76','#85bdf2'];
    for(let i=latest.legAssumed?1:0;i<3;i++){
      ctx.setLineDash(i===1&&latest.torsoAssumed?[9,7]:[]);
      ctx.lineWidth=8;ctx.strokeStyle=colors[i];ctx.beginPath();ctx.moveTo(...chain[i]);ctx.lineTo(...chain[i+1]);ctx.stroke();
      ctx.beginPath();ctx.arc(...chain[i],7,0,Math.PI*2);ctx.fillStyle=colors[i];ctx.fill();
    }
    ctx.setLineDash([]);
    ctx.beginPath();ctx.arc(...chain[3],8,0,Math.PI*2);ctx.fillStyle=colors[2];ctx.fill();
  }
  ctx.shadowBlur=0;
}
function updateAutomatic(f,time){
  autoState=autoFollow.observe(f,time,{baseline,moving:gate.engaged});
  if(autoState.phase==='start'){
    baseline=autoState.baseline;engage();
    $('countdown').hidden=true;return;
  }
  const counting=autoState.phase==='countdown';
  $('countdown').hidden=!counting;
  if(counting){
    $('countdown').textContent=String(autoState.seconds);
    help(autoState.recovering?'자세가 다시 잡혔습니다. 0.6초 안정 확인 후 이어갑니다.':'자세를 잡았습니다. 잠시 멈추면 자동으로 따라갑니다. 회전 중앙은 오른쪽 45°로 고정입니다.');
  }else if(['waiting','position','unstable'].includes(autoState.phase)&&f?.valid){
    help(autoState.reason||'상반신과 앞으로 뻗은 팔을 기다리고 있습니다.');
  }
}
function receivePose(points,time,world=null){
  poseTimes.push(time);poseTimes=poseTimes.filter(t=>time-t<2000);
  const wasBrieflyMissing=gate.engaged&&(!latest?.valid||time-lastPoseAt>=350);
  let f=headingMode()?headingContinuity.observe(headingFeatures(points,world,canvas.width/canvas.height,$('arm-mode').value),time):
    features(points,canvas.width/canvas.height,$('arm-mode').value);
  if(f.valid&&headingMode()&&Math.abs(angleDelta(f.heading,HEADING_ZERO))>85)
    f={...f,valid:false,reason:'오른쪽 45° 기준에서 너무 많이 돌아섰습니다. 카메라 쪽으로 돌아오십시오.'};
  latest=f;lastPoseAt=time;drawSkeleton(points);
  const wasMoving=gate.engaged;gate.seen(f.valid,time);
  if(!f.valid){
    if(calibration){cancelCalibration();help('방향 기록이 중단되었습니다. '+f.reason);}
    else if(wasMoving&&!gate.engaged)pause('인식이 끊겨 잠시 멈췄습니다. '+f.reason,{manual:false});
    else if(gate.engaged){target={...bodyPose};help('잠깐 인식 대기 · 0.8초 안에 돌아오면 대기 없이 이어갑니다.');}
    updateAutomatic(f,time);
    return;
  }
  if(wasBrieflyMissing&&gate.engaged)help('인식이 돌아와 대기 없이 이어갑니다. 회전 중앙은 오른쪽 45°로 유지합니다.');
  if(calibration){
    calibration.samples.push(f);
    const elapsed=time-calibration.started;
    $('countdown').textContent=Math.max(1,Math.ceil((3000-elapsed)/1000));
    if(elapsed>=3000){
      try{baseline=makeBaseline(calibration.samples);pauseReason='';help(headingMode()?'자세 확인 완료 · 회전 중앙은 오른쪽 45° 고정입니다.':'팔 방향을 확인했습니다.');}
      catch(e){baseline=null;help(e.message);}
      cancelCalibration();
      if(baseline)engage();
    }
  }else updateAutomatic(f,time);
  if(gate.engaged && baseline)target=mapBody(f,baseline,options());
}
function beginCalibration(){
  if(!latest?.valid || !latest.ready || performance.now()-lastPoseAt>=350)return;
  pause('양팔을 앞으로 뻗고 3초 동안 멈추십시오. 자세를 확인한 뒤 바로 시작합니다.');
  baseline=null;calibration={started:performance.now(),samples:[]};$('countdown').textContent='3';$('countdown').hidden=false;
}
function engage(){
  if(!scene || !baseline || !latest?.valid || calibration || !gate.start(performance.now()))return;
  autoFollow.arm();autoState={phase:'following'};
  target=mapBody(latest,baseline,options());pauseReason='';
  help(headingMode()?'제자리에서 몸을 돌리면 베이스가 회전하고, 몸통·팔을 굽히면 링크가 굽습니다. 화면 좌우 이동은 무시합니다. Space로 멈춥니다.':
    '베이스는 중앙에 고정합니다. 옆 또는 비스듬히 서서 몸통·팔로 앞쪽 과자를 퍼 담으십시오. Space로 멈춥니다.');
}
function startDemo(){
  endCamera();mode='demo';demoLost=false;canvas.width=640;canvas.height=480;canvas.parentElement.style.aspectRatio='4/3';
  $('camera-placeholder').hidden=true;$('demo-label').hidden=false;
  help('상반신만 있는 합성 자세입니다. 잠시 멈추면 방향을 잡고 자동으로 시작합니다.');
}
function refreshUi(now,k){
  const fresh=latest?.valid && now-lastPoseAt<350;
  $('camera-start').disabled=starting;$('camera-stop').disabled=mode==='off'&&!starting;
  $('device').disabled=starting;
  $('calibrate').disabled=!fresh||!latest?.ready||!!calibration||mode==='off';
  $('engage').disabled=!scene||!fresh||!baseline||!!calibration||gate.engaged;
  $('engine-check').disabled=!!enginePromise&&!engineReady;
  $('demo-loss').disabled=mode!=='demo';
  $('auto-rearm').disabled=mode==='off';
  $('motion-badge').textContent=gate.engaged?(fresh?'상반신을 따라가는 중':'잠깐 인식 대기 · 바로 재개'):calibration?'자세 확인 중':autoState.phase==='countdown'?'자동 시작 '+autoState.seconds+'초':autoFollow.suspended?'수동 일시정지':autoFollow.enabled?'자동 시작 대기':'수동 시작 대기';
  $('motion-badge').className='status'+(gate.engaged?' live':'');
  $('tracking-badge').textContent=mode==='off'?(starting?'연결 중':cameraIssue?'연결 확인 필요':'카메라 꺼짐'):fresh?(mode==='demo'?'합성 상반신':'상반신 인식 중'):'상반신 인식 대기';
  $('tracking-badge').className='status'+(fresh?' live':mode!=='off'?' warning':'');
  if(mode!=='off'&&!fresh&&!gate.engaged&&!calibration&&!pauseReason)
    help(latest?.reason||'상반신과 양팔을 기다리고 있습니다. 다리는 보이지 않아도 됩니다.');
  $('pose-details').textContent=fresh
    ? (latest.legAssumed?'다리 안 보임 → 90° 가정':'다리 추적 중')+' · '+(latest.torsoAssumed?'허리 안 보임 → 몸통 90° 가정':'몸통 추적 중')+' · '+({both:'양팔 사용',left:'보이는 왼팔 사용',right:'보이는 오른팔 사용'}[latest.armSource])
    : '보이는 몸 구간을 사용합니다. 다리·허리가 안 보이면 각각 90°로 가정합니다.';
  $('base-gain').disabled=$('base-reverse').disabled=!headingMode();
  $('base-gain-value').textContent=Number($('base-gain').value).toFixed(1)+'배';
  $('demo-heading').disabled=!headingMode();
  $('base-readout').textContent=!headingMode()?'회전 고정 · 베이스 0° · 한쪽 팔만 보여도 측면 2D 조종':
    !fresh?'몸 방향 3D · '+(latest?.reason||'양쪽 어깨와 앞으로 뻗은 팔을 기다립니다.'):
    '몸 방향 '+Math.round(latest.heading)+'° · 오른쪽 45° 기준 '+Math.round(angleDelta(latest.heading,HEADING_ZERO))+'°'+
    (baseline?' → 베이스 목표 '+Math.round(mapBody(latest,baseline,options()).yaw)+'°':' · 시작 자세 확인 중')+' · 현재 '+Math.round(current.yaw)+'°';
  $('yaw-value').textContent=Math.round(current.yaw)+'°';
  $('leg-value').textContent=Math.round(current.leg)+'°';
  $('torso-value').textContent=Math.round(current.torso)+'°';
  $('arm-value').textContent=Math.round(current.arm)+'°';
  $('height-value').textContent=((k?.tip[1]??0)*100).toFixed(0)+' cm';
  $('reach-status').textContent=collisionReason?'가상 모델 이동 차단: '+collisionReason+' · 실물은 입력한 치수로 별도 검사합니다.':'가상 모델의 바닥·베이스·링크 간섭 검사 중 · 과자/주변 물체의 접촉·집기는 아직 계산하지 않습니다.';
  const inputHz=poseTimes.length>1&&now-lastPoseAt<350?1000*(poseTimes.length-1)/(poseTimes.at(-1)-poseTimes[0]):0;
  $('fps').textContent=mode==='camera'&&frameMs?'입력 '+inputHz.toFixed(1)+' Hz · 추론 '+Math.round(frameMs)+' ms':mode==='demo'?'합성 입력':'—';
}
function tick(now){
  const dt=(now-lastDraw)/1000;lastDraw=now;
  if(!document.hidden){
    if(mode==='demo' && now-lastDemoAt>65){
      lastDemoAt=now;
      const demoPose={leg:Number($('demo-leg').value),torso:Number($('demo-torso').value),arm:Number($('demo-arm').value)};
      const simulated3D=headingMode()?demoBody3D({...demoPose,heading:Number($('demo-heading').value)}):null;
      const synthetic=simulated3D?simulated3D.landmarks:demoLandmarks(demoPose);
      synthetic.forEach((p,i)=>{
        p.x+=Number($('demo-shift').value);
        if(!$('demo-legs').checked){p.x=(p.x-.08)/.8;p.y=(p.y-.045)/.8;if(i>=25){p.y=1.3;p.visibility=0;}}
      });
      if($('demo-no-hips').checked)[23,24].forEach(i=>{synthetic[i].visibility=0;synthetic[i].y=1.2;});
      if($('demo-side').checked)[12,14,16,24].forEach(i=>{synthetic[i].visibility=.1;});
      receivePose(demoLost?null:synthetic,now,demoLost?null:simulated3D?.worldLandmarks);
    }
    if(mode==='camera'&&engineReady&&!busy&&video.readyState>=2&&now-frameAt>=40&&video.currentTime!==lastVideoTime){
      busy=true;frameAt=now;lastVideoTime=video.currentTime;const ticket=session;
      createImageBitmap(video).then(frame=>{
        if(ticket!==session||mode!=='camera'||!worker){frame.close();if(ticket===session)busy=false;return;}
        worker.postMessage({type:'frame',frame,timestamp:now,session:ticket},[frame]);
      }).catch(e=>{if(ticket===session){busy=false;pause('카메라 프레임을 읽지 못했습니다: '+e.message);}});
    }
    if(mode==='camera'&&busy&&now-frameAt>5000){
      busy=false;engineSerial++;worker?.terminate();worker=null;enginePromise=null;engineReady=false;
      $('engine-status').textContent='인식 엔진: 응답 없음';pause('인식 엔진이 응답하지 않습니다. 카메라를 껐다가 다시 켜십시오.');
    }
    const wasMoving=gate.engaged,moving=gate.canMove(now);
    if(wasMoving&&!gate.engaged)pause('자세 입력이 늦어 잠시 멈췄습니다. 다시 잡히면 자동으로 이어갑니다.',{manual:false});
    if(now-lastPoseAt>=TRACKING_GRACE_MS&&['countdown','holding'].includes(autoState.phase)){
      autoFollow.clear();autoState={phase:'waiting'};$('countdown').hidden=true;
    }
    if(calibration && now-lastPoseAt>500){cancelCalibration();help('자세 입력이 끊겨 방향 기록을 취소했습니다. 다시 시도하십시오.');}
    if(moving){
      const next=advanceMotion(bodyPose,current,target,dt);
      bodyPose=next.body;current=next.virtual;collisionReason=next.virtualCollision;
    }
    const k=scene?.update(current,moving);
    if(now-lastUi>100){refreshUi(now,k);lastUi=now;}
  }
  requestAnimationFrame(tick);
}
$('camera-start').addEventListener('click',startCamera);
$('camera-stop').addEventListener('click',()=>{endCamera();help('카메라를 껐습니다. 가상 팔은 현재 위치에 멈춰 있습니다.');});
$('auto-start').addEventListener('change',()=>{
  cancelCalibration();pause('');autoFollow.setEnabled($('auto-start').checked);autoState={phase:'waiting'};
  help(autoFollow.enabled?'자동 시작을 켰습니다. 팔을 뻗고 잠시 멈추십시오.':'자동 시작을 껐습니다. 방향 잡기와 따라하기 버튼으로 조작합니다.');
});
$('auto-rearm').addEventListener('click',()=>{
  cancelCalibration();pause('');baseline=null;autoFollow.setEnabled(true);$('auto-start').checked=true;
  autoState={phase:'waiting'};pauseReason='';help('자동 시작을 다시 기다립니다. 상반신과 뻗은 팔이 잡히면 시작합니다.');
});
$('device').addEventListener('change',()=>{if(mode==='camera')startCamera();});
$('calibrate').addEventListener('click',beginCalibration);
$('engage').addEventListener('click',engage);
$('pause').addEventListener('click',()=>{cancelCalibration();pause();});
$('reset').addEventListener('click',()=>{cancelCalibration();pause('가상 팔을 처음 자세로 옮겼습니다. 자동 시작 대기로 다시 준비할 수 있습니다.');current={...NEUTRAL};bodyPose={...NEUTRAL};target={...NEUTRAL};collisionReason='';scene?.clearTrail();});
$('demo-start').addEventListener('click',startDemo);
$('demo-loss').addEventListener('click',()=>{
  demoLost=!demoLost;$('demo-loss').textContent=demoLost?'합성 인식 복구':'인식 끊김 시험';
  if(demoLost)receivePose(null,performance.now());
});
$('arm-mode').addEventListener('change',()=>{
  clearInput();help('읽을 팔을 바꿨습니다. 안정적으로 잡히면 자동으로 방향을 다시 맞춥니다.');
});
$('reverse').addEventListener('input',()=>{
  pause('바라보는 방향을 반전했습니다. 자동 시작 대기 또는 수동 시작으로 다시 이어갈 수 있습니다.');
});
for(const id of ['base-mode','base-reverse','base-gain'])$(id).addEventListener('change',()=>{
  clearInput();help(headingMode()?'몸 방향 모드입니다. 양쪽 어깨가 보이도록 비스듬히 서서 팔을 앞으로 뻗으십시오. 3초 후 자동으로 시작합니다.':
    '회전을 고정했습니다. 옆모습에서 팔을 뻗으면 자동으로 시작합니다. 실물 추종은 다시 대기로 시작하십시오.');
});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{
  scene?.view(Number(button.dataset.view));document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));
}));
$('engine-check').addEventListener('click',async()=>{
  try{await ensureEngine();help('인식 엔진을 불러왔습니다. 카메라 켜기를 누르면 영상에서 자세를 찾습니다.');}catch{}
});
document.addEventListener('keydown',e=>{
  if(e.code==='Escape'||(e.code==='Space'&&!['INPUT','SELECT','TEXTAREA','SUMMARY'].includes(e.target.tagName))){
    e.preventDefault();cancelCalibration();pause();
  }
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){
  cancelCalibration();gate.seen(false,performance.now());
  pause('화면을 벗어나 멈췄습니다. 돌아오면 안정된 자세에서 자동으로 이어갑니다.',{manual:autoFollow.suspended});
}});
window.addEventListener('pagehide',()=>{endCamera();worker?.terminate();});
try{const {createScene}=await import('./scene.mjs');scene=createScene($('stage'));}
catch(e){
  const message=document.createElement('p');message.className='scene-error';
  message.textContent='3D 화면을 열지 못했습니다. start-viewer.ps1로 실행하고 WebGL이 가능한 Chrome/Edge를 사용하십시오. '+e.message;$('stage').append(message);
}
requestAnimationFrame(tick);
hardware=createHardware(()=>({
  // Match the rendered joint angles, including a virtual collision stop.
  // The collision flag is not a readiness gate; hardware checks its own path.
  mode,valid:!!latest?.valid&&performance.now()-lastPoseAt<350,moving:gate.engaged,pose:{...current},
  reason:performance.now()-lastPoseAt>=350?'카메라 자세 입력이 0.35초 이상 늦어졌습니다.':!latest?.valid?latest?.reason:
    !gate.engaged?(autoState.phase==='countdown'?'카메라 자동 시작 '+autoState.seconds+'초 대기 중입니다.':pauseReason||autoState.reason):'',
  legAssumed:latest?.legAssumed,torsoAssumed:latest?.torsoAssumed,virtualCollision:collisionReason
}));
