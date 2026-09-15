/**
 * 시간 입력칸("HH:MM") 정규화·검증.
 *
 * 운영일정 설정의 시간 입력은 `<input type="time">` 이었다. 형식·범위를 브라우저가 보장해 주는
 * 대신 브라우저마다 다른 네이티브 위젯(시·분 스피너, 드롭다운)이 떠서 키보드로 빠르게 칠 수 없었다.
 * 일반 텍스트 입력으로 바꾸면서 **브라우저가 해 주던 몫을 여기서 대신한다** — 이 파일이 없으면
 * "2590" 같은 값이 그대로 state 에 남아 `HHMMToHmm` 을 지나 서버로 나간다.
 *
 * 빈 값은 오류가 아니다. 진료행은 "그 요일 휴무", 휴게행은 "휴게 없음"이라는 정상적인 의사 표현이다.
 */

/** 24시각 표기 "HH:MM" (00~23시 / 00~59분) */
const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 정규화 결과가 확정된 "HH:MM" 인가 */
export function isValidHHMM(value: string | null | undefined): boolean {
  return HHMM_PATTERN.test(value ?? '');
}

/** 값이 있는데 형식이 틀렸는가 — 빈 값은 "정하지 않음"이라 오류로 보지 않는다. */
export function isInvalidTimeText(value: string | null | undefined): boolean {
  const v = String(value ?? '').trim();
  return v !== '' && !isValidHHMM(v);
}

/**
 * 입력 중(타이핑·붙여넣기) 마스킹 — 시간 칸에 애초에 들어올 수 없는 것을 막는다.
 *   · 숫자 외 문자는 넣지 않는다
 *   · 숫자는 4개까지다(HHMM 이 전부다)
 *   · 4개가 차는 순간 콜론을 넣어 "HH:MM" 으로 보여준다
 *
 * ★3자리까지는 콜론을 넣지 않는다. "930" 은 09:30 을 의도한 것이라 앞 2자리를 시로 잡으면
 *  "93:0" 이 되어 오히려 틀린다 — 3자리 이하의 시/분 경계는 blur 때 normalizeTimeInput 이 정한다.
 *
 * 범위(00~23시 / 00~59분)까지 여기서 강제하지는 않는다. 두 번째 자리를 치는 순간 거부하면
 * 커서·붙여넣기·중간 편집에서 이질감이 크다 — 범위는 blur 이후 오류 표시와 저장 게이트가 맡는다.
 */
export function maskTimeTyping(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '').slice(0, 4);
  if (digits.length < 4) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

/**
 * 자유 입력 → "HH:MM" 정규화.
 *
 * 콜론 없이 숫자만 쳐도 되게 한다 — 시간 입력의 대부분은 "0930" 처럼 연속 타이핑이다.
 *   "9" · "09"   → "09:00"    (시만 입력 = 정시)
 *   "930"        → "09:30"
 *   "0930"       → "09:30"
 *   "9:3" · "9:" → "09:03" · "09:00"
 *
 * @returns 정규화된 "HH:MM" · 빈 입력이면 "" · 보정할 수 없으면 null(원문을 그대로 두고 오류 표시)
 */
export function normalizeTimeInput(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').replace(/\s/g, '');
  if (v === '') return '';
  if (!/^[\d:]+$/.test(v)) return null;

  const parts = v.split(':');
  if (parts.length > 2) return null;

  let hourText: string;
  let minuteText: string;

  if (parts.length === 2) {
    const [h, m] = parts;
    if (h === '' || h.length > 2 || m.length > 2) return null;
    hourText = h;
    minuteText = m === '' ? '0' : m;
  } else {
    const digits = parts[0];
    if (digits.length <= 2) {
      hourText = digits;
      minuteText = '0';
    } else if (digits.length === 3) {
      hourText = digits.slice(0, 1);
      minuteText = digits.slice(1);
    } else if (digits.length === 4) {
      hourText = digits.slice(0, 2);
      minuteText = digits.slice(2);
    } else {
      return null;
    }
  }

  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour > 23 || minute > 59) return null;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "HH:MM" → 자정 기준 분. 형식이 틀리면 null */
export function timeToMinutes(value: string | null | undefined): number | null {
  if (!isValidHHMM(value)) return null;
  const [h, m] = String(value).split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * 종료가 시작보다 늦지 않은가 — 같은 시각도 구간이 아니므로 역전으로 본다.
 * 한쪽이라도 비었거나 형식이 틀리면 판정하지 않는다(그건 다른 가드가 잡는 상태다).
 */
export function isReversedTimeRange(
  start: string | null | undefined,
  end: string | null | undefined,
): boolean {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s === null || e === null) return false;
  return e <= s;
}
