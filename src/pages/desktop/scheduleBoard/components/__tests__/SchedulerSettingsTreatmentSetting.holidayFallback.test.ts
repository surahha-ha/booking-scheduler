/**
 * @vitest-environment happy-dom
 *
 * 공휴일에 미설정 담당자가 빌려 쓰는 사업장 시간 (2026-08-28).
 *
 * 종전에는 공휴일에도 사업장의 **요일** 운영시간을 빌렸다. 기관이 공휴일 운영시간을 따로
 * 등록해 뒀으면 그 값과 다른 시각이 셀에 찍힌다 — 기관은 13시에 닫는데 화면은 18시까지 연다고 한다.
 * 기관이 공휴일 시간을 따로 등록했다는 건 "이날은 요일 시간과 다르다"는 명시적 의사표시이므로
 * 상속도 그것을 따라야 한다(institutionBlocksOn).
 *
 * ★등록하지 않은 기관은 요일 시간으로 내려간다 — 현행 유지다. 그 폴백까지 없애면 지금 보이던 줄이
 *  통째로 사라진다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const dialogMock = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn() }))
vi.mock('@/lib/http', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
  useDialog: () => dialogMock,
}))
vi.mock('@/lib/useDialog', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
  useDialog: () => dialogMock,
}))
vi.mock('notivue', () => ({
  push: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

/* 2026-08-18(화)만 공휴일로 둔다 — 같은 화요일인 08-25 와 대조해 공휴일 축만 갈리는지 본다. */
const HOLIDAY = '2026-08-18'
const PLAIN_TUE = '2026-08-25'
vi.mock('@/stores/holidayStore', () => ({
  useHolidayStore: () => ({ isHoliday: (d: string) => d === '2026-08-18', ensureYears: vi.fn(async () => {}) }),
}))

const mocks = vi.hoisted(() => ({
  getTeams: vi.fn(),
  getSiteWorkHours: vi.fn(),
  getStaffWorkHours: vi.fn(),
  saveTreatmentSettings: vi.fn(),
  getUnassignedReservations: vi.fn(),
  assignUnassigned: vi.fn(),
}))
vi.mock('@/api/siteApi', () => ({
  getTeams: mocks.getTeams,
  getSiteWorkHours: mocks.getSiteWorkHours,
  getStaffWorkHours: mocks.getStaffWorkHours,
  saveTreatmentSettings: mocks.saveTreatmentSettings,
}))
vi.mock('@/api/bookApi', () => ({
  getUnassignedReservations: mocks.getUnassignedReservations,
  assignUnassigned: mocks.assignUnassigned,
}))

import dayjs from 'dayjs'
import SchedulerSettingsTreatmentSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTreatmentSetting.vue'
import { useStaffStore } from '@/stores/staffStore'

const TUESDAY = 2
const DOC = 11
const NAME = '공휴일운영'

/* 사업장 화요일 10:00~17:00 / 공휴일 09:00~13:00 — 일부러 다른 값이라 어느 쪽을 빌렸는지 드러난다. */
const SITE_ROWS = [{
  dayCd: TUESDAY, openHm: '1000', closeHm: '1700',
  lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
}]
const HOLIDAY_TIME = {
  openHm: '0900', closeHm: '1300',
  lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
}

const mounted: any[] = []
afterEach(() => {
  mounted.forEach(w => w.unmount())
  mounted.length = 0
})

/** holidayClosedYn=true = 사업장은 공휴일 휴무. 담당자는 holidayOpenYn='Y' 라 그날 운영한다(R11). */
function setupMocks(holidayHours: any, holidayClosedYn = true, dateTimes: any[] = []) {
  mocks.getTeams.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: { teams: [{ id: '1', name: '1팀', doctors: [{ staffId: DOC, staffName: NAME }] }] },
    },
  })
  mocks.getSiteWorkHours.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: { site: SITE_ROWS, holidayHours, dateTimes, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn },
    },
  })
  mocks.getStaffWorkHours.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: { staff: [{ staffId: DOC, staffName: NAME, times: [], monthlyOffRules: [], holidayOpenYn: 'Y' }], overrides: [] },
    },
  })
  mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', payload: {} } })
}

async function mountSetting() {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  mounted.push(wrapper)
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

function labelOf(wrapper: any, dateKey: string) {
  const entries = wrapper.vm.$.setupState.formatListEntries([DOC], dayjs(dateKey), dateKey)
  expect(entries[0], `${dateKey} entry`).toBeTruthy()
  return entries[0].label
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  useStaffStore().doctors.push({ id: `${DOC}`, text: NAME, staffId: DOC } as any)
})

describe('공휴일 폴백 — 사업장 공휴일 운영시간이 요일 시간보다 먼저다', () => {
  it('★공휴일에는 기관 공휴일 운영시간을 빌린다 (요일 시간이 아니다)', async () => {
    setupMocks(HOLIDAY_TIME)
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, HOLIDAY)).toBe(`${NAME} 09:00 ~ 13:00`)
  })

  it('같은 요일이라도 공휴일이 아니면 요일 시간을 빌린다 — 공휴일 값이 평일까지 물들이지 않는다', async () => {
    setupMocks(HOLIDAY_TIME)
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, PLAIN_TUE)).toBe(`${NAME} 10:00 ~ 17:00`)
  })

  it('기관이 공휴일 시간을 등록하지 않았으면 요일 시간으로 내려간다 (줄이 사라지지 않는다)', async () => {
    setupMocks(null)
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, HOLIDAY)).toBe(`${NAME} 10:00 ~ 17:00`)
  })

  it('공휴일 시간의 시작·종료가 온전치 않으면 요일 시간으로 내려간다', async () => {
    setupMocks({ ...HOLIDAY_TIME, closeHm: null })
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, HOLIDAY)).toBe(`${NAME} 10:00 ~ 17:00`)
  })

  it('기관도 공휴일 운영(holidayClosedYn=false)면 같은 값을 빌린다 — 기관 휴무 여부와 무관한 표기다', async () => {
    setupMocks(HOLIDAY_TIME, false)
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, HOLIDAY)).toBe(`${NAME} 09:00 ~ 13:00`)
  })

  it('자기 운영시간을 가진 담당자는 공휴일에도 자기 값이다 — 빌리지 않는다', async () => {
    setupMocks(HOLIDAY_TIME)
    mocks.getStaffWorkHours.mockResolvedValue({
      data: {
        code   : 'succeed',
        payload: {
          staff: [{
            staffId : DOC, staffName: NAME,
            times          : [{ dayCd: TUESDAY, staffOpenHm: '0800', staffCloseHm: '1200' }],
            monthlyOffRules: [], holidayOpenYn: 'Y',
          }],
          overrides: [],
        },
      },
    })
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, HOLIDAY)).toBe(`${NAME} 08:00 ~ 12:00`)
  })
})

/**
 * 일자별 폴백 (2026-09-02).
 *
 * 사업장이 임시운영으로 지정한 날짜에는 그 날짜의 운영시간이 따로 저장된다(응답 dateTimes, 원천 외부 시스템).
 * 보드 예약검증(pickDailySchedule)·타임라인 밴드(resolveUnitHours)는 이 값을 요일·공휴일보다 먼저 쓰는데
 * 설정·보기 화면만 읽지 않아, 같은 날 같은 담당자의 시간이 화면마다 갈렸다.
 */
describe('일자별 폴백 — 그 날짜에 저장된 시각이 공휴일·요일보다 먼저다', () => {
  const dateTimeRow = (date: string, closed: boolean, start: string | null, end: string | null) => ({
    date, closed, openHm: start, closeHm: end,
    lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
  })

  it('★그 날짜에 저장된 시각이 있으면 공휴일 운영시간보다 먼저다', async () => {
    setupMocks(HOLIDAY_TIME, true, [dateTimeRow(HOLIDAY, false, '1400', '1600')])
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, HOLIDAY)).toBe(`${NAME} 14:00 ~ 16:00`)
  })

  it('평일도 마찬가지 — 그 날짜 시각이 요일 시간을 이긴다', async () => {
    setupMocks(HOLIDAY_TIME, true, [dateTimeRow(PLAIN_TUE, false, '1400', '1600')])
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, PLAIN_TUE)).toBe(`${NAME} 14:00 ~ 16:00`)
  })

  it('임시휴무(closed)인 날짜의 행은 시간으로 쓰지 않는다 — 휴무는 일자 지정이 갖는다', async () => {
    setupMocks(HOLIDAY_TIME, true, [dateTimeRow(PLAIN_TUE, true, '1400', '1600')])
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, PLAIN_TUE)).toBe(`${NAME} 10:00 ~ 17:00`)
  })

  it('시작·종료가 반쪽인 행은 쓰지 않는다 — 종전 폴백으로 내려간다', async () => {
    setupMocks(HOLIDAY_TIME, true, [dateTimeRow(PLAIN_TUE, false, '1400', null)])
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, PLAIN_TUE)).toBe(`${NAME} 10:00 ~ 17:00`)
  })
})
