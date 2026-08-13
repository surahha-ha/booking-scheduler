/**
 * 커스텀 병원 스케줄러 - 핵심 타입 정의
 *
 * 이 파일은 스케줄러 엔진의 모든 타입을 정의한다.
 * Layout 엔진, Interaction Layer, Composable 전체에서 공유된다.
 */

// ═══════════════════════════════════════════════════════════
// 모드 및 상수
// ═══════════════════════════════════════════════════════════

/** 가로 레이아웃 전략 */
export type WidthMode = 'fixed-viewport' | 'dynamic-scroll'

/** 뷰 모드 */
export type ViewMode = 'day' | 'week'

/** 예약 카드 표시 밀도 등급 */
export type DisplayTier = 'full' | 'standard' | 'compact' | 'minimal'

/** 그룹 레벨 타입 */
export type GroupLevel = 'date' | 'doctorGroup' | 'doctor' | 'chair'

// ═══════════════════════════════════════════════════════════
// 줌 시스템
// ═══════════════════════════════════════════════════════════

/** 줌 단계 정의 (고정 테이블의 한 항목) */
export interface ZoomStep {
  level: number
  widthMultiplier: number
  displayTier: DisplayTier
}

/**
 * 줌 단계 매핑 테이블
 * level 1 = 최대 확대 (왼쪽), level 5 = 최대 축소 (오른쪽)
 */
export const ZOOM_STEPS: readonly ZoomStep[] = [
  { level: 1, widthMultiplier: 1.6, displayTier: 'full' },
  { level: 2, widthMultiplier: 1.3, displayTier: 'standard' },
  { level: 3, widthMultiplier: 1.0, displayTier: 'standard' },
  { level: 4, widthMultiplier: 0.8, displayTier: 'compact' },
  { level: 5, widthMultiplier: 0.6, displayTier: 'minimal' },
] as const

/** 스케줄러 핵심 상태 - 레이아웃 계산의 유일한 입력 */
export interface SchedulerZoomState {
  /** 예약 1건이 차지하는 슬롯 수 (1~5). "칸 보기" UI로 조절 */
  patientSlotSpan: number
  /** 단계형 확대 레벨 (1~5). 슬라이더 UI로 조절 */
  zoomLevel: number
  /** 가로 레이아웃 전략 */
  widthMode: WidthMode
}

// ═══════════════════════════════════════════════════════════
// 레이아웃 엔진
// ═══════════════════════════════════════════════════════════

/** 레이아웃 계산 입력 */
export interface LayoutInput {
  zoom: SchedulerZoomState
  /** 슬롯 1칸 기본 px (상수, 예: 120) */
  baseSlotWidth: number
  /** 뷰포트 가용 폭 (timeAxis 제외) */
  availableWidth: number
  /** 조회 기간의 총 날짜 수 */
  dayCount: number
  /** 하루당 leaf 컬럼 수 (필터된 의사 수 등) */
  leafColumnCountPerDay: number
}

/** 레이아웃 계산 결과 */
export interface LayoutResult {
  /** 예약 1건의 px 폭 (정방향 계산만, 역산 없음) */
  slotWidth: number
  /** 하루 전체 px 폭 */
  dayColumnWidth: number
  /** 뷰포트에 보이는 날짜 수 (계산 결과) */
  visibleDayCount: number
  /** 전체 콘텐츠 가로폭 */
  totalContentWidth: number
  /** 가로 스크롤 필요 여부 */
  needHorizontalScroll: boolean
  /** 현재 줌의 카드 표시 등급 */
  displayTier: DisplayTier
}

// ═══════════════════════════════════════════════════════════
// 리소스 (의사, 체어 등)
// ═══════════════════════════════════════════════════════════

/** 의사 */
export interface DoctorResource {
  id: string
  name: string
  groupId?: string
  groupName?: string
}

/** 체어 */
export interface ChairResource {
  id: string
  name: string
  doctorId?: string
}

/** 리소스 맵 (header/column builder 입력용) */
export interface ResourceMap {
  doctors: DoctorResource[]
  chairs?: ChairResource[]
  doctorGroups?: { id: string; name: string; doctorIds: string[] }[]
}

// ═══════════════════════════════════════════════════════════
// 헤더 트리
// ═══════════════════════════════════════════════════════════

/** 그룹 구조 설정 */
export interface GroupingConfig {
  levels: GroupLevel[]
}

/** 헤더 트리 노드 (n-depth 재귀) */
export interface HeaderNode {
  key: string
  label: string
  /** leaf 기준 span 수 */
  colSpan: number
  depth: number
  type: GroupLevel
  children?: HeaderNode[]
  /**
   * leaf 노드에만 존재하는 메타데이터.
   * column builder가 key 파싱 없이 date/resourceId를 직접 참조할 수 있도록 한다.
   * children이 있는 중간 노드에서는 undefined.
   */
  leafMeta?: HeaderLeafMeta
  /**
   * 날짜(date) 노드 전용 — 공휴일 휴무 라벨('휴무'). 날짜 행에 빨간색으로 표기.
   * 공휴일이면서 '공휴일 휴무' 설정(holidayClosedYn)이 켜진 날에만 채워진다 — 공휴일에도 진료하는 병원이 있다.
   */
  holidayLabel?: string
  /** 의사(doctor) 노드 전용 — 비공개(openYn='N') 담당자(#1). true 면 '비공개' 뱃지 표기. */
  isPrivate?: boolean
}

/** leaf 노드 전용 메타데이터 */
export interface HeaderLeafMeta {
  date: string
  resourceId: string
  resourceLabel: string
}

// ═══════════════════════════════════════════════════════════
// 컬럼 (Flat, Leaf)
// ═══════════════════════════════════════════════════════════

/** 그룹 경로의 한 단계 */
export interface AncestorEntry {
  type: GroupLevel
  id: string
  label: string
}

/** Flat Column (leaf 노드, 그리드의 실제 열) */
export interface FlatColumn {
  key: string
  date: string
  resourceId: string
  resourceLabel: string
  /**
   * 상위 그룹 경로 (leaf 자기 자신은 포함하지 않음).
   * 예: date>doctorGroup>doctor 구조에서 doctor leaf의 ancestors는
   * [{ type:'date', ... }, { type:'doctorGroup', ... }] (doctor 자신 제외)
   */
  ancestors: AncestorEntry[]
  /** 전체 컬럼 중 순서 인덱스 */
  index: number
  /** 계산된 left 위치 (px) */
  leftPx: number
  /** 계산된 width (px) */
  widthPx: number
}

// ═══════════════════════════════════════════════════════════
// 시간축
// ═══════════════════════════════════════════════════════════

/** 시간 슬롯 */
export interface TimeSlot {
  time: string
  startMinute: number
  endMinute: number
  /** 계산된 y 위치 (px) */
  topPx: number
  /** 이 슬롯의 높이 (가변) */
  heightPx: number
  /** 점심/휴게 차단 여부 */
  blocked: boolean
  /** 차단 라벨 (예: "점심시간") */
  blockLabel?: string
}

// ═══════════════════════════════════════════════════════════
// 예약 배치
// ═══════════════════════════════════════════════════════════

/** 예약 카드 배치 좌표 */
export interface AppointmentRect {
  appointmentId: string
  columnKey: string
  top: number
  left: number
  width: number
  height: number
  /** N칸 보기 sub-column 번호 (0 ~ N-1) */
  subColIndex: number
  /** band 내 compact row 번호 */
  rowIndex: number
  /** 레이어링 z-index (row 기반: 짧은 예약이 높음) */
  zIndex: number
  /** 전체 layout의 displayTier (zoom 기준) */
  displayTier: DisplayTier
  /**
   * 이 카드에 실제 적용되는 displayTier.
   * sub-column 폭이 좁으면 displayTier보다 강등될 수 있다.
   */
  cardDisplayTier: DisplayTier
}

// ═══════════════════════════════════════════════════════════
// Scroll Anchor
// ═══════════════════════════════════════════════════════════

/** 스크롤 앵커 (3축) */
export interface ScrollAnchor {
  anchorDate: string
  anchorColumnKey: string
  /** 컬럼 내 비율 (0~1) */
  xRatio: number
  /** 하루 기준 분 */
  anchorMinute: number
  /** 슬롯 내 비율 (0~1) */
  yRatio: number
  /** 뷰포트 내 기준점 비율 (X) */
  viewportAnchorX: number
  /** 뷰포트 내 기준점 비율 (Y) */
  viewportAnchorY: number
}

// ═══════════════════════════════════════════════════════════
// HitTest
// ═══════════════════════════════════════════════════════════

/** hitTest 입력 */
export interface HitTestInput {
  /** body 영역 내 절대 X (scrollLeft 포함) */
  mouseX: number
  /** body 영역 내 절대 Y (scrollTop 포함) */
  mouseY: number
  columns: FlatColumn[]
  /** bandInfos (timeSlots 대체). topPx/heightPx/startMinute/endMinute 필요 */
  bandInfos: BandCompatible[]
  /** N칸 보기 (sub-column 수). 기본 1 */
  patientSlotSpan?: number
}

/** hitTest에서 사용하는 band 호환 타입 (BandInfo 또는 TimeSlot 모두 가능) */
export interface BandCompatible {
  startMinute: number
  endMinute: number
  topPx: number
  heightPx: number
}

/** hitTest 결과 */
export interface HitTestResult {
  columnKey: string | null
  column: FlatColumn | null
  date: string | null
  resourceId: string | null
  /** band의 startMinute (snap 전 기준 시간) */
  minute: number
  /** 매칭된 band */
  band: BandCompatible | null
  bandIndex: number
  /** column 내부 sub-column 인덱스 (0 ~ N-1) */
  subColIndex: number
}

// ═══════════════════════════════════════════════════════════
// Snap Grid
// ═══════════════════════════════════════════════════════════

/** Snap 설정 */
export interface SnapConfig {
  /** 기본 snap 단위 (분) */
  intervalMinutes: number
  /** Shift 키 누를 때 세밀 단위 (분) */
  fineIntervalMinutes: number
}

// ═══════════════════════════════════════════════════════════
// Interaction 상태
// ═══════════════════════════════════════════════════════════

/** 인터랙션 모드 (상호 배타) */
export type InteractionMode =
  | 'idle'
  | 'hovering'
  | 'dragging'
  | 'resizing'
  | 'selecting'
  | 'contextMenu'
  | 'popover'
  | 'creating'

/** Drag 상태 */
export interface DragState {
  appointmentId: string
  originColumnKey: string
  originStartMinute: number
  originEndMinute: number
  currentColumnKey: string
  currentStartMinute: number
  offsetX: number
  offsetY: number
  previewRect: AppointmentRect
  isValid: boolean
  invalidReason?: string
  /** 같은 column + 같은 시간 = 데이터 변경 없음 */
  isNoChange?: boolean
}

/** Resize 방향 */
export type ResizeDirection = 'top' | 'bottom'

/** Resize 상태 */
export interface ResizeState {
  appointmentId: string
  direction: ResizeDirection
  columnKey: string
  originStartMinute: number
  originEndMinute: number
  currentStartMinute: number
  currentEndMinute: number
  previewRect: AppointmentRect
  isValid: boolean
  invalidReason?: string
  minDuration: number
  maxDuration: number
  /** 같은 시간 = 데이터 변경 없음 (origin === current) */
  isNoChange?: boolean
}

/** Hover 상태 */
export interface HoverState {
  appointmentId: string
  cardElement: HTMLElement
  mouseX: number
  mouseY: number
  showQuickAction: boolean
  hoverStartTime: number
}

/** Selection 상태 */
export interface SelectionState {
  selectedIds: Set<string>
  lastSelectedId: string | null
  focusedId: string | null
}

/** Context Menu 대상 타입 */
export type ContextMenuTargetType = 'appointment' | 'cell' | 'header'

/** Context Menu 상태 */
export interface ContextMenuState {
  targetType: ContextMenuTargetType
  appointmentId?: string
  cellPosition?: {
    date: string
    resourceId: string
    minute: number
  }
  menuX: number
  menuY: number
}

/** Popover 타입 */
export type PopoverType = 'quickAction' | 'detail'

/** Popover 상태 */
export interface PopoverState {
  appointmentId: string
  triggerElement: HTMLElement
  anchorPosition: { x: number; y: number }
  popoverType: PopoverType
}

/** 통합 인터랙션 상태 */
export interface InteractionState {
  mode: InteractionMode
  drag: DragState | null
  resize: ResizeState | null
  hover: HoverState | null
  selection: SelectionState
  contextMenu: ContextMenuState | null
  popover: PopoverState | null
  creating: CreatingContext | null
}

// ═══════════════════════════════════════════════════════════
// Create Flow
// ═══════════════════════════════════════════════════════════

/** 생성 진입 경로 */
export type CreateTrigger = 'dblclick' | 'contextMenu'

/** 생성 진입 컨텍스트 (불변, 읽기 전용) */
export interface CreatingContext {
  hit: {
    columnKey: string
    date: string
    resourceId: string
    resourceLabel: string
    minute: number
    slotIndex: number
  }
  snappedStartMinute: number
  snappedEndMinute: number
  trigger: CreateTrigger
  createdAt: number
}

/** Modal 모드 */
export type ModalMode = 'create' | 'edit'

/**
 * 예약 Draft (가변, modal의 유일한 source of truth)
 * create/edit 모두 이 draft만 수정하며,
 * 최종 등록(confirm) 시 이 값이 store에 전달된다.
 */
export interface AppointmentDraft {
  date: string
  resourceId: string
  resourceLabel: string
  startMinute: number
  endMinute: number
  patientName: string
  patientPhone: string
  treatmentCategory: string
  treatmentDetail: string
  memo: string
}

/** Modal 상태 */
export interface ModalState {
  isOpen: boolean
  mode: ModalMode
  /** 생성 진입 컨텍스트 (create 모드, 읽기 전용) */
  context: CreatingContext | null
  /** 원본 예약 ID (edit 모드) */
  originAppointmentId: string | null
  /**
   * 유일한 source of truth.
   * 저장 기준값은 항상 이 draft 하나만 사용한다.
   */
  draft: AppointmentDraft
}

// ═══════════════════════════════════════════════════════════
// Create Validation
// ═══════════════════════════════════════════════════════════

/** 유효성 검증 코드 */
export type CreateValidationCode =
  | 'BLOCKED_TIME'
  | 'OUTSIDE_HOURS'
  | 'CLOSED_DAY'
  | 'DOCTOR_OFF'
  | 'DOCTOR_BLOCKED'
  | 'DUPLICATE_CONFLICT'
  | 'DURATION_TOO_SHORT'
  | 'DURATION_TOO_LONG'
  | 'SPANS_BLOCKED_RANGE'

/** 유효성 검증 결과 */
export interface CreateValidationResult {
  isValid: boolean
  reason?: string
  code?: CreateValidationCode
  /** 자동 보정 제안값 (분) */
  correctedEndMinute?: number
}

/** Duration 정책 */
export interface DurationPolicy {
  /** 기본 예약 길이 (분) */
  defaultMinutes: number
  /** 최소 (분) */
  minMinutes: number
  /** 최대 (분) */
  maxMinutes: number
  /** 조절 단위 (분) */
  snapMinutes: number
}

/** 중복 예약 정책 */
export interface DuplicatePolicy {
  mode: 'allow' | 'warn' | 'block'
  /**
   * 새 예약을 포함한 최종 겹침 수 상한.
   *
   * 기준: "새 예약이 추가된 후" 해당 시간대의 총 예약 수.
   * 예: maxOverlap=3이면 기존 2건 + 신규 1건 = 3건까지 허용.
   * 즉 기존 겹침이 maxOverlap-1 이하일 때만 신규 예약이 가능하다.
   */
  maxOverlap: number
}

/** 중복 검사 결과 */
export interface DuplicateCheckResult {
  allowed: boolean
  reason?: string
  overlapCount: number
  needsWarning: boolean
}

/** 운영시간 범위 */
export interface OperatingHours {
  startMinute: number
  endMinute: number
}

/** 차단 시간 범위 */
export interface BlockedRange {
  startMinute: number
  endMinute: number
  label: string
}

/** 의사 상태 */
export type DoctorStatus = 'working' | 'off' | 'vacation'

/** 유효성 검증 입력 */
export interface CreateValidationInput {
  date: string
  resourceId: string
  startMinute: number
  endMinute: number
  operatingHours: OperatingHours
  blockedRanges: BlockedRange[]
  closedDates: string[]
  doctorStatus: DoctorStatus
  doctorBlockedRanges: BlockedRange[]
  existingAppointments: ExistingAppointmentSlot[]
  duplicatePolicy: DuplicatePolicy
  durationPolicy: DurationPolicy
  /**
   * edit 모드에서 자기 자신을 중복 검사에서 제외하기 위한 ID.
   * create 모드에서는 undefined.
   */
  excludeAppointmentId?: string
}

/** 기존 예약 슬롯 (중복 검사용) */
export interface ExistingAppointmentSlot {
  id: string
  startMinute: number
  endMinute: number
}

// ═══════════════════════════════════════════════════════════
// DblClick 분기 판정
// ═══════════════════════════════════════════════════════════

/**
 * dblclick 판정 결과
 * DOM hit + logical hit 둘 다 사용하여 create / edit / ignore 분기
 */
export type DblClickResolution =
  | { action: 'create'; context: CreatingContext }
  | { action: 'edit'; appointmentId: string }
  | { action: 'ignore'; reason: string }
