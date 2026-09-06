/**
 * apiCache.js — 前端数据缓存（改动即失效），加速图表类接口。
 *
 * 背景：数据存在东京 Turso，单次查询 ~150ms+ 网络往返，图表页一次要拉多个接口，
 * 切换 Tab 反复重拉导致"图表很慢"。这里给 GET 接口加一层缓存：
 *  - 命中：直接用缓存渲染（秒开）。
 *  - 失效：任何新增/修改/删除记录的操作会调用 ApiCache.invalidate*()，
 *    相关缓存立即作废，下次重新拉取——保证不会看到过期数据。
 *  - 共享：同一 key 的并发请求只发一次（in-flight Promise 去重），
 *    科研看板和健康总览都打 /api/health-overview，借此避免重复请求。
 *
 * 存储：内存 Map（页面生命周期内）+ sessionStorage（同会话刷新也命中）。
 * 不用 localStorage，避免长时间存旧数据；关标签页即清。
 */

const ApiCache = {
    _mem: new Map(),          // key -> { data, t }
    _inflight: new Map(),     // key -> Promise
    _ns: 'qhcache:',

    _readSession(key) {
        try {
            const raw = sessionStorage.getItem(this._ns + key);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            return obj && 'data' in obj ? obj : null;
        } catch (e) { return null; }
    },
    _writeSession(key, data) {
        try {
            sessionStorage.setItem(this._ns + key, JSON.stringify({ data, t: Date.now() }));
        } catch (e) { /* 超出配额等情况静默降级为仅内存 */ }
    },

    /** 取缓存（内存优先，其次 sessionStorage）。未命中返回 undefined。 */
    get(key) {
        if (this._mem.has(key)) return this._mem.get(key).data;
        const s = this._readSession(key);
        if (s) {
            this._mem.set(key, s);
            return s.data;
        }
        return undefined;
    },

    set(key, data) {
        const obj = { data, t: Date.now() };
        this._mem.set(key, obj);
        this._writeSession(key, data);
    },

    /** 删除指定 key（含 sessionStorage）。 */
    invalidate(key) {
        this._mem.delete(key);
        try { sessionStorage.removeItem(this._ns + key); } catch (e) {}
    },

    /** 删除所有以 prefix 开头的 key。 */
    invalidatePrefix(prefix) {
        for (const k of Array.from(this._mem.keys())) {
            if (k.startsWith(prefix)) this._mem.delete(k);
        }
        try {
            const toDel = [];
            for (let i = 0; i < sessionStorage.length; i++) {
                const sk = sessionStorage.key(i);
                if (sk && sk.startsWith(this._ns + prefix)) toDel.push(sk);
            }
            toDel.forEach((sk) => sessionStorage.removeItem(sk));
        } catch (e) {}
    },

    invalidateAll() {
        this._mem.clear();
        try {
            const toDel = [];
            for (let i = 0; i < sessionStorage.length; i++) {
                const sk = sessionStorage.key(i);
                if (sk && sk.startsWith(this._ns)) toDel.push(sk);
            }
            toDel.forEach((sk) => sessionStorage.removeItem(sk));
        } catch (e) {}
    },

    /**
     * 带缓存的 GET JSON。命中缓存立即返回；否则发请求（并发去重）并写缓存。
     * @param {string} url 请求地址（含 query），同时作为缓存 key。
     * @param {object} opts { force: true 时跳过缓存强制刷新 }
     */
    async fetch(url, opts = {}) {
        if (!opts.force) {
            const hit = this.get(url);
            if (hit !== undefined) return hit;
        }
        if (this._inflight.has(url)) return this._inflight.get(url);
        const p = (async () => {
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const data = await resp.json();
                this.set(url, data);
                return data;
            } finally {
                this._inflight.delete(url);
            }
        })();
        this._inflight.set(url, p);
        return p;
    },
};

window.ApiCache = ApiCache;
