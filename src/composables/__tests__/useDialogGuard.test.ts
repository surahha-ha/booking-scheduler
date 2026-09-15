/**
 * useDialogGuard — 다이얼로그가 떠 있는 동안만 dialogOpen 이 true 다.
 *
 * 이 플래그를 보고 팝업이 ESC·바깥 클릭을 양보한다. 다이얼로그가 닫힌 뒤에도 true 로 남으면
 * 팝업이 영영 닫히지 않고(덫), 거부(reject)로 끝났을 때 못 내리면 같은 덫이 된다.
 */

import { describe, expect, it } from 'vitest'
import { useDialogGuard } from '../useDialogGuard'

describe('useDialogGuard', () => {
  it('🔑 다이얼로그가 떠 있는 동안 true, 닫히면 false — 결과는 그대로 돌려준다', async () => {
    const { dialogOpen, withDialog } = useDialogGuard()
    let release: (_v: boolean) => void = () => {}

    expect(dialogOpen.value).toBe(false)
    const pending = withDialog(() => new Promise<boolean>(r => { release = r }))
    expect(dialogOpen.value).toBe(true)

    release(true)
    await expect(pending).resolves.toBe(true)
    expect(dialogOpen.value).toBe(false)
  })

  it('다이얼로그가 거부로 끝나도 플래그는 내려간다 — 남으면 팝업이 영영 안 닫힌다', async () => {
    const { dialogOpen, withDialog } = useDialogGuard()

    await expect(withDialog(() => Promise.reject(new Error('닫힘')))).rejects.toThrow('닫힘')
    expect(dialogOpen.value).toBe(false)
  })

  it('동기 값을 돌려주는 호출도 같은 규약이다', async () => {
    const { dialogOpen, withDialog } = useDialogGuard()

    await expect(withDialog(() => 'ok')).resolves.toBe('ok')
    expect(dialogOpen.value).toBe(false)
  })
})
