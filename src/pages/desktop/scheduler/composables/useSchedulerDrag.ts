/**
 * 스케줄러 Drag Composable
 *
 * 책임:
 *   - 예약 카드 drag 이동의 상태 머신 관리
 *   - mousedown → mousemove → mouseup 전체 흐름
 *   - hitTest + snap 기반 preview 위치 계산
 *   - drop 확정 시 콜백 발행
 *   - interactionLock 획득/해제
 *
 * 하지 않는 것:
 *   - DOM 이벤트 직접 바인딩 (card 컴포넌트가 startDrag 호출)
 *   - store 직접 수정 (onDrop 콜백으로 위임)
 *   - auto scroll 루프 관리 (useSchedulerAutoScroll에 위임)
 *
 * 좌표 변환 흐름:
 *   clientXY → bodyLocalXY (scroll offset 포함) → hitTest → snapMinute → preview
 *
 * drag 중 불변:
 *   - duration (endMinute - startMinute)
 *   - appointmentId
 *
 * drag 중 가변:
 *   - 대상 column (날짜 + 리소스)
 *   - startMinute (snap 적용)
 */

import { ref, readonly, type Ref, type DeepReadonly } from 'vue'
import { hitTest, minuteToBandTopPx, isValidMinute } from '@/scheduler-engine/schedulerHitTest'
import { snapMinute, DEFAULT_SNAP_CONFIG } from '@/scheduler-engine/schedulerSnapGrid'
import type {
  FlatColumn,
  BandCompatible,
  DragState,
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

/** drag 시작에 필요한 예약 정보 */
export interface DragStartInfo {
  appointmentId: string
  columnKey: string
  startMinute: number
  endMinute: number
  /** 기존 배치 rect (preview 초기값 + grabOffset 계산) */
  rect: AppointmentRect
}

/** drop 확정 시 전달되는 결과 */
export interface DragDropResult {
  appointmentId: string
  fromColumnKey: string
  toColumnKey: string
  toDate: string
  toResourceId: string
  newStartMinute: number
  newEndMinute: number
  /** drop된 sub-column index */
  toSubColIndex: number
}

/** 유효성 검증 함수 타입 */
export type DragValidateFn = (
  _appointmentId: string,
  _targetColumnKey: string,
  _targetDate: string,
  _targetResourceId: string,
  _startMinute: number,
  _endMinute: number,
) => { isValid: boolean; reason?: string }

// ═══════════════════════════════════════════════════════════
// 입력 옵션
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerDragOptions {
  /** body 스크롤 컨테이너 (좌표 변환용) */
  bodyEl: Ref<HTMLElement | null>
  /** 현재 column 배열 (hitTest 입력) */
  columns: Ref<FlatColumn[]>
  /** 현재 bandInfos (hitTest + preview 계산) */
  bandInfos: Ref<BandCompatible[]>
  /** N칸 보기 */
  patientSlotSpan?: Ref<number> | number
  /** interactionLock composable */
  interactionLock: UseSchedulerInteractionLockReturn
  /** auto scroll 핸들 (미제공 시 auto scroll 비활성 — V3 는 미제공) */
  autoScroll?: AutoScrollHandle
  /** snap 설정 (미제공 시 기본값) */
  snapConfig?: SnapConfig
  /** 유효성 검증 (미제공 시 항상 valid) */
  validate?: DragValidateFn
  /** drop 확정 콜백 */
  onDrop: (_result: DragDropResult) => void
  /** threshold 미달 시 클릭 콜백 (edit/detail) */
  onClick?: (_appointmentId: string) => void
}

// ═══════════════════════════════════════════════════════════
// Return 타입
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerDragReturn {
  /** 현재 drag 상태 (null이면 idle) */
  dragState: DeepReadonly<Ref<DragState | null>>
  /** drag 진행 중 여부 */
  isDragging: Readonly<Ref<boolean>>
  /**
   * drag 시작. card 컴포넌트의 mousedown에서 호출.
   * lock 획득 실패 시 false 반환.
   */
  startDrag: (_e: MouseEvent, _info: DragStartInfo) => boolean
  /** drag 강제 취소 (ESC 등) */
  cancelDrag: () => void
}

// ═══════════════════════════════════════════════════════════
// Composable 본체
// ═══════════════════════════════════════════════════════════

export function useSchedulerDrag(
  options: UseSchedulerDragOptions
): UseSchedulerDragReturn {

  const {
    bodyEl,
    columns,
    bandInfos,
    patientSlotSpan: _slotSpanOpt,
    interactionLock,
    autoScroll,
    snapConfig = DEFAULT_SNAP_CONFIG,
    validate,
    onDrop,
    onClick,
  } = options

  function getN(): number {
    if (!_slotSpanOpt) return 1
    return typeof _slotSpanOpt === 'number' ? _slotSpanOpt : _slotSpanOpt.value
  }

  // ── 상태 ──
  const _dragState = ref<DragState | null>(null)
  const _isDragging = ref(false)

  // ── 내부 변수 (reactive 불필요) ──
  let _lockHandle: LockHandle | null = null
  let _duration = 0         // 불변: endMinute - startMinute
  let _grabOffsetX = 0      // 카드 내 클릭 X offset (px)
  let _grabOffsetY = 0      // 카드 내 클릭 Y offset (px)
  let _isFineSnap = false   // Shift 키 상태

  // ── drag 시작 threshold (클릭 vs drag 구분) ──
  const DRAG_THRESHOLD = 5   // px
  let _pendingDrag = false    // threshold 대기 중
  let _startClientX = 0
  let _startClientY = 0
  let _pendingInfo: DragStartInfo | null = null

  // ═══════════════════════════════════════════════════════════
  // 좌표 변환
  // ═══════════════════════════════════════════════════════════

  /**
   * client 좌표 → body 내부 절대 좌표 (scroll offset 포함)
   */
  function clientToBodyLocal(clientX: number, clientY: number): { x: number; y: number } | null {
    const body = bodyEl.value
    if (!body) return null
    const rect = body.getBoundingClientRect()
    return {
      x: clientX - rect.left + body.scrollLeft,
      y: clientY - rect.top + body.scrollTop,
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Drag Start
  // ═══════════════════════════════════════════════════════════

  function startDrag(e: MouseEvent, info: DragStartInfo): boolean {
    // threshold 대기: mousedown 시점에서는 drag를 시작하지 않음
    // 5px 이상 이동 시에만 실제 drag 진입
    _startClientX = e.clientX
    _startClientY = e.clientY
    _pendingInfo = info
    _pendingDrag = true
    // grabOffset: 카드 내 클릭 위치 (미리 계산)
    const cardRect = (e.currentTarget as HTMLElement)?.getBoundingClientRect()
    if (cardRect) {
      _grabOffsetX = e.clientX - cardRect.left
      _grabOffsetY = e.clientY - cardRect.top
    } else {
      _grabOffsetX = 0
      _grabOffsetY = 0
    }

    _isFineSnap = e.shiftKey

    // document 리스너 등록 (threshold 판정용)
    document.addEventListener('mousemove', onDragMove)
    document.addEventListener('mouseup', onDragEnd)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)

    return true
  }

  // ═══════════════════════════════════════════════════════════
  // Preview 재계산 (mousemove + auto scroll tick 공용)
  // ═══════════════════════════════════════════════════════════

  /**
   * client 좌표 기준으로 hitTest → snap → validate → preview 업데이트.
   * onDragMove와 autoScroll onTick 양쪽에서 호출된다.
   */
  function updatePreviewFromClient(clientX: number, clientY: number): void {
    if (!_dragState.value) return

    // hitTest는 마우스 원래 좌표 기준 (grabOffset 적용 안 함)
    // preview left/top은 hit 결과의 column/band 기준으로 계산
    const local = clientToBodyLocal(clientX, clientY)
    if (!local) return

    const N = getN()
    const hit = hitTest({
      mouseX: local.x,
      mouseY: local.y,
      columns: columns.value,
      bandInfos: bandInfos.value,
      patientSlotSpan: N,
    })

    if (!hit.columnKey || !isValidMinute(hit.minute)) return

    const snappedStart = snapMinute(hit.minute, snapConfig, _isFineSnap)
    const snappedEnd = snappedStart + _duration

    let isValid = true
    let invalidReason: string | undefined

    // blocked 판단은 validate에서 처리 (bandInfo에 blocked 없음)
    if (validate && hit.date && hit.resourceId) {
      const result = validate(
        _dragState.value.appointmentId,
        hit.columnKey,
        hit.date,
        hit.resourceId,
        snappedStart,
        snappedEnd,
      )
      isValid = result.isValid
      invalidReason = result.reason
    }

    const column = hit.column!
    const subColWidth = column.widthPx / N
    const topPx = minuteToBandTopPx(snappedStart, bandInfos.value)
    const originalHeight = _dragState.value.previewRect.height

    const previewRect: AppointmentRect = {
      ..._dragState.value.previewRect,
      columnKey: hit.columnKey,
      top: topPx,
      left: column.leftPx + hit.subColIndex * subColWidth,
      width: subColWidth,
      height: originalHeight,
      subColIndex: hit.subColIndex,
    }

    // 같은 column + 같은 시간 = 데이터 변경 없음 → isNoChange 플래그
    const isNoChange =
      hit.columnKey === _dragState.value.originColumnKey &&
      snappedStart === _dragState.value.originStartMinute

    _dragState.value = {
      ..._dragState.value,
      currentColumnKey: hit.columnKey,
      currentStartMinute: snappedStart,
      previewRect,
      isValid,
      invalidReason,
      isNoChange,
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Drag Move
  // ═══════════════════════════════════════════════════════════

  function onDragMove(e: MouseEvent): void {
    _isFineSnap = e.shiftKey

    // ── threshold 대기 중: 5px 이동 여부 판정 ──
    if (_pendingDrag) {
      const dx = e.clientX - _startClientX
      const dy = e.clientY - _startClientY
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return

      // threshold 초과 → 실제 drag 진입
      const commitOk = commitDragStart()
      if (!commitOk) {
        cleanup()
        return
      }
      _pendingDrag = false
    }

    if (!_dragState.value) return

    updatePreviewFromClient(e.clientX, e.clientY)
    autoScroll?.update(e.clientX, e.clientY)
  }

  /**
   * threshold 초과 후 실제 drag 상태를 초기화한다.
   * lock 획득 실패 시 false 반환.
   */
  function commitDragStart(): boolean {
    const info = _pendingInfo
    if (!info) return false

    const handle = interactionLock.acquire('drag', {
      appointmentId: info.appointmentId,
    })
    if (!handle) return false

    _lockHandle = handle
    _duration = info.endMinute - info.startMinute
    document.body.classList.add('is-dragging-active')

    _dragState.value = {
      appointmentId: info.appointmentId,
      originColumnKey: info.columnKey,
      originStartMinute: info.startMinute,
      originEndMinute: info.endMinute,
      currentColumnKey: info.columnKey,
      currentStartMinute: info.startMinute,
      offsetX: _grabOffsetX,
      offsetY: _grabOffsetY,
      previewRect: { ...info.rect },
      isValid: true,
      invalidReason: undefined,
    }

    _isDragging.value = true

    autoScroll?.setOnTick((lastClientX, lastClientY) => {
      updatePreviewFromClient(lastClientX, lastClientY)
    })

    return true
  }

  // ═══════════════════════════════════════════════════════════
  // Drag End
  // ═══════════════════════════════════════════════════════════

  function onDragEnd(_e: MouseEvent): void {
    // threshold 미달 (클릭) → drag 없이 종료, onClick 콜백 발행
    if (_pendingDrag) {
      const id = _pendingInfo?.appointmentId
      cleanup()
      if (id && onClick) onClick(id)
      return
    }
    const state = _dragState.value
    if (!state) {
      cleanup()
      return
    }

    // 유효한 drop이고 위치가 실제로 변경되었을 때만 콜백 발행
    if (state.isValid && hasPositionChanged(state)) {
      const targetColumn = columns.value.find(c => c.key === state.currentColumnKey)

      if (targetColumn) {
        onDrop({
          appointmentId: state.appointmentId,
          fromColumnKey: state.originColumnKey,
          toColumnKey: state.currentColumnKey,
          toDate: targetColumn.date,
          toResourceId: targetColumn.resourceId,
          newStartMinute: state.currentStartMinute,
          newEndMinute: state.currentStartMinute + _duration,
          toSubColIndex: state.previewRect.subColIndex ?? 0,
        })
      }
    }

    cleanup()
  }

  // ═══════════════════════════════════════════════════════════
  // Cancel / Cleanup
  // ═══════════════════════════════════════════════════════════

  function cancelDrag(): void {
    cleanup()
  }

  function cleanup(): void {
    document.body.classList.remove('is-dragging-active')
    // document 리스너 해제
    document.removeEventListener('mousemove', onDragMove)
    document.removeEventListener('mouseup', onDragEnd)
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)

    // 상태 초기화
    _dragState.value = null
    _isDragging.value = false
    _duration = 0
    _grabOffsetX = 0
    _grabOffsetY = 0
    _isFineSnap = false
    _pendingDrag = false
    _pendingInfo = null
    _startClientX = 0
    _startClientY = 0

    // auto scroll 중단 + 콜백 해제
    autoScroll?.stop()
    autoScroll?.setOnTick(null)

    // lock 해제
    _lockHandle?.unlock()
    _lockHandle = null
  }

  // ═══════════════════════════════════════════════════════════
  // 키보드 처리
  // ═══════════════════════════════════════════════════════════

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      cancelDrag()
    }
    if (e.key === 'Shift') {
      _isFineSnap = true
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') {
      _isFineSnap = false
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 유틸
  // ═══════════════════════════════════════════════════════════

  function hasPositionChanged(state: DragState): boolean {
    return (
      state.currentColumnKey !== state.originColumnKey ||
      state.currentStartMinute !== state.originStartMinute
    )
  }

  return {
    dragState: readonly(_dragState),
    isDragging: readonly(_isDragging),
    startDrag,
    cancelDrag,
  }
}
