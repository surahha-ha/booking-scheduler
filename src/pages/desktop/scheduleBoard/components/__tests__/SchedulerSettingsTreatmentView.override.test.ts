/**
 * @vitest-environment happy-dom
 *
 * 운영시간 — 담당자 × 날짜 지정(override) 계약 검증 (2026-07-13 원천 전환).
 *
 * override 는 weekly 반복을 덮어쓰는 단일 날짜 설정이다.
 *  - 행 있음 + 시작·종료 있음 → 그 날짜는 그 시간으로 override (weekly 무시)
 *  - 행 있음 + 시작·종료 null → **그 날짜만 휴무** (정상 값 — "지정 없음"과 반드시 구분)
 *  - 행 없음               → 지정 없음 → weekly 요일 패턴 fallback
 *
 * 이 판정(resolveDisplay/overrideRowToRange)은 SchedulerSettingsTreatmentView.vue 안에만 있어
 * 컴포넌트 마운트로 검증한다. production 코드는 수정하지 않는다 — mount 의존성만 테스트에서 충족.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'
import type { StaffWorkHoursResponse } from '@/api/siteApi'

// ── 외부 의존 stub ──────────────────────────────────────────
vi.mock('@/lib/useDialog', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
}))
// 공휴일은 이 테스트의 관심사가 아니다 — 전부 평일로 고정(휴무 판정이 override 를 가리지 않게).
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

// ── fixture: 이번 달 안의 3개 날짜 (모든 달에 존재하는 10~12일) ──
const MONTH = dayjs().format('YYYY-MM')
const D_PLAIN = `${MONTH}-10`     // 지정 없음 → weekly (09:00~18:00)
const D_OVERRIDE = `${MONTH}-11`  // 지정 있음 → 13:00~16:00
const D_DAYOFF = `${MONTH}-12`    // 지정 행은 있는데 시각 null → 그 날짜만 휴무

const STAFF_ID = 101
const DOCTOR = '김의사'

/** 담당자 weekly — 7요일 전부 09:00~18:00 (요일 편차가 override 검증을 흐리지 않게) */
const weeklyTimes = Array.from({ length: 7 }, (_, dayCd) => ({
  dayCd,
  staffOpenHm: '0900',
  staffCloseHm: '1800',
}))

// 운영일정 보기는 담당자(staff) 운영시간·오버라이드만 쓴다 — 사업장(site)은 별도 조회로 분리됨.
const staffWorkHours: StaffWorkHoursResponse = {
  staff: [{ staffId: STAFF_ID, staffName: DOCTOR, times: weeklyTimes }],
  overrides: [
    { staffId: STAFF_ID, date: D_OVERRIDE, overrideOpenHm: '1300', overrideCloseHm: '1600' },
    { staffId: STAFF_ID, date: D_DAYOFF, overrideOpenHm: null, overrideCloseHm: null },
  ],
}

async function mountView() {
  const wrapper = mount(SchedulerSettingsTreatmentView, {
    global: { stubs: { CellMorePopover: true } },
  })
  // hydrate(teams/settings/work-hours) 3연쇄 await
  for (let i = 0; i < 5; i++) await wrapper.vm.$nextTick()
  return wrapper
}

/** 이번 달 셀(day 번호) → 그 셀의 직원 entry 목록 [{name, time}] */
function entriesOfDay(wrapper: any, ymd: string) {
  const day = String(dayjs(ymd).date())
  const cell = wrapper.findAll('.schedulerTreatmentView__cell').find((c: any) => {
    if (c.classes('is-other')) return false
    return c.find('.schedulerTreatmentView__cellDate').exists()
      && c.find('.schedulerTreatmentView__cellDate').text() === day
  })
  expect(cell, `이번 달 ${day}일 셀`).toBeTruthy()
  return cell!.findAll('.schedulerTreatmentView__appt')
    .filter((a: any) => !a.classes('schedulerTreatmentView__appt--institution'))
    .map((a: any) => ({
      name: a.find('.schedulerTreatmentView__apptDoctor').text(),
      time: a.find('.schedulerTreatmentView__apptTime').text(),
    }))
}

/** '진료일'/'휴무일' 세그먼트 클릭 */
async function selectDayType(wrapper: any, label: '진료일' | '휴무일') {
  const btn = wrapper.findAll('.scheduleSegment__btn').find((b: any) => b.text() === label)
  await btn!.trigger('click')
  await wrapper.vm.$nextTick()
}

describe('운영일정 보기 — 담당자 × 날짜 지정(override)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getTeams.mockResolvedValue({
      data: { payload: { teams: [{ id: 1, name: '1구역', doctors: [{ staffId: STAFF_ID, staffName: DOCTOR }] }] } },
    })
    // 휴무 규칙 없음 — 이 달은 전부 진료일
    mocks.getTreatmentSettings.mockResolvedValue({
      data: { payload: { recurringOffRules: [], offDates: [], workDates: [], holidayClosedYn: false, teams: [] } },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { payload: staffWorkHours } })
    // 이 fixture 는 7요일을 모두 정해두어 기관 폴백이 걸릴 자리가 없다 — override 판정만 남긴다.
    mocks.getSiteWorkHours.mockResolvedValue({ data: { payload: { site: [] } } })
  })

  it('지정 없는 날 → weekly 요일 패턴(09:00 ~ 18:00)', async () => {
    const wrapper = await mountView()
    expect(entriesOfDay(wrapper, D_PLAIN)).toEqual([{ name: DOCTOR, time: '09:00 ~ 18:00' }])
  })

  it('지정 있는 날(시작·종료 있음) → weekly 대신 지정 시간(13:00 ~ 16:00)으로 override', async () => {
    const wrapper = await mountView()
    expect(entriesOfDay(wrapper, D_OVERRIDE)).toEqual([{ name: DOCTOR, time: '13:00 ~ 16:00' }])
  })

  it('지정 행이 있는데 시작·종료가 null → 그 날짜만 휴무 (진료일 목록에서 빠진다)', async () => {
    const wrapper = await mountView()
    // 진료일(WORK) 모드: weekly 로 fallback 하지 않고 그 날짜만 사라져야 한다.
    expect(entriesOfDay(wrapper, D_DAYOFF)).toEqual([])
  })

  it("지정 행 + null 시각 → 휴무일(OFF) 모드에서 '휴무' 으로 잡힌다 (지정 없음과 구분)", async () => {
    const wrapper = await mountView()
    await selectDayType(wrapper, '휴무일')

    expect(entriesOfDay(wrapper, D_DAYOFF)).toEqual([{ name: DOCTOR, time: '(휴무)' }])
    // 지정 없는 날/시간 지정된 날은 휴무가 아니다
    expect(entriesOfDay(wrapper, D_PLAIN)).toEqual([])
    expect(entriesOfDay(wrapper, D_OVERRIDE)).toEqual([])
  })
})
