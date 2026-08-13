// dev 부분 mock — 외부 연동 3건만 가로채고 자체 API 는 실제 네트워크로 나가야 한다.
// 특히 GET /staff(자체 DB 조회)가 mock 으로 새면 실제 담당자가 가짜로 덮여
// 이름 스냅샷(staffName) 매칭이 깨지고 실제 예약이 화면에서 사라진다 — 그 회귀를 막는다.
import {beforeEach, describe, expect, it, vi} from 'vitest';
import axios from 'axios';

const hoisted = vi.hoisted(() => ({api: null as any}));
vi.mock('@/lib/http', () => ({useApi: () => hoisted.api}));

import {installExternalMockAdapter} from '../index';

let realAdapter: any;

beforeEach(() => {
    realAdapter = vi.fn((config: any) => Promise.resolve({
        data   : {code: 'succeed', message: 'OK', payload: 'REAL'},
        status : 200,
        headers: {},
        config,
        request: {},
    }));
    hoisted.api = axios.create();
    hoisted.api.defaults.adapter = realAdapter;
    installExternalMockAdapter();
});

describe('installExternalMockAdapter — 외부 연동만 가로채기', () => {
    it.each([
        ['post', '/api/booking/v1/staff/sync'],
        ['get', '/api/booking/v1/work-state'],
        ['put', '/api/booking/v1/work-state/modify'],
    ])('%s %s — 외부 호출이라 mock 이 응답하고 네트워크로 안 나간다', async (method, url) => {
        await (hoisted.api as any)[method](url);
        expect(realAdapter).not.toHaveBeenCalled();
    });

    it.each([
        ['get', '/api/booking/v1/staff'],       // 자체 DB(담당자 테이블) — mock 금지
        ['post', '/api/booking/v1/staff/add'],  // 자체 DB INSERT
        ['get', '/api/booking'],                   // 예약 목록
        ['get', '/api/booking/v2/reservation-settings/settings'],  // 예약장부 설정
    ])('%s %s — 자체 API 라 실제 네트워크로 나간다', async (method, url) => {
        const res: any = await (hoisted.api as any)[method](url);
        expect(realAdapter).toHaveBeenCalledOnce();
        expect(res.data.payload).toBe('REAL');
    });

    it('쿼리스트링이 붙어도 대상 판정이 유지된다', async () => {
        await hoisted.api.put('/api/booking/v1/work-state/modify', undefined, {params: {enabled: 'Y'}});
        expect(realAdapter).not.toHaveBeenCalled();
    });
});
