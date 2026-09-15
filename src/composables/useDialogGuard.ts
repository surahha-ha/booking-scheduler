import { nextTick, ref } from 'vue'

/**
 * 화면이 띄운 다이얼로그(alert/confirm)가 떠 있는 동안을 표시하는 가드.
 *
 * document capture 로 ESC 를 잡거나 바깥 클릭으로 닫히는 팝업은, 자기가 띄운 확인창 위의 ESC·클릭까지
 * 자기 것으로 가로챈다 — 삭제 확인 중 ESC 가 닫기 확인을 겹쳐 띄우고, 확인창의 [확인] 클릭이 팝업
 * 바깥 클릭으로 잡혀 입력을 날리던 결함이 그것이다. 호출 지점마다 플래그를 여닫으면 언젠가 빠뜨리고,
 * 빠뜨린 그 다이얼로그 위에서 같은 결함이 난다. 그래서 다이얼로그 호출은 전부 `withDialog` 를 지난다.
 *
 * 사용: `const { dialogOpen, withDialog } = useDialogGuard()`
 *   - ESC/바깥 클릭 핸들러 첫 줄에서 `if (dialogOpen.value) return`
 *   - DxPopup 이면 `:hide-on-outside-click="!dialogOpen"`
 *   - `await withDialog(() => dialog.confirm(...))`
 */
export function useDialogGuard() {
  const dialogOpen = ref(false)

  async function withDialog<T>(open: () => Promise<T> | T): Promise<T> {
    dialogOpen.value = true
    try {
      return await open()
    } finally {
      // 해제는 한 tick 뒤에 한다 — 다이얼로그의 [확인] 클릭과 팝업의 닫힘 판정이 같은 클릭에서
      // 이어지므로, 닫히자마자 풀면 가드가 걸리기 전에 false 가 된다(운영일정 설정 화면 실측).
      await nextTick()
      dialogOpen.value = false
    }
  }

  return { dialogOpen, withDialog }
}
