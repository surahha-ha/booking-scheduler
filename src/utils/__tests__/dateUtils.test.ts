/**
 * dateUtils.yearLabelFor — 월 스트립의 연도 라벨은 "1월 앞에만".
 *
 * 줄달력(SchedulerDateStrip)과 운영일정 보기의 월 스트립(SchedulerSettingsTreatmentView)이 같은 규칙을
 * 각자 들고 있었다. 맨 앞 월에도 연도를 붙이는 안은 "보고 있는 연도가 늘 왼쪽에 떠 있어 거슬린다" 로
 * 반려됐으므로, 규칙이 바뀌면 두 화면이 같이 바뀌어야 한다 — 그래서 함수 하나를 둘이 부른다.
 */

import { describe, expect, it } from 'vitest'
import { yearLabelFor } from '../dateUtils'

describe('yearLabelFor — 1월 앞에만 연도', () => {
  it('1월이면 그 해의 연도 문자열', () => {
    expect(yearLabelFor('2027-01')).toBe('2027')
  })

  it('1월이 아니면 null — 2월도, 창의 맨 앞 12월도', () => {
    expect(yearLabelFor('2027-02')).toBeNull()
    expect(yearLabelFor('2026-12')).toBeNull()
  })
})
