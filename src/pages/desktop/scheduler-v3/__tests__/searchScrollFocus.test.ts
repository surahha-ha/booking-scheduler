import { describe, expect, it } from 'vitest'
import { computeScrollDelta } from '../searchScrollFocus'

/**
 * 검색 pick 자동 스크롤의 가시 판정.
 * viewTop 은 뷰포트 상단이 아니라 sticky 헤더 하단이다 — 헤더에 덮인 카드는 "보인다"가 아니다.
 */
describe('searchScrollFocus — computeScrollDelta', () => {
  const view = { viewTop: 100, viewBottom: 700 }

  it('유효 영역 안에 온전히 있으면 스크롤하지 않는다', () => {
    expect(computeScrollDelta({ cardTop: 300, cardBottom: 360, ...view })).toBeNull()
  })

  it('경계에 딱 걸친 카드도 보이는 것으로 본다', () => {
    expect(computeScrollDelta({ cardTop: 100, cardBottom: 700, ...view })).toBeNull()
  })

  it('sticky 헤더에 가린 카드는 보이는 것으로 치지 않고 가운데로 옮긴다', () => {
    // 뷰포트(0~700) 안이지만 헤더 아래(100)에 못 미친 카드.
    // 카드 중심 70 → 영역 중심 400 이므로 -330 만큼 거슬러 올라가야 한다.
    expect(computeScrollDelta({ cardTop: 40, cardBottom: 100, ...view })).toBe(-330)
  })

  it('아래로 벗어난 카드는 가운데로 내려온다', () => {
    // 카드 중심 1230 → 영역 중심 400. 830 만큼 더 스크롤.
    expect(computeScrollDelta({ cardTop: 1200, cardBottom: 1260, ...view })).toBe(830)
  })

  it('일부만 걸친 카드도 온전히 보이도록 옮긴다', () => {
    // 하단이 720 으로 40px 잘려 있다 — null 이 아니어야 한다.
    expect(computeScrollDelta({ cardTop: 660, cardBottom: 720, ...view })).toBe(290)
  })

  it('영역보다 긴 예약은 가운데가 아니라 시작 시각이 보이게 맞춘다', () => {
    // 카드 높이 800 > 영역 높이 600. 가운데 정렬하면 시작·종료가 모두 잘린다.
    expect(computeScrollDelta({ cardTop: 300, cardBottom: 1100, ...view })).toBe(200)
  })
})
