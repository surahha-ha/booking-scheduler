/**
 * 스케줄러 Hover Composable
 *
 * 책임:
 *   - 예약 카드 hover 상태 관리 (단일 hover)
 *   - quick action 버튼 노출 타이밍 제어
 *   - hover 억제(suppress) 상태 관리
 *   - interactionLock 연동 (lock 시 강제 해제)
 *
 * 하지 않는 것:
 *   - popover 관리 (useSchedulerPopover)
 *   - context menu 관리
 *   - quick action 클릭 동작 (popover에 위임)
 *
 * hover 억제(suppress) 정책:
 *   popover가 열려 있거나, context menu가 열려 있을 때
 *   외부에서 suppress()를 호출하면 hover 해제가 억제된다.
 *   unsuppress() 호출 시 현재 마우스 위치에 따라 hover를 재판정한다.
 *
 * 타이밍 정책:
 *   quick action 노출: mouseenter 후 150ms 대기
 *   card leave: 50ms delay (quick action 버튼 이동 유예)
 */

import { ref, watch, onBeforeUnmount, readonly, type Ref, type Readonly as VueReadonly } from 'vue'
import type { UseSchedulerInteractionLockReturn } from './useSchedulerInteractionLock'

// ═══════════════════════════════════════════════════════════
// 설정
// ═══════════════════════════════════════════════════════════

export interface HoverConfig {
  /** quick action 노출까지 대기 시간 (ms). 기본 150. */
  quickActionDelay: number
  /** card leave 후 해제까지 유예 시간 (ms). 기본 50. */
  leaveGracePeriod: number
}

const DEFAULT_CONFIG: HoverConfig = {
  quickActionDelay: 150,
  leaveGracePeriod: 50,
}

// ═══════════════════════════════════════════════════════════
// Return 타입
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerHoverReturn {
  /** 현재 hover 중인 appointment ID (null이면 없음) */
  hoveredId: Readonly<Ref<string | null>>
  /** hover 중인 카드의 DOM element */
  hoveredElement: Readonly<Ref<HTMLElement | null>>
  /** quick action 버튼 표시 여부 */
  showQuickAction: Readonly<Ref<boolean>>
  /** hover가 억제 중인지 */
  isSuppressed: Readonly<Ref<boolean>>

  /** 카드 mouseenter 시 호출 */
  onCardEnter: (appointmentId: string, element: HTMLElement) => void
  /** 카드 mouseleave 시 호출 */
  onCardLeave: () => void
  /** quick action 버튼 영역 mouseenter 시 호출 (leave delay 취소) */
  onQuickActionEnter: () => void
  /** quick action 버튼 영역 mouseleave 시 호출 (leave 재개) */
  onQuickActionLeave: () => void

  /**
   * hover 해제 억제. popover/context menu가 열릴 때 호출.
   * 억제 중에는 onCardLeave가 hover를 해제하지 않는다.
   */
  suppress: () => void
  /**
   * hover 해제 억제 해제. popover/context menu가 닫힐 때 호출.
   * 마우스가 카드 위에 없으면 hover도 즉시 해제된다.
   */
  unsuppress: () => void

  /** 강제 hover 해제 (lock 전환, 외부 정리 등) */
  clearHover: () => void
}

// ═══════════════════════════════════════════════════════════
// Composable 본체
// ═══════════════════════════════════════════════════════════

export function useSchedulerHover(
  interactionLock: UseSchedulerInteractionLockReturn,
  config: Partial<HoverConfig> = {},
): UseSchedulerHoverReturn {

  const cfg: HoverConfig = { ...DEFAULT_CONFIG, ...config }

  // ── 상태 ──
  const _hoveredId = ref<string | null>(null)
  const _hoveredElement = ref<HTMLElement | null>(null)
  const _showQuickAction = ref(false)
  const _isSuppressed = ref(false)

  // ── 타이머 ──
  let _quickActionTimer: ReturnType<typeof setTimeout> | null = null
  let _leaveTimer: ReturnType<typeof setTimeout> | null = null

  // ── 마우스가 카드 위에 있는지 (suppress 해제 시 판정용) ──
  let _isMouseOverCard = false

  // ═══════════════════════════════════════════════════════════
  // 카드 진입/이탈
  // ═══════════════════════════════════════════════════════════

  function onCardEnter(appointmentId: string, element: HTMLElement): void {
    // lock 중이면 무시
    if (interactionLock.isLocked.value) return

    // leave timer가 있으면 취소 (빠른 카드 간 이동)
    clearLeaveTimer()

    _isMouseOverCard = true

    // 같은 카드 재진입이면 quick action만 복원
    if (_hoveredId.value === appointmentId) {
      startQuickActionTimer()
      return
    }

    // 새 카드 hover
    _hoveredId.value = appointmentId
    _hoveredElement.value = element
    _showQuickAction.value = false

    startQuickActionTimer()
  }

  function onCardLeave(): void {
    _isMouseOverCard = false

    // 억제 중이면 해제하지 않음
    if (_isSuppressed.value) return

    // grace period 후 해제
    clearLeaveTimer()
    _leaveTimer = setTimeout(() => {
      _leaveTimer = null
      clearHoverState()
    }, cfg.leaveGracePeriod)
  }

  // ═══════════════════════════════════════════════════════════
  // Quick Action 영역 진입/이탈
  // ═══════════════════════════════════════════════════════════

  function onQuickActionEnter(): void {
    // leave timer 취소 → hover 유지
    clearLeaveTimer()
  }

  function onQuickActionLeave(): void {
    // 카드 위에 있지 않으면 leave 시작
    if (!_isMouseOverCard) {
      onCardLeave()
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 억제(suppress)
  // ═══════════════════════════════════════════════════════════

  function suppress(): void {
    _isSuppressed.value = true
    clearLeaveTimer()
  }

  function unsuppress(): void {
    _isSuppressed.value = false

    // 마우스가 카드 위에 없으면 즉시 해제
    if (!_isMouseOverCard) {
      clearHoverState()
    }
  }

  // ═══════════════════════════════════════════════════════════
  // InteractionLock 연동
  // ═══════════════════════════════════════════════════════════

  const stopLockWatch = watch(interactionLock.isLocked, (locked) => {
    if (locked) {
      clearHover()
    }
  })

  // ═══════════════════════════════════════════════════════════
  // 정리
  // ═══════════════════════════════════════════════════════════

  function clearHover(): void {
    clearLeaveTimer()
    clearQuickActionTimer()
    _isSuppressed.value = false
    _isMouseOverCard = false
    clearHoverState()
  }

  function clearHoverState(): void {
    _hoveredId.value = null
    _hoveredElement.value = null
    _showQuickAction.value = false
    clearQuickActionTimer()
  }

  function startQuickActionTimer(): void {
    clearQuickActionTimer()
    _quickActionTimer = setTimeout(() => {
      _quickActionTimer = null
      if (_hoveredId.value) {
        _showQuickAction.value = true
      }
    }, cfg.quickActionDelay)
  }

  function clearQuickActionTimer(): void {
    if (_quickActionTimer !== null) {
      clearTimeout(_quickActionTimer)
      _quickActionTimer = null
    }
  }

  function clearLeaveTimer(): void {
    if (_leaveTimer !== null) {
      clearTimeout(_leaveTimer)
      _leaveTimer = null
    }
  }

  onBeforeUnmount(() => {
    stopLockWatch()
    clearLeaveTimer()
    clearQuickActionTimer()
  })

  return {
    hoveredId: readonly(_hoveredId),
    hoveredElement: readonly(_hoveredElement),
    showQuickAction: readonly(_showQuickAction),
    isSuppressed: readonly(_isSuppressed),
    onCardEnter,
    onCardLeave,
    onQuickActionEnter,
    onQuickActionLeave,
    suppress,
    unsuppress,
    clearHover,
  }
}
