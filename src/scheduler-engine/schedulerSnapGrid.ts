/**
 * 스케줄러 Snap Grid
 *
 * 순수 계산 모듈. Vue 의존성 없음.
 * 마우스 좌표에서 변환된 분(minute) 값을 지정 간격으로 snap한다.
 */

import type { SnapConfig } from './types/scheduler.types'
import { STEP_MIN } from '@/constants/componentConstants'

/** 기본 snap 설정 — 예약 단위는 예약 팝업의 STEP_MIN 이 원본이고 여기서 파생한다(값을 두 번 적지 않는다). */
export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  intervalMinutes: STEP_MIN,
}

/** step 격자로 내림. 드롭 보정·resize 가 같은 연산을 쓴다 — 각자 Math.floor 를 들고 있으면 한쪽만 고쳐진다. */
export function floorToStep(minute: number, step: number): number {
  return Math.floor(minute / step) * step
}

/** step 격자로 올림. */
export function ceilToStep(minute: number, step: number): number {
  return Math.ceil(minute / step) * step
}

/**
 * 분 값을 snap 간격에 맞춰 반올림 (드래그·resize 의 마우스 위치 → 격자)
 *
 * 예: rawMinute=637, interval=10 → 640 (10:40)
 */
export function snapMinute(rawMinute: number, config: SnapConfig): number {
  const interval = config.intervalMinutes
  if (interval <= 0) return rawMinute
  return Math.round(rawMinute / interval) * interval
}

/** 하루의 분 수. 자정(24:00)은 저장 가능한 시각이 아니다 — 아래 LAST_MINUTE_OF_DAY 로 표현한다. */
export const DAY_MINUTES = 24 * 60
/** 하루의 마지막 분(23:59). 예약 수정 화면이 23:30 시작의 종료를 23:59 로 두는 것과 같은 예외. */
export const LAST_MINUTE_OF_DAY = DAY_MINUTES - 1

/**
 * 격자 위의 종료 분에 하루 끝 규칙을 적용한다 — 드롭·변경 커밋·resize 가 모두 여기를 지난다.
 *
 * 예약 수정 화면의 규칙(`reservationTimeRules.getEndOptionsByStart`)을 분 단위로 옮긴 것이다:
 *   - 종료 옵션은 마지막 시작 칸(24:00 − step)까지가 기본이고
 *   - 시작이 그 한 칸 앞(24:00 − 2·step) 이상이면 23:59 를 종료로 고를 수 있다
 * 그래서 자정에 닿는 종료는 시작이 그 구간이면 23:59, 아니면 마지막 칸(23:30)으로 내려온다.
 * 입력이 이미 23:59 인 예약도 같은 조건에서만 23:59 를 유지한다(밖이면 내림).
 */
export function clampEndToDay(startMinute: number, endMinute: number, step: number): number {
  const canEndAtLastMinute = startMinute >= DAY_MINUTES - 2 * step
  if (endMinute >= DAY_MINUTES) return canEndAtLastMinute ? LAST_MINUTE_OF_DAY : DAY_MINUTES - step
  if (endMinute >= LAST_MINUTE_OF_DAY && !canEndAtLastMinute) return DAY_MINUTES - step
  return endMinute
}

/**
 * 예약 시간 범위를 예약 단위 격자에 맞춘다.
 *
 * ⭐이 규칙의 SSOT 는 예약 수정 화면(`reservationTimeRules.normalizeTimeStrings`)이다.
 *   화면은 "HH:mm 옵션 목록"으로, 여기서는 "분"으로 같은 규칙을 편다 —
 *   표현이 달라 함수를 합칠 수 없으므로 같은 입력에 같은 답을 내는지 계약 테스트
 *   (`schedulerSnapGrid.contract.test.ts`)로 묶는다.
 *
 * 규칙 (수정 화면과 동일):
 *   - 시작은 격자로 **내림**, 마지막 시작 칸(24:00 − step)을 넘지 않는다
 *   - 종료도 격자로 **내림**, 단 입력이 23:59 면 그대로 둔다(마지막 칸 예외 후보)
 *   - 내림 결과 종료가 시작 이하면 종료를 한 칸(= step) 뒤로 → 최소 한 칸 보장
 *   - 하루 끝 규칙(`clampEndToDay`)으로 자정을 23:59 또는 마지막 칸으로 되돌린다
 */
export function normalizeRangeToGrid(
  startMinute: number,
  endMinute: number,
  step: number,
): { startMinute: number; endMinute: number } {
  if (step <= 0) return { startMinute, endMinute }

  const start = Math.min(floorToStep(startMinute, step), DAY_MINUTES - step)
  let end = endMinute >= LAST_MINUTE_OF_DAY ? endMinute : floorToStep(endMinute, step)
  if (end <= start) end = start + step
  end = clampEndToDay(start, end, step)

  return { startMinute: start, endMinute: end }
}
