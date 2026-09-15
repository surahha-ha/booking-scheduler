/**
 * @vitest-environment happy-dom
 *
 * 운영일정 "보기" — 년/월 뷰 모두 오늘 날짜 셀 하나에만 is-today 가 붙는다.
 * (표시는 줄달력 선택일과 같은 꽉 찬 브랜드색 원 — 스타일은 CSS 몫, 여기서는 클래스 부여만 검증)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'

vi.mock('@/lib/http', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
}))
vi.mock('@/stores/holidayStore', () => ({
  useHolidayStore: () => ({
    isHoliday: () => false,
    ensureYears: vi.fn(async () => {}),
  }),
}))

const mocks = vi.hoisted(() => ({
  getTeams: vi.fn(),
  getTreatmentSettings: vi.fn(),
  getStaffWorkHours: vi.fn(),
  getSiteWorkHours: vi.fn(),
}))
vi.mock('@/api/siteApi', () => ({
  getTeams: mocks.getTeams,
  getTreatmentSettings: mocks.getTreatmentSettings,
  getStaffWorkHours: mocks.getStaffWorkHours,
  getSiteWorkHours: mocks.getSiteWorkHours,
}))

import SchedulerSettingsTreatmentView from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTreatmentView.vue'

const TODAY_DAY = String(dayjs().date())

async function mountView() {
  const wrapper = mount(SchedulerSettingsTreatmentView, {
    global: { stubs: { CellMorePopover: true } },
  })
  for (let i = 0; i < 5; i++) await wrapper.vm.$nextTick()
  return wrapper
}

async function clickSegment(wrapper: any, label: string) {
  const btn = wrapper.findAll('.scheduleSegment__btn').find((b: any) => b.text() === label)
  expect(btn, `세그먼트 '${label}'`).toBeTruthy()
  await btn!.trigger('click')
  await wrapper.vm.$nextTick()
}

describe('운영일정 보기 — 오늘 날짜 표시', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getTeams.mockResolvedValue({ data: { payload: { teams: [] } } })
    mocks.getTreatmentSettings.mockResolvedValue({
      data: { payload: { recurringOffRules: [], offDates: [], workDates: [], holidayClosedYn: false, teams: [] } },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { payload: { staff: [], overrides: [] } } })
    mocks.getSiteWorkHours.mockResolvedValue({ data: { payload: { site: [] } } })
  })

  it('월 뷰 — 이번 달 오늘 셀 하나에만 is-today', async () => {
    const wrapper = await mountView()
    const todays = wrapper.findAll('.schedulerTreatmentView__cell.is-today')
    expect(todays).toHaveLength(1)
    expect(todays[0].classes()).not.toContain('is-other')
    expect(todays[0].find('.schedulerTreatmentView__cellDate').text()).toBe(TODAY_DAY)
  })

  it('월 뷰 — 다른 달로 이동하면 is-today 가 없다', async () => {
    const wrapper = await mountView()
    // 월 스트립(__month 버튼)에서 다음 달 클릭 — 스트립은 오늘 달부터 12개월이라 다음 달은 한 번만 나온다
    const nextLabel = `${dayjs().add(1, 'month').month() + 1}월`
    const btn = wrapper.findAll('.schedulerTreatmentView__month')
      .find((b: any) => !b.classes('is-year') && b.text() === nextLabel)
    expect(btn, '다음 달 버튼').toBeTruthy()
    await btn!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.schedulerTreatmentView__cell.is-today')).toHaveLength(0)
  })

  it('년 뷰 — 12개월 미니 캘린더 전체에서 오늘 셀 하나에만 is-today', async () => {
    const wrapper = await mountView()
    await clickSegment(wrapper, '년')
    const todays = wrapper.findAll('.schedulerTreatmentView__miniDay.is-today')
    expect(todays).toHaveLength(1)
    expect(todays[0].classes()).not.toContain('is-other')
    expect(todays[0].text()).toBe(TODAY_DAY)
  })
})
