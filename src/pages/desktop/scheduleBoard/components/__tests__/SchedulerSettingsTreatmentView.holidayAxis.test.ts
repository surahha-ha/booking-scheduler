/**
 * @vitest-environment happy-dom
 *
 * 운영일정 "보기" 화면 — **공휴일에는 담당자마다 답이 다르다**.
 *
 * 셀 옆의 빨간 '휴무' 라벨은 **사업장 축**이고, 셀 안의 직원 리스트는 **담당자 축**이다
 * (화면정의서 APB031 §2-1). 예전에는 사업장 축의 isOff 를 직원 전원에게 그대로 접어
 * 내려(fold-down) 공휴일 진료('Y')로 정한 담당자까지 "(휴무)"으로 찍혔다. 두 축은 갈라야 한다.
 *
 * 이 파일이 고정하는 것:
 *   1. holidayOpenYn='Y' 담당자는 사업장이 공휴일 휴무가어도 진료로 표기된다(시간까지).
 *   2. holidayOpenYn='N' 담당자는 "(휴무)"이다.
 *   3. 1·2 와 무관하게 셀의 isOff(빨간 라벨)는 사업장 축이라 그대로 true 다.
 *   4. 사업장 축 자체의 우선순위는 "일자 지정 > 공휴일 스위치 > 반복 휴무" 이다 —
 *      공휴일이라도 그 날짜를 임시진료(workDates)로 지정했으면 셀은 휴무가 아니다.
 *
 * 판정 본체는 순수함수(`offDayRules.isStaffOffOn`)에 있지만, "화면이 그 함수를 실제로 쓰는가 ·
 * 응답의 holidayOpenYn/monthlyOffRules 를 수집하는가"는 마운트해야만 드러난다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

/* 2026-05-05(화) 어린이날 — 이 날짜 하나만 공휴일로 본다.
 * 고정 날짜를 쓰는 이유: 공휴일·요일·"매월 N번째" 가 전부 날짜에 걸려 있어
 * 실행일에 따라 흔들리면 무엇이 실패했는지 알 수 없다. */
const HOLIDAY = '2026-05-05'   // 화요일
const PLAIN_TUE = '2026-05-12' // 화요일 · 공휴일 아님 (대조군)
const MONTH_KEY = '2026-05'
const TUESDAY = 2

// ── 외부 의존 stub ──────────────────────────────────────────
vi.mock('@/lib/http', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
}))
vi.mock('@/stores/holidayStore', () => ({
  useHolidayStore: () => ({
    isHoliday: (key: string) => key === '2026-05-05',
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

// ── fixture ────────────────────────────────────────────────
const DOC_WORK = 201  // 공휴일에도 진료 (holidayOpenYn='Y')
const DOC_OFF = 202   // 공휴일은 휴무   (holidayOpenYn='N')
const NAME_WORK = '진료의'
const NAME_OFF = '휴무의'

/* 사업장 — 월~금 10:00~17:00. 자기 요일값이 없는 담당자가 따르게 되는 값. */
const institutionTimes = [1, 2, 3, 4, 5].map(dayCd => ({
  dayCd,
  openHm: '1000',
  closeHm : '1700',
  lunchStartHm: null, lunchEndHm: null,
  dinnerStartHm: null, dinnerEndHm: null,
}))

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

function setStaff(rows: any[], overrides: any[] = []) {
  mocks.getStaffWorkHours.mockResolvedValue({ data: { payload: { staff: rows, overrides } } })
}

/** 운영일정 설정(사업장 축) — holidayClosedYn=true 는 "공휴일은 휴무" */
function setInstitutionSettings(patch: Record<string, unknown> = {}) {
  mocks.getTreatmentSettings.mockResolvedValue({
    data: {
      payload: {
        teams            : [],
        recurringOffRules: [],
        offDates         : [],
        workDates        : [],
        holidayClosedYn           : true,
        ...patch,
      },
    },
  })
}

async function mountView() {
  const wrapper = mount(SchedulerSettingsTreatmentView, {
    global: { stubs: { CellMorePopover: true } },
  })
  await flushPromises()
  // 캘린더는 기본이 "이번 달"이라 고정 날짜를 보려면 달을 옮긴다
  wrapper.vm.$.setupState.selectedMonthKey = MONTH_KEY
  await wrapper.vm.$nextTick()
  return wrapper
}

/** 그 날짜의 캘린더 셀 (이번 달 셀만) */
function cellOf(wrapper: any, dateKey: string) {
  const cell = wrapper.vm.$.setupState.calendarCells
      .find((c: any) => c.key === dateKey && c.isCurrentMonth)
  expect(cell, `${dateKey} 셀`).toBeTruthy()
  return cell
}

/** 그 셀의 직원 리스트 — [{name, time}] */
function entriesOf(wrapper: any, dateKey: string) {
  return cellOf(wrapper, dateKey).entries.map((e: any) => ({ name: e.name, time: e.time }))
}

/** '진료일'(WORK) / '휴무일'(OFF) 세그먼트 전환 */
async function setDayType(wrapper: any, type: 'WORK' | 'OFF') {
  wrapper.vm.$.setupState.selectedDayType = type
  await wrapper.vm.$nextTick()
}

describe('보기 화면 공휴일 — 사업장 축(셀 라벨)과 담당자 축(직원 리스트)은 다르다', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mocks.getTeams.mockResolvedValue({
      data: {
        payload: {
          teams: [{
            id     : 1,
            name   : '1구역',
            doctors: [
              { staffId: DOC_WORK, staffName: NAME_WORK },
              { staffId: DOC_OFF, staffName: NAME_OFF },
            ],
          }],
        },
      },
    })
    setInstitutionSettings()
    setStaff([
      staffRow(DOC_WORK, NAME_WORK, 'Y'),
      staffRow(DOC_OFF, NAME_OFF, 'N'),
    ])
    mocks.getSiteWorkHours.mockResolvedValue({ data: { payload: { site: institutionTimes } } })
  })

  it("★holidayOpenYn='Y' — 기관이 공휴일 휴무가어도 진료일 목록에 시간과 함께 남는다", async () => {
    const wrapper = await mountView()

    // 자기 요일값이 없으므로 사업장 그 요일(화) 운영시간을 따른다
    expect(entriesOf(wrapper, HOLIDAY)).toEqual([{ name: NAME_WORK, time: '10:00 ~ 17:00' }])
  })

  it("★holidayOpenYn='Y' — 휴무일 목록에는 들어가지 않는다", async () => {
    const wrapper = await mountView()
    await setDayType(wrapper, 'OFF')

    expect(entriesOf(wrapper, HOLIDAY).map((e: any) => e.name)).not.toContain(NAME_WORK)
  })

  it("★holidayOpenYn='N' — 공휴일은 \"(휴무)\" 으로 표기된다", async () => {
    const wrapper = await mountView()
    await setDayType(wrapper, 'OFF')

    expect(entriesOf(wrapper, HOLIDAY)).toEqual([{ name: NAME_OFF, time: '(휴무)' }])
  })

  it("holidayOpenYn='Y' 는 자기 요일값이 있으면 그 값으로 표기된다 (기관 값이 아니다)", async () => {
    setStaff([
      staffRow(DOC_WORK, NAME_WORK, 'Y', [{ dayCd: TUESDAY, staffOpenHm: '0800', staffCloseHm: '1200' }]),
      staffRow(DOC_OFF, NAME_OFF, 'N'),
    ])
    const wrapper = await mountView()

    expect(entriesOf(wrapper, HOLIDAY)).toEqual([{ name: NAME_WORK, time: '08:00 ~ 12:00' }])
  })

  it('★셀의 휴무 라벨(isOff)은 사업장 축이라 직원 판정과 무관하게 유지된다', async () => {
    const wrapper = await mountView()

    // 'Y' 담당자가 그 날 진료해도 기관은 여전히 공휴일 휴무가다
    expect(cellOf(wrapper, HOLIDAY).isOff, '공휴일 + holidayClosedYn=true').toBe(true)
    expect(cellOf(wrapper, PLAIN_TUE).isOff, '평일 대조군').toBe(false)
  })

  it('공휴일이 아닌 화요일은 두 담당자 모두 진료다 (공휴일 축이 평일까지 물들이지 않는다)', async () => {
    const wrapper = await mountView()

    expect(entriesOf(wrapper, PLAIN_TUE)).toEqual([
      { name: NAME_WORK, time: '10:00 ~ 17:00' },
      { name: NAME_OFF, time: '10:00 ~ 17:00' },
    ])
  })

  /* ★사업장 축의 순서 교정 — 예전에는 공휴일 여부를 먼저 보고 일자 지정을 무시해,
   * 공휴일에 임시진료로 지정해 둔 날도 셀이 '휴무'으로 남았다. */
  it('★일자 임시진료(workDates)는 공휴일 스위치를 이긴다 — 셀 isOff=false', async () => {
    setInstitutionSettings({ workDates: [HOLIDAY] })
    const wrapper = await mountView()

    expect(cellOf(wrapper, HOLIDAY).isOff).toBe(false)
  })

  it("★기관이 임시진료로 열어도 holidayOpenYn='N' 담당자는 여전히 휴무가다", async () => {
    setInstitutionSettings({ workDates: [HOLIDAY] })
    const wrapper = await mountView()
    await setDayType(wrapper, 'OFF')

    // 기관 축은 진료(isOff=false)지만, 공휴일 휴무는 그 담당자가 직접 정한 답이라 상속에 지지 않는다
    expect(entriesOf(wrapper, HOLIDAY)).toEqual([{ name: NAME_OFF, time: '(휴무)' }])
  })

  it('★일자 임시휴무(offDates)은 공휴일 진료 담당자도 쉬게 한다 — 병원이 그날 문을 닫는다', async () => {
    setInstitutionSettings({ holidayClosedYn: false, offDates: [HOLIDAY] })
    const wrapper = await mountView()

    /* 'Y' 는 "공휴일이라는 이유로는 쉬지 않는다"는 뜻일 뿐, 그 날짜를 진료로 지정한 것이 아니다.
     * 그 담당자는 그 날짜도 그 요일도 정한 것이 없으므로 기관 일자 지정을 상속한다(§4-2 4단계). */
    expect(cellOf(wrapper, HOLIDAY).isOff, '기관 축은 휴무').toBe(true)
    expect(entriesOf(wrapper, HOLIDAY), '진료일 모드에 뜨지 않는다').toEqual([])

    await setDayType(wrapper, 'OFF')
    expect(entriesOf(wrapper, HOLIDAY).map((e: any) => e.name), '휴무일 모드에 뜬다')
        .toContain(NAME_WORK)
  })
})

/**
 * 미설정 담당자가 공휴일에 빌려 쓰는 사업장 시간 (2026-08-28).
 *
 * 종전에는 공휴일에도 기관의 **요일** 운영시간을 빌렸다. 기관이 공휴일 운영시간(holidayHours)을 따로
 * 등록해 뒀으면 그 값과 다른 시각이 찍힌다. 설정 화면(institutionBlocksOn)과 **같은 규칙**이어야
 * 한다 — 갈리면 같은 날 같은 담당자가 보기와 설정에서 다른 시간으로 보인다.
 */
describe('보기 화면 공휴일 폴백 — 기관 공휴일 운영시간이 요일 시간보다 먼저다', () => {
  /* 기관 화요일 10:00~17:00(institutionTimes)과 일부러 다른 값이라 어느 쪽을 빌렸는지 드러난다 */
  const HOLIDAY_TIME = {
    openHm: '0900', closeHm: '1300',
    lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mocks.getTeams.mockResolvedValue({
      data: {
        payload: {
          teams: [{ id: 1, name: '1구역', doctors: [{ staffId: DOC_WORK, staffName: NAME_WORK }] }],
        },
      },
    })
    setInstitutionSettings()
    setStaff([staffRow(DOC_WORK, NAME_WORK, 'Y')])
  })

  it('★공휴일에는 기관 공휴일 운영시간을 빌린다 (요일 시간이 아니다)', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { payload: { site: institutionTimes, holidayHours: HOLIDAY_TIME } } })
    const wrapper = await mountView()

    expect(entriesOf(wrapper, HOLIDAY)).toEqual([{ name: NAME_WORK, time: '09:00 ~ 13:00' }])
  })

  it('같은 요일이라도 공휴일이 아니면 요일 시간을 빌린다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { payload: { site: institutionTimes, holidayHours: HOLIDAY_TIME } } })
    const wrapper = await mountView()

    expect(entriesOf(wrapper, PLAIN_TUE)).toEqual([{ name: NAME_WORK, time: '10:00 ~ 17:00' }])
  })

  it('기관이 공휴일 시간을 등록하지 않았으면 요일 시간으로 내려간다 (줄이 사라지지 않는다)', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { payload: { site: institutionTimes, holidayHours: null } } })
    const wrapper = await mountView()

    expect(entriesOf(wrapper, HOLIDAY)).toEqual([{ name: NAME_WORK, time: '10:00 ~ 17:00' }])
  })
})
