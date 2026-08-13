/**
 * Sub-Column Resize Composable
 *
 * 책임:
 *   - column 내부 sub-column 사이의 세로 구분선(handle)을 mousedown → mousemove → mouseup
 *     하는 상태 머신 관리
 *   - mousemove 누적 dx가 threshold(subColWidth × 0.4) 초과 시 N 값 ±1 변경 콜백 발화
 *   - 좌측 drag(=dx 음수): N-1 (칸 감소)
 *   - 우측 drag(=dx 양수): N+1 (칸 증가)
 *   - interactionLock('subcol-resize') 획득/해제
 *
 * 하지 않는 것:
 *   - DOM 이벤트 직접 바인딩 (handle 컴포넌트가 startSubColResize 호출)
 *   - patientSlotSpan 직접 변경 (onChange 콜백으로 부모에 위임)
 *   - 1step 변경 후 즉시 종료. 한 drag 세션에서 여러 step은 누적 dx 기준 다단계 변경 가능
 *
 * 핵심 정책:
 *   - 한 drag 세션에서 patientSlotSpan은 1~4 범위 내에서만 변경
 *   - 매 step(=threshold 단위) 마다 baseN 갱신 후 다음 step 측정
 *   - mouseup으로 최종 N 확정
 */

import { ref, readonly, type Ref, type DeepReadonly } from 'vue'
import type {
  UseSchedulerInteractionLockReturn,
  LockHandle,
} from './useSchedulerInteractionLock'

// ═══════════════════════════════════════════════════════════
// 타입 정의
// ═══════════════════════════════════════════════════════════

export interface SubColResizeStartInfo {
  /** column 폭 (px) — N 분할 전 column 전체 폭 */
  columnWidthPx: number
  /** 현재 N (1~4) */
  currentN: number
  /** 조절 대상 컬럼 key (per-column 모드, V3). 미전달 시 전역 모드(V2). */
  columnKey?: string
}

export interface SubColResizeState {
  /** drag 시작 시점 N */
  baseN: number
  /** 현재 적용된 N (drag 중 변경 가능) */
  currentN: number
  /** column 폭 */
  columnWidthPx: number
  /** drag 시작 시점 client X */
  startClientX: number
  /** 조절 대상 컬럼 key (per-column 모드). 전역 모드면 undefined. */
  columnKey?: string
}

/** newN 변경 콜백. columnKey 전달 시 per-column(V3), 미전달 시 전역(V2). */
export type SubColResizeChangeFn = (_newN: number, _columnKey?: string) => void

export interface UseSubColResizeOptions {
  interactionLock: UseSchedulerInteractionLockReturn
  /** N 변경 시 콜백 (부모가 patientSlotSpan 갱신) */
  onChange: SubColResizeChangeFn
  /** N 최소값 (기본 1) */
  minN?: number
  /** N 최대값 (기본 4) */
  maxN?: number
  /** N 1step 변경에 필요한 dx 비율 (subColWidth 대비, 기본 0.4) */
  thresholdRatio?: number
}

export interface UseSubColResizeReturn {
  state: DeepReadonly<Ref<SubColResizeState | null>>
  isResizing: Readonly<Ref<boolean>>
  /** handle mousedown 시 호출 */
  startSubColResize: (_e: MouseEvent, _info: SubColResizeStartInfo) => boolean
  /** ESC 등 강제 취소 */
  cancelSubColResize: () => void
}

// ═══════════════════════════════════════════════════════════
// Composable
// ═══════════════════════════════════════════════════════════

export function useSubColResize(
  options: UseSubColResizeOptions,
): UseSubColResizeReturn {
  const {
    interactionLock,
    onChange,
    minN = 1,
    maxN = 4,
    thresholdRatio = 0.4,
  } = options

  const _state = ref<SubColResizeState | null>(null)
  const _isResizing = ref(false)
  let _lockHandle: LockHandle | null = null
  /** 마지막 step 적용 시점의 누적 dx 기준 */
  let _stepBaseClientX = 0

  function startSubColResize(e: MouseEvent, info: SubColResizeStartInfo): boolean {
    if (e.button !== 0) return false
    if (interactionLock.isLocked.value) return false

    const handle = interactionLock.acquire('subcol-resize', {})
    if (!handle) return false
    _lockHandle = handle

    e.preventDefault()
    e.stopPropagation()

    _state.value = {
      baseN: info.currentN,
      currentN: info.currentN,
      columnWidthPx: info.columnWidthPx,
      startClientX: e.clientX,
      columnKey: info.columnKey,
    }
    _isResizing.value = true
    _stepBaseClientX = e.clientX

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keydown', onKey)
    document.body.classList.add('is-subcol-resizing-active')
    return true
  }

  function onMove(e: MouseEvent): void {
    const s = _state.value
    if (!s) return
    const subColWidth = s.columnWidthPx / Math.max(1, s.currentN)
    const threshold = subColWidth * thresholdRatio
    const dx = e.clientX - _stepBaseClientX

    // 좌 drag (dx < 0) → N-1(칸 감소), 우 drag (dx > 0) → N+1(칸 증가)
    if (dx <= -threshold && s.currentN > minN) {
      const newN = s.currentN - 1
      _state.value = { ...s, currentN: newN }
      _stepBaseClientX = e.clientX
      onChange(newN, s.columnKey)
    } else if (dx >= threshold && s.currentN < maxN) {
      const newN = s.currentN + 1
      _state.value = { ...s, currentN: newN }
      _stepBaseClientX = e.clientX
      onChange(newN, s.columnKey)
    }
  }

  function onUp(_e: MouseEvent): void {
    cleanup()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') cancelSubColResize()
  }

  function cancelSubColResize(): void {
    cleanup()
  }

  function cleanup(): void {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.removeEventListener('keydown', onKey)
    document.body.classList.remove('is-subcol-resizing-active')
    _state.value = null
    _isResizing.value = false
    if (_lockHandle) {
      _lockHandle.unlock()
      _lockHandle = null
    }
    _stepBaseClientX = 0
  }

  return {
    state: readonly(_state) as DeepReadonly<Ref<SubColResizeState | null>>,
    isResizing: readonly(_isResizing),
    startSubColResize,
    cancelSubColResize,
  }
}
