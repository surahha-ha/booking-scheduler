/**
 * 스케줄러 Popover Composable
 *
 * 책임:
 *   - quick action popover 상태 관리 (단일 popover)
 *   - open / close / toggle
 *   - hover suppress 연동 (open → suppress, close → unsuppress)
 *   - interactionLock 연동 (lock 시 강제 close)
 *   - outside click / ESC / scroll / resize 시 자동 close
 *
 * 하지 않는 것:
 *   - hover 관리 (useSchedulerHover)
 *   - popover 내부 UI / 액션 처리
 *   - context menu 관리
 *
 * hover 연동 흐름:
 *   open  → hover.suppress()  (카드 밖으로 나가도 hover 유지)
 *   close → hover.unsuppress() (마우스 위치에 따라 hover 재판정)
 */

import { ref, computed, watch, onBeforeUnmount, readonly, type Ref, type ComputedRef, type DeepReadonly } from 'vue'
import type { UseSchedulerInteractionLockReturn } from './useSchedulerInteractionLock'
import type { UseSchedulerHoverReturn } from './useSchedulerHover'

// ═══════════════════════════════════════════════════════════
// 타입 정의
// ═══════════════════════════════════════════════════════════

export interface PopoverState {
  appointmentId: string
  triggerElement: HTMLElement
  /** popover를 연 시점의 trigger 위치 (scroll 변화 감지용) */
  anchorRect: DOMRect
}

// ═══════════════════════════════════════════════════════════
// Return 타입
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerPopoverReturn {
  /** 현재 popover 상태 (null이면 닫힘) */
  popoverState: DeepReadonly<Ref<PopoverState | null>>
  /** popover 열림 여부 */
  isOpen: ComputedRef<boolean>
  /** 현재 열린 appointment ID */
  openedId: ComputedRef<string | null>

  /** popover 열기 */
  open: (appointmentId: string, triggerElement: HTMLElement) => void
  /** popover 닫기 */
  close: () => void
  /** toggle (같은 id면 닫고, 다른 id면 열기) */
  toggle: (appointmentId: string, triggerElement: HTMLElement) => void

  /**
   * popover 컨테이너 element 등록.
   * outside click 판정에서 이 element 내부 클릭은 무시한다.
   *
   * 슬롯이 하나뿐이라 지금 열려 있는 카드만 채울 수 있다 — appointmentId 로 주인을 밝힌다.
   */
  setPopoverElement: (el: HTMLElement | null, appointmentId?: string) => void
}

// ═══════════════════════════════════════════════════════════
// 입력 옵션
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerPopoverOptions {
  interactionLock: UseSchedulerInteractionLockReturn
  hover: UseSchedulerHoverReturn
  /** body 스크롤 컨테이너 (scroll 시 close 감지) */
  bodyEl: Ref<HTMLElement | null>
}

// ═══════════════════════════════════════════════════════════
// Composable 본체
// ═══════════════════════════════════════════════════════════

export function useSchedulerPopover(
  options: UseSchedulerPopoverOptions
): UseSchedulerPopoverReturn {

  const { interactionLock, hover, bodyEl } = options

  // ── 상태 ──
  const _state = ref<PopoverState | null>(null)
  let _popoverEl: HTMLElement | null = null

  // ── 파생 ──
  const isOpen = computed(() => _state.value !== null)
  const openedId = computed(() => _state.value?.appointmentId ?? null)

  // ═══════════════════════════════════════════════════════════
  // Open / Close / Toggle
  // ═══════════════════════════════════════════════════════════

  function open(appointmentId: string, triggerElement: HTMLElement): void {
    // lock 중이면 차단
    if (interactionLock.isLocked.value) return

    // 이미 같은 popover가 열려 있으면 무시
    if (_state.value?.appointmentId === appointmentId) return

    // 다른 popover가 열려 있으면 먼저 닫기
    if (_state.value) {
      close()
    }

    _state.value = {
      appointmentId,
      triggerElement,
      anchorRect: triggerElement.getBoundingClientRect(),
    }

    // hover 해제 억제
    hover.suppress()

    // global 리스너 등록
    document.addEventListener('mousedown', onOutsideClick, true)
    document.addEventListener('keydown', onKeyDown)
  }

  function close(): void {
    if (!_state.value) return

    _state.value = null

    // 패널 슬롯 비우기 — 주인 판정 가드 때문에 카드 쪽 해제(null)는 더 이상 들어오지 않는다.
    // 여기서 안 비우면 닫힌 뒤에도 떨어져 나간 DOM 참조가 남는다.
    _popoverEl = null

    // hover 억제 해제
    hover.unsuppress()

    // global 리스너 해제
    document.removeEventListener('mousedown', onOutsideClick, true)
    document.removeEventListener('keydown', onKeyDown)
  }

  function toggle(appointmentId: string, triggerElement: HTMLElement): void {
    if (_state.value?.appointmentId === appointmentId) {
      close()
    } else {
      open(appointmentId, triggerElement)
    }
  }

  /**
   * 주인 판정 가드 — 슬롯은 전역 하나인데 카드마다 자기 패널을 감시해 등록(el)과 해제(null)를 각각 넣는다.
   * 카드 A → B 로 옮겨 열 때 B 의 등록이 먼저 flush 되고 A 의 해제가 뒤에 오면 B 의 패널이 null 로 덮여,
   * 바깥클릭 판정이 패널 안쪽을 알아보지 못한다(리스너가 캡처 단계라 패널의 mousedown.stop 도 못 막는다).
   * 그러면 메뉴 항목을 눌러도 메뉴가 먼저 닫혀 클릭이 먹지 않는다 — flush 순서에 달려 간헐적이다.
   * 지금 열린 카드가 아닌 곳에서 온 호출은 무시한다. 닫을 때는 close() 가 슬롯을 비운다.
   */
  function setPopoverElement(el: HTMLElement | null, appointmentId?: string): void {
    if (appointmentId != null && _state.value?.appointmentId !== appointmentId) return
    _popoverEl = el
  }

  // ═══════════════════════════════════════════════════════════
  // 자동 닫힘 핸들러
  // ═══════════════════════════════════════════════════════════

  /** outside click: popover 컨테이너 및 trigger 밖 클릭 시 닫기 */
  function onOutsideClick(e: MouseEvent): void {
    if (!_state.value) return
    const target = e.target as Node

    // popover 내부 클릭 → 무시
    if (_popoverEl?.contains(target)) return

    // trigger element 클릭 → toggle이 처리하므로 무시
    if (_state.value.triggerElement.contains(target)) return

    close()
  }

  /** ESC 키 → 닫기 */
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      close()
    }
  }

  /** body scroll → 닫기 */
  function onBodyScroll(): void {
    if (_state.value) {
      close()
    }
  }

  /**
   * 창 크기 변경 → 닫기.
   * 위치는 열 때 잡은 anchorRect 한 장이라 리사이즈를 따라가지 못한다. 카드는 새 레이아웃으로 옮겨가고
   * popover 만 옛 좌표에 남는다 — 따라가게 만드는 대신 스크롤과 같은 규약으로 닫는다.
   */
  function onViewportResize(): void {
    if (_state.value) {
      close()
    }
  }

  // ═══════════════════════════════════════════════════════════
  // InteractionLock 연동
  // ═══════════════════════════════════════════════════════════

  const stopLockWatch = watch(interactionLock.isLocked, (locked) => {
    if (locked && _state.value) {
      close()
    }
  })

  // ═══════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════

  // bodyEl이 나중에 설정되므로 watch로 리스너 등록
  watch(bodyEl, (el, oldEl) => {
    oldEl?.removeEventListener('scroll', onBodyScroll)
    el?.addEventListener('scroll', onBodyScroll, { passive: true })
  }, { immediate: true })

  // V3 는 보드 내부 스크롤이 아니라 브라우저 전체 스크롤이라 bodyEl scroll 만으론 안 잡힘.
  // window 캡처 단계로 임의 스크롤(전체/중첩)을 모두 감지해 popover 닫기(fixed popover 떠다님 방지).
  window.addEventListener('scroll', onBodyScroll, { passive: true, capture: true })
  window.addEventListener('resize', onViewportResize)

  onBeforeUnmount(() => {
    stopLockWatch()
    bodyEl.value?.removeEventListener('scroll', onBodyScroll)
    window.removeEventListener('scroll', onBodyScroll, true)
    window.removeEventListener('resize', onViewportResize)
    close()
  })

  return {
    popoverState: readonly(_state),
    isOpen,
    openedId,
    open,
    close,
    toggle,
    setPopoverElement,
  }
}
