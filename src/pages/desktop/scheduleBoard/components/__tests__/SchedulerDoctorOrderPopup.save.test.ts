/**
 * @vitest-environment happy-dom
 *
 * 담당자 순서 변경 팝업 저장 — 순서 전용 API 회귀 방지.
 *
 * BE 계약(POST /book/v2/site/teams/member-order):
 *  - body = { teams: [{ teamId, orderedStaffIds:[staffId, ...] }] }
 *  - orderedStaffIds 의 index 가 팀 구성원 정렬순서(SORT_ORD)가 된다.
 *  - 이 팝업은 더 이상 settings/save(전체 치환) 를 호출하지 않는다 — 팀·운영시간·사업장 설정은 건드리지 않는다.
 *
 * 지키는 것:
 *  ① 저장은 reorderTeamMembers 만 호출한다(getTreatmentSettings/save·work-hours passthrough 없음).
 *  ② payload.teams 는 { teamId, orderedStaffIds } 형태이며 드래그로 바꾼 순서를 그대로 담는다.
 *  ③ 성공 시 loadTeams 재조회 + saved/close emit, 실패(code!=='succeed') 시 닫지 않는다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// ── 외부 의존 stub ──────────────────────────────────────────
vi.mock('@/lib/useDialog', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
  useDialog: () => ({ alert: vi.fn(), confirm: vi.fn() }),
}))
vi.mock('notivue', () => ({
  push: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const mocks = vi.hoisted(() => ({
  reorderTeamMembers: vi.fn(),
  getUnassignedReservations: vi.fn(),
  assignUnassigned: vi.fn(),
  triggerSearch: vi.fn(),
}))
vi.mock('@/api/siteApi', () => ({
  reorderTeamMembers: mocks.reorderTeamMembers,
  // staffStore 가 모듈 로드 시 import 하는 함수들 — 저장 경로엔 쓰이지 않지만 export 는 있어야 한다
  getTeams: vi.fn(),
  getTreatmentSettings: vi.fn(),
  getSiteWorkHours: vi.fn(),
  getStaffWorkHours: vi.fn(),
  saveTreatmentSettings: vi.fn(),
}))
vi.mock('@/api/bookApi', () => ({
  getUnassignedReservations: mocks.getUnassignedReservations,
  assignUnassigned: mocks.assignUnassigned,
}))
vi.mock('@/stores/useSchedulerFilterStore', () => ({
  useSchedulerFilterStore: () => ({ triggerSearch: mocks.triggerSearch }),
}))

import { push } from 'notivue'
import { useStaffStore } from '@/stores/staffStore'
import SchedulerDoctorOrderPopup from '@/pages/desktop/scheduleBoard/components/SchedulerDoctorOrderPopup.vue'

const TEAM_ID = 7
const DOC_A = 101
const DOC_B = 202
const DOC_C = 303

/** 팝업 오픈 시 draft 로 복사될 팀 구성 (A,B,C 순) */
function seedTeams(store: ReturnType<typeof useStaffStore>) {
  store.teams = [
    {
      id: TEAM_ID,
      name: '1구역',
      doctors: [
        { staffId: DOC_A, staffName: '가의사' },
        { staffId: DOC_B, staffName: '나의사' },
        { staffId: DOC_C, staffName: '다의사' },
      ],
    },
  ] as any
}

async function mountPopup() {
  const store = useStaffStore()
  seedTeams(store)
  const loadTeams = vi.spyOn(store, 'loadTeams').mockResolvedValue(undefined as any)
  const wrapper = mount(SchedulerDoctorOrderPopup, {
    props: { visible: true },
    global: { stubs: { Teleport: true } },
  })
  await flushPromises()
  return { wrapper, store, loadTeams }
}

const saveBtn = (wrapper: any) => wrapper.find('.doctorOrderPopup__saveBtn')

function savedPayload() {
  expect(mocks.reorderTeamMembers, '순서 전용 API 호출').toHaveBeenCalledTimes(1)
  return mocks.reorderTeamMembers.mock.calls[0][0] as any
}

describe('담당자 순서 변경 팝업 — 순서 전용 API 저장', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mocks.reorderTeamMembers.mockResolvedValue({ data: { code: 'succeed', message: '저장되었습니다.' } })
    mocks.getUnassignedReservations.mockResolvedValue({ data: { payload: { assignable: false } } })
  })

  it('저장 → settings/save 가 아니라 순서 전용 payload({teamId, orderedStaffIds})를 보낸다', async () => {
    const { wrapper } = await mountPopup()

    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    const payload = savedPayload()
    expect(payload).toEqual({
      teams: [{ teamId: TEAM_ID, orderedStaffIds: [DOC_A, DOC_B, DOC_C] }],
    })
  })

  it('드래그로 바꾼 순서가 orderedStaffIds 배열 순서에 그대로 반영된다', async () => {
    const { wrapper } = await mountPopup()

    // 첫 행(가의사, idx 0)을 세 번째(idx 2)로 이동 → 나,다,가 순
    const state = wrapper.vm.$.setupState
    state.onDragStart(TEAM_ID, 0)
    state.onDrop(TEAM_ID, 2)
    await wrapper.vm.$nextTick()

    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(savedPayload().teams[0].orderedStaffIds).toEqual([DOC_B, DOC_C, DOC_A])
  })

  it('성공 → loadTeams 재조회 + saved/close emit', async () => {
    const { wrapper, loadTeams } = await mountPopup()

    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(loadTeams).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('saved')).toBeTruthy()
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('code!==succeed → 에러 안내, 닫지 않고 loadTeams 도 호출하지 않는다', async () => {
    mocks.reorderTeamMembers.mockResolvedValue({ data: { code: 'failed', message: '순서 저장 실패' } })
    const { wrapper, loadTeams } = await mountPopup()

    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(push.error).toHaveBeenCalledWith('순서 저장 실패')
    expect(loadTeams).not.toHaveBeenCalled()
    expect(wrapper.emitted('saved')).toBeFalsy()
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('저장 경로는 settings/save 계열 API 를 전혀 호출하지 않는다 (passthrough 제거 회귀)', async () => {
    const siteApi: any = await import('@/api/siteApi')
    const { wrapper } = await mountPopup()

    await saveBtn(wrapper).trigger('click')
    await flushPromises()

    expect(siteApi.saveTreatmentSettings).not.toHaveBeenCalled()
    expect(siteApi.getTreatmentSettings).not.toHaveBeenCalled()
    expect(siteApi.getSiteWorkHours).not.toHaveBeenCalled()
    expect(siteApi.getStaffWorkHours).not.toHaveBeenCalled()
  })
})
