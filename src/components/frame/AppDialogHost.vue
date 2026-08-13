<script setup>
/**
 * 전역 alert/confirm 렌더러. 앱 셸에 1개만 마운트한다.
 * 상태·결과 확정은 `@/lib/useDialog` 가 소유하고 여기서는 표시와 입력만 담당.
 */
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { settleDialog, useDialogState } from '@/lib/useDialog'

const state = useDialogState()

// confirm 은 ESC/딤 클릭 = 취소, alert 은 = 확인(어느 쪽이든 닫히는 게 자연스럽다).
function dismiss() {
  settleDialog(state.kind === 'alert')
}

function onKeydown(e) {
  if (!state.open) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    dismiss()
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true))

// 다이얼로그가 떠 있는 동안 배경 스크롤 차단
watch(() => state.open, (open) => {
  document.body.style.overflow = open ? 'hidden' : ''
})
</script>

<template>
  <Teleport to="body">
    <div v-if="state.open" class="app-dialog__dim" @click.self="dismiss">
      <div class="app-dialog" role="dialog" aria-modal="true">
        <h2 class="app-dialog__title">{{ state.title }}</h2>
        <p class="app-dialog__message">{{ state.message }}</p>
        <div class="app-dialog__actions">
          <button
            v-if="state.kind === 'confirm'"
            type="button"
            class="app-dialog__btn app-dialog__btn--ghost"
            @click="settleDialog(false)"
          >
            {{ state.cancelText }}
          </button>
          <button
            type="button"
            class="app-dialog__btn app-dialog__btn--primary"
            autofocus
            @click="settleDialog(true)"
          >
            {{ state.okText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.app-dialog__dim {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
}

.app-dialog {
  width: min(420px, calc(100vw - 32px));
  padding: 24px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 12px 32px rgb(0 0 0 / 24%);
}

.app-dialog__title {
  margin: 0 0 12px;
  font-size: 17px;
  font-weight: 700;
}

.app-dialog__message {
  /* 메시지에 \n 이 들어온다 — 줄바꿈을 그대로 살린다. */
  margin: 0 0 24px;
  font-size: 14px;
  line-height: 1.6;
  color: #333;
  white-space: pre-line;
}

.app-dialog__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.app-dialog__btn {
  min-width: 76px;
  padding: 9px 16px;
  font-size: 14px;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 4px;
}

.app-dialog__btn--ghost {
  color: #444;
  background: #fff;
  border-color: #ccc;
}

.app-dialog__btn--primary {
  color: #fff;
  background: var(--bs-primary, #2f6fed);
}
</style>
