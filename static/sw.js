/**
 * Service Worker — Sleep Tracker PWA
 * 策略：所有请求 network-first（网络可用时永远取最新），离线才回退缓存。
 * 新版本激活时强制已打开的页面自动重新加载，确保用户看到的永远是最新版，
 * 无需手动清缓存 / 开 DevTools。
 */

const CACHE_NAME = 'sleep-tracker-v3';

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

// Fetch — network-first，离线时回退缓存（ignoreSearch 让 ?v= 变体共用一份缓存）
self.addEventListener('fetch', (event) => {
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response.ok && event.request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
});
