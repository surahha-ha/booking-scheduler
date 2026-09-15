/**
 * @vitest-environment happy-dom
 *
 * 운영일정 "보기" 년 뷰 — 현재 탭(진료일/휴무일)에 해당하는 날짜는 굵게(is-active), 아닌 날짜는 흐리게(is-mismatch).
 *
 * 두 클래스는 상호배타다. 같은 셀이 둘 다 갖거나 둘 다 없으면 "굵게" 규칙이 깨진 것이다.
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

const STAFF_ID = 101
const DOCTOR = '김의사'

/** 이번 달에서 그 요일인 날짜 하나 (1~28일 안에서 고른다 — 모든 달에 존재) */
function dateOfWeekday(weekday: number) {
  const start = dayjs().startOf('month')
  for (let i = 0; i < 28; i++) {
    const d = start.add(i, 'day')
    if (d.day() === weekday) return d.format('YYYY-MM-DD')
  }
  throw new Error(`이번 달에 요일 ${weekday} 없음`)
}

const D_WORK = dateOfWeekday(1) // 월 — 진료
const D_OFF = dateOfWeekday(2)  // 화 — 휴무로 정함

/* 담당자 weekly — 월만 진료, 화는 명시적 휴무. */
const staffTimes = [
  { dayCd: 1, staffOpenHm: '0900', staffCloseHm: '1800' },
  { dayCd: 2, staffOpenHm: null, staffCloseHm: null },
]

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

/** 년 뷰에서 이번 달 미니 캘린더의 ymd 일 셀 */
function miniDayOf(wrapper: any, ymd: string) {
  const monthKey = dayjs(ymd).format('YYYY-MM')
  const day = String(dayjs(ymd).date())
  const mini = wrapper.findAll('.schedulerTreatmentView__miniMonth')
    .find((m: any) => m.find('.schedulerTreatmentView__miniMonthLabel').text() === `${dayjs(monthKey).month() + 1}월`)
  expect(mini, `${monthKey} 미니 캘린더`).toBeTruthy()
  const cell = mini!.findAll('.schedulerTreatmentView__miniDay')
    .find((c: any) => !c.classes('is-other') && c.text() === day)
  expect(cell, `${ymd} 셀`).toBeTruthy()
  return cell!
}

describe('운영일정 보기 년 뷰 — 현재 탭에 해당하는 날짜는 굵게', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getTeams.mockResolvedValue({
      data: { payload: { teams: [{ id: 1, name: '1구역', doctors: [{ staffId: STAFF_ID, staffName: DOCTOR }] }] } },
    })
    mocks.getTreatmentSettings.mockResolvedValue({
      data: { payload: { recurringOffRules: [], offDates: [], workDates: [], holidayClosedYn: false, teams: [] } },
    })
    mocks.getStaffWorkHours.mockResolvedValue({
      data: { payload: { staff: [{ staffId: STAFF_ID, staffName: DOCTOR, times: staffTimes }], overrides: [] } },
    })
    mocks.getSiteWorkHours.mockResolvedValue({ data: { payload: { site: [] } } })
  })

  it('진료일 탭 — 진료하는 날은 is-active, 휴무일은 is-mismatch', async () => {
    const wrapper = await mountView()
    await clickSegment(wrapper, '년')

    const work = miniDayOf(wrapper, D_WORK)
    expect(work.classes()).toContain('is-active')
    expect(work.classes()).not.toContain('is-mismatch')

    const off = miniDayOf(wrapper, D_OFF)
    expect(off.classes()).toContain('is-mismatch')
    expect(off.classes()).not.toContain('is-active')
  })

  it('휴무일 탭 — 뒤집힌다: 휴무일이 is-active, 진료일이 is-mismatch', async () => {
    const wrapper = await mountView()
    await clickSegment(wrapper, '년')
    await clickSegment(wrapper, '휴무일')

    const off = miniDayOf(wrapper, D_OFF)
    expect(off.classes()).toContain('is-active')
    expect(off.classes()).not.toContain('is-mismatch')

    const work = miniDayOf(wrapper, D_WORK)
    expect(work.classes()).toContain('is-mismatch')
    expect(work.classes()).not.toContain('is-active')
  })

  it('다른 달 날짜(is-other)는 어느 탭에서도 굵어지지 않는다', async () => {
    const wrapper = await mountView()
    await clickSegment(wrapper, '년')

    const others = wrapper.findAll('.schedulerTreatmentView__miniDay.is-other')
    expect(others.length).toBeGreaterThan(0)
    for (const c of others) expect(c.classes()).not.toContain('is-active')
  })
})
