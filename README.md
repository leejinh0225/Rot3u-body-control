# ROT3U Body Control

웹캠 몸동작으로 ROT3U 로봇팔을 조종하는 Windows 도구입니다. 가상 팔 연습, Arduino 실물 제어, 서보 시험과 원점 기록을 지원합니다.

## 준비 및 실행

- Windows, Python 3, Chrome 또는 Edge
- 실물: Uno R3, PCA9685, MG996R, 외부 서보 전원
- 최초 실행에 인식 라이브러리 다운로드용 인터넷이 필요합니다. 설치 후에는 로컬에서 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-desktop-shortcuts.ps1
```

바탕화면의 **로봇팔 조종**을 실행합니다. 서버와 전용 창이 자동으로 열립니다. 직접 실행할 수도 있습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch-robot-arm.ps1
```

- 몸동작 조종: <http://127.0.0.1:8765/body-control/>
- 서보 시험·원점 기록: <http://127.0.0.1:8765/viewer/>
- 창을 닫아도 서버는 남습니다. 종료는 **로봇팔 서버 종료** 아이콘을 사용합니다.

## 실물 연결

서보 전원을 끈 상태에서 `firmware/ArmBench/ArmBench.ino`를 Uno에 업로드합니다. 추가 Arduino 라이브러리는 필요하지 않습니다. 업로드 후 시리얼 모니터를 닫습니다.

| 연결 | 용도 |
|---|---|
| Uno 5V → PCA VCC | 논리 전원 |
| Uno GND → PCA GND | 공통 접지 |
| Uno A4 → PCA SDA | I²C 데이터 |
| Uno A5 → PCA SCL | I²C 클록 |
| 외부 PSU + → PCA V+ | 서보 전원 |
| 외부 PSU − → PCA GND | 서보 접지 |

OE는 연결하지 않습니다. 보드의 기본 LOW 구성을 전제로 합니다. 서보 선은 PWM / V+ / GND 표기를 확인합니다. 서보 전원을 Uno 5V에서 공급하지 않습니다.

몸동작 화면에서 **USB 연결 → 원점 JSON 확인 → 원점 PWM 켜기 → 실물 추종 대기** 순서로 시작합니다. USB 연결·업로드·재설정 중에는 서보 PSU를 끄고, 장치의 출력 OFF를 확인한 뒤 켭니다. 최초 PWM 활성화 전에는 팔을 받칩니다.

## 채널과 원점

| 채널 | 역할 |
|---|---|
| CH0 | 베이스 회전 |
| CH1 | 어깨 |
| CH2 | 팔꿈치 |
| CH3 | 손목 굽힘 |
| CH4 | 손목 회전 — 몸동작 조종에서는 고정 |
| CH5 | 그리퍼 — 몸동작 조종에서는 OFF |

서보 시험 화면에서 관절을 선택해 도/µs 단위로 조정하고 **현재 위치를 원점으로 기록 → JSON 다운로드**로 저장합니다. 기본 시험 범위는 1000~2000µs이며, 전체 PWM OFF에서 관절별로 500~2500µs 안의 한계를 지정할 수 있습니다. PCA 포트를 옮길 때도 OFF에서 채널 매핑을 변경합니다.

현재 장치의 원점은 [calibration/rot3u-zero.json](calibration/rot3u-zero.json)에 백업했습니다. CH0~4는 `1523 / 1677 / 1611 / 1500 / 1612µs`, 위로 편 자세입니다. 화면의 **원점 JSON**으로 불러오거나 아래 명령으로 로컬 자동 로딩 파일을 복원합니다. 다른 조립품에는 새로 보정해야 합니다.

```powershell
Copy-Item .\calibration\rot3u-zero.json .\body-control\local-zero.json
```

## 제어와 종료

- 양팔을 나란히 뻗고 처음 3초간 안정되면 가상 추종이 시작됩니다. 다리·허리가 안 보이면 각각 90°를 가정합니다.
- 베이스 중앙은 거울 화면 오른쪽 45°입니다. 회전 고정 모드도 제공합니다.
- 0.8초 미만 인식 끊김은 자세를 유지한 뒤 대기 없이 이어갑니다. 실물은 화면과 같은 절대 관절각을 목표로 합니다.
- 실물 이동 상한은 새 펌웨어에서 1,200µs/초입니다. `Space`/`Esc`는 추종 일시정지, 정상 종료는 **원점 복귀 후 OFF**입니다.
- 최초 출력·전원 차단 시 실제 자세를 읽을 수 없습니다. 충돌 검사는 임시 치수의 보조 제한이며 주변 물체·하중·처짐은 계산하지 않습니다. 서버 종료는 PWM OFF가 아닙니다.

## 파일과 검증

| 경로 | 내용 |
|---|---|
| `body-control/` | 몸동작 추적·가상 팔·실물 제어 |
| `viewer/` | 서보 조정·원점 기록·PCA 포트 변경 |
| `firmware/ArmBench/` | Uno 펌웨어 |
| `launcher/` | 로컬 서버·시작/종료 실행기 |
| `calibration/` | 현재 장치의 원점 백업 |
| `tests/` | 제어·통신·실행기 테스트 |

```powershell
node --test tests/*.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\launcher.test.ps1
```

[몸동작 설정](body-control/README.md) · [치수](body-control/DIMENSIONS.md) · [실행기](launcher/README.md)
