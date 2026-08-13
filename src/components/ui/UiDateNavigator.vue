<script setup>
import {VueDatePicker} from '@vuepic/vue-datepicker';
import '@vuepic/vue-datepicker/dist/main.css';
import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';
import {storeToRefs} from 'pinia';
import {useSchedulerPeriodPicker} from '@/composables/useSchedulerPeriodPicker';
import {computed} from 'vue';
import {datePickerYearRange} from '@/utils/schedulerSearchFilterUtils';
import dayjs from 'dayjs';

const schedulerFilterStore = useSchedulerFilterStore();

const {
  viewMode  : selectedViewMode,
  periodDate: selectedPeriodDate,
  dataType  : selectedDataType,
} = storeToRefs(schedulerFilterStore);

const yearRange = computed(() => {
  return datePickerYearRange(10, 10);
});

// 진료 화면: 오늘까지만 선택 가능
const maxDate = computed(() => selectedDataType.value === 'TREATMENT' ? new Date() : null);

// 보고 있는 기간의 마지막 날. WEEK 의 periodDate 는 그 주의 일요일이라 시작일만 보면
// 이번 주를 보는 중에도 "시작일 < 오늘"이 되어 미래인 다음 주로 넘어가 버린다.
const periodEndDate = computed(() => selectedViewMode.value === 'WEEK'
    ? dayjs(selectedPeriodDate.value).add(6, 'day')   // week-start=0(일) 기준 토요일
    : dayjs(selectedPeriodDate.value));

// 진료 화면: > 버튼 비활성 (오늘 이후 이동 불가). maxDate 와 같은 규칙 —
// 오늘이 든 기간까지는 볼 수 있고, 전부 미래인 다음 기간으로는 못 넘어간다.
const canMoveNext = computed(() => {
  if (selectedDataType.value !== 'TREATMENT') return true;
  return periodEndDate.value.isBefore(dayjs(), 'day');
});

const periodPicker = useSchedulerPeriodPicker({
  getPeriodDate         : () => selectedPeriodDate.value,
  getViewMode           : () => selectedViewMode.value,
  setPeriodDate         : (d) => schedulerFilterStore.setPeriodDate(d),
  // 팝업이 fixed 라 트리거 박스 밖에 그려진다 → 팝업 내부 클릭도 "바깥"으로 판정되지 않게 함께 등록.
  closeOnOutsideSelector: '.scheduleNavDateBox, .scheduleDatePopup',
});

const {
  weekPickerRef,
  dayPickerRef,
  triggerRef,
  popupRef,
  popupStyle,
  weekRange,
  dayValue,
  isDateOpen,
  periodDateText,
  openPicker,
  closePicker,
  onPickWeek,
  onPickDay,
} = periodPicker;

</script>

<template>
  <div ref="triggerRef" class="scheduleNavDateBox">
    <button
        class="scheduleNavDate"
        type="button"
    >
      <span
          aria-hidden="true"
          class="scheduleNavDate__arrow"
          @click.stop="schedulerFilterStore.movePeriod(-1)"
      >‹</span>

      <span
          class="scheduleNavDate__text"
          @click.stop="openPicker"
      >
        {{ periodDateText }}
      </span>

      <span
          aria-hidden="true"
          :class="{ 'is-hidden': !canMoveNext }"
          class="scheduleNavDate__arrow"
          @click.stop="schedulerFilterStore.movePeriod(1)"
      >›</span>
    </button>

    <div
        v-if="isDateOpen"
        ref="popupRef"
        :style="popupStyle"
        class="scheduleDatePopup"
        @click.stop
    >
      <!-- WEEK -->
      <VueDatePicker
          v-if="selectedViewMode === 'WEEK'"
          ref="weekPickerRef"
          v-model="weekRange"
          :auto-apply="true"
          :hide-input="true"
          :inline="true"
          :max-date="maxDate"
          :time-config="{ enableTimePicker: false }"
          :week-picker="true"
          :week-start="0"
          :year-range="yearRange"
          @update:model-value="onPickWeek"
      />

      <!-- DAY -->
      <VueDatePicker
          v-else
          ref="dayPickerRef"
          v-model="dayValue"
          :auto-apply="true"
          :hide-input="true"
          :inline="true"
          :max-date="maxDate"
          :time-config="{ enableTimePicker: false }"
          :year-range="yearRange"
          @update:model-value="onPickDay"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.scheduleNavDateBox {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.scheduleNavDate {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font-size: $font-size-16;
  color: #1e1e1e;
  font-weight: $font-weight-semibold;

  &__arrow {
    display: inline-block;
    width: 20px;
    height: 20px;

    // 텍스트 숨김 처리
    font-size: 0;
    color: transparent;

    // SVG 아이콘 배경 - #999 color Chevron
    --arrow-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239e9e9e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");

    background-image: var(--arrow-icon);
    background-repeat: no-repeat;
    background-position: center;
    background-size: 20px 20px;

    opacity: 1; // 기존 opacity 제거

    // Next arrow (오른쪽 화살표)는 180도 회전
    &:last-child {
      transform: rotate(180deg);
    }

    &:hover {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");
    }

    &.is-hidden {
      visibility: hidden;
      pointer-events: none;
    }
  }

  &__text {
    white-space: nowrap;
  }
}

.scheduleDatePopup {
  // fixed: 검색필터바가 overflow-x:auto(→ overflow-y 도 auto)라 absolute 면 바 높이 밖이 잘려
  // 달력이 화면에 안 보인다. 좌표는 트리거 기준으로 useSchedulerPeriodPicker 가 인라인으로 준다.
  position: fixed;
  z-index: 1000;

  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
}
</style>
