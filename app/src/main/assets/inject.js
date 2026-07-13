// HR 打卡助手 - WebView 注入脚本
(function() {
    'use strict';

    if (window.__HR_PUNCH_INJECTED) return;
    window.__HR_PUNCH_INJECTED = true;

    // ---- 诊断：定位 SDK 中计算最终显示坐标的函数 ----
    (function() {
        var orig = console.log;
        function _hr_safeString(a) {
            try {
                if (a === null) return 'null';
                if (a === undefined) return 'undefined';
                if (typeof a === 'string') return a;
                if (typeof a === 'number' || typeof a === 'boolean') return String(a);
                if (typeof a === 'function') return '[Function]';
                if (typeof a === 'symbol') return a.toString();
                try { return JSON.stringify(a); } catch(ee) {}
                return Object.prototype.toString.call(a);
            } catch(e) { return '[unstringifiable]'; }
        }
        console.log = function() {
            var args = Array.prototype.slice.call(arguments);
            try {
                var msg = args.map(_hr_safeString).join(' ');
                if (msg.indexOf('kk gcj translate wgs success') !== -1) {
                    console.error('[HR-DIAG] 发现最终显示坐标计算点，调用栈：');
                    console.error((new Error('HR-DIAG')).stack);
                }
            } catch(e) {}
            return orig.apply(console, args);
        };
    })();

    console.log('[HR] 注入脚本启动');

    // ========================================================
    //  坐标常量 & 转换算法
    // ========================================================
    var PI = Math.PI;
    var A = 6378245.0;
    var EE = 0.00669342162296594323;

    function transformLat(x, y) {
        var ret = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
        ret += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI))*2/3;
        ret += (20*Math.sin(y*PI) + 40*Math.sin(y/3*PI))*2/3;
        ret += (160*Math.sin(y/12*PI) + 320*Math.sin(y*PI/30))*2/3;
        return ret;
    }
    function transformLng(x, y) {
        var ret = 300.0 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
        ret += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI))*2/3;
        ret += (20*Math.sin(x*PI) + 40*Math.sin(x/3*PI))*2/3;
        ret += (150*Math.sin(x/12*PI) + 300*Math.sin(x/30*PI))*2/3;
        return ret;
    }
    function wgs84ToGcj02(lng, lat) {
        var dLat = transformLat(lng-105, lat-35);
        var dLng = transformLng(lng-105, lat-35);
        var rad = lat/180*PI;
        var magic = Math.sin(rad);
        magic = 1 - EE*magic*magic;
        var sqrt = Math.sqrt(magic);
        dLat = (dLat*180)/((A*(1-EE))/(magic*sqrt)*PI);
        dLng = (dLng*180)/(A/sqrt*Math.cos(rad)*PI);
        return { lng: lng+dLng, lat: lat+dLat };
    }
    function gcj02ToWgs84(lng, lat) {
        var dLat = transformLat(lng-105, lat-35);
        var dLng = transformLng(lng-105, lat-35);
        var rad = lat/180*PI;
        var magic = Math.sin(rad);
        magic = 1 - EE*magic*magic;
        var sqrt = Math.sqrt(magic);
        dLat = (dLat*180)/((A*(1-EE))/(magic*sqrt)*PI);
        dLng = (dLng*180)/(A/sqrt*Math.cos(rad)*PI);
        return { lng: lng*2-(lng+dLng), lat: lat*2-(lat+dLat) };
    }
    function gcj02ToBd09(lng, lat) {
        var z = Math.sqrt(lng*lng + lat*lat) + 0.00002*Math.sin(lat*PI*3000/180);
        var theta = Math.atan2(lat, lng) + 0.000003*Math.cos(lng*PI*3000/180);
        return { lng: z*Math.cos(theta) + 0.0065, lat: z*Math.sin(theta) + 0.006 };
    }
    function bd09ToGcj02(lng, lat) {
        var x = lng - 0.0065, y = lat - 0.006;
        var z = Math.sqrt(x*x + y*y) - 0.00002*Math.sin(y*PI*3000/180);
        var theta = Math.atan2(y, x) - 0.000003*Math.cos(x*PI*3000/180);
        return { lng: z*Math.cos(theta), lat: z*Math.sin(theta) };
    }
    function wgs84ToBd09(lng, lat) { return gcj02ToBd09(wgs84ToGcj02(lng, lat)); }
    function bd09ToWgs84(lng, lat) { return gcj02ToWgs84(bd09ToGcj02(lng, lat)); }

    // ========================================================
    //  定位覆盖 — 多层拦截 + 回调拦截
    // ========================================================
    // FAKE_LNG/LAT 用 WGS-84（navigator.geolocation 标准返回 WGS-84）
    // 不再硬编码默认坐标，必须由用户通过地图选点或预设指定
    var FAKE_LNG = null, FAKE_LAT = null;

    // 供原生 __js2java_proxy 桥读取的 BD-09 坐标（KK SDK 原生返回 BD-09）
    function updateNativeFakeCoords() {
        try {
            if (FAKE_LNG !== null && FAKE_LAT !== null && !isNaN(FAKE_LNG) && !isNaN(FAKE_LAT)) {
                window.__hr_fake_coords_bd09 = wgs84ToBd09(FAKE_LNG, FAKE_LAT);
            } else {
                window.__hr_fake_coords_bd09 = null;
            }
        } catch(e) {}
    }
    updateNativeFakeCoords();

    // 模拟定位总开关：每次启动默认关闭，使用真实 GPS
    var _hr_use_fake = false;
    window.__hr_use_fake = _hr_use_fake;

    window.__hr_real_coords_wgs = null;
    window.__hr_on_real_location = function(lat, lng, accuracy) {
        window.__hr_real_coords_wgs = { lng: lng, lat: lat, accuracy: accuracy };
        // 真实坐标到达时，如果地图可见且未使用模拟定位，自动更新标记位置
        if (mapInited && mapInstance && !_hr_use_fake) {
            var gcj = wgs84ToGcj02(lng, lat);
            mapInstance.setCenter([gcj.lng, gcj.lat]);
            if (!mapMarker) {
                mapMarker = new AMap.Marker({
                    position: [gcj.lng, gcj.lat],
                    draggable: true,
                    anchor: 'bottom-center',
                    icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
                    map: mapInstance
                });
                mapMarker.on('dragend', function() {
                    var pos = mapMarker.getPosition();
                    document.getElementById('hr_lng').value = pos.lng.toFixed(7);
                    document.getElementById('hr_lat').value = pos.lat.toFixed(7);
                });
            } else {
                mapMarker.setPosition([gcj.lng, gcj.lat]);
            }
        }
    };

    // 当前使用的 WGS-84 坐标：fake 开启时用假坐标，否则用真实坐标
    function getCurrentWgsCoords() {
        if (_hr_use_fake) {
            if (FAKE_LNG !== null && FAKE_LAT !== null && typeof FAKE_LNG === 'number' && typeof FAKE_LAT === 'number' &&
                !isNaN(FAKE_LNG) && !isNaN(FAKE_LAT)) {
                return { lng: FAKE_LNG, lat: FAKE_LAT, accuracy: 10 };
            }
            return null; // 模拟坐标未设置，不能返回硬编码默认值
        }
        var real = window.__hr_real_coords_wgs;
        if (real && typeof real.lng === 'number' && typeof real.lat === 'number' && !isNaN(real.lng) && !isNaN(real.lat)) {
            return { lng: real.lng, lat: real.lat, accuracy: real.accuracy || 10 };
        }
        return null; // 真实坐标尚未获取到，不返回假数据
    }
    function _hr_waitForWgsCoords(timeoutMs, intervalMs, cb) {
        var start = Date.now();
        function check() {
            var c = getCurrentWgsCoords();
            if (c) return cb(c);
            if (Date.now() - start > timeoutMs) return cb(null);
            setTimeout(check, intervalMs);
        }
        check();
    }
    // KK SDK 原生定位接口返回 BD-09，注入坐标也必须用 BD-09，否则页面显示会偏移
    function _hr_trySdkPos() {
        var c = getCurrentWgsCoords();
        if (!c) return null;
        var bd = wgs84ToBd09(c.lng, c.lat);
        return { longitude: bd.lng, latitude: bd.lat, accuracy: c.accuracy };
    }

    // 当前使用的 BD-09 坐标（供 KK SDK 路径使用），无数据时回退到原生
    function _hr_makeSdkPos() {
        var pos = _hr_trySdkPos();
        if (pos) return pos;
        // 没有我们的数据，尝试走原生：
        // 返回 null 会让调用方 fall through 到原始 Was.exec / __js2java_proxy
        return null;
    }

    // 当前使用的 GCJ-02 坐标（lat/lng 形式），供 Angular 强制注入等，无数据返回 null
    function getCurrentGcjCoords() {
        var c = getCurrentWgsCoords();
        if (!c) return null;
        return wgs84ToGcj02(c.lng, c.lat);
    }

    // 判断是否为定位类插件调用（所有 Was.exec 钩子依赖此函数）
    function _hr_isLocationPlugin(plugin) {
        return plugin === 'gps' || plugin === 'location' || plugin === 'kk.location' ||
               plugin.indexOf('location') !== -1 || plugin.indexOf('gps') !== -1;
    }

    // ---- 核心：创建完整 Was 桩，让 KK SDK 误以为在原生 KK 客户端中运行 ----
    function _hr_ensureWasStub() {
        if (typeof window.Was !== 'undefined' && window.Was._hr_stub) return;
        window.Was = window.Was || {};
        window.Was._hr_stub = true;
        window.Was.readyArgs = window.Was.readyArgs || { tokenReady: true, callArgs: {} };
        window.Was.SSOTokenReady = true;
        window.Was.callbackID = window.Was.callbackID || 0;
        window.Was.callbacks = window.Was.callbacks || {};
        window.Was.ready = function(cb) {
            if (cb) setTimeout(function() { cb(window.Was.readyArgs); }, 0);
        };

        // 保留可能已存在的原生 SDK exec，未开启模拟时回退到真实调用
        if (!window.Was._hr_origExec && window.Was.exec && !window.Was.exec._hr_stub_wrapper) {
            window.Was._hr_origExec = window.Was.exec.bind(window.Was);
        }
        if (!window.Was._hr_origExecA && window.Was.execA && !window.Was.execA._hr_stub_wrapper) {
            window.Was._hr_origExecA = window.Was.execA.bind(window.Was);
        }

        function _hr_wasExecWrapper(plugin, method, args, success, fail) {
            if (_hr_isLocationPlugin(plugin)) {
                var pos = _hr_trySdkPos();
                if (pos) {
                    setTimeout(function() { if (success) success(pos); }, 10);
                    return;
                }
                // 真实坐标可能还没到位，等最多 5 秒
                _hr_waitForWgsCoords(5000, 200, function(c) {
                    if (c) {
                        var p = _hr_trySdkPos();
                        if (p) { if (success) success(p); return; }
                    }
                    // 仍无坐标，优先走原生 SDK 的 exec
                    if (window.Was._hr_origExec) {
                        return window.Was._hr_origExec(plugin, method, args, success, fail);
                    }
                    // 也没有原生，走 __js2java_proxy
                    if (typeof window.__js2java_proxy !== 'undefined' && window.__js2java_proxy.execPlugin) {
                        var id = plugin + '_' + (window.Was.callbackID++);
                        if (success || fail) window.Was.callbacks[id] = { success: success, fail: fail };
                        window.__js2java_proxy.execPlugin(plugin, method, args, id, method);
                        return;
                    }
                    if (fail) fail(-999, 'not implemented');
                });
                return;
            }
            // 非定位：优先走原生 SDK 的 exec
            if (window.Was._hr_origExec) {
                return window.Was._hr_origExec(plugin, method, args, success, fail);
            }
            // 没有原生前，尝试原生桥接
            if (typeof window.__js2java_proxy !== 'undefined' && window.__js2java_proxy.execPlugin) {
                var id = plugin + '_' + (window.Was.callbackID++);
                if (success || fail) window.Was.callbacks[id] = { success: success, fail: fail };
                window.__js2java_proxy.execPlugin(plugin, method, args, id, method);
            } else {
                setTimeout(function() { if (fail) fail(-999, 'not implemented'); }, 10);
            }
        }
        _hr_wasExecWrapper._hr_stub_wrapper = true;
        window.Was.exec = _hr_wasExecWrapper;
        window.Was.execA = _hr_wasExecWrapper;
        window.Was.callbackResult = function(id, args, keep) {
            var cb = window.Was.callbacks[id];
            if (cb) {
                if (!(keep && keep == 1)) delete window.Was.callbacks[id];
                if (cb.success) cb.success(args);
            }
        };
        window.Was.callbackError = function(id, code, msg) {
            var cb = window.Was.callbacks[id];
            if (cb) { delete window.Was.callbacks[id]; if (cb.fail) cb.fail(code, msg); }
        };
        try {
            window.dispatchEvent(new Event('kkJsBridgeReady'));
        } catch(e) {}
        console.log('[HR] Was 桩已创建');
    }
    _hr_ensureWasStub();
    // 页面加载过程中 SDK 可能覆盖 Was，轮询确保桩始终存在
    var _hr_was_stub_timer = setInterval(_hr_ensureWasStub, 300);
    setTimeout(function() { clearInterval(_hr_was_stub_timer); }, 15000);

    // ---- 核心：修正 geocheck 请求坐标 ----
    // Was.exec 现在返回 BD-09，SDK 内部会转成 WGS-84 再发给服务端，
    // 但服务端按 GCJ-02 校验，导致明明在打卡点却报"外勤"。
    // 这里把请求体里的坐标替换为当前选中的 GCJ-02 坐标并重新计算 hash。
    function _hr_getMd5() {
        if (window.__hr_md5) return window.__hr_md5;
        try {
            if (typeof angular !== 'undefined' && angular.element && angular.element(document.body).injector) {
                var inj = angular.element(document.body).injector();
                if (inj) {
                    var crypto = inj.get('cryptoService');
                    if (crypto && typeof crypto.md5 === 'function') {
                        window.__hr_md5 = crypto.md5;
                        return window.__hr_md5;
                    }
                }
            }
        } catch(e) {}
        return null;
    }
    function _hr_hookXHR() {
        if (window._hr_xhr_hooked) return;
        window._hr_xhr_hooked = true;
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
            this._hr_url = url;
            return origOpen.apply(this, arguments);
        };
        function _hr_isNear(a, b) { return Math.abs(a - b) < 1e-6; }
        function _hr_isInvalidCoord(v) {
            if (v === null || v === undefined) return true;
            if (typeof v === 'number') return isNaN(v) || v === 0;
            if (typeof v === 'string') { var f = parseFloat(v); return isNaN(f) || f === 0; }
            return true;
        }
        // 处理 position.gcj.encryptwgs 请求体：把无效坐标或 BD-09 坐标统一换成 GCJ-02
        function _hr_fixEncryptWgsBody(obj, bd, gcj) {
            if (!obj || typeof obj !== 'object') return obj;
            if (Array.isArray(obj)) {
                for (var i = 0; i < obj.length; i++) obj[i] = _hr_fixEncryptWgsBody(obj[i], bd, gcj);
                return obj;
            }
            for (var k in obj) {
                if (!obj.hasOwnProperty(k)) continue;
                var v = obj[k];
                if (k === 'latitude' || k === 'lat') {
                    if (_hr_isInvalidCoord(v) || _hr_isNear(parseFloat(v), bd.lat)) {
                        obj[k] = typeof v === 'string' ? String(gcj.lat) : gcj.lat;
                    }
                } else if (k === 'longitude' || k === 'lng' || k === 'longtitude') {
                    if (_hr_isInvalidCoord(v) || _hr_isNear(parseFloat(v), bd.lng)) {
                        obj[k] = typeof v === 'string' ? String(gcj.lng) : gcj.lng;
                    }
                } else if (typeof v === 'object') {
                    obj[k] = _hr_fixEncryptWgsBody(v, bd, gcj);
                }
            }
            return obj;
        }

        XMLHttpRequest.prototype.send = function(body) {
            // SDK 把 Was.exec 返回的 BD-09 发给 position.gcj.encryptwgs，但该接口要求 GCJ-02，会 500。
            // 这里把请求体里的 BD-09 坐标替换为 GCJ-02；若坐标尚未就绪则等待。
            if (this._hr_url && this._hr_url.indexOf('position.gcj.encryptwgs') !== -1) {
                var self = this;
                var originalBody = body;
                function _hr_sendEncryptWgs(wgs) {
                    try {
                        var req = JSON.parse(originalBody);
                        var bd = wgs84ToBd09(wgs.lng, wgs.lat);
                        var gcj = wgs84ToGcj02(wgs.lng, wgs.lat);
                        var newReq = _hr_fixEncryptWgsBody(req, bd, gcj);
                        var newBody = JSON.stringify(newReq);
                        console.log('[HR] position.gcj.encryptwgs 原始body:', originalBody, '修正后:', newBody);
                        return origSend.call(self, newBody);
                    } catch(e) {
                        console.error('[HR] position.gcj.encryptwgs 修正失败:', e);
                        return origSend.apply(self, [originalBody]);
                    }
                }
                var wgs = getCurrentWgsCoords();
                if (wgs) return _hr_sendEncryptWgs(wgs);
                // 坐标可能还没就绪，等最多 5 秒
                _hr_waitForWgsCoords(5000, 200, function(wgs2) {
                    if (wgs2) return _hr_sendEncryptWgs(wgs2);
                    console.warn('[HR] position.gcj.encryptwgs 等待坐标超时，发送原始 body');
                    return origSend.apply(self, [originalBody]);
                });
                return;
            }

            // 拦截 geocheck 和 create，将坐标统一修正为 GCJ-02（模拟/真实均有）
            if (this._hr_url && (this._hr_url.indexOf('attend.signin.geocheck') !== -1 || this._hr_url.indexOf('attend.signin.create') !== -1)) {
                var md5 = _hr_getMd5();
                if (md5) {
                    try {
                        var req = JSON.parse(body);
                        var wgs;
                        if (_hr_use_fake) {
                            if (FAKE_LNG !== null && FAKE_LAT !== null && !isNaN(FAKE_LNG) && !isNaN(FAKE_LAT)) {
                                wgs = { lng: FAKE_LNG, lat: FAKE_LAT, accuracy: 10 };
                            }
                        } else {
                            wgs = window.__hr_real_coords_wgs;
                        }
                        if (wgs && typeof wgs.lng === 'number' && typeof wgs.lat === 'number' && !isNaN(wgs.lng) && !isNaN(wgs.lat)) {
                            var gcj = wgs84ToGcj02(wgs.lng, wgs.lat);
                            var newBody = JSON.stringify({
                                latitude: String(gcj.lat),
                                longitude: String(gcj.lng),
                                accuracy: wgs.accuracy,
                                timestamp: req.timestamp,
                                hash: md5([String(gcj.lat), String(gcj.lng), wgs.accuracy, req.timestamp, 'hcm cloud'].join(''))
                            });
                            console.log('[HR] API 请求已修正为 GCJ-02:', this._hr_url.split('/').pop(), newBody);
                            return origSend.call(this, newBody);
                        }
                    } catch(e) { console.error('[HR] API 请求修正失败:', e); }
                } else {
                    console.warn('[HR] cryptoService.md5 未获取到，无法修正', this._hr_url.split('/').pop(), '坐标');
                }
            }
            if (this._hr_url && (this._hr_url.indexOf('/img') !== -1 || this._hr_url.indexOf('hr-mobile') !== -1 && this._hr_url.indexOf('img') !== -1)) {
                var self = this;
                console.log('[HR] /img 上传请求 URL=', this._hr_url, 'body长度=', body ? body.length : 0, 'body前100=', body ? body.substring(0,100) : '');
                var origOnload = this.onload;
                var origOnerror = this.onerror;
                this.onload = function() {
                    console.log('[HR] /img 上传响应 status=', self.status, 'text=', self.responseText ? self.responseText.substring(0,300) : '');
                    if (origOnload) origOnload.apply(this, arguments);
                };
                this.onerror = function() {
                    console.log('[HR] /img 上传错误 status=', self.status, 'text=', self.responseText ? self.responseText.substring(0,300) : '');
                    if (origOnerror) origOnerror.apply(this, arguments);
                };
            }
            return origSend.apply(this, arguments);
        };
        console.log('[HR] XHR 请求修正器/日志已创建');
    }
    _hr_hookXHR();
    // 轮询尝试获取 cryptoService.md5（Angular 可能比注入脚本晚加载）
    var _hr_md5_attempts = 0;
    var _hr_md5_timer = setInterval(function() {
        _hr_md5_attempts++;
        if (_hr_getMd5() || _hr_md5_attempts > 40) clearInterval(_hr_md5_timer);
    }, 500);

    function makeCoords(lng, lat) {
        return {
            coords: {
                latitude: lat, longitude: lng,
                accuracy: 10, altitude: null, altitudeAccuracy: null,
                heading: null, speed: null
            },
            timestamp: Date.now()
        };
    }

    // 地图用坐标：有输入用输入；fake 开启用假坐标；否则用真实坐标；都没有则返回 null
    function getMapCenter() {
        // 真实模式：优先用 GPS，忽略输入框；模拟模式：用输入框或已设置的假坐标
        if (!_hr_use_fake) {
            var real = window.__hr_real_coords_wgs;
            if (real) return wgs84ToGcj02(real.lng, real.lat);
            return null;
        }
        var inputLng = parseFloat(document.getElementById('hr_lng').value);
        var inputLat = parseFloat(document.getElementById('hr_lat').value);
        if (!isNaN(inputLng) && !isNaN(inputLat)) return { lng: inputLng, lat: inputLat };
        if (FAKE_LNG !== null && FAKE_LAT !== null && !isNaN(FAKE_LNG) && !isNaN(FAKE_LAT)) {
            return wgs84ToGcj02(FAKE_LNG, FAKE_LAT);
        }
        return null;
    }

    // 手动定位：把地图和红标移到当前位置
    function locateCurrentPosition() {
        // 先检查是否已有缓存位置（避免无意义等待）
        var cached = getMapCenter();
        if (cached) {
            // 已有缓存，直接用；同时后台拉一次最新
            applyCenter(cached);
        }
        // 触发一次原生定位请求（one-shot），回调后自动更新标记
        try {
            if (window.HRBridge && HRBridge.startRealLocation) HRBridge.startRealLocation();
        } catch(e) {}
        if (!cached) {
            setStatus('正在获取当前位置...', '#4a6cf7');
        }
    }

    function applyCenter(center) {
        if (!mapInstance) return;
        mapInstance.setCenter([center.lng, center.lat]);
        if (!mapMarker) {
            mapMarker = new AMap.Marker({
                position: [center.lng, center.lat],
                draggable: true,
                anchor: 'bottom-center',
                icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
                map: mapInstance
            });
            mapMarker.on('dragend', function() {
                var pos = mapMarker.getPosition();
                document.getElementById('hr_lng').value = pos.lng.toFixed(7);
                document.getElementById('hr_lat').value = pos.lat.toFixed(7);
            });
        } else {
            mapMarker.setPosition([center.lng, center.lat]);
        }
    }

    // ---- 层次1: navigator.geolocation（递归所有 frame，锁定防覆盖） ----
    function hookNavigatorGeolocation(win) {
        try {
            if (!win.navigator || !win.navigator.geolocation) return;
            if (win.__hr_geo_hooked) return;
            var geo = win.navigator.geolocation;
            var origGet = geo.getCurrentPosition.bind(geo);
            var origWatch = geo.watchPosition.bind(geo);
            var origClear = geo.clearWatch.bind(geo);
            geo.getCurrentPosition = function(succ, fail, opts) {
                var c = getCurrentWgsCoords();
                if (c) {
                    setTimeout(function() { if (succ) succ(makeCoords(c.lng, c.lat)); }, 10);
                } else {
                    origGet(succ, fail, opts);
                }
            };
            geo.watchPosition = function(succ, fail, opts) {
                var c = getCurrentWgsCoords();
                if (c) {
                    if (succ) succ(makeCoords(c.lng, c.lat));
                    return setInterval(function() {
                        var c2 = getCurrentWgsCoords();
                        if (c2 && succ) succ(makeCoords(c2.lng, c2.lat));
                    }, 5000);
                }
                return origWatch(succ, fail, opts);
            };
            geo.clearWatch = function(id) { clearInterval(id); };
            win.__hr_geo_hooked = true;
            console.log('[HR] navigator.geolocation 已覆盖:', win.location ? win.location.href : 'unknown frame');
        } catch(e) { console.error('[HR] geolocation 覆盖失败:', e); }
    }
    function hookAllFrames(win) {
        hookNavigatorGeolocation(win);
        try {
            for (var i = 0; i < win.frames.length; i++) {
                hookAllFrames(win.frames[i]);
            }
        } catch(e) {}
    }
    hookAllFrames(window);
    // 轮询重新挂（防止延迟加载的 frame 或网页覆盖），降低频率减少日志
    var _hr_geo_hook_attempts = 0;
    var _hr_geo_hook_timer = setInterval(function() {
        _hr_geo_hook_attempts++;
        if (_hr_geo_hook_attempts > 20) { clearInterval(_hr_geo_hook_timer); return; }
        hookAllFrames(window);
    }, 3000);

    // ---- 层次2: PhoneGap/Cordova Geolocation ----
    if (typeof PhoneGap !== 'undefined' && PhoneGap.exec && !PhoneGap._hr_exec_hooked) {
        PhoneGap._hr_origExec = PhoneGap.exec;
        PhoneGap.exec = function() {
            var a = arguments;
            if (a.length >= 4 && (a[2] === 'Geolocation' || a[2] === 'geolocation')) {
                var c = getCurrentWgsCoords();
                if (c) {
                    if (a[3] === 'getCurrentPosition' || a[3] === 'getPosition') {
                        setTimeout(function() { if (a[0]) a[0](makeCoords(c.lng, c.lat)); }, 10);
                        return;
                    }
                    if (a[3] === 'watchPosition') {
                        if (a[0]) a[0](makeCoords(c.lng, c.lat));
                        return setInterval(function() {
                            var c2 = getCurrentWgsCoords();
                            if (c2 && a[0]) a[0](makeCoords(c2.lng, c2.lat));
                        }, 5000);
                    }
                }
            }
            return PhoneGap._hr_origExec.apply(this, a);
        };
        PhoneGap._hr_exec_hooked = true;
        console.log('[HR] PhoneGap.exec 已覆盖');
    }

    // ---- 层次3: Was.callbackResult 拦截 ----
    var _hr_location_callbacks = {};

    function hookWasCallbackResult() {
        if (typeof Was === 'undefined' || !Was.callbackResult || Was._hr_callback_hooked) return;
        var origCallbackResult = Was.callbackResult;
        Was.callbackResult = function(callbackID, args, keepCallback) {
            if (_hr_use_fake && _hr_location_callbacks[callbackID]) {
                var pos = _hr_makeSdkPos();
                if (pos) {
                    delete _hr_location_callbacks[callbackID];
                    console.log('[HR] 拦截到定位回调:', callbackID);
                    return origCallbackResult.call(Was, callbackID, pos, keepCallback);
                }
            }
            return origCallbackResult.call(Was, callbackID, args, keepCallback);
        };
        Was._hr_callback_hooked = true;
        console.log('[HR] Was.callbackResult 已覆盖');
    }
    hookWasCallbackResult();

    // ---- 层次4: __js2java_proxy.execPlugin 拦截（记录 callbackID） ----
    function hookJs2JavaProxy() {
        if (typeof __js2java_proxy === 'undefined' || !__js2java_proxy.execPlugin || __js2java_proxy._hr_hooked) return;
        var origExecPlugin = __js2java_proxy.execPlugin;
        __js2java_proxy.execPlugin = function(plugin, method, args, callbackID, ability) {
            console.log('[HR] __js2java_proxy 调用:', plugin, method, callbackID);
            if (_hr_isLocationPlugin(plugin)) {
                _hr_location_callbacks[callbackID] = true;
                console.log('[HR] 标记定位请求 callbackID:', callbackID);
            }
            return origExecPlugin.call(this, plugin, method, args, callbackID, ability);
        };
        __js2java_proxy._hr_hooked = true;
        console.log('[HR] __js2java_proxy 已覆盖');
    }
    hookJs2JavaProxy();

    // ---- 层次5: Was.exec/execA 覆盖 ----
    function hookWasExec() {
        if (typeof Was === 'undefined') return;
        if (Was.exec && !Was._hr_exec_hooked) {
            if (!Was._hr_origExec && !Was.exec._hr_stub_wrapper) Was._hr_origExec = Was.exec.bind(Was);
            var origExec = Was._hr_origExec || Was.exec;
            Was.exec = function(plugin, method, args, resultCB, errorCB) {
                if (_hr_isLocationPlugin(plugin)) {
                    var pos = _hr_makeSdkPos();
                    if (pos) { setTimeout(function() { if (resultCB) resultCB(pos); }, 10); return; }
                    // 真实坐标可能还没到位，等最多 5 秒
                    _hr_waitForWgsCoords(5000, 200, function(c) {
                        if (c) {
                            var p = _hr_makeSdkPos();
                            if (p) { if (resultCB) resultCB(p); return; }
                        }
                        if (Was._hr_origExec) return Was._hr_origExec(plugin, method, args, resultCB, errorCB);
                        return origExec.call(Was, plugin, method, args, resultCB, errorCB);
                    });
                    return;
                }
                return origExec.call(this, plugin, method, args, resultCB, errorCB);
            };
            Was._hr_exec_hooked = true;
            console.log('[HR] Was.exec 已覆盖');
        }
        if (Was.execA && !Was._hr_execA_hooked) {
            if (!Was._hr_origExecA && !Was.execA._hr_stub_wrapper) Was._hr_origExecA = Was.execA.bind(Was);
            var origExecA = Was._hr_origExecA || Was.execA;
            Was.execA = function(plugin, method, args, resultCB, errorCB, ability) {
                if (_hr_isLocationPlugin(plugin)) {
                    var pos = _hr_makeSdkPos();
                    if (pos) { setTimeout(function() { if (resultCB) resultCB(pos); }, 10); return; }
                    // 真实坐标可能还没到位，等最多 5 秒
                    _hr_waitForWgsCoords(5000, 200, function(c) {
                        if (c) {
                            var p = _hr_makeSdkPos();
                            if (p) { if (resultCB) resultCB(p); return; }
                        }
                        if (Was._hr_origExecA) return Was._hr_origExecA(plugin, method, args, resultCB, errorCB, ability);
                        return origExecA.call(Was, plugin, method, args, resultCB, errorCB, ability);
                    });
                    return;
                }
                return origExecA.call(this, plugin, method, args, resultCB, errorCB, ability);
            };
            Was._hr_execA_hooked = true;
            console.log('[HR] Was.execA 已覆盖');
        }
    }
    hookWasExec();

    // 轮询重新 hook（KK SDK webpack 模块加载后会覆盖 Was.exec/execA）
    // 降低频率：每 1s 检查一次，最多持续 30 秒
    var _hr_hook_attempts = 0;
    var _hr_hook_timer = setInterval(function() {
        _hr_hook_attempts++;
        if (_hr_hook_attempts > 30) { clearInterval(_hr_hook_timer); return; }
        hookWasExec();
        hookWasCallbackResult();
        hookJs2JavaProxy();
    }, 1000);

    // ---- 层次6: 轮询强制注入 Angular scope ----
    function forcePositionToAngular() {
        if (typeof angular === 'undefined') return;
        try {
            // 查找 time-sign-in 相关元素
            var el = document.querySelector('.time-sign-in, [ng-controller*="Punch"], [ng-controller*="punch"]');
            if (!el) el = document.querySelector('[ui-view] > *');
            if (!el) return;
            var scope = angular.element(el).scope();
            if (!scope) return;

            // 如果页面还在加载定位中，强制注入位置
            if (scope.refreshIng || (scope.warningTips && scope.warningTips !== '')) {
                console.log('[HR] 强制注入位置到 Angular scope');
                // Angular scope 里需要 GCJ-02 坐标
                var gcjPos = getCurrentGcjCoords();
                if (!gcjPos) return;
                if (!scope.$$phase && !scope.$root.$$phase) {
                    scope.$apply(function() {
                        scope.refreshIng = false;
                        scope.warningTips = '';
                        scope.position = scope.position || {};
                        scope.position.lat = gcjPos.lat;
                        scope.position.lng = gcjPos.lng;
                        scope.position.accuracy = 10;
                        if (scope.lat === undefined) scope.lat = gcjPos.lat;
                        if (scope.lng === undefined) scope.lng = gcjPos.lng;
                    });
                } else {
                    scope.$evalAsync(function() {
                        scope.refreshIng = false;
                        scope.warningTips = '';
                        scope.position = scope.position || {};
                        scope.position.lat = gcjPos.lat;
                        scope.position.lng = gcjPos.lng;
                        scope.position.accuracy = 10;
                        if (scope.lat === undefined) scope.lat = gcjPos.lat;
                        if (scope.lng === undefined) scope.lng = gcjPos.lng;
                    });
                }
            }
        } catch(e) { /* 静默 */ }
    }

    // 模拟定位开关控制
    function setFakeMode(enabled) {
        // 开启模拟前必须已选择坐标，防止直接定位到硬编码默认点
        if (enabled) {
            var lng = parseFloat(document.getElementById('hr_lng').value);
            var lat = parseFloat(document.getElementById('hr_lat').value);
            if (isNaN(lng) || isNaN(lat)) {
                setStatus('请先选择坐标点再开启模拟定位', '#dc3545');
                try { if (window.HRBridge) HRBridge.toast('请先选择坐标点再开启模拟定位'); } catch(e) {}
                var toggle = document.getElementById('hr_fake_toggle');
                if (toggle) toggle.checked = false;
                return;
            }
            // 用当前输入框坐标更新模拟坐标，而不是硬编码默认值
            var wgs = gcj02ToWgs84(lng, lat);
            FAKE_LNG = wgs.lng;
            FAKE_LAT = wgs.lat;
            updateNativeFakeCoords();
        }

        _hr_use_fake = !!enabled;
        window.__hr_use_fake = _hr_use_fake;

        var toggle = document.getElementById('hr_fake_toggle');
        if (toggle) toggle.checked = _hr_use_fake;

        try {
            if (_hr_use_fake) {
                if (window.HRBridge && HRBridge.stopRealLocation) HRBridge.stopRealLocation();
            } else {
                if (window.HRBridge && HRBridge.startRealLocation) HRBridge.startRealLocation();
            }
        } catch(e) {}

        // 关闭模拟时：清空输入框，让地图跟随真实定位
        if (!_hr_use_fake) {
            document.getElementById('hr_lng').value = '';
            document.getElementById('hr_lat').value = '';
            // 取消预设栏的高亮选中
            var chips = document.querySelectorAll('#hr_presets_bar span');
            chips.forEach(function(c) { c.style.background = '#fff'; c.style.color = '#333'; c.style.borderColor = '#ddd'; });
            if (mapInited && mapInstance) {
                setTimeout(function() { locateCurrentPosition(); }, 500);
            }
        }
    }

    // 强制刷新: 刚注入后 + 1秒 + 2秒 + 3秒 + 5秒
    setTimeout(forcePositionToAngular, 100);
    setTimeout(forcePositionToAngular, 1000);
    setTimeout(forcePositionToAngular, 2000);
    setTimeout(forcePositionToAngular, 3000);
    setTimeout(forcePositionToAngular, 5000);

    // 持续监控（每2秒检查）
    setInterval(forcePositionToAngular, 2000);

    // ========================================================
    //  图片选择：补丁 weChatService.selectImage，走 Was.exec("image", ...)
    // ========================================================
    function patchWeChatService() {
        if (typeof angular === 'undefined') return false;
        try {
            var inj = null;
            // 尝试多种方式获取 Angular injector
            try { inj = angular.element(document.body).injector(); } catch(e) {}
            if (!inj) try { inj = angular.element(document.querySelector('[ng-app]')).injector(); } catch(e) {}
            if (!inj) try { inj = angular.element(document).injector(); } catch(e) {}
            if (!inj) return false;
            var svc = inj.get('weChatService');
            if (!svc || svc._hr_patched) return !!svc;
            var $q = inj.get('$q');
            svc.selectImage = function(useCamera) {
                var deferred = $q.defer();
                var optionParams = {
                    sourceType: useCamera ? 'sysCamera' : 'album',
                    destinationType: 'data',
                    encodingType: 'png',
                    targetWidth: 500,
                    targetHeight: 500,
                    quality: 100
                };
                console.log('[HR] 调用图片选择:', optionParams);
                Was.exec('image', 'getPicture', JSON.stringify(optionParams), function(result) {
                    console.log('[HR] 图片选择成功:', result);
                    // 优先使用 retDataStr（无前缀），兼容旧版 KK SDK wrapper
                    var base64 = '';
                    if (result && result.retDataStr) {
                        base64 = result.retDataStr;
                    } else if (result && result.imageData && typeof result.imageData === 'string') {
                        var idx = result.imageData.indexOf(',');
                        base64 = idx >= 0 ? result.imageData.substring(idx + 1) : result.imageData;
                    }
                    if (!base64 || base64 === 'undefined') {
                        console.error('[HR] 图片选择结果缺少有效 base64');
                        setTimeout(function() { deferred.reject({message: '图片数据为空'}); });
                        return;
                    }
                    setTimeout(function() { deferred.resolve(base64); });
                }, function(code, msg) {
                    console.error('[HR] 图片选择失败: code=' + code + ' msg=' + msg);
                    setTimeout(function() { deferred.reject({message: msg || ('错误码:' + code)}); });
                });
                return deferred.promise;
            };
            svc._hr_patched = true;
            console.log('[HR] weChatService.selectImage 已补丁');
            return true;
        } catch(e) { console.error('[HR] patchWeChatService 失败:', e); return false; }
    }
    // 持续尝试补丁，直到成功或达到最大次数
    var _hr_patch_attempts = 0;
    var _hr_patch_timer = setInterval(function() {
        _hr_patch_attempts++;
        if (patchWeChatService() || _hr_patch_attempts > 60) clearInterval(_hr_patch_timer);
    }, 500);

    // ========================================================
    //  UI 样式（内联，避免外部依赖）
    // ========================================================
    var style = document.createElement('style');
    style.textContent =
        '#hr_fab{position:fixed;right:12px;bottom:80px;width:44px;height:44px;' +
            'background:linear-gradient(135deg,#4a6cf7,#6a3de8);border-radius:50%;' +
            'display:flex;align-items:center;justify-content:center;font-size:18px;' +
            'cursor:pointer;box-shadow:0 3px 12px rgba(74,108,247,0.4);z-index:999999;' +
            'border:none;color:#fff;user-select:none;-webkit-tap-highlight-color:transparent;' +
            'transition:transform 0.2s;}' +
                '#hr_fab:active{transform:scale(0.9)}' +
        '#hr_fake_switch_label{position:relative;display:inline-block;width:30px;height:16px;cursor:pointer;flex-shrink:0;vertical-align:middle;}' +
        '#hr_fake_toggle{opacity:0;width:0;height:0;position:absolute;}' +
        '#hr_fake_slider{position:absolute;top:0;left:0;width:100%;height:100%;background:#888;border:1px solid rgba(255,255,255,0.4);border-radius:16px;transition:0.2s;}' +
        '#hr_fake_slider:before{content:"";position:absolute;height:12px;width:12px;left:2px;bottom:2px;background:#fff;border-radius:50%;transition:0.2s;box-shadow:0 1px 2px rgba(0,0,0,0.3);}' +
        '#hr_fake_toggle:checked + #hr_fake_slider{background:#28a745;border-color:rgba(255,255,255,0.6);}' +
        '#hr_fake_toggle:checked + #hr_fake_slider:before{-webkit-transform:translateX(14px);transform:translateX(14px);}' +
        '#hr_panel{position:fixed;right:12px;bottom:130px;width:340px;max-height:500px;'
 +
            'background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,0.3);' +
            'z-index:999998;display:none;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}' +
        '#hr_presets_bar{padding:8px 10px;background:#f5f6fa;border-bottom:1px solid #eee;overflow-x:auto;white-space:nowrap;}' +
        '#hr_presets_bar span{display:inline-block;padding:4px 12px;margin:2px 4px;border-radius:12px;' +
            'font-size:12px;cursor:pointer;border:1px solid #ddd;background:#fff;color:#333;user-select:none;}' +
        '#hr_presets_bar span:active{opacity:0.7}' +
        '#hr_settings_overlay{position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999999;' +
            'background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;' +
            'font-family:-apple-system,BlinkMacSystemFont,sans-serif;}' +
        '#hr_settings_box{background:#fff;border-radius:14px;width:320px;max-width:90vw;' +
            'overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.3);}' +
        '@media(orientation:landscape){' +
            '#hr_fab{right:8px;bottom:16px;width:40px;height:40px;font-size:16px;}' +
            '#hr_panel{right:8px;bottom:62px;max-height:calc(100vh - 80px);}' +
            '#hr_map_container{height:150px!important;}' +
        '}';
    if (document.head) document.head.appendChild(style);
    else document.addEventListener('DOMContentLoaded', function() { document.head.appendChild(style); });

    // ========================================================
    //  UI - 浮动按钮 + 面板
    // ========================================================
    function boot() {
        if (document.getElementById('hr_fab')) return;

        // ---- 📍 按钮 ----
        var fab = document.createElement('div');
        fab.id = 'hr_fab';
        fab.textContent = '📍';
        fab.onclick = togglePanel;
        document.body.appendChild(fab);

        // ---- 面板 ----
        var p = document.createElement('div');
        p.id = 'hr_panel';
        p.innerHTML =
            '<div style="background:linear-gradient(135deg,#4a6cf7,#6a3de8);padding:8px 10px;color:#fff;' +
                'display:flex;justify-content:space-between;align-items:center;">' +
                '<span style="flex:1;min-width:0;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📍 打卡</span>' +
                '<div style="display:flex;align-items:center;flex-shrink:0;margin-left:6px;">' +
                    '<label id="hr_fake_switch_label" title="启用模拟定位" style="margin-left:0;">' +
                        '<input type="checkbox" id="hr_fake_toggle" ' + (_hr_use_fake ? 'checked' : '') + '>' +
                        '<span id="hr_fake_slider"></span>' +
                    '</label>' +
                    '<span id="hr_gear" style="cursor:pointer;font-size:13px;padding:1px;flex-shrink:0;margin-left:4px;">⚙️</span>' +
                    '<span id="hr_close" style="cursor:pointer;font-size:15px;padding:1px;flex-shrink:0;margin-left:4px;">✕</span>' +
                '</div>' +
            '</div>' +
            '<div id="hr_presets_bar"></div>' +
            '<div style="padding:8px 12px;">' +
                '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
                    '<div style="flex:1;font-size:11px;color:#888;">经度(GCJ-02) ' +
                        '<input id="hr_lng" type="number" step="0.0000001" readonly ' +
                        'style="width:100%;padding:5px;border:1px solid #ddd;border-radius:5px;font-size:13px;box-sizing:border-box;background:#f9f9f9;"></div>' +
                    '<div style="flex:1;font-size:11px;color:#888;">纬度(GCJ-02) ' +
                        '<input id="hr_lat" type="number" step="0.0000001" readonly ' +
                        'style="width:100%;padding:5px;border:1px solid #ddd;border-radius:5px;font-size:13px;box-sizing:border-box;background:#f9f9f9;"></div>' +
                                '</div>' +
                '<div style="display:flex;gap:6px;">' +
                    '<button id="hr_use_btn" style="flex:1;padding:10px;background:#28a745;color:#fff;border:none;' +
                        'border-radius:7px;font-size:14px;font-weight:600;cursor:pointer;">确认打卡坐标</button>' +
                    '<button id="hr_save_btn" style="flex:1;padding:10px;background:#ffc107;color:#333;border:none;' +
                        'border-radius:7px;font-size:14px;font-weight:600;cursor:pointer;">保存预设</button>' +
                '</div>' +
                '<div id="hr_map_container" style="display:block;height:220px;margin-top:8px;border-radius:8px;overflow:hidden;"></div>' +
                '<div id="hr_status" style="margin-top:6px;font-size:11px;color:#666;text-align:center;"></div>' +
            '</div>';

        document.body.appendChild(p);

        function fitPanel() {
            var w = Math.min(450, Math.max(320, Math.floor(window.innerWidth * 0.98)));
            var h = Math.min(560, Math.floor(window.innerHeight * 0.75));
            p.style.width = w + 'px';
            p.style.maxHeight = h + 'px';
            var mc = document.getElementById('hr_map_container');
            if (mc) mc.style.height = Math.min(220, Math.floor(window.innerHeight * 0.35)) + 'px';
        }
        fitPanel();
        window.addEventListener('resize', fitPanel);

        document.getElementById('hr_close').onclick = function() { p.style.display = 'none'; };
        document.getElementById('hr_gear').onclick = openSettings;
        document.getElementById('hr_use_btn').onclick = useLocation;
        document.getElementById('hr_save_btn').onclick = savePreset;

        var fakeToggle = document.getElementById('hr_fake_toggle');
        if (fakeToggle) {
            fakeToggle.checked = _hr_use_fake;
            fakeToggle.onchange = function() { setFakeMode(this.checked); };
        }

        loadPresets();
        // 不再自动选择第一个预设，让地图默认跟随真实定位

        // 根据当前模式启动/停止真实定位
        setFakeMode(_hr_use_fake);
    }

    // ========================================================
    //  预设管理（持久化到手机存储）
    // ========================================================
    var presets = [];

    function loadPresets() {
        presets = [];
        try {
            var raw = window.HRBridge ? HRBridge.getPresets() : null;
            if (raw) {
                var parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    // 过滤掉旧版本遗留的默认打卡点，只保留用户自己保存的预设
                    presets = parsed.filter(function(p) { return p && p.name !== '默认打卡点'; });
                }
            }
        } catch(e) { presets = []; }
        renderPresets();
    }

    function renderPresets() {
        var bar = document.getElementById('hr_presets_bar');
        if (!bar) return;
        bar.innerHTML = '';
        presets.forEach(function(p, i) {
            var c = document.createElement('span');
            c.textContent = p.name;
            c.title = '点击使用，长按删除';
            c.onclick = function() { selectPreset(i); };

            // 长按删除（移动端 touch / 桌面端 contextmenu）
            var pressTimer = null;
            var longPressed = false;
            function startLongPress(e) {
                if (e.type === 'contextmenu') return; // 由 contextmenu 单独处理
                longPressed = false;
                pressTimer = setTimeout(function() {
                    pressTimer = null;
                    longPressed = true;
                    if (confirm('删除预设 "' + p.name + '"?')) {
                        presets.splice(i, 1);
                        saveToNative();
                        renderPresets();
                        setStatus('已删除预设: ' + p.name, '#28a745');
                    }
                }, 600);
            }
            function cancelLongPress() {
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
            }
            c.addEventListener('touchstart', startLongPress);
            c.addEventListener('touchend', cancelLongPress);
            c.addEventListener('touchmove', cancelLongPress);
            c.addEventListener('mousedown', startLongPress);
            c.addEventListener('mouseup', cancelLongPress);
            c.addEventListener('mouseleave', cancelLongPress);
            c.addEventListener('contextmenu', function(e) {
                e.preventDefault();
                cancelLongPress();
                if (longPressed) { longPressed = false; return; }
                if (confirm('删除预设 "' + p.name + '"?')) {
                    presets.splice(i, 1);
                    saveToNative();
                    renderPresets();
                    setStatus('已删除预设: ' + p.name, '#28a745');
                }
            });

            bar.appendChild(c);
        });
    }

    function selectPreset(idx) {
        var p = presets[idx];
        if (!p) return;
        document.getElementById('hr_lng').value = p.lng.toFixed(7);
        document.getElementById('hr_lat').value = p.lat.toFixed(7);

        var chips = document.querySelectorAll('#hr_presets_bar span');
        chips.forEach(function(c, i) {
            c.style.background = (i === idx) ? '#4a6cf7' : '#fff';
            c.style.color = (i === idx) ? '#fff' : '#333';
            c.style.borderColor = (i === idx) ? '#4a6cf7' : '#ddd';
        });
    }

    function savePreset() {
        var lng = parseFloat(document.getElementById('hr_lng').value);
        var lat = parseFloat(document.getElementById('hr_lat').value);
        if (isNaN(lng) || isNaN(lat)) { setStatus('请先选择坐标', '#dc3545'); return; }

        var name = prompt('保存为预设，输入名称:');
        if (!name) return;

        for (var i = 0; i < presets.length; i++) {
            if (presets[i].name === name) {
                presets[i].lng = lng;
                presets[i].lat = lat;
                saveToNative();
                renderPresets();
                selectPreset(i);
                setStatus('已更新预设: ' + name, '#28a745');
                return;
            }
        }
        presets.push({ name: name, lng: lng, lat: lat });
        saveToNative();
        renderPresets();
        selectPreset(presets.length - 1);
        setStatus('已保存预设: ' + name, '#28a745');
    }

    function saveToNative() {
        try {
            if (window.HRBridge) HRBridge.savePresets(JSON.stringify(presets));
        } catch(e) {}
    }

    // ========================================================
    //  地图（高德 AMap JS API）

    function useLocation() {
        var lng = parseFloat(document.getElementById('hr_lng').value);
        var lat = parseFloat(document.getElementById('hr_lat').value);
        if (isNaN(lng) || isNaN(lat)) {
            setStatus('请先选择位置', '#dc3545');
            return;
        }
        // GCJ-02 → WGS84 后保存为模拟坐标（页面会再转回 GCJ-02）
        var wgs = gcj02ToWgs84(lng, lat);
        FAKE_LNG = wgs.lng;
        FAKE_LAT = wgs.lat;
        updateNativeFakeCoords();

        // 通过 Angular 的 rootScope 广播事件（GCJ-02）
        try {
            var rootScope = angular.element(document.body).injector().get('$rootScope');
            var gcjPos2 = wgs84ToGcj02(FAKE_LNG, FAKE_LAT);
            rootScope.$broadcast('locationChanged', { lat: gcjPos2.lat, lng: gcjPos2.lng });
        } catch(e) {}

        try { if (window.HRBridge) HRBridge.toast('坐标已注入'); } catch(e) {}

        setTimeout(function() {
            document.getElementById('hr_panel').style.display = 'none';
        }, 2000);
    }

    // ========================================================
    //  地图（高德 AMap JS API）
    // ========================================================
    var mapInited = false;
    var mapInstance = null;
    var mapMarker = null;
    var AMAP_KEY = 'd8a3a89911723f78214181eb82eb972d';

    function loadMap() {
        if (mapInited && mapInstance) {
            document.getElementById('hr_map_container').style.display = 'block';
            setTimeout(function() { mapInstance.resize(); }, 100);
            var center = getMapCenter();
            if (center) {
                mapInstance.setCenter([center.lng, center.lat]);
                if (!mapMarker) {
                    mapMarker = new AMap.Marker({
                        position: [center.lng, center.lat],
                        draggable: true,
                        anchor: 'bottom-center',
                        icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
                        map: mapInstance
                    });
                    mapMarker.on('dragend', function() {
                        var pos = mapMarker.getPosition();
                        document.getElementById('hr_lng').value = pos.lng.toFixed(7);
                        document.getElementById('hr_lat').value = pos.lat.toFixed(7);
                    });
                } else {
                    mapMarker.setPosition([center.lng, center.lat]);
                }
            }
            return;
        }

        var container = document.getElementById('hr_map_container');
        container.style.display = 'block';
        setStatus('正在加载高德地图...', '#4a6cf7');

        if (window.AMap) { initAMap(); return; }

        var script = document.createElement('script');
        script.src = 'https://webapi.amap.com/maps?v=2.0&key=' + AMAP_KEY;
        script.onload = function() { setTimeout(initAMap, 300); };
        script.onerror = function() { setStatus('高德地图加载失败，试试直接选预设', '#dc3545'); };
        document.head.appendChild(script);
    }

    function initAMap() {
        try {
            var center = getMapCenter();
            var lng = center ? center.lng : 112.94;
            var lat = center ? center.lat : 28.23;
            var container = document.getElementById('hr_map_container');

            mapInstance = new AMap.Map(container, {
                zoom: 16,
                center: [lng, lat],
                resizeEnable: true,
                touchZoom: true,
                dragEnable: true
            });

            if (center) {
                mapMarker = new AMap.Marker({
                    position: [lng, lat],
                    draggable: true,
                    anchor: 'bottom-center',
                    icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
                    map: mapInstance
                });

                mapMarker.on('dragend', function() {
                    var pos = mapMarker.getPosition();
                    document.getElementById('hr_lng').value = pos.lng.toFixed(7);
                    document.getElementById('hr_lat').value = pos.lat.toFixed(7);
                });

                mapInstance.on('click', function(e) {
                    mapMarker.setPosition(e.lnglat);
                    document.getElementById('hr_lng').value = e.lnglat.lng.toFixed(7);
                    document.getElementById('hr_lat').value = e.lnglat.lat.toFixed(7);
                });
            } else {
                // 尚未获取到位置，等真实坐标到了再创建标记
                mapInstance.on('click', function(e) {
                    if (!mapMarker) {
                        mapMarker = new AMap.Marker({
                            position: e.lnglat,
                            draggable: true,
                            anchor: 'bottom-center',
                            icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
                            map: mapInstance
                        });
                        mapMarker.on('dragend', function() {
                            var pos = mapMarker.getPosition();
                            document.getElementById('hr_lng').value = pos.lng.toFixed(7);
                            document.getElementById('hr_lat').value = pos.lat.toFixed(7);
                        });
                    } else {
                        mapMarker.setPosition(e.lnglat);
                    }
                    document.getElementById('hr_lng').value = e.lnglat.lng.toFixed(7);
                    document.getElementById('hr_lat').value = e.lnglat.lat.toFixed(7);
                });
            }

            // 添加「定位到当前位置」按钮
            var locateBtn = document.createElement('div');
            locateBtn.style.cssText = 'position:absolute;right:6px;bottom:6px;z-index:10;width:30px;height:30px;background:rgba(255,255,255,0.9);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:pointer;';
            locateBtn.textContent = '📍';
            locateBtn.title = '定位到当前位置';
            locateBtn.onclick = locateCurrentPosition;
            container.appendChild(locateBtn);

            mapInited = true;
            if (center) setStatus('点击地图选点，或拖拽红色标记', '#28a745');
        } catch(e) {
            setStatus('高德地图加载失败: ' + e.message, '#dc3545');
        }
    }

    // ========================================================
    //  工具
    // ========================================================
    function togglePanel() {
        var p = document.getElementById('hr_panel');
        if (!p) return;
        var show = p.style.display !== 'block';
        p.style.display = show ? 'block' : 'none';
        if (show) loadMap();
    }

    function setStatus(msg, color) {
        var el = document.getElementById('hr_status');
        if (el) { el.textContent = msg; el.style.color = color || '#666'; }
        console.log('[HR] ' + msg);
    }

    // ========================================================
    //  设置（自定义 UA）
    // ========================================================
    function openSettings() {
        var existing = document.getElementById('hr_settings_overlay');
        if (existing) existing.remove();

        var currentUA = '';
        try { if (window.HRBridge) currentUA = HRBridge.getUserAgent(); } catch(e) {}
        if (!currentUA) currentUA = navigator.userAgent;

        var overlay = document.createElement('div');
        overlay.id = 'hr_settings_overlay';
        overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
        overlay.innerHTML =
            '<div id="hr_settings_box">' +
                '<div style="background:linear-gradient(135deg,#4a6cf7,#6a3de8);padding:12px 16px;color:#fff;' +
                    'display:flex;justify-content:space-between;align-items:center;">' +
                    '<span style="font-weight:600;font-size:15px;">⚙️ 设置</span>' +
                    '<span id="hr_settings_close" style="cursor:pointer;font-size:18px;padding:2px 8px;">✕</span>' +
                '</div>' +
                '<div style="padding:16px;">' +
                    '<label style="font-size:13px;color:#555;display:block;margin-bottom:6px;">自定义 User Agent</label>' +
                    '<textarea id="hr_ua_input" rows="2" style="width:100%;padding:8px;border:1px solid #ddd;' +
                        'border-radius:6px;font-size:13px;box-sizing:border-box;resize:none;font-family:monospace;">' +
                        currentUA.replace(/</g, '&lt;').replace(/>/g, '&gt;') +
                    '</textarea>' +
                    '<div style="font-size:11px;color:#999;margin-top:4px;">留空恢复默认，修改后将重新加载页面</div>' +
                    '<button id="hr_ua_apply" style="width:100%;margin-top:12px;padding:10px;' +
                        'background:#4a6cf7;color:#fff;border:none;border-radius:7px;font-size:14px;font-weight:600;cursor:pointer;">应用并重新加载</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        var settingsBox = document.getElementById('hr_settings_box');
        if (settingsBox) {
            settingsBox.style.width = Math.min(380, Math.floor(window.innerWidth * 0.9)) + 'px';
            settingsBox.style.maxWidth = '90vw';
        }

        document.getElementById('hr_settings_close').onclick = function() { overlay.remove(); };
        document.getElementById('hr_ua_apply').onclick = function() {
            var ua = document.getElementById('hr_ua_input').value.trim();
            try {
                if (window.HRBridge) HRBridge.setUserAgent(ua);
            } catch(e) {}
        };
    }

    // ========================================================
    //  启动
    // ========================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    // SPA hash / pathname 变化检测（合并为一个 timer）
    var lastHash = '';
    var lastPath = location.pathname;
    setInterval(function() {
        var changed = false;
        if (window.location.hash !== lastHash) {
            lastHash = window.location.hash;
            changed = true;
        }
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            changed = true;
        }
        if (changed && !document.getElementById('hr_fab')) {
            if (window.location.hash.includes('time_punch') || location.pathname.includes('time_punch') || location.pathname.includes('sign')) {
                boot();
            }
            // 路由变化后重新强制注入位置并重新补丁图片服务
            setTimeout(forcePositionToAngular, 500);
            setTimeout(forcePositionToAngular, 1500);
            setTimeout(patchWeChatService, 1000);
            setTimeout(patchWeChatService, 3000);
        }
    }, 800);

    console.log('[HR] 注入脚本完成');
})();
