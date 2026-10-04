import test from 'node:test';
import assert from 'node:assert/strict';
import {checkEngineSource} from '../body-control/engine-source.mjs';

test('a stopped local server explains the launcher instead of blaming camera access',async()=>{
  await assert.rejects(checkEngineSource('worker',{request:async()=>{throw new TypeError('Failed to fetch');}}),/로컬 조종 서버.*start-viewer\.ps1/);
});

test('missing worker and a wrong server document have distinct errors',async()=>{
  await assert.rejects(checkEngineSource('worker',{request:async()=>new Response(null,{status:404})}),/인식 파일.*HTTP 404/);
  await assert.rejects(checkEngineSource('worker',{request:async()=>new Response(null,{headers:{'content-type':'text/html'}})}),/파일 형식/);
});

test('available JavaScript source allows the engine to start without opening the camera',async()=>{
  const calls=[];
  await checkEngineSource('worker',{request:async(url,options)=>{
    calls.push({url,options});return new Response(null,{headers:{'content-type':'text/javascript; charset=utf-8'}});
  }});
  assert.equal(calls.length,1);assert.equal(calls[0].options.method,'HEAD');assert.equal(calls[0].options.cache,'no-store');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});
