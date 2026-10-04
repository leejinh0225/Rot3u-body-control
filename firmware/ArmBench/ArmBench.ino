/* Uno R3 + PCA9685, supervised single tests, multi-channel hold and zero trim.
   Read ../../README.md before applying servo power. No position feedback.
   FOUR WIRES: 5V->VCC, GND->GND, A4->SDA, A5->SCL. Leave OE unconnected.
   No independent output inhibit: I2C failure may leave the last PWM running.
   Keep servo PSU OFF during upload/reset/reconnection. No resistor required.
   Stop/timeout requests PWM OFF over I2C, NOT power removal. Support the arm.
*/
#include <Wire.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

const uint8_t PCA_ADDRESS = 0x40;
const uint8_t PRESCALE = 121; // ~50.03 Hz at nominal 25 MHz
const uint16_t MIN_US = 500, MAX_US = 2500, START_US = 1500;
const uint32_t WATCHDOG_MS = 2000;
const uint16_t STEP_MS = 20, STEP_US = 2; // nominal 100 us/s, not degrees/s
uint16_t bodyStepUs = STEP_US; // Negotiated while OFF; only MOVE uses this rate.

bool ready = false;
bool outputKnown = false; // Last PWM/OFF command ACKed; NOT physical feedback.
uint8_t activeMask = 0;
uint8_t channelMap[6] = {0, 1, 2, 3, 4, 5}; // logical joint -> physical PCA port
uint16_t lowerUs[6] = {1000, 1000, 1000, 1000, 1000, 1000};
uint16_t upperUs[6] = {2000, 2000, 2000, 2000, 2000, 2000};
uint16_t applied[6] = {1500, 1500, 1500, 1500, 1500, 1500};
uint16_t target[6] = {1500, 1500, 1500, 1500, 1500, 1500};
uint32_t lastPing = 0, lastStep = 0, lastStatus = 0, lastHealth = 0;
bool streaming = false;
uint32_t lastMove = 0;
const uint16_t STREAM_TIMEOUT_MS = 350;
char input[64];
uint8_t inputLen = 0;
bool discardLine = false;
uint32_t lastByte = 0;

bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(PCA_ADDRESS);
  Wire.write(reg); Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readRegister(uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(PCA_ADDRESS); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(PCA_ADDRESS, (uint8_t)1) != 1) return false;
  value = Wire.read(); return true;
}

bool channelPWM(uint8_t channel, uint16_t off) {
  Wire.beginTransmission(PCA_ADDRESS);
  Wire.write((uint8_t)(0x06 + 4 * channel));
  Wire.write((uint8_t)0); Wire.write((uint8_t)0);
  Wire.write((uint8_t)off); Wire.write((uint8_t)(off >> 8));
  return Wire.endTransmission() == 0;
}

bool allOff() {
  // A single register write also works if auto-increment configuration is lost.
  // Unlike OE, this cannot inhibit outputs when I2C communication is broken.
  return writeRegister(0xFD, 0x10);
}

uint16_t pulseTicks(uint16_t microseconds) {
  // Count period = (PRESCALE+1)/25 microseconds; nearest-count rounding.
  return ((uint32_t)microseconds * 25 + (PRESCALE + 1) / 2) / (PRESCALE + 1);
}

bool pulse(uint8_t channel, uint16_t microseconds) {
  return channelPWM(channelMap[channel], pulseTicks(microseconds));
}

bool startChannels(uint8_t mask, const uint16_t *pose) {
  // Noncontiguous ports after remapping: short sequential writes, then all hold.
  // allOff() ran first so every unselected/unused physical port stays FULL_OFF.
  for (uint8_t ch = 0; ch < 6; ++ch) {
    if ((mask & (1 << ch)) && !pulse(ch,pose[ch])) return false;
  }
  return true;
}

void status() {
  Serial.print(F("STATE4 ")); Serial.print(ready ? 1 : 0);
  Serial.print(' '); Serial.print(activeMask);
  Serial.print(' '); Serial.print(MIN_US);
  Serial.print(' '); Serial.print(MAX_US);
  Serial.print(' '); Serial.print(WATCHDOG_MS);
  Serial.print(' '); Serial.print(outputKnown ? 1 : 0);
  for (uint8_t ch = 0; ch < 6; ++ch) { Serial.print(' '); Serial.print(applied[ch]); }
  for (uint8_t ch = 0; ch < 6; ++ch) { Serial.print(' '); Serial.print(target[ch]); }
  for (uint8_t ch = 0; ch < 6; ++ch) { Serial.print(' '); Serial.print(channelMap[ch]); }
  for (uint8_t ch = 0; ch < 6; ++ch) { Serial.print(' '); Serial.print(lowerUs[ch]); }
  for (uint8_t ch = 0; ch < 6; ++ch) { Serial.print(' '); Serial.print(upperUs[ch]); }
  Serial.println();
}

void disableOutput(const __FlashStringHelper *reason) {
  streaming = false;
  activeMask = 0;
  outputKnown = allOff();
  if (!outputKnown) ready = false;
  Serial.print(F("OFF ")); Serial.println(reason);
  status();
}

void fault(const __FlashStringHelper *reason) {
  streaming = false;
  activeMask = 0; ready = false;
  outputKnown = allOff(); // Best effort only; failure must remain visible.
  Serial.print(F("FAULT ")); Serial.println(reason); status();
}

bool healthy() {
  uint8_t mode1, mode2, prescale;
  if (!readRegister(0x00, mode1) || !readRegister(0x01, mode2) ||
      !readRegister(0xFE, prescale)) return false;
  // AI enabled, internal oscillator awake, all/sub-call disabled.
  return (mode1 & 0x7F) == 0x20 && mode2 == 0x04 && prescale == PRESCALE;
}

void initializePCA() {
  streaming = false;
  bodyStepUs = STEP_US;
  activeMask = 0; ready = false; outputKnown = false;
#ifdef WIRE_HAS_TIMEOUT
  Wire.clearWireTimeoutFlag();
#endif
  Wire.beginTransmission(PCA_ADDRESS);
  if (Wire.endTransmission() != 0) { fault(F("PCA_NOT_FOUND_0x40")); return; }
  // Stop existing PWM before sleep/wake. Keep servo PSU OFF during setup.
  if (!allOff() || !writeRegister(0x00, 0x30) || !writeRegister(0x01, 0x04) ||
      !writeRegister(0xFE, PRESCALE) || !allOff() ||
      !writeRegister(0x00, 0x20)) { fault(F("PCA_WRITE_FAILED")); return; }
  delay(1); // oscillator wake-up >= 500 us
  if (!healthy()) { fault(F("PCA_CONFIG_CHECK_FAILED")); return; }
  ready = true; outputKnown = true;
  for (uint8_t ch = 0; ch < 6; ++ch) applied[ch] = target[ch] = START_US;
  Serial.println(F("READY ARM_BENCH_V4_ANGLE")); status();
}

void freezeMotion(const __FlashStringHelper *reason) {
  streaming = false;
  for (uint8_t ch = 0; ch < 6; ++ch) target[ch] = applied[ch];
  Serial.print(F("FROZEN ")); Serial.println(reason);
  status(); // Maintains commanded PWM, not measured physical position.
}

bool number(const char *text, long &result) {
  if (!text || !*text) return false;
  for (const char *p = text; *p; ++p) if (*p < '0' || *p > '9') return false;
  errno = 0; char *end;
  result = strtol(text, &end, 10);
  return errno != ERANGE && *end == '\0' && result >= 0;
}

void reject(const __FlashStringHelper *reason) {
  // Request OFF on malformed/rejected commands; a broken bus may prevent it.
  disableOutput(F("REJECTED_COMMAND"));
  Serial.print(F("ERR ")); Serial.println(reason);
}

void armChannels(uint8_t mask, const uint16_t *pose) {
  if (!ready || !outputKnown || activeMask != 0 || !mask || mask > 63) {
    reject(F("ARM_REQUIRES_OFF")); return;
  }
  for (uint8_t ch = 0; ch < 6; ++ch) {
    if ((mask & (1 << ch)) && (pose[ch] < lowerUs[ch] || pose[ch] > upperUs[ch])) {
      reject(F("POSE_JOINT_LIMITS")); return;
    }
  }
  if (!healthy() || !allOff() || !startChannels(mask, pose)) { fault(F("PCA_ARM_FAILED")); return; }
  for (uint8_t ch = 0; ch < 6; ++ch) applied[ch] = target[ch] = pose[ch];
  activeMask = mask; lastPing = lastStep = millis(); outputKnown = true;
  Serial.println(F("OK ARM")); status();
}

void command(char *line) {
  char *words[8]; uint8_t n = 0; char *ctx;
  for (char *p = strtok_r(line, " \t", &ctx); p; p = strtok_r(NULL, " \t", &ctx)) {
    if (n == 8) { reject(F("SYNTAX")); return; }
    words[n++] = p;
  }
  if (!n) return;
  if (n == 1 && !strcmp(words[0], "STOP")) { disableOutput(F("USER")); return; }
  if (n == 1 && !strcmp(words[0], "INIT")) { initializePCA(); return; }
  if (n == 1 && !strcmp(words[0], "HELLO")) {
    Serial.println(F("HELLO ARM_BENCH_V4_ANGLE"));
    Serial.println(F("CAPS BODY_STREAM_V1"));
    Serial.println(F("CAPS BODY_SPEED_V2"));
    Serial.println(F("CAPS BODY_SPEED_V3")); status(); return;
  }
  if (n == 1 && !strcmp(words[0], "PING")) {
    lastPing = millis(); Serial.println(F("PONG")); return;
  }
  if (n == 1 && !strcmp(words[0], "FREEZE")) {
    if (!ready || !outputKnown) { reject(F("FREEZE_NOT_READY")); return; }
    freezeMotion(F("USER")); return;
  }
  long ch = -1, us = -1;
  long high = -1;
  if (n == 2 && !strcmp(words[0], "SPEED") && number(words[1], us)) {
    if (!ready || !outputKnown || activeMask || us < 100 || us > 1200 || us % 50 != 0) {
      reject(F("SPEED_REQUIRES_OFF_100_1200_MULTIPLE_50")); return;
    }
    bodyStepUs = (uint16_t)(us / 50);
    Serial.print(F("OK SPEED ")); Serial.println(us); return;
  }
  if (n == 4 && !strcmp(words[0], "LIMIT") && number(words[1], ch) &&
      number(words[2], us) && number(words[3], high)) {
    if (!ready || !outputKnown || activeMask || ch > 5 || us < MIN_US ||
        us > START_US || high < START_US || high > MAX_US || us >= high) {
      reject(F("LIMIT_REQUIRES_OFF_500_2500_INCLUDING_1500")); return;
    }
    if (!healthy() || !allOff()) { fault(F("PCA_LIMIT_FAILED")); return; }
    lowerUs[ch] = (uint16_t)us; upperUs[ch] = (uint16_t)high;
    Serial.println(F("OK LIMIT")); status(); return;
  }
  if (n == 3 && !strcmp(words[0], "MAP") && number(words[1], ch) && number(words[2], us)) {
    if (!ready || !outputKnown || activeMask || ch > 5 || us > 15) { reject(F("MAP_REQUIRES_OFF_AND_PORT_0_15")); return; }
    for (uint8_t i = 0; i < 6; ++i) if (i != ch && channelMap[i] == us) { reject(F("MAP_PORT_OCCUPIED")); return; }
    if (!healthy() || !allOff()) { fault(F("PCA_MAP_FAILED")); return; }
    channelMap[ch] = (uint8_t)us; outputKnown = true;
    Serial.println(F("OK MAP")); status(); return;
  }
  uint16_t pose[6] = {1500, 1500, 1500, 1500, 1500, 1500};
  if (n == 8 && !strcmp(words[0], "MOVE")) {
    if (!number(words[1], ch) || ch != 31 || activeMask != 31 || !ready || !outputKnown) {
      reject(F("MOVE_REQUIRES_ACTIVE_MASK_31")); return;
    }
    for (uint8_t i = 0; i < 6; ++i) {
      if (!number(words[i + 2], us) || us < MIN_US || us > MAX_US ||
          (i < 5 && (us < lowerUs[i] || us > upperUs[i]))) {
        reject(F("MOVE_JOINT_LIMITS")); return;
      }
      pose[i] = (uint16_t)us;
    }
    for (uint8_t i = 0; i < 5; ++i) target[i] = pose[i];
    streaming = true; lastMove = millis();
    Serial.println(F("OK MOVE")); status(); return;
  }
  // HOLD: 1500us. POSE: explicitly supplied zeros; no EEPROM auto-replay.
  if ((n == 2 && !strcmp(words[0], "HOLD")) || (n == 8 && !strcmp(words[0], "POSE"))) {
    if (!number(words[1], ch) || (ch != 31 && ch != 63)) { reject(F("HOLD_MASK_31_OR_63")); return; }
    if (n == 8) for (uint8_t i = 0; i < 6; ++i) {
      if (!number(words[i + 2], us) || us < MIN_US || us > MAX_US) { reject(F("POSE_LIMITS")); return; }
      pose[i] = (uint16_t)us;
    }
    armChannels((uint8_t)ch, pose); return;
  }
  if (n == 3 && !strcmp(words[0], "ARM") && number(words[1], ch) && number(words[2], us)) {
    if (ch > 5 || us != START_US) { reject(F("ARM_REQUIRES_CHANNEL_0_5_AND_1500")); return; }
    armChannels((uint8_t)(1 << ch), pose); return;
  }
  if (n == 3 && !strcmp(words[0], "SET") && number(words[1], ch) && number(words[2], us)) {
    if (!ready || !outputKnown || ch > 5 || !(activeMask & (1 << ch)) || us < lowerUs[ch] || us > upperUs[ch]) {
      reject(F("SET_REQUIRES_ACTIVE_CHANNEL_AND_LIMITS")); return;
    }
    target[ch] = (uint16_t)us;
    Serial.println(F("OK SET")); status(); return;
  }
  reject(F("SYNTAX"));
}

void setup() {
  Serial.begin(115200);
  Serial.println(F("HELLO ARM_BENCH_V4_ANGLE"));
  Wire.begin(); Wire.setClock(100000);
#ifdef WIRE_HAS_TIMEOUT
  Wire.setWireTimeout(25000, true);
#endif
  initializePCA();
}

void loop() {
  uint32_t now = millis();
  if (streaming && now - lastMove >= STREAM_TIMEOUT_MS) freezeMotion(F("STREAM_TIMEOUT"));
  // Check deadline before accepting late PING bytes.
  if (activeMask && now - lastPing >= WATCHDOG_MS) disableOutput(F("TIMEOUT"));
  if (inputLen && now - lastByte > 500) {
    inputLen = 0; discardLine = true; disableOutput(F("PARTIAL_LINE_TIMEOUT"));
  }
  // Bounded receive work so a continuously transmitting host cannot starve checks.
  for (uint8_t count = 0; count < 32 && Serial.available(); ++count) {
    char c = Serial.read(); lastByte = millis();
    if (c == '!') {
      inputLen = 0; discardLine = true; disableOutput(F("EMERGENCY")); continue;
    }
    if (c == '\r') continue;
    if (c == '\n') {
      if (!discardLine) { input[inputLen] = '\0'; command(input); }
      inputLen = 0; discardLine = false;
    } else if (!discardLine) {
      if (c < 32 || c > 126 || inputLen >= sizeof(input) - 1) {
        inputLen = 0; discardLine = true; disableOutput(F("BAD_SERIAL_FRAME"));
      } else input[inputLen++] = c;
    }
  }
  now = millis();
  if (ready && now - lastHealth >= 500) {
    lastHealth = now;
    if (!healthy()) fault(F("PCA_CONNECTION_OR_CONFIG_LOST"));
  }
  if (activeMask && now - lastStep >= STEP_MS) {
    lastStep = now;
    const uint16_t stepUs = streaming ? bodyStepUs : STEP_US;
    bool changed = false, moving = false;
    for (uint8_t ch = 0; ch < 6; ++ch) {
      if (!(activeMask & (1 << ch)) || applied[ch] == target[ch]) continue;
      changed = true;
      if (applied[ch] < target[ch]) applied[ch] += min((uint16_t)(target[ch] - applied[ch]), stepUs);
      else applied[ch] -= min((uint16_t)(applied[ch] - target[ch]), stepUs);
      if (!pulse(ch, applied[ch])) { fault(F("PCA_MOVE_FAILED")); break; }
      if (applied[ch] != target[ch]) moving = true;
    }
    // Tell the host as soon as the bounded segment ends. Waiting for the
    // periodic 50ms status here caused a repeated pause between MOVE segments.
    if (streaming && changed && !moving) { lastStatus = now; status(); }
  }
  if (now - lastStatus >= (streaming ? 50UL : 250UL)) { lastStatus = now; status(); }
}
