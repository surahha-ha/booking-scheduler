/**
 * 장부 전환(예약 ↔ 방문) 은 전환 전 화면의 검색 조건을 남기지 않는다.
 *
 * 상태 필터는 이미 비운다 — 상태 키 집합이 화면마다 달라 이전 선택이 남으면 어떤 버튼도 켜져 보이지
 * 않는데 목록만 걸러진다. 고객명 검색도 같은 이유다: 예약장부에서 찾던 고객가 방문장부 목록을 계속
 * 거르면, 입력칸은 비어 보이는데 목록은 그 고객뿐인 상태가 된다.
 *
 * 기대값 출처: 정책 결정(2026-09-07, "상태 필터가 초기화되듯 고객명 검색도 초기화").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'
import { useSchedulerFilterStore } from '../useSchedulerFilterStore'

describe('useSchedulerFilterStore.setDataType — 전환 시 검색 조건 초기화', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('🔑 고객명 검색어(keyword)를 비운다', () => {
    const store = useSchedulerFilterStore()
    store.setDataType('APPOINTMENT', false)
    store.setKeyword('김고객')

    store.setDataType('TREATMENT', false)

    expect(store.keyword).toBe('')
  })

  it('상태 필터도 함께 비운다 (기존 규약)', () => {
    const store = useSchedulerFilterStore()
    store.setDataType('APPOINTMENT', false)
    store.setStatusKeys(['CANCEL'] as never, false)

    store.setDataType('TREATMENT', false)

    expect(store.status).toEqual([])
  })

  it('같은 장부를 다시 고르면 아무것도 비우지 않는다', () => {
    const store = useSchedulerFilterStore()
    store.setDataType('TREATMENT', false)
    store.setKeyword('김고객')

    store.setDataType('TREATMENT', false)

    expect(store.keyword).toBe('김고객')
  })
})

// 장부 전환의 날짜 분기 — 방문장부는 미래를 표기할 수 없고, 예약장부는 운영에서 보던 과거를 남기지 않는다.
// 기대값 출처: setDataType 주석(방문 전환 시 미래→오늘 클램프, 과거~오늘 유지 / 예약 전환 시 항상 오늘).
describe('useSchedulerFilterStore.setDataType — 전환 시 날짜', () => {
  const TODAY = '2030-03-06' // 수요일 — WEEK 정규화(주 시작)와 DAY 가 다른 값이 되도록 주 중간
  const ymd = (d: Date) => dayjs(d).format('YYYY-MM-DD')

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.setSystemTime(dayjs(TODAY).toDate())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('예약장부에서 미래를 보다 방문장부로 가면 오늘로 당긴다', () => {
    const store = useSchedulerFilterStore()
    store.setViewMode('DAY', false)
    store.setDataType('APPOINTMENT', false)
    store.setPeriodDate(dayjs(TODAY).add(10, 'day').toDate(), false)

    store.setDataType('TREATMENT', false)

    expect(ymd(store.periodDate)).toBe(TODAY)
  })

  it('예약장부에서 과거를 보다 방문장부로 가면 그 날짜를 유지한다', () => {
    const store = useSchedulerFilterStore()
    store.setViewMode('DAY', false)
    store.setDataType('APPOINTMENT', false)
    const past = dayjs(TODAY).subtract(10, 'day').toDate()
    store.setPeriodDate(past, false)

    store.setDataType('TREATMENT', false)

    expect(ymd(store.periodDate)).toBe(ymd(past))
  })

  it('방문장부에서 과거를 보다 예약장부로 가면 항상 오늘이다', () => {
    const store = useSchedulerFilterStore()
    store.setViewMode('DAY', false)
    store.setDataType('TREATMENT', false)
    store.setPeriodDate(dayjs(TODAY).subtract(10, 'day').toDate(), false)

    store.setDataType('APPOINTMENT', false)

    expect(ymd(store.periodDate)).toBe(TODAY)
  })

  // "오늘"은 viewMode 로 정규화한 값이다 — WEEK 면 오늘이 속한 주의 시작. 그대로 오늘 날짜를
  // 넣으면 주 뷰가 주 중간에서 시작해 이동 단위(7일)와 어긋난다.
  it('WEEK 뷰의 오늘은 주 시작으로 정규화된다', () => {
    const store = useSchedulerFilterStore()
    store.setViewMode('WEEK', false)
    store.setDataType('TREATMENT', false)
    store.setPeriodDate(dayjs(TODAY).subtract(30, 'day').toDate(), false)

    store.setDataType('APPOINTMENT', false)

    expect(ymd(store.periodDate)).toBe(ymd(dayjs(TODAY).startOf('week').toDate()))
    expect(ymd(store.periodDate)).not.toBe(TODAY)
  })
})
