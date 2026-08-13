<script setup>
/* 캘린더 셀 entries 더보기 popover 셸.
 * 헤더(날짜 + 휴무 라벨 + 닫기)와 스크롤 컨테이너만 제공.
 * entry 렌더링은 호출처가 slot 으로 주입 (View: 읽기 전용 div, Setting: 편집 트리거 button).
 *
 * 외부 클릭/스크롤 close 는 호출처 책임 — 여러 popover 를 함께 닫는 호출처 통합 로직과 충돌 방지 */
defineProps({
  open     : {type: Boolean, default: false},
  top      : {type: Number, default: 0},
  left     : {type: Number, default: 0},
  dayNumber: {type: Number, default: 0},
  isOff    : {type: Boolean, default: false},
});

const emit = defineEmits(['close']);
</script>

<template>
  <Teleport to="body">
    <div
        v-if="open"
        :style="{
          top : `${top}px`,
          left: `${left}px`,
        }"
        class="cellMorePopover"
        @click.stop
        @mousedown.stop
        @pointerdown.stop
    >
      <header class="cellMorePopover__header">
        <span class="cellMorePopover__date">{{ dayNumber }}</span>
        <span
            v-if="isOff"
            class="cellMorePopover__offLabel"
        >휴무</span>
        <button
            aria-label="닫기"
            class="cellMorePopover__close"
            type="button"
            @click="emit('close')"
        >×</button>
      </header>
      <div class="cellMorePopover__list">
        <slot />
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.cellMorePopover {
  position: fixed;
  z-index: 2000;
  min-width: 180px;
  max-width: 280px;
  padding: 8px 10px;
  background: #fff;
  border: 1px solid $color-border-light;
  border-radius: $radius-2;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  gap: 4px;

  &__header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid $color-border-light;
  }

  &__date {
    font-size: $font-size-13;
    font-weight: $font-weight-medium;
    color: $color-text-default;
  }

  &__offLabel {
    font-size: $font-size-11;
    font-weight: $font-weight-bold;
    color: $color-danger;
    padding: 1px 4px;
    border: 1px solid $color-danger;
    border-radius: $radius-2;
    line-height: 1;
  }

  &__close {
    margin-left: auto;
    width: 18px;
    height: 18px;
    border: 0;
    background: transparent;
    cursor: pointer;
    color: $color-text-muted;
    font-size: $font-size-14;
    line-height: 1;
    padding: 0;

    &:hover { color: $color-text-default; }
  }

  &__list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 320px;
    overflow-y: auto;
  }
}
</style>
