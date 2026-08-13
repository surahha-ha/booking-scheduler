<script setup>
import {isLabelFixedMode} from '@/constants/componentConstants';
const props = defineProps({
  modelValue : {
    type    : String,
    required: true,
  },
  buttonItems: {
    type   : Array, // [{ label, value }]
    default: () => [],
  },
  statistics : {
    type   : Object,
    default: () => ({}),
  },
});

const emit = defineEmits(['update:modelValue']);

// 통합회원 여부 viewMode

function getCount(value) {
  return props?.statistics[value] ?? 0;
}
</script>

<template>
  <div class="scheduleMemberToggle">
    <button
        v-for="item in buttonItems"
        v-if="isLabelFixedMode"
        :key="item.value"
        :class="{
          'is-active': 'Y' === item.value,
          'is-non-member': 'N' === item.value,
        }"
        class="scheduleMemberToggle__btn"
        style="cursor: default;"
        type="button"
        @click.stop="false"
    >
      <img
          v-if="item.value === 'Y'"
          alt=""
          aria-hidden="true"
          class="scheduleMemberToggle__icon"
          src="@/assets/icons/vector.svg"
      >
      {{ item.label }}
      <span class="scheduleMemberToggle__count">
        {{ getCount(item.value) }}
      </span>
    </button>
    <button
        v-for="item in buttonItems"
        v-else
        :key="item.value"
        :class="{
          'is-active': modelValue === item.value,
          'is-non-member': 'N' === item.value,
        }"
        class="scheduleMemberToggle__btn"
        type="button"
        @click.stop="emit('update:modelValue', item.value)"
    >
      <img
          v-if="item.value === 'Y'"
          alt=""
          aria-hidden="true"
          class="scheduleMemberToggle__icon"
          src="@/assets/icons/vector.svg"
      >
      {{ item.label }}
      <span class="scheduleMemberToggle__count">
        {{ getCount(item.value) }}
      </span>
    </button>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.scheduleMemberToggle {
  display: inline-flex;
  align-items: center;
  gap: 0px;
  font-size: $font-size-14;

  &__btn {
    border: 0;
    background: transparent;
    cursor: pointer;
    color: $color-text-black;
    padding: 0;
    display: inline-flex;
    align-items: center;

    &.is-active {
      color: $color-current-time;
      font-weight: $font-weight-bold;
    }

    &.is-non-member {
      color: $color-text-black;
      font-weight: $font-weight-semibold;
    }

    // items 사이의 구분선(|) 처리
    // button + button 인 경우 가상요소로 구분선 추가
    & + &::before {
      content: '|';
      margin: 0 8px;
      color: rgba(0, 0, 0, 0.3);
    }
  }

  &__icon {
    flex: 0 0 $space-12;
    width: $space-12;
    height: $space-12;
    margin-right: $space-4;
    transform: translateY(-1px);
  }

  &__count {
    margin-left: 4px;
    font-weight: $font-weight-bold;
  }
}
</style>
