/**
 * 스케줄러 Snap Grid
 *
 * 순수 계산 모듈. Vue 의존성 없음.
 * 마우스 좌표에서 변환된 분(minute) 값을 지정 간격으로 snap한다.
 */

import type { SnapConfig } from './types/scheduler.types'

/** 기본 snap 설정 (예약은 30분 단위) */
export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  intervalMinutes: 30,
  fineIntervalMinutes: 5,
}

/**
 * 분 값을 snap 간격에 맞춰 반올림
 *
 * @param rawMinute - snap 전 원본 분
 * @param config - snap 설정
 * @param isFine - Shift 키 누름 여부 (세밀 모드)
 * @returns snap 적용된 분
 *
 * 예: rawMinute=637, interval=10 → 640 (10:40)
 * 예: rawMinute=637, fineInterval=5, isFine=true → 635 (10:35)
 */
export function snapMinute(
  rawMinute: number,
  config: SnapConfig,
  isFine: boolean
): number {
  const interval = isFine ? config.fineIntervalMinutes : config.intervalMinutes
  if (interval <= 0) return rawMinute
  return Math.round(rawMinute / interval) * interval
}

/**
 * 분 값을 snap 간격에 맞춰 내림 (시작 시간용)
 */
export function snapMinuteFloor(
  rawMinute: number,
  config: SnapConfig,
  isFine: boolean
): number {
  const interval = isFine ? config.fineIntervalMinutes : config.intervalMinutes
  if (interval <= 0) return rawMinute
  return Math.floor(rawMinute / interval) * interval
}

/**
 * 분 값을 snap 간격에 맞춰 올림 (종료 시간용)
 */
export function snapMinuteCeil(
  rawMinute: number,
  config: SnapConfig,
  isFine: boolean
): number {
  const interval = isFine ? config.fineIntervalMinutes : config.intervalMinutes
  if (interval <= 0) return rawMinute
  return Math.ceil(rawMinute / interval) * interval
}
