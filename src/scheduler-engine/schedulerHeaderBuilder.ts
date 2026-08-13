/**
 * 스케줄러 헤더 트리 빌더
 *
 * 순수 계산 모듈. Vue 의존성 없음.
 *
 * n-depth 재귀 트리 구조로 헤더를 생성한다.
 * GroupingConfig.levels 배열이 트리의 깊이와 순서를 결정한다.
 *
 * 지원하는 그룹 구조:
 *   ['date', 'doctor']                  → 날짜 > 의사
 *   ['date', 'chair']                   → 날짜 > 체어
 *   ['date', 'doctor', 'chair']         → 날짜 > 의사 > 체어
 *   ['date', 'doctorGroup', 'doctor']   → 날짜 > 의사그룹 > 의사
 *
 * 정책:
 *   - doctorGroup은 중간 그룹 노드 전용. leaf가 될 수 없다.
 *     levels 마지막에 오면 해당 그룹 아래에 children이 없으므로 빈 배열 반환.
 *   - leaf 노드에는 반드시 leafMeta(date, resourceId, resourceLabel)가 포함된다.
 *   - 각 date 노드는 해당 날짜 context만 하위로 전달한다.
 *
 * colSpan 계산:
 *   leaf: colSpan = 1
 *   부모: colSpan = sum(children.colSpan)
 */

import type {
  HeaderNode,
  HeaderLeafMeta,
  GroupingConfig,
  GroupLevel,
  ResourceMap,
  DoctorResource,
  ChairResource,
} from './types/scheduler.types'

/** 날짜 정보 (builder 입력용) */
export interface DateEntry {
  date: string
  label: string
}

/** buildHeaderTree 입력 */
export interface HeaderBuilderInput {
  dates: DateEntry[]
  resources: ResourceMap
  grouping: GroupingConfig
}

/**
 * 헤더 트리 생성 (메인 함수)
 */
export function buildHeaderTree(input: HeaderBuilderInput): HeaderNode[] {
  const { dates, resources, grouping } = input

  if (grouping.levels.length === 0 || dates.length === 0) return []

  // 첫 번째 level은 반드시 'date'여야 한다
  if (grouping.levels[0] !== 'date') {
    throw new Error('GroupingConfig.levels[0] must be "date"')
  }

  return buildDateNodes(dates, resources, grouping.levels, 0)
}

/**
 * 헤더 트리의 총 depth 수
 */
export function getHeaderDepth(grouping: GroupingConfig): number {
  return grouping.levels.length
}

/**
 * 헤더 트리를 depth별 flat 배열로 변환
 *
 * rows[0] = depth 0의 모든 노드 (날짜 행)
 * rows[1] = depth 1의 모든 노드 (의사 또는 그룹 행)
 * ...
 */
export function flattenHeaderByDepth(nodes: HeaderNode[]): HeaderNode[][] {
  const rows: HeaderNode[][] = []

  function traverse(node: HeaderNode) {
    if (!rows[node.depth]) rows[node.depth] = []
    rows[node.depth].push(node)
    if (node.children) {
      for (const child of node.children) traverse(child)
    }
  }

  for (const node of nodes) traverse(node)
  return rows
}

/**
 * resources 기반 하루당 실제 leaf column 수 계산
 *
 * 의사별 chair 수가 다를 수 있으므로 단순 곱셈이 아닌
 * 실제 resources를 순회하여 합산한다.
 */
export function countLeafColumnsPerDay(
  resources: ResourceMap,
  levels: GroupLevel[]
): number {
  // date 이후의 level만 고려
  const subLevels = levels.filter(l => l !== 'date')

  if (subLevels.length === 0) {
    // date만 있는 경우 (week 뷰)
    return 1
  }

  return countResourceLeaves(subLevels, 0, resources, null)
}

// ═══════════════════════════════════════════════════════════
// 내부: 재귀 빌더
// ═══════════════════════════════════════════════════════════

/** 하위 level로 전달되는 context */
interface BuildContext {
  date: string
  dateLabel: string
  doctorGroupId?: string
  doctorId?: string
  doctorName?: string
}

/**
 * date level 노드 생성
 */
function buildDateNodes(
  dates: DateEntry[],
  resources: ResourceMap,
  levels: GroupLevel[],
  depth: number,
): HeaderNode[] {
  const isLast = levels.length === 1 // date만 있는 경우

  return dates.map(d => {
    const ctx: BuildContext = { date: d.date, dateLabel: d.label }

    if (isLast) {
      // date 자체가 leaf (week 뷰 등)
      return createLeafNode(d.date, d.label, depth, 'date', {
        date: d.date,
        resourceId: '',
        resourceLabel: d.label,
      })
    }

    // 다음 level의 children 생성 (해당 날짜 context만 전달)
    const children = buildSubLevel(levels, 1, depth + 1, resources, ctx)
    const colSpan = sumColSpan(children)

    return {
      key: d.date,
      label: d.label,
      colSpan,
      depth,
      type: 'date' as GroupLevel,
      children: children.length > 0 ? children : undefined,
    }
  })
}

/**
 * date 이후 하위 level을 재귀적으로 생성
 */
function buildSubLevel(
  levels: GroupLevel[],
  levelIndex: number,
  depth: number,
  resources: ResourceMap,
  ctx: BuildContext,
): HeaderNode[] {
  if (levelIndex >= levels.length) return []

  const currentLevel = levels[levelIndex]
  const isLast = levelIndex === levels.length - 1

  switch (currentLevel) {
    case 'doctorGroup':
      return buildDoctorGroupNodes(levels, levelIndex, depth, resources, ctx, isLast)
    case 'doctor':
      return buildDoctorNodes(levels, levelIndex, depth, resources, ctx, isLast)
    case 'chair':
      return buildChairNodes(levels, levelIndex, depth, resources, ctx)
    default:
      return []
  }
}

/**
 * doctorGroup 노드 생성
 *
 * 정책: doctorGroup은 중간 그룹 노드 전용.
 * isLast=true이면 leaf가 되어야 하지만 doctorGroup은 leaf 불가이므로
 * 빈 배열을 반환한다. (또는 하위에 doctor가 없으면 colSpan=0)
 */
function buildDoctorGroupNodes(
  levels: GroupLevel[],
  levelIndex: number,
  depth: number,
  resources: ResourceMap,
  ctx: BuildContext,
  isLast: boolean,
): HeaderNode[] {
  const groups = resources.doctorGroups ?? []

  // doctorGroup이 마지막 level → leaf가 될 수 없으므로 빈 배열
  if (isLast) return []

  return groups.map(group => {
    const childCtx: BuildContext = { ...ctx, doctorGroupId: group.id }
    const children = buildSubLevel(levels, levelIndex + 1, depth + 1, resources, childCtx)
    const colSpan = sumColSpan(children)

    // children이 없으면 (그룹 내 의사가 0명) 이 그룹 노드도 생략
    if (colSpan === 0) return null!

    return {
      key: `${ctx.date}_group_${group.id}`,
      label: group.name,
      colSpan,
      depth,
      type: 'doctorGroup' as GroupLevel,
      children,
    }
  }).filter(Boolean)
}

/**
 * doctor 노드 생성
 */
function buildDoctorNodes(
  levels: GroupLevel[],
  levelIndex: number,
  depth: number,
  resources: ResourceMap,
  ctx: BuildContext,
  isLast: boolean,
): HeaderNode[] {
  let doctors = filterDoctors(resources, ctx.doctorGroupId)

  return doctors.map(doc => {
    const key = `${ctx.date}_${doc.id}`

    if (isLast) {
      return createLeafNode(key, doc.name, depth, 'doctor', {
        date: ctx.date,
        resourceId: doc.id,
        resourceLabel: doc.name,
      })
    }

    const childCtx: BuildContext = { ...ctx, doctorId: doc.id, doctorName: doc.name }
    const children = buildSubLevel(levels, levelIndex + 1, depth + 1, resources, childCtx)
    const colSpan = sumColSpan(children)

    return {
      key,
      label: doc.name,
      colSpan: colSpan > 0 ? colSpan : 1,
      depth,
      type: 'doctor' as GroupLevel,
      children: children.length > 0 ? children : undefined,
    }
  })
}

/**
 * chair 노드 생성 (항상 leaf)
 */
function buildChairNodes(
  levels: GroupLevel[],
  levelIndex: number,
  depth: number,
  resources: ResourceMap,
  ctx: BuildContext,
): HeaderNode[] {
  let chairs = filterChairs(resources, ctx.doctorId)

  return chairs.map(chair => {
    const keyParts = [ctx.date, ctx.doctorId, chair.id].filter(Boolean)
    const key = keyParts.join('_')

    return createLeafNode(key, chair.name, depth, 'chair', {
      date: ctx.date,
      resourceId: chair.id,
      resourceLabel: chair.name,
    })
  })
}

// ═══════════════════════════════════════════════════════════
// 헬퍼
// ═══════════════════════════════════════════════════════════

function createLeafNode(
  key: string,
  label: string,
  depth: number,
  type: GroupLevel,
  leafMeta: HeaderLeafMeta
): HeaderNode {
  return { key, label, colSpan: 1, depth, type, leafMeta }
}

function sumColSpan(nodes: HeaderNode[]): number {
  let sum = 0
  for (const n of nodes) sum += n.colSpan
  return sum
}

function filterDoctors(resources: ResourceMap, groupId?: string): DoctorResource[] {
  if (!groupId || !resources.doctorGroups) return resources.doctors

  const group = resources.doctorGroups.find(g => g.id === groupId)
  if (!group) return resources.doctors

  const idSet = new Set(group.doctorIds)
  return resources.doctors.filter(d => idSet.has(d.id))
}

function filterChairs(resources: ResourceMap, doctorId?: string): ChairResource[] {
  const chairs = resources.chairs ?? []
  if (!doctorId) return chairs
  return chairs.filter(c => c.doctorId === doctorId)
}

// ═══════════════════════════════════════════════════════════
// resources 기반 leaf count (재귀)
// ═══════════════════════════════════════════════════════════

function countResourceLeaves(
  subLevels: GroupLevel[],
  index: number,
  resources: ResourceMap,
  parentDoctorId: string | null,
): number {
  if (index >= subLevels.length) return 1 // leaf 도달

  const level = subLevels[index]

  switch (level) {
    case 'doctorGroup': {
      // doctorGroup은 leaf 불가, 반드시 하위가 있어야 함
      const groups = resources.doctorGroups ?? []
      if (index === subLevels.length - 1) return 0 // leaf 불가
      let total = 0
      for (const group of groups) {
        // 그룹 내 의사 수 × 하위 leaf
        const doctors = resources.doctors.filter(d => {
          const idSet = new Set(group.doctorIds)
          return idSet.has(d.id)
        })
        for (const doc of doctors) {
          total += countResourceLeaves(subLevels, index + 1, resources, doc.id)
        }
      }
      return total
    }

    case 'doctor': {
      const doctors = parentDoctorId
        ? resources.doctors.filter(d => d.id === parentDoctorId)
        : resources.doctors
      let total = 0
      for (const doc of doctors) {
        total += countResourceLeaves(subLevels, index + 1, resources, doc.id)
      }
      return total
    }

    case 'chair': {
      const chairs = resources.chairs ?? []
      const filtered = parentDoctorId
        ? chairs.filter(c => c.doctorId === parentDoctorId)
        : chairs
      return filtered.length || 1
    }

    default:
      return 1
  }
}
