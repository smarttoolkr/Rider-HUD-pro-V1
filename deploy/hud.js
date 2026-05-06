/* ============================================================
   HUD for Riders — js/hud.js
   HUD 탭 모듈 (메인)
   ============================================================
   설계문서 §06 배달 사이클:
     드롭 → 도착  = 콜 수락 후 이동 시간 (추정)
     도착 → 픽업  = 매장 조리 대기 시간
     픽업 → 드롭  = 실제 배달 시간
   ============================================================ */

const HudHUD = (() => {

    /* ──────────────────────────────────────────
       1. 상태
    ────────────────────────────────────────── */
    let isWorking          = false;
    let currentSessionStartTime = 0;
    let totalWorkMs        = 0;
    let timerInterval      = null;
    let activeFloor        = null;       // 'f1'|'b1'|'b2'|'b3'|null

    /* 휴식 상태 [v3] */
    let isResting          = false;
    let restStartTime      = 0;
    let totalRestMs        = 0;          // 이번 세션 누적 휴식시간
    let currentRestLogId   = null;

    let places             = [];          // 복호화된 장소 목록
    let editingId          = null;        // 수정 중인 장소 ID

    /* 현재 진행 중인 배달 (도착→픽업→드롭 사이클) */
    let currentDelivery = null;
    /*  null  또는  { phase: 'arrived'|'pickedUp',
                      arrived:  { ts, lat, lng, region },
                      pickedUp: { ts, lat, lng } }  */

    let deliveryTimerInterval = null;
    let pickupVibeNotified    = false;
    const PICKUP_WARN_MS = 45 * 60 * 1000;   // 45분 — 빨강 깜박임
    const PICKUP_VIBE_MS = 60 * 60 * 1000;   // 1시간 — 진동

    /* 미션 모드 상태 */
    let missionActive       = false;
    let missionStartTime    = 0;
    let missionCount        = 0;
    let missionAlertInterval = null;
    let missionLastAlertMin = 0;       // 마지막 알림 친 시점 (분 단위, 30분 단위 알림용)
    let dailyMissionBonus   = 0;       // 그날 누적 미션 보너스

    let currentTimerView    = 'work';  // 'work' | 'mission' — 타이머 표시 모드


    /* ──────────────────────────────────────────
       2. 초기화 (PIN 해제 후 호출됨)
    ────────────────────────────────────────── */
    async function init() {
        /* 설정값 로드 → TTS 적용 */
        const rate = await HudDB.settings.get('ttsRate', 0.85);
        const vol  = await HudDB.settings.get('ttsVolume', 100);
        HudCommon.setTtsSettings(rate, vol/100);

        /* 근무 상태 복원 */
        await loadWorkState();

        /* 휴식시간 복원 [v3] */
        totalRestMs = (await HudDB.settings.get('todayRestMs')) || 0;

        /* 토탈 카운터 복원 */
        totalCount = (await HudDB.settings.get('totalCount')) || 0;

        /* 미션 상태 복원 */
        await restoreMissionState();
        await loadDailyMissionBonus();

        /* 장소 로드 (복호화) */
        await loadPlaces();

        /* 진행 중 배달 복원 */
        await restoreCurrentDelivery();

        /* UI 초기 렌더 */
        HudCommon.updateDateDisplay();
        setInterval(HudCommon.updateDateDisplay, 60000);
        renderPlaceList();
        updateHeroCard();
        updateCounterCard();
        refreshTimerView();
        await restoreLastFloor();

        /* GPS 시작 */
        HudCommon.startGPSWatch(handleLocationUpdate);

        /* 날씨 */
        setTimeout(() => HudCommon.fetchWeather(), 1500);
    }

    /** 백그라운드 → 포그라운드 복귀 시 */
    function onResume() {
        refreshTimerView();
        HudCommon.startGPSWatch(handleLocationUpdate);
        HudCommon.fetchWeather();
        HudCommon.updateDateDisplay();
        renderPlaceList();
    }


    /* ──────────────────────────────────────────
       3. 근무 타이머 (START / STOP)
    ────────────────────────────────────────── */
    async function loadWorkState() {
        totalWorkMs = (await HudDB.settings.get('totalWorkMs')) || 0;
        const startTs = await HudDB.settings.get('workStartTime');
        if (startTs) {
            isWorking = true;
            currentSessionStartTime = parseInt(startTs);
            const btn = document.getElementById('toggleBtn');
            if (btn) {
                btn.innerText = 'STOP';
                btn.classList.replace('btn-start', 'btn-stop');
            }
            clearInterval(timerInterval);
            timerInterval = setInterval(refreshTimerView, 1000);
        }
    }

    async function handleWorkToggle() {
        await HudCommon.initAudio();
        const btn = document.getElementById('toggleBtn');

        if (!isWorking) {
            /* START */
            isWorking = true;
            currentSessionStartTime = Date.now();
            await HudDB.settings.set('workStartTime', currentSessionStartTime);
            btn.innerText = 'STOP';
            btn.classList.replace('btn-start', 'btn-stop');
            clearInterval(timerInterval);
            timerInterval = setInterval(refreshTimerView, 1000);
            refreshTimerView();
        } else {
            /* STOP — 진행 중 배달이 있으면 확인 */
            if (currentDelivery) {
                const ok = await showAlert({
                    type: 'warn', icon: '⚠️', title: '진행 중 배달',
                    message: '진행 중인 배달이 있습니다.\n근무를 종료하면 해당 배달은 취소됩니다.\n계속하시겠습니까?',
                    okText: '종료', cancelText: '취소'
                });
                if (!ok) return;
                await cancelPickup();
            }
            const sessionMs = Date.now() - currentSessionStartTime;
            isWorking = false;
            clearInterval(timerInterval);
            totalWorkMs += sessionMs;
            await HudDB.settings.set('totalWorkMs', totalWorkMs);
            await HudDB.settings.remove('workStartTime');
            btn.innerText = 'START';
            btn.classList.replace('btn-stop', 'btn-start');

            /* 휴식 중이었다면 종료 처리 [v3] */
            if (isResting) {
                totalRestMs += Date.now() - restStartTime;
                isResting = false;
                currentRestLogId = null;
                const restBtn = document.getElementById('restBtn');
                if (restBtn) { restBtn.innerText = '휴식'; restBtn.classList.remove('resting'); }
            }

            /* 실근무시간 = 총 근무시간 - 휴식시간 [v3] */
            const activeMs = Math.max(0, sessionMs - totalRestMs);
            await HudDB.settings.set('todayRestMs', 0);
            totalRestMs = 0;

            refreshTimerView();
            /* manager.js의 시급 입력 팝업 호출 (sessionMs, activeMs 전달) [v3] */
            if (typeof HudManager !== 'undefined' && HudManager.openWagePopup) {
                HudManager.openWagePopup(sessionMs, activeMs);
            } else {
                document.getElementById('wageOverlay').classList.add('open');
            }
        }
    }

    function getCurrentWorkMs() {
        return isWorking ? totalWorkMs + (Date.now() - currentSessionStartTime) : totalWorkMs;
    }

    function refreshTimerView() {
        const tEl = document.getElementById('workTimer');
        if (!tEl) return;

        /* 표시할 시간: mission 뷰이고 미션 활성 상태면 미션 경과시간, 아니면 근무시간 */
        let ms;
        if (currentTimerView === 'mission' && missionActive) {
            ms = Date.now() - missionStartTime;
        } else {
            currentTimerView = 'work';
            ms = getCurrentWorkMs();
        }

        const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
        const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
        const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
        tEl.innerText = h + ':' + m + ':' + s;

        /* RESET 버튼 라벨 */
        const resetLabel = document.getElementById('resetBtnLabel');
        if (resetLabel) {
            resetLabel.innerHTML = currentTimerView === 'mission'
                ? 'MISSION<br>TIME' : 'WORK<br>RESET';
        }

        /* WORK / MISSION 모드 버튼 활성화 */
        const modeWork    = document.getElementById('modeWorkBtn');
        const modeMission = document.getElementById('modeMissionBtn');
        if (modeWork)    modeWork.className    = 'mode-btn' + (currentTimerView === 'work' ? ' active-work' : '');
        if (modeMission) modeMission.className = 'mode-btn' + (currentTimerView === 'mission' && missionActive ? ' active-mission' : '');

        /* START / STOP 버튼 */
        const btn = document.getElementById('toggleBtn');
        if (btn) {
            if (isWorking) {
                btn.textContent = 'STOP';
                btn.classList.replace('btn-start', 'btn-stop');
            } else {
                btn.textContent = 'START';
                btn.classList.replace('btn-stop', 'btn-start');
            }
        }

        /* 상태 배지 (속도카드 좌상단) */
        const label = document.getElementById('statusLabel');
        if (label) {
            if (isWorking && isResting) {
                label.innerText = '☕ 휴식 중';
                label.className = 'hero-status-badge resting';
            } else if (isWorking && missionActive) {
                label.innerText = '⚡ 미션 진행중';
                label.className = 'hero-status-badge mission';
            } else if (isWorking) {
                label.innerText = '● 근무중';
                label.className = 'hero-status-badge live';
            } else {
                label.innerText = '대기 중';
                label.className = 'hero-status-badge';
            }
        }
    }

    /* WORK / MISSION 타이머 표시 전환 (모드 버튼 onclick) */
    function setTimerView(mode) {
        if (mode === 'mission' && !missionActive) return;  // 미션 비활성 시 무시
        currentTimerView = mode;
        refreshTimerView();
    }


    /* ──────────────────────────────────────────
       3-2. 시간 초기화 (확인 팝업 동반)
       대상: 근무 시간 + 토탈 카운터 (미션 시간은 추가 시 함께)
    ────────────────────────────────────────── */
    async function confirmResetTimer() {
        const ms = getCurrentWorkMs();
        const h = String(Math.floor(ms/3600000)).padStart(2,'0');
        const m = String(Math.floor((ms%3600000)/60000)).padStart(2,'0');
        const s = String(Math.floor((ms%60000)/1000)).padStart(2,'0');
        const timeStr = h + ':' + m + ':' + s;

        const ok = await showAlert({
            type: 'warn', icon: '⚠️',
            title: '시간 초기화',
            message: '근무 시간과 카운터를 0으로 초기화하시겠습니까?\n\n'
                   + '현재 기록\n'
                   + '• 근무 시간: ' + timeStr + '\n'
                   + '• 토탈 카운터: ' + totalCount + '건\n\n'
                   + '※ 이 동작은 되돌릴 수 없습니다',
            okText: '초기화', cancelText: '취소'
        });
        if (!ok) return;

        /* 근무 중이면 STOP 처리 (저장 없이) */
        if (isWorking) {
            isWorking = false;
            clearInterval(timerInterval);
            const btn = document.getElementById('toggleBtn');
            btn.innerText = 'START';
            btn.classList.replace('btn-stop', 'btn-start');
            await HudDB.settings.remove('workStartTime');
        }

        /* 휴식 상태도 초기화 [v3] */
        isResting   = false;
        totalRestMs = 0;
        currentRestLogId = null;
        await HudDB.settings.set('todayRestMs', 0);
        const restBtn = document.getElementById('restBtn');
        if (restBtn) { restBtn.innerText = '휴식'; restBtn.classList.remove('resting'); }

        /* 데이터 초기화 */
        totalWorkMs = 0;
        totalCount  = 0;
        currentSessionStartTime = 0;

        await HudDB.settings.set('totalWorkMs', 0);
        await HudDB.settings.set('totalCount', 0);

        /* 미션 카운터 / 보너스도 초기화 */
        if (missionActive) await stopMission(false);   // 진행 중이면 보너스 입력 없이 종료
        missionCount = 0;
        dailyMissionBonus = 0;
        await HudDB.settings.set('missionCount', 0);
        await HudDB.settings.set('dailyMissionBonus_' + HudCommon.todayStr(), 0);

        refreshTimerView();
        updateHeroCard();
        HudCommon.triggerHaptic();
    }


    /* ──────────────────────────────────────────
       3-2-1. 휴식 토글 [v3]
    ────────────────────────────────────────── */
    async function handleRestToggle() {
        if (!isWorking) return;   // 근무 중이 아니면 무시

        const btn = document.getElementById('restBtn');

        if (!isResting) {
            /* ── 휴식 시작 ── */
            isResting     = true;
            restStartTime = Date.now();

            /* DB에 휴식 기록 시작 */
            const newId = await HudDB.restLogs.add({
                date:       HudCommon.todayStr(),
                startTime:  restStartTime,
                endTime:    null,
                durationMs: 0,
            });
            currentRestLogId = newId;

            if (btn) { btn.innerText = '재개'; btn.classList.add('resting'); }
            refreshTimerView();
            HudCommon.triggerHaptic();

        } else {
            /* ── 휴식 종료 ── */
            const duration  = Date.now() - restStartTime;
            isResting       = false;
            totalRestMs    += duration;

            /* DB 휴식 기록 완료 */
            if (currentRestLogId) {
                const rows = await HudDB.restLogs.getAll();
                const row  = rows.find(r => r.id === currentRestLogId);
                if (row) {
                    row.endTime    = Date.now();
                    row.durationMs = duration;
                    await HudDB.restLogs.update(row);
                }
                currentRestLogId = null;
            }
            await HudDB.settings.set('todayRestMs', totalRestMs);

            if (btn) { btn.innerText = '휴식'; btn.classList.remove('resting'); }
            refreshTimerView();
            HudCommon.triggerHaptic();
        }
    }


    /* ──────────────────────────────────────────
       3-3. 미션 모드
       ──────────────────────────────────────────
       원칙:
         - 근무 START 상태에서만 작동 (OFF면 자동 START 동반)
         - 버튼 한 번 = 즉시 시작
         - 수동 종료 (다시 누름) → 보너스 입력 팝업
         - 30분 단위 알림
    ────────────────────────────────────────── */
    const MISSION_ALERT_INTERVAL_MIN = 30;

    async function toggleMission() {
        await HudCommon.initAudio();
        if (missionActive) {
            await stopMission(true);
        } else {
            /* 근무 OFF 면 함께 시작 안내 */
            if (!isWorking) {
                const ok = await showAlert({
                    type: 'confirm', icon: '🎯',
                    title: '미션 시작',
                    message: '근무가 시작되지 않았습니다.\n\n근무를 시작하고 미션도 함께 시작합니다.\n계속하시겠습니까?',
                    okText: '시작', cancelText: '취소'
                });
                if (!ok) return;
                /* 근무 자동 시작 */
                await handleWorkToggle();
            }
            await startMission();
        }
    }

    async function startMission() {
        missionActive    = true;
        missionStartTime = Date.now();
        missionCount     = 0;
        missionLastAlertMin = 0;

        await HudDB.settings.set('missionActive', true);
        await HudDB.settings.set('missionStartTime', missionStartTime);
        await HudDB.settings.set('missionCount', 0);

        /* 타이머 뷰를 미션으로 자동 전환 */
        currentTimerView = 'mission';

        /* 버튼 활성화 */
        const btn = document.getElementById('missionBtn');
        if (btn) btn.classList.add('active');

        /* 알림 인터벌 시작 — 1분마다 체크하여 30분 단위 도달 시 알림 */
        clearInterval(missionAlertInterval);
        missionAlertInterval = setInterval(checkMissionAlert, 60 * 1000);

        /* 시작 알림 */
        HudCommon.speakDirect('미션 시작');
        HudCommon.triggerHaptic();

        updateHeroCard();
    }

    /**
     * @param {boolean} askBonus 보너스 입력 팝업 표시 여부
     */
    async function stopMission(askBonus = true) {
        if (!missionActive) return;

        const endTime = Date.now();
        const duration = endTime - missionStartTime;
        const finishedCount = missionCount;
        const startTs = missionStartTime;

        missionActive = false;
        clearInterval(missionAlertInterval);
        missionAlertInterval = null;
        currentTimerView = 'work';   // 타이머 뷰를 work로 복귀

        await HudDB.settings.remove('missionActive');
        await HudDB.settings.remove('missionStartTime');

        const btn = document.getElementById('missionBtn');
        if (btn) btn.classList.remove('active');

        HudCommon.speakDirect('미션 종료');
        HudCommon.triggerHaptic();

        if (askBonus) {
            /* 보너스 팝업 */
            openMissionBonusPopup({
                startTs, endTime, duration, count: finishedCount
            });
        } else {
            /* 보너스 없이 저장 */
            await saveMission({ startTs, endTime, duration, count: finishedCount, bonus: 0 });
            missionCount = 0;
            await HudDB.settings.set('missionCount', 0);
            updateHeroCard();
        }
    }

    /** 30분 단위 / 잔여 10분, 5분 알림 */
    function checkMissionAlert() {
        if (!missionActive) return;
        const elapsedMin = Math.floor((Date.now() - missionStartTime) / 60000);

        /* 30분 단위 */
        if (elapsedMin > 0 && elapsedMin % MISSION_ALERT_INTERVAL_MIN === 0
            && elapsedMin !== missionLastAlertMin) {
            missionLastAlertMin = elapsedMin;
            HudCommon.speakDirect('미션 ' + elapsedMin + '분 경과, ' + missionCount + '건 완료');
            HudCommon.triggerHaptic();
        }
    }

    /* ───── 미션 보너스 팝업 ───── */
    let pendingMission = null;

    function openMissionBonusPopup(missionData) {
        pendingMission = missionData;
        const summary = document.getElementById('missionBonusSummary');
        const min = Math.floor(missionData.duration / 60000);
        const timeStr = min < 60 ? min + '분' : Math.floor(min/60) + '시간 ' + (min%60) + '분';
        summary.innerHTML = '미션 시간: ' + timeStr + ' · ' + missionData.count + '건 완료<br>'
                          + '<span style="color:var(--orange);font-size:0.7rem;">받은 보너스가 없으면 0 입력</span>';
        document.getElementById('missionBonusInput').value = '';
        document.getElementById('missionBonusOverlay').classList.add('open');
    }

    async function closeMissionBonus(save) {
        const overlay = document.getElementById('missionBonusOverlay');
        const bonusInput = parseInt(document.getElementById('missionBonusInput').value) || 0;
        const bonus = save ? bonusInput : 0;

        if (pendingMission) {
            await saveMission({
                startTs:  pendingMission.startTs,
                endTime:  pendingMission.endTime,
                duration: pendingMission.duration,
                count:    pendingMission.count,
                bonus
            });

            /* 그날 누적 보너스에 합산 */
            if (bonus > 0) {
                dailyMissionBonus += bonus;
                await HudDB.settings.set('dailyMissionBonus_' + HudCommon.todayStr(), dailyMissionBonus);
            }
        }
        pendingMission = null;
        missionCount = 0;
        await HudDB.settings.set('missionCount', 0);

        overlay.classList.remove('open');
        updateHeroCard();
    }

    async function saveMission(m) {
        await HudDB.missions.add({
            date:          HudCommon.todayStr(),
            startTime:     m.startTs,
            endTime:       m.endTime,
            durationMs:    m.duration,
            deliveryCount: m.count,
            bonus:         m.bonus,
            status:        'completed'
        });
    }

    /** 진행 중 미션 복원 (앱 재시작 시) */
    async function restoreMissionState() {
        const active = await HudDB.settings.get('missionActive');
        if (!active) return;

        const startTs = await HudDB.settings.get('missionStartTime');
        const savedCount = (await HudDB.settings.get('missionCount')) || 0;

        /* 24시간 초과 시 자동 취소 */
        if (!startTs || Date.now() - startTs > 24 * 3600 * 1000) {
            await HudDB.settings.remove('missionActive');
            await HudDB.settings.remove('missionStartTime');
            return;
        }

        missionActive    = true;
        missionStartTime = startTs;
        missionCount     = savedCount;

        const btn = document.getElementById('missionBtn');
        if (btn) btn.classList.add('active');

        clearInterval(missionAlertInterval);
        missionAlertInterval = setInterval(checkMissionAlert, 60 * 1000);
    }

    /** 그날 누적 미션 보너스 로드 */
    async function loadDailyMissionBonus() {
        dailyMissionBonus = (await HudDB.settings.get('dailyMissionBonus_' + HudCommon.todayStr())) || 0;
    }

    /** 외부에서 미션 보너스 합계 조회 (manager.js가 사용) */
    function getDailyMissionBonus() {
        return dailyMissionBonus;
    }


    /* ──────────────────────────────────────────
       4. 층수 버튼 (1F·L·B1·B2·B3·B4·B5)
       마지막 선택 층은 IndexedDB에 기억하여 재시작 후에도 표시
    ────────────────────────────────────────── */
    async function handleFloorToggle(id) {
        await HudCommon.initAudio();
        const btn = document.getElementById(id);
        if (!btn) return;

        if (activeFloor === id) {
            btn.classList.remove('active');
            activeFloor = null;
            await HudDB.settings.set('lastFloor', null);
        } else {
            if (activeFloor) {
                const prev = document.getElementById(activeFloor);
                if (prev) prev.classList.remove('active');
            }
            btn.classList.add('active');
            activeFloor = id;
            await HudDB.settings.set('lastFloor', id);
            HudCommon.speakFloor(id);

            /* 선택한 버튼이 화면 중앙에 오도록 스크롤 */
            const scroll = document.getElementById('floorScroll');
            if (scroll && btn.offsetParent === scroll) {
                const targetX = btn.offsetLeft - (scroll.clientWidth / 2) + (btn.clientWidth / 2);
                scroll.scrollTo({ left: targetX, behavior: 'smooth' });
            }
        }
    }

    /** 마지막 선택 층 복원 */
    async function restoreLastFloor() {
        const last = await HudDB.settings.get('lastFloor');
        if (!last) return;
        const btn = document.getElementById(last);
        if (!btn) return;
        btn.classList.add('active');
        activeFloor = last;
        /* 화면에 보이도록 스크롤 (애니메이션 없이) */
        const scroll = document.getElementById('floorScroll');
        if (scroll) {
            const targetX = btn.offsetLeft - (scroll.clientWidth / 2) + (btn.clientWidth / 2);
            scroll.scrollLeft = Math.max(0, targetX);
        }
    }


    /* ──────────────────────────────────────────
       5. 도착 / 픽업 / 드롭 3버튼 시스템
       ──────────────────────────────────────────
       사이클:
         (대기)  →  도착 → (조리 대기)  →  픽업 → (배달 중)  →  드롭 → (대기)
    ────────────────────────────────────────── */

    /** 도착 — 매장 도착 시각 기록 + 조리 대기 타이머 시작 */
    async function handleArrive() {
        await HudCommon.initAudio();

        if (currentDelivery) {
            const ok = await showAlert({
                type: 'confirm', icon: '🔄', title: '새 배달 시작',
                message: '진행 중인 배달이 있습니다.\n새 배달로 시작하시겠습니까?\n(이전 배달은 취소됩니다)',
                okText: '새로 시작', cancelText: '취소'
            });
            if (!ok) return;
        }

        const lat = HudCommon.lat;
        const lng = HudCommon.lon;

        currentDelivery = {
            phase: 'arrived',
            arrived: { ts: Date.now(), lat, lng, region: null }
        };

        document.getElementById('btnArrive').classList.add('active');
        document.getElementById('btnPickupNew').classList.remove('active');

        await persistCurrentDelivery();
        startDeliveryTimer();
        HudCommon.triggerHaptic('arrive');
    }

    /** 픽업 — 음식 수령 시각 기록 + 배달 타이머 전환 */
    async function handlePickup() {
        await HudCommon.initAudio();

        /* 도착 없이 바로 픽업 — 자동으로 도착 처리 */
        if (!currentDelivery) {
            await handleArrive();
            await new Promise(r => setTimeout(r, 50));
        }

        if (currentDelivery.phase === 'pickedUp') return;   // 중복 방지

        currentDelivery.phase = 'pickedUp';
        currentDelivery.pickedUp = {
            ts:  Date.now(),
            lat: HudCommon.lat,
            lng: HudCommon.lon
        };

        document.getElementById('btnArrive').classList.remove('active');
        document.getElementById('btnPickupNew').classList.add('active');

        pickupVibeNotified = false;
        await persistCurrentDelivery();
        startDeliveryTimer();   // 타이머 재시작 (배달 시간 기준)
        HudCommon.triggerHaptic('pickup');
    }

    /** 드롭 — 배달 완료 + 전체 사이클 IndexedDB 저장 */
    async function handleDrop() {
        await HudCommon.initAudio();

        /* 토탈 카운터 +1 */
        totalCount += 1;
        await HudDB.settings.set('totalCount', totalCount);

        /* 미션 중이면 미션 카운터도 +1 + 알림 */
        if (missionActive) {
            missionCount += 1;
            await HudDB.settings.set('missionCount', missionCount);
            HudCommon.speakDirect('미션 ' + missionCount + '건');
        }

        if (!currentDelivery) {
            /* 도착·픽업 없이 단독 드롭 — 카운트만 +1 (간이 모드) */
            await saveDeliveryLog({
                ts: Date.now(),
                lat: HudCommon.lat,
                lng: HudCommon.lon,
                solo: true
            });
            HudCommon.triggerHaptic('drop');
            updateHeroCard();
            return;
        }

        const dropped = {
            ts:  Date.now(),
            lat: HudCommon.lat,
            lng: HudCommon.lon,
            region: null
        };

        const arrived  = currentDelivery.arrived;
        const pickedUp = currentDelivery.pickedUp || arrived;

        /* 시간 계산 */
        const waitMinutes     = Math.round((pickedUp.ts - arrived.ts)  / 60000);
        const deliveryMinutes = Math.round((dropped.ts  - pickedUp.ts) / 60000);
        const totalMinutes    = Math.round((dropped.ts  - arrived.ts)  / 60000);

        /* 배달거리 계산: 픽업→드롭 직선거리 × 1.3 (도로거리 추정) [v3] */
        let distance = 0;
        if (pickedUp.lat && pickedUp.lng && dropped.lat && dropped.lng) {
            const straightKm = HudCommon.getD(
                pickedUp.lat, pickedUp.lng,
                dropped.lat,  dropped.lng
            );
            distance = Math.round(straightKm * 1.3 * 100) / 100;  // 소수 2자리
        }

        const log = {
            workLogId: null,
            date:      HudCommon.todayStr(),
            timeSlot:  HudCommon.getTimeSlot(),
            dayOfWeek: new Date().getDay(),
            arrived, pickedUp, dropped,
            floor:     activeFloor,
            waitMinutes, deliveryMinutes, totalMinutes,
            distance,   // km [v3]
        };

        await HudDB.deliveryLogs.add(log);

        /* 사이클 종료 */
        currentDelivery = null;
        await persistCurrentDelivery();
        stopDeliveryTimer();
        document.getElementById('btnArrive').classList.remove('active');
        document.getElementById('btnPickupNew').classList.remove('active');
        document.getElementById('pickupIndicator').classList.remove('visible', 'warning');

        HudCommon.triggerHaptic('drop');
        updateHeroCard();
    }

    /** 도착·픽업 없이 단독 드롭 (간이 카운트) */
    async function saveDeliveryLog(opts) {
        await HudDB.deliveryLogs.add({
            workLogId: null,
            date:      HudCommon.todayStr(),
            timeSlot:  HudCommon.getTimeSlot(),
            dayOfWeek: new Date().getDay(),
            arrived:   null,
            pickedUp:  null,
            dropped:   { ts: opts.ts, lat: opts.lat, lng: opts.lng, region: null },
            floor:     activeFloor,
            waitMinutes: null, deliveryMinutes: null, totalMinutes: null,
            solo: true
        });
    }

    /** 배달 취소 */
    async function cancelPickup() {
        currentDelivery = null;
        await persistCurrentDelivery();
        stopDeliveryTimer();
        document.getElementById('btnArrive').classList.remove('active');
        document.getElementById('btnPickupNew').classList.remove('active');
        document.getElementById('pickupIndicator').classList.remove('visible', 'warning');
    }


    /* ──────────────────────────────────────────
       6. 배달 타이머 (히어로카드 좌상단 배지)
    ────────────────────────────────────────── */
    function startDeliveryTimer() {
        clearInterval(deliveryTimerInterval);
        updateDeliveryTimerUI();
        deliveryTimerInterval = setInterval(updateDeliveryTimerUI, 1000);
    }
    function stopDeliveryTimer() {
        clearInterval(deliveryTimerInterval);
        deliveryTimerInterval = null;
        pickupVibeNotified = false;
    }

    function updateDeliveryTimerUI() {
        const area      = document.getElementById('pickupIndicator');
        const indicator = area?.querySelector('.pickup-indicator');
        const timeText  = document.getElementById('pickupTimeText');
        if (!area || !indicator || !timeText) return;

        if (!currentDelivery) {
            area.classList.remove('visible', 'warning');
            return;
        }

        const startTs = currentDelivery.phase === 'pickedUp'
            ? currentDelivery.pickedUp.ts
            : currentDelivery.arrived.ts;
        const elapsed = Date.now() - startTs;

        const label = currentDelivery.phase === 'pickedUp' ? '🛵 배달 중' : '⏱ 조리 대기';
        indicator.innerText = label;
        timeText.innerText  = formatElapsed(elapsed);
        area.classList.add('visible');

        if (elapsed > PICKUP_WARN_MS) area.classList.add('warning');
        else                          area.classList.remove('warning');

        if (elapsed > PICKUP_VIBE_MS && !pickupVibeNotified) {
            pickupVibeNotified = true;
            HudCommon.triggerHaptic();
        }
    }

    function formatElapsed(ms) {
        const totalMin = Math.floor(ms / 60000);
        const sec      = Math.floor((ms % 60000) / 1000);
        if (totalMin < 60) return totalMin + ':' + String(sec).padStart(2,'0');
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        return h + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
    }

    async function persistCurrentDelivery() {
        if (currentDelivery) await HudDB.settings.set('currentDelivery', currentDelivery);
        else                  await HudDB.settings.remove('currentDelivery');
    }

    async function restoreCurrentDelivery() {
        const saved = await HudDB.settings.get('currentDelivery');
        if (!saved) return;
        /* 24시간 초과 시 자동 취소 */
        const startTs = saved.phase === 'pickedUp' ? saved.pickedUp?.ts : saved.arrived?.ts;
        if (!startTs || Date.now() - startTs > 24 * 3600 * 1000) {
            await HudDB.settings.remove('currentDelivery');
            return;
        }
        currentDelivery = saved;
        if (saved.phase === 'arrived')  document.getElementById('btnArrive').classList.add('active');
        if (saved.phase === 'pickedUp') document.getElementById('btnPickupNew').classList.add('active');
        startDeliveryTimer();
    }


    /* ──────────────────────────────────────────
       7. 장소 저장 / 로드 / 렌더링
    ────────────────────────────────────────── */
    async function loadPlaces() {
        const rows = await HudDB.places.getAll();
        const pin  = HudCommon.getPin();
        places = [];
        for (const row of rows) {
            if (!row.encBlob) continue;
            const data = await HudCommon.decrypt(row.encBlob, pin);
            if (data) places.push({ id: row.id, ...data });
        }
    }

    async function savePlace() {
        const nameEl = document.getElementById('placeName');
        const memoEl = document.getElementById('placeMemo');
        const name   = nameEl.value.trim();
        const memo   = memoEl.value.trim();
        if (!name) return;

        const locPin = window._locatePin;   // {lat, lng, active}
        const pin    = HudCommon.getPin();

        if (editingId !== null) {
            const idx = places.findIndex(p => p.id === editingId);
            if (idx > -1) {
                places[idx].name = name;
                places[idx].memo = memo;
                if (locPin && locPin.active) {
                    places[idx].pins = places[idx].pins || [];
                    places[idx].pins[0] = { lat: locPin.lat, lng: locPin.lng };
                }
                const enc = await HudCommon.encrypt({
                    name: places[idx].name, memo: places[idx].memo, pins: places[idx].pins
                }, pin);
                await HudDB.places.update({ id: editingId, encBlob: enc, savedAt: Date.now() });
            }
            editingId = null;
        } else {
            const newPlace = { name, memo, pins: [] };
            if (locPin && locPin.active) newPlace.pins = [{ lat: locPin.lat, lng: locPin.lng }];
            const enc = await HudCommon.encrypt(newPlace, pin);
            const newId = await HudDB.places.add({ encBlob: enc });
            places.push({ id: newId, ...newPlace });
        }

        nameEl.value = ''; memoEl.value = '';
        document.getElementById('scrollPh')?.classList.remove('hidden');
        window._locatePin = null;
        renderPlaceList();
    }

    async function deletePlace(id) {
        const place = places.find(p => p.id === id);
        const ok = await showAlert({
            type: 'warn', icon: '🗑️', title: '장소 삭제',
            message: '"' + (place?.name || '') + '" 을(를) 삭제하시겠습니까?',
            okText: '삭제', cancelText: '취소'
        });
        if (!ok) return;
        await HudDB.places.remove(id);
        places = places.filter(p => p.id !== id);
        if (editingId === id) {
            editingId = null;
            document.getElementById('placeName').value = '';
            document.getElementById('placeMemo').value = '';
        }
        renderPlaceList();
    }

    function editPlace(id) {
        const place = places.find(p => p.id === id);
        if (!place) return;
        editingId = id;
        document.getElementById('placeName').value = place.name;
        document.getElementById('placeMemo').value = place.memo || '';
        document.getElementById('scrollPh')?.classList.add('hidden');
        document.getElementById('placeListArea').scrollTo({ top: 0, behavior: 'smooth' });
    }


    /* 현위치 GPS 핀 등록 (역지오코딩) */
    async function locateAndSave() {
        const lat = HudCommon.lat;
        const lng = HudCommon.lon;
        if (!lat || !lng) {
            await showAlert({
                type: 'info', icon: '📡', title: 'GPS 확인 중',
                message: 'GPS 위치를 확인 중입니다.\n잠시 후 다시 시도해주세요.'
            });
            return;
        }
        if (typeof kakao !== 'undefined' && kakao.maps?.services) {
            const geocoder = new kakao.maps.services.Geocoder();
            geocoder.coord2Address(lng, lat, (result, status) => {
                let placeName = '';
                if (status === kakao.maps.services.Status.OK && result[0]) {
                    const addr = result[0].address;
                    placeName = addr.region_3depth_name || addr.region_2depth_name || '';
                    if (result[0].road_address?.building_name) placeName = result[0].road_address.building_name;
                }
                document.getElementById('placeName').value = placeName;
                document.getElementById('placeMemo').focus();
                window._locatePin = { lat, lng, active: true };
                showLocateFeedback(placeName || '현재 위치');
            });
        } else {
            document.getElementById('placeName').value = '';
            document.getElementById('placeMemo').focus();
            window._locatePin = { lat, lng, active: true };
            showLocateFeedback('현재 위치');
        }
    }

    function showLocateFeedback(name) {
        const fb = document.createElement('div');
        fb.className = 'locate-feedback';
        fb.innerHTML = '<div style="font-size:1.5rem;margin-bottom:8px;">📍</div>'
                     + '<div style="font-size:0.9rem;font-weight:bold;color:var(--green);">'
                     + HudCommon.escapeHtml(name) + '</div>'
                     + '<div style="font-size:0.7rem;color:#888;margin-top:4px;">메모를 입력하세요</div>';
        document.body.appendChild(fb);
        setTimeout(() => {
            fb.style.transition = 'opacity 0.5s';
            fb.style.opacity    = '0';
            setTimeout(() => fb.remove(), 500);
        }, 2000);
    }


    /* ──────────────────────────────────────────
       8. 장소 목록 렌더링
       정렬 모드 토글: 'distance' (가까운 순) | 'recent' (최근 저장 순)
    ────────────────────────────────────────── */
    let listSortMode = 'distance';
    let lastRenderTime = 0;

    function toggleSortMode() {
        listSortMode = listSortMode === 'distance' ? 'recent' : 'distance';
        renderPlaceList();
    }

    function renderPlaceList() {
        const list = document.getElementById('placeList');
        if (!list) return;

        const lat = HudCommon.lat, lon = HudCommon.lon;

        /* 정렬 */
        if (listSortMode === 'distance' && lat && lon) {
            places.sort((a, b) =>
                HudCommon.getPlaceMinDist(a, lat, lon) - HudCommon.getPlaceMinDist(b, lat, lon));
        } else if (listSortMode === 'recent') {
            /* 최근 저장 순 — id가 클수록 최신 */
            places.sort((a, b) => (b.id || 0) - (a.id || 0));
        }

        /* 헤더: 정렬 토글 + 총 개수 */
        let html = '<div style="display:flex;justify-content:space-between;align-items:center;'
                +  'padding:0 4px 6px;font-size:0.7rem;color:var(--dim);">'
                +    '<span>저장 ' + places.length + '개</span>'
                +    '<button id="listSortToggle" style="background:#1a1a1a;border:1px solid #333;'
                +      'color:#ccc;padding:4px 10px;border-radius:6px;font-size:0.7rem;cursor:pointer;">'
                +      (listSortMode === 'distance' ? '📍 가까운 순' : '🕐 최근 저장 순')
                +    '</button>'
                +  '</div>';

        /* 전체 렌더링 (제한 없음) */
        html += places.map((p, i) => {
            const pins = p.pins || [];
            const dist = (lat && lon && pins.length)
                ? HudCommon.getPlaceMinDist(p, lat, lon).toFixed(2) + 'km'
                : '--';
            const borderColor = (listSortMode === 'distance' && i === 0) ? 'var(--green)' : 'var(--yellow)';
            const p0 = pins[0], p1 = pins[1];
            return '<div class="place-item" style="border-left-color:' + borderColor + '">'
                +   '<div style="display:flex;align-items:center;">'
                +     '<button class="gps-btn' + (p0?' saved':'') + '" data-action="pin0" data-id="' + p.id + '">' + (p0?'📍¹':'📌¹') + '</button>'
                +     '<button class="gps-btn' + (p1?' saved':'') + '" data-action="pin1" data-id="' + p.id + '">' + (p1?'📍²':'📌²') + '</button>'
                +     '<div style="margin-left:6px;"><span style="font-size:0.65rem;color:#888;">' + dist + '</span><br>'
                +     '<b>' + HudCommon.escapeHtml(p.name) + '</b></div>'
                +   '</div>'
                +   '<div style="display:flex;align-items:center;gap:6px;">'
                +     '<span style="font-size:1rem;font-weight:bold;color:var(--orange)">' + HudCommon.escapeHtml(p.memo || '') + '</span>'
                +     '<button class="edit-btn" data-action="edit" data-id="' + p.id + '">수정</button>'
                +     '<button class="edit-btn" style="border-color:var(--red);color:var(--red);" data-action="delete" data-id="' + p.id + '">삭제</button>'
                +   '</div>'
                + '</div>';
        }).join('');

        list.innerHTML = html;

        /* 정렬 토글 버튼 이벤트 */
        const sortBtn = document.getElementById('listSortToggle');
        if (sortBtn) sortBtn.addEventListener('click', toggleSortMode);
    }

    /* 이벤트 위임 — 장소 목록 액션 */
    document.addEventListener('click', e => {
        const btn = e.target.closest('#placeList [data-action]');
        if (!btn) return;
        const id     = parseInt(btn.dataset.id);
        const action = btn.dataset.action;
        if      (action === 'edit')   editPlace(id);
        else if (action === 'delete') deletePlace(id);
        else if (action === 'pin0')   updatePlacePin(id, 0);
        else if (action === 'pin1')   updatePlacePin(id, 1);
    });

    async function updatePlacePin(id, pinIndex) {
        navigator.geolocation.getCurrentPosition(async pos => {
            const place = places.find(p => p.id === id);
            if (!place) return;
            place.pins = place.pins || [];
            while (place.pins.length <= pinIndex) place.pins.push(null);
            place.pins[pinIndex] = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            const pin = HudCommon.getPin();
            const enc = await HudCommon.encrypt({ name: place.name, memo: place.memo, pins: place.pins }, pin);
            await HudDB.places.update({ id, encBlob: enc, savedAt: Date.now() });
            renderPlaceList();
        }, async err => {
            const msg = err.code === 1 ? '위치 권한이 차단되어 있습니다.'
                      : err.code === 3 ? 'GPS 신호가 약합니다. 잠시 후 다시 시도하세요.'
                      : 'GPS 핀 저장에 실패했습니다.';
            await showAlert({ type: 'warn', icon: '📡', title: 'GPS 오류', message: msg });
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    }


    /* ──────────────────────────────────────────
       9. 히어로 카드 (v2)
       모드: 'counter' (평소, 토탈 카운터)
            'place'   (가까운 장소 30m 이내)
       카운터 클릭 시: TOTAL ↔ 시간당 건수 토글
    ────────────────────────────────────────── */
    let totalCount = 0;       // 토탈 드롭 카운터
    let showHourly = false;   // 시간당 표시 토글

    /** 토탈 카운터 보정 (⊖ ⊕ 버튼) — 미션 중이면 미션도 함께 */
    function adjustCount(delta) {
        totalCount = Math.max(0, totalCount + delta);
        HudDB.settings.set('totalCount', totalCount);
        if (missionActive) {
            missionCount = Math.max(0, missionCount + delta);
            HudDB.settings.set('missionCount', missionCount);
        }
        HudCommon.triggerHaptic();
        updateCounterCard();
    }

    /** 카운터 카드 클릭 시 TOTAL ↔ 시간당 토글 */
    function toggleCountMode() {
        showHourly = !showHourly;
        updateCounterCard();
    }

    /** 시간당 건수 계산 (현재 근무시간 기준) */
    function computeHourly() {
        const ms = getCurrentWorkMs();
        if (ms < 60000) return 0;   // 1분 미만 = 0
        const hours = ms / 3600000;
        return totalCount / hours;
    }

    /* ───────────────────────────────────────
       히어로카드 — 마지막 근접 장소 표시 전용
       lastNearbyPlace는 30m 이내 들어왔던 마지막 장소
    ─────────────────────────────────────── */
    let lastNearbyPlace = null;   // { name, memo }

    function updateHeroCard() {
        const placeArea = document.getElementById('heroPlaceArea');
        const emptyArea = document.getElementById('heroEmptyArea');

        if (placeArea) {
            if (lastNearbyPlace) {
                placeArea.classList.remove('hidden');
                const nameEl = document.getElementById('heroPlaceName');
                const memoEl = document.getElementById('heroMemo');
                if (nameEl) nameEl.innerText = lastNearbyPlace.name || '';
                if (memoEl) memoEl.innerText = lastNearbyPlace.memo || '';
            } else {
                placeArea.classList.add('hidden');
            }
        }
        if (emptyArea) emptyArea.classList.add('hidden');  // 속도카드엔 별도 빈상태 없음

        /* 미션 배지 표시 */
        const missionBadge = document.getElementById('missionBadge');
        if (missionBadge) {
            missionBadge.style.display = missionActive ? 'block' : 'none';
        }

        /* 카운터 카드도 같이 갱신 (편의) */
        updateCounterCard();
    }

    /* ───────────────────────────────────────
       카운터 카드 — 토탈/미션/시간당 표시
    ─────────────────────────────────────── */
    function updateCounterCard() {
        const numEl   = document.getElementById('heroCountNum');
        const labelEl = document.getElementById('heroCountLabel');
        if (!numEl || !labelEl) return;

        if (showHourly) {
            /* 시간당 건수 */
            const h = computeHourly();
            numEl.innerText = h.toFixed(1);
            numEl.className = 'count-num hourly';
            labelEl.innerText = '건 / 시간';
            labelEl.className = 'count-label hourly';
        } else if (missionActive) {
            /* 미션 카운터 (초록 형광) */
            numEl.innerText = missionCount;
            numEl.className = 'count-num mission';
            labelEl.innerText = '⚡ MISSION COUNT';
            labelEl.className = 'count-label mission';
        } else {
            /* 평소: 토탈 카운터 */
            numEl.innerText = totalCount;
            numEl.className = 'count-num';
            labelEl.innerText = 'Total Count';
            labelEl.className = 'count-label';
        }

        /* ⊖ ⊕ 버튼도 미션 색 적용 */
        document.querySelectorAll('.count-adjust-btn').forEach(btn => {
            if (missionActive) btn.classList.add('mission');
            else btn.classList.remove('mission');
        });
    }


    /* ──────────────────────────────────────────
       10. GPS 위치 업데이트 핸들러
    ────────────────────────────────────────── */
    async function handleLocationUpdate(lat, lon) {
        /* 속도 카드 업데이트 */
        const speedEl = document.getElementById('speedNum');
        if (speedEl) speedEl.innerText = Math.round(HudCommon.speed || 0);

        if (!places.length) { updateHeroCard(); return; }

        const closest = HudCommon.getClosestPlace(places, lat, lon);
        if (!closest) return;
        const dist = HudCommon.getPlaceMinDist(closest, lat, lon);

        /* 30m 이내 들어옴 → lastNearbyPlace 갱신 */
        if (dist <= 0.03) {
            lastNearbyPlace = { name: closest.name, memo: closest.memo };
            updateHeroCard();
        }

        const now = Date.now();
        if (now - lastRenderTime > 3000) {
            renderPlaceList();
            lastRenderTime = now;
        }

        /* GPS 모드 전환: 가까우면 고정밀 */
        HudCommon.setGpsMode(dist < 0.03 ? 'tracking' : 'normal');

        /* TTS 근접 안내 */
        await HudCommon.handleTTS(closest, dist);
    }


    /* ──────────────────────────────────────────
       공개 API
    ────────────────────────────────────────── */
    return {
        init, onResume,

        /* 근무 */
        handleWorkToggle, confirmResetTimer,
        handleRestToggle,   /* 휴식 버튼 [v3] */

        /* 층수 */
        handleFloorToggle,

        /* 도착 / 픽업 / 드롭 */
        handleArrive, handlePickup, handleDrop, cancelPickup,

        /* 장소 */
        savePlace, locateAndSave, deletePlace, editPlace,

        /* 히어로카드 — 카운터 / 장소 자동 전환 */
        toggleCountMode, adjustCount,

        /* hudpro8 UI — 타이머 뷰 전환 */
        setTimerView,
        toggleMission,
    };

})();
