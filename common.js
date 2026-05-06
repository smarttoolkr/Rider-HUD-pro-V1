/* ============================================================
   HUD for Riders — js/common.js
   GPS / TTS / 암호화 / PIN / 날씨 / 오디오
   설계문서 §10 재활용 기준:
     ✅ AES-256 + PBKDF2 암호화
     ✅ GPS 핀 근접감지 (30m + 100m 재진입)
     ✅ TTS 워밍업 패턴 (speakDirect)
     ✅ 카카오맵 SDK
     ❌ SAFETY_MESSAGES 전체 제거
     ❌ speakSafetyMsg() 제거
   ============================================================ */

const HudCommon = (() => {

    /* ──────────────────────────────────────────
       1. XSS 방어
    ────────────────────────────────────────── */
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    function escapeAttr(str) { return escapeHtml(str).replace(/\\/g,'\\\\'); }
    function stripEmoji(str) {
        return str.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27FF}]|[\u{2300}-\u{23FF}]/gu,'')
                  .replace(/\s+/g,' ').trim();
    }


    /* ──────────────────────────────────────────
       2. 암호화 (AES-256 + PBKDF2, 재활용)
       솔트는 HudDB.settings에 저장
    ────────────────────────────────────────── */
    async function getOrCreateSalt(key) {
        let salt = await HudDB.settings.get(key);
        if (!salt) {
            salt = CryptoJS.lib.WordArray.random(128/8).toString();
            await HudDB.settings.set(key, salt);
        }
        return salt;
    }

    async function deriveKey(pin) {
        const salt = await getOrCreateSalt('enc_salt');
        return CryptoJS.PBKDF2(pin, salt, { keySize: 256/32, iterations: 10000 }).toString();
    }

    async function encrypt(data, pin) {
        const key = await deriveKey(pin);
        return CryptoJS.AES.encrypt(JSON.stringify(data), key).toString();
    }

    async function decrypt(ct, pin) {
        // PBKDF2 방식 시도 → 실패 시 레거시(raw key) 시도
        try {
            const key = await deriveKey(pin);
            const result = JSON.parse(CryptoJS.AES.decrypt(ct, key).toString(CryptoJS.enc.Utf8));
            if (result) return result;
        } catch {}
        try {
            return JSON.parse(CryptoJS.AES.decrypt(ct, pin).toString(CryptoJS.enc.Utf8));
        } catch {}
        return null;
    }


    /* ──────────────────────────────────────────
       3. PIN 시스템 (6자리, PBKDF2 해시)
    ────────────────────────────────────────── */
    const PIN_LENGTH      = 6;
    const PIN_MAX_ATTEMPT = 5;
    const PIN_LOCKOUT_MS  = 30 * 1000;
    const AUTO_LOCK_MS    = 15 * 60 * 1000;

    let _pin       = null;   // 잠금 해제 후 메모리에만 보관
    let _pinMode   = 'unlock';
    let _pinCode   = [];
    let _pinFirst  = '';
    let _autoLockTimer = null;

    async function getPinSalt() {
        return getOrCreateSalt('pin_salt');
    }

    async function hashPin(pin) {
        const salt = await getPinSalt();
        return CryptoJS.PBKDF2(pin, salt, { keySize: 256/32, iterations: 5000 }).toString();
    }

    async function hasPinSet() {
        return !!(await HudDB.settings.get('pin_hash'));
    }

    async function verifyPin(entered) {
        const stored = await HudDB.settings.get('pin_hash');
        return stored && (await hashPin(entered)) === stored;
    }

    async function savePin(pin) {
        const hash = await hashPin(pin);
        await HudDB.settings.set('pin_hash', hash);
    }

    async function clearPin() {
        await HudDB.settings.remove('pin_hash');
        await HudDB.settings.remove('pin_salt');
        await HudDB.settings.remove('enc_salt');
    }

    /* 잠금 실패 횟수 (IndexedDB 사용) */
    async function getPinAttempts()   { return (await HudDB.settings.get('pin_attempts'))  || 0; }
    async function getLockoutUntil()  { return (await HudDB.settings.get('pin_lockout'))   || 0; }
    async function clearPinFailures() {
        await HudDB.settings.remove('pin_attempts');
        await HudDB.settings.remove('pin_lockout');
    }
    async function recordPinFailure() {
        const attempts = (await getPinAttempts()) + 1;
        await HudDB.settings.set('pin_attempts', attempts);
        if (attempts >= PIN_MAX_ATTEMPT) {
            await HudDB.settings.set('pin_lockout', Date.now() + PIN_LOCKOUT_MS);
            await HudDB.settings.set('pin_attempts', 0);
            return PIN_LOCKOUT_MS;
        }
        return 0;
    }

    /* PIN 입력 UI */
    function pinInput(num) {
        getLockoutUntil().then(until => {
            if (Date.now() < until) return;
            if (_pinCode.length >= PIN_LENGTH) return;
            _pinCode.push(num);
            _updatePinDots();
            if (_pinCode.length === PIN_LENGTH) setTimeout(_handlePinComplete, 200);
        });
    }
    function pinDelete() { _pinCode.pop(); _updatePinDots(); }
    function _updatePinDots() {
        for (let i = 0; i < PIN_LENGTH; i++) {
            const el = document.getElementById('dot' + i);
            if (el) el.className = 'pin-dot' + (i < _pinCode.length ? ' filled' : '');
        }
    }
    function _showPinError(msg) {
        const msgEl = document.getElementById('pinMsg');
        if (msgEl) msgEl.innerText = msg;
        for (let i = 0; i < PIN_LENGTH; i++) {
            const el = document.getElementById('dot' + i);
            if (el) el.className = 'pin-dot error';
        }
        setTimeout(() => { _pinCode = []; _updatePinDots(); if (msgEl) msgEl.innerText = ''; }, 1500);
    }
    function _showPinLockout(ms) {
        _showPinError(Math.ceil(ms/1000) + '초 후 다시 시도하세요');
        const iv = setInterval(async () => {
            const rem = (await getLockoutUntil()) - Date.now();
            const msgEl = document.getElementById('pinMsg');
            if (rem <= 0) { clearInterval(iv); if (msgEl) msgEl.innerText = ''; }
            else if (msgEl) msgEl.innerText = Math.ceil(rem/1000) + '초 후 다시 시도하세요';
        }, 500);
    }

    async function _handlePinComplete() {
        const entered = _pinCode.join('');

        if (_pinMode === 'setup') {
            _pinFirst = entered; _pinMode = 'confirm'; _pinCode = []; _updatePinDots();
            const sub = document.getElementById('pinSubtitle');
            if (sub) sub.innerText = 'PIN 확인 (다시 입력)';
            return;
        }
        if (_pinMode === 'confirm') {
            if (entered === _pinFirst) {
                _pin = entered;
                await savePin(_pin);
                await clearPinFailures();
                _unlockApp();
            } else {
                _showPinError('PIN이 일치하지 않습니다');
                _pinMode = 'setup'; _pinFirst = '';
                const sub = document.getElementById('pinSubtitle');
                if (sub) sub.innerText = '새 PIN 설정 (6자리)';
            }
            return;
        }
        if (_pinMode === 'unlock') {
            const lockUntil = await getLockoutUntil();
            const rem = lockUntil - Date.now();
            if (rem > 0) { _showPinLockout(rem); return; }

            if (await verifyPin(entered)) {
                _pin = entered;
                await clearPinFailures();
                _unlockApp();
            } else {
                const newLockout = await recordPinFailure();
                if (newLockout > 0) _showPinLockout(newLockout);
                else {
                    const left = PIN_MAX_ATTEMPT - (await getPinAttempts());
                    _showPinError('PIN이 틀렸습니다 (남은 시도: ' + left + '회)');
                }
            }
        }
    }

    function _unlockApp() {
        document.getElementById('pinScreen').classList.remove('open');
        // 마이그레이션 → 앱 초기화
        HudDB.migrateFromLocalStorage(_pin).then(() => {
            if (typeof HudHUD !== 'undefined') HudHUD.init();
        });
    }

    function lockApp() {
        _pinCode = []; _updatePinDots(); _pinMode = 'unlock';
        const sub = document.getElementById('pinSubtitle');
        const msg = document.getElementById('pinMsg');
        if (sub) sub.innerText = 'PIN 입력';
        if (msg) msg.innerText = '';
        document.getElementById('pinScreen').classList.add('open');
    }

    async function pinReset(showAlertFn) {
        const ok = await showAlertFn({
            type: 'warn', icon: '⚠️', title: 'PIN 초기화',
            message: 'PIN을 초기화하면 저장된 장소 데이터가 모두 삭제됩니다.\n계속하시겠습니까?',
            okText: '초기화', cancelText: '취소'
        });
        if (!ok) return;
        await clearPin();
        await HudDB.places.clear();
        await HudDB.emergency.clear();
        await clearPinFailures();
        _pin = null; _pinMode = 'setup'; _pinCode = []; _updatePinDots();
        const sub = document.getElementById('pinSubtitle');
        if (sub) sub.innerText = '새 PIN 설정 (6자리)';
    }

    async function showPinScreen() {
        const hasPin = await hasPinSet();
        _pinMode = hasPin ? 'unlock' : 'setup';
        const sub = document.getElementById('pinSubtitle');
        if (sub) sub.innerText = hasPin ? 'PIN 입력 (6자리)' : '새 PIN 설정 (6자리)';
        document.getElementById('pinScreen').classList.add('open');
    }

    /* 자동잠금: 백그라운드 전환 후 15분 (근무 중이면 잠금 안 함) */
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            /* IndexedDB에서 근무 상태 확인 후 잠금 여부 결정 */
            HudDB.settings.get('workStartTime').then(startTs => {
                if (!startTs) {
                    _autoLockTimer = setTimeout(lockApp, AUTO_LOCK_MS);
                }
            }).catch(() => {
                /* DB 오류 시 안전하게 잠금 */
                _autoLockTimer = setTimeout(lockApp, AUTO_LOCK_MS);
            });
        } else {
            clearTimeout(_autoLockTimer);
            if (!document.getElementById('pinScreen').classList.contains('open')) {
                if (typeof HudHUD !== 'undefined') HudHUD.onResume();
            }
        }
    });


    /* ──────────────────────────────────────────
       4. 날짜 표시
    ────────────────────────────────────────── */
    function updateDateDisplay() {
        const now  = new Date();
        const days = ['일','월','화','수','목','금','토'];
        const str  = now.getFullYear() + '.'
                   + String(now.getMonth()+1).padStart(2,'0') + '.'
                   + String(now.getDate()).padStart(2,'0')
                   + ' (' + days[now.getDay()] + ')';
        const el = document.getElementById('dateDisplay');
        if (el) el.innerText = str;
    }

    /** 현재 시간 → 시간대 슬롯 (설계문서 §04) */
    function getTimeSlot(date = new Date()) {
        const hhmm = date.getHours() * 100 + date.getMinutes();
        if (hhmm >= 700  && hhmm <= 1029) return '오전';
        if (hhmm >= 1030 && hhmm <= 1359) return '점피';
        if (hhmm >= 1400 && hhmm <= 1659) return '오후';
        if (hhmm >= 1700 && hhmm <= 1959) return '저피';
        if (hhmm >= 2000 && hhmm <= 2259) return '야간';
        return '심야';
    }

    /** ISO 날짜 문자열 반환 (YYYY-MM-DD) */
    function todayStr(date = new Date()) {
        return date.toISOString().slice(0, 10);
    }


    /* ──────────────────────────────────────────
       5. 날씨 (Open-Meteo, 재활용)
    ────────────────────────────────────────── */
    const WMO_ICONS = {
        0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',
        51:'🌦️',53:'🌧️',55:'🌧️',56:'🌧️',57:'🌧️',
        61:'🌧️',63:'🌧️',65:'🌧️',66:'🌧️',67:'🌧️',
        71:'🌨️',73:'🌨️',75:'❄️',77:'❄️',
        80:'🌦️',81:'🌧️',82:'🌧️',85:'🌨️',86:'❄️',
        95:'⛈️',96:'⛈️',99:'⛈️'
    };
    const WMO_TEXT = {
        0:'맑음',1:'대체로 맑음',2:'구름 조금',3:'흐림',45:'안개',48:'안개',
        51:'이슬비',53:'이슬비',55:'이슬비',
        61:'약한 비',63:'비',65:'강한 비',
        71:'약한 눈',73:'눈',75:'강한 눈',
        80:'소나기',81:'소나기',82:'강한 소나기',
        95:'뇌우',96:'우박 뇌우',99:'강한 우박 뇌우'
    };
    const RAIN_CODES = [51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99];

    let _weatherInterval = null;

    function fetchWeather(lat, lon) {
        const useLat = lat || 37.5665;
        const useLon = lon || 126.978;
        fetch('https://api.open-meteo.com/v1/forecast?latitude=' + useLat
            + '&longitude=' + useLon
            + '&current=temperature_2m,weather_code&timezone=Asia%2FSeoul')
        .then(r => r.json())
        .then(data => {
            if (!data.current) return;
            const code = data.current.weather_code ?? data.current.weathercode;
            const temp = Math.round(data.current.temperature_2m);
            const el   = document.getElementById('weatherDisplay');
            const sep  = document.getElementById('dateSep');
            if (el)  el.innerText = (WMO_ICONS[code] || '🌡️') + ' ' + temp + '° ' + (WMO_TEXT[code] || '');
            if (sep) sep.style.display = 'inline';
            _scheduleWeather(code, lat, lon);
        })
        .catch(() => {
            const el  = document.getElementById('weatherDisplay');
            const sep = document.getElementById('dateSep');
            if (el)  el.innerText = '날씨 정보 없음';
            if (sep) sep.style.display = 'inline';
        });
    }

    function _scheduleWeather(code, lat, lon) {
        clearInterval(_weatherInterval);
        const ms = RAIN_CODES.includes(code) ? 10*60*1000
                 : [2,3,45,48].includes(code) ? 15*60*1000
                 : 30*60*1000;
        _weatherInterval = setInterval(() => fetchWeather(lat, lon), ms);
    }


    /* ──────────────────────────────────────────
       6. 오디오 (Web Audio API, 재활용)
    ────────────────────────────────────────── */
    let _audioCtx = null;

    async function initAudio() {
        if (!_audioCtx) {
            try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
        }
        if (_audioCtx.state === 'suspended') {
            try { await _audioCtx.resume(); } catch {}
        }
    }

    function playTone({ freq=880, duration=0.15, type='sine', gain=0.1, startDelay=0 } = {}) {
        if (!_audioCtx || _audioCtx.state !== 'running') return;
        try {
            const t   = _audioCtx.currentTime + startDelay;
            const osc = _audioCtx.createOscillator();
            const g   = _audioCtx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, t);
            g.gain.setValueAtTime(0.001, t);
            g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.001, t + duration);
            osc.connect(g); g.connect(_audioCtx.destination);
            osc.start(t); osc.stop(t + duration + 0.02);
        } catch {}
    }

    /** 도착 — 낮은 단음 */
    function playArriveSound() {
        playTone({ freq: 440, duration: 0.12, gain: 0.12, startDelay: 0 });    // A4 (라)
    }

    /** 픽업 — 상승하는 2음 */
    function playPickupSound() {
        playTone({ freq: 523.25, duration: 0.10, gain: 0.12, startDelay: 0 });    // C5
        playTone({ freq: 659.25, duration: 0.15, gain: 0.12, startDelay: 0.08 }); // E5
    }

    /** 드롭 — 완성의 2음 */
    function playDropSound() {
        playTone({ freq: 659.25, duration: 0.12, gain: 0.13, startDelay: 0 });    // E5
        playTone({ freq: 783.99, duration: 0.22, gain: 0.13, startDelay: 0.10 }); // G5
    }

    function triggerHaptic(kind) {
        if (navigator.vibrate) navigator.vibrate(100);
        if      (kind === 'arrive')  playArriveSound();
        else if (kind === 'pickup')  playPickupSound();
        else if (kind === 'drop')    playDropSound();
        else    playTone({ freq: 880, duration: 0.08, gain: 0.08 });
    }


    /* ──────────────────────────────────────────
       7. TTS (재활용, 안전 멘트 제거)
       speakPlaceInfo — 장소명 + 메모 분리 발화
    ────────────────────────────────────────── */
    const CHAR_MAP = {
        '0':'영','1':'일','2':'이','3':'삼','4':'사',
        '5':'오','6':'육','7':'칠','8':'팔','9':'구',
        '#':'샵','*':'별','-':'대시','.':'점'
    };

    let _ttsSettings = { rate: 0.95, volume: 1.0 };

    function setTtsSettings(rate, volume) {
        _ttsSettings = { rate, volume };
    }

    function speakDirect(text, opts = {}) {
        if (!('speechSynthesis' in window) || !text) return;
        try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch {}
        try {
            const u    = new SpeechSynthesisUtterance(' ' + text);
            u.lang     = 'ko-KR';
            u.rate     = opts.rate   ?? _ttsSettings.rate;
            u.volume   = opts.volume ?? _ttsSettings.volume;
            speechSynthesis.speak(u);
        } catch (e) { console.warn('[TTS]', e); }
    }

    function speakPlaceInfo(name, memo) {
        if (!('speechSynthesis' in window)) return;
        try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch {}
        try { speechSynthesis.cancel(); } catch {}

        const baseRate   = _ttsSettings.rate;
        const numberRate = Math.min(1.5, baseRate + 0.15);
        const vol        = _ttsSettings.volume;

        setTimeout(() => {
            try {
                /* TTS 엔진 워밍업 prefix — 앞부분 잘림 방지 */
                const prefix = new SpeechSynthesisUtterance('장소 안내.');
                prefix.lang = 'ko-KR'; prefix.rate = baseRate; prefix.volume = vol;
                speechSynthesis.speak(prefix);

                if (name && name.trim()) {
                    const u = new SpeechSynthesisUtterance(name.trim());
                    u.lang = 'ko-KR'; u.rate = baseRate; u.volume = vol;
                    speechSynthesis.speak(u);
                }
                if (memo) {
                    const segs = memo.match(/[0-9]+|[^0-9]+/g) || [];
                    segs.forEach(seg => {
                        const u = new SpeechSynthesisUtterance();
                        u.lang = 'ko-KR'; u.volume = vol;
                        if (/^[0-9]+$/.test(seg)) {
                            u.text = seg.split('').map(c => CHAR_MAP[c] || c).join(' ');
                            u.rate = numberRate;
                        } else {
                            u.text = seg.trim();
                            u.rate = baseRate;
                        }
                        if (u.text) speechSynthesis.speak(u);
                    });
                }
            } catch (e) { console.warn('[TTS]', e); }
        }, 100);
    }

    const FLOOR_SPEAK = {
        'f1': '일층',
        'lobby': '로비',
        'b1': '지하일층', 'b2': '지하이층', 'b3': '지하삼층',
        'b4': '지하사층', 'b5': '지하오층'
    };
    function speakFloor(id) {
        const floorText = FLOOR_SPEAK[id] || id;
        speakDirect('주차 안내. ' + floorText);
    }


    /* ──────────────────────────────────────────
       8. GPS Watch (재활용)
    ────────────────────────────────────────── */
    let _watchId        = null;
    let _gpsMode        = 'normal';
    let _updateInterval = 5000;
    let _lastUpdate     = 0;
    let _firstFix       = true;
    let _gpsErrorCount  = 0;

    let _prevLat = null, _prevLon = null, _prevTime = 0;
    let currentLat = null, currentLon = null, currentSpeedKmh = null;
    let _lastGpsAccuracy = null;
    let totalDistKm = 0;   // 누적 이동거리 (3중 필터 적용)

    /* TTS 근접 상태 */
    let _lastTtsPlace  = null;
    let _ttsLeftZone   = true;
    let _lastTtsTime   = 0;
    const TTS_LEAVE_DIST = 0.1;   // 100m 벗어나면 재진입 가능

    function startGPSWatch(onLocationUpdate) {
        if (!navigator.geolocation) return;
        if (_watchId !== null) navigator.geolocation.clearWatch(_watchId);

        _watchId = navigator.geolocation.watchPosition(
            pos => {
                _gpsErrorCount = 0;
                _hideGpsWarning();

                const now    = Date.now();
                const newLat = pos.coords.latitude;
                const newLon = pos.coords.longitude;

                if (now - _lastUpdate < _updateInterval) return;
                if (currentLat && currentLon && getD(currentLat, currentLon, newLat, newLon) < 0.005) {
                    _lastUpdate = now; return;
                }

                /* 속도 계산 */
                if (pos.coords.speed !== null && pos.coords.speed >= 0) {
                    currentSpeedKmh = pos.coords.speed * 3.6;
                } else if (_prevLat !== null && _prevTime > 0) {
                    const distKm  = getD(_prevLat, _prevLon, newLat, newLon);
                    const elapsedH = (now - _prevTime) / 3600000;
                    currentSpeedKmh = elapsedH > 0 ? distKm / elapsedH : null;
                    if (currentSpeedKmh && currentSpeedKmh > 200) currentSpeedKmh = null;
                }

                /* ── 이동거리 누적 (3중 필터) ── */
                if (_prevLat !== null && _prevTime > 0) {
                    const accuracy = pos.coords.accuracy || 999;
                    const speed    = currentSpeedKmh || 0;
                    const delta    = getD(_prevLat, _prevLon, newLat, newLon);
                    const elapsedH = (now - _prevTime) / 3600000;
                    const calcSpd  = elapsedH > 0 ? delta / elapsedH : 0;

                    const passAccuracy = accuracy <= 20;          // 정확도 20m 이하
                    const passSpeed    = speed >= 1.5;            // 시속 1.5km 이상 (정차 제외)
                    const passDelta    = calcSpd <= 150;          // 시속 150km 이하 (노이즈 제외)

                    if (passAccuracy && passSpeed && passDelta) {
                        totalDistKm = Math.round((totalDistKm + delta) * 1000) / 1000;
                        /* IndexedDB에 500m 단위로 저장 (빈도 제한) */
                        if (Math.round(totalDistKm * 2) !== Math.round((totalDistKm - delta) * 2)) {
                            HudDB.settings.set('totalDistKm', totalDistKm).catch(() => {});
                        }
                    }
                }

                _prevLat = newLat; _prevLon = newLon; _prevTime = now;
                _lastUpdate = now;
                currentLat  = newLat; currentLon = newLon;
                _lastGpsAccuracy = pos.coords.accuracy;

                if (_firstFix) { _firstFix = false; fetchWeather(currentLat, currentLon); }

                if (typeof onLocationUpdate === 'function') onLocationUpdate(currentLat, currentLon);
            },
            err => {
                _gpsErrorCount++;
                if (_gpsErrorCount >= 3) {
                    const msg = err.code === 1 ? '📡 위치 권한이 차단됨'
                              : err.code === 3 ? '📡 GPS 신호 약함 (터널/실내)'
                              : '📡 위치 확인 불가';
                    _showGpsWarning(msg);
                }
            },
            {
                enableHighAccuracy: _gpsMode === 'tracking',
                maximumAge: _gpsMode === 'tracking' ? 2000 : 5000,
                timeout: 10000
            }
        );
    }

    function setGpsMode(mode) {
        _gpsMode        = mode;
        _updateInterval = mode === 'tracking' ? 2000 : 5000;
    }

    function _showGpsWarning(msg) {
        let el = document.getElementById('gpsWarning');
        if (!el) {
            el = document.createElement('div');
            el.id = 'gpsWarning';
            el.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:6px;'
                + 'background:rgba(255,62,62,0.9);color:#fff;font-size:0.7rem;'
                + 'font-weight:bold;text-align:center;z-index:900;';
            document.body.appendChild(el);
        }
        el.innerText = msg; el.style.display = 'block';
    }
    function _hideGpsWarning() {
        const el = document.getElementById('gpsWarning');
        if (el) el.style.display = 'none';
    }


    /* ──────────────────────────────────────────
       9. TTS 근접 감지 핸들러
       places: [{ name, memo, pins:[{lat,lng}] }]
    ────────────────────────────────────────── */
    async function handleTTS(place, dist) {
        if (_lastGpsAccuracy && _lastGpsAccuracy > 200) return;
        if (Date.now() - _lastTtsTime < 3000) return;

        const proxDist  = await HudDB.settings.get('proxDist')  || 0.03;
        const proxSpeed = await HudDB.settings.get('proxSpeed') || 30;

        if (dist > proxDist) {
            if (_lastTtsPlace === place.name) _ttsLeftZone = true;
            return;
        }

        const speedOk = currentSpeedKmh === null || proxSpeed >= 999 || currentSpeedKmh <= proxSpeed;
        if (!speedOk) return;

        if (_lastTtsPlace === place.name && !_ttsLeftZone) return;

        _lastTtsPlace = place.name;
        _ttsLeftZone  = false;
        _lastTtsTime  = Date.now();

        speakPlaceInfo(place.name, place.memo);
    }


    /* ──────────────────────────────────────────
       10. 거리 계산 (Haversine)
    ────────────────────────────────────────── */
    function getD(l1, o1, l2, o2) {
        const R  = 6371;
        const dL = (l2-l1) * Math.PI/180;
        const dO = (o2-o1) * Math.PI/180;
        const a  = Math.sin(dL/2)**2
                 + Math.cos(l1*Math.PI/180) * Math.cos(l2*Math.PI/180) * Math.sin(dO/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    function getPlaceMinDist(place, lat, lon) {
        const pins = (place.pins || []).filter(p => p);
        if (!pins.length) return 999;
        return Math.min(...pins.map(p => getD(lat, lon, p.lat, p.lng ?? p.lon)));
    }

    function getClosestPlace(places, lat, lon) {
        return [...places]
            .filter(p => (p.pins||[]).some(pin => pin))
            .sort((a,b) => getPlaceMinDist(a,lat,lon) - getPlaceMinDist(b,lat,lon))[0] || null;
    }


    /* ──────────────────────────────────────────
       11. 카카오맵 열기
    ────────────────────────────────────────── */
    function openKakaoMap() {
        const appUrl = currentLat && currentLon
            ? 'kakaomap://map?center=' + currentLat + ',' + currentLon
            : 'kakaomap://open';
        const webUrl = 'https://map.kakao.com';
        const fallback = setTimeout(() => window.open(webUrl), 1000);
        window.location.href = appUrl;
        window.addEventListener('blur', () => clearTimeout(fallback), { once: true });
    }


    /* ──────────────────────────────────────────
       공개 API
    ────────────────────────────────────────── */
    return {
        /* XSS */
        escapeHtml, escapeAttr, stripEmoji,

        /* 암호화 */
        encrypt, decrypt,

        /* PIN */
        pinInput, pinDelete, showPinScreen, lockApp, pinReset,
        hasPinSet, getPin: () => _pin,

        /* 날짜/날씨 */
        updateDateDisplay, getTimeSlot, todayStr, fetchWeather,

        /* 오디오 */
        initAudio, triggerHaptic, playArriveSound, playPickupSound, playDropSound,

        /* TTS */
        setTtsSettings, speakDirect, speakPlaceInfo, speakFloor,

        /* GPS */
        startGPSWatch, setGpsMode, handleTTS,
        get lat()   { return currentLat; },
        get lon()   { return currentLon; },
        get speed()       { return currentSpeedKmh; },
        get totalDistKm() { return totalDistKm; },

        /* 이동거리 복원 (앱 시작 시 hud.js init에서 호출) */
        async restoreDistKm() {
            const saved = await HudDB.settings.get('totalDistKm');
            if (saved) totalDistKm = saved;
        },

        /* 이동거리 초기화 (당일 리셋 시) */
        resetDistKm() {
            totalDistKm = 0;
            HudDB.settings.set('totalDistKm', 0).catch(() => {});
        },

        /* 거리 */
        getD, getPlaceMinDist, getClosestPlace,

        /* 지도 */
        openKakaoMap,
    };

})();
