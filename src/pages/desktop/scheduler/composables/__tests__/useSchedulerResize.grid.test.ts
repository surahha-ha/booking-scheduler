/**
 * resolveResizeRange — resize 도 등록/수정과 같은 30분(STEP_MIN) 예약 단위로만 놓인다
 *
 * 예전에는 움직이는 끝을 30분에 snap 해 놓고도 최소 시간이 10분이라,
 * 핸들을 anchor 쪽으로 바짝 끌면 `anchor ± 10분` 으로 붙잡혀
 * 등록/수정 화면에서는 고를 수 없는 시각(예: 09:50)이 만들어졌다.
 *
 * 규약:
 * - 움직이는 끝은 언제나 step 그리드 위에 있다 — 최소/최대로 붙잡을 때도 마찬가지
 * - 최소 시간보다 짧게 끌면 isUnderMin=true → 호출부가 invalid(빨간 점선) 로 표시하고 확정하지 않는다
 */

import { describe, expect, it } from 'vitest'
import { resolveResizeRange } from '../useSchedulerResize'

const LIMITS = { step: 30, minDuration: 30, maxDuration: 480 }

/** 09:00 = 540, 09:30 = 570, 10:00 = 600 */
describe('resolveResizeRange — bottom handle (start 고정)', () => {
  it('snap 된 위치를 그대로 종료시각으로 쓴다', () => {
    expect(resolveResizeRange(540, 660, 'bottom', LIMITS))
      .toEqual({ startMinute: 540, endMinute: 660, isUnderMin: false })
  })

  it('최소 시간과 정확히 같은 30분은 유효하다', () => {
    expect(resolveResizeRange(540, 570, 'bottom', LIMITS))
      .toEqual({ startMinute: 540, endMinute: 570, isUnderMin: false })
  })

  it('🔑 30분보다 짧게 끌면 30분으로 붙잡고 isUnderMin 을 세운다', () => {
    expect(resolveResizeRange(540, 540, 'bottom', LIMITS))
      .toEqual({ startMinute: 540, endMinute: 570, isUnderMin: true })
  })

  it('anchor 를 지나 위로 올려도 30분 아래로는 내려가지 않는다', () => {
    expect(resolveResizeRange(540, 480, 'bottom', LIMITS))
      .toEqual({ startMinute: 540, endMinute: 570, isUnderMin: true })
  })

  it('최대 시간을 넘기면 최대에서 멈춘다', () => {
    expect(resolveResizeRange(540, 1200, 'bottom', LIMITS))
      .toEqual({ startMinute: 540, endMinute: 1020, isUnderMin: false })
  })
})

describe('resolveResizeRange — top handle (end 고정)', () => {
  it('snap 된 위치를 그대로 시작시각으로 쓴다', () => {
    expect(resolveResizeRange(600, 480, 'top', LIMITS))
      .toEqual({ startMinute: 480, endMinute: 600, isUnderMin: false })
  })

  it('🔑 30분보다 짧게 끌면 30분으로 붙잡고 isUnderMin 을 세운다', () => {
    expect(resolveResizeRange(600, 600, 'top', LIMITS))
      .toEqual({ startMinute: 570, endMinute: 600, isUnderMin: true })
  })

  it('최대 시간을 넘기면 최대에서 멈춘다', () => {
    expect(resolveResizeRange(600, 0, 'top', LIMITS))
      .toEqual({ startMinute: 120, endMinute: 600, isUnderMin: false })
  })
})

describe('resolveResizeRange — anchor 가 그리드 밖인 예약(외부 유입분)', () => {
  // 09:40(580) 종료인 예약의 top 핸들을 바짝 끌어올린 경우.
  // anchor - minDuration = 550(09:10) 은 그리드 밖이므로 그 아래 그리드인 540(09:00)으로 붙잡는다.
  it('🔑 붙잡히는 값도 그리드 위에 놓는다 — top', () => {
    expect(resolveResizeRange(580, 600, 'top', LIMITS))
      .toEqual({ startMinute: 540, endMinute: 580, isUnderMin: true })
  })

  // 09:40(580) 시작인 예약의 bottom 핸들. 580 + 30 = 610 은 그리드 밖 → 그 위 그리드인 630(10:30).
  it('🔑 붙잡히는 값도 그리드 위에 놓는다 — bottom', () => {
    expect(resolveResizeRange(580, 570, 'bottom', LIMITS))
      .toEqual({ startMinute: 580, endMinute: 630, isUnderMin: true })
  })
})

/**
 * 하루 끝 — 시간축을 24:00 까지 늘린 뒤 핸들을 맨 아래로 끌면 snap 값이 1440(24:00) 이다.
 * 24:00 은 저장 시각이 아니고, 예약 수정 화면은 그 자리를 23:59(시작 23:00 이상) 또는
 * 마지막 칸 23:30 으로 닫는다. resize 도 같은 값으로 닫는다.
 *   22:30=1350 23:00=1380 23:30=1410 23:59=1439 24:00=1440
 */
describe('resolveResizeRange — 하루 끝(자정)', () => {
  it('🔑 23:30 예약을 24:00 까지 늘리면 23:59 로 닫고, 한 칸 예외이므로 최소 시간 미달이 아니다', () => {
    expect(resolveResizeRange(1410, 1440, 'bottom', LIMITS))
      .toEqual({ startMinute: 1410, endMinute: 1439, isUnderMin: false })
  })

  it('23:00 예약을 24:00 까지 늘리면 23:59', () => {
    expect(resolveResizeRange(1380, 1440, 'bottom', LIMITS).endMinute).toBe(1439)
  })

  it('22:30 예약을 24:00 까지 늘리면 23:59 는 고를 수 없는 종료라 23:30 에서 멈춘다', () => {
    expect(resolveResizeRange(1350, 1440, 'bottom', LIMITS))
      .toEqual({ startMinute: 1350, endMinute: 1410, isUnderMin: false })
  })

  it('🔑 23:30~23:59 예약의 top 핸들 — 종료 23:59 는 자정으로 세어 23:30 시작을 유지할 수 있다', () => {
    // 23:59 를 글자 그대로 세면 최소 30분을 지키는 가장 늦은 시작이 23:00 이 되어
    // 핸들을 놓기만 해도 예약이 한 칸 길어졌다.
    expect(resolveResizeRange(1439, 1410, 'top', LIMITS))
      .toEqual({ startMinute: 1410, endMinute: 1439, isUnderMin: false })
  })
})
