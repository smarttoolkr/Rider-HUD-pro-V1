/* ============================================================
   HUD for Riders — js/manager.js  v3
   통계 엔진 전면 재작성
   ============================================================
   신규 KPI:
     ✅ 실시급 (수입 ÷ 실근무시간)
     ✅ 공차비율 % (공차시간 ÷ 실근무시간)
     ✅ 평균 조리대기시간 (도착→픽업)
     ✅ 평균 배달시간 (픽업→드롭)
     ✅ km당 수입 (이동효율)
     ✅ 플랫폼별 수입 비교
     ✅ 시간대별 시급 (건수 아닌 ₩/h)
     ✅ 요일×시간대 매트릭스
     ✅ 거리별 분석 (단/중/장거리)
     ✅ 이번달 예상 수입 예측
   ============================================================ */

const HudManager = (() => {

    /* ── 유틸 ── */
    const safeDiv = (n, d) => (d && d > 0 ? Math.round(n / d) : 0);

    /* ── 상수 ── */
    const PLATFORMS = {
        coupang: { label: '쿠팡이츠', color: '#ff2727' },
        baemin:  { label: '배민',     color: '#00cba9' },
        other:   { label: '기타',     color: '#888888' },
        agency:  { label: '일반대행', color: '#f39c12' },
    };
    const TIME_SLOTS  = ['오전','점피','오후','저피','야간','심야'];
    const DAY_LABELS  = ['일','월','화','수','목','금','토'];

    /* ── 상태 ── */
    let activeRange       = 'today';
    let pendingSessionMs  = 0;
    let pendingActiveMs   = 0;
    let platformData      = _emptyPlatformData();
    let activePlatformTab = 'coupang';


    /* ══════════════════════════════════════════
       1. 탭 진입 / 렌더
    ══════════════════════════════════════════ */
    async function onShow() { await render(); }

    async function render() {
        const container = document.getElementById('managerContainer');
        if (!container) return;
        container.style.cssText = 'width:100%;display:block;';

        const s = await computeStats();
        container.innerHTML = buildHTML(s);

        _attachTabEvents();
        _renderBars(s);
        _renderTimeSlotWage(s);
        _renderDayTimeMatrix(s);
        _renderPlatformBars(s);
        _renderDistanceBars(s);
        _renderWorkLogs(s.recentLogs);
    }


    /* ══════════════════════════════════════════
       2. 핵심 통계 집계
    ══════════════════════════════════════════ */
    async function computeStats() {
        const [allLogs, allDrops, allRests] = await Promise.all([
            HudDB.workLogs.getAll(),
            HudDB.deliveryLogs.getAll(),
            HudDB.restLogs.getAll(),
        ]);

        const range = _rangeWindow(activeRange);
        const logs  = allLogs.filter(l => l.date >= range.start && l.date <= range.end);
        const drops = allDrops.filter(d => d.date >= range.start && d.date <= range.end);
        const rests = allRests.filter(r => r.date >= range.start && r.date <= range.end);

        /* ── 시간 집계 ── */
        const totalMs  = logs.reduce((s, l) => s + (l.durationMs || 0), 0);
        const restMs   = logs.reduce((s, l) => s + (l.restMs || 0), 0)
                       || rests.reduce((s, r) => s + (r.durationMs || 0), 0);
        const activeMs = logs.reduce((s, l) => s + (l.activeMs || 0), 0)
                       || Math.max(0, totalMs - restMs);

        /* 공차시간 계산: 드롭 → 다음 도착 사이 시간 */
        const idleMs   = _computeIdleMs(drops);

        /* ── 수입 집계 ── */
        const income        = logs.reduce((s, l) => s + (l.income || 0), 0);
        const deliveries    = drops.filter(d => d.dropped?.ts).length
                            || logs.reduce((s, l) => s + (l.deliveryCount || 0), 0);

        /* ── 시급 ── */
        const totalHourly  = totalMs  > 0 ? Math.round(income / (totalMs  / 3600000)) : 0;
        const realHourly   = activeMs > 0 ? Math.round(income / (activeMs / 3600000)) : 0;

        /* ── 건당 / 거리 ── */
        const avgPerDelivery = deliveries > 0 ? Math.round(income / deliveries) : 0;
        const totalDistance  = drops.reduce((s, d) => s + (d.distance || 0), 0);
        const incomePerKm    = totalDistance > 0 ? Math.round(income / totalDistance) : 0;

        /* ── 배달 사이클 ── */
        const cycle = _computeCycle(drops);

        /* ── 공차비율 ── */
        const idleRatio = activeMs > 0 ? Math.round((idleMs / activeMs) * 100) : 0;

        /* ── 플랫폼별 ── */
        const platformMap = _computePlatform(logs);

        /* ── 7일 그래프 ── */
        const dailyMap = _build7DayMap(allLogs, allDrops);

        /* ── 시간대별 시급 ── */
        const slotWageMap = _computeSlotWage(allLogs, allDrops);

        /* ── 요일×시간대 매트릭스 (건수) ── */
        const matrix = _computeMatrix(allDrops);

        /* ── 거리별 분석 ── */
        const distMap = _computeDistRange(drops);

        /* ── 스트릭 / 기록 일수 ── */
        const allDates  = [...new Set(allLogs.map(l => l.date))].sort();
        const streak    = _computeStreak(allDates);
        const totalDays = allDates.length;

        /* ── 예측 ── */
        const prediction = _computePrediction(income, totalMs, activeRange);

        /* ── 최고 기록 ── */
        const records = _computeRecords(allLogs);

        /* ── 연속배달 유지율 / 시간당 처리건수 ── */
        const ordersPerHour = totalMs > 0
            ? Math.round((deliveries / (totalMs / 3600000)) * 10) / 10 : 0;
        const chainRate = activeMs > 0
            ? Math.max(0, Math.round((1 - idleMs / activeMs) * 100)) : 0;

        /* ── 최근 기록 ── */
        const recentLogs = [...logs].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 30);

        return {
            income, totalMs, activeMs, restMs, idleMs,
            totalHourly, realHourly,
            deliveries, avgPerDelivery,
            totalDistance, incomePerKm,
            idleRatio, chainRate, ordersPerHour,
            cycle,
            platformMap,
            dailyMap, slotWageMap, matrix,
            distMap,
            streak, totalDays,
            prediction, records,
            recentLogs,
        };
    }


    /* ── 공차시간 계산 ── */
    function _computeIdleMs(drops) {
        const sorted = [...drops]
            .filter(d => d.dropped?.ts && d.arrived?.ts)
            .sort((a, b) => a.dropped.ts - b.dropped.ts);

        let idle = 0;
        for (let i = 1; i < sorted.length; i++) {
            const gap = sorted[i].arrived.ts - sorted[i-1].dropped.ts;
            if (gap > 0 && gap < 3600000) idle += gap; // 0~60분 사이만
        }
        return idle;
    }

    /* ── 배달 사이클 분석 ── */
    function _computeCycle(drops) {
        const full = drops.filter(d => d.arrived?.ts && d.pickedUp?.ts && d.dropped?.ts);
        if (!full.length) return { avgWait: 0, avgDeliv: 0, count: 0 };

        const waits  = full.map(d => (d.pickedUp.ts - d.arrived.ts) / 60000);
        const delivs = full.map(d => (d.dropped.ts  - d.pickedUp.ts) / 60000);

        const _avg = arr => arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0;
        return {
            avgWait:  Math.round(_avg(waits)  * 10) / 10,
            avgDeliv: Math.round(_avg(delivs) * 10) / 10,
            count:    full.length,
        };
    }

    /* ── 플랫폼별 집계 ── */
    function _computePlatform(logs) {
        const map = {};
        Object.keys(PLATFORMS).forEach(k => { map[k] = { income: 0, mission: 0, count: 0 }; });

        logs.forEach(l => {
            const bp = l.byPlatform;
            if (!bp) return;
            Object.keys(PLATFORMS).forEach(k => {
                if (bp[k]) {
                    map[k].income  += bp[k].delivery || 0;
                    map[k].mission += bp[k].mission  || 0;
                    map[k].count   += bp[k].count    || 0;
                }
            });
        });
        return map;
    }

    /* ── 시간대별 시급 ── */
    function _computeSlotWage(allLogs, allDrops) {
        const map = {};
        TIME_SLOTS.forEach(s => { map[s] = { income: 0, ms: 0, count: 0 }; });

        // workLogs의 timeSlot별 근무시간은 없으므로 deliveryLogs 기준
        // 각 시간대 드롭건 × 건당평균수입 으로 추정
        const totalDrops  = allDrops.filter(d => d.timeSlot).length;
        const allLogsIncome = allLogs.reduce((s,l) => s+l.income, 0);
        const avgPerDrop  = totalDrops > 0 ? allLogsIncome / totalDrops : 0;

        allDrops.forEach(d => {
            if (!d.timeSlot) return;
            const slot = d.timeSlot;
            if (!map[slot]) return;
            map[slot].count++;
            map[slot].income += avgPerDrop;
        });

        // 시간대별 근무시간 추정 (건수 × 평균배달시간 × 2)
        allDrops.forEach(d => {
            if (!d.timeSlot) return;
            const delMin = d.deliveryMinutes || 20;
            map[d.timeSlot].ms += delMin * 60000 * 2;
        });

        // 시급 계산
        const result = {};
        TIME_SLOTS.forEach(s => {
            const { income, ms, count } = map[s];
            result[s] = {
                count,
                wage: ms > 0 ? Math.round(income / (ms / 3600000)) : 0,
            };
        });
        return result;
    }

    /* ── 요일×시간대 매트릭스 ── */
    function _computeMatrix(allDrops) {
        // matrix[dayOfWeek][timeSlotIdx] = count
        const matrix = Array.from({length:7}, () => Array(6).fill(0));
        allDrops.forEach(d => {
            const dow  = d.dayOfWeek;
            const slot = TIME_SLOTS.indexOf(d.timeSlot);
            if (dow >= 0 && dow < 7 && slot >= 0) matrix[dow][slot]++;
        });
        return matrix;
    }

    /* ── 거리별 분석 ── */
    function _computeDistRange(drops) {
        const ranges = {
            short:  { label: '단거리 <1km',  min: 0,   max: 1,   count: 0, income: 0 },
            medium: { label: '중거리 1~3km', min: 1,   max: 3,   count: 0, income: 0 },
            long:   { label: '장거리 >3km',  min: 3,   max: 999, count: 0, income: 0 },
        };
        // 건당 평균 수입은 workLog에서만 알 수 있으므로 건수만 집계
        drops.filter(d => d.distance > 0).forEach(d => {
            const km = d.distance;
            if      (km < 1)  { ranges.short.count++;  ranges.short.income  += d.estIncome || 0; }
            else if (km < 3)  { ranges.medium.count++; ranges.medium.income += d.estIncome || 0; }
            else              { ranges.long.count++;   ranges.long.income   += d.estIncome || 0; }
        });
        return ranges;
    }

    /* ── 7일 그래프 데이터 ── */
    function _build7DayMap(allLogs, allDrops) {
        const map = {};
        const today = HudCommon.todayStr();
        for (let i = 6; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            const k = d.toISOString().slice(0,10);
            map[k] = { income: 0, deliveries: 0, workMs: 0, wage: 0 };
        }
        allLogs.forEach(l => {
            if (!map[l.date]) return;
            map[l.date].income   += l.income || 0;
            map[l.date].workMs   += l.durationMs || 0;
        });
        allDrops.forEach(d => {
            if (!map[d.date]) return;
            map[d.date].deliveries++;
        });
        Object.values(map).forEach(v => {
            v.wage = v.workMs > 0 ? Math.round(v.income / (v.workMs / 3600000)) : 0;
        });
        return map;
    }

    /* ── 스트릭 ── */
    function _computeStreak(sortedDates) {
        if (!sortedDates.length) return 0;
        let streak = 1, max = 1;
        for (let i = 1; i < sortedDates.length; i++) {
            const prev = new Date(sortedDates[i-1]);
            const cur  = new Date(sortedDates[i]);
            const diff = (cur - prev) / 86400000;
            if (diff === 1) { streak++; max = Math.max(max, streak); }
            else { streak = 1; }
        }
        return max;
    }

    /* ── 예측 ── */
    function _computePrediction(income, totalMs, range) {
        if (range !== 'month' || totalMs < 3600000) return null;
        const now       = new Date();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
        const daysPassed  = now.getDate();
        const daysLeft    = daysInMonth - daysPassed;
        const dailyAvg    = income / daysPassed;
        const projected   = Math.round(income + dailyAvg * daysLeft);
        return { projected, daysPassed, daysLeft, dailyAvg: Math.round(dailyAvg) };
    }

    /* ── 최고 기록 ── */
    function _computeRecords(allLogs) {
        if (!allLogs.length) return {};
        const bestIncome = allLogs.reduce((b, l) => l.income > (b.income||0) ? l : b, {});
        const bestWage   = allLogs.reduce((b, l) => (l.realHourlyWage||l.hourlyWage||0) > (b.realHourlyWage||b.hourlyWage||0) ? l : b, {});
        return { bestIncome, bestWage };
    }

    /* ── 날짜 범위 ── */
    function _rangeWindow(range) {
        const today = HudCommon.todayStr();
        const d = new Date();
        if (range === 'today') return { start: today, end: today };
        if (range === 'week')  {
            const mon = new Date(d); mon.setDate(d.getDate() - d.getDay() + 1);
            return { start: mon.toISOString().slice(0,10), end: today };
        }
        if (range === 'month') {
            return { start: today.slice(0,7) + '-01', end: today };
        }
        return { start: '2000-01-01', end: today };
    }


    /* ══════════════════════════════════════════
       3. HTML 빌드
    ══════════════════════════════════════════ */
    function buildHTML(s) {
        return `
        <!-- 기간 탭 -->
        <div class="mgr-range-tabs" style="padding-bottom:10px;">
            ${['today','week','month','all'].map((r,i) =>
                `<div class="mgr-range-tab${activeRange===r?' active':''}" data-range="${r}">${['오늘','주간','월간','전체'][i]}</div>`
            ).join('')}
        </div>

        <!-- ★ 하이라이트 카드 (statv5 스타일) -->
        <div class="mgr-highlight-main" style="margin:0 14px 10px;">
            <span class="mgr-hl-label">최우선 생산성 지표 · 순작업시간당 수입</span>
            <div class="mgr-hl-value">${s.realHourly > 0 ? '₩'+_fmt(s.realHourly) : '--'}<span class="mgr-hl-unit">/h</span></div>
        </div>
        <div class="mgr-highlight-sub" style="margin:0 14px 10px;">
            <div class="mgr-hl-sub-card">
                <span class="mgr-hl-sub-label">연속배달 유지율</span>
                <div class="mgr-hl-sub-value">${s.chainRate}<span style="font-size:0.7em;">%</span></div>
            </div>
            <div class="mgr-hl-sub-card">
                <span class="mgr-hl-sub-label">시간당 처리건수</span>
                <div class="mgr-hl-sub-value">${s.ordersPerHour}<span style="font-size:0.7em;">건/h</span></div>
            </div>
        </div>

        <!-- ★ 인사이트 카드 -->
        <div class="mgr-section">
            <div class="mgr-section-title">💡 AI 인사이트</div>
            ${buildInsightCards(s)}
        </div>

        <!-- ① 핵심 요약 카드 -->
        <div class="mgr-summary">
            <div class="mgr-summary-label">${_rangeLabel(activeRange)}</div>
            <div class="mgr-summary-income">₩${_fmt(s.income)}</div>
            <div class="mgr-summary-sub">
                <span>${s.deliveries}건</span>
                <span class="mgr-sep">·</span>
                <span>총 ${_fmtMs(s.totalMs)}</span>
                <span class="mgr-sep">·</span>
                <span>실 ${_fmtMs(s.activeMs)}</span>
            </div>
        </div>

        <!-- ② 시간 분해 바 -->
        ${buildTimeBreakdown(s)}

        <!-- ③ KPI 카드 6개 -->
        <div class="mgr-kpi-grid">
            ${kpiCard('⏱ 총시급',   '₩'+_fmt(s.totalHourly),  '/h')}
            ${kpiCard('⚡ 실시급',   '₩'+_fmt(s.realHourly),   '/h', 'green')}
            ${kpiCard('📦 건당수입', '₩'+_fmt(s.avgPerDelivery), '')}
            ${kpiCard('🛣 km당수입', s.incomePerKm > 0 ? '₩'+_fmt(s.incomePerKm) : '--', '/km')}
            ${kpiCard('🍳 조리대기', s.cycle.avgWait > 0 ? s.cycle.avgWait+'분' : '--', '')}
            ${kpiCard('🏍 배달시간', s.cycle.avgDeliv > 0 ? s.cycle.avgDeliv+'분' : '--', '')}
        </div>

        <!-- ④ 플랫폼별 수입 -->
        ${buildPlatformSection(s)}

        <!-- ⑤ 7일 수입 그래프 -->
        <div class="mgr-section">
            <div class="mgr-section-title">📈 최근 7일 수입</div>
            <div class="mgr-bars" id="mgrDailyBars"></div>
        </div>

        <!-- ⑥ 시간대별 시급 -->
        <div class="mgr-section">
            <div class="mgr-section-title">🕐 시간대별 시급</div>
            <div class="mgr-bars" id="mgrSlotBars"></div>
        </div>

        <!-- ⑦ 요일×시간대 매트릭스 -->
        <div class="mgr-section">
            <div class="mgr-section-title">📅 요일×시간대 배달건수</div>
            <div id="mgrMatrix"></div>
        </div>

        <!-- ⑧ 거리별 분석 -->
        ${buildDistSection(s)}

        <!-- ⑨ 예측 -->
        ${s.prediction ? buildPrediction(s.prediction) : ''}

        <!-- ⑩ 최고 기록 -->
        ${buildRecords(s.records)}

        <!-- ⑪ 근무 기록 리스트 -->
        <div class="mgr-section">
            <div class="mgr-section-title">📋 근무 기록</div>
            <div id="mgrWorkLogs"></div>
        </div>

        <!-- 백업/복원 -->
        <div class="mgr-section">
            <div class="mgr-section-title">💾 데이터</div>
            <button class="settings-action-btn" onclick="HudManager.exportBackup()">
                <span>백업 파일 내보내기 (.enc)</span><span style="color:#888;">→</span>
            </button>
            <button class="settings-action-btn" onclick="document.getElementById('mgrRestoreFile').click()">
                <span>백업 파일 복원</span><span style="color:#888;">→</span>
            </button>
            <input type="file" id="mgrRestoreFile" accept=".enc" style="display:none"
                   onchange="HudManager.importBackup(event)">
            <button class="settings-action-btn settings-action-danger"
                    onclick="HudManager.clearAllStats()">
                <span>전체 통계 초기화</span><span style="color:var(--red);">✕</span>
            </button>
        </div>

        <div style="height:60px;"></div>
        `;
    }

    function buildTimeBreakdown(s) {
        const total = s.totalMs || 1;
        const activePct = Math.round((s.activeMs / total) * 100);
        const restPct   = Math.round((s.restMs   / total) * 100);
        const idlePct   = Math.round((s.idleMs   / total) * 100);
        const workPct   = Math.max(0, 100 - activePct - restPct - idlePct);

        return `<div class="mgr-section mgr-time-breakdown">
            <div class="mgr-section-title">⏱ 시간 분해</div>
            <div class="mgr-time-bar">
                <div class="mgr-time-seg active"   style="width:${activePct}%"></div>
                <div class="mgr-time-seg rest"     style="width:${restPct}%"></div>
                <div class="mgr-time-seg idle"     style="width:${idlePct}%"></div>
                <div class="mgr-time-seg cooldown" style="width:${workPct}%"></div>
            </div>
            <div class="mgr-time-legend">
                <div class="mgr-tl-item"><span class="mgr-tl-dot active"></span>실근무 ${_fmtMs(s.activeMs)}</div>
                <div class="mgr-tl-item"><span class="mgr-tl-dot rest"></span>휴식 ${_fmtMs(s.restMs)}</div>
                <div class="mgr-tl-item"><span class="mgr-tl-dot idle"></span>공차 ${_fmtMs(s.idleMs)} <span class="mgr-idle-ratio">${s.idleRatio}%</span></div>
            </div>
        </div>`;
    }

    function buildPlatformSection(s) {
        const entries = Object.entries(PLATFORMS)
            .map(([k, p]) => ({ ...p, key: k, ...s.platformMap[k] }))
            .filter(p => p.income > 0 || p.mission > 0);

        if (!entries.length) return `<div class="mgr-section">
            <div class="mgr-section-title">🏢 플랫폼별 수입</div>
            <div class="mgr-empty">기록 없음</div>
        </div>`;

        const maxIncome = Math.max(...entries.map(p => (p.income||0)+(p.mission||0)), 1);

        return `<div class="mgr-section">
            <div class="mgr-section-title">🏢 플랫폼별 수입</div>
            <div id="mgrPlatformBars">
            ${entries.map(p => {
                const total = (p.income||0) + (p.mission||0);
                const pct   = Math.round((total / maxIncome) * 100);
                return `<div class="mgr-platform-row">
                    <div class="mgr-platform-label" style="color:${p.color}">${p.label}</div>
                    <div class="mgr-platform-bar-wrap">
                        <div class="mgr-platform-bar" style="width:${pct}%;background:${p.color}22;border-color:${p.color}55;">
                            <div class="mgr-platform-fill" style="width:${Math.round((p.income||0)/total*100)}%;background:${p.color};"></div>
                        </div>
                    </div>
                    <div class="mgr-platform-val">
                        <span>₩${_fmtShort(total)}</span>
                        ${p.mission > 0 ? `<span class="mgr-mission-badge">미션+${_fmtShort(p.mission)}</span>` : ''}
                        ${p.count   > 0 ? `<span class="mgr-count-badge">${p.count}건</span>` : ''}
                    </div>
                </div>`;
            }).join('')}
            </div>
        </div>`;
    }

    function buildDistSection(s) {
        const { short, medium, long } = s.distMap;
        const maxCount = Math.max(short.count, medium.count, long.count, 1);
        const rows = [
            { ...short,  color: '#00ff41' },
            { ...medium, color: '#f39c12' },
            { ...long,   color: '#ff3e3e' },
        ];
        return `<div class="mgr-section">
            <div class="mgr-section-title">🛣 거리별 배달 (추정 도로거리 ×1.3)</div>
            ${rows.map(r => {
                const pct = Math.round((r.count / maxCount) * 100);
                return `<div class="mgr-dist-row">
                    <div class="mgr-dist-label">${r.label}</div>
                    <div class="mgr-dist-bar-wrap">
                        <div class="mgr-dist-bar" style="width:${pct}%;background:${r.color}33;border:1px solid ${r.color}66;"></div>
                    </div>
                    <div class="mgr-dist-val" style="color:${r.color}">${r.count}건</div>
                </div>`;
            }).join('')}
        </div>`;
    }

    function buildPrediction(p) {
        return `<div class="mgr-section mgr-prediction">
            <div class="mgr-section-title">🔮 이번달 예측</div>
            <div class="mgr-pred-main">₩${_fmt(p.projected)}</div>
            <div class="mgr-pred-sub">
                ${p.daysPassed}일 경과 · ${p.daysLeft}일 남음 · 일평균 ₩${_fmt(p.dailyAvg)}
            </div>
        </div>`;
    }

    function buildRecords(r) {
        if (!r.bestIncome?.income) return '';
        return `<div class="mgr-section">
            <div class="mgr-section-title">🏆 최고 기록</div>
            <div class="mgr-records">
                <div class="mgr-record-item">
                    <div class="mgr-record-label">최고 수입일</div>
                    <div class="mgr-record-val">₩${_fmt(r.bestIncome.income)}</div>
                    <div class="mgr-record-date">${r.bestIncome.date || ''}</div>
                </div>
                <div class="mgr-record-item">
                    <div class="mgr-record-label">최고 시급일</div>
                    <div class="mgr-record-val">₩${_fmt(r.bestWage.realHourlyWage || r.bestWage.hourlyWage || 0)}/h</div>
                    <div class="mgr-record-date">${r.bestWage.date || ''}</div>
                </div>
            </div>
        </div>`;
    }

    /* ══════════════════════════════════════════
       인사이트 카드 생성
    ══════════════════════════════════════════ */
    function buildInsightCards(s) {
        const insights = { good: [], warn: [], bad: [] };

        /* ── 데이터 충분성 체크 ── */
        const hasEnoughData = s.deliveries >= 5 && s.totalMs >= 3600000;
        if (!hasEnoughData) {
            const need = Math.max(0, 5 - s.deliveries);
            return `<div class="mgr-insight-empty">
                📊 인사이트를 생성하려면 데이터가 더 필요합니다
                <span>${need > 0 ? need + '건 더 배달하면 분석이 시작됩니다' : '근무 시간을 늘려주세요'}</span>
            </div>`;
        }

        /* ── 🟢 잘하고 있는 것 ── */

        // 실시급이 최저임금(10,030원) 대비 높으면
        if (s.realHourly >= 25000) {
            insights.good.push(`순작업 시급 <b>₩${_fmt(s.realHourly)}/h</b>로 매우 효율적입니다. 현재 패턴을 유지하세요.`);
        } else if (s.realHourly >= 18000) {
            insights.good.push(`순작업 시급 <b>₩${_fmt(s.realHourly)}/h</b>로 양호한 수준입니다.`);
        }

        // 연속배달 유지율이 높으면
        if (s.chainRate >= 80) {
            insights.good.push(`연속배달 유지율 <b>${s.chainRate}%</b> — 공차 손실이 거의 없습니다.`);
        }

        // 조리 대기가 짧으면
        if (s.cycle.avgWait > 0 && s.cycle.avgWait <= 4) {
            insights.good.push(`조리 대기 평균 <b>${s.cycle.avgWait}분</b> — 빠른 픽업으로 처리량이 높습니다.`);
        }

        // 시간당 처리건수가 높으면
        if (s.ordersPerHour >= 4) {
            insights.good.push(`시간당 <b>${s.ordersPerHour}건</b> 처리 — 상위권 효율입니다.`);
        }

        /* ── 🟡 개선 가능한 것 ── */

        // 조리 대기가 길면
        if (s.cycle.avgWait > 6) {
            insights.warn.push(`조리 대기 평균 <b>${s.cycle.avgWait}분</b> — 대기가 길어 처리량이 줄고 있습니다. 매장 도착 타이밍 조정을 고려하세요.`);
        }

        // 미션 보너스 의존도가 높으면
        if (s.income > 0) {
            const bonusRatio = Math.round(
                (Object.values(s.platformMap).reduce((sum, p) => sum + (p.mission||0), 0) / s.income) * 100
            );
            if (bonusRatio > 30) {
                insights.warn.push(`수입의 <b>${bonusRatio}%</b>가 미션 보너스 의존입니다. 기본 배달 효율도 점검해보세요.`);
            }
        }

        // 실시급과 총시급 차이가 크면 (휴식 과다)
        if (s.totalHourly > 0 && s.realHourly > 0) {
            const gapRatio = Math.round(((s.realHourly - s.totalHourly) / s.realHourly) * 100);
            if (gapRatio > 25) {
                insights.warn.push(`휴식·대기로 인한 시급 손실이 <b>${gapRatio}%</b>입니다. 순작업 시간을 늘리면 수입이 올라갑니다.`);
            }
        }

        // 플랫폼 간 효율 격차가 크면
        const pfEntries = Object.entries(s.platformMap)
            .filter(([, p]) => p.income > 0 && p.count > 0)
            .map(([k, p]) => ({ key: k, label: (PLATFORMS[k]?.label||k), perOrder: safeDiv(p.income + (p.mission||0), p.count) }));
        if (pfEntries.length >= 2) {
            pfEntries.sort((a, b) => b.perOrder - a.perOrder);
            const best  = pfEntries[0];
            const worst = pfEntries[pfEntries.length - 1];
            if (best.perOrder > worst.perOrder * 1.2) {
                insights.warn.push(`<b>${best.label}</b>의 건당 수입(₩${_fmt(best.perOrder)})이 <b>${worst.label}</b>(₩${_fmt(worst.perOrder)})보다 높습니다. 플랫폼 배분을 고려하세요.`);
            }
        }

        /* ── 🔴 손실 구간 ── */

        // 공차 비율이 높으면
        if (s.idleRatio > 20) {
            const lostIncome = Math.round((s.idleMs / 3600000) * s.realHourly);
            insights.bad.push(`공차 시간이 <b>${Math.round(s.idleMs/60000)}분(${s.idleRatio}%)</b>입니다. 이 시간에 배달했으면 약 <b>₩${_fmt(lostIncome)}</b> 추가 수입이 가능했습니다.`);
        }

        // 배달 시간이 너무 길면
        if (s.cycle.avgDeliv > 20) {
            insights.bad.push(`픽업→드롭 평균 <b>${s.cycle.avgDeliv}분</b> — 장거리 위주 배달로 처리량이 낮습니다. 단·중거리 비중을 높여보세요.`);
        }

        // 실시급이 낮으면
        if (s.realHourly > 0 && s.realHourly < 15000) {
            insights.bad.push(`순작업 시급 <b>₩${_fmt(s.realHourly)}/h</b> — 수익성이 낮습니다. 시간대나 지역 변경을 검토하세요.`);
        }

        /* ── 렌더링 ── */
        const renderGroup = (items, icon, cls, title) => {
            if (!items.length) return '';
            return items.map(msg => `
                <div class="mgr-insight-card ${cls}">
                    <div class="mgr-insight-header">${icon} ${title}</div>
                    <div class="mgr-insight-msg">${msg}</div>
                </div>`).join('');
        };

        const html = renderGroup(insights.good, '🟢', 'insight-good', '잘하고 있는 것')
                   + renderGroup(insights.warn, '🟡', 'insight-warn', '개선 가능')
                   + renderGroup(insights.bad,  '🔴', 'insight-bad',  '손실 구간');

        if (!html) return `<div class="mgr-insight-empty">📊 아직 인사이트를 생성할 조건이 없습니다. 계속 기록해주세요.</div>`;

        return `<div class="mgr-insight-wrap">${html}</div>`;
    }

    function kpiCard(label, val, unit, accent='') {
        return `<div class="mgr-kpi-card${accent?' '+accent:''}">
            <div class="mgr-kpi-label">${label}</div>
            <div class="mgr-kpi-val">${val}<span class="mgr-kpi-unit">${unit}</span></div>
        </div>`;
    }


    /* ══════════════════════════════════════════
       4. 차트 렌더 함수들
    ══════════════════════════════════════════ */
    function _renderBars(s) {
        const el = document.getElementById('mgrDailyBars');
        if (!el) return;
        const entries = Object.entries(s.dailyMap);
        const maxIncome = Math.max(...entries.map(([,v]) => v.income), 1);

        el.innerHTML = entries.map(([date, v]) => {
            const pct   = Math.round((v.income / maxIncome) * 100);
            const label = new Date(date).toLocaleDateString('ko-KR',{weekday:'narrow'});
            return `<div class="mgr-bar-col">
                <div class="mgr-bar-val">${v.income > 0 ? _fmtShort(v.income) : ''}</div>
                <div class="mgr-bar${v.income===0?' empty':''}" style="height:${Math.max(2,pct)}%"></div>
                <div class="mgr-bar-label">${label}</div>
            </div>`;
        }).join('');
    }

    function _renderTimeSlotWage(s) {
        const el = document.getElementById('mgrSlotBars');
        if (!el) return;
        const entries = TIME_SLOTS.map(slot => ({ slot, ...s.slotWageMap[slot] }));
        const maxWage = Math.max(...entries.map(e => e.wage), 1);

        el.innerHTML = entries.map(e => {
            const pct = Math.round((e.wage / maxWage) * 100);
            return `<div class="mgr-bar-col">
                <div class="mgr-bar-val">${e.wage > 0 ? _fmtShort(e.wage) : ''}</div>
                <div class="mgr-bar${e.wage===0?' empty':''}" style="height:${Math.max(2,pct)}%"></div>
                <div class="mgr-bar-label">${e.slot}</div>
            </div>`;
        }).join('');
    }

    function _renderDayTimeMatrix(s) {
        const el = document.getElementById('mgrMatrix');
        if (!el) return;
        const matrix = s.matrix;
        const maxVal = Math.max(...matrix.flat(), 1);

        let html = `<table class="mgr-matrix">
            <thead><tr><th></th>${TIME_SLOTS.map(s=>`<th>${s}</th>`).join('')}</tr></thead>
            <tbody>`;
        DAY_LABELS.forEach((day, di) => {
            html += `<tr><td class="mgr-matrix-day">${day}</td>`;
            matrix[di].forEach(val => {
                const intensity = Math.round((val / maxVal) * 100);
                const bg = intensity > 0
                    ? `rgba(0,255,65,${0.1 + intensity/100 * 0.7})`
                    : '#0a0a0a';
                html += `<td style="background:${bg};color:${intensity>50?'#000':'#888'};">
                    ${val > 0 ? val : ''}
                </td>`;
            });
            html += `</tr>`;
        });
        html += `</tbody></table>`;
        el.innerHTML = html;
    }

    function _renderPlatformBars(s) { /* 이미 buildHTML에서 인라인으로 렌더됨 */ }
    function _renderDistanceBars(s) { /* 이미 buildHTML에서 인라인으로 렌더됨 */ }

    function _renderWorkLogs(logs) {
        const el = document.getElementById('mgrWorkLogs');
        if (!el) return;
        if (!logs.length) {
            el.innerHTML = '<div class="mgr-empty">근무 기록이 없습니다.</div>';
            return;
        }
        el.innerHTML = logs.map(l => {
            const realWage = l.realHourlyWage || l.hourlyWage || 0;
            const byPf = l.byPlatform;
            const pfBadges = byPf
                ? Object.entries(byPf)
                    .filter(([,v]) => v.delivery > 0 || v.mission > 0)
                    .map(([k]) => `<span class="mgr-pf-badge" style="border-color:${PLATFORMS[k]?.color||'#888'};">${PLATFORMS[k]?.label||k}</span>`)
                    .join('')
                : '';
            return `<div class="mgr-log-item">
                <div class="mgr-log-top">
                    <div class="mgr-log-date">${l.date} ${pfBadges}</div>
                    <div class="mgr-log-income">₩${_fmt(l.income||0)}</div>
                </div>
                <div class="mgr-log-row">
                    <span>근무 ${_fmtMs(l.durationMs)} · 실 ${_fmtMs(l.activeMs||l.durationMs)}</span>
                    <span>${l.deliveryCount||0}건 · 시급 ₩${_fmt(realWage)}/h</span>
                </div>
            </div>`;
        }).join('');
    }


    /* ══════════════════════════════════════════
       5. 이벤트 연결
    ══════════════════════════════════════════ */
    function _attachTabEvents() {
        document.querySelectorAll('#managerContainer .mgr-range-tab').forEach(el => {
            el.addEventListener('click', async () => {
                activeRange = el.dataset.range;
                await render();
            });
        });
    }


    /* ══════════════════════════════════════════
       6. 시급 팝업 (플랫폼별 수입 입력)
    ══════════════════════════════════════════ */
    function _emptyPlatformData() {
        const d = {};
        Object.keys(PLATFORMS).forEach(k => { d[k] = { delivery: 0, mission: 0, count: 0 }; });
        return d;
    }

    function openWagePopup(sessionMs, activeMs) {
        pendingSessionMs  = sessionMs;
        pendingActiveMs   = activeMs || sessionMs;
        platformData      = _emptyPlatformData();
        activePlatformTab = 'coupang';

        // 오늘 미션 보너스 자동 입력
        HudDB.missions.getByDate(HudCommon.todayStr()).then(missions => {
            const bonus = missions.reduce((s,m) => s + (m.bonus||0), 0);
            if (bonus > 0) {
                platformData.coupang.mission = bonus;
            }
            _renderWagePopup();
        });

        document.getElementById('wageOverlay').classList.add('open');
        _renderWagePopup();
    }

    function _renderWagePopup() {
        const container = document.getElementById('wagePlatformArea');
        if (!container) return;

        const pd = platformData[activePlatformTab] || { delivery: 0, mission: 0 };

        container.innerHTML = `
            <div class="wage-pf-tabs">
                ${Object.entries(PLATFORMS).map(([k,p]) => {
                    const total = (platformData[k].delivery||0) + (platformData[k].mission||0);
                    const hasData = total > 0;
                    return `<button class="wage-pf-tab${activePlatformTab===k?' active':''}"
                        data-pf="${k}" style="${activePlatformTab===k?'border-color:'+p.color+';color:'+p.color:''}">
                        ${p.label}${hasData?`<span class="wage-pf-dot" style="background:${p.color};"></span>`:''}
                    </button>`;
                }).join('')}
            </div>
            <div class="wage-pf-inputs">
                <div class="wage-row-label">배달수입</div>
                <input id="wagePfDelivery" type="number" class="wage-input" placeholder="0"
                    value="${pd.delivery||''}" oninput="HudManager.onWageInput()">
                <div class="wage-row-label">미션수입</div>
                <input id="wagePfMission" type="number" class="wage-input" placeholder="0"
                    value="${pd.mission||''}" oninput="HudManager.onWageInput()">
            </div>
        `;

        // 탭 이벤트
        container.querySelectorAll('.wage-pf-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                _saveCurrentPlatformInput();
                activePlatformTab = btn.dataset.pf;
                _renderWagePopup();
            });
        });

        _updateWageTotal();
    }

    function _saveCurrentPlatformInput() {
        const d = parseInt(document.getElementById('wagePfDelivery')?.value) || 0;
        const m = parseInt(document.getElementById('wagePfMission')?.value)  || 0;
        platformData[activePlatformTab].delivery = d;
        platformData[activePlatformTab].mission  = m;
    }

    function onWageInput() {
        _saveCurrentPlatformInput();
        _updateWageTotal();
    }

    function _updateWageTotal() {
        const totalIncome = Object.values(platformData)
            .reduce((s, p) => s + (p.delivery||0) + (p.mission||0), 0);

        const totalEl = document.getElementById('wageTotalDisplay');
        const resultEl = document.getElementById('wageResult');
        if (totalEl) totalEl.innerText = '₩ ' + _fmt(totalIncome);

        if (resultEl && totalIncome > 0 && pendingActiveMs > 0) {
            const hours    = pendingActiveMs / 3600000;
            const realWage = Math.round(totalIncome / hours);
            const totalWage = Math.round(totalIncome / (pendingSessionMs/3600000));
            const min = Math.floor(pendingActiveMs / 60000);
            const timeStr = min < 60 ? min + '분 실근무' : (min/60).toFixed(1) + '시간 실근무';
            resultEl.innerHTML = `${timeStr}<br>실시급 <b style="color:var(--green);">₩${_fmt(realWage)}/h</b> · 총시급 ₩${_fmt(totalWage)}/h`;
        } else if (resultEl) {
            resultEl.innerHTML = '';
        }
    }

    async function closeWagePopup(save) {
        if (save) {
            _saveCurrentPlatformInput();
            const income = Object.values(platformData).reduce((s,p) => s+(p.delivery||0)+(p.mission||0), 0);
            const drops  = await HudDB.deliveryLogs.getByDate(HudCommon.todayStr());

            const log = {
                date:           HudCommon.todayStr(),
                startTime:      Date.now() - pendingSessionMs,
                endTime:        Date.now(),
                durationMs:     pendingSessionMs,
                activeMs:       pendingActiveMs,
                restMs:         Math.max(0, pendingSessionMs - pendingActiveMs),
                deliveryCount:  drops.length,
                income,
                byPlatform:     JSON.parse(JSON.stringify(platformData)),
                hourlyWage:     pendingSessionMs > 0 ? Math.round(income / (pendingSessionMs/3600000)) : 0,
                realHourlyWage: pendingActiveMs  > 0 ? Math.round(income / (pendingActiveMs /3600000)) : 0,
            };
            const newId = await HudDB.workLogs.add(log);

            for (const d of drops) {
                if (!d.workLogId) {
                    d.workLogId = newId;
                    await HudDB.deliveryLogs.update(d);
                }
            }
        }
        pendingSessionMs = 0; pendingActiveMs = 0;
        document.getElementById('wageOverlay').classList.remove('open');
        if (typeof HudShell !== 'undefined' && HudShell.currentTab === 2) await render();
    }

    function calcWage() { onWageInput(); }   // 하위 호환


    /* ══════════════════════════════════════════
       7. 백업 / 복원
    ══════════════════════════════════════════ */
    async function exportBackup() {
        const pin = HudCommon.getPin();
        if (!pin) {
            await showAlert({ type:'warn', icon:'🔒', title:'잠금 해제 필요', message:'PIN으로 잠금 해제 후 시도하세요.' });
            return;
        }
        const data = {
            workLogs:     await HudDB.workLogs.getAll(),
            deliveryLogs: await HudDB.deliveryLogs.getAll(),
            restLogs:     await HudDB.restLogs.getAll(),
            places:       await HudDB.places.getAll(),
            settings:     await HudDB.settings.getAll(),
            goals:        await HudDB.goals.getAll(),
            emergency:    await HudDB.emergency.getAll(),
            exportDate:   new Date().toISOString(),
            version:      'hud_v3',
        };
        const enc  = await HudCommon.encrypt(data, pin);
        const blob = new Blob([enc], { type:'text/plain' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        const ds   = new Date().toISOString().slice(0,10).replace(/-/g,'');
        a.href = url; a.download = 'hud_backup_' + ds + '.enc'; a.click();
        URL.revokeObjectURL(url);
        await HudDB.settings.set('lastBackupDate', Date.now());
    }

    async function importBackup(event) {
        const file = event.target.files[0];
        if (!file) return;
        const ok = await showAlert({
            type:'warn', icon:'⚠️', title:'백업 복원',
            message:'현재 데이터가 백업 파일로 덮어씌워집니다.\n계속하시겠습니까?',
            okText:'복원', cancelText:'취소'
        });
        if (!ok) { event.target.value=''; return; }

        const reader = new FileReader();
        reader.onload = async (e) => {
            const pin  = HudCommon.getPin();
            const data = await HudCommon.decrypt(e.target.result, pin);
            if (!data) {
                await showAlert({ type:'warn', icon:'❌', title:'복원 실패', message:'PIN이 다르거나 파일이 손상되었습니다.' });
                return;
            }
            await HudDB.workLogs.clear();
            await HudDB.deliveryLogs.clear();
            await HudDB.places.clear();
            await HudDB.emergency.clear();
            await HudDB.restLogs.clear();

            for (const w of (data.workLogs     || [])) { delete w.id; await HudDB.workLogs.add(w); }
            for (const d of (data.deliveryLogs || [])) { delete d.id; await HudDB.deliveryLogs.add(d); }
            for (const r of (data.restLogs     || [])) { delete r.id; await HudDB.restLogs.add(r); }
            for (const p of (data.places       || [])) { delete p.id; await HudDB.places.add(p); }
            for (const e of (data.emergency    || [])) { delete e.id; await HudDB.emergency.add(e); }
            for (const [k,v] of Object.entries(data.settings || {})) await HudDB.settings.set(k,v);
            for (const [k,v] of Object.entries(data.goals    || {})) await HudDB.goals.set(k,v);

            await showAlert({ type:'info', icon:'✅', title:'복원 완료', message:'데이터를 성공적으로 복원했습니다.' });
            await render();
        };
        reader.readAsText(file);
        event.target.value = '';
    }


    /* ══════════════════════════════════════════
       8. 유틸
    ══════════════════════════════════════════ */
    function _fmt(n)      { return (n||0).toLocaleString('ko-KR'); }
    function _fmtShort(n) {
        if (n >= 10000) return (n/10000).toFixed(1) + '만';
        if (n >= 1000)  return Math.round(n/1000) + 'k';
        return String(n||0);
    }
    function _fmtMs(ms) {
        if (!ms || ms < 60000) return '0분';
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        return h > 0 ? `${h}h ${m}m` : `${m}분`;
    }
    function _rangeLabel(r) {
        return ({today:'오늘 수입', week:'이번 주 수입', month:'이번 달 수입', all:'전체 수입'})[r];
    }


    /* ══════════════════════════════════════════
       공개 API
    ══════════════════════════════════════════ */
    /* ── 전체 통계 초기화 ── */
    async function clearAllStats() {
        /* 1단계 확인 */
        const step1 = await showAlert({
            type: 'confirm', icon: '⚠️',
            title: '통계 초기화',
            message: '모든 정산 기록과 배달 로그가 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.',
            okText: '계속', cancelText: '취소'
        });
        if (!step1) return;

        /* 2단계 확인 */
        const step2 = await showAlert({
            type: 'confirm', icon: '🔴',
            title: '정말 삭제하시겠습니까?',
            message: '전체 근무 기록과 통계 데이터가\n완전히 삭제됩니다.',
            okText: '삭제', cancelText: '취소'
        });
        if (!step2) return;

        try {
            await HudDB.workLogs.clear();
            await HudDB.deliveryLogs.clear();
            await showAlert({ type:'info', icon:'✅', title:'초기화 완료', message:'통계 데이터가 초기화되었습니다.' });
            render();
        } catch(e) {
            await showAlert({ type:'info', icon:'❌', title:'오류', message:'초기화 중 오류가 발생했습니다.' });
        }
    }

    return {
        onShow, render,
        openWagePopup, onWageInput, calcWage, closeWagePopup,
        exportBackup, importBackup,
        clearAllStats,
        get PLATFORMS() { return PLATFORMS; },
    };

})();

/* ── index.html 하위 호환 ── */
function calcWage()           { HudManager.calcWage(); }
function closeWagePopup(save) { HudManager.closeWagePopup(save); }
function exportBackup()       { HudManager.exportBackup(); }
function importBackup(e)      { HudManager.importBackup(e); }
