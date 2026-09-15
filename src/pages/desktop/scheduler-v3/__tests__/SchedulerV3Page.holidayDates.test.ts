/**
 * @vitest-environment happy-dom
 *
 * SchedulerV3Page → 엔진 입력 계약 — 밴드가 받는 `holidayDates` 는 **공휴일 전부**다.
 *
 * 공휴일 축은 담당자 자기 값(HOLIDAY_OPEN_YN)이라 기관이 쉬는 공휴일에도 그날 진료하는 담당자가 있고,
 * 그 사람의 밴드는 기관 공휴일 운영시간으로 그려야 한다. 그래서 페이지는 "기관이 문을 여는 공휴일"
 * (holidayOpenDates)이 아니라 store 의 publicHolidayDates 를 배열로 바꿔 넘긴다.
 * 157cbb9 가 예약검증(useSchedulerRules.isPublicHolidayDate)과 밴드를 이 규칙으로 맞췄는데, 되돌아가면
 * 예약검증은 새 규칙·밴드만 옛 규칙이 되어 "밴드는 닫혔는데 클릭하면 열린다"가 된다.
 *
 * 기대값 출처: SchedulerV3Page.publicHolidayDateList 주석(공휴일 전부, 예약검증과 한 쌍) — 157cbb9 정책.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { stubResizeObserver } from './v3PageHarness'

// 엔진은 실물을 돌리되 입력만 엿본다 — 어댑터(v3StoreInput → runLayoutAdapter)까지 거친 최종 입력이 판정 대상.
const engineSpy = vi.hoisted(() => ({ runLayout: vi.fn() }))
vi.mock('@/scheduler-engine/redesign/layoutPipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/scheduler-engine/redesign/layoutPipeline')>()
  engineSpy.runLayout.mockImplementation(actual.runLayout)
  return { ...actual, runLayout: engineSpy.runLayout }
})

import SchedulerV3Page from '@/pages/desktop/scheduler-v3/SchedulerV3Page.vue'
import { useStaffStore } from '@/stores/staffStore'

const HOLIDAY = '2026-10-03'

function lastEngineInput() {
  const calls = engineSpy.runLayout.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as { site: { holidayDates: string[] } }
}

describe('SchedulerV3Page — 밴드 holidayDates 는 공휴일 전부', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    stubResizeObserver()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('store 의 publicHolidayDates(Set) 가 엔진 입력 holidayDates(배열) 로 그대로 간다', async () => {
    shallowMount(SchedulerV3Page)
    await flushPromises()

    const staff = useStaffStore()
    staff.hospitalRules = { ...staff.hospitalRules, publicHolidayDates: new Set([HOLIDAY]) }
    await flushPromises()

    expect(lastEngineInput().site.holidayDates).toEqual([HOLIDAY])
  })

  // 157cbb9 이전 규칙의 재발 방지 — 기관이 그 공휴일에 문을 연다는 사실(holidayOpenDates)은
  // 밴드의 공휴일 판정 근거가 아니다. 이걸 근거로 되돌리면 기관 휴무 공휴일에 진료하는 담당자의
  // 밴드가 요일 시간으로 떨어진다.
  it('holidayOpenDates 만 있고 공휴일 목록이 비면 holidayDates 는 빈 배열이다', async () => {
    shallowMount(SchedulerV3Page)
    await flushPromises()

    const staff = useStaffStore()
    staff.hospitalRules = {
      ...staff.hospitalRules,
      holidayOpenDates: new Set([HOLIDAY]),
      publicHolidayDates: new Set(),
    }
    await flushPromises()

    expect(lastEngineInput().site.holidayDates).toEqual([])
  })
})
