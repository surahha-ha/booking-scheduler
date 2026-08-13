<template>
  <!--
    SubColResizeHandles: 각 column 내부 sub-col 사이 + column 오른쪽 끝의 세로 구분선(handle).
    - N=1: column 오른쪽 끝에 handle 1개 (우 drag로 N=2 진입 — 우=증가/좌=감소)
    - N=2: 분할선 1개 + 오른쪽 끝 1개 = 2개
    - N=3: 분할선 2개 + 오른쪽 끝 1개 = 3개
    - N=4: 분할선 3개 + 오른쪽 끝 1개 = 4개 (단 max라 좌 drag는 무시)

    평소 옅은 회색 실선으로 항상 노출. hover/active 시 진한 파란색.
  -->
  <div class="subcol-resize-handles">
    <div
      v-for="h in handles"
      :key="h.key"
      class="subcol-resize-handle"
      :class="{
        'subcol-resize-handle--edge': h.isEdge,
        'subcol-resize-handle--clamped': h.clamped,
      }"
      :style="{ left: h.left + 'px' }"
      @mousedown="onMouseDown($event, h)"
    >
      <div class="subcol-resize-handle__line" />
    </div>
  </div>
</template>

<script setup>
import { computed, inject } from 'vue'

const HALF_HIT = 4 // hit zone 폭의 절반 (즉 ±4px = 8px hit zone). 스타일 width 와 일치시킬 것
const HANDLE_W = HALF_HIT * 2

const props = defineProps({
  columns: { type: Array, default: () => [] },
  /** 전역 N (V2). per-column 모드(V3)에선 slotsByKey 가 우선. */
  n: { type: Number, default: 1 },
  /** per-column 칸수 맵 (V3): { [col.key]: N }. 미전달 시 전역 n 사용(V2). */
  slotsByKey: { type: Object, default: null },
  /**
   * true = 컬럼(그룹) 경계에만 핸들 (V3): 헤더 담당자/날짜 그룹 컬럼 단위로만 칸수 조절.
   * false(기본, V2) = sub-col 내부 분할선 + 경계 모두.
   */
  edgeOnly: { type: Boolean, default: false },
  /**
   * 보드(핸들 컨테이너) 콘텐츠 폭. 이 폭을 넘는 핸들은 안쪽으로 당겨 문서 가로 스크롤을 막는다.
   * 0(미측정) 이면 clamp 하지 않는다 — 초기 렌더 한 프레임뿐이고 이때 컬럼 폭도 0 이라 무해.
   */
  availableWidth: { type: Number, default: 0 },
})

/** 컬럼의 현재 N — per-column 맵 우선, 없으면 전역 n. */
function colN(col) {
  const v = props.slotsByKey?.[col.key]
  return typeof v === 'number' && v >= 1 ? v : props.n
}

const handles = computed(() => {
  const out = []
  // 핸들은 경계선 중앙정렬(left = 경계 - HALF_HIT)이라, 경계가 보드 오른쪽 끝과 같으면
  // 폭의 절반이 보드 밖으로 나가 문서에 가로 스크롤이 생긴다. 좌표를 안쪽으로 당기고
  // 구분선은 flex-end 로 경계에 남긴다(--clamped). 컬럼 경계가 아닌 "보드 폭" 기준인 이유:
  // 예약 모드는 denom=budget 고정이라 마지막 컬럼이 보드 끝에 못 미칠 수 있고, 그땐 당기면 안 된다.
  const maxLeft = props.availableWidth > 0 ? props.availableWidth - HANDLE_W : Infinity
  const place = (x) => {
    const left = Math.min(x, maxLeft)
    return { left, clamped: left < x }
  }
  for (const col of props.columns) {
    const n = colN(col)
    // sub-col 내부 분할선 — edgeOnly(V3) 면 생략(컬럼 그룹 경계만 조절).
    if (!props.edgeOnly) {
      for (let i = 1; i < n; i++) {
        out.push({
          key: `${col.key}__inner${i}`,
          ...place(col.leftPx + (col.widthPx / n) * i - HALF_HIT),
          columnWidthPx: col.widthPx,
          columnKey: col.key,
          currentN: n,
          isEdge: false,
        })
      }
    }
    // column 오른쪽 끝 (그룹 컬럼 경계 — 모든 N에서 노출)
    out.push({
      key: `${col.key}__edge`,
      ...place(col.leftPx + col.widthPx - HALF_HIT),
      columnWidthPx: col.widthPx,
      columnKey: col.key,
      currentN: n,
      isEdge: true,
    })
  }
  return out
})

const subColResize = inject('schedulerSubColResize', null)

function onMouseDown(e, h) {
  if (!subColResize) return
  subColResize.startSubColResize(e, {
    columnWidthPx: h.columnWidthPx,
    currentN: h.currentN,
    columnKey: h.columnKey,
  })
}
</script>

<style lang="scss" scoped>
.subcol-resize-handles {
  position: absolute;
  inset: 0;
  pointer-events: none;
  // 카드 z-index(startMinute × 10 + rowIndex + 1)는 매우 클 수 있어
  // 카드 위에 노출되도록 충분히 높게. NowIndicator(300) 이하 유지.
  z-index: 250;
}

.subcol-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px; // hit zone 폭 (script 의 HANDLE_W 와 일치시킬 것)
  pointer-events: auto;
  cursor: col-resize;
  display: flex;
  justify-content: center;

  // 보드 오른쪽 끝이라 안쪽으로 당겨진 핸들 — hit zone 만 안쪽이고 구분선은 경계에 그대로 둔다.
  &.subcol-resize-handle--clamped {
    justify-content: flex-end;
  }

  // 평소: 옅은 회색 실선 (항상 노출)
  .subcol-resize-handle__line {
    width: 1px;
    height: 100%;
    background: #d0d4d9;
    transition: background 0.12s ease, width 0.12s ease;
  }

  &:hover .subcol-resize-handle__line,
  &:active .subcol-resize-handle__line {
    background: #1976d2;
    width: 2px;
  }
}

// drag 중 전역 cursor
:global(body.is-subcol-resizing-active) {
  cursor: col-resize !important;
  user-select: none;
}
:global(body.is-subcol-resizing-active *) {
  cursor: col-resize !important;
}
</style>
