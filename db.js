/* ============================================================
   HUD for Riders — js/db.js  v3
   변경사항:
     v2→v3: hud_restLogs 신규, workLogs·deliveryLogs 스키마 확장
   ============================================================ */

const HudDB = (() => {

    const DB_NAME    = 'hud_for_riders';
    const DB_VERSION = 3;
    let _db = null;

    /* ──────────────────────────────────────────
       1. DB 초기화
    ────────────────────────────────────────── */
    function open() {
        return new Promise((resolve, reject) => {
            if (_db) { resolve(_db); return; }

            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db      = e.target.result;
                const oldVer  = e.oldVersion;

                /* ── v1 신규 스토어 ── */
                if (oldVer < 1) {
                    const wl = db.createObjectStore('hud_workLogs',     { keyPath: 'id', autoIncrement: true });
                    wl.createIndex('date', 'date', { unique: false });

                    const dl = db.createObjectStore('hud_deliveryLogs', { keyPath: 'id', autoIncrement: true });
                    dl.createIndex('workLogId', 'workLogId', { unique: false });
                    dl.createIndex('date',      'date',      { unique: false });
                    dl.createIndex('timeSlot',  'timeSlot',  { unique: false });
                    dl.createIndex('dayOfWeek', 'dayOfWeek', { unique: false });

                    db.createObjectStore('hud_places',   { keyPath: 'id', autoIncrement: true })
                      .createIndex('savedAt', 'savedAt', { unique: false });

                    db.createObjectStore('hud_settings', { keyPath: 'key' });
                    db.createObjectStore('hud_goals',    { keyPath: 'key' });
                    db.createObjectStore('hud_emergency',{ keyPath: 'id', autoIncrement: true });
                }

                /* ── v2 신규 스토어 ── */
                if (oldVer < 2) {
                    if (!db.objectStoreNames.contains('hud_missions')) {
                        db.createObjectStore('hud_missions', { keyPath: 'id', autoIncrement: true })
                          .createIndex('date', 'date', { unique: false });
                    }
                }

                /* ── v3 신규: hud_restLogs ── */
                if (oldVer < 3) {
                    if (!db.objectStoreNames.contains('hud_restLogs')) {
                        const rl = db.createObjectStore('hud_restLogs', { keyPath: 'id', autoIncrement: true });
                        rl.createIndex('date',      'date',      { unique: false });
                        rl.createIndex('workLogId', 'workLogId', { unique: false });
                    }
                }

                /*
                  ※ deliveryLogs·workLogs의 신규 필드
                     (distance, platform, activeMs, restMs, byPlatform 등)
                     IndexedDB는 필드 추가에 스키마 변경 불필요.
                     신규 레코드부터 자동으로 저장됨.
                */
            };

            req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
            req.onerror   = (e) => reject(e.target.error);
        });
    }


    /* ──────────────────────────────────────────
       2. 공통 트랜잭션 헬퍼
    ────────────────────────────────────────── */
    function tx(storeName, mode = 'readonly') {
        return _db.transaction(storeName, mode).objectStore(storeName);
    }
    function reqToPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror   = (e) => reject(e.target.error);
        });
    }
    const getAll       = (s)          => reqToPromise(tx(s).getAll());
    const getByIndex   = (s, idx, v)  => reqToPromise(tx(s).index(idx).getAll(v));
    const getOne       = (s, k)       => reqToPromise(tx(s).get(k));
    const put          = (s, d)       => reqToPromise(tx(s, 'readwrite').put(d));
    const add          = (s, d)       => reqToPromise(tx(s, 'readwrite').add(d));
    const remove       = (s, k)       => reqToPromise(tx(s, 'readwrite').delete(k));
    const clear        = (s)          => reqToPromise(tx(s, 'readwrite').clear());


    /* ──────────────────────────────────────────
       3. hud_workLogs
       스키마: id, date, startTime, endTime,
               durationMs,       ← 총 근무시간 (휴식 포함)
               activeMs,         ← 실근무시간 (휴식 제외)  [v3]
               restMs,           ← 총 휴식시간              [v3]
               idleMs,           ← 공차시간 (드롭→다음도착) [v3]
               deliveryCount,
               income,           ← 총 수입
               byPlatform,       ← { coupang, baemin, other, agency } [v3]
               hourlyWage,       ← 총시급 (income/durationMs)
               realHourlyWage    ← 실시급 (income/activeMs)  [v3]
    ────────────────────────────────────────── */
    const workLogs = {
        add:       (log)  => add('hud_workLogs', log),
        update:    (log)  => put('hud_workLogs', log),
        remove:    (id)   => remove('hud_workLogs', id),
        getAll:    ()     => getAll('hud_workLogs'),
        getByDate: (date) => getByIndex('hud_workLogs', 'date', date),
        getOne:    (id)   => getOne('hud_workLogs', id),
        clear:     ()     => clear('hud_workLogs'),

        getRecent: async (n = 30) => {
            const all = await getAll('hud_workLogs');
            return all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
        },
    };


    /* ──────────────────────────────────────────
       4. hud_deliveryLogs
       스키마: id, workLogId, date, timeSlot, dayOfWeek,
               arrived:  { ts, lat, lng, region },
               pickedUp: { ts, lat, lng },
               dropped:  { ts, lat, lng, region },
               floor,
               waitMinutes,     ← 도착→픽업 (조리대기)
               deliveryMinutes, ← 픽업→드롭 (배달시간)
               totalMinutes,
               distance,        ← 배달거리 km (×1.3 보정) [v3]
               platform         ← 'coupang'|'baemin'|'other'|'agency' [v3]
    ────────────────────────────────────────── */
    const deliveryLogs = {
        add:            (log)       => add('hud_deliveryLogs', log),
        update:         (log)       => put('hud_deliveryLogs', log),
        remove:         (id)        => remove('hud_deliveryLogs', id),
        getAll:         ()          => getAll('hud_deliveryLogs'),
        getByWorkLog:   (wid)       => getByIndex('hud_deliveryLogs', 'workLogId', wid),
        getByDate:      (date)      => getByIndex('hud_deliveryLogs', 'date', date),
        getByTimeSlot:  (slot)      => getByIndex('hud_deliveryLogs', 'timeSlot', slot),
        getByDayOfWeek: (day)       => getByIndex('hud_deliveryLogs', 'dayOfWeek', day),
        clear:          ()          => clear('hud_deliveryLogs'),

        count: async () => (await getAll('hud_deliveryLogs')).length,
    };


    /* ──────────────────────────────────────────
       5. hud_restLogs  [v3 신규]
       스키마: id, workLogId, date,
               startTime, endTime, durationMs
    ────────────────────────────────────────── */
    const restLogs = {
        add:          (log)  => add('hud_restLogs', log),
        update:       (log)  => put('hud_restLogs', log),
        remove:       (id)   => remove('hud_restLogs', id),
        getAll:       ()     => getAll('hud_restLogs'),
        getByDate:    (date) => getByIndex('hud_restLogs', 'date', date),
        getByWorkLog: (wid)  => getByIndex('hud_restLogs', 'workLogId', wid),
        clear:        ()     => clear('hud_restLogs'),

        /** 날짜별 총 휴식시간 (ms) */
        totalMsByDate: async (date) => {
            const logs = await getByIndex('hud_restLogs', 'date', date);
            return logs.reduce((s, r) => s + (r.durationMs || 0), 0);
        },
    };


    /* ──────────────────────────────────────────
       6. hud_places (GPS 핀)
    ────────────────────────────────────────── */
    const places = {
        add:    (p) => add('hud_places', { ...p, savedAt: p.savedAt || Date.now() }),
        update: (p) => put('hud_places', p),
        remove: (id)=> remove('hud_places', id),
        getAll: ()  => getAll('hud_places'),
        getOne: (id)=> getOne('hud_places', id),
        clear:  ()  => clear('hud_places'),
    };


    /* ──────────────────────────────────────────
       7. hud_settings (key-value)
    ────────────────────────────────────────── */
    const settings = {
        get: async (key, fallback = null) => {
            const row = await getOne('hud_settings', key);
            return row ? row.value : fallback;
        },
        set:    (key, value) => put('hud_settings', { key, value }),
        remove: (key)        => remove('hud_settings', key),
        getAll: async () => {
            const rows = await getAll('hud_settings');
            return Object.fromEntries(rows.map(r => [r.key, r.value]));
        },

        DEFAULTS: {
            ttsRate:          0.85,
            ttsVolume:        100,
            autoLockMs:       15 * 60 * 1000,
            proxDist:         0.03,
            proxSpeed:        30,
            safetyMsgEnabled: false,
        },

        applyDefaults: async function() {
            for (const [key, val] of Object.entries(this.DEFAULTS)) {
                if ((await this.get(key)) === null) await this.set(key, val);
            }
        },
    };


    /* ──────────────────────────────────────────
       8. hud_goals
    ────────────────────────────────────────── */
    const goals = {
        get:    (key)        => getOne('hud_goals', key).then(r => r ? r.value : null),
        set:    (key, value) => put('hud_goals', { key, value }),
        getAll: async () => {
            const rows = await getAll('hud_goals');
            return Object.fromEntries(rows.map(r => [r.key, r.value]));
        },
    };


    /* ──────────────────────────────────────────
       9. hud_emergency
    ────────────────────────────────────────── */
    const emergency = {
        add:    (item) => add('hud_emergency', item),
        update: (item) => put('hud_emergency', item),
        remove: (id)   => remove('hud_emergency', id),
        getAll: ()     => getAll('hud_emergency'),
        clear:  ()     => clear('hud_emergency'),
    };


    /* ──────────────────────────────────────────
       10. hud_missions
    ────────────────────────────────────────── */
    const missions = {
        add:       (m)    => add('hud_missions', m),
        update:    (m)    => put('hud_missions', m),
        remove:    (id)   => remove('hud_missions', id),
        getAll:    ()     => getAll('hud_missions'),
        getByDate: (date) => getByIndex('hud_missions', 'date', date),
    };


    /* ──────────────────────────────────────────
       11. 통계 유틸 (히트맵 / 매니저)
    ────────────────────────────────────────── */
    const stats = {
        totalDrops:       () => deliveryLogs.count(),
        dropPoints: async () => {
            const all = await deliveryLogs.getAll();
            return all
                .filter(d => d.dropped?.lat && d.dropped?.lng)
                .map(d => ({
                    lat: d.dropped.lat, lng: d.dropped.lng,
                    date: d.date, timeSlot: d.timeSlot, dayOfWeek: d.dayOfWeek,
                    distance: d.distance || 0,
                    platform: d.platform || null,
                }));
        },
    };


    /* ──────────────────────────────────────────
       12. localStorage → IndexedDB 마이그레이션
    ────────────────────────────────────────── */
    async function migrateFromLocalStorage(pin) {
        const flag = await settings.get('ls_migrated');
        if (flag) return;

        const userSettings = safeParseLS('gpn_settings', {});
        const settingMap = {
            ttsRate: userSettings.ttsRate, ttsVolume: userSettings.ttsVolume,
            autoLockMs: userSettings.autoLockMs, proxDist: userSettings.proxDist,
            proxSpeed: userSettings.proxSpeed, safetyMsgEnabled: false,
        };
        for (const [k, v] of Object.entries(settingMap)) {
            if (v !== undefined && v !== null) await settings.set(k, v);
        }
        const pinHash = localStorage.getItem('gpn_pin_hash');
        const pinSalt = localStorage.getItem('gpn_pin_salt');
        const encSalt = localStorage.getItem('gpn_enc_salt');
        if (pinHash) await settings.set('pin_hash', pinHash);
        if (pinSalt) await settings.set('pin_salt', pinSalt);
        if (encSalt) await settings.set('enc_salt', encSalt);

        const consent     = localStorage.getItem('gpn_consent');
        const consentDate = localStorage.getItem('gpn_consent_date');
        if (consent)     await settings.set('consent', consent);
        if (consentDate) await settings.set('consentDate', consentDate);

        const oldLogs = safeParseLS('gpn_workLogs', []);
        for (const log of oldLogs) { const { id, ...rest } = log; await workLogs.add(rest); }

        await settings.set('ls_migrated', true);
    }

    function safeParseLS(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key)) || fallback; }
        catch { return fallback; }
    }


    /* ──────────────────────────────────────────
       공개 API
    ────────────────────────────────────────── */
    return {
        open,
        workLogs, deliveryLogs, restLogs,
        places, settings, goals, emergency, missions,
        stats, migrateFromLocalStorage,
    };

})();
