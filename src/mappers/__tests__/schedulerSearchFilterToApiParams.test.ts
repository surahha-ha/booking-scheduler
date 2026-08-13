import { describe, expect, it } from 'vitest'
import { toBookApiParams } from '../schedulerSearchFilterToApiParams'
import type { SchedulerFilterState } from '@/stores/useSchedulerFilterStore'

function baseFilter(overrides: Partial<SchedulerFilterState> = {}): SchedulerFilterState {
  return {
    periodDate: new Date(2026, 5, 1),
    viewMode: 'WEEK',
    dataType: 'APPOINTMENT',
    memberType: 'N',
    treatmentStateType: 'Y',
    keyword: '',
    doctors: [],
    selectedTeamName: null,
    status: [],
    searchVersion: 0,
    isResetToToday: false,
    windowAnchorDate: null,
    windowDays: 0,
    ...overrides,
  }
}

describe('toBookApiParams — 조회 윈도우 분기', () => {
  it('윈도우 미설정 → 기존 viewMode/periodDate(toPeriodRange) 경로 (V2 동작 유지)', () => {
    // WEEK: 그 주 일~토. 2026-06-03(수) → 일(05-31)~토(06-06)
    const p = toBookApiParams(baseFilter({ periodDate: new Date(2026, 5, 3), viewMode: 'WEEK' }))
    expect(p.startDate).toBe('20260531')
    expect(p.endDate).toBe('20260606')
  })

  it('윈도우 설정 → anchor ~ +days (viewMode 무관)', () => {
    const p = toBookApiParams(baseFilter({
      windowAnchorDate: new Date(2026, 5, 5), // 06-05
      windowDays: 14,
      viewMode: 'DAY', // 무시되어야 함
    }))
    expect(p.startDate).toBe('20260605')
    expect(p.endDate).toBe('20260618') // 06-05 + 13일
  })

  it('윈도우 days=0 이면 미설정 취급(periodDate 경로 — anchor 무시)', () => {
    const p = toBookApiParams(baseFilter({
      periodDate: new Date(2026, 5, 5), // DAY: 단일일 06-05
      windowAnchorDate: new Date(2026, 5, 1), // days=0 이라 무시되어야
      windowDays: 0,
      viewMode: 'DAY',
    }))
    expect(p.startDate).toBe('20260605')
    expect(p.endDate).toBe('20260605')
  })
})
