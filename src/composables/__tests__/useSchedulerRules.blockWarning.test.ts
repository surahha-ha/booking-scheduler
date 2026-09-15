import { describe, expect, it } from 'vitest'
import { pickBlockWarning } from '../useSchedulerRules'
import { labelBlockedReason } from '@/utils/formatStringUtils'

/**
 * 이동(드래그·리사이즈) 시 안내할 차단 사유 고르기 — TC 003-03 v0.3 (2026-08-26).
 *
 * 배경: 이동 경로(SchedulerV3Page)는 휴무가면 아무 안내 없이 카드를 되돌리고, 휴게시간은 경고 없이
 * 통과시키고, 운영종료 문구만 하드코딩돼 있었다. 등록 경로(ReservationPopup)는 같은 상황에서
 * 사유별 확인 팝업을 띄우고 [확인]이면 허용한다 — 같은 시각이 등록은 되고 이동은 안 되는 상태였다.
 * 이동을 등록 정책에 맞추면서, 여러 칸에 걸친 카드의 "어느 사유를 알릴 것인가"가 새 판정으로 생겼다.
 *
 * 규칙: 휴무(closedDate·closedWeekday) > 휴게시간(lunch·dinner·blockedTime) > 운영종료(outsideHours).
 * 뒤 칸이 앞 칸을 덮어쓰면 같은 드롭인데 놓인 위치에 따라 문구가 달라지므로 우선순위로 고정한다.
 */
describe('pickBlockWarning — 이동 안내 사유 선택', () => {

  it('사유가 없으면 null 이다 (운영시간 안쪽 이동은 확인 없이 진행)', () => {
    expect(pickBlockWarning(null, 'none')).toBeNull()
    expect(pickBlockWarning(null, null)).toBeNull()
    expect(pickBlockWarning(null, undefined)).toBeNull()
  })

  it('첫 사유는 그대로 채택된다', () => {
    expect(pickBlockWarning(null, 'outsideHours')).toBe('outsideHours')
    expect(pickBlockWarning(null, 'closedDate')).toBe('closedDate')
  })

  it("'none' 은 이미 고른 사유를 지우지 않는다", () => {
    expect(pickBlockWarning('lunch', 'none')).toBe('lunch')
  })

  it('휴무가 운영종료·휴게시간을 이긴다 — 순서와 무관하게', () => {
    expect(pickBlockWarning('outsideHours', 'closedDate')).toBe('closedDate')
    expect(pickBlockWarning('closedDate', 'outsideHours')).toBe('closedDate')
    expect(pickBlockWarning('lunch', 'closedWeekday')).toBe('closedWeekday')
    expect(pickBlockWarning('closedWeekday', 'lunch')).toBe('closedWeekday')
  })

  it('휴게시간이 운영종료를 이긴다 — 순서와 무관하게', () => {
    expect(pickBlockWarning('outsideHours', 'lunch')).toBe('lunch')
    expect(pickBlockWarning('lunch', 'outsideHours')).toBe('lunch')
    expect(pickBlockWarning('outsideHours', 'blockedTime')).toBe('blockedTime')
    expect(pickBlockWarning('dinner', 'outsideHours')).toBe('dinner')
  })

  it('운영종료 구간과 휴무 구간에 걸친 카드는 휴무로 안내한다', () => {
    // 09:00~10:00 카드가 셀 4개를 덮고 마지막 칸만 휴무인 경우
    const cells = ['outsideHours', 'outsideHours', 'none', 'closedDate'] as const
    const warning = cells.reduce<ReturnType<typeof pickBlockWarning>>(
        (acc, reason) => pickBlockWarning(acc, reason), null)
    expect(warning).toBe('closedDate')
  })

  it('우선순위 표에 없는 사유는 이미 고른 사유를 밀어내지 못한다', () => {
    // 사유가 늘었는데 표에 추가하지 않으면 안내가 뒤바뀐다 — 그때도 기존 문구를 지키는 쪽으로
    expect(pickBlockWarning('outsideHours', 'somethingNew' as never)).toBe('outsideHours')
    // 다만 고른 사유가 없으면 모르는 값이라도 알린다(조용히 통과시키지 않는다)
    expect(pickBlockWarning(null, 'somethingNew' as never)).toBe('somethingNew')
  })
})

/** 고른 사유가 어떤 문장이 되는지 — TC 가 문구를 그대로 적어 두고 있어 라벨이 바뀌면 TC 가 깨진다. */
describe('labelBlockedReason — 이동 안내 문구', () => {

  const sentence = (reason: string) =>
      `해당 시간에 미추이님은 ${labelBlockedReason(reason) || '운영종료 시간'}입니다.`

  it('휴무는 등록 팝업과 같은 문장이 된다 (TC 003-03)', () => {
    expect(sentence('closedDate')).toBe('해당 시간에 미추이님은 휴무입니다.')
    expect(sentence('closedWeekday')).toBe('해당 시간에 미추이님은 휴무입니다.')
  })

  it('운영종료·휴게시간도 사유대로 읽힌다', () => {
    expect(sentence('outsideHours')).toBe('해당 시간에 미추이님은 운영종료 시간입니다.')
    expect(sentence('lunch')).toBe('해당 시간에 미추이님은 휴게시간1입니다.')
    expect(sentence('dinner')).toBe('해당 시간에 미추이님은 휴게시간2입니다.')
    expect(sentence('blockedTime')).toBe('해당 시간에 미추이님은 휴게시간입니다.')
  })

  it('모르는 사유는 운영종료 시간으로 떨어진다 (빈 문장이 나가지 않는다)', () => {
    expect(sentence('somethingNew')).toBe('해당 시간에 미추이님은 운영종료 시간입니다.')
  })
})
