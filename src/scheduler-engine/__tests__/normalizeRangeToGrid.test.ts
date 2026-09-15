/**
 * normalizeRangeToGrid — 격자 밖 예약을 옮길 때의 30분 보정
 *
 * 예약 수정 화면(ReservationPopup.normalizeTimeRange)이 이미 하고 있는 보정을
 * 보드의 이동(드래그 drop · 변경 모드 커밋) 저장 경로에도 같은 규칙으로 편 것이다.
 * 그래서 기대값은 "수정 화면에서 그 예약을 열었을 때 나오는 값"과 같아야 한다.
 *
 * 수정 화면 규칙 (실측):
 *   - 시작: 30분 옵션 중 그 이하로 가장 가까운 값(내림)
 *   - 종료: (시작+30분) 이상인 30분 옵션 중 내림
 *   - 내림 결과가 시작 이하면 → 시작+30분
 *   - 23:30 시작은 종료 23:59 (마지막 칸 예외)
 */

import { describe, expect, it } from 'vitest'
import { normalizeRangeToGrid } from '../schedulerSnapGrid'

const STEP = 30

/** 09:00=540 09:30=570 10:00=600 10:20=620 */
describe('normalizeRangeToGrid — 예약 수정 화면과 같은 보정', () => {
  it('🔑 09:40~10:20 → 09:30~10:00 (수정 화면과 동일)', () => {
    expect(normalizeRangeToGrid(580, 620, STEP))
      .toEqual({ startMinute: 570, endMinute: 600 })
  })

  it('🔑 내림하면 30분이 안 되는 09:40~09:50 → 09:30~10:00', () => {
    expect(normalizeRangeToGrid(580, 590, STEP))
      .toEqual({ startMinute: 570, endMinute: 600 })
  })

  it('시작만 격자 밖인 경우도 종료를 내림한다 — 09:00~09:40 → 09:00~09:30', () => {
    expect(normalizeRangeToGrid(540, 580, STEP))
      .toEqual({ startMinute: 540, endMinute: 570 })
  })

  it('이미 격자 위인 예약은 그대로 둔다', () => {
    expect(normalizeRangeToGrid(540, 600, STEP))
      .toEqual({ startMinute: 540, endMinute: 600 })
  })

  it('변경 모드에서 10분 눈금 칸(09:10)을 골라도 09:00 으로 내린다', () => {
    expect(normalizeRangeToGrid(550, 580, STEP))
      .toEqual({ startMinute: 540, endMinute: 570 })
  })

  it('🔑 자정을 넘길 상황은 23:59 로 막는다 (수정 화면의 마지막 칸 예외)', () => {
    // 23:40~23:50 → 시작 23:30, 종료 내림하면 23:30 = 시작 → 24:00 이 아니라 23:59
    expect(normalizeRangeToGrid(1420, 1430, STEP))
      .toEqual({ startMinute: 1410, endMinute: 1439 })
  })

  it('step 이 0 이하이면 아무것도 바꾸지 않는다', () => {
    expect(normalizeRangeToGrid(580, 620, 0))
      .toEqual({ startMinute: 580, endMinute: 620 })
  })
})
