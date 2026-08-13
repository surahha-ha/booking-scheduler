// ============================================================================
// HTTP 클라이언트 — 앱 전역 axios 싱글턴
// ============================================================================
import axios, {type AxiosInstance} from 'axios';
import qs from 'qs';

/**
 * 응답 인터셉터를 두지 않는다.
 *
 * API 응답 봉투는 `{code, message, payload}` 이고 store 들은
 * `unwrapBody(res) = res.data ?? res` 로 raw AxiosResponse 를 직접 다룬다.
 * 여기서 `data` 를 미리 벗기면 그 규약이 전부 깨진다.
 */
const api: AxiosInstance = axios.create({
    baseURL        : '/api',
    withCredentials: true,
    // 배열 파라미터는 콤마 결합 — `staffName=A,B,C`. 형식이 바뀌면 목록 필터가 깨진다.
    paramsSerializer: params => qs.stringify(params, {arrayFormat: 'comma'}),
});

api.defaults.headers.post['Content-Type'] = 'application/json';

/** 전역 axios 인스턴스를 돌려준다. */
export function useApi(): AxiosInstance {
    return api;
}

export default api;
