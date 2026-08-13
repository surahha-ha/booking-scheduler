<template>
  <div class="appointment-layer">
    <AppointmentCard
      v-for="rect in rects"
      :key="rect.appointmentId"
      :appointment="getAppointment(rect.appointmentId)"
      :rect="rect"
      :column-key="rect.columnKey"
      :display-tier="rect.cardDisplayTier"
      :display-info="displayInfo"
      :row-height-level="rowHeightLevel"
      :cell-duration="cellDuration"
      @edit="(id) => emit('edit', id)"
      @delete="(id) => emit('delete', id)"
      @status-change="(id, state) => emit('status-change', id, state)"
      @callback="(res) => emit('callback', res)"
    />
  </div>
</template>

<script setup>
import AppointmentCard from './AppointmentCard.vue'

const props = defineProps({
  rects: { type: Array, default: () => [] },
  engineAppointments: { type: Array, default: () => [] },
  // 카드 표시정보 순서. null = 기존 하드코딩 레이아웃(V2 backward compat), 배열 = displayInfo 동적 렌더(V3).
  displayInfo: { type: Array, default: null },
  // 카드 높이 단계(1~5) = 정보 표시 줄 수(V3 동적 레이아웃 line-clamp).
  rowHeightLevel: { type: Number, default: 3 },
  // 예약 시간단위(분). 종료시각은 예약 길이가 이 값보다 클 때만 표기(1칸 예약은 숨김).
  cellDuration: { type: Number, default: 30 },
})

const emit = defineEmits(['edit', 'delete', 'status-change', 'callback'])

function getAppointment(id) {
  return props.engineAppointments.find(a => a.id === id) ?? null
}
</script>

<style lang="scss" scoped>
.appointment-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 5; // Grid(z-index 없음)보다 위에 렌더

  // 카드는 pointer-events를 다시 활성화
  :deep(.appointment-card) {
    pointer-events: auto;
  }
}
</style>
