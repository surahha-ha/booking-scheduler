import {describe, expect, it} from 'vitest';
import {normalizeName, normalizeTeamName, resolveVisibleDoctors, toDisplayStatus, toStatusCodes, toStatusLabel} from '@/utils/schedulerSearchFilterUtils';

describe('toDisplayStatus (화면별 상태 표시 코드 — 예약 화면은 00·03 만 구분)', () => {
    it('예약 화면: 예약(00)·취소(03)는 그대로', () => {
        expect(toDisplayStatus('00', 'APPOINTMENT')).toBe('00');
        expect(toDisplayStatus('03', 'APPOINTMENT')).toBe('03');
    });

    it('예약 화면: 진료완료(01)·미이행(02)·접수대기(05)는 예약(00)으로 표기', () => {
        expect(toDisplayStatus('01', 'APPOINTMENT')).toBe('00');
        expect(toDisplayStatus('02', 'APPOINTMENT')).toBe('00');
        expect(toDisplayStatus('05', 'APPOINTMENT')).toBe('00');
    });

    it('예약 화면: 상태 미지정(undefined/빈값)도 예약(00)으로 표기', () => {
        expect(toDisplayStatus(undefined, 'APPOINTMENT')).toBe('00');
        expect(toDisplayStatus('', 'APPOINTMENT')).toBe('00');
    });

    it('진료 화면: 실제 상태를 그대로 쓴다', () => {
        for (const s of ['00', '01', '02', '03', '05']) {
            expect(toDisplayStatus(s, 'TREATMENT')).toBe(s);
        }
    });
});

describe('normalizeName (이름 키 정규화)', () => {
    it('특수문자 제거 + trim', () => {
        expect(normalizeName(' 김의사(원장) ')).toBe('김의사원장');
    });
    it('다중 공백 압축(내부 단일 공백은 유지)', () => {
        expect(normalizeName('김  의사')).toBe('김 의사');
    });
    it('null/undefined → 빈문자', () => {
        expect(normalizeName(null)).toBe('');
        expect(normalizeName(undefined)).toBe('');
    });
});

describe('normalizeTeamName (팀명 키 정규화 — 숫자 보존)', () => {
    it('숫자 보존(의사용 normalizeName 과 달리 충돌 안 함)', () => {
        expect(normalizeTeamName('1담당 팀')).toBe('1담당 팀');
        expect(normalizeTeamName('2담당 팀')).toBe('2담당 팀');
        // 회귀 근거: normalizeName 은 숫자를 제거해 둘이 같은 키로 붕괴
        expect(normalizeName('1담당 팀')).toBe(normalizeName('2담당 팀'));
    });
    it('앞뒤 공백/다중 공백만 정리', () => {
        expect(normalizeTeamName('  1진료  팀 ')).toBe('1진료 팀');
    });
});

describe('resolveVisibleDoctors (진료 팀 표시 필터 — 이름 통일 key)', () => {
    const doctors = [
        {id: '김의사', text: '김의사'},
        {id: '최의사', text: '최의사'},
        {id: '이의사', text: '이의사'},
        {id: '박직원', text: '박직원'},
    ];
    const teams = [
        {id: 1, name: '보철팀', doctors: [{staffName: '김의사'}, {staffName: '최의사'}]},
        {id: 2, name: '교정팀', doctors: [{staffName: '이의사'}]},
    ];

    it('미지정(null) = 담당자 목록 − 모든 팀멤버 이름', () => {
        expect(resolveVisibleDoctors(null, doctors, teams).map(d => d.id)).toEqual(['박직원']);
    });
    it('특정 팀(이름) = 담당자 목록 ∩ 그 팀멤버 이름', () => {
        expect(resolveVisibleDoctors('보철팀', doctors, teams).map(d => d.id)).toEqual(['김의사', '최의사']);
    });
    it('빈 문자열도 미지정 취급', () => {
        expect(resolveVisibleDoctors('', doctors, teams).map(d => d.id)).toEqual(['박직원']);
    });
    it('★회귀: 숫자로만 구분되는 팀명도 각 팀 멤버로 정확히 분리 (1담당 팀≠2담당 팀)', () => {
        const numTeams = [
            {id: 1, name: '1담당 팀', doctors: [{staffName: '김의사'}, {staffName: '최의사'}]},
            {id: 2, name: '2담당 팀', doctors: [{staffName: '이의사'}]},
        ];
        // 버그 시 둘 다 1담당 팀(첫 팀) 멤버로 붕괴됐음 → 각 팀 멤버로 분리돼야 함
        expect(resolveVisibleDoctors('1담당 팀', doctors, numTeams).map(d => d.id)).toEqual(['김의사', '최의사']);
        expect(resolveVisibleDoctors('2담당 팀', doctors, numTeams).map(d => d.id)).toEqual(['이의사']);
    });
    it('팀 없음(빈 teams) → 미지정 = 담당자 전체', () => {
        expect(resolveVisibleDoctors(null, doctors, []).map(d => d.id)).toEqual(['김의사', '최의사', '이의사', '박직원']);
    });
    it('존재하지 않는 팀명 → 빈 결과', () => {
        expect(resolveVisibleDoctors('없는팀', doctors, teams)).toEqual([]);
    });
    it('팀명 앞뒤/다중 공백만 정규화 매칭 (숫자·특수문자는 보존 — normalizeTeamName)', () => {
        expect(resolveVisibleDoctors('  보철팀  ', doctors, teams).map(d => d.id)).toEqual(['김의사', '최의사']);
    });
    it('의사 이름 특수문자 정규화 매칭 (담당자명 정규화 id vs 팀 raw staffName)', () => {
        const docs = [{id: '김의사원장', text: '김의사원장'}]; // 담당자: 특수문자 제거됨
        const t = [{id: 1, name: '보철팀', doctors: [{staffName: '김의사(원장)'}]}]; // 팀: raw
        expect(resolveVisibleDoctors('보철팀', docs, t).map(d => d.id)).toEqual(['김의사원장']);
    });

    it('담당자 메타(text)를 보존한다', () => {
        expect(resolveVisibleDoctors('교정팀', doctors, teams)).toEqual([{id: '이의사', text: '이의사'}]);
    });

    it('특정 팀 = team.doctors(SORT_ORD) 순서대로 반환 — 담당자 배열 순서 무시 [item1 순서반영]', () => {
        // 담당자 배열은 김의사→최의사 순이지만, 팀 SORT_ORD 는 최의사→김의사 → 그 순서로 나와야 함.
        const t = [{id: 1, name: '보철팀', doctors: [{staffName: '최의사'}, {staffName: '김의사'}]}];
        expect(resolveVisibleDoctors('보철팀', doctors, t).map(d => d.id)).toEqual(['최의사', '김의사']);
    });

    it('팀에 doctors 가 없어도(null) 크래시 없이 동작 — BE 팀 재등록 과도기 방어 (line 134/137 가드)', () => {
        // 팀 삭제·재등록 이력으로 doctors=null 인 빈 팀이 응답에 섞일 수 있음.
        const teamsWithNull = [
            {id: 1, name: '보철팀', doctors: [{staffName: '김의사'}]},
            {id: 2, name: '빈팀', doctors: undefined},
        ] as any;
        // 미지정(line 137): 보철팀 멤버(김의사) 제외, null 팀은 멤버 0 취급
        expect(() => resolveVisibleDoctors(null, doctors, teamsWithNull)).not.toThrow();
        expect(resolveVisibleDoctors(null, doctors, teamsWithNull).map(d => d.id)).toEqual(['최의사', '이의사', '박직원']);
        // 특정 팀이 doctors null(line 134): 빈 결과
        expect(resolveVisibleDoctors('빈팀', doctors, teamsWithNull)).toEqual([]);
    });
});

// 기대값 출처: 상수 APPOINTMENT/TREATMENT_STATUS_TYPE 의 주석(예약 00 · 취소 03 · 접수대기 05 · 진료완료 01 · 미이행 02).
describe('toStatusCodes (상태 필터 키 → 코드 목록, 빈 선택 = 전체)', () => {
    it('키를 코드로 바꾸고 중복은 한 번만', () => {
        expect(toStatusCodes(['APPOINTMENT', 'CANCEL', 'CANCEL'])).toEqual(['00', '03']);
    });
    it('빈 선택은 빈 배열 — 호출자가 "거르지 않음"으로 읽는다', () => {
        expect(toStatusCodes([])).toEqual([]);
    });
});

describe('toStatusLabel (표시 상태 코드 → 그 장부의 칩 라벨)', () => {
    it('예약장부: 00 → 예약, 03 → 취소', () => {
        expect(toStatusLabel('00', 'APPOINTMENT')).toBe('예약');
        expect(toStatusLabel('03', 'APPOINTMENT')).toBe('취소');
    });
    // 라벨은 용어 사전(src/messages/ko.json terms.status)의 값 — 05 대기 · 01 완료
    it('진료장부: 05 → 대기, 01 → 완료, 02 → 미이행, 03 → 취소', () => {
        expect(toStatusLabel('05', 'TREATMENT')).toBe('대기');
        expect(toStatusLabel('01', 'TREATMENT')).toBe('완료');
        expect(toStatusLabel('02', 'TREATMENT')).toBe('미이행');
        expect(toStatusLabel('03', 'TREATMENT')).toBe('취소');
    });
    it('그 장부에 칩이 없는 코드는 null — 진료장부의 00(예약), 예약장부의 01(진료완료)', () => {
        expect(toStatusLabel('00', 'TREATMENT')).toBeNull();
        expect(toStatusLabel('01', 'APPOINTMENT')).toBeNull();
    });
});
