/**
 * @vitest-environment happy-dom
 *
 * 운영일정 "보기" 화면 — 요일 3상태 표기가 "설정" 화면과 같은지 검증.
 *
 * 두 화면이 같은 데이터를 다르게 표기하면 사용자는 무엇이 맞는지 알 수 없다.
 * 판정 cascade 는 하나뿐이어야 한다:
 *   일자 지정 → (없으면) 요일 설정 → (미설정이면) 사업장 운영시간 → (그것도 모르면) 표기하지 않음
 *
 *   키 없음      = 미설정 → 사업장 운영시간을 따른다
 *   키 + null    = 휴무로 정함 → 기관 값으로 대체되지 않는다
 *   키 + Range   = 운영
 *
 * 이 판정(resolveDisplay)은 컴포넌트 안에만 있어 마운트로 검증한다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'

// ── 외부 의존 stub ──────────────────────────────────────────
vi.mock('@/lib/useDialog', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
}))
// 공휴일은 관심사가 아니다 — 전부 평일로 고정(휴무 판정이 3상태를 가리지 않게).
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
const DOCTOR = '김담당'

/** 이번 달에서 그 요일인 날짜 하나 (1~28일 안에서 고른다 — 모든 달에 존재) */
function dateOfWeekday(weekday: number) {
  const start = dayjs().startOf('month')
  for (let i = 0; i < 28; i++) {
    const d = start.add(i, 'day')
    if (d.day() === weekday) return d.format('YYYY-MM-DD')
  }
  throw new Error(`이번 달에 요일 ${weekday} 없음`)
}

const D_WORK = dateOfWeekday(1)   // 월 — 본인이 09:00~18:00 로 정함
const D_OFF = dateOfWeekday(2)    // 화 — 본인이 휴무로 정함 (행 + null)
const D_UNSET = dateOfWeekday(3)  // 수 — 정한 적 없음 (행 자체가 없다)
const D_NO_INSTITUTION = dateOfWeekday(0)  // 일 — 담당자도 사업장도 정한 적이 없다

/* 담당자 weekly — 월만 운영, 화는 명시적 휴무, 수는 행을 아예 넣지 않는다(미설정). */
const staffTimes = [
  { dayCd: 1, staffOpenHm: '0900', staffCloseHm: '1800' },
  { dayCd: 2, staffOpenHm: null, staffCloseHm: null },
]

/* 사업장 — 월~토 10:00~17:00. 미설정 요일(수)이 따르게 되는 값. */
const institutionTimes = [1, 2, 3, 4, 5, 6].map(dayCd => ({
  dayCd,
  openHm: '1000',
  closeHm: '1700',
  lunchStartHm: null, lunchEndHm: null,
  dinnerStartHm: null, dinnerEndHm: null,
}))

async function mountView() {
  const wrapper = mount(SchedulerSettingsTreatmentView, {
    global: { stubs: { CellMorePopover: true } },
  })
  for (let i = 0; i < 5; i++) await wrapper.vm.$nextTick()
  return wrapper
}

/** 이번 달 셀 → 그 셀의 직원 entry 목록 [{name, time}] */
function entriesOfDay(wrapper: any, ymd: string) {
  const day = String(dayjs(ymd).date())
  const cell = wrapper.findAll('.schedulerTreatmentView__cell').find((c: any) => {
    if (c.classes('is-other')) return false
    return c.find('.schedulerTreatmentView__cellDate').exists()
      && c.find('.schedulerTreatmentView__cellDate').text() === day
  })
  expect(cell, `이번 달 ${day}일 셀`).toBeTruthy()
  return cell!.findAll('.schedulerTreatmentView__appt').map((a: any) => ({
    name: a.find('.schedulerTreatmentView__apptDoctor').text(),
    time: a.find('.schedulerTreatmentView__apptTime').text(),
  }))
}

/** '운영일'/'휴무일' 세그먼트 클릭 */
async function selectDayType(wrapper: any, label: '운영일' | '휴무일') {
  const btn = wrapper.findAll('.scheduleSegment__btn').find((b: any) => b.text() === label)
  await btn!.trigger('click')
  await wrapper.vm.$nextTick()
}

describe('운영일정 보기 — 요일 3상태 표기 (설정 화면과 동일)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getTeams.mockResolvedValue({
      data: { payload: { teams: [{ id: 1, name: '1구역', doctors: [{ staffId: STAFF_ID, staffName: DOCTOR }] }] } },
    })
    // 휴무 규칙 없음 — 이 달은 전부 운영일
    mocks.getTreatmentSettings.mockResolvedValue({
      data: { payload: { recurringOffRules: [], offDates: [], workDates: [], holidayClosedYn: false, teams: [] } },
    })
    mocks.getStaffWorkHours.mockResolvedValue({
      data: { payload: { staff: [{ staffId: STAFF_ID, staffName: DOCTOR, times: staffTimes }], overrides: [] } },
    })
    mocks.getSiteWorkHours.mockResolvedValue({ data: { payload: { site: institutionTimes } } })
  })

  it('운영 — 본인이 정한 시간이 그대로 표기된다 (기관 값으로 덮이지 않는다)', async () => {
    const wrapper = await mountView()
    expect(entriesOfDay(wrapper, D_WORK)).toEqual([{ name: DOCTOR, time: '09:00 ~ 18:00' }])
  })

  it('★미설정 — 정한 적 없는 요일은 사업장 운영시간으로 표기된다', async () => {
    const wrapper = await mountView()
    // 예전에는 이 요일이 "휴무"이라 운영일 목록에서 아예 빠졌다.
    expect(entriesOfDay(wrapper, D_UNSET)).toEqual([{ name: DOCTOR, time: '10:00 ~ 17:00' }])
  })

  /* 2026-09-02 규약 — 아무도 정하지 않은 요일은 예약장부 보드·타임라인이 실제로 여는 시간을 빌린다.
   * 설정 화면(defaultWorkBlocks)과 같은 값이어야 한다. 종전에는 목록에서 빠져,
   * 화면에는 없는데 보드에서는 예약을 받는 상태였다. */
  it('★미설정 + 사업장도 그 요일을 정하지 않음 → 보드가 여는 기본 운영시간으로 표기된다', async () => {
    const wrapper = await mountView()
    expect(entriesOfDay(wrapper, D_NO_INSTITUTION)).toEqual([{ name: DOCTOR, time: '09:00 ~ 18:00' }])
  })

  /* 사업장이 임시운영으로 지정한 날짜에는 그 날짜 운영시간이 따로 저장된다(응답 dateTimes).
   * 보드·타임라인·설정 화면이 모두 이 값을 요일보다 먼저 쓴다 — 이 화면만 빠지면 시간이 갈린다. */
  it('★사업장이 그 날짜에 저장한 시각은 요일 시간을 이긴다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        payload: {
          site     : institutionTimes,
          dateTimes: [{
            date: D_UNSET, closed: false, openHm: '1400', closeHm: '1600',
            lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
          }],
        },
      },
    })
    const wrapper = await mountView()
    expect(entriesOfDay(wrapper, D_UNSET)).toEqual([{ name: DOCTOR, time: '14:00 ~ 16:00' }])
  })

  it('★휴무 — 쉬기로 정한 요일은 사업장 값으로 대체되지 않는다', async () => {
    const wrapper = await mountView()
    expect(entriesOfDay(wrapper, D_OFF)).toEqual([])

    await selectDayType(wrapper, '휴무일')
    expect(entriesOfDay(wrapper, D_OFF)).toEqual([{ name: DOCTOR, time: '(휴무)' }])
  })

  it('휴무일 모드에서 미설정·운영 요일은 휴무로 잡히지 않는다', async () => {
    const wrapper = await mountView()
    await selectDayType(wrapper, '휴무일')

    expect(entriesOfDay(wrapper, D_WORK)).toEqual([])
    expect(entriesOfDay(wrapper, D_UNSET)).toEqual([])
  })

  it("★미설정 + 사업장 운영시간을 모름 → '휴무'으로 찍지 않고 표기하지 않는다 (APB031 §3-1)", async () => {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { payload: { site: [] } } })
    const wrapper = await mountView()
    await selectDayType(wrapper, '휴무일')

    // 휴무로 정한 적이 없는 직원은 휴무일 목록에 나오지 않는다 — "휴무하는 직원에 대한 정보만 표기"
    expect(entriesOfDay(wrapper, D_UNSET)).toEqual([])
    // 쉬기로 정한 요일은 기관 조회와 무관하게 그대로 '휴무'
    expect(entriesOfDay(wrapper, D_OFF)).toEqual([{ name: DOCTOR, time: '(휴무)' }])
  })

  it('사업장 운영시간 조회가 실패해도 화면은 뜬다 (미설정 직원은 표기 대상에서 빠진다)', async () => {
    mocks.getSiteWorkHours.mockRejectedValue(new Error('사업장 설정 down'))
    const wrapper = await mountView()

    // 본인이 정한 요일은 조회 실패와 무관하게 그대로 보인다
    expect(entriesOfDay(wrapper, D_WORK)).toEqual([{ name: DOCTOR, time: '09:00 ~ 18:00' }])
    // 미설정 요일은 운영일 목록에서 빠지고
    expect(entriesOfDay(wrapper, D_UNSET)).toEqual([])

    // 휴무일 목록에도 잡히지 않는다 — 휴무로 정한 적이 없다
    await selectDayType(wrapper, '휴무일')
    expect(entriesOfDay(wrapper, D_UNSET)).toEqual([])
  })

  it('일자 지정은 요일 설정보다 우선한다 (미설정 요일에도 지정이 이긴다)', async () => {
    mocks.getStaffWorkHours.mockResolvedValue({
      data: {
        payload: {
          staff: [{ staffId: STAFF_ID, staffName: DOCTOR, times: staffTimes }],
          overrides: [
            { staffId: STAFF_ID, date: D_UNSET, overrideOpenHm: '1300', overrideCloseHm: '1600' },
          ],
        },
      },
    })
    const wrapper = await mountView()
    // 미설정 요일이라도 그 날짜에 지정이 있으면 기관 폴백이 아니라 지정이 답이다
    expect(entriesOfDay(wrapper, D_UNSET)).toEqual([{ name: DOCTOR, time: '13:00 ~ 16:00' }])
  })
})
