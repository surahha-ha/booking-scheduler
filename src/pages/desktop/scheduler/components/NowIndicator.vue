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
import { computed, inject, ref } from 'vue'
import dayjs from 'dayjs'
import { minuteToBandTopPx } from '@/scheduler-engine/schedulerHitTest'

const props = defineProps({
  bandInfos: { type: Array, default: () => [] },
  columns: { type: Array, default: () => [] },
})

const nowTick = inject('nowTick', ref(Date.now()))

const todayStr = computed(() => dayjs(nowTick.value).format('YYYY-MM-DD'))

const nowMinute = computed(() => {
  const d = new Date(nowTick.value)
  return d.getHours() * 60 + d.getMinutes()
})

const visible = computed(() => {
  if (!props.bandInfos.length) return false
  const first = props.bandInfos[0]
  const last = props.bandInfos[props.bandInfos.length - 1]
  return nowMinute.value >= first.startMinute && nowMinute.value < last.endMinute
})

const topPx = computed(() => {
  if (!visible.value) return 0
  return minuteToBandTopPx(nowMinute.value, props.bandInfos)
})

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
