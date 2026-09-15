/**
 * schedulerSnapGrid — 하루 끝(자정) 규칙
 *
 * 시간축을 ∨ 로 24:00 까지 늘리면 드래그·변경 커밋·resize 가 종료 1440(24:00) 을 만들 수 있다.
 * 1440 은 `T24:00:00` 으로 나가는데 예약 수정 화면은 그 시각을 표현하지 못한다 — 화면의 하루 끝은
 * 마지막 시작 칸(23:30)과, 시작이 23:00 이상일 때만 고를 수 있는 23:59 다.
 *
 * 그래서 보드의 저장 경로도 같은 두 값으로만 하루를 닫는다:
 *   - 시작 ≥ 24:00 − 2·step(23:00) → 종료 23:59
 *   - 그보다 이르면 → 종료는 마지막 칸(23:30)
 * 입력이 이미 23:59 인 예약(화면에서 만든 것)도 같은 조건에서만 23:59 를 유지한다.
 *
 * 기대값은 화면 규칙에서 다시 쓴 것이다 — 구현에서 복사하지 않았다. 화면과 같은 답인지는
 * `schedulerSnapGrid.contract.test.ts` 가 묶는다.
 */

import { describe, expect, it } from 'vitest'
import { clampEndToDay, normalizeRangeToGrid, LAST_MINUTE_OF_DAY } from '../schedulerSnapGrid'

const STEP = 30

/** 22:00=1320 22:30=1350 23:00=1380 23:30=1410 23:45=1425 23:59=1439 24:00=1440 */
describe('normalizeRangeToGrid — 자정에 닿는 예약', () => {
  it('🔑 23:30~24:00 은 23:30~23:59 로 닫는다 (24:00 은 저장 시각이 아니다)', () => {
    expect(normalizeRangeToGrid(1410, 1440, STEP))
      .toEqual({ startMinute: 1410, endMinute: 1439 })
  })

  it('🔑 화면에서 만든 23:00~23:59 는 그대로 둔다 — 이동해도 59분이 30분으로 줄지 않는다', () => {
    expect(normalizeRangeToGrid(1380, 1439, STEP))
      .toEqual({ startMinute: 1380, endMinute: 1439 })
  })

  it('23:00~24:00 은 23:59 로 닫는다 (시작이 23:00 이상이라 23:59 를 고를 수 있는 구간)', () => {
    expect(normalizeRangeToGrid(1380, 1440, STEP))
      .toEqual({ startMinute: 1380, endMinute: 1439 })
  })

  it('22:00~23:59 는 22:00~23:30 — 시작이 23:00 앞이면 23:59 는 고를 수 없는 종료다', () => {
    expect(normalizeRangeToGrid(1320, 1439, STEP))
      .toEqual({ startMinute: 1320, endMinute: 1410 })
  })

  it('22:00~24:00 은 22:00~23:30 으로 닫는다', () => {
    expect(normalizeRangeToGrid(1320, 1440, STEP))
      .toEqual({ startMinute: 1320, endMinute: 1410 })
  })

  it('23:00~23:45 는 23:00~23:30 — 23:59 가 아닌 격자 밖 종료는 평소처럼 내린다', () => {
    expect(normalizeRangeToGrid(1380, 1425, STEP))
      .toEqual({ startMinute: 1380, endMinute: 1410 })
  })

  it('밴드 맨 아래(24:00)에 놓인 시작은 마지막 시작 칸 23:30 으로 되돌리고 종료는 23:59', () => {
    expect(normalizeRangeToGrid(1440, 1470, STEP))
      .toEqual({ startMinute: 1410, endMinute: 1439 })
  })
})

describe('clampEndToDay — 하루 끝 규칙 하나를 드롭·resize 가 함께 쓴다', () => {
  it.each([
    // [시작, 종료, 기대] — 종료가 자정이면 시작 구간에 따라 23:59 또는 23:30
    [1410, 1440, LAST_MINUTE_OF_DAY],
    [1380, 1440, LAST_MINUTE_OF_DAY],
    [1350, 1440, 1410],
    // 이미 23:59 인 종료는 시작이 23:00 앞이면 23:30 으로 내린다
    [1380, 1439, LAST_MINUTE_OF_DAY],
    [1320, 1439, 1410],
    // 자정에 닿지 않는 종료는 건드리지 않는다
    [540, 600, 600],
    [1380, 1410, 1410],
  ])('시작 %i · 종료 %i → %i', (start, end, expected) => {
    expect(clampEndToDay(start, end, STEP)).toBe(expected)
  })
})
