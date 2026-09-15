/**
 * minuteToBandOffsetPx — 현재 시각선처럼 band 경계에 걸리지 않는 분의 좌표.
 *
 * band 시작 경계로 snap 하면(minuteToBandTopPx) 예약단위가 커질수록 선이 위로 밀린다.
 * 예약단위 45분에서 11:03 선이 10:30 자리에 그려진 건이 이 규칙이 없어서 났다.
 */
import { describe, expect, it } from 'vitest'
import { minuteToBandOffsetPx, minuteToBandTopPx } from '../schedulerHitTest'
import type { BandCompatible } from '../types/scheduler.types'

/**
 * 예약단위 45분 · 결함 캡처의 실제 band 배치.
 * 09:45 는 예약 없는 운영 band(1행), 10:30 은 카드 1장이 있어 1행 + 하단 여백만큼 높다.
 * band 높이가 시간에 비례하지 않는다는 점을 일부러 담은 배치다.
 */
const BANDS_45: BandCompatible[] = [
  { startMinute: 585, endMinute: 630, topPx: 181, heightPx: 50 },
  { startMinute: 630, endMinute: 675, topPx: 231, heightPx: 74 },
]

describe('minuteToBandOffsetPx — band 내부 시간 비례 보간', () => {
  it('band 중간의 분은 경과 비율만큼 내려온 좌표를 준다', () => {
    // 11:03 은 10:30~11:15 band 를 33/45 지난 지점 → 그 band 높이의 33/45 만큼 아래.
    const expected = 231 + (33 / 45) * 74
    expect(minuteToBandOffsetPx(663, BANDS_45)).toBeCloseTo(expected)
  })

  it('band 시작 경계에서는 snap 방식과 같은 좌표를 준다', () => {
    expect(minuteToBandOffsetPx(630, BANDS_45)).toBe(231)
    expect(minuteToBandOffsetPx(630, BANDS_45)).toBe(minuteToBandTopPx(630, BANDS_45))
  })

  it('예약단위가 커져도 선이 band 상단으로 밀리지 않는다', () => {
    // 같은 11:03 을 snap 으로 구하면 10:30 자리(231)에 머문다 — 33분어치가 사라진다.
    expect(minuteToBandTopPx(663, BANDS_45)).toBe(231)
    expect(minuteToBandOffsetPx(663, BANDS_45)).toBeGreaterThan(231)
  })

  it('band 이 좁을수록 snap 과의 차이가 줄어든다', () => {
    // 예약단위 10분이면 같은 11:03 도 band 상단에서 3/10 지점이라 오차가 눈에 띄지 않았다.
    const bands10: BandCompatible[] = [
      { startMinute: 660, endMinute: 670, topPx: 100, heightPx: 50 },
    ]
    expect(minuteToBandOffsetPx(663, bands10)).toBeCloseTo(100 + (3 / 10) * 50)
  })

  it('마지막 band 를 지난 분은 본문 하단을 준다', () => {
    expect(minuteToBandOffsetPx(700, BANDS_45)).toBe(231 + 74)
  })

  it('첫 band 보다 이른 분은 본문 상단을 준다', () => {
    expect(minuteToBandOffsetPx(500, BANDS_45)).toBe(181)
  })

  it('band 이 없으면 0 을 준다', () => {
    expect(minuteToBandOffsetPx(663, [])).toBe(0)
  })
})
