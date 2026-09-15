<template>
  <!--
    NowIndicator: body 영역의 현재 시각 가로선.
    - 오늘 날짜 column: 실선
    - 다른 날짜 column: 점선
    - 시각 라벨/동그라미는 SchedulerTimeAxis에서 표시
  -->
  <div
    v-if="visible"
    class="now-indicator"
    :style="{ top: topPx + 'px' }"
  >
    <div
      v-for="col in columns"
      :key="col.key"
      class="now-indicator__segment"
      :class="{ 'is-today': isColumnToday(col) }"
      :style="{ left: col.leftPx + 'px', width: col.widthPx + 'px' }"
    />
  </div>
</template>

<script setup>
import { toRef } from 'vue'
import { useNowIndicator } from '../composables/useNowIndicator'

const props = defineProps({
  bandInfos: { type: Array, default: () => [] },
  columns: { type: Array, default: () => [] },
})

// 시간축 라벨(SchedulerTimeAxis)과 같은 계산 — 보이는 구간·높이가 갈리지 않게 한 벌을 쓴다.
const { todayStr, visible, topPx } = useNowIndicator(toRef(props, 'bandInfos'))

function isColumnToday(col) {
  return col.date === todayStr.value
}
</script>

<style lang="scss" scoped>
$color-now: var(--scheduler-now, #256AF5);

.now-indicator {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 300;
  pointer-events: none;
  display: flex;
}

.now-indicator__segment {
  position: absolute;
  height: 2px;

  /* 기본: 점선 (오늘이 아닌 날짜) */
  background: repeating-linear-gradient(
    to right,
    $color-now 0,
    $color-now 4px,
    transparent 4px,
    transparent 8px
  );

  /* 오늘: 실선 */
  &.is-today {
    background: $color-now;
  }
}
</style>
