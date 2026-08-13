/**
 * 실패 응답 정규화 — 세션 만료(401) 안내 계약.
 *
 * 지키는 것:
 *  ① 401 이면 WAS 의 영문 메시지 대신 한국어 안내로 바꾼다(호출부가 message 를 그대로 토스트에 띄우므로).
 *  ② 401 이 아닌 실패는 BE 가 준 본문을 손대지 않는다.
 *  ③ 어떤 경우에도 페이지 이동을 유발하지 않는다 — 저장 중이던 입력을 지켜야 한다.
 */

import { describe, expect, it } from 'vitest'
import { SESSION_EXPIRED_MESSAGE, toErrorBody } from '@/utils/apiErrorUtils'

/** axios 에러 모양 — response.status + response.data(ApiResult). */
function axiosError(status: number, data: unknown) {
  return { response: { status, data } }
}

describe('toErrorBody', () => {
  it('401 이면 영문 메시지를 한국어 안내로 바꾼다', () => {
    const e = axiosError(401, {
      code   : 'failed',
      message: 'Full authentication is required to access this resource',
    })

    expect(toErrorBody(e)).toEqual({ code: 'failed', message: SESSION_EXPIRED_MESSAGE })
  })

  it('401 이면 code 가 없던 응답에도 failed 를 채워 호출부의 succeed 분기를 타지 않게 한다', () => {
    const e = axiosError(401, {})

    expect(toErrorBody(e)).toEqual({ code: 'failed', message: SESSION_EXPIRED_MESSAGE })
  })

  it('401 이 아닌 실패는 BE 본문을 그대로 돌려준다', () => {
    const body = { code: 'failed', message: '이미 처리중인 요청입니다.' }

    expect(toErrorBody(axiosError(500, body))).toBe(body)
    expect(toErrorBody(axiosError(403, body))).toBe(body)
  })

  it('response 가 없는 에러(네트워크 단절 등)는 undefined 로 끝난다', () => {
    expect(toErrorBody(new Error('Network Error'))).toBeUndefined()
    expect(toErrorBody(undefined)).toBeUndefined()
  })
})
