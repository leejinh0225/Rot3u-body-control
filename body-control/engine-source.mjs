// A loaded page can survive after its localhost server has exited. Workers
// cannot: diagnose that separately from camera permissions/device failures.
export async function checkEngineSource(url,{request=fetch}={}){
  let response;
  try{
    response=await request(url,{method:'HEAD',cache:'no-store',signal:AbortSignal.timeout(5000)});
  }catch{
    throw Error('로컬 조종 서버에 연결할 수 없습니다. start-viewer.ps1을 다시 실행한 뒤 카메라 켜기를 누르십시오.');
  }
  if(!response.ok)throw Error('자세 인식 파일을 불러오지 못했습니다 (HTTP '+response.status+'). 로봇팔 폴더의 start-viewer.ps1을 다시 실행하십시오.');
  const type=response.headers.get('content-type')??'';
  if(type&&!/(java|ecma)script/i.test(type))throw Error('자세 인식 파일 형식이 올바르지 않습니다. 로봇팔 폴더의 start-viewer.ps1로 실행하십시오.');
}
