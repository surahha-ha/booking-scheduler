/**
 * 계약 테스트 — **날짜를 옮기면 조회는 한 번, 그것도 새 날짜 범위로 나간다.**
 *
 * V3 의 조회 범위는 `windowAnchorDate`(+windowDays) 가 정하고, 그 창은 페이지가 표시 날짜
 * (selectedDate)로 잡는다(applyDataWindow → setWindow, 150ms 디바운스). 그런데 ‹ › 이동·달력 pick·
 * 검색 pick 은 store 의 setPeriodDate 로 들어와 즉시 재조회를 걸었다 — 그 순간 창은 아직 옛 날짜라
 * 첫 조회가 옛 범위로 나가고, 150ms 뒤 창 경로가 새 범위로 한 번 더 조회했다(날짜 이동 1회 = 조회 2회).
 *
 * 고정하는 계약:
 *   ① 재조회가 나가는 순간(searchVersion 이 오르는 시점)의 API 파라미터가 이미 새 날짜 범위다
 *   ② 뒤따르는 창 경로(setWindow)가 같은 창을 다시 잡아도 재조회는 늘지 않는다
 *   ③ 페이지→store 동기화(trigger=false)는 창을 건드리지 않는다 — 그 경로의 재조회는 창 경로 몫이다
 *   ④ 창이 없을 때(V2 · 랜딩 전)는 창을 만들지 않는다
 *
 * 기대값은 화면 동작(‹ › 한 번 = 다음 날 조회 한 번)에서 썼다. store 계층 테스트라 페이지의
 * 150ms 디바운스 자체는 재지 않고, 페이지가 창을 만드는 방식(날짜 문자열 → Date)을 그대로 흉내낸다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'

import { useSchedulerFilterStore } from '../useSchedulerFilterStore'
import { toBookApiParams } from '@/mappers/schedulerSearchFilterToApiParams'

const WINDOW_DAYS = 7

/** SchedulerV3Page.applyDataWindow 가 창 anchor 를 만드는 방식과 같다 — 'YYYY-MM-DD' 를 Date 로. */
function pageAnchorOf(date: Date): Date {
  return dayjs(dayjs(date).format('YYYY-MM-DD')).toDate()
}

function landedOn(ymd: string) {
  const store = useSchedulerFilterStore()
  const day = dayjs(ymd).toDate()
  store.setViewMode('DAY', false)
  store.setDataType('APPOINTMENT', false)
  store.setPeriodDate(day, false)
  store.setWindow(pageAnchorOf(day), WINDOW_DAYS, false)
  return store
}

describe('useSchedulerFilterStore — 날짜 이동과 조회 창', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 7, 10, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('🔑 › 한 번 → 재조회 한 번, 그 조회의 범위는 다음 날부터다', () => {
    const store = landedOn('2026-09-07')
    const before = store.searchVersion

    store.movePeriod(1)

    expect(store.searchVersion).toBe(before + 1)
    const params = toBookApiParams(store)
    expect(params.startDate).toBe('20260908')
    expect(params.endDate).toBe('20260914')
  })

  it('🔑 뒤따르는 창 경로가 같은 창을 잡아도 재조회는 늘지 않는다', () => {
    const store = landedOn('2026-09-07')
    store.movePeriod(1)
    const afterMove = store.searchVersion

    // 페이지: periodDate → navigation.selectedDate → applyDataWindow → setWindow
    store.setWindow(pageAnchorOf(store.periodDate), WINDOW_DAYS)

    expect(store.searchVersion).toBe(afterMove)
  })

  it('달력에서 날짜를 고르면(setPeriodDate) 그 날부터 조회한다', () => {
    const store = landedOn('2026-09-07')
    const before = store.searchVersion

    store.setPeriodDate(dayjs('2026-09-21').toDate())

    expect(store.searchVersion).toBe(before + 1)
    expect(toBookApiParams(store).startDate).toBe('20260921')
  })

  it('진료장부로 바꾸며 오늘로 돌아올 때도 조회 범위가 오늘부터다', () => {
    const store = landedOn('2026-09-21')
    const before = store.searchVersion

    store.setDataType('TREATMENT')

    expect(store.searchVersion).toBe(before + 1)
    expect(toBookApiParams(store).startDate).toBe('20260907')
  })

  it('페이지→store 동기화(trigger=false)는 창을 건드리지 않는다 — 재조회는 창 경로가 낸다', () => {
    const store = landedOn('2026-09-07')
    const before = store.searchVersion
    const anchorBefore = store.windowAnchorDate

    store.patch({ periodDate: dayjs('2026-09-08').toDate() }, false)

    expect(store.searchVersion).toBe(before)
    expect(store.windowAnchorDate).toBe(anchorBefore)
  })

  it('창이 없으면(V2 · 랜딩 전) 날짜를 옮겨도 창을 만들지 않는다', () => {
    const store = useSchedulerFilterStore()
    store.setViewMode('DAY', false)
    store.setPeriodDate(dayjs('2026-09-07').toDate(), false)

    store.movePeriod(1)

    expect(store.windowAnchorDate).toBeNull()
    expect(store.windowDays).toBe(0)
  })
})
