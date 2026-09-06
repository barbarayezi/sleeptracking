/**
 * Service Worker — QHealth PWA
 *
 * 策略（针对「代码已更新但浏览器顽固显示旧样式」的缓存陷阱）：
 *  - 静态资源走 network-first，且每次强制向服务器验证（cache:'no-cache'），
 *    绕过任何 HTTP / SW 旧缓存，代码更新后浏览器立刻看到最新 CSS/JS，无需手动清缓存。
 *  - 缓存版本号随发布递增（每次改 UI 必须 +1），activate 阶段删除所有旧缓存，
 *    彻底清掉陈旧资源（否则旧 style.css 会一直被 SW 回放）。
 *  - 新 SW 安装即 skipWaiting，activate 即 clients.claim 并强制已打开页面重新导航，
 *    确保用户看到的永远是最新版。
 */

const CACHE_NAME = 'qhealth-v27';   // ← 每次发布改 UI 必须 +1，否则旧缓存不会被清

// Install — 直接 skipWaiting，让新 SW 尽快接管
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// Activate — 清理旧缓存、接管所有客户端，并强制已打开的页面重新加载到最新版
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        );
        await self.clients.claim();

        // 让所有已打开的窗口用新 SW 重新导航一次，确保立刻看到最新资源
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
            try {
                client.navigate(client.url);
            } catch (_) {
                /* ignore */
            }
        }
    })());
});

// Fetch — 仅拦截 GET；API 请求永远不缓存，静态资源走 network-first
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;   // 非 GET 不拦截，避免干扰接口请求

    const url = new URL(event.request.url);

    // API 请求：永远直连服务器，不读、不写 Service Worker 缓存。
    // 这彻底避免 /api/records 等指标数据被旧缓存覆盖。
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request, { cache: 'no-cache' }).catch(() =>
                new Response(JSON.stringify({ error: 'offline' }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' }
                })
            )
        );
        return;
    }

    // 静态资源：network-first 且强制向服务器验证，离线才回退缓存
    event.respondWith(
        fetch(event.request, { cache: 'no-cache' })   // 每次都向服务器拿最新，绕过缓存层
            .then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
});
