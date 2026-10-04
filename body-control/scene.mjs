import * as T from './vendor/three/build/three.module.js';
import {solveArm} from './motion.mjs';
export function createScene(container) {
  const scene=new T.Scene();scene.background=new T.Color('#101e28');
  const renderer=new T.WebGLRenderer({antialias:true,alpha:false});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.outputColorSpace=T.SRGBColorSpace;
  container.append(renderer.domElement);renderer.domElement.setAttribute('aria-label','몸동작으로 조종하는 가상 로봇팔 3D 화면');
  const camera=new T.PerspectiveCamera(38,1,.01,10);
  const views=[[.94,.75,1.28],[.2,.43,1.55],[1.4,.55,.30]];
  function view(i){camera.position.set(...views[i]);camera.lookAt(.16,.30,0);}
  view(0);
  scene.add(new T.HemisphereLight(0xdaf7ee,0x354150,2.5));
  const light=new T.DirectionalLight(0xffffff,3.5);light.position.set(-.6,1.4,.7);light.castShadow=true;
  light.shadow.mapSize.set(1024,1024);light.shadow.camera.left=-1;light.shadow.camera.right=1;
  light.shadow.camera.top=1;light.shadow.camera.bottom=-1;light.shadow.camera.near=.1;light.shadow.camera.far=4;light.shadow.bias=-.001;scene.add(light);
  const mat=(color,metalness=.1)=>new T.MeshStandardMaterial({color,metalness,roughness:.55});
  const metal=mat('#344c5a',.6),trim=mat('#8dacae',.65),green=mat('#72e3ae',.25),dark=mat('#182833'),orange=mat('#ffcb78');
  function mesh(geometry,material,parent=scene){const m=new T.Mesh(geometry,material);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
  function box(x,y,z,material,parent){return mesh(new T.BoxGeometry(x,y,z),material,parent);}
  const floor=mesh(new T.PlaneGeometry(2,2),mat('#182d39'));floor.rotation.x=-Math.PI/2;floor.position.y=-.011;
  const grid=new T.GridHelper(1.6,20,0x395767,0x233e4c);grid.position.y=-.009;scene.add(grid);
  const base=box(.18,.028,.17,metal);base.position.y=.014;
  mesh(new T.CylinderGeometry(.053,.063,.055,32),dark).position.y=.055;
  const axis=mesh(new T.CylinderGeometry(.047,.047,.018,32),green);axis.position.y=.079;
  const segments=[box(.047,1,.044,mat('#7fe1a6')),box(.041,1,.038,mat('#f4be76')),box(.033,1,.030,mat('#85bdf2'))];
  const joints=Array.from({length:3},()=>mesh(new T.SphereGeometry(.028,24,16),dark));
  const bolts=Array.from({length:3},()=>mesh(new T.SphereGeometry(.013,16,12),green));
  const scoop=new T.Group();scene.add(scoop);
  box(.075,.007,.085,orange,scoop);
  box(.007,.028,.085,orange,scoop).position.set(-.036,.014,0);
  box(.007,.028,.085,orange,scoop).position.set(.036,.014,0);
  box(.075,.026,.006,orange,scoop).position.set(0,.013,-.040);
  const tray=box(.28,.014,.25,mat('#345363'));tray.position.set(.39,.003,0);
  for(const [x,z,w,d] of [[.25,0,.009,.25],[.53,0,.009,.25],[.39,-.125,.28,.009],[.39,.125,.28,.009]])
    box(w,.023,d,trim).position.set(x,.018,z);
  // Static props: this prototype does not simulate candy contact.
  for(let i=0;i<14;i++) {
    const c=box(.021,.013,.033,mat(['#faac75','#a6dfb0','#c1a2ed'][i%3]));
    c.position.set(.29+(i%5)*.047,.018,-.08+Math.floor(i/5)*.07);c.rotation.y=i*.7;
  }
  const tipMarker=mesh(new T.RingGeometry(.018,.021,32),new T.MeshBasicMaterial({color:0x9aefc6,side:T.DoubleSide}));
  tipMarker.rotation.x=-Math.PI/2;tipMarker.position.y=.025;
  const trail=new T.BufferGeometry(),trailPoints=[];
  const trailPositions=new Float32Array(110*3);
  trail.setAttribute('position',new T.BufferAttribute(trailPositions,3));trail.setDrawRange(0,0);
  const trailLine=new T.Line(trail,new T.LineBasicMaterial({color:0x61aa95,transparent:true,opacity:.45}));scene.add(trailLine);
  const up=new T.Vector3(0,1,0);
  function link(m,a,b){const va=new T.Vector3(...a),vb=new T.Vector3(...b),delta=vb.clone().sub(va);m.position.copy(va.add(vb).multiplyScalar(.5));m.scale.y=delta.length();m.quaternion.setFromUnitVectors(up,delta.normalize());}
  function update(pose,moving=false){
    const k=solveArm(pose),points=k.points;
    for(let i=0;i<3;i++){link(segments[i],points[i],points[i+1]);joints[i].position.set(...points[i]);bolts[i].position.set(points[i][0]+.019,points[i][1],points[i][2]+.012);}
    axis.rotation.y=-k.yaw;
    scoop.position.set(...k.tip);scoop.rotation.set(0,-k.yaw,0);scoop.rotateZ(k.pitch);scoop.rotateY(Math.PI/2);
    tipMarker.position.x=k.tip[0];tipMarker.position.z=k.tip[2];
    if(moving){
      trailPoints.push(k.tip);if(trailPoints.length>110)trailPoints.shift();
      trailPoints.forEach((p,i)=>trailPositions.set(p,i*3));
      trail.attributes.position.needsUpdate=true;trail.setDrawRange(0,trailPoints.length);trail.computeBoundingSphere();
    }
    renderer.render(scene,camera);return k;
  }
  const observer=new ResizeObserver(()=>{const w=container.clientWidth,h=container.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();});observer.observe(container);
  return {update,view,clearTrail(){trailPoints.length=0;trail.setDrawRange(0,0);}};
}
