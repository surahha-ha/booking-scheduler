<template>
  <div
    v-if="drag.isDragging.value"
    class="drag-preview"
    :class="{
      'is-invalid': !drag.dragState.value?.isValid,
      'is-no-change': drag.dragState.value?.isNoChange,
    }"
    :style="previewStyle"
  />
</template>

<script setup>
import { computed, inject } from 'vue'

const drag = inject('schedulerDrag')

const previewStyle = computed(() => {
  const state = drag.dragState.value
  if (!state) return { display: 'none' }
  const r = state.previewRect
  return {
    position: 'absolute',
    top: r.top + 'px',
    left: r.left + 'px',
    width: r.width + 'px',
    height: r.height + 'px',
  }
})
</script>

<style lang="scss" scoped>
@use '../../../../scss/schedule/v3/preview' as preview;

/* preview 박스 = drag/resize 공유(클래스명만 다름) → mixin 사용(scoped 유지). */
.drag-preview {
  @include preview.preview-box;
}
</style>
