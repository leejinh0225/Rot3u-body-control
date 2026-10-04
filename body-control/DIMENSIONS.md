# 치수 설정

기본값은 동작 시험용 가정이며 실제 조립품의 측정값이 아닙니다. 원점 JSON에는 PWM과 PCA 채널만 저장합니다.

| 항목 | 기본값 |
|---|---|
| 어깨→팔꿈치 / 팔꿈치→손목 / 손목→부착점 | 105 / 100 / 70mm |
| 어깨 축 높이 / 베이스 반경 | 110 / 20mm |
| 추가 도구 길이 | 0mm |
| 충돌 반경 / 여유 | 10 / 10mm 고정 |
| 수직 원점 | 어깨 90°, 팔꿈치·손목 상대각 0° |
| 가상 화면 링크 / 도구 | 210 / 200 / 210mm, 55mm |

링크 길이는 회전축 중심 사이, 어깨 높이는 테이블에서 CH1 축까지입니다. 베이스 반경은 회전 중심부터 구조 바깥까지입니다. 도구를 추가하면 길이와 외형을 별도로 확인합니다.

검사는 바닥·베이스·비인접 링크의 근사 간섭과 각도 한계만 확인합니다. 실제 형상·주변 물체·처짐을 보장하지 않습니다.

참고 자료:

- [Diymore ROT3U 제품](https://www.diymore.cc/products/diymore-rot3u-6dof-aluminium-robot-arm-mechanical-robotic-clamp-claw-kit-for-arduino-mega2560)
- [DeKUT ROT3U 모델, Table 2](https://stieconference.dkut.ac.ke/downloads/6th-STI%26E-Proceedings/STIE06-ETI-006.pdf)
- [ROT3U 기구학 구현](https://github.com/JayshKhan/5-1DOF_kinematics)
