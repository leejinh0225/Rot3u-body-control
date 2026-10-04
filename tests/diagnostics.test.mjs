import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionIssue} from '../viewer/diagnostics.mjs';
import {FIRMWARE} from '../viewer/protocol.mjs';
test('no serial response explains firmware upload instead of blaming PCA wiring', () => {
  const issue = connectionIssue({receivedBytes:0});
  assert.match(issue.title,/Uno 응답이 없습니다/);
  assert.match(issue.detail,/자동 업로드하지 않습니다/);
});
test('wrong firmware and other serial traffic have distinct recovery instructions', () => {
  assert.match(connectionIssue({firmware:'ARM_BENCH_V1',receivedBytes:30}).title,/이전 스케치/);
  assert.match(connectionIssue({receivedBytes:30}).title,/데이터는 오지만/);
});
test('bus failure never claims that PWM was stopped', () => {
  const issue = connectionIssue({firmware:FIRMWARE,receivedBytes:50,state:{ready:false,outputKnown:false},fault:'PCA_NOT_FOUND_0x40'});
  assert.match(issue.title,/중지 전달을 확인할 수 없습니다/);
  assert.match(issue.detail,/PSU를 끄십시오/);
});
test('PCA failure, USB EOF, and healthy state remain distinct', () => {
  assert.match(connectionIssue({firmware:FIRMWARE,receivedBytes:100,state:{ready:false,outputKnown:true},fault:'PCA_CONFIG_CHECK_FAILED'}).title,/PCA9685/);
  assert.match(connectionIssue({readEnded:true}).title,/USB 수신/);
  assert.equal(connectionIssue({firmware:FIRMWARE,receivedBytes:100,state:{ready:true,outputKnown:true}}),null);
});
