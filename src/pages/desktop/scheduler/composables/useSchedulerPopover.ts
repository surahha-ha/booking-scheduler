/**
 * 스케줄러 Popover Composable
 *
 * 책임:
 *   - quick action popover 상태 관리 (단일 popover)
 *   - open / close / toggle
 *   - hover suppress 연동 (open → suppress, close → unsuppress)
 *   - interactionLock 연동 (lock 시 강제 close)
 *   - outside click / ESC / scroll 시 자동 close
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
   */
  setPopoverElement: (el: HTMLElement | null) => void
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

  function setPopoverElement(el: HTMLElement | null): void {
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

  onBeforeUnmount(() => {
    stopLockWatch()
    bodyEl.value?.removeEventListener('scroll', onBodyScroll)
    window.removeEventListener('scroll', onBodyScroll, true)
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
