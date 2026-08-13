// 실제 axios 인스턴스에 공통 응답 인터셉터(원문 복제) + mock adapter 를 붙여
// "호출부가 올바른 payload 를 받는가"를 end-to-end 로 검증한다.
import {describe, expect, it} from 'vitest';
import axios from 'axios';
import {createMockAdapter} from '../index';

// ── 과거 공통 응답 인터셉터 재현 ──
function buildApiLikeDnsCore() {
    const api = axios.create();
    const is4xx = (s: number) => s >= 400 && s < 500;
    const is5xx = (s: number) => s >= 500 && s < 600;
    const isError = (s: number) => is4xx(s) || is5xx(s);
    api.interceptors.response.use(
        (response: any) => {
            if (!['status', 'code', 'message'].every(name => name in response.data)) {
                return response; // ← 서버 응답 봉투(status 없음)는 여기서 raw 반환
            }
            const {config, data, request} = response;
            const {code, data: items, totalCount, message, status} = data;
            if (isError(status)) {
                throw new axios.AxiosError(message, code, config, request, response);
            }
            let result = items;
            if (typeof totalCount !== 'undefined') result = {data: result, totalCount};
            return result;
        },
    );
    api.defaults.adapter = createMockAdapter({latencyMs: 0, log: false});
    return api;
}

const ymd = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

describe('mock adapter × 공통 인터셉터 end-to-end', () => {
    it('인터셉터가 bail → 호출부는 res.data.payload 로 접근 가능(raw 응답)', async () => {
        const api = buildApiLikeDnsCore();
        const res: any = await api.get('/api/booking/v1/staff');
        // 인터셉터가 raw 응답을 반환해야 한다(가공되어 payload 가 통째로 사라지면 안 됨)
        expect(res).toHaveProperty('data');
        expect(res.data).toHaveProperty('payload');
        expect(Array.isArray(res.data.payload)).toBe(true);
        expect(res.data.payload.length).toBeGreaterThan(0);
        expect(res.data.payload[0]).toHaveProperty('staffName');
    });

    it('장부 조회 — 오늘 포함 윈도우에 예약 payload 존재', async () => {
        const api = buildApiLikeDnsCore();
        const res: any = await api.get('/api/booking', {params: {startDate: ymd(-3), endDate: ymd(16)}});
        const groups = res.data.payload;
        expect(Array.isArray(groups)).toBe(true);
        const items = groups.flatMap((g: any) => g.items ?? []);
        expect(items.length).toBeGreaterThan(0);
    });

    // 진료는 시작~종료 단일 구간(3세션 폐기). 휴게(lunch/dinner)는 기관(site)만 소유한다.
    // BE 계약 전환: 번들 all → 원천 분리 2조회(work-hours/site · work-hours/staff).
    it('운영시간(site) — 요일별 단일 구간 + 휴게 + 휴무 규칙 strict 번들로 저장 게이트를 통과시킨다', async () => {
        const api = buildApiLikeDnsCore();
        const res: any = await api.get('/api/booking/v2/schedule/work-hours/site');
        const site = res.data.payload.site;
        expect(Array.isArray(site)).toBe(true);

        const monday = site.find((r: any) => r.dayCd === 1);
        expect(monday.openHm).toBe('0900');
        expect(monday.closeHm).toBe('1800');
        // 평일 휴게시간1(점심) 13:00~14:00, 휴게시간2(저녁)는 미설정
        expect(monday.lunchStartHm).toBe('1300');
        expect(monday.lunchEndHm).toBe('1400');
        expect(monday.dinnerStartHm).toBeNull();
        // institutionToWeekly 가 기대하는 4자리 HHMM 포맷인지
        expect(/^\d{4}$/.test(monday.openHm)).toBe(true);

        // 요일마다 다를 수 있다 — 토요일은 09~13, 휴게 없음. 일요일은 site 행이 없다(매주 휴무 → recurringOffRules).
        const saturday = site.find((r: any) => r.dayCd === 6);
        expect(saturday.closeHm).toBe('1300');
        expect(saturday.lunchStartHm).toBeNull();
        expect(site.find((r: any) => r.dayCd === 0)).toBeUndefined();
        // 휴무 이중표현: 일요일은 site 생략 + recurringOffRules WEEKLY 로 존재해야 사업장 설정에 휴무로 남는다.
        expect(res.data.payload.recurringOffRules).toContainEqual({dayCd: 0, repeatTy: 'WEEKLY', monthlyNth: null});
    });

    it('운영시간(staff) — 담당자 행은 진료 시작/종료만 갖는다(휴게 필드/USE_YN 없음)', async () => {
        const api = buildApiLikeDnsCore();
        const res: any = await api.get('/api/booking/v2/schedule/work-hours/staff');
        const staff = res.data.payload.staff[0];
        const staffMonday = staff.times.find((r: any) => r.dayCd === 1);
        expect(Object.keys(staffMonday).sort()).toEqual(['dayCd', 'staffCloseHm', 'staffOpenHm']);
        expect(res.data.payload).toHaveProperty('overrides');
    });

    it('통계 2종은 배열(FE reduce 대상)', async () => {
        const api = buildApiLikeDnsCore();
        const m: any = await api.get('/api/booking/statistics/member');
        const s: any = await api.get('/api/booking/statistics/state');
        expect(Array.isArray(m.data.payload)).toBe(true);
        expect(Array.isArray(s.data.payload)).toBe(true);
    });

    it('사업장 설정 운영중 상태 — boolean payload', async () => {
        const api = buildApiLikeDnsCore();
        const res: any = await api.get('/api/booking/v1/work-state');
        expect(typeof res.data.payload).toBe('boolean');
    });
});
