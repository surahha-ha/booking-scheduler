<template>
  <div class="scheduler-time-axis">
    <div
      v-for="band in bandInfos"
      :key="band.startMinute"
      class="time-axis-cell"
      :style="{ height: band.heightPx + 'px' }"
    >
      <span class="time-axis-label">{{ band.time }}</span>
    </div>

    <!-- 현재 시각 마커: [시각] [●] — 선 중앙 정렬 -->
    <div
      v-if="nowIndicatorVisible"
      class="time-axis-now"
      :style="{ top: nowTopPx + 'px' }"
    >
      <span class="time-axis-now__label">{{ nowTimeLabel }}</span>
      <span class="time-axis-now__dot">●</span>
    </div>
  </div>
</template>

<script setup>
import { toRef } from 'vue'
import { useNowIndicator } from '../composables/useNowIndicator'

const props = defineProps({
  bandInfos: { type: Array, default: () => [] },
})

// 본문 가로선(NowIndicator)과 같은 계산 — 보이는 구간·높이가 갈리지 않게 한 벌을 쓴다.
const {
  visible: nowIndicatorVisible,
  topPx: nowTopPx,
  timeLabel: nowTimeLabel,
} = useNowIndicator(toRef(props, 'bandInfos'))
</script>

<style lang="scss" scoped>
$color-now: var(--scheduler-now, #256AF5);

.scheduler-time-axis {
  position: relative;
}

/* V1: time-panel-cell 기준
 * - 14px, font-weight 500, color #333
 * - odd #fff, even #f5f6f8
 * - vertical-align middle, padding 2px 0
 */
.time-axis-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  box-sizing: border-box;
  border-bottom: 1px solid #f0f0f0;
  font-size: 14px;
  font-weight: 500;
  color: #333;
  background: #fff;

  // V1 줄무늬: even 행
  &:nth-child(even) {
    background: #f5f6f8;
  }
}

.time-axis-label {
  white-space: nowrap;
}

/* ── 현재 시각 마커 ── */
.time-axis-now {
  position: absolute;
  right: 0;
  z-index: 10;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 2px;
  // 선 중앙에 오도록 y축 -50% 보정
  transform: translateY(-50%);
}

.time-axis-now__label {
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: $color-now;
  padding: 2px 6px;
  border-radius: 6px;
  white-space: nowrap;
}

.time-axis-now__dot {
  font-size: 8px;
  color: $color-now;
  line-height: 1;
  animation: pulse 1.2s infinite;
}

@keyframes pulse {
  0% {
    transform: scale(1);
    opacity: 1;
  }
  70% {
    transform: scale(1.8);
    opacity: 0;
  }
  100% {
    opacity: 0;
  }
}
</style>
