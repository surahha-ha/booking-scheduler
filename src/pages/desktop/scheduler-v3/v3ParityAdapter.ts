/**
 * 시각 패리티 어댑터 — redesign 엔진 출력 → V2 컴포넌트(SchedulerHeader/TimeAxis/Grid/Panel/NowIndicator) props 변환
 *
 * 원칙: V2 = 기능/이벤트 SSOT. V2 컴포넌트를 미수정 재사용하기 위해 이 어댑터가
 *       redesign 의 {BandInfo, ResolvedColumn} 을 V2 의 {BandCompatible, FlatColumn, HeaderNode} 로 매핑.
 * 순수함수(Vue 의존 없음) — 단위테스트 가능. 라이브 배선은 SchedulerV3Page 에서.
 *
 * 결합도 주의(Explore 조사): AppointmentCard 는 hover/popover/drag/resize 4 inject 필수라 렌더전용 불가
 *   → 카드는 카드 도입 단계에서 V2 카드+composable 통째 도입. 본 어댑터는 헤더/축/그리드 렌더 컴포넌트만 대상.
 */

import type { BandInfo, Rect, Unit } from '@/scheduler-engine/redesign/layoutTypes'
import type { ResolvedColumn } from '@/scheduler-engine/redesign/layoutPipeline'
import type { FlatColumn, HeaderNode } from '@/scheduler-engine/types/scheduler.types'

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토']

/** 'YYYY-MM-DD' → 'MM-DD (요일)'. */
export function formatDateLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return ymd
  const wd = WEEKDAY_KO[new Date(y, m - 1, d).getDay()]
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} (${wd})`
}

/** SchedulerTimeAxis/Grid/Panel/NowIndicator 가 소비하는 band 형태(BandCompatible + 선택필드). */
export interface V2Band {
  startMinute: number
  endMinute: number
  topPx: number
  heightPx: number
  bandIndex: number
  time: string
  blocked: boolean
  blockLabel?: string
}

function minToLabel(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** redesign BandInfo[] → V2 band[]. startMin/endMin→startMinute/endMinute, isBreak→blocked. */
export function toV2Bands(bands: BandInfo[]): V2Band[] {
  return bands.map(b => ({
    startMinute: b.startMin,
    endMinute: b.endMin,
    topPx: b.topPx,
    heightPx: b.heightPx,
    bandIndex: b.index,
    time: minToLabel(b.startMin),
    blocked: b.isBreak,
    blockLabel: b.breakLabel,
  }))
}

/** unit.key 를 컬럼/헤더 leaf 의 공통 key 로 사용(=`${date}__${doctorId}`). */
function columnKey(unit: Unit): string {
  return unit.key
}

/** redesign ResolvedColumn[] → V2 FlatColumn[] (그리드 실제 열). */
export function toV2Columns(columns: ResolvedColumn[]): FlatColumn[] {
  return columns.map(col => ({
    key: columnKey(col.unit),
    date: col.unit.date,
    resourceId: col.unit.doctorId,
    resourceLabel: col.unit.doctorName,
    ancestors: [{ type: 'date' as const, id: col.unit.date, label: formatDateLabel(col.unit.date) }],
    index: col.columnIndex,
    leftPx: col.leftPx,
    widthPx: col.widthPx,
  }))
}

/**
 * redesign ResolvedColumn[] → V2 HeaderNode[] (날짜 > 의사 트리).
 * leaf.key = unit.key 로 FlatColumn.key 와 통일 → SchedulerHeader 의 "의사 1명 시 doctor 행 제거" 자동 동작.
 * holidayLabelFor: 날짜→공휴일 휴무 라벨('휴무') lookup. 전달 시 date 노드 holidayLabel 채움(날짜 행 빨간 표기).
 */
export function toV2HeaderTree(
  columns: ResolvedColumn[],
  holidayLabelFor?: (_ymd: string) => string | undefined,
  // 비공개(openYn='N') 담당자 id(=이름) 집합(#1). 전달 시 의사 노드 isPrivate → 헤더 '비공개' 뱃지.
  privateDoctorIds?: Set<string>,
): HeaderNode[] {
  const dateOrder: string[] = []
  const byDate = new Map<string, ResolvedColumn[]>()
  for (const col of columns) {
    const d = col.unit.date
    if (!byDate.has(d)) {
      byDate.set(d, [])
      dateOrder.push(d)
    }
    byDate.get(d)!.push(col)
  }

  return dateOrder.map((date) => {
    const cols = byDate.get(date)!
    const children: HeaderNode[] = cols.map(col => ({
      key: columnKey(col.unit),
      label: col.unit.doctorName,
      colSpan: 1,
      depth: 1,
      type: 'doctor' as const,
      isPrivate: !!privateDoctorIds?.has(col.unit.doctorId),
      leafMeta: {
        date: col.unit.date,
        resourceId: col.unit.doctorId,
        resourceLabel: col.unit.doctorName,
      },
    }))
    return {
      key: date,
      label: formatDateLabel(date),
      holidayLabel: holidayLabelFor?.(date) || undefined,
      colSpan: children.length,
      depth: 0,
      type: 'date' as const,
      children,
    }
  })
}

/**
 * AppointmentLayer/AppointmentCard 가 소비하는 rect 형태(V2 AppointmentRect 부분집합).
 * - Card 는 top/left/width/height/zIndex 만 좌표로 사용.
 * - Layer 는 appointmentId(키+조회)/columnKey/cardDisplayTier 만 사용.
 * subColIndex/rowIndex 는 카드 렌더에 불필요(드래그 hitTest 용) → 후속 단계에서 별도 처리.
 */
export interface V2Rect {
  appointmentId: string
  columnKey: string
  top: number
  left: number
  width: number
  height: number
  zIndex: number
  cardDisplayTier: string
  /** layering(긴 예약 위 얹힌 짧은 예약) — 카드 그림자 토글용. */
  isLayered: boolean
}

/**
 * redesign Rect[] → V2 AppointmentRect[]. id→appointmentId, z→zIndex,
 * columnIndex→columns[idx].unit.key(columnKey). cardDisplayTier 는 'standard' 고정(엔진 미보유).
 */
export function toV2Rects(rects: Rect[], columns: ResolvedColumn[]): V2Rect[] {
  return rects.map(r => ({
    appointmentId: r.id,
    columnKey: columns[r.columnIndex] ? columnKey(columns[r.columnIndex].unit) : '',
    top: r.top,
    left: r.left,
    width: r.width,
    height: r.height,
    zIndex: r.z,
    cardDisplayTier: 'standard',
    isLayered: r.isLayered,
  }))
}
