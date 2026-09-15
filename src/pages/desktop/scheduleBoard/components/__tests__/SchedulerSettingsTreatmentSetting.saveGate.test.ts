/**
 * @vitest-environment happy-dom
 *
 * 운영일정 설정 저장 — **파트별(3축) 게이트** 회귀 방지.
 *
 * BE 계약(POST /book/v2/site/settings/save) — 필드 미전송(null) = 그 파트를 아예 손대지 않음:
 *  - body.teams        미전송 → 자체 파트 통째 skip
 *  - body.workingHours 미전송 → 담당자 운영시간·오버라이드 두 테이블 미변경(삭제도 안 함). 팀은 정상 저장
 *  - body.site         미전송 → 사업장 파트(사업장 운영시간 + 휴무규칙/지정일자/공휴일) 통째 skip
 *  - 빈 목록 []/{} 은 생략이 아니라 "전부 삭제" 라는 정상 의도 (null 과 구분)
 *
 * 전송 조건:
 *  teams        : !teamLoadFailed
 *  workingHours : !teamLoadFailed && !staffLoadFailed  ← BE 가 요청 payload 의 teams 로
 *                 "팀 소속 담당자만" 거르므로 teams 없이 보낼 수 없다(신규 팀은 DB 미채번)
 *  site 번들    : !siteLoadFailed
 *
 * 요일 3상태 — times[] 는 정한 요일 행만 담는다(7행으로 채우지 않는다):
 *   행 없음 = 미설정(사업장 운영시간을 따른다) / 행 + 시각 = 진료 / 행 + null = 명시적 휴무
 *
 * 지키는 것(데이터 파괴 방지 + 부당한 저장 차단 방지):
 *  ① 팀 조회 실패 → payload 에 teams/workingHours 없음. 보내면 BE 가 delete 후 재삽입할 게 없어 팀 전멸.
 *  ② 사업장(site) 조회 실패 → payload 에 site 번들 없음. 담당자는 미설정이든 아니든 그대로 보낸다 —
 *     저장 payload 에 사업장 값을 끌어다 채우지 않으므로 "휴무 확정"으로 굳을 일이 없다.
 *     (예전에는 채웠기 때문에 미설정 담당자를 payload 에서 걸러내야 했다 — skipUnsetStaff.)
 *  ③ 미설정은 저장해도 미설정으로 남는다. 화면에 보이는 사업장 값은 "기본값 참조"일 뿐이며,
 *     예약 가능 시간대는 저장값이 아니라 엔진의 기관 fallback 이 정한다.
 *  ④ ★팀은 운영시간에 엮이지 않는다 — staff 조회만 실패해도 팀은 저장할 수 있어야 한다.
 *     (묶어 두면 "팀을 저장하려면 운영시간이 반드시 있어야 한다" 가 되어 잘못이다.)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// ── 외부 의존 stub ──────────────────────────────────────────
/** dialog 는 setup 에서 한 번만 잡히므로, 호출을 단언하려면 인스턴스가 고정돼야 한다 */
const dialogMock = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn() }))
vi.mock('@/lib/useDialog', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
  useDialog: () => dialogMock,
}))
vi.mock('notivue', () => ({
  push: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/stores/holidayStore', () => ({
  useHolidayStore: () => ({
    isHoliday: () => false,
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

import { push } from 'notivue'
import SchedulerSettingsTreatmentSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTreatmentSetting.vue'

// ── fixture ────────────────────────────────────────────────
const STAFF_SET = 101    // 운영시간을 설정한 담당자
const STAFF_UNSET = 202  // 한 번도 설정하지 않은 담당자(행 자체가 없음) → 화면엔 사업장 값이 보인다

/** 사업장: 월~금 09:00~18:00 진료 (site 조회 성공 시) */
const siteRows = [1, 2, 3, 4, 5].map(dayCd => ({
  dayCd,
  openHm: '0900',
  closeHm: '1800',
  lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
}))

/* ★토·일은 **매주 휴무로 정해 둔** 상태다 — 진료행만 월~금으로 두고 주말을 비워 놓으면
 * "운영시간을 정하지 않은 요일"이 되어, 화면이 그 요일을 '매주 휴무'으로 자동 보정하려고
 * site 파트를 dirty 로 만든다(missingTimeWeekdays). 이 파일의 관심사는 파트별 게이트이므로
 * 그 보정이 끼어들지 않게 주말을 명시적 휴무로 채운다. 자동 보정 자체의 검증은
 * SchedulerSettingsTreatmentSetting.dayState.test.ts 에 있다. */
const weekendOffRules = [
  { dayCd: 0, repeatTy: 'WEEKLY' },
  { dayCd: 6, repeatTy: 'WEEKLY' },
]

/* BE 는 저장된 요일 행만 내려준다 — 7행으로 채우지 않는다.
 *   행 없음 = 미설정 / 행 + 시각 = 진료 / 행 + null = 명시적 휴무
 * 이 셋을 구분하지 못하면 "안 정한 요일"이 "휴무로 정한 요일"로 굳는다. */
const setTimes = Array.from({ length: 7 }, (_, dayCd) => ({
  dayCd, staffOpenHm: '1000', staffCloseHm: '1700',
}))
/** 미설정 — 행이 하나도 없다 */
const unsetTimes: Array<{ dayCd: number; staffOpenHm: string | null; staffCloseHm: string | null }> = []
/** 월요일만 진료로 정하고, 화요일은 휴무로 정한 상태(나머지 5요일은 미설정) */
const partialTimes = [
  { dayCd: 1, staffOpenHm: '1000', staffCloseHm: '1700' },
  { dayCd: 2, staffOpenHm: null, staffCloseHm: null },
]

/* 공휴일 운영시간 — 이 파일의 site dirty 레버가 toggleHoliday(공휴일 휴무→진료)라서 값이 필요하다.
 * 공휴일 진료로 저장하려면 운영시간이 있어야 하고(공휴일 운영시간 테이블 의 시작·종료시분이 NOT NULL),
 * 없으면 onSave 가 안내만 띄우고 막는다. 이 파일의 관심사는 파트별 게이트이므로 정상값을 쥐어 준다.
 * 그 가드 자체의 검증은 SchedulerSettingsTreatmentSetting.holidayTime.test.ts 에 있다. */
const holidayHoursRow = {
  openHm: '1000', closeHm: '1600',
  lunchStartHm: null, lunchEndHm: null, dinnerStartHm: null, dinnerEndHm: null,
}

function okSite() {
  return { data: { code: 'succeed', payload: { site: siteRows, holidayHours: holidayHoursRow, recurringOffRules: weekendOffRules, workDates: [], offDates: [], holidayClosedYn: true } } }
}
function okStaff() {
  return {
    data: {
      code: 'succeed',
      payload: {
        staff: [
          { staffId: STAFF_SET, staffName: '설정의사', times: setTimes },
          { staffId: STAFF_UNSET, staffName: '미설정의사', times: unsetTimes },
        ],
        overrides: [],
      },
    },
  }
}
/** getTeams 응답의 팀 구성원 — 컴포넌트는 staffId 만 doctorIds 로 옮긴다 */
const members = (...nos: number[]) => nos.map(no => ({ staffId: no, staffName: `담당자${no}` }))

function okTeams() {
  return { data: { code: 'succeed', payload: { teams: [{ id: 1, name: '1구역', doctors: members(STAFF_SET, STAFF_UNSET) }] } } }
}

async function mountSetting() {
  const wrapper = mount(SchedulerSettingsTreatmentSetting, {
    global: { stubs: { CellMorePopover: true, Teleport: true } },
  })
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

/** script setup 내부 state 접근 — 테스트에서 편집을 재현하기 위한 최소 통로 */
function setupState(wrapper: any) {
  return wrapper.vm.$.setupState
}

const saveBtn = (wrapper: any) => wrapper.find('.schedulerTreatmentSetting__saveBtn')

/** 진입 가드와 동일한 재사용 문구 — 신규 문구를 만들지 않는다 */
const SERVICE_UNAVAILABLE_MSG = '일시적인 서비스 접근 불가입니다.\n잠시 후에 다시 시도해주세요.'

/** 구성원 없는 팀 안내 — 팀 이름을 담지 않는다(빈 팀이 여럿일 때 나머지를 감추지 않으려고) */
const TEAM_MEMBERS_REQUIRED_MSG = '팀 구성원이 없습니다.\n구성원을 선택해 주세요.'

function expectLossAlert() {
  expect(dialogMock.alert, '유실 안내 alert').toHaveBeenCalledTimes(1)
  expect(dialogMock.alert.mock.calls[0][0]).toBe(SERVICE_UNAVAILABLE_MSG)
}

/** 공휴일 체크박스 토글 → 사업장 파트 dirty */
async function toggleHoliday(wrapper: any) {
  const box = wrapper.find('.schedulerTreatmentSetting__check input[type="checkbox"]')
  expect(box.exists(), '공휴일 체크박스').toBe(true)
  await box.setValue(!(box.element as HTMLInputElement).checked)
  await wrapper.vm.$nextTick()
}

/** 팀 배열 변경 → teams 파트 dirty
 *
 * ★구성원을 반드시 넣는다 — 구성원이 없는 팀은 onSave 가 안내만 띄우고 막기 때문에(2026-08-24),
 *  빈 팀으로 dirty 를 만들면 이 파일의 관심사(파트별 게이트)에 닿기 전에 걸린다.
 *  그 가드 자체의 검증은 아래 「구성원 없는 팀」 describe 에 있다. */
async function makeTeamDirty(wrapper: any) {
  setupState(wrapper).teams.push({ id: 'TEAM_new', name: '신규팀', doctorIds: [STAFF_SET] })
  await wrapper.vm.$nextTick()
}

/** 담당자 운영시간 변경 → workingHours 파트 dirty (teams 는 건드리지 않는다) */
async function makeWorkingHoursDirty(wrapper: any) {
  const state = setupState(wrapper)
  state.setStaffWorkHours(STAFF_SET, 1, 'start', '11:00')
  await wrapper.vm.$nextTick()
}

function savedPayload() {
  expect(mocks.saveTreatmentSettings, '저장 API 호출').toHaveBeenCalledTimes(1)
  return mocks.saveTreatmentSettings.mock.calls[0][0] as any
}

describe('운영일정 설정 저장 — 파트별(teams / workingHours / site) 3축 게이트', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mocks.getTeams.mockResolvedValue(okTeams())
    mocks.getSiteWorkHours.mockResolvedValue(okSite())
    mocks.getStaffWorkHours.mockResolvedValue(okStaff())
    mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', message: '저장되었습니다.', payload: { staff: 'succeed', site: 'succeed' } } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  // ── 회귀 ① 팀 전멸 방지 ────────────────────────────────
  it('팀 조회 실패 → payload 에 teams/workingHours 가 없다 (전송 시 팀 전멸)', async () => {
    mocks.getTeams.mockRejectedValue(new Error('503'))
    const wrapper = await mountSetting()

    // 자체 파트만 막히고 사업장 설정은 살아 있다 → 저장 버튼은 활성
    expect(saveBtn(wrapper).attributes('disabled')).toBeUndefined()

    await toggleHoliday(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.teams, 'teams 미전송 → BE 가 자체 파트 skip').toBeUndefined()
    expect(payload.workingHours, 'workingHours 는 teams 와 한 트랜잭션 → 함께 생략').toBeUndefined()
    // 사업장 파트는 정상 전송
    expect(payload.site).toEqual(siteRows)
    expect(payload).toHaveProperty('holidayClosedYn')
  })

  it('팀 조회가 code=failed 로 와도(HTTP 200) teams 를 보내지 않는다', async () => {
    mocks.getTeams.mockResolvedValue({ data: { code: 'failed', message: '조회 실패', payload: null } })
    const wrapper = await mountSetting()

    await toggleHoliday(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(savedPayload().teams).toBeUndefined()
  })

  // ── 회귀 ② 사업장 파트 보호 ───────────────────────────────
  //
  // ★예전에는 여기서 미설정 담당자를 payload 에서 통째로 걸러냈다(skipUnsetStaff).
  // 저장 payload 를 만들 때 사업장 값을 끌어다 7행을 채웠는데, 사업장 조회가 실패하면
  // 그 원천이 비어 전 요일 null = "휴무 확정"으로 굳었기 때문이다.
  // 이제는 채우지 않으므로 걸러낼 이유가 없다 — 보내도 안전하다는 것이 이 테스트다.
  it('사업장(site) 조회 실패 → site 번들만 빠지고, 미설정 담당자는 보내되 휴무로 굳지 않는다', async () => {
    mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
    const wrapper = await mountSetting()

    expect(saveBtn(wrapper).attributes('disabled')).toBeUndefined()

    await makeTeamDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    // 사업장 번들 통째 생략
    expect(payload.site).toBeUndefined()
    expect(payload.recurringOffRules).toBeUndefined()
    expect(payload.workDates).toBeUndefined()
    expect(payload.offDates).toBeUndefined()
    expect(payload.holidayClosedYn).toBeUndefined()

    expect(payload.teams).toBeTruthy()
    const nos = payload.workingHours.staff.map((m: any) => m.staffId)
    expect(nos, '이제 걸러내지 않는다').toEqual([STAFF_SET, STAFF_UNSET])

    // ★핵심: 보내되 "정한 요일이 없다"는 사실 그대로 나간다. 휴무 7행이 아니다.
    const unset = payload.workingHours.staff.find((m: any) => m.staffId === STAFF_UNSET)
    expect(unset.times, '빈 times = 미설정 유지. 행이 있으면 그 요일을 정했다는 뜻이 된다').toEqual([])
  })

  it('site 가 code=failed 여도 동일하게 사업장 파트를 생략한다 (staff 는 정상 전송)', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { code: 'failed', message: '사업장 조회 장애', payload: null } })
    const wrapper = await mountSetting()

    await makeTeamDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.site).toBeUndefined()
    expect(payload.workingHours.staff.map((m: any) => m.staffId)).toEqual([STAFF_SET, STAFF_UNSET])
  })

  // ── ③ 정상 경로 — 미설정은 미설정으로 남는다 ─────────────
  //
  // ★예전에는 미설정 담당자에게 사업장 값을 채워 저장했다. 화면에 그 값이 보이니
  // 저장하면 그대로 굳는 것이 자연스러워 보였지만, 그러면 (1) 그 담당자는 두 번 다시
  // 미설정으로 돌아가지 못하고 (2) 이후 사업장 운영시간을 바꿔도 따라오지 않는다.
  // 화면의 사업장 값은 "기본값 참조"일 뿐 확정이 아니다 — 예약 가능 시간대는
  // 저장된 값이 아니라 엔진의 기관 fallback(useSchedulerRules.pickDailySchedule)이 정한다.
  it('둘 다 정상 → 두 파트 모두 전송 + 미설정 담당자는 빈 times 로 나간다(기관값 박제 없음)', async () => {
    const wrapper = await mountSetting()

    await toggleHoliday(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.site).toEqual(siteRows)
    expect(payload.teams).toBeTruthy()

    const unset = payload.workingHours.staff.find((m: any) => m.staffId === STAFF_UNSET)
    expect(unset, '미설정 담당자도 보낸다').toBeTruthy()
    expect(unset.times, '사업장 09:00~18:00 을 끌어다 채우지 않는다').toEqual([])
  })

  // ── ★요일 3상태 — 미설정 / 진료 / 휴무 ─────────────────
  //
  // 한 원인에서 나온 두 증상을 함께 막는다:
  //  ① 조회 왕복에서 "휴무로 정한 요일"이 미설정으로 강등되던 것
  //  ② 한 요일만 고쳤는데 나머지 요일이 휴무로 확정되던 것
  describe('요일 3상태', () => {
    beforeEach(() => {
      mocks.getStaffWorkHours.mockResolvedValue({
        data: {
          code: 'succeed',
          payload: {
            staff: [{ staffId: STAFF_SET, staffName: '부분설정의사', times: partialTimes }],
            overrides: [],
          },
        },
      })
      mocks.getTeams.mockResolvedValue({
        data: { code: 'succeed', payload: { teams: [{ id: 1, name: '1구역', doctors: members(STAFF_SET) }] } },
      })
    })

    it('★건드리지 않고 저장하면 읽어온 3상태가 그대로 되돌아간다 (휴무→미설정 강등 없음)', async () => {
      const wrapper = await mountSetting()

      await toggleHoliday(wrapper)
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      const times = savedPayload().workingHours.staff
        .find((m: any) => m.staffId === STAFF_SET).times

      expect(times, '정한 2요일만 나간다 — 미설정 5요일이 휴무로 확정되지 않는다').toHaveLength(2)
      expect(times.find((t: any) => t.dayCd === 1)).toMatchObject({ staffOpenHm: '1000', staffCloseHm: '1700' })
      expect(times.find((t: any) => t.dayCd === 2), '휴무로 정한 화요일은 행으로 남는다')
        .toMatchObject({ staffOpenHm: null, staffCloseHm: null })
    })

    it('★한 요일만 고쳐도 나머지 미설정 요일이 휴무로 굳지 않는다', async () => {
      const wrapper = await mountSetting()

      setupState(wrapper).setStaffWorkHours(STAFF_SET, 3, 'start', '09:00')
      setupState(wrapper).setStaffWorkHours(STAFF_SET, 3, 'end', '12:00')
      await wrapper.vm.$nextTick()

      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      const times = savedPayload().workingHours.staff
        .find((m: any) => m.staffId === STAFF_SET).times
      const days = times.map((t: any) => t.dayCd)

      expect(days, '원래 있던 2요일 + 방금 정한 수요일').toEqual([1, 2, 3])
      expect(times.find((t: any) => t.dayCd === 3)).toMatchObject({ staffOpenHm: '0900', staffCloseHm: '1200' })
    })

    /* ★2026-08-20 규약 변경 — 운영시간 탭은 휴무를 만들지 않는다(탭 책임 분리).
     * 시간을 비우면 휴무 행이 아니라 **행 자체가 빠진다**(미설정). 휴무는 휴무일 탭에서 정한다. */
    it('요일을 비우면 그 요일 행이 빠진다 — 휴무가 아니라 미설정이다', async () => {
      const wrapper = await mountSetting()

      setupState(wrapper).setStaffWorkHours(STAFF_SET, 1, 'start', '')
      setupState(wrapper).setStaffWorkHours(STAFF_SET, 1, 'end', '')
      await wrapper.vm.$nextTick()

      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      const times = savedPayload().workingHours.staff
        .find((m: any) => m.staffId === STAFF_SET).times

      expect(times.map((t: any) => t.dayCd), '비운 요일은 행 자체가 나가지 않는다').toEqual([2])
    })
  })

  // ── ★핵심: 팀은 운영시간에 엮이지 않는다 ────────────────
  //
  // 담당자 운영시간(staff) 조회가 실패해도 팀은 자체 소유 데이터이므로 저장할 수 있어야 한다.
  // 묶어 두면 "팀을 저장하려면 운영시간이 반드시 있어야 한다" 가 되어 잘못이다.
  // BE 는 workingHours 미전송 시 담당자 운영시간·오버라이드 두 테이블을 손대지 않는다(삭제도 안 함).
  it('★staff 만 실패 → 저장 버튼 활성 + teams 는 보내고 workingHours 만 생략한다', async () => {
    mocks.getStaffWorkHours.mockRejectedValue(new Error('503'))
    const wrapper = await mountSetting()

    expect(saveBtn(wrapper).attributes('disabled'), '팀은 저장 가능 → 버튼 활성').toBeUndefined()

    await makeTeamDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.teams, '팀은 운영시간 가용성과 무관하게 저장된다').toBeTruthy()
    expect(payload.teams.map((t: any) => t.name)).toContain('신규팀')
    expect(payload.workingHours, 'baseline 미확보 → 미전송(= BE 가 두 테이블 미변경)').toBeUndefined()
    expect(payload.site, '사업장 파트도 정상 전송').toEqual(siteRows)
  })

  it('staff 만 실패 + 팀 미변경이어도 site 변경은 정상 전송된다 (workingHours 만 빠진다)', async () => {
    mocks.getStaffWorkHours.mockRejectedValue(new Error('503'))
    const wrapper = await mountSetting()

    await toggleHoliday(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.teams, 'teams 는 읽혔으므로 함께 나간다').toBeTruthy()
    expect(payload.workingHours).toBeUndefined()
    expect(payload.site).toEqual(siteRows)
  })

  // ── 팀만 실패 ──────────────────────────────────────────
  it('팀만 실패 → teams/workingHours 둘 다 생략, site 는 전송, 버튼 활성', async () => {
    mocks.getTeams.mockRejectedValue(new Error('503'))
    const wrapper = await mountSetting()

    expect(saveBtn(wrapper).attributes('disabled')).toBeUndefined()

    await toggleHoliday(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.teams).toBeUndefined()
    // ★workingHours 는 teams 없이 보낼 수 없다 — BE 가 요청 teams 로 대상 담당자를 거른다
    expect(payload.workingHours, 'teams 없이 보내면 BE 가 아무도 저장하지 못해 전멸').toBeUndefined()
    expect(payload.site).toEqual(siteRows)
    expect(payload).toHaveProperty('holidayClosedYn')
  })

  // ── site 만 실패 ───────────────────────────────────────
  it('site 만 실패 → 사업장 5필드 생략, teams/workingHours 는 전송, 버튼 활성', async () => {
    mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
    const wrapper = await mountSetting()

    expect(saveBtn(wrapper).attributes('disabled')).toBeUndefined()

    await makeWorkingHoursDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    for (const key of ['site', 'recurringOffRules', 'workDates', 'offDates', 'holidayClosedYn']) {
      expect(payload[key], `사업장 번들 ${key} 생략`).toBeUndefined()
    }
    expect(payload.teams, 'workingHours 를 보내려면 teams 도 함께 가야 한다').toBeTruthy()
    expect(payload.workingHours).toBeTruthy()
  })

  // ── 팀 + site 실패 → 보낼 파트 없음 ────────────────────
  it('팀 + site 실패 → 저장 버튼 비활성 (staff 성공이어도 단독 저장 불가)', async () => {
    mocks.getTeams.mockRejectedValue(new Error('503'))
    mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
    const wrapper = await mountSetting()

    expect(saveBtn(wrapper).attributes('disabled'), 'workingHours 는 teams 의존이라 단독 저장 불가').toBeDefined()
    await saveBtn(wrapper).trigger('click')
    await flushPromises()
    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
  })

  // ── dirty 판정도 3축 ───────────────────────────────────
  it('staff 실패 상태에서 담당자 운영시간만 고치면 저장 API 를 호출하지 않는다 (+유실 안내 후 닫힘)', async () => {
    mocks.getStaffWorkHours.mockRejectedValue(new Error('503'))
    const wrapper = await mountSetting()

    // workingHours 는 게이트로 제외된 파트 → 그 변경은 dirty 로 치지 않는다
    await makeWorkingHoursDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
    expectLossAlert()
    expect(wrapper.emitted('cancel'), '★알린 뒤에는 닫는다 — 붙잡아 두면 되돌리기 전까지 영영 못 닫는다(덫)').toBeTruthy()
  })

  it('전부 정상일 때 담당자 운영시간만 고쳐도 저장된다 (workingHours 키가 dirty 그룹에 배정돼 있다)', async () => {
    const wrapper = await mountSetting()

    await makeWorkingHoursDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    const set = payload.workingHours.staff.find((m: any) => m.staffId === STAFF_SET)
    expect(set.times.find((t: any) => t.dayCd === 1)).toMatchObject({ staffOpenHm: '1100' })
  })

  it('게이트로 제외된 파트만 변경됐다면 저장 API 를 호출하지 않는다 (+유실 안내 후 닫힘)', async () => {
    mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
    const wrapper = await mountSetting()

    // 사업장 설정은 조회 실패 → 그 파트 변경(공휴일 토글)은 어차피 전송되지 않으므로 dirty 로 치지 않는다
    await toggleHoliday(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
    expectLossAlert()
    expect(wrapper.emitted('cancel'), '★알린 뒤에는 닫는다 — 되돌리기 전까지 못 닫으면 덫이 된다').toBeTruthy()
  })

  // ── 배너 / 재시도 ──────────────────────────────────────
  it('한 원천만 실패해도 인라인 안내가 뜨고, 재시도는 실패한 원천만 다시 읽는다', async () => {
    mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
    const wrapper = await mountSetting()

    expect(wrapper.find('.schedulerTreatmentSetting__loadError').exists()).toBe(true)
    expect(mocks.getStaffWorkHours).toHaveBeenCalledTimes(1)

    mocks.getSiteWorkHours.mockResolvedValue(okSite())
    await wrapper.find('.schedulerTreatmentSetting__loadErrorRetry').trigger('click')
    await flushPromises()

    expect(mocks.getSiteWorkHours).toHaveBeenCalledTimes(2)
    expect(mocks.getStaffWorkHours, '성공한 원천은 재조회하지 않는다(편집값 덮어쓰기 방지)').toHaveBeenCalledTimes(1)
    expect(wrapper.find('.schedulerTreatmentSetting__loadError').exists()).toBe(false)
  })

  // ── ④ code=succeed + payload 부재 = 장애 ───────────────
  //
  // 게이트 우회 구멍: code 만 보면 succeed 이므로 실패 플래그가 서지 않는데, 값은 초기값 그대로다.
  // 그대로 저장하면 teams:[] / site:[] 가 전송되고 BE 는 [] 를 null 과 구분해
  // "전부 삭제"라는 정상 의도로 해석한다(파트 skip 은 미전송일 때만) → 팀·운영시간 전멸 재현.
  it('팀 조회가 succeed 인데 payload 가 없으면 장애로 보고 teams 를 보내지 않는다', async () => {
    mocks.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: null } })
    const wrapper = await mountSetting()

    // 장애 안내가 뜨고, 사업장 설정은 살아 있으므로 저장 버튼 자체는 활성
    expect(wrapper.find('.schedulerTreatmentSetting__loadError').exists()).toBe(true)
    expect(saveBtn(wrapper).attributes('disabled')).toBeUndefined()

    await toggleHoliday(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.teams, 'payload 부재 → 자체 파트 미전송(teams:[] 전송 시 팀 전멸)').toBeUndefined()
    expect(payload.workingHours).toBeUndefined()
    expect(payload.site, '사업장 파트는 정상 전송').toEqual(siteRows)
  })

  it('site 가 succeed 인데 payload 가 없으면 장애로 보고 사업장 번들을 보내지 않는다', async () => {
    mocks.getSiteWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: null } })
    const wrapper = await mountSetting()

    expect(wrapper.find('.schedulerTreatmentSetting__loadError').exists()).toBe(true)

    await makeTeamDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.site, 'payload 부재 → site:[] 전송 시 사업장 운영시간 전멸').toBeUndefined()
    expect(payload.recurringOffRules, '휴무규칙도 같은 사업장 번들 → 함께 생략').toBeUndefined()
    expect(payload.workDates).toBeUndefined()
    expect(payload.offDates).toBeUndefined()
    expect(payload.holidayClosedYn).toBeUndefined()
    // 자체 파트는 살아 있다 — 미설정 담당자도 함께 나가되 빈 times 라 굳지 않는다
    expect(payload.teams).toBeTruthy()
    expect(payload.workingHours.staff.map((m: any) => m.staffId)).toEqual([STAFF_SET, STAFF_UNSET])
  })

  it('staff 가 succeed 인데 payload 가 없으면 장애로 보고 workingHours 만 생략한다 (팀은 저장)', async () => {
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: null } })
    const wrapper = await mountSetting()

    await toggleHoliday(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.workingHours, 'payload 부재 → staff:[] 전송 시 담당자 운영시간 전멸').toBeUndefined()
    expect(payload.teams, '팀은 운영시간에 엮이지 않는다').toBeTruthy()
    expect(payload.site).toEqual(siteRows)
  })

  // ── ⑤ "미설정(정상)" 회귀 방지 ──────────────────────────
  //
  // ★위 ④ 를 넓게 잡으면 여기가 깨진다. BE 계약상 한 번도 설정하지 않은 거래처는
  //   succeed + **빈 배열을 담은 payload** 로 내려온다(payload 는 존재). 이건 장애가 아니라 정상이며,
  //   장애로 오판하면 신규 거래처가 영원히 저장 불가가 된다.
  it('팀 미설정 거래처(succeed + payload:{teams:[]})는 장애가 아니며 저장할 수 있다', async () => {
    mocks.getTeams.mockResolvedValue({ data: { code: 'succeed', payload: { teams: [] } } })
    const wrapper = await mountSetting()

    expect(wrapper.find('.schedulerTreatmentSetting__loadError').exists(), '빈 배열은 장애가 아니다').toBe(false)
    expect(saveBtn(wrapper).attributes('disabled')).toBeUndefined()

    await makeTeamDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.teams, '자체 파트가 정상 전송된다').toBeTruthy()
    expect(payload.workingHours).toBeTruthy()
    expect(payload.site, '사업장 파트도 정상 전송').toEqual(siteRows)
  })

  it('운영시간 미설정 거래처(succeed + 빈 목록 payload)도 장애가 아니다', async () => {
    /* ★holidayClosedYn 은 false(공휴일 진료)에서 시작한다 — 이 거래처는 아무것도 설정하지 않은 상태라
     * 공휴일 운영시간도 없다. 아래 toggleHoliday 가 "진료 → 휴무" 방향으로 가야 공휴일 시간 필수
     * 가드에 걸리지 않는다(가드는 "진료로 저장할 때"만 본다). 반대 방향이면 시간이 필요해진다. */
    mocks.getSiteWorkHours.mockResolvedValue({
      data: { code: 'succeed', payload: { site: [], recurringOffRules: [], workDates: [], offDates: [], holidayClosedYn: false } },
    })
    mocks.getStaffWorkHours.mockResolvedValue({ data: { code: 'succeed', payload: { staff: [], overrides: [] } } })
    const wrapper = await mountSetting()

    expect(wrapper.find('.schedulerTreatmentSetting__loadError').exists()).toBe(false)

    await toggleHoliday(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload.site, '미설정이므로 빈 배열이 정상 전송된다').toEqual([])
    /* 운영시간을 한 번도 등록하지 않은 거래처는 저장 한 번에 7요일 전부 '매주 휴무'이 된다 —
     * 원천(마이페이지)도 운영시간이 전혀 없으면 휴무로 읽으므로 같은 결론을 명시로 남기는 것이다.
     * 배너가 7요일을 모두 고지한 뒤라 놀랄 일이 아니어야 한다(정책 확정 2026-09-04). */
    expect(payload.recurringOffRules, '정한 요일이 없으면 7요일 모두 매주 휴무로 나간다')
        .toEqual([0, 1, 2, 3, 4, 5, 6].map(dayCd => ({ dayCd, repeatTy: 'WEEKLY', monthlyNth: null })))
    expect(payload).toHaveProperty('holidayClosedYn')
    expect(payload.teams).toBeTruthy()
  })

  /* 매월 n번째만 쉬는 요일은 나머지 주에 진료하므로 운영시간이 있어야 한다. 규칙이 없는 요일처럼
   * 자동 '매주 휴무'으로 보정하면 사용자가 고른 매월 규칙이 사라지고, 미설정으로 두면 보드가 기본
   * 운영시간으로 열린다 — 둘 다 아니라 저장을 막고 그 요일을 가리킨다(배너 둘째 줄과 같은 문구). */
  it('★매월 n번째만 휴무인 요일에 운영시간이 없으면 저장을 막는다 — 나머지 주에 진료하는 요일이다', async () => {
    const FRIDAY = 5
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site: siteRows.filter(r => r.dayCd !== FRIDAY),                 // 금요일 운영시간 없음
          holidayHours: holidayHoursRow,
          recurringOffRules: [...weekendOffRules, { dayCd: FRIDAY, repeatTy: 'MONTHLY', monthlyNth: 1 }],
          workDates: [], offDates: [], holidayClosedYn: true,
        },
      },
    })
    const wrapper = await mountSetting()

    await makeTeamDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(mocks.saveTreatmentSettings, '저장 API 미호출').not.toHaveBeenCalled()
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
    expect(dialogMock.alert.mock.calls[0][0])
        .toBe('금요일은 매월 1번째 휴무가라 나머지 주에 진료합니다.\n운영시간을 입력해 주세요.')
    expect(setupState(wrapper).expandedTreatmentKey, '사업장 패널을 펼쳐 그 요일을 가리킨다').toBe('institution')
    expect(setupState(wrapper).ownerWeekdayInvalid('INSTITUTION', FRIDAY), '금요일 버튼이 붉게 켜진다').toBe(true)
    expect(setupState(wrapper).ownerWeekdayInvalid('INSTITUTION', 1), '시간이 있는 요일은 아니다').toBe(false)
  })

  /* 그런 요일이 둘 이상이면 안내는 전부 나열하고 붉은 표시도 전부 켠다 — 첫 요일만 알리면 하나 고칠 때마다
   * 새 안내가 떠 "몇 번을 고쳐야 하나" 가 된다. 포커스(패널 펼침)는 첫 요일 하나면 된다.
   * 기대값 출처: 정책 결정(2026-09-04 배너 둘째 줄과 같은 문구 규약) — 감사 §2-6 의 공백 케이스. */
  it('매월 n번째만 휴무인 요일이 둘이면 안내에 둘 다 나열하고 둘 다 붉게 켠다', async () => {
    const THURSDAY = 4
    const FRIDAY = 5
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site: siteRows.filter(r => r.dayCd !== THURSDAY && r.dayCd !== FRIDAY),
          holidayHours: holidayHoursRow,
          recurringOffRules: [
            ...weekendOffRules,
            { dayCd: THURSDAY, repeatTy: 'MONTHLY', monthlyNth: 3 },
            { dayCd: FRIDAY, repeatTy: 'MONTHLY', monthlyNth: 1 },
          ],
          workDates: [], offDates: [], holidayClosedYn: true,
        },
      },
    })
    const wrapper = await mountSetting()

    await makeTeamDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(mocks.saveTreatmentSettings, '저장 API 미호출').not.toHaveBeenCalled()
    expect(dialogMock.alert).toHaveBeenCalledTimes(1)
    expect(dialogMock.alert.mock.calls[0][0])
        .toBe('목요일은 매월 3번째, 금요일은 매월 1번째 휴무가라 나머지 주에 진료합니다.\n운영시간을 입력해 주세요.')
    expect(setupState(wrapper).ownerWeekdayInvalid('INSTITUTION', THURSDAY), '목요일도 붉게').toBe(true)
    expect(setupState(wrapper).ownerWeekdayInvalid('INSTITUTION', FRIDAY), '금요일도 붉게').toBe(true)
  })

  /* 사업장 조회가 잠긴(siteLocked) 동안에는 4단 게이트가 대상을 갖지 않는다.
   * 잠김은 "원천이 뭘 갖고 있는지 모른다" 이지 "비어 있다" 가 아니고, site 파트는 어차피 전송에서 빠진다.
   * 처음 조회는 성공했다가 재시도가 실패하면 화면에 옛 규칙(매월 n번째 + 시간 없음)이 남는데, 이때 게이트가
   * 살아 있으면 저장 못 하는 파트 때문에 저장 가능한 파트(팀)까지 영영 못 저장하는 덫이 된다.
   * 기대값 출처: 정책 결정(2026-09-04 잠금 축 규약 — missingTimeWeekdays 와 같은 가드). 감사 §2-7 공백. */
  it('★사업장 조회가 재시도 실패로 잠기면 4단 게이트는 대상이 없다 — 옛 매월 규칙이 남아 있어도 저장은 나간다', async () => {
    const FRIDAY = 5
    mocks.getSiteWorkHours.mockResolvedValue({
      data: {
        code: 'succeed',
        payload: {
          site: siteRows.filter(r => r.dayCd !== FRIDAY),
          holidayHours: holidayHoursRow,
          recurringOffRules: [...weekendOffRules, { dayCd: FRIDAY, repeatTy: 'MONTHLY', monthlyNth: 1 }],
          workDates: [], offDates: [], holidayClosedYn: true,
        },
      },
    })
    const wrapper = await mountSetting()
    expect(setupState(wrapper).monthlyOnlyMissingTimeWeekdays, '사전조건: 잠기기 전에는 게이트 대상').toEqual([FRIDAY])

    // 재시도가 실패한다 — 규칙·시간은 화면에 그대로 남고 site 만 잠긴다.
    mocks.getSiteWorkHours.mockResolvedValue({ data: { code: 'failed', message: '사업장 설정 장애', payload: null } })
    await setupState(wrapper).hydrateWorkingHoursFromServer({ site: true, staff: false })
    await flushPromises()
    expect(setupState(wrapper).siteLocked).toBe(true)

    await makeTeamDirty(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(setupState(wrapper).monthlyOnlyMissingTimeWeekdays, '잠기면 대상 없음').toEqual([])
    expect(dialogMock.alert.mock.calls.map((c: any[]) => c[0]).some((m: string) => String(m).includes('매월')),
        '4단 게이트 안내가 뜨지 않는다').toBe(false)
    expect(mocks.saveTreatmentSettings, '팀 파트는 저장된다').toHaveBeenCalledTimes(1)
    expect(savedPayload().site, '잠긴 site 파트는 빠진다').toBeUndefined()
  })

  // ── ⑥ ★게이트로 버려진 편집의 조용한 유실 방지 ──────────
  //
  // 입력칸을 잠그지 않기로 했으므로(편집은 계속 가능) 사용자는 전송되지 않을 파트도 고칠 수 있다.
  // 그 입력은 payload 에서 빠진다 — 아무 말 없이 팝업이 닫히면 "저장된 줄 알았는데 사라졌다" 가 된다.
  // 그래서 저장 시점에 재사용 문구로 한 번 알린다. 알린 뒤에는 **닫는다** — 붙잡아 두면
  // 그 편집을 손수 되돌리기 전까지 매번 같은 안내가 뜨고 팝업을 영영 닫을 수 없다(덫).
  describe('게이트로 제외된 파트를 고친 경우 — 유실 안내', () => {
    it('staff 실패 + 담당자 운영시간만 수정 → alert 뜨고 닫힘, API 미호출', async () => {
      mocks.getStaffWorkHours.mockRejectedValue(new Error('503'))
      const wrapper = await mountSetting()

      await makeWorkingHoursDirty(wrapper)
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expectLossAlert()
      expect(mocks.saveTreatmentSettings, '보낼 파트가 없다').not.toHaveBeenCalled()
      expect(wrapper.emitted('save'), '저장되지 않았다').toBeFalsy()
      expect(wrapper.emitted('cancel'), '★알린 뒤에는 닫는다 — 저장 못 하는 파트가 팝업을 볼모로 잡으면 안 된다').toBeTruthy()
    })

    it('staff 실패 + 팀만 수정 → alert 없이 팀 저장·팝업 닫힘 (게이트 파트가 dirty 하지 않다)', async () => {
      mocks.getStaffWorkHours.mockRejectedValue(new Error('503'))
      const wrapper = await mountSetting()

      await makeTeamDirty(wrapper)
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expect(dialogMock.alert, '유실된 편집이 없으면 방해하지 않는다').not.toHaveBeenCalled()
      expect(savedPayload().teams).toBeTruthy()
      expect(wrapper.emitted('save'), '정상 저장 → 닫힌다').toBeTruthy()
    })

    it('★staff 실패 + 팀·담당자 운영시간 둘 다 수정 → 팀은 저장되고 alert 도 뜨며 닫힌다', async () => {
      mocks.getStaffWorkHours.mockRejectedValue(new Error('503'))
      const wrapper = await mountSetting()

      await makeTeamDirty(wrapper)
      await makeWorkingHoursDirty(wrapper)
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      // 보낼 수 있는 파트는 막지 않는다 — 팀은 운영시간 가용성과 무관하게 저장돼야 한다
      const payload = savedPayload()
      expect(payload.teams.map((t: any) => t.name)).toContain('신규팀')
      expect(payload.workingHours, '게이트로 빠진다').toBeUndefined()
      // 저장이 성공했으면 유실을 알리되 닫는다 — 팀은 저장됐고, 붙잡아 두면 덫이 된다
      expectLossAlert()
      expect(wrapper.emitted('save'), '저장된 파트가 있으므로 닫는다').toBeTruthy()
      // ★"저장되었습니다" 토스트와 "저장하지 못했다" alert 이 동시에 뜨면 서로 모순된다.
      //  전송된 파트는 실제로 저장됐지만, 지금 알려야 할 사실은 "일부가 안 들어갔다" 쪽이다.
      expect(push.success, '성공 토스트와 유실 안내가 동시에 뜨면 안 된다').not.toHaveBeenCalled()
    })

    it('★저장할 수 없는 파트의 편집은 baseline 으로 되돌아간다 — 다음 저장을 막지 않는다(덫 방지)', async () => {
      mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
      const wrapper = await mountSetting()

      const before = setupState(wrapper).includePublicHolidays
      await toggleHoliday(wrapper)   // site 파트(게이트) 편집
      await makeTeamDirty(wrapper)   // 저장 가능한 파트 편집
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expect(savedPayload().teams, '저장 가능한 파트는 저장된다').toBeTruthy()
      expectLossAlert()
      // 화면 상태가 원래대로 돌아와야 안내("안 들어갔다")와 보이는 값이 일치한다
      expect(setupState(wrapper).includePublicHolidays, '버린 편집은 baseline 으로 복원').toBe(before)

      // ★되돌렸으므로 다시 저장해도 같은 안내가 반복되지 않는다.
      //  되돌리지 않으면 사용자가 손수 원래대로 고치기 전까지 매번 안내가 떠 저장을 방해한다.
      dialogMock.alert.mockClear()
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expect(dialogMock.alert, '같은 안내가 반복되면 덫이다').not.toHaveBeenCalled()
    })

    it('전부 정상 + 수정 → alert 없음, 기존 동작 그대로 (회귀 방지)', async () => {
      const wrapper = await mountSetting()

      await makeTeamDirty(wrapper)
      await makeWorkingHoursDirty(wrapper)
      await toggleHoliday(wrapper)
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expect(dialogMock.alert).not.toHaveBeenCalled()
      expect(savedPayload().teams).toBeTruthy()
      expect(wrapper.emitted('save')).toBeTruthy()
    })

    it('변경이 전혀 없으면 게이트가 실패 상태여도 조용히 닫힌다 (불필요한 안내 금지)', async () => {
      mocks.getStaffWorkHours.mockRejectedValue(new Error('503'))
      const wrapper = await mountSetting()

      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expect(dialogMock.alert, '고친 게 없으면 유실도 없다').not.toHaveBeenCalled()
      expect(mocks.saveTreatmentSettings).not.toHaveBeenCalled()
      expect(wrapper.emitted('cancel')).toBeTruthy()
    })

    /* ★"고친 게 없으면 안 보낸다"의 유일한 예외 — 운영시간을 정하지 않은 요일이 남아 있을 때.
     * 그 요일을 '매주 휴무'으로 만드는 것은 사용자가 고친 값이 아니라 **화면이 만드는 값**이라
     * isDirtyIn(SITE_STATE_KEYS) 이 잡지 못한다. 그것까지 dirty 로 세지 않으면 저장이 위
     * "보낼 게 없다" 분기로 빠져 API 가 나가지 않고, 배너가 예고한 휴무가 아무 일도 없이
     * 사라진다 — 안내한 것과 실제가 어긋난다(실제로 눈검증에서 잡힌 결함이다). */
    it('★고친 게 없어도 운영시간 미설정 요일이 있으면 저장이 나간다 — 자동 매주 휴무', async () => {
      mocks.getSiteWorkHours.mockResolvedValue({
        data: {
          code: 'succeed',
          payload: {
            site: siteRows, holidayHours: holidayHoursRow,
            recurringOffRules: [],   // 토·일이 휴무로 정해져 있지 않다 = 미설정
            workDates: [], offDates: [], holidayClosedYn: true,
          },
        },
      })
      const wrapper = await mountSetting()

      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expect(mocks.saveTreatmentSettings, '저장이 스킵되면 안 된다').toHaveBeenCalled()
      expect(savedPayload().recurringOffRules, '미설정 주말이 매주 휴무로 나간다')
          .toEqual([0, 6].map(dayCd => ({ dayCd, repeatTy: 'WEEKLY', monthlyNth: null })))
    })
  })


  // ── ⑧ ★C-2: 재시도 성공이 사용자 편집을 흡수하지 않는다 ────
  //
  // retryHydrate 가 성공 후 origin 을 **전체** 재캡처하면, 재시도 전에 사용자가 정상 파트(팀)를
  // 고쳐둔 내용까지 baseline 이 되어 dirty 가 사라진다 → 저장을 눌러도 API 가 안 나가고
  // emit('cancel') 로 닫히며 그 편집이 조용히 증발한다.
  // 그래서 baseline 은 **이번에 새로 읽어온 파트의 키만** 갱신한다(rebaseOriginFor).
  describe('재시도 baseline — 새로 읽어온 파트만 rebase', () => {
    const retry = (wrapper: any) => wrapper.find('.schedulerTreatmentSetting__loadErrorRetry').trigger('click')

    it('site 실패 중 편집한 팀은 재시도 성공 후에도 dirty 로 남아 그대로 전송된다', async () => {
      mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
      const wrapper = await mountSetting()

      await makeTeamDirty(wrapper) // 재시도 **전에** 정상 파트를 고쳐둔다

      mocks.getSiteWorkHours.mockResolvedValue(okSite())
      await retry(wrapper)
      await flushPromises()

      expect(wrapper.find('.schedulerTreatmentSetting__loadError').exists()).toBe(false)

      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      const payload = savedPayload()
      expect(payload.teams.map((t: any) => t.name), '전체 rebase 였다면 이 편집이 증발했다').toContain('신규팀')
      expect(payload.site, '복구된 사업장 파트도 함께 나간다').toEqual(siteRows)
      expect(wrapper.emitted('save')).toBeTruthy()
    })

    it('재시도로 새로 읽어온 파트(site)는 baseline 이 갱신돼 dirty 로 잡히지 않는다', async () => {
      mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
      const wrapper = await mountSetting()

      mocks.getSiteWorkHours.mockResolvedValue(okSite())
      await retry(wrapper)
      await flushPromises()

      // 사용자가 고친 것은 하나도 없다 — 재조회로 채워진 기관값이 dirty 로 잡히면 안 된다
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expect(mocks.saveTreatmentSettings, 'site rebase 누락 시 불필요한 전체 치환 저장이 나간다').not.toHaveBeenCalled()
      expect(dialogMock.alert).not.toHaveBeenCalled()
      expect(wrapper.emitted('cancel'), '변경이 없으므로 조용히 닫힌다').toBeTruthy()
    })

    it('재시도했는데 여전히 실패하면 그 파트 baseline 은 갱신되지 않고 실패 플래그도 유지된다', async () => {
      mocks.getSiteWorkHours.mockRejectedValue(new Error('503'))
      const wrapper = await mountSetting()

      await makeTeamDirty(wrapper)
      await retry(wrapper) // 여전히 503
      await flushPromises()

      expect(mocks.getSiteWorkHours).toHaveBeenCalledTimes(2)
      expect(wrapper.find('.schedulerTreatmentSetting__loadError').exists(), '실패 플래그 유지').toBe(true)

      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      const payload = savedPayload()
      expect(payload.site, 'baseline 미확보 → 사업장 파트는 계속 미전송').toBeUndefined()
      expect(payload.teams.map((t: any) => t.name), '재시도 실패가 팀 편집을 흡수하지 않는다').toContain('신규팀')
    })
  })

  it('저장이 code=failed 로 오면 팝업을 닫지 않는다 (부분 성공 포함)', async () => {
    mocks.saveTreatmentSettings.mockResolvedValue({
      data: { code: 'failed', message: '사업장 운영시간 저장 실패', payload: { staff: 'succeed', site: 'failed' } },
    })
    const wrapper = await mountSetting()

    await toggleHoliday(wrapper)
    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.emitted('save')).toBeFalsy()
  })

  /**
   * 구성원 없는 팀 (2026-08-24).
   *
   * 서버는 이 상태를 거부하지 않는다 — 구성원 목록이 비면 팀만 저장하고 끝난다. 그래서 화면이 막지
   * 않으면 이름만 있는 팀이 그대로 저장되고, 사용자는 무엇이 잘못됐는지 알 수 없다.
   */
  describe('구성원 없는 팀 — 저장 전 안내', () => {
    it('★구성원이 없는 팀이 있으면 저장하지 않고 안내한다', async () => {
      const wrapper = await mountSetting()

      setupState(wrapper).teams.push({ id: 'TEAM_new', name: '신규팀', doctorIds: [] })
      await wrapper.vm.$nextTick()
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expect(mocks.saveTreatmentSettings, '저장 API 를 부르지 않는다').not.toHaveBeenCalled()
      expect(dialogMock.alert).toHaveBeenCalledTimes(1)
      expect(dialogMock.alert.mock.calls[0][0]).toBe(TEAM_MEMBERS_REQUIRED_MSG)
      expect(wrapper.emitted('save'), '팝업을 닫지 않는다').toBeFalsy()
    })

    /* ★문구는 팀 이름을 말하지 않는다 — 빈 팀이 여럿이면 하나만 말하게 되어 나머지를 감춘다.
     * 어느 팀인지는 화면이 전부 표시한다. */
    it('★빈 팀이 여럿이면 전부 하이라이트된다 — 문구는 팀 이름을 담지 않는다', async () => {
      const wrapper = await mountSetting()
      const state = setupState(wrapper)

      state.teams.push({ id: 'TEAM_x', name: '빈팀1', doctorIds: [] })
      state.teams.push({ id: 'TEAM_y', name: '빈팀2', doctorIds: [] })
      await wrapper.vm.$nextTick()

      /* 저장 전에는 그리지 않는다 — 입력 도중에 빨간 테두리를 띄우지 않는 규약 */
      expect(wrapper.findAll('.schedulerTreatmentSetting__memberArea[data-invalid="true"]').length).toBe(0)

      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      const marked = wrapper.findAll('.schedulerTreatmentSetting__memberArea[data-invalid="true"]')
      expect(marked.length, '빈 팀 두 개가 모두 표시돼야 한다').toBe(2)
      expect(dialogMock.alert.mock.calls[0][0], '문구에는 팀 이름이 없다').not.toContain('빈팀')
    })

    /* ★한 번 켜고 두면 그 뒤 만드는 팀은 반드시 빈 상태로 시작하므로 이름을 적기도 전에 빨개진다.
     * 경고가 상시가 되면 뜻을 잃는다 — 저장을 시도한 그 순간 비어 있던 팀만 표시한다. */
    it('★저장 시도 뒤에 새로 만든 빈 팀은 다시 저장을 누르기 전까지 표시되지 않는다', async () => {
      const wrapper = await mountSetting()
      const state = setupState(wrapper)

      state.teams.push({ id: 'TEAM_old', name: '빈팀', doctorIds: [] })
      await wrapper.vm.$nextTick()
      await saveBtn(wrapper).trigger('click')
      await flushPromises()
      expect(wrapper.findAll('.schedulerTreatmentSetting__memberArea[data-invalid="true"]').length).toBe(1)

      /* 지적받은 팀을 채우고, 새 팀을 하나 만든다 */
      state.teams = state.teams.map((t: any) => t.id === 'TEAM_old' ? { ...t, doctorIds: [STAFF_SET] } : t)
      state.teams.push({ id: 'TEAM_fresh', name: '새로 만든 팀', doctorIds: [] })
      await wrapper.vm.$nextTick()

      const marked = wrapper.findAll('.schedulerTreatmentSetting__memberArea[data-invalid="true"]')
      expect(marked.length, '새 팀은 아직 지적 대상이 아니다').toBe(0)

      /* 다시 저장을 누르면 그때 판정된다 */
      await saveBtn(wrapper).trigger('click')
      await flushPromises()
      expect(wrapper.findAll('.schedulerTreatmentSetting__memberArea[data-invalid="true"]').length).toBe(1)
    })

    it('구성원을 채우면 그대로 저장된다', async () => {
      const wrapper = await mountSetting()

      setupState(wrapper).teams.push({ id: 'TEAM_new', name: '신규팀', doctorIds: [STAFF_SET] })
      await wrapper.vm.$nextTick()
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expect(dialogMock.alert).not.toHaveBeenCalled()
      expect(savedPayload().teams.map((t: any) => t.name)).toContain('신규팀')
    })

    /* ★이미 저장돼 있던 빈 팀이 무관한 저장을 막으면 덫이 된다 — 사용자가 그 팀을 고치기 전에는
     * 운영시간·휴무일 변경조차 저장할 수 없게 된다. 팀을 실제로 보낼 때만 검사하는 이유다. */
    it('빈 팀이 원래 있었어도 팀을 건드리지 않았다면 다른 파트는 저장된다', async () => {
      mocks.getTeams.mockResolvedValue({
        data: {
          code   : 'succeed',
          payload: {
            teams: [
              { id: 1, name: '1구역', doctors: members(STAFF_SET, STAFF_UNSET) },
              { id: 2, name: '빈팀', doctors: [] },
            ],
          },
        },
      })
      const wrapper = await mountSetting()

      await toggleHoliday(wrapper)          // site 만 dirty — teams 는 건드리지 않는다
      await saveBtn(wrapper).trigger('click')
      await flushPromises()

      expect(dialogMock.alert).not.toHaveBeenCalled()
      expect(savedPayload().site, '사업장 설정 파트는 정상 전송').toBeDefined()
    })
  })
})

/**
 * 열려 있는 popover 의 입력도 저장에 실린다 (2026-09-03).
 *
 * 사고: 운영시간 popover 를 띄운 채 [저장] 을 누르면 방금 입력한 값이 통째로 빠졌다.
 * 저장은 상태만 보는데 popover 의 입력은 아직 draft 였고, 그 draft 를 상태로 옮기는
 * 배경 클릭 정리(handleDocumentClick)는 **버블**이라 저장 버튼 @click 보다 뒤에 돌기 때문이다.
 *
 * 규칙: onSave 가 첫머리에서 직접 정리한다(settleAllPopovers) — 시간 게이트보다 앞이라
 * 게이트도 그 draft 를 보고 판정한다.
 */
describe('저장 — 열려 있는 popover 의 draft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mocks.getTeams.mockResolvedValue(okTeams())
    mocks.getSiteWorkHours.mockResolvedValue(okSite())
    mocks.getStaffWorkHours.mockResolvedValue(okStaff())
    mocks.saveTreatmentSettings.mockResolvedValue({ data: { code: 'succeed', message: '저장되었습니다.', payload: { book: 'succeed', site: 'succeed' } } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  /** 사업장 월요일 popover 를 draft 만 얹어 연다 */
  function openInstitutionMonday(state: any, draft: Record<string, { start: string; end: string }>) {
    state.weekdayEditor.open = true
    state.weekdayEditor.ownerKey = 'INSTITUTION'
    state.weekdayEditor.weekday = 1
    state.weekdayEditor.draft = {
      WORK: { start: '', end: '' }, LUNCH: { start: '', end: '' }, DINNER: { start: '', end: '' }, ...draft,
    }
  }

  it('★popover 를 띄운 채 저장하면 그 입력이 payload 에 실린다', async () => {
    const wrapper = await mountSetting()
    const state = setupState(wrapper)
    openInstitutionMonday(state, { WORK: { start: '08:00', end: '17:00' } })

    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(state.weekdayEditor.open, '저장하면서 popover 도 정리된다').toBe(false)
    expect(savedPayload().site.find((r: any) => r.dayCd === 1), '방금 입력한 08:00~17:00')
      .toMatchObject({ openHm: '0800', closeHm: '1700' })
  })

  /* ★게이트보다 먼저 정리해야 하는 이유 — 순서가 뒤바뀌면 반쪽 입력이 게이트를 통과해
   * 그 요일이 휴무(null)으로 저장된다. */
  it('★popover 에 반쪽 입력이 남아 있으면 저장이 막힌다', async () => {
    const wrapper = await mountSetting()
    const state = setupState(wrapper)
    openInstitutionMonday(state, { WORK: { start: '08:00', end: '' } })

    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(mocks.saveTreatmentSettings, '저장하지 않는다').not.toHaveBeenCalled()
    expect(dialogMock.alert.mock.calls[0][0]).toBe('시작시간과 종료시간을 모두 입력해 주세요.')
  })
})
