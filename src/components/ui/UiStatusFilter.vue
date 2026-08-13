<script setup>
import {useCheckBoxSelection} from '@/composables/useCheckBoxSelection';
import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';
import {storeToRefs} from "pinia";

const props = defineProps({
  buttonItems: {
    type   : Array,
    default: () => [],
  },
  statistics : {
    type   : Object,
    default: () => ({}),
  },
});

const schedulerFilterStore = useSchedulerFilterStore();

const {
  status: selectedStatus,
} = storeToRefs(schedulerFilterStore);

// TODO 서버 호출이 아닌 예약목록에서 필터되도록 수정
const statusSelection = useCheckBoxSelection({
  items                 : () => props.buttonItems,
  selectedValues        : selectedStatus,
  onChange              : (keys) => schedulerFilterStore.setStatusKeys(keys),
  normalizeOnItemsChange: false, // 동적으로 변경하지 않는 검색 값이면 false
  isAllEmpty            : true
});

const {
  isAllSelected: isAllAppointmentStatusSelected,
  isActive     : isAppointmentStatusActive,
  selectAll,
  toggle
} = statusSelection;

function getStatistic(key) {
  return props?.statistics[key] ?? 0;
}
</script>

<template>
  <div class="scheduleStatusChecks">
    <button
        :aria-pressed="isAllAppointmentStatusSelected"
        :class="{ 'is-on': isAllAppointmentStatusSelected }"
        class="scheduleStatusChecks__check"
        type="button"
        @click="selectAll"
    >
      전체 <span class="scheduleStatusChecks__count">{{ getStatistic('전체') }}</span>
    </button>

    <button
        v-for="item in buttonItems"
        :key="item.value"
        :aria-pressed="isAppointmentStatusActive(item.value)"
        :class="{ 'is-on': isAppointmentStatusActive(item.value) }"
        class="scheduleStatusChecks__check"
        type="button"
        @click="toggle(item.value)"
    >
      {{ item.label }}
      <span class="scheduleStatusChecks__count">{{ getStatistic(item.label) }}</span>
    </button>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.scheduleStatusChecks {
  display: inline-flex;
  align-items: center;
  height: 24px;
  border: 1px solid #a5a5a5;
  border-radius: $radius-4;
  background: $color-surface;

  &__check {
    position: relative;
    height: 24px;
    padding: 0 10px;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
    font-size: $font-size-14;
    font-weight: $font-weight-medium;
    color: $color-text-segment;

    & + &::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 0;
      width: 1px;
      height: $space-12;
      background: #a5a5a5;
      transform: translateY(-50%);
    }

    &.is-on {
      z-index: 1;
      border: 1px solid $color-primary;
      border-radius: $radius-4;
      background: $color-surface;
      color: $color-primary;
      font-weight: $font-weight-semibold;
    }

    &.is-on::before,
    &.is-on + &::before {
      display: none;
    }

  }

  &__count {
    margin-left: $space-4;
    color: $color-primary;
  }
}
</style>
