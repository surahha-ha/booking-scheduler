<script setup>
import {computed, ref, watch} from 'vue';
import {useCheckBoxSelection} from '@/composables/useCheckBoxSelection';
import {ALL_BUTTON_ITEM, FIX_ALL, PAGE_SIZE_DOCTOR_FILTER} from '@/constants/componentConstants';

/* 선택 상태는 v-model 로 주고받는다 — 이 컴포넌트는 특정 스토어에 묶이지 않는다.
 * 예약장부는 useSchedulerFilterStore 를, 운영일정 보기는 자기 화면의 로컬 상태를 연결한다
 * (두 화면의 필터가 서로 연동되면 안 되므로).
 * ★빈 배열 = "전체 선택" 이다(isAllEmpty). 아무도 안 고른 상태가 아니다. */
const props = defineProps({
  buttonItems: {
    type   : Array,
    default: () => [],
  },
  modelValue : {
    type   : Array,
    default: () => [],
  },
});

const emit = defineEmits(['update:modelValue']);

const selectedDoctors = computed(() => props.modelValue ?? []);

const doctorSelection = useCheckBoxSelection({
  items                 : () => props.buttonItems,
  selectedValues        : selectedDoctors,
  onChange              : (ids) => emit('update:modelValue', ids),
  normalizeOnItemsChange: true, // 동적으로 변경하는 검색 값이면 true
  isAllEmpty            : true
});

const {
  isAllSelected: isAllSelectedByItems,
  isActive     : isDoctorActive,
  selectAll,
  toggle
} = doctorSelection;

/* 표시할 의사가 없어도 '전체'는 켜진 채로 보여준다.
 * 규약상 빈 배열 = 전체라 선택 상태는 이미 '전체'인데, useCheckBoxSelection 은 항목이 0개면
 * "전원 선택"을 판정할 수 없어 false 를 준다. 그대로 쓰면 필터가 꺼진 것처럼 보인다.
 * ⚠️ buttonItems 가 비는 경로는 "담당자 원장 0명"이 아니다 — 그건 bookStore 게이트가
 *   사업장 설정로 내보내 이 화면에 도달하지 못한다. 실제 경로는 팀 표시 필터(resolveVisibleDoctors)의
 *   결과가 빌 때: 선택한 팀에 멤버가 0명 · 전원이 팀 소속이라 '미지정' 그룹이 빔. */
const isAllDoctorsSelected = computed(
    () => (props.buttonItems ?? []).length === 0 || isAllSelectedByItems.value
);

/* 이미 전체면 아무것도 하지 않는다 — 목록이 비었을 때 무의미한 빈 배열 emit(→ 재조회)을 막는다. */
function onSelectAll() {
  if (isAllDoctorsSelected.value) return;
  selectAll();
}

const offset = ref(0);

function getPageStart(pageOffset) {
  return pageOffset * PAGE_SIZE_DOCTOR_FILTER;
}

const allItems = computed(() => [ALL_BUTTON_ITEM, ...props.buttonItems]);

// 최대 페이지 index
const maxOffset = computed(() => {
  const total = props.buttonItems.length;

  if (FIX_ALL) {
    return Math.max(0, Math.ceil(total / PAGE_SIZE_DOCTOR_FILTER) - 1);
  }

  return Math.max(0, Math.ceil(allItems.value.length / PAGE_SIZE_DOCTOR_FILTER) - 1);
});

// 화면에 노출되는 button Items
const visibleItems = computed(() => {
  const start = getPageStart(offset.value);

  if (FIX_ALL) {
    return props.buttonItems.slice(start, start + PAGE_SIZE_DOCTOR_FILTER);
  }

  // 전체도 같이 이동
  return allItems.value.slice(start, start + PAGE_SIZE_DOCTOR_FILTER);
});

// buttonItems 변경 시 offset이 범위를 초과하지 않도록 clamp
watch(maxOffset, (max) => {
  if (offset.value > max) offset.value = max;
});

const isPrevDisabled = computed(() => offset.value === 0);
const isNextDisabled = computed(() => offset.value >= maxOffset.value);

function prev() {
  if (!isPrevDisabled.value) offset.value--;
}

function next() {
  if (!isNextDisabled.value) offset.value++;
}
</script>

<template>
  <div class="scheduleDoctorFilter">
    <!-- Prev Arrow -->
    <button
        :disabled="isPrevDisabled"
        aria-label="이전 담당자 목록"
        class="scheduleDoctorFilter__arrow"
        type="button"
        @click="prev"
    />

    <!-- Items -->
    <div class="scheduleDoctorFilter__list">
      <label
          v-if="FIX_ALL"
          :key="'ALL_FIXED'"
          class="scheduleDoctorFilter__item"
          @click.prevent="onSelectAll"
      >
        <input
            :checked="isAllDoctorsSelected"
            :class="['scheduleDoctorFilter__check', { 'is-checked': isAllDoctorsSelected }]"
            type="checkbox"
        >
        <span class="scheduleDoctorFilter__label">의사</span>
      </label>

      <label
          v-for="item in visibleItems"
          :key="String(item.value)"
          class="scheduleDoctorFilter__item"
          @click.prevent="item.type === 'ALL' ? onSelectAll() : toggle(item.value)"
      >
        <input
          v-if="item.type === 'ALL'"
          :checked="isAllDoctorsSelected"
          :class="['scheduleDoctorFilter__check', { 'is-checked': isAllDoctorsSelected }]"
          type="checkbox"
        />

        <input
          v-else
          :checked="isDoctorActive(item.value)"
          :class="['scheduleDoctorFilter__check', { 'is-checked': isDoctorActive(item.value) }]"
          type="checkbox"
        />
        <span class="scheduleDoctorFilter__label">
          {{ item.label }}
          <span v-if="item.isPrivate" class="scheduleDoctorFilter__badge">비공개</span>
        </span>
      </label>
    </div>

    <!-- Next Arrow -->
    <button
        :disabled="isNextDisabled"
        aria-label="다음 담당자 목록"
        class="scheduleDoctorFilter__arrow"
        type="button"
        @click="next"
    />
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.scheduleDoctorFilter {
  display: inline-flex;
  align-items: center;
  gap: 4px;

  &__list {
    display: inline-flex;
    gap: 14px;
  }

  &__item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: 14px;
    color: #000;
    user-select: none;
  }

  &__label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  // 비공개(openYn='N') 담당자 표시 뱃지 (#1)
  &__badge {
    flex-shrink: 0;
    padding: 0 5px;
    border-radius: 8px;
    background: #eee;
    color: #888;
    font-size: 11px;
    line-height: 16px;
  }

  &__check {
    appearance: none;
    -webkit-appearance: none;
    pointer-events: none;
    cursor: pointer;
    width: 14px;
    height: 14px;

    border-radius: 2px;
    border: 1px solid #C4C4C4;
    background: #FFF;

    &:checked,
    &.is-checked {
      background-color: $color-primary;
      border-color: $color-primary;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E");
      background-size: 100% 100%;
      background-position: center;
      background-repeat: no-repeat;
    }
  }

  // 화살표 버튼 (DateNavigator와 유사 스타일)
  &__arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: 0;
    background: transparent;
    cursor: pointer;

    font-size: 0;
    color: transparent;

    --arrow-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239e9e9e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");

    background-image: var(--arrow-icon);
    background-repeat: no-repeat;
    background-position: center;
    background-size: 20px 20px;

    &:last-child {
      transform: rotate(180deg);
    }

    &:not(:disabled):hover {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");
    }

    &:disabled {
      opacity: 0.2;
      cursor: default;
    }
  }
}
</style>
