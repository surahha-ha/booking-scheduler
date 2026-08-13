/**
 * 스케줄러 HitTest — Band 기반
 *
 * 순수 계산 모듈. Vue 의존성 없음.
 *
 * 3-phase 엔진 전환 후:
 *   - TimeSlot 대신 BandCompatible (BandInfo 호환) 사용
 *   - subColIndex 산출 (N칸 보기)
 *   - minuteToBandTopPx / minuteToBandBottomPx: band 경계 기반 좌표
 */

import type {
  FlatColumn,
  BandCompatible,
  HitTestInput,
  HitTestResult,
} from './types/scheduler.types'

/**
 * hitTest에서 band를 찾지 못했을 때 사용하는 sentinel 값.
 */
export const INVALID_MINUTE = NaN

/** minute 값이 유효한지 확인 */
export function isValidMinute(minute: number): boolean {
  return !Number.isNaN(minute)
}

// ═══════════════════════════════════════════════════════════
// hitTest
// ═══════════════════════════════════════════════════════════

/**
 * 마우스 좌표 → 논리 위치 변환
 */
export function hitTest(input: HitTestInput): HitTestResult {
  const { mouseX, mouseY, columns, bandInfos, patientSlotSpan = 1 } = input
  const N = Math.max(1, patientSlotSpan)

  // X → column 매핑
  const column = findColumnAtX(mouseX, columns)

  // X → sub-column 매핑 (column 내부)
  let subColIndex = 0
  if (column && N > 1 && column.widthPx > 0) {
    const subColWidth = column.widthPx / N
    const offsetInCol = mouseX - column.leftPx
    subColIndex = Math.max(0, Math.min(N - 1, Math.floor(offsetInCol / subColWidth)))
  }

  // Y → band 매핑
  const bandResult = findBandAtY(mouseY, bandInfos)

  // band의 startMinute를 기본 minute로 사용
  let minute = INVALID_MINUTE
  if (bandResult.band) {
    // band 내부에서 시간 비례로 minute 계산 (snap 전)
    const ratio = bandResult.band.heightPx > 0
      ? (mouseY - bandResult.band.topPx) / bandResult.band.heightPx
      : 0
    const clampedRatio = Math.max(0, Math.min(1, ratio))
    const bandDuration = bandResult.band.endMinute - bandResult.band.startMinute
    minute = bandResult.band.startMinute + clampedRatio * bandDuration
  }

  return {
    columnKey: column?.key ?? null,
    column: column ?? null,
    date: column?.date ?? null,
    resourceId: column?.resourceId ?? null,
    minute,
    band: bandResult.band,
    bandIndex: bandResult.index,
    subColIndex,
  }
}

// ═══════════════════════════════════════════════════════════
// Band 경계 기반 좌표 함수
// ═══════════════════════════════════════════════════════════

/**
 * minute → 해당 band의 topPx (band 시작 경계)
 *
 * drag preview의 top 계산에 사용.
 * band 내부 시간 비례 아님 — band 시작 경계에 snap.
 */
export function minuteToBandTopPx(
  minute: number,
  bandInfos: BandCompatible[]
): number {
  if (bandInfos.length === 0) return 0

  for (const band of bandInfos) {
    if (minute >= band.startMinute && minute < band.endMinute) {
      return band.topPx
    }
  }

  // 범위 밖: 마지막 band 하단
  const last = bandInfos[bandInfos.length - 1]
  if (minute >= last.endMinute) {
    return last.topPx + last.heightPx
  }

  return bandInfos[0].topPx
}

/**
 * minute → 해당 band의 bottomPx (band 종료 경계)
 *
 * resize/drag preview의 height 계산에 사용.
 * endMinute가 band 경계에 정확히 일치하면 해당 band의 하단 반환.
 */
export function minuteToBandBottomPx(
  minute: number,
  bandInfos: BandCompatible[]
): number {
  if (bandInfos.length === 0) return 0

  // endMinute는 band.endMinute와 같을 수 있음 (exclusive)
  // 이 경우 해당 band의 하단을 반환
  for (const band of bandInfos) {
    if (minute > band.startMinute && minute <= band.endMinute) {
      return band.topPx + band.heightPx
    }
  }

  // 정확히 첫 band.startMinute인 경우
  if (bandInfos.length > 0 && minute <= bandInfos[0].startMinute) {
    return bandInfos[0].topPx
  }

  // 범위 밖
  const last = bandInfos[bandInfos.length - 1]
  return last.topPx + last.heightPx
}

/**
 * minute 범위 → height 계산 (band 경계 기반)
 */
export function minuteRangeToBandHeight(
  startMinute: number,
  endMinute: number,
  bandInfos: BandCompatible[]
): number {
  return minuteToBandBottomPx(endMinute, bandInfos) - minuteToBandTopPx(startMinute, bandInfos)
}

// ═══════════════════════════════════════════════════════════
// 내부 검색 함수
// ═══════════════════════════════════════════════════════════

function findColumnAtX(
  x: number,
  columns: FlatColumn[]
): FlatColumn | null {
  if (columns.length === 0) return null
  if (x < 0) return null
  const lastCol = columns[columns.length - 1]
  if (x >= lastCol.leftPx + lastCol.widthPx) return null

  let lo = 0
  let hi = columns.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const col = columns[mid]
    if (x < col.leftPx) hi = mid - 1
    else if (x >= col.leftPx + col.widthPx) lo = mid + 1
    else return col
  }
  return null
}

function findBandAtY(
  y: number,
  bands: BandCompatible[]
): { band: BandCompatible | null; index: number } {
  if (bands.length === 0) return { band: null, index: -1 }
  if (y < 0) return { band: null, index: -1 }

  const last = bands[bands.length - 1]
  if (y >= last.topPx + last.heightPx) return { band: null, index: -1 }

  let lo = 0
  let hi = bands.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const band = bands[mid]
    if (y < band.topPx) hi = mid - 1
    else if (y >= band.topPx + band.heightPx) lo = mid + 1
    else return { band, index: mid }
  }
  return { band: null, index: -1 }
}
