import {describe, expect, it} from 'vitest';
import {routes} from '../routes';
import * as db from '../db';
import {mockEnvelope} from '../index';
import {resolveDoctorKey} from '@/scheduler-engine/redesign/runLayoutAdapter';

function call(method: string, path: string, opts: {params?: any; body?: any} = {}) {
    // index.ts 의 매칭 로직을 축약 재현 (path 변수 추출 포함)
    const M = method.toUpperCase();
    for (const r of routes) {
        if (r.method !== M) continue;
        const ps = r.pattern.split('/').filter(Boolean);
        const xs = path.split('/').filter(Boolean);
        if (ps.length !== xs.length) continue;
        const pathParams: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < ps.length; i++) {
            if (ps[i].startsWith(':')) pathParams[ps[i].slice(1)] = xs[i];
            else if (ps[i] !== xs[i]) {ok = false; break;}
        }
        if (!ok) continue;
        return r.handle({params: opts.params ?? {}, body: opts.body, pathParams});
    }
    throw new Error(`no route: ${method} ${path}`);
}

const range = () => {
    const d = new Date();
    const s = new Date(d); s.setDate(s.getDate() - 3);
    const e = new Date(d); e.setDate(e.getDate() + 16);
    const f = (x: Date) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
    return {startDate: f(s), endDate: f(e)};
};

describe('mock routes smoke', () => {
    it('담당자 목록 payload', () => {
        const p = call('GET', '/api/booking/v1/staff');
        expect(p.length).toBeGreaterThan(0);
        expect(p[0]).toHaveProperty('staffId');
        expect(p[0]).toHaveProperty('staffName');
    });

    it('장부 조회 — 요일 그룹 + items, 의사명 정합', () => {
        const groups = call('GET', '/api/booking', {params: range()});
        expect(groups.length).toBeGreaterThan(0);
        const items = groups.flatMap((g: any) => g.items);
        expect(items.length).toBeGreaterThan(0);
        const names = new Set(db.doctors.map(d => d.staffName));
        expect(items.every((it: any) => names.has(it.staffName))).toBe(true);
        // 카드 렌더 필수 필드
        expect(items[0]).toHaveProperty('startAt');
        expect(items[0]).toHaveProperty('statusCode');
    });

    it('예약 추가 → 조회에 반영(stateful)', () => {
        const before = call('GET', '/api/booking', {params: range()}).flatMap((g: any) => g.items).length;
        const today = new Date();
        const dtm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}T10:00:00`;
        const created = call('POST', '/api/booking/add', {
            body: {startDate: dtm, endDate: dtm, externalStaffNo: 1, doctorName: '김민준', patientName: '테스트고객', patientPhone: '010-0000-0000', customerRefId: 7777},
        });
        expect(created.reservationId).toBeGreaterThan(0);
        const after = call('GET', '/api/booking', {params: range()}).flatMap((g: any) => g.items).length;
        expect(after).toBe(before + 1);
    });

    it('상태 변경(complete→01) 반영', () => {
        const groups = call('GET', '/api/booking', {params: range()});
        const id = groups.flatMap((g: any) => g.items)[0].reservationId;
        call('PUT', `/api/booking/${id}/complete`);
        expect(db.reservations.find(r => r.reservationId === id)!.statusCode).toBe('01');
    });

    it('삭제 → 조회에서 제외', () => {
        const groups = call('GET', '/api/booking', {params: range()});
        const id = groups.flatMap((g: any) => g.items)[0].reservationId;
        call('DELETE', `/api/booking/${id}/delete`);
        const stillThere = call('GET', '/api/booking', {params: range()})
            .flatMap((g: any) => g.items).some((it: any) => it.reservationId === id);
        expect(stillThere).toBe(false);
    });

    it('운영시간/설정/서비스 항목/팀 payload 스키마', () => {
        // 운영시간 원천 분리 2조회 (BE 계약 전환): site(사업장) + staff(담당자)
        const site = call('GET', '/api/booking/v2/schedule/work-hours/site');
        expect(site).toHaveProperty('site');
        expect(site).toHaveProperty('recurringOffRules');
        expect(call('GET', '/api/booking/v2/schedule/work-hours/staff')).toHaveProperty('staff');
        expect(call('GET', '/api/booking/v2/reservation-settings/settings')).toHaveProperty('slotUnitMinutes');
        expect(call('GET', '/api/booking/v2/schedule/settings')).toHaveProperty('teams');
        expect(call('GET', '/api/booking/v2/schedule/teams').teams.length).toBeGreaterThan(0);
        expect(call('GET', '/api/booking/service-items/groups').length).toBeGreaterThan(0);
        expect(typeof call('GET', '/api/booking/v1/work-state')).toBe('boolean');
    });

    it('봉투는 공통 인터셉터를 bail 시켜야(raw 응답) — status·code·message 셋 다 있으면 안 됨', () => {
        const env = mockEnvelope({x: 1});
        // 인터셉터 가공 진입 조건: ['status','code','message'].every(k => k in body). 반드시 false.
        expect(['status', 'code', 'message'].every(k => k in env)).toBe(false);
        // store 는 res.data.payload 를 읽는다 — payload 키 존재 보장
        expect(env).toHaveProperty('payload');
    });

    it('name 모드 컬럼 매칭 — 예약은 externalStaffNo(번호)가 아니라 staffName(이름)으로 그룹핑돼야', () => {
        // 시드 예약의 externalStaffNo 는 falsy(0) 여야 한다 (truthy 면 resolveDoctorKey 가 번호로 그룹핑→카드 전멸)
        expect(db.reservations.every(r => !r.externalStaffNo)).toBe(true);
        // applyBookItemToAppointment 재현: doctorId = externalStaffNo ? String : ''
        const it0 = db.reservations[0];
        const appt = {doctorId: it0.externalStaffNo ? String(it0.externalStaffNo) : '', doctorName: it0.staffName} as any;
        // 컬럼 id = 의사 이름. resolveDoctorKey 도 이름을 반환해야 매칭됨.
        expect(resolveDoctorKey(appt)).toBe(it0.staffName);
        expect(db.doctors.some(d => d.staffName === resolveDoctorKey(appt))).toBe(true);
    });

    it('통계 모수 = 목록 모수 — 조회 기간 밖 예약은 세지 않는다', () => {
        // 회귀: 통계가 전건 집계라 보드에 없는 예약까지 세었다(회원 6건 표기 ↔ 주황 이름 0개).
        const params = range();
        const boardItems = call('GET', '/api/booking', {params}).flatMap((g: any) => g.items);

        const member = call('GET', '/api/booking/statistics/member', {params});
        const memberTotal = member.reduce((a: number, r: any) => a + r.cnt, 0);
        expect(memberTotal).toBe(boardItems.length);
        expect(member.find((r: any) => r.memberYn === 'Y').cnt)
            .toBe(boardItems.filter((it: any) => it.memberYn === 'Y').length);

        const state = call('GET', '/api/booking/statistics/state', {params});
        expect(state.reduce((a: number, r: any) => a + r.cnt, 0)).toBe(boardItems.length);
    });

    it('통계는 의사 필터를 반영한다 (보드 컬럼과 정합)', () => {
        const params = {...range(), doctorName: [db.reservations[0].staffName]};
        const boardItems = call('GET', '/api/booking', {params}).flatMap((g: any) => g.items);
        const member = call('GET', '/api/booking/statistics/member', {params});
        expect(member.reduce((a: number, r: any) => a + r.cnt, 0)).toBe(boardItems.length);
        expect(boardItems.every((it: any) => it.staffName === params.doctorName[0])).toBe(true);
    });

    it('modify 와 updateStatus 패턴 충돌 없음 (modify 우선)', () => {
        // /api/booking/modify/:id 는 PUT modify 로, /api/booking/:id/:state 로 새지 않아야
        const groups = call('GET', '/api/booking', {params: range()});
        const id = groups.flatMap((g: any) => g.items)[0].reservationId;
        const dtm = db.reservations.find(r => r.reservationId === id)!.startAt;
        const res = call('PUT', `/api/booking/modify/${id}`, {body: {startDate: dtm, endDate: dtm, externalStaffNo: 2, doctorName: '이서연', patientName: '수정됨', patientPhone: '010-1111-2222', customerRefId: 1}});
        expect(res.customerName).toBe('수정됨');
        expect(res.staffName).toBe('이서연');
    });
});
