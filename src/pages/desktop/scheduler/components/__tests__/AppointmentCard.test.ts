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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

// '당일' 뱃지 — 진료 화면에서, 진료장부에서 등록한 건(isTreatmentRegistered) 중 오늘 등록한 건에만 붙는다.
// 예약장부에서 등록한 건(CMM)은 진료 화면에 보여도 붙지 않는다(등록 화면 구분은 BE RESERVATION_USE_TYPE).
describe("AppointmentCard - '당일' 뱃지", () => {
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('진료 화면 + 진료장부 등록건 + 오늘 등록 → .card-today-badge 노출', () => {
    useSchedulerFilterStore().dataType = 'TREATMENT'
    const wrapper = mountCard({ isTreatmentRegistered: true, createdAt: today })
    const badge = wrapper.find('.card-today-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('당일')
  })

  it('진료 화면 + 예약장부 등록건(isTreatmentRegistered=false) + 오늘 등록 → 뱃지 없음', () => {
    useSchedulerFilterStore().dataType = 'TREATMENT'
    const wrapper = mountCard({ isTreatmentRegistered: false, createdAt: today })
    expect(wrapper.find('.card-today-badge').exists()).toBe(false)
  })

  it('진료 화면 + isTreatmentRegistered 미정의 + 오늘 등록 → 뱃지 없음(기본값 제외)', () => {
    useSchedulerFilterStore().dataType = 'TREATMENT'
    const wrapper = mountCard({ isTreatmentRegistered: undefined, createdAt: today })
    expect(wrapper.find('.card-today-badge').exists()).toBe(false)
  })

  it('진료 화면 + 진료장부 등록건 + 어제 등록 → 뱃지 없음', () => {
    useSchedulerFilterStore().dataType = 'TREATMENT'
    const wrapper = mountCard({ isTreatmentRegistered: true, createdAt: yesterday })
    expect(wrapper.find('.card-today-badge').exists()).toBe(false)
  })

  it('예약 화면에서는 진료장부 등록건이라도 뱃지 없음', () => {
    useSchedulerFilterStore().dataType = 'APPOINTMENT'
    const wrapper = mountCard({ isTreatmentRegistered: true, createdAt: today })
    expect(wrapper.find('.card-today-badge').exists()).toBe(false)
  })
})

// 예약 화면은 예약(00)·취소(03)만 상태 색으로 구분한다. 진료완료·미이행·접수대기 건은
// 예약(00)처럼(상태 클래스 없이) 그린다. 진료 화면은 실제 상태 색을 그대로 쓴다.
describe('AppointmentCard - 화면별 상태 색 클래스', () => {
  const STATUS_CLASSES = ['status-done', 'status-undone', 'status-cancel', 'status-receipt']

  // 템플릿 루트가 주석으로 시작해 wrapper.classes() 는 비어 있다 → 카드 엘리먼트를 직접 찾는다.
  function statusClassOf(wrapper) {
    return wrapper.find('.appointment-card').classes().filter(c => STATUS_CLASSES.includes(c))
  }

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it.each([
    ['01', 'is-done'],
    ['02', 'is-undone'],
    ['05', 'is-receipt'],
  ])('예약 화면: status %s 는 상태 색 없이 예약(00)처럼 그린다', (status, statusClass) => {
    useSchedulerFilterStore().dataType = 'APPOINTMENT'
    const wrapper = mountCard({ status, statusClass })
    expect(statusClassOf(wrapper)).toEqual([])
  })

  it('예약 화면: 취소(03)는 status-cancel 로 구분한다', () => {
    useSchedulerFilterStore().dataType = 'APPOINTMENT'
    const wrapper = mountCard({ status: '03', statusClass: 'is-cancel' })
    expect(statusClassOf(wrapper)).toEqual(['status-cancel'])
  })

  it.each([
    ['01', 'is-done', 'status-done'],
    ['02', 'is-undone', 'status-undone'],
    ['03', 'is-cancel', 'status-cancel'],
    ['05', 'is-receipt', 'status-receipt'],
  ])('진료 화면: status %s 는 실제 상태 색(%s → %s)을 그대로 쓴다', (status, statusClass, expected) => {
    useSchedulerFilterStore().dataType = 'TREATMENT'
    const wrapper = mountCard({ status, statusClass })
    expect(statusClassOf(wrapper)).toEqual([expected])
  })
})

/**
 * 리사이즈 핸들 포털 사본(.resize-handle-portal)
 * - 밑바탕(isLayerBase) 카드의 꼬리 위에 float 이 얹히면 카드 안 하단 핸들이 가려진다 → hover 중 포털에 사본을 띄운다.
 * - 밑바탕이 아닌 카드·hover 아닌 카드는 사본 없음(e2e 의 카드 안 핸들 좌표 클릭을 가로채지 않도록).
 * - 사본 mousedown 은 카드 안 핸들과 같은 startResize 호출.
 * Teleport 대상(.v3-qa-portal)은 보드(SchedulerV3Page)가 만든다 → 테스트가 body 에 직접 만든다.
 */
describe('AppointmentCard - 밑바탕 카드 리사이즈 핸들 포털 사본', () => {
  let portalEl

  function mountWithHover({ hovered, rect, provideOverrides = {} }) {
    const provide = createProvide()
    provide.schedulerHover.hoveredId = ref(hovered ? 'appt-1' : null)
    Object.assign(provide, provideOverrides)
    const wrapper = mount(AppointmentCard, {
      props: {
        appointment: makeAppointment(),
        rect: { ...baseRect, ...rect },
        columnKey: '2026-05-28_홍길동',
        displayTier: 'standard',
      },
      global: { provide },
    })
    return { wrapper, provide }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    portalEl = document.createElement('div')
    portalEl.className = 'v3-qa-portal'
    document.body.appendChild(portalEl)
  })

  afterEach(() => {
    portalEl.remove()
  })

  it('hover 중 + isLayerBase → 포털에 top/bottom 사본 2개, 카드 rect 의 위·아래 변에 전폭으로', () => {
    const rect = { top: 100, left: 50, width: 200, height: 240, isLayerBase: true }
    mountWithHover({ hovered: true, rect })
    const handles = portalEl.querySelectorAll('.resize-handle-portal')
    expect(handles).toHaveLength(2)
    const top = portalEl.querySelector('.resize-handle-portal--top')
    const bottom = portalEl.querySelector('.resize-handle-portal--bottom')
    expect(top.style.top).toBe('100px')
    expect(top.style.left).toBe('50px')
    expect(top.style.width).toBe('200px')
    expect(bottom.style.top).toBe(`${100 + 240 - 3}px`) // 카드 하단 3px
    expect(bottom.style.height).toBe('3px')
  })

  it('밑바탕이 아니면 hover 중이라도 사본 없음', () => {
    mountWithHover({ hovered: true, rect: { isLayerBase: false } })
    expect(portalEl.querySelectorAll('.resize-handle-portal')).toHaveLength(0)
  })

  it('hover 아니면 밑바탕이라도 사본 없음', () => {
    mountWithHover({ hovered: false, rect: { isLayerBase: true } })
    expect(portalEl.querySelectorAll('.resize-handle-portal')).toHaveLength(0)
  })

  it('리사이즈 진행 중(resizeState 가 이 카드)에는 사본을 감춘다', () => {
    const provideOverrides = {
      schedulerResize: {
        resizeState: ref({ appointmentId: 'appt-1', direction: 'bottom', isValid: true }),
        startResize: vi.fn(),
      },
    }
    mountWithHover({ hovered: true, rect: { isLayerBase: true }, provideOverrides })
    expect(portalEl.querySelectorAll('.resize-handle-portal')).toHaveLength(0)
  })

  it('하단 사본 mousedown(좌클릭) → 카드 안 핸들과 같은 startResize(direction bottom) 호출', async () => {
    const { provide } = mountWithHover({ hovered: true, rect: { isLayerBase: true } })
    const bottom = portalEl.querySelector('.resize-handle-portal--bottom')
    bottom.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
    const startResize = provide.schedulerResize.startResize
    expect(startResize).toHaveBeenCalledTimes(1)
    expect(startResize.mock.calls[0][1]).toMatchObject({ appointmentId: 'appt-1', direction: 'bottom' })
  })

  it('사본 mouseenter/leave 는 ⋮ 버튼과 같은 hover 유예 함수를 쓴다(카드 밖 요소로 옮겨도 hover 유지)', () => {
    const { provide } = mountWithHover({ hovered: true, rect: { isLayerBase: true } })
    const bottom = portalEl.querySelector('.resize-handle-portal--bottom')
    bottom.dispatchEvent(new MouseEvent('mouseenter'))
    expect(provide.schedulerHover.onQuickActionEnter).toHaveBeenCalledTimes(1)
    bottom.dispatchEvent(new MouseEvent('mouseleave'))
    expect(provide.schedulerHover.onQuickActionLeave).toHaveBeenCalledTimes(1)
  })
})

describe('AppointmentCard - 긴 예약 좌측 바(is-long-card)와 층수별 농도(--layer-marker-opacity)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function cardElOf(rectOverrides = {}) {
    const wrapper = mount(AppointmentCard, {
      props: {
        appointment: makeAppointment(),
        rect: { ...baseRect, ...rectOverrides },
        columnKey: '2026-05-28_홍길동',
        displayTier: 'standard',
      },
      global: { provide: createProvide() },
    })
    return wrapper.find('.appointment-card')
  }

  /** 카드 루트 인라인 스타일의 --layer-marker-opacity 값. 루트가 fragment(Teleport 동반)라 카드 요소로 찾는다. */
  function markerOpacityOf(rectOverrides = {}) {
    return cardElOf(rectOverrides).element.style.getPropertyValue('--layer-marker-opacity')
  }

  it('좌측 바는 긴 예약이면서 가려졌을 때만 — 두 클래스가 함께 있어야 CSS 가 바를 그린다', () => {
    // 바(::before)의 셀렉터는 .is-long-card.is-layer-base 다. 둘 중 하나만으로는 그려지지 않는다 —
    // 가려지지 않은 긴 예약에 바가 붙으면 '아래에 가린 것이 있다'가 아니라 '길다'는 뜻이 돼버린다.
    const both = cardElOf({ isLongCard: true, isLayerBase: true }).classes()
    expect(both).toContain('is-long-card')
    expect(both).toContain('is-layer-base')

    // 긴 예약이지만 아무도 얹히지 않음 → is-layer-base 가 없어 바가 안 그려진다.
    expect(cardElOf({ isLongCard: true, isLayerBase: false }).classes()).not.toContain('is-layer-base')

    // 얹혔지만 긴 예약이 아님 → is-long-card 가 없어 바가 안 그려진다.
    expect(cardElOf({ isLayerBase: true, isLongCard: false }).classes()).not.toContain('is-long-card')
  })

  it('layerDepth 0(맨 아래 밑바탕) → 농도 1', () => {
    expect(markerOpacityOf({ isLayerBase: true, layerDepth: 0 })).toBe('1')
  })

  it('layerDepth 1 → 0.7, depth 2 → 0.4 (층마다 0.3씩 연해지는 계단)', () => {
    expect(markerOpacityOf({ isLayerBase: true, layerDepth: 1 })).toBe('0.7')
    expect(markerOpacityOf({ isLayerBase: true, layerDepth: 2 })).toBe('0.4')
  })

  it('layerDepth 3 이상 → 하한 0.3 (연한 상태색이 배경에 묻히지 않게)', () => {
    expect(markerOpacityOf({ isLayerBase: true, layerDepth: 3 })).toBe('0.3')
    expect(markerOpacityOf({ isLayerBase: true, layerDepth: 5 })).toBe('0.3')
  })

  it('layerDepth 미지정 rect(구 엔진 호환) → 농도 1 (마커 무영향)', () => {
    expect(markerOpacityOf({ isLayerBase: true })).toBe('1')
  })
})
