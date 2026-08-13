/**
 * @vitest-environment happy-dom
 *
 * AppointmentCard.vue 컴포넌트 단위 테스트
 *
 * 검증 범위: EXT 뱃지(.card-external-badge) 렌더링 조건
 * - appointment.isExternalSync === true  → .card-external-badge 노출 + text 'EXT'
 * - appointment.isExternalSync false/undefined → .card-external-badge 없음
 *
 * production 코드(AppointmentCard.vue)는 수정하지 않는다.
 * mount 의존성(inject/pinia/dialog)은 테스트 셋업에서만 충족시킨다.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// 다이얼로그 모킹
// - useDialog: confirm 스파이 반환 (AppointmentCard가 직접 사용)
// - useApi / useUserProfile: bookApi → bookStore import 체인이 모듈 로드 시점에
//   호출하므로 부작용 없는 stub 필요 (EXT 뱃지 검증과 무관)
vi.mock('@/lib/useDialog', () => ({
  useDialog: () => ({ confirm: vi.fn() }),
  useApi: () => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  }),
  useUserProfile: () => ({ currentUser: ref(null) }),
}))

import AppointmentCard from '@/pages/desktop/scheduler/components/AppointmentCard.vue'
import { useSchedulerFilterStore } from '@/stores/useSchedulerFilterStore'

// ── inject provide 팩토리 (컴포넌트가 .value 접근하므로 ref 사용) ──
function createProvide() {
  return {
    schedulerHover: {
      hoveredId: ref(null),
      showQuickAction: ref(false),
      onCardEnter: vi.fn(),
      onCardLeave: vi.fn(),
      clearHover: vi.fn(),
      onQuickActionEnter: vi.fn(),
      onQuickActionLeave: vi.fn(),
    },
    schedulerPopover: {
      openedId: ref(null),
      isOpen: ref(false),
      toggle: vi.fn(),
      close: vi.fn(),
      setPopoverElement: vi.fn(),
    },
    schedulerDrag: {
      dragState: ref(null),
      startDrag: vi.fn(),
    },
    schedulerResize: {
      resizeState: ref(null),
      startResize: vi.fn(),
    },
  }
}

// ── appointment fixture (EXT 뱃지 외 필드는 렌더 의존성 충족용) ──
function makeAppointment(overrides = {}) {
  return {
    id: 'appt-1',
    patientName: '홍길동',
    patientPhone: '010-1234-5678',
    memo: '정기검진',
    status: '00',
    statusClass: 'is-waiting',
    isJoinMember: false,
    isExternalSync: false,
    startMinute: 600,
    endMinute: 630,
    ...overrides,
  }
}

const baseRect = { top: 100, left: 50, width: 200, height: 38, zIndex: 1 }

function mountCard(appointmentOverrides = {}) {
  return mount(AppointmentCard, {
    props: {
      appointment: makeAppointment(appointmentOverrides),
      rect: { ...baseRect },
      columnKey: '2026-05-28_홍길동',
      displayTier: 'standard',
    },
    global: {
      provide: createProvide(),
    },
  })
}

describe('AppointmentCard - EXT 뱃지', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 예약(APPOINTMENT) 화면 기준 — store 기본값이 'APPOINTMENT'이나 명시적으로 고정
    useSchedulerFilterStore().dataType = 'APPOINTMENT'
  })

  it('isExternalSync: true → .card-external-badge 노출 + text "EXT"', () => {
    const wrapper = mountCard({ isExternalSync: true })

    const badge = wrapper.find('.card-external-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('EXT')
  })

  it('isExternalSync: false → .card-external-badge 없음', () => {
    const wrapper = mountCard({ isExternalSync: false })

    expect(wrapper.find('.card-external-badge').exists()).toBe(false)
  })

  it('isExternalSync: undefined → .card-external-badge 없음', () => {
    const wrapper = mountCard({ isExternalSync: undefined })

    expect(wrapper.find('.card-external-badge').exists()).toBe(false)
  })

  it('고객명(.card-patient)은 isExternalSync 여부와 무관하게 항상 렌더', () => {
    const withBadge = mountCard({ isExternalSync: true })
    const withoutBadge = mountCard({ isExternalSync: false })

    expect(withBadge.find('.card-patient').text()).toBe('홍길동')
    expect(withoutBadge.find('.card-patient').text()).toBe('홍길동')
  })
})
