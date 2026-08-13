// 상태변경/삭제 요청에 화면 구분(type)이 실리는지에 대한 회귀 가드.
// BE 는 type 을 못 받으면 RESERVATION_USE_TYPE 를 'CMM' 으로 덮어쓸 수 있어,
// 진료 화면에서 등록한 예약이 상태 변경 후 예약 화면에도 나타났었다.
import {beforeEach, describe, expect, it, vi} from 'vitest';

const hoisted = vi.hoisted(() => ({api: null as any}));
vi.mock('@/lib/http', () => ({useApi: () => hoisted.api}));

let put: any;
let del: any;

beforeEach(() => {
    put = vi.fn(async () => ({data: {}}));
    del = vi.fn(async () => ({data: {}}));
    hoisted.api = {put, delete: del, get: vi.fn(), post: vi.fn()};
    vi.resetModules();
});

async function loadApi() {
    return await import('../bookApi');
}

describe('updateStatus — 상태 변경 시 화면 구분 전달', () => {
    it('type=treatment 를 쿼리파라미터로 보낸다', async () => {
        const {updateStatus} = await loadApi();

        await updateStatus('100', 'complete', 'treatment');

        const [url, body, config] = put.mock.calls[0];
        expect(url).toBe('/api/booking/100/complete');
        expect(body).toBeUndefined();
        expect(config.params).toEqual({type: 'treatment'});
    });

    it('type 미전달 시 params 를 붙이지 않는다 (BE 가 기존 구분값 유지)', async () => {
        const {updateStatus} = await loadApi();

        await updateStatus('100', 'complete');

        expect(put.mock.calls[0][2].params).toBeUndefined();
    });
});

describe('remove — 삭제 시 화면 구분 전달', () => {
    it('type=treatment 를 쿼리파라미터로 보낸다', async () => {
        const {remove} = await loadApi();

        await remove('100', 'treatment');

        const [url, config] = del.mock.calls[0];
        expect(url).toBe('/api/booking/100/delete');
        expect(config.params).toEqual({type: 'treatment'});
    });

    it('type 미전달 시 params 를 붙이지 않는다', async () => {
        const {remove} = await loadApi();

        await remove('100');

        expect(del.mock.calls[0][1].params).toBeUndefined();
    });
});
