/**
 * schedulerSnapGrid — 격자 연산은 한 벌이다
 *
 * 30분 격자로 내림·올림하는 연산이 세 자리에 각자 있었다(엔진의 snapMinuteFloor/Ceil · 드롭 보정의
 * Math.floor · resize 의 floorTo/ceilTo). 값이 같아 보여도 한쪽만 고쳐지면 드롭과 resize 가 다른
 * 시각에 놓인다. 여기서는 엔진이 내놓는 step 단위 연산 하나를 고정하고, 드롭·resize 가 그것을 쓴다.
 *
 * 예약 단위(30분)도 한 번만 적는다 — 예약 팝업의 STEP_MIN 이 원본이고 엔진 기본 snap 은 거기서 파생한다.
 * Shift 세밀 모드(5분)는 호출자가 전부 끈 채라 설정에서 뺐다.
 */

import { describe, expect, it } from 'vitest'
import { STEP_MIN } from '@/constants/componentConstants'
import {
  ceilToStep,
  DEFAULT_SNAP_CONFIG,
  floorToStep,
  normalizeRangeToGrid,
  snapMinute,
} from '../schedulerSnapGrid'

describe('floorToStep / ceilToStep — step 격자 연산', () => {
  it.each([
    [554, 30, 540],   // 09:14 → 09:00
    [555, 30, 540],   // 09:15 → 09:00
    [570, 30, 570],   // 격자 위는 그대로
    [610, 30, 600],   // 10:10 → 10:00
    [1439, 30, 1410], // 23:59 → 23:30
  ])('floorToStep(%i, %i) = %i', (minute, step, expected) => {
    expect(floorToStep(minute, step)).toBe(expected)
  })

  it.each([
    [554, 30, 570],   // 09:14 → 09:30
    [570, 30, 570],   // 격자 위는 그대로
    [610, 30, 630],   // 10:10 → 10:30
    [1411, 30, 1440], // 23:31 → 24:00 (하루 끝 처리는 clampEndToDay 몫)
  ])('ceilToStep(%i, %i) = %i', (minute, step, expected) => {
    expect(ceilToStep(minute, step)).toBe(expected)
  })
})

describe('예약 단위는 한 번만 적는다', () => {
  it('엔진 기본 snap 간격은 예약 팝업의 STEP_MIN 에서 파생한다', () => {
    expect(DEFAULT_SNAP_CONFIG.intervalMinutes).toBe(STEP_MIN)
  })

  it('세밀 모드 설정은 없다 — 호출자가 전부 끄고 있던 죽은 설정', () => {
    expect(DEFAULT_SNAP_CONFIG).toEqual({ intervalMinutes: STEP_MIN })
  })

  it('snapMinute 은 설정만 받는다 (Shift 인자 없음)', () => {
    expect(snapMinute(637, { intervalMinutes: 10 })).toBe(640)
    expect(snapMinute.length).toBe(2)
  })
})

describe('드롭 보정이 같은 step 연산을 쓴다', () => {
  it('09:14~09:44 → floorToStep 결과와 같은 09:00~09:30', () => {
    expect(normalizeRangeToGrid(554, 584, 30))
      .toEqual({ startMinute: floorToStep(554, 30), endMinute: floorToStep(584, 30) })
  })
})
