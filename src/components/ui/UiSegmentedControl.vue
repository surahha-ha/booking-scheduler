<script setup>
defineProps({
  modelValue: {
    type: [String, Number],
    required: true,
  },
  items: {
    type: Array,
    default: () => [],
  },
});

const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <div class="scheduleSegment">
    <button
      v-for="item in items"
      :key="item.value"
      :aria-pressed="modelValue === item.value"
      :class="{ 'is-active': modelValue === item.value }"
      class="scheduleSegment__btn"
      type="button"
      @click="emit('update:modelValue', item.value)"
    >
      {{ item.label }}
    </button>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.scheduleSegment {
  display: inline-flex;
  align-items: center;

  &__btn {
    // 공통 스타일
    height: 24px;
    padding: 0 12px;
    border-radius: 0;
    border: 1px solid #a5a5a5;
    background: $color-surface;

    font-size: 14px;
    font-style: normal;
    font-weight: 500;
    color: $color-text-segment;

    cursor: pointer;

    &:first-child {
      border-radius: $radius-4 0 0 $radius-4;
    }

    &:last-child {
      border-radius: 0 $radius-4 $radius-4 0;
    }

    & + & {
      margin-left: -1px;
    }

    // 마우스 호버 (기본형)
    &:hover {
      text-decoration: underline;
    }

    &.is-active {
      // Active 스타일
      position: relative;
      z-index: 1;
      border-radius: $radius-4;
      border-color: $color-primary;
      color: $color-primary;
      font-weight: $font-weight-semibold;

      // 마우스 호버 (활성화)
      &:hover {
        text-decoration: none;
      }
    }
  }
}
</style>
