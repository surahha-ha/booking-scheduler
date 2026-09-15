/**
 * SchedulerV3Page 마운트 하네스 — 페이지를 happy-dom 에 올리기 위한 외부 의존 mock 한 벌.
 *
 * 페이지는 SSE·라우터·API·HTTP 클라이언트를 마운트 시점에 부르므로 그것들을 여기서 한 번에 막는다.
 * 스토어는 실물을 쓴다(API 레이어만 mock) — 스토어 경유 동작이 판정 대상이기 때문.
 *
 * 쓰는 쪽은 이 모듈을 페이지보다 먼저 import 한다(vi.mock 등록이 페이지 import 앞에 와야 한다).
 * 테스트별로 더 막을 것이 있으면 자기 파일에서 vi.mock 을 추가한다.
 */

import { vi } from 'vitest'
import { ref } from 'vue'

vi.mock('@/lib/http', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
  useDialog: () => ({ alert: vi.fn(), confirm: vi.fn() }),
  useUserProfile: () => ({ currentUser: ref(null) }),
}))
vi.mock('@/lib/useDialog', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() }),
  useDialog: () => ({ alert: vi.fn(), confirm: vi.fn() }),
  useUserProfile: () => ({ currentUser: ref(null) }),
}))

// onCardCallback 은 성공 시 push.success(...) 의 반환값에 .clear() 를 호출한다.
const toastMocks = vi.hoisted(() => ({
  success: vi.fn(() => ({ clear: vi.fn() })),
  error: vi.fn(() => ({ clear: vi.fn() })),
}))
vi.mock('notivue', () => ({ push: toastMocks }))

// useQueryString(route/router) — 라우터 설치 없이 통과.
// replace/push 는 useQueryString 이 .finally() 를 붙이므로 Promise 를 돌려줘야 한다.
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({
    replace: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
  }),
}))

// SSE 구독(EventSource) 차단
vi.mock('@/composables/useReservationStream', () => ({ useReservationStream: vi.fn() }))

// SchedulerSearchFilter 는 이 페이지 트리에서 유일하게 devextreme 을 import 한다.
// devextreme 테마 로더가 주기 타이머를 걸어두는데, 테스트 환경이 내려간 뒤 그 타이머가 깨어나
// window.getComputedStyle 을 부르면 unhandled error 로 스위트 전체가 빨간불이 된다(간헐적).
// 필터를 스텁으로 대체해 devextreme 자체를 들이지 않는다.
vi.mock('@/pages/desktop/scheduleBoard/components/SchedulerSearchFilter.vue', () => ({
  default: { name: 'SchedulerSearchFilterStub', render: () => null },
}))

// ── API 레이어 mock (스토어는 실물 사용) ──
const api = vi.hoisted(() => ({
  add: vi.fn(),
  modify: vi.fn(),
  get: vi.fn(async () => ({ data: { code: 'succeed', payload: [] } })),
  getRecent: vi.fn(async () => ({ data: { code: 'succeed', payload: [] } })),
  /** staffApi.getDoctors — 테스트가 담당자 목록을 넣어 컬럼을 만든다. */
  getDoctors: vi.fn(async () => ({ data: { code: 'succeed', payload: [] } })),
  /** siteApi.getTeams — 테스트가 팀 소속을 넣어 팀 전환을 만든다. */
  getTeams: vi.fn(async () => ({ data: { code: 'succeed', payload: { teams: [] } } })),
}))
vi.mock('@/api/bookApi', () => ({
  add: api.add,
  modify: api.modify,
  get: api.get,
  getRecent: api.getRecent,
  getHolidays: vi.fn(async () => ({ data: { code: 'succeed', payload: [] } })),
  getMemberStatistics: vi.fn(async () => ({ data: { code: 'succeed', payload: [] } })),
  getStateStatistics: vi.fn(async () => ({ data: { code: 'succeed', payload: [] } })),
  getUnassignedReservations: vi.fn(async () => ({ data: { code: 'succeed', payload: false } })),
  assignUnassigned: vi.fn(),
  remove: vi.fn(),
  updateStatus: vi.fn(),
}))
vi.mock('@/api/staffApi', () => ({
  getDoctors: api.getDoctors,
  syncDoctors: vi.fn(async () => ({ data: { code: 'succeed', payload: [] } })),
  getDoctorSchedule: vi.fn(async () => ({ data: { code: 'succeed', payload: [] } })),
}))
vi.mock('@/api/siteApi', () => ({
  getTeams: api.getTeams,
  getSiteWorkHours: vi.fn(async () => ({ data: { code: 'succeed', payload: [] } })),
  getStaffWorkHours: vi.fn(async () => ({ data: { code: 'succeed', payload: [] } })),
  getTreatmentSettings: vi.fn(async () => ({ data: { code: 'succeed', payload: {} } })),
  saveTreatmentSettings: vi.fn(),
  reorderTeamMembers: vi.fn(),
}))
vi.mock('@/api/reservationSettingsApi', () => ({
  getReservationSettings: vi.fn(async () => ({ data: { code: 'succeed', payload: {} } })),
  saveReservationSettings: vi.fn(),
}))
vi.mock('@/api/publicHolidayApi', () => ({ fetchPublicHolidays: vi.fn(async () => []) }))

// ReservationPopup 은 실물 대신 스텁 — save/modify 를 emit 하고 visible/saving prop 을 관찰한다.
vi.mock('@/components/popup/ReservationPopup.vue', () => ({
  default: {
    name: 'ReservationPopupStub',
    props: {
      visible: { type: Boolean, default: false },
      payload: { type: Object, default: null },
      getBlockedReason: { type: Function, default: null },
      isDayOff: { type: Boolean, default: false },
      saving: { type: Boolean, default: false },
    },
    emits: ['close', 'save', 'modify'],
    render: () => null,
  },
}))

/** happy-dom 에는 ResizeObserver 가 없다(페이지 onMounted 에서 사용). beforeEach 에서 부른다. */
export function stubResizeObserver() {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
}

export { api, toastMocks }
