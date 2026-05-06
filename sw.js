/* ============================================================
   HUD for Riders — sw.js
   Service Worker · 정적 캐싱 (개발 단계: Network First 전략)
   ============================================================
   원칙 (설계문서 §02):
     ✅ 서버 없음 — 정적 파일 캐싱만
     ❌ periodicsync / sync / push 이벤트 일체 없음
     ❌ 백그라운드 자동 실행 없음
     ❌ 외부 데이터 전송 없음

   ⚠️ 개발 단계 전략:
     - 앱 파일(html/css/js)은 Network First → 항상 새 버전 우선
     - 새 버전 감지 시 자동 reload (skipWaiting + 메시지)
     - 외부 라이브러리만 Cache First (CDN은 변경 안 됨)
   ============================================================ */

/* 빌드 시점 버전 — 파일 변경 시 자동으로 캐시 무효화 */
const APP_VERSION = '1.1.0-' + '20260429-2330';
const CACHE_NAME  = 'hud-cache-' + APP_VERSION;

const STATIC_ASSETS = [
  /* 진입점 */
  '/',
  '/index.html',

  /* 스타일 */
  '/style.css',

  /* 모듈 */
  '/db.js',
  '/common.js',
  '/hud.js',
  '/manager.js',
  '/heatmap.js',

  /* 부속 페이지 */
  '/privacy.html',
  '/terms.html',
  '/manual.html',

  /* PWA */
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',

  /* 외부 라이브러리 */
  'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js'
];

/* Network First 적용할 파일 패턴 (앱 본체) */
const APP_FILE_PATTERNS = [
  /\.html$/,
  /\.css$/,
  /\.js$/,
  /\.json$/,
  /\/$/   // 루트
];


/* ──────────────────────────────────────────
   1. 설치 — 정적 자산 사전 캐시 + 즉시 활성화
────────────────────────────────────────── */
self.addEventListener('install', event => {
  console.log('[SW] 설치:', APP_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] 일부 캐시 실패 (외부 리소스):', err);
      });
    })
  );
  /* 새 SW를 즉시 활성화 (대기 X) */
  self.skipWaiting();
});


/* ──────────────────────────────────────────
   2. 활성화 — 이전 버전 캐시 정리 + 클라이언트 즉시 제어
────────────────────────────────────────── */
self.addEventListener('activate', event => {
  console.log('[SW] 활성화:', APP_VERSION);
  event.waitUntil(
    Promise.all([
      /* 이전 캐시 모두 삭제 */
      caches.keys().then(keys =>
        Promise.all(
          keys.filter(k => k !== CACHE_NAME).map(k => {
            console.log('[SW] 이전 캐시 삭제:', k);
            return caches.delete(k);
          })
        )
      ),
      /* 모든 탭을 즉시 새 SW 제어 하에 둠 */
      self.clients.claim()
    ]).then(() => {
      /* 활성화 완료 → 모든 클라이언트에 새 버전 알림 */
      return self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'SW_UPDATED', version: APP_VERSION });
        });
      });
    })
  );
});


/* ──────────────────────────────────────────
   3. fetch
   - 앱 파일(html/css/js): Network First (개발 중 항상 새 버전)
   - 그 외 (이미지, 외부 CDN): Cache First
────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  /* 외부 API는 항상 네트워크 (캐시 제외) */
  const bypassDomains = [
    'api.open-meteo.com',     // 날씨
    'dapi.kakao.com',          // 카카오 SDK / 지도 타일
    't1.daumcdn.net',          // 카카오 타일 CDN
    'map.kakao.com',           // 카카오 지도 웹
    'mts.googleapis.com'       // (혹시 모를) 외부 지도
  ];
  if (bypassDomains.some(d => url.hostname.includes(d))) {
    return;   // SW 개입 없이 기본 fetch
  }

  /* GET이 아니면 패스 */
  if (event.request.method !== 'GET') return;

  /* 앱 본체 파일인지 판별 */
  const isAppFile = url.origin === location.origin
    && APP_FILE_PATTERNS.some(re => re.test(url.pathname));

  if (isAppFile) {
    /* === Network First === */
    event.respondWith(
      fetch(event.request).then(response => {
        /* 성공 → 캐시 갱신 후 반환 */
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        /* 네트워크 실패(오프라인) → 캐시에서 */
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          if (event.request.destination === 'document') {
            return caches.match('/index.html');
          }
        });
      })
    );
  } else {
    /* === Cache First (이미지, 외부 CDN 등) === */
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (!response || response.status !== 200 || response.type === 'opaque') {
            return response;
          }
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
  }
});


/* ──────────────────────────────────────────
   4. message — 클라이언트로부터의 명령
────────────────────────────────────────── */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.ports[0]?.postMessage({ ok: true });
    });
  }
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: APP_VERSION });
  }
});

/*
  ⚠️ 명시적으로 추가하지 않은 이벤트:
     - periodicsync   (백그라운드 주기 동기화)
     - sync           (백그라운드 동기화)
     - push           (서버 푸시)
     - notificationclick  (알림 클릭)
  설계 원칙: 서버 없음 + 백그라운드 자동 실행 없음
*/
