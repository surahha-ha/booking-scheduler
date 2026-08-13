/**
 * 스케줄러 Resize Composable
 *
 * 책임:
 *   - 예약 카드 resize(시간 늘리기/줄이기) 상태 머신 관리
 *   - top handle → startMinute 변경, bottom handle → endMinute 변경
 *   - hitTest(Y축만) + snap 기반 minute 계산
 *   - minDuration / maxDuration 제약 적용
 *   - resize 확정 시 콜백 발행
 *   - interactionLock 획득/해제
 *
 * 하지 않는 것:
 *   - DOM 이벤트 직접 바인딩 (handle 컴포넌트가 startResize 호출)
 *   - store 직접 수정 (onResize 콜백으로 위임)
 *   - column(날짜/리소스) 변경 (resize는 시간 축만)
 *
 * 핵심 정책:
 *   - top handle: endMinute 고정(anchor), startMinute만 변경
 *   - bottom handle: startMinute 고정(anchor), endMinute만 변경
 *   - duration은 minDuration 이상, maxDuration 이하
 *   - preview는 항상 같은 column 내에서만 표시
 */

import { ref, readonly, type Ref, type DeepReadonly } from 'vue'
import { hitTest, minuteToBandTopPx, minuteRangeToBandHeight, isValidMinute } from '@/scheduler-engine/schedulerHitTest'
import { snapMinute, DEFAULT_SNAP_CONFIG } from '@/scheduler-engine/schedulerSnapGrid'
import type {
  FlatColumn,
  BandCompatible,
  ResizeState,
  ResizeDirection,
  AppointmentRect,
  SnapConfig,
} from '@/scheduler-engine/types/scheduler.types'
import type { UseSchedulerInteractionLockReturn, LockHandle } from './useSchedulerInteractionLock'

/** auto scroll 핸들 — 구 useSchedulerAutoScroll(MR-Swap 으로 제거)의 옵셔널 인터페이스만 로컬 보존.
 *  V3 는 autoScroll 을 넘기지 않아 `autoScroll?.` 호출이 no-op 이다. */
interface AutoScrollHandle {
  update(_clientX: number, _clientY: number): void
  setOnTick(_cb: ((_clientX: number, _clientY: number) => void) | null): void
  stop(): void
}

// ═══════════════════════════════════════════════════════════
// 타입 정의
// ═══════════════════════════════════════════════════════════

/** resize 시작에 필요한 예약 정보 */
export interface ResizeStartInfo {
  appointmentId: string
  columnKey: string
  startMinute: number
  endMinute: number
  direction: ResizeDirection
  /** 기존 배치 rect (preview 초기값) */
  rect: AppointmentRect
}

/** resize 확정 시 전달되는 결과 */
export interface ResizeResult {
  appointmentId: string
  columnKey: string
  newStartMinute: number
  newEndMinute: number
}

/** 유효성 검증 함수 타입 */
export type ResizeValidateFn = (
  _appointmentId: string,
  _columnKey: string,
  _startMinute: number,
  _endMinute: number,
) => { isValid: boolean; reason?: string }

// ═══════════════════════════════════════════════════════════
// 입력 옵션
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerResizeOptions {
  /** body 스크롤 컨테이너 (좌표 변환용) */
  bodyEl: Ref<HTMLElement | null>
  /** 현재 column 배열 (preview rect의 left/width 참조) */
  columns: Ref<FlatColumn[]>
  /** 현재 bandInfos (hitTest + preview 계산) */
  bandInfos: Ref<BandCompatible[]>
  /** interactionLock composable */
  interactionLock: UseSchedulerInteractionLockReturn
  /** auto scroll 핸들 (미제공 시 auto scroll 비활성 — V3 는 미제공) */
  autoScroll?: AutoScrollHandle
  /** snap 설정 (미제공 시 기본값) */
  snapConfig?: SnapConfig
  /** 최소 예약 시간 (분, 기본 10) */
  minDuration?: number
  /** 최대 예약 시간 (분, 기본 480 = 8시간) */
  maxDuration?: number
  /** 유효성 검증 (미제공 시 항상 valid) */
  validate?: ResizeValidateFn
  /** resize 확정 콜백 */
  onResize: (_result: ResizeResult) => void
}

// ═══════════════════════════════════════════════════════════
// Return 타입
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerResizeReturn {
  /** 현재 resize 상태 (null이면 idle) */
  resizeState: DeepReadonly<Ref<ResizeState | null>>
  /** resize 진행 중 여부 */
  isResizing: Readonly<Ref<boolean>>
  /**
   * resize 시작. handle 컴포넌트의 mousedown에서 호출.
   * lock 획득 실패 시 false 반환.
   */
  startResize: (_e: MouseEvent, _info: ResizeStartInfo) => boolean
  /** resize 강제 취소 (ESC 등) */
  cancelResize: () => void
}

// ═══════════════════════════════════════════════════════════
// Composable 본체
// ═══════════════════════════════════════════════════════════

export function useSchedulerResize(
  options: UseSchedulerResizeOptions
): UseSchedulerResizeReturn {

  const {
    bodyEl,
    bandInfos,
    interactionLock,
    autoScroll,
    snapConfig = DEFAULT_SNAP_CONFIG,
    minDuration = 10,
    maxDuration = 480,
    validate,
    onResize,
  } = options

  // ── 상태 ──
  const _resizeState = ref<ResizeState | null>(null)
  const _isResizing = ref(false)

  // ── 내부 변수 ──
  let _lockHandle: LockHandle | null = null
  let _anchorMinute = 0     // 고정 끝 minute
  let _columnKey = ''        // resize 대상 column (불변)
  let _isFineSnap = false

  // ═══════════════════════════════════════════════════════════
  // 좌표 변환
  // ═══════════════════════════════════════════════════════════

  function clientToBodyLocalY(clientY: number): number | null {
    const body = bodyEl.value
    if (!body) return null
    const rect = body.getBoundingClientRect()
    return clientY - rect.top + body.scrollTop
  }

  // ═══════════════════════════════════════════════════════════
  // Resize Start
  // ═══════════════════════════════════════════════════════════

  function startResize(e: MouseEvent, info: ResizeStartInfo): boolean {
    const handle = interactionLock.acquire('resize', {
      appointmentId: info.appointmentId,
      meta: { direction: info.direction },
    })
    if (!handle) return false

    _lockHandle = handle
    _columnKey = info.columnKey
    _isFineSnap = e.shiftKey
    document.body.classList.add('is-resizing-active')

    // anchor: 고정 끝
    _anchorMinute = info.direction === 'top'
      ? info.endMinute    // top handle → end 고정
      : info.startMinute  // bottom handle → start 고정

    _resizeState.value = {
      appointmentId: info.appointmentId,
      direction: info.direction,
      columnKey: info.columnKey,
      originStartMinute: info.startMinute,
      originEndMinute: info.endMinute,
      currentStartMinute: info.startMinute,
      currentEndMinute: info.endMinute,
      previewRect: { ...info.rect },
      isValid: true,
      invalidReason: undefined,
      minDuration,
      maxDuration,
      isNoChange: true, // 시작 직후엔 origin과 동일
    }

    _isResizing.value = true

    // auto scroll tick 콜백 등록 (scroll 중 preview 재계산, Y만 사용)
    autoScroll?.setOnTick((_lastClientX, lastClientY) => {
      updatePreviewFromClientY(lastClientY)
    })

    document.addEventListener('mousemove', onResizeMove)
    document.addEventListener('mouseup', onResizeEnd)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)

    // mousedown이 drag로 전파되지 않도록
    e.stopPropagation()
    e.preventDefault()

    return true
  }

  // ═══════════════════════════════════════════════════════════
  // Preview 재계산 (mousemove + auto scroll tick 공용)
  // ═══════════════════════════════════════════════════════════

  /**
   * clientY 기준으로 hitTest(Y) → snap → validate → preview 업데이트.
   * onResizeMove와 autoScroll onTick 양쪽에서 호출된다.
   */
  function updatePreviewFromClientY(clientY: number): void {
    if (!_resizeState.value) return

    const bodyY = clientToBodyLocalY(clientY)
    if (bodyY === null) return

    // resize는 Y축만 사용 — hitTest에 columns 빈 배열, subColIndex 불변
    const hit = hitTest({
      mouseX: 0,
      mouseY: bodyY,
      columns: [],
      bandInfos: bandInfos.value,
    })

    if (!isValidMinute(hit.minute)) return

    const snappedMinute = snapMinute(hit.minute, snapConfig, _isFineSnap)
    const direction = _resizeState.value.direction

    let newStart: number
    let newEnd: number

    if (direction === 'top') {
      newStart = Math.min(snappedMinute, _anchorMinute - minDuration)
      newEnd = _anchorMinute
    } else {
      newStart = _anchorMinute
      newEnd = Math.max(snappedMinute, _anchorMinute + minDuration)
    }

    const duration = newEnd - newStart
    if (duration < minDuration) {
      if (direction === 'top') {
        newStart = newEnd - minDuration
      } else {
        newEnd = newStart + minDuration
      }
    }
    if (duration > maxDuration) {
      if (direction === 'top') {
        newStart = newEnd - maxDuration
      } else {
        newEnd = newStart + maxDuration
      }
    }

    let isValid = true
    let invalidReason: string | undefined

    if (validate) {
      const result = validate(
        _resizeState.value.appointmentId,
        _columnKey,
        newStart,
        newEnd,
      )
      isValid = result.isValid
      invalidReason = result.reason
    }

    const topPx = minuteToBandTopPx(newStart, bandInfos.value)
    const heightPx = minuteRangeToBandHeight(newStart, newEnd, bandInfos.value)

    // subColIndex / rowIndex / zIndex / left / width는 spread로 기존 값 유지
    // resize는 column/sub-column 변경 없이 시간만 변경
    const previewRect: AppointmentRect = {
      ..._resizeState.value.previewRect,
      top: topPx,
      height: heightPx,
      // left/width는 기존 카드 값 유지 (sub-column 폭)
    }

    // origin과 동일 시간 = 데이터 변경 없음 → preview 회색 표기 (drag와 동일 정책)
    const isNoChange =
      newStart === _resizeState.value.originStartMinute &&
      newEnd === _resizeState.value.originEndMinute

    _resizeState.value = {
      ..._resizeState.value,
      currentStartMinute: newStart,
      currentEndMinute: newEnd,
      previewRect,
      isValid,
      invalidReason,
      isNoChange,
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Resize Move
  // ═══════════════════════════════════════════════════════════

  function onResizeMove(e: MouseEvent): void {
    if (!_resizeState.value) return

    _isFineSnap = e.shiftKey
    updatePreviewFromClientY(e.clientY)

    // auto scroll: edge zone 감지 (세로만)
    autoScroll?.update(e.clientX, e.clientY)
  }

  // ═══════════════════════════════════════════════════════════
  // Resize End
  // ═══════════════════════════════════════════════════════════

  function onResizeEnd(_e: MouseEvent): void {
    const state = _resizeState.value
    if (!state) {
      cleanup()
      return
    }

    if (state.isValid && hasTimeChanged(state)) {
      onResize({
        appointmentId: state.appointmentId,
        columnKey: state.columnKey,
        newStartMinute: state.currentStartMinute,
        newEndMinute: state.currentEndMinute,
      })
    }

    cleanup()
  }

  // ═══════════════════════════════════════════════════════════
  // Cancel / Cleanup
  // ═══════════════════════════════════════════════════════════

  function cancelResize(): void {
    cleanup()
  }

  function cleanup(): void {
    document.body.classList.remove('is-resizing-active')
    document.removeEventListener('mousemove', onResizeMove)
    document.removeEventListener('mouseup', onResizeEnd)
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)

    _resizeState.value = null
    _isResizing.value = false
    _anchorMinute = 0
    _columnKey = ''
    _isFineSnap = false

    // auto scroll 중단 + 콜백 해제
    autoScroll?.stop()
    autoScroll?.setOnTick(null)

    _lockHandle?.unlock()
    _lockHandle = null
  }

  // ═══════════════════════════════════════════════════════════
  // 키보드 처리
  // ═══════════════════════════════════════════════════════════

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') cancelResize()
    if (e.key === 'Shift') _isFineSnap = true
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') _isFineSnap = false
  }

  // ═══════════════════════════════════════════════════════════
  // 유틸
  // ═══════════════════════════════════════════════════════════

  function hasTimeChanged(state: ResizeState): boolean {
    return (
      state.currentStartMinute !== state.originStartMinute ||
      state.currentEndMinute !== state.originEndMinute
    )
  }

  return {
    resizeState: readonly(_resizeState),
    isResizing: readonly(_isResizing),
    startResize,
    cancelResize,
  }
}
