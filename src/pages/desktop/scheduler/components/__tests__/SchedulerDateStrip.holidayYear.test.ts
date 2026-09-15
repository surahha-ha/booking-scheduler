/**
 * @vitest-environment happy-dom
 *
 * 줄달력(SchedulerDateStrip) — 공휴일 셀 붉은색(is-holiday) + 연도 라벨.
 * 연도 라벨 규칙 = 운영일정 보기 월 스트립과 같은 "1월 앞에만". 맨 앞 월에도 붙이는 안은 반려됐다.
 * 30일 창·월 버튼 계산 자체는 바꾸지 않았으므로 여기서는 라벨·클래스 부여만 본다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  holidays: new Set<string>(),
  ensureYears: vi.fn(async () => {}),
}))
vi.mock('@/stores/holidayStore', () => ({
  useHolidayStore: () => ({
    isHoliday: (d: string) => mocks.holidays.has(d),
    ensureYears: mocks.ensureYears,
  }),
}))

import SchedulerDateStrip from '@/pages/desktop/scheduler/components/SchedulerDateStrip.vue'

function mountStrip(props: Record<string, unknown>) {
  return mount(SchedulerDateStrip, {
    props: {
      selectedDate: '2026-12-15',
      stripWindowStart: '2026-12-15',
      headerWindowDays: 30,
      ...props,
    },
  })
}

function yearLabels(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.scheduleDateStrip__yearLabel').map(el => el.text())
}

/** 연도 라벨이 어느 월 라벨 바로 앞에 붙었는지 — DOM 순서로 (연도, 다음 형제 텍스트) 쌍을 뽑는다 */
function yearToNextLabel(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.scheduleDateStrip__yearLabel').map((el) => {
    const next = (el.element as HTMLElement).nextElementSibling
    return [el.text(), next?.textContent?.trim()]
  })
}

describe('줄달력 — 공휴일 붉은색', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.holidays = new Set(['2026-12-25', '2027-01-01'])
    mocks.ensureYears.mockClear()
  })

  it('공휴일 셀에만 is-holiday 가 붙는다 (요일 무관)', () => {
    const wrapper = mountStrip({})
    const cell = (date: string) => wrapper.find(`[aria-label="${date} 선택"]`)
    expect(cell('2026-12-25').classes()).toContain('is-holiday')   // 금요일 공휴일
    expect(cell('2027-01-01').classes()).toContain('is-holiday')   // 금요일 공휴일
    expect(cell('2026-12-24').classes()).not.toContain('is-holiday')
    expect(cell('2026-12-27').classes()).not.toContain('is-holiday') // 일요일 — 요일색만
  })

  it('월 펼침 모드에서도 공휴일 셀에 is-holiday 가 붙는다', () => {
    const wrapper = mountStrip({ mode: 'monthExpanded', expandedMonth: '2027-01' })
    expect(wrapper.find('[aria-label="2027-01-01 선택"]').classes()).toContain('is-holiday')
    expect(wrapper.find('[aria-label="2027-01-02 선택"]').classes()).not.toContain('is-holiday')
  })

  it('날짜 셀이 걸친 연도의 공휴일을 보장한다 (연 경계를 가로지르면 두 해)', () => {
    mountStrip({})
    expect(mocks.ensureYears).toHaveBeenCalledWith([2026, 2027])
  })
})

describe('줄달력 — 연도 라벨', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.holidays = new Set()
  })

  it('예약 모드: 창 안 1월 구분선 앞에만 붙는다 (12/15~1/13 창 → 12월 … 2027 1월)', () => {
    const wrapper = mountStrip({})
    expect(yearToNextLabel(wrapper)).toEqual([['2027', '1월']])
  })

  it('예약 모드: 창이 한 해 안이면 오른쪽 월 버튼의 1월 앞에만 붙는다 (맨 앞 월에는 없음)', () => {
    const wrapper = mountStrip({ selectedDate: '2026-09-03', stripWindowStart: '2026-09-03' })
    expect(yearToNextLabel(wrapper)).toEqual([['2027', '1월']])
  })

  it('방문 모드: 1월이 보이지 않는 창에는 연도 라벨이 없다', () => {
    const wrapper = mountStrip({
      selectedDate: '2026-09-03', stripWindowStart: '2026-08-05', maxDate: '2026-09-03',
    })
    expect(yearLabels(wrapper)).toEqual([])
  })

  it('방문 모드: 왼쪽 월 버튼에 1월이 있으면 그 앞에 붙는다', () => {
    const wrapper = mountStrip({
      selectedDate: '2027-02-03', stripWindowStart: '2027-01-05', maxDate: '2027-02-03',
    })
    expect(yearToNextLabel(wrapper)).toEqual([['2027', '1월']])
  })

  it('월 펼침 모드: 왼쪽 1월 + 펼친 1월 + 오른쪽 1월 앞에 붙는다', () => {
    const wrapper = mountStrip({ mode: 'monthExpanded', expandedMonth: '2027-01' })
    expect(yearLabels(wrapper)).toEqual(['2026', '2027', '2028'])
  })
})
