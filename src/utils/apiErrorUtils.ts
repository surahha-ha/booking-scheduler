/**
 * API 실패 응답 정규화.
 *
 * <p>호출부(예: SchedulerV3Page onCardCallback)는 `response.message` 를 그대로 토스트에 띄운다.
 * 그런데 WAS 의 `RestAuthenticationEntryPoint` 는 세션 만료 시 `message` 에 Spring Security 의
 * 영문 메시지(예: "Full authentication is required...")를 담아 보내므로 그대로 노출된다.
 * 여기서 401 만 한국어 안내로 바꾼다.
 *
 * <p><b>페이지 이동은 하지 않는다.</b> 저장 도중 세션이 끊겼을 때 메인으로 튕기면 입력하던 내용이
 * 사라진다. 화면을 유지한 채 안내만 하고, 재로그인 후 다시 시도할 수 있어야 한다.
 * 진입 차단은 라우터 가드(userStateUtils)의 몫이다.
 */

export const SESSION_EXPIRED_MESSAGE = '로그인이 만료되었습니다. 다시 로그인해 주세요.';

/** axios 에러에서 호출부에 돌려줄 실패 본문을 만든다. 401 이면 메시지를 교체한다. */
export function toErrorBody(e: any): any {
    const body = e?.response?.data;
    if (e?.response?.status === 401) {
        return {...body, code: 'failed', message: SESSION_EXPIRED_MESSAGE};
    }
    return body;
}
