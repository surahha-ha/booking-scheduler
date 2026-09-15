/**
 * @vitest-environment happy-dom
 *
 * 운영일정 "설정" 화면 — 캘린더 셀의 직원 리스트는 **직원마다 따로 판정**한다.
 *
 * 날짜 옆 '휴무' 라벨은 사업장 축이고 직원 리스트는 담당자 축이다(화면정의서 APB031 §2-1).
 * 예전에는 셀의 isOff 를 그대로 직원 전원에게 접어 내려, 사업장이 공휴일 휴무가면
 * 공휴일 진료('Y')로 정한 담당자까지 "(휴무)"으로 찍혔다. 지금은 라벨 판정이
 * `offDayRules.isStaffOffOn` 하나로 모여 있고(§4-2), 화면은 직원별로 그것을 부른다.
 *
 * 이 파일이 고정하는 것 — `formatListEntries(doctorIds, date, dateKey)` 의 라벨:
 *   1. holidayOpenYn='Y' 담당자의 공휴일 → "(휴무)"이 아니라 운영시간
 *      (자기 요일값이 있으면 그 값, 없으면 사업장 그 요일값)
 *   2. holidayOpenYn='N' 담당자의 공휴일 → "(휴무)"
 *   3. 매월 N번째 O요일 규칙(monthlyOffRules)에 걸린 평일 → "(휴무)"
 *
 * 보기 화면(SchedulerSettingsTreatmentView.holidayAxis.test.ts)이 같은 규칙을 같은 값으로
 * 지킨다 — 두 화면이 갈리면 사용자는 무엇이 맞는지 알 수 없다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'

/* 고정 날짜 — 공휴일·요일·"매월 N번째"가 전부 날짜에 걸려 있어 실행일에 흔들리면 안 된다.
 *   2026-05-05 화 · 어린이날(이 테스트에서 유일한 공휴일)
 *   2026-05-12 화 · 평일 대조군
 *   2026-05-11 월 · 그 달 2번째 월요일 → 매월 규칙 대상
 *   2026-05-18 월 · 그 달 3번째 월요일 → 규칙 밖 대조군 */
const HOLIDAY = '2026-05-05'
const PLAIN_TUE = '2026-05-12'
const MONTHLY_OFF_MON = '2026-05-11'
const PLAIN_MON = '2026-05-18'

const MONDAY = 1
const TUESDAY = 2

// ── 외부 의존 stub ──────────────────────────────────────────
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
vi.mock('@/stores/holidayStore', () => ({
  useHolidayStore: () => ({
    isHoliday: (key: string) => key === '2026-05-05',
    ensureYears: vi.fn(async () => {}),
  }),
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

import SchedulerSettingsTreatmentSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTreatmentSetting.vue'
import { useStaffStore } from '@/stores/staffStore'

// ── fixture ────────────────────────────────────────────────
const DOC_WORK = 301  // 공휴일에도 진료 (holidayOpenYn='Y')
const DOC_OFF = 302   // 공휴일은 휴무   (holidayOpenYn='N')
const NAME_WORK = '진료의'
const NAME_OFF = '휴무의'

/* 사업장 — 월 09:00~18:00 / 화 10:00~17:00 */
const siteRows = [
  { dayCd: MONDAY, openHm: '0900', closeHm: '1800', lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null },
  { dayCd: TUESDAY, openHm: '1000', closeHm: '1700', lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null },
]

/** 계약대로 monthlyOffRules(배열)·holidayOpenYn('Y'|'N') 을 항상 채운 staff 행 */
function staffRow(
    staffId: number,
    staffName: string,
    holidayOpenYn: 'Y' | 'N',
    times: Array<{ dayCd: number; staffOpenHm: string | null; staffCloseHm: string | null }> = [],
    monthlyOffRules: Array<{ dayCd: number; monthlyNth: number }> = [],
) {
  return { staffId, staffName, times, monthlyOffRules, holidayOpenYn }
}

const mounted: any[] = []
afterEach(() => {
  mounted.forEach(w => w.unmount())
  mounted.length = 0
})

/** holidayClosedYn=true = 사업장은 공휴일 휴무(= 화면의 '공휴일' 체크 상태) */
function setupMocks(staff: any[], overrides: any[] = []) {
  mocks.getTeams.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: {
        teams: [{
          id     : '1',
          name   : '1진료팀',
          doctors: [
            { staffId: DOC_WORK, staffName: '공휴일진료' },
            { staffId: DOC_OFF, staffName: '공휴일휴무' },
          ],
        }],
      },
    },
  })
  mocks.getSiteWorkHours.mockResolvedValue({
    data: {
      code   : 'succeed',
      payload: { site: siteRows, holidayHours: null, recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: true },
    },
  })
  mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff, overrides } } })
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

/** 그 (직원, 날짜) 셀 entry — 라벨 판정이 겉으로 드러나는 유일한 지점 */
function entryOf(wrapper: any, doctorId: number, dateKey: string) {
  const entries = wrapper.vm.$.setupState.formatListEntries([doctorId], dayjs(dateKey), dateKey)
  const entry = entries.find((e: any) => e.staffId === doctorId)
  expect(entry, `${doctorId} / ${dateKey} entry`).toBeTruthy()
  return entry
}

function labelOf(wrapper: any, doctorId: number, dateKey: string) {
  return entryOf(wrapper, doctorId, dateKey).label
}

describe('설정 화면 공휴일 — 직원별 holidayOpenYn 이 사업장 휴무를 이긴다', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    // 셀 entry 는 이름을 staffStore.doctors 에서 찾는다 — 없으면 entry 자체가 만들어지지 않는다
    const staff = useStaffStore()
    staff.doctors.push({ id: `${DOC_WORK}`, text: NAME_WORK, staffId: DOC_WORK } as any)
    staff.doctors.push({ id: `${DOC_OFF}`, text: NAME_OFF, staffId: DOC_OFF } as any)
    setupMocks([
      staffRow(DOC_WORK, NAME_WORK, 'Y'),
      staffRow(DOC_OFF, NAME_OFF, 'N'),
    ])
  })

  it("★holidayOpenYn='Y' + 자기 요일값 없음 → 사업장 그 요일 운영시간으로 표기된다", async () => {
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, DOC_WORK, HOLIDAY), '기관 공휴일 휴무가 덮으면 안 된다')
        .toBe(`${NAME_WORK} 10:00 ~ 17:00`)
    expect(entryOf(wrapper, DOC_WORK, HOLIDAY).isOff).toBe(false)
  })

  it("★holidayOpenYn='Y' + 자기 요일값 있음 → 자기 값으로 표기된다", async () => {
    setupMocks([
      staffRow(DOC_WORK, NAME_WORK, 'Y', [{ dayCd: TUESDAY, staffOpenHm: '0800', staffCloseHm: '1200' }]),
      staffRow(DOC_OFF, NAME_OFF, 'N'),
    ])
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, DOC_WORK, HOLIDAY)).toBe(`${NAME_WORK} 08:00 ~ 12:00`)
  })

  it("★holidayOpenYn='N' → 공휴일은 \"(휴무)\"", async () => {
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, DOC_OFF, HOLIDAY)).toBe(`${NAME_OFF} (휴무)`)
    expect(entryOf(wrapper, DOC_OFF, HOLIDAY).isOff).toBe(true)
  })

  it('공휴일이 아닌 같은 요일은 두 담당자 모두 진료다 (공휴일 축이 평일까지 물들이지 않는다)', async () => {
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, DOC_WORK, PLAIN_TUE)).toBe(`${NAME_WORK} 10:00 ~ 17:00`)
    expect(labelOf(wrapper, DOC_OFF, PLAIN_TUE)).toBe(`${NAME_OFF} 10:00 ~ 17:00`)
  })

  /* 판정 1단계(일자 지정)가 2단계(공휴일)를 이긴다 — 공휴일 휴무로 정한 담당자도
   * 그 날짜만 진료로 지정했으면 시간이 보이고, 그 줄만 지정으로 강조된다. */
  it("★일자 지정은 holidayOpenYn='N' 을 이긴다 — 시간이 보이고 그 줄만 강조된다", async () => {
    setupMocks(
        [staffRow(DOC_WORK, NAME_WORK, 'Y'), staffRow(DOC_OFF, NAME_OFF, 'N')],
        [{ staffId: DOC_OFF, date: HOLIDAY, overrideOpenHm: '1400', overrideCloseHm: '1900' }],
    )
    const wrapper = await mountSetting()

    const entry = entryOf(wrapper, DOC_OFF, HOLIDAY)
    expect(entry.label).toBe(`${NAME_OFF} 14:00 ~ 19:00`)
    expect(entry.isOff).toBe(false)
    expect(entry.isDesignated, '사업장 휴무일에도 지정 강조를 억제하지 않는다').toBe(true)
  })
})

describe('설정 화면 매월 N번째 휴무 — 같은 요일이라도 그 주차만 쉰다', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    const staff = useStaffStore()
    staff.doctors.push({ id: `${DOC_WORK}`, text: NAME_WORK, staffId: DOC_WORK } as any)
    staff.doctors.push({ id: `${DOC_OFF}`, text: NAME_OFF, staffId: DOC_OFF } as any)
    setupMocks([
      // 매월 2번째 월요일 휴무 — 월요일 운영시간은 정해 두었다(규칙이 요일 설정을 이긴다)
      staffRow(DOC_WORK, NAME_WORK, 'Y',
          [{ dayCd: MONDAY, staffOpenHm: '0900', staffCloseHm: '1300' }],
          [{ dayCd: MONDAY, monthlyNth: 2 }]),
      staffRow(DOC_OFF, NAME_OFF, 'N'),
    ])
  })

  it('★매월 2번째 월요일은 "(휴무)" — 그 요일에 운영시간을 정해 뒀어도 규칙이 이긴다', async () => {
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, DOC_WORK, MONTHLY_OFF_MON)).toBe(`${NAME_WORK} (휴무)`)
    expect(entryOf(wrapper, DOC_WORK, MONTHLY_OFF_MON).isOff).toBe(true)
  })

  it('같은 요일이라도 3번째 월요일은 진료다 — 규칙이 그 요일 전체를 덮지 않는다', async () => {
    const wrapper = await mountSetting()

    expect(labelOf(wrapper, DOC_WORK, PLAIN_MON)).toBe(`${NAME_WORK} 09:00 ~ 13:00`)
  })

  it('매월 규칙은 그 담당자 것이다 — 규칙 없는 담당자는 같은 날 진료다', async () => {
    const wrapper = await mountSetting()

    // DOC_OFF 는 월요일 미설정이라 사업장 월요일 값을 따른다
    expect(labelOf(wrapper, DOC_OFF, MONTHLY_OFF_MON)).toBe(`${NAME_OFF} 09:00 ~ 18:00`)
  })
})
