/**
 * 스케줄러 인터랙션 잠금 Composable
 *
 * 책임:
 *   - 배타적 인터랙션 상태 관리 (한 번에 하나만 활성)
 *   - lock / unlock API 제공
 *   - 다른 composable이 현재 lock 상태를 reactive하게 조회
 *
 * 하지 않는 것:
 *   - 개별 인터랙션 로직 (drag, resize 등)
 *   - DOM 이벤트 처리
 *
 * 사용 패턴:
 *   drag 시작 시:
 *     const handle = lock('drag', { appointmentId })
 *     → 성공하면 LockHandle 반환, 실패하면 null
 *     drag 종료 시:
 *     handle.unlock()
 *
 *   hover composable:
 *     watch(isLocked, (locked) => { if (locked) hoveredId = null })
 *
 *   popover composable:
 *     watch(lockState, () => { if (lockState.value.type !== 'idle') close() })
 *
 *   context menu:
 *     onContextMenu: if (isLocked.value) return
 */

import { ref, computed, readonly, type Ref, type DeepReadonly } from 'vue'

// ═══════════════════════════════════════════════════════════
// 타입 정의
// ═══════════════════════════════════════════════════════════

export type InteractionType = 'idle' | 'drag' | 'resize' | 'create' | 'subcol-resize' | 'reschedule'

export interface InteractionLockState {
  type: InteractionType
  /** 대상 예약 ID (drag/resize 시) */
  appointmentId?: string
  /** 확장용 메타데이터 */
  meta?: Record<string, unknown>
}

/**
 * lock 성공 시 반환되는 핸들.
 * lock 소유자만 이 핸들을 통해 unlock할 수 있다.
 */
export interface LockHandle {
  /** 잠금 해제. 이미 해제되었거나 다른 소유자면 no-op. */
  unlock: () => void
  /** 메타데이터 업데이트 (lock 유지한 채 정보 변경) */
  updateMeta: (meta: Record<string, unknown>) => void
}

// ═══════════════════════════════════════════════════════════
// Return 타입
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerInteractionLockReturn {
  /** 현재 lock 상태 (readonly reactive) */
  lockState: DeepReadonly<Ref<InteractionLockState>>
  /** lock이 걸려 있는지 (type !== 'idle') */
  isLocked: Readonly<Ref<boolean>>
  /** 현재 lock 타입 */
  lockType: Readonly<Ref<InteractionType>>

  /**
   * lock 획득 시도.
   * 이미 다른 lock이 걸려 있으면 null 반환 (획득 실패).
   * idle 상태에서만 성공하며 LockHandle을 반환한다.
   */
  acquire: (
    type: Exclude<InteractionType, 'idle'>,
    options?: { appointmentId?: string; meta?: Record<string, unknown> }
  ) => LockHandle | null

  /** 특정 타입인지 확인하는 헬퍼 */
  isType: (type: InteractionType) => boolean

  /**
   * 강제 해제 (비상용).
   * 정상적으로는 LockHandle.unlock()을 사용해야 한다.
   * 예외 상황(blur, visibility change 등)에서만 사용.
   */
  forceUnlock: () => void
}

// ═══════════════════════════════════════════════════════════
// Idle 상수
// ═══════════════════════════════════════════════════════════

const IDLE_STATE: InteractionLockState = Object.freeze({ type: 'idle' as const })

// ═══════════════════════════════════════════════════════════
// Composable 본체
// ═══════════════════════════════════════════════════════════

export function useSchedulerInteractionLock(): UseSchedulerInteractionLockReturn {

  const _state = ref<InteractionLockState>({ ...IDLE_STATE })

  // lock 소유권 식별용 토큰. acquire마다 새 객체 생성.
  let _ownerToken: object | null = null

  // ── 파생 ──
  const isLocked = computed(() => _state.value.type !== 'idle')
  const lockType = computed(() => _state.value.type)

  // ── acquire ──
  function acquire(
    type: Exclude<InteractionType, 'idle'>,
    options?: { appointmentId?: string; meta?: Record<string, unknown> }
  ): LockHandle | null {
    // 이미 lock이 걸려 있으면 실패
    if (_state.value.type !== 'idle') return null

    const token = {}
    _ownerToken = token

    _state.value = {
      type,
      appointmentId: options?.appointmentId,
      meta: options?.meta,
    }

    return {
      unlock: () => {
        // 내 토큰이 아니면 no-op (이미 다른 lock으로 교체되었거나 해제됨)
        if (_ownerToken !== token) return
        _ownerToken = null
        _state.value = { ...IDLE_STATE }
      },
      updateMeta: (meta: Record<string, unknown>) => {
        if (_ownerToken !== token) return
        _state.value = { ..._state.value, meta }
      },
    }
  }

  // ── 헬퍼 ──
  function isType(type: InteractionType): boolean {
    return _state.value.type === type
  }

  function forceUnlock(): void {
    _ownerToken = null
    _state.value = { ...IDLE_STATE }
  }

  return {
    lockState: readonly(_state),
    isLocked: readonly(isLocked),
    lockType: readonly(lockType),
    acquire,
    isType,
    forceUnlock,
  }
}
