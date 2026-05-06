/* ============================================================
   HUD for Riders — js/heatmap.js
   히트맵 탭 — 전략 지도
   ============================================================
   설계문서 §05 단계별 활성화 (전업 라이더 주 200건 기준):
     0~399건    지도만 표시 / 진행 상황 프로그레스바
     400건~     기본 히트맵 — 자주 간 곳
     800건~     시간대별 히트맵 — 언제 어디서
     1,200건~   효율 히트맵   [유료]
     2,000건~   전략 히트맵   [유료]
   ============================================================ */

const HudHeatmap = (() => {

    /* ──────────────────────────────────────────
       1. 단계 정의
    ────────────────────────────────────────── */
    const STAGES = [
        { id: 1, threshold:    0, name: '지도',        desc: '드롭 위치 마커 표시' },
        { id: 2, threshold:  400, name: '기본 히트맵', desc: '자주 가는 곳 시각화' },
        { id: 3, threshold:  800, name: '시간대별',    desc: '언제 어디서 일하는지' },
        { id: 4, threshold: 1200, name: '효율 히트맵', desc: '어디서 돈이 되는지', paid: true },
        { id: 5, threshold: 2000, name: '전략 히트맵', desc: '내 황금 공식',       paid: true }
    ];

    function getCurrentStage(count) {
        let stage = STAGES[0];
        for (const s of STAGES) {
            if (count >= s.threshold) stage = s;
        }
        return stage;
    }

    function getNextStage(count) {
        for (const s of STAGES) {
            if (count < s.threshold) return s;
        }
        return null;
    }


    /* ──────────────────────────────────────────
       2. 상태
    ────────────────────────────────────────── */
    let kakaoMap     = null;
    let heatmap      = null;
    let markerLayer  = [];
    let activeFilter = { timeSlot: null, dayOfWeek: null };


    /* ──────────────────────────────────────────
       3. 탭 진입 시 호출
    ────────────────────────────────────────── */
    async function onShow() {
        await render();
    }


    /* ──────────────────────────────────────────
       4. 메인 렌더
    ────────────────────────────────────────── */
    async function render() {
        const container = document.getElementById('heatmapContainer');
        if (!container) return;

        /* index.html의 로딩 중 인라인 스타일(flex 가운데 정렬) 리셋 */
        container.style.cssText = 'width:100%;flex:1;display:flex;flex-direction:column;';

        const totalCount = await HudDB.deliveryLogs.count();
        const stage      = getCurrentStage(totalCount);
        const next       = getNextStage(totalCount);

        container.innerHTML = `
            <div style="display:flex;flex-direction:column;height:100%;width:100%;gap:8px;">

                <!-- 진행 상황 -->
                ${renderProgress(totalCount, stage, next)}

                <!-- 필터 (800건 이상) -->
                ${stage.id >= 3 ? renderFilters() : ''}

                <!-- 지도 영역 -->
                <div id="hmMapBox" style="flex:1;position:relative;border-radius:10px;overflow:hidden;background:#0d0d0d;border:1px solid var(--border);min-height:300px;">
                    <div id="hmMap" style="width:100%;height:100%;"></div>
                    ${stage.id === 1 && totalCount === 0 ? renderEmptyOverlay() : ''}
                    ${stage.paid ? renderPaidLock(stage) : ''}
                </div>

                <!-- 단계 안내 -->
                <div style="font-size:0.7rem;color:var(--dim);text-align:center;line-height:1.5;">
                    ${stage.desc}${stage.paid ? ' <span style="color:var(--orange);">· 유료</span>' : ''}
                </div>
            </div>
        `;

        attachFilterEvents();

        /* 카카오맵 초기화 (탭 진입마다 재생성) */
        await ensureKakaoMap();

        /* 데이터 그리기 (유료 잠금 단계는 데이터 미표시) */
        if (!stage.paid) {
            const drops = await getFilteredDrops();
            drawDataOnMap(drops, stage);
        }
    }


    /* ──────────────────────────────────────────
       5. 진행 상황 프로그레스바
    ────────────────────────────────────────── */
    function renderProgress(count, stage, next) {
        if (!next) {
            return `<div style="background:var(--card);border:1px solid var(--green);border-radius:10px;padding:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <div style="font-size:0.7rem;color:var(--green);letter-spacing:1px;">현재 단계</div>
                        <div style="font-size:0.95rem;font-weight:900;color:#fff;margin-top:2px;">${stage.name}</div>
                    </div>
                    <div style="font-size:1.2rem;font-weight:900;color:var(--green);">${count.toLocaleString()}건</div>
                </div>
            </div>`;
        }

        const remain = next.threshold - count;
        const prevTh = stage.threshold;
        const span   = next.threshold - prevTh;
        const cur    = count - prevTh;
        const pct    = Math.min(100, Math.round((cur / span) * 100));

        return `<div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <div>
                    <div style="font-size:0.7rem;color:var(--dim);letter-spacing:1px;">현재</div>
                    <div style="font-size:0.9rem;font-weight:900;color:#fff;">${stage.name}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:0.7rem;color:var(--dim);">${count.toLocaleString()} / ${next.threshold.toLocaleString()}</div>
                    <div style="font-size:0.7rem;color:var(--green);">${remain.toLocaleString()}건 남음</div>
                </div>
            </div>
            <div style="height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--green),#006b1c);transition:width 0.5s;"></div>
            </div>
            <div style="font-size:0.65rem;color:var(--dim);margin-top:6px;text-align:center;">
                다음: <span style="color:var(--orange);">${next.name}</span>${next.paid ? ' <span style="color:var(--orange);">🔒 유료</span>' : ''}
            </div>
        </div>`;
    }


    /* ──────────────────────────────────────────
       6. 필터 (시간대 / 요일)
    ────────────────────────────────────────── */
    function renderFilters() {
        const slots = ['오전','점피','오후','저피','야간','심야'];
        const days  = ['일','월','화','수','목','금','토'];

        const slotChips = slots.map(s =>
            `<button class="hm-chip${activeFilter.timeSlot===s?' on':''}" data-filter="time" data-val="${s}">${s}</button>`
        ).join('');

        const dayChips = days.map((d, i) =>
            `<button class="hm-chip${activeFilter.dayOfWeek===i?' on':''}" data-filter="day" data-val="${i}">${d}</button>`
        ).join('');

        const showClear = activeFilter.timeSlot || activeFilter.dayOfWeek !== null;

        return `<div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px;">
            <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;">${slotChips}</div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">${dayChips}</div>
            ${showClear ? '<button class="hm-chip clear" id="hmClearFilter" style="margin-top:6px;">필터 해제</button>' : ''}
        </div>`;
    }

    function attachFilterEvents() {
        document.querySelectorAll('#heatmapContainer .hm-chip[data-filter]').forEach(el => {
            el.addEventListener('click', async () => {
                const type = el.dataset.filter;
                const val  = el.dataset.val;
                if (type === 'time') {
                    activeFilter.timeSlot = activeFilter.timeSlot === val ? null : val;
                } else if (type === 'day') {
                    const dayNum = parseInt(val);
                    activeFilter.dayOfWeek = activeFilter.dayOfWeek === dayNum ? null : dayNum;
                }
                await render();
            });
        });
        const clearBtn = document.getElementById('hmClearFilter');
        if (clearBtn) clearBtn.addEventListener('click', async () => {
            activeFilter = { timeSlot: null, dayOfWeek: null };
            await render();
        });
    }


    /* ──────────────────────────────────────────
       7. 빈 상태 / 유료 잠금 오버레이
    ────────────────────────────────────────── */
    function renderEmptyOverlay() {
        return `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);">
            <div style="font-size:2.5rem;margin-bottom:8px;">📍</div>
            <div style="font-size:0.85rem;color:#fff;font-weight:700;">아직 드롭 기록이 없습니다</div>
            <div style="font-size:0.7rem;color:var(--dim);margin-top:4px;">HUD 탭에서 드롭 버튼을 눌러보세요</div>
        </div>`;
    }

    function renderPaidLock(stage) {
        return `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);">
            <div style="font-size:2.5rem;margin-bottom:8px;">🔒</div>
            <div style="font-size:0.95rem;color:#fff;font-weight:900;">${stage.name}</div>
            <div style="font-size:0.75rem;color:var(--orange);margin-top:6px;letter-spacing:1px;">${stage.desc}</div>
            <div style="font-size:0.65rem;color:var(--dim);margin-top:12px;text-align:center;line-height:1.6;">
                추후 유료 기능으로 출시 예정<br>
                <span style="color:#888;">데이터는 계속 축적됩니다</span>
            </div>
        </div>`;
    }


    /* ──────────────────────────────────────────
       8. 카카오맵 초기화
    ────────────────────────────────────────── */
    async function ensureKakaoMap() {
        const node = document.getElementById('hmMap');
        if (!node) return;

        /* 탭 재진입 시 DOM 재생성 → 맵 재초기화 */
        kakaoMap = null;
        heatmap = null;
        markerLayer = [];

        await new Promise(resolve => {
            if (window.kakao && kakao.maps && kakao.maps.load) {
                kakao.maps.load(() => {
                    const center = (HudCommon.lat && HudCommon.lon)
                        ? new kakao.maps.LatLng(HudCommon.lat, HudCommon.lon)
                        : new kakao.maps.LatLng(37.5665, 126.978);
                    kakaoMap = new kakao.maps.Map(node, { center, level: 5 });
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }


    /* ──────────────────────────────────────────
       9. 데이터 필터링
    ────────────────────────────────────────── */
    async function getFilteredDrops() {
        const all = await HudDB.deliveryLogs.getAll();
        return all
            .filter(d => d.dropped?.lat && d.dropped?.lng)
            .filter(d => !activeFilter.timeSlot  || d.timeSlot  === activeFilter.timeSlot)
            .filter(d => activeFilter.dayOfWeek === null || d.dayOfWeek === activeFilter.dayOfWeek)
            .map(d => ({
                lat: d.dropped.lat, lng: d.dropped.lng,
                date: d.date, timeSlot: d.timeSlot, dayOfWeek: d.dayOfWeek
            }));
    }


    /* ──────────────────────────────────────────
       10. 지도에 그리기
    ────────────────────────────────────────── */
    function drawDataOnMap(drops, stage) {
        if (!kakaoMap) return;

        if (heatmap) { heatmap.setMap(null); heatmap = null; }
        markerLayer.forEach(m => m.setMap(null));
        markerLayer = [];

        if (!drops.length) return;

        /* 단계 1: 마커만 (최근 50건) */
        if (stage.id === 1) {
            drops.slice(-50).forEach(d => {
                const m = new kakao.maps.Marker({
                    position: new kakao.maps.LatLng(d.lat, d.lng),
                    map: kakaoMap
                });
                markerLayer.push(m);
            });
            const last = drops[drops.length - 1];
            kakaoMap.setCenter(new kakao.maps.LatLng(last.lat, last.lng));
            return;
        }

        /* 단계 2~3: 히트맵 */
        if (kakao.maps.visualization?.Heatmap) {
            const points = drops.map(d => ({
                location: new kakao.maps.LatLng(d.lat, d.lng),
                weight: 1
            }));
            const radius = stage.id >= 3 ? 30 : 25;
            heatmap = new kakao.maps.visualization.Heatmap({
                map: kakaoMap, data: points,
                radius, opacity: 0.7
            });

            /* 중심점: 현재 위치 → 없으면 가장 최근 데이터 */
            const centerLat = HudCommon.lat || drops[drops.length - 1].lat;
            const centerLng = HudCommon.lon || drops[drops.length - 1].lng;
            kakaoMap.setCenter(new kakao.maps.LatLng(centerLat, centerLng));
        } else {
            /* visualization 라이브러리 미로드 → 마커 fallback */
            drops.slice(-200).forEach(d => {
                const m = new kakao.maps.Marker({
                    position: new kakao.maps.LatLng(d.lat, d.lng),
                    map: kakaoMap
                });
                markerLayer.push(m);
            });
        }
    }


    /* ──────────────────────────────────────────
       공개 API
    ────────────────────────────────────────── */
    return { onShow, render };

})();
