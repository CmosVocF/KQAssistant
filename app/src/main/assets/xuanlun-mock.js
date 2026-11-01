/*
 * 浏览器预览用的 HRBridge 模拟层（仅在非 Android 环境生效）。
 * 配合 `tools/preview.ps1` 启动本地静态服务：
 *   http://127.0.0.1:8788/xuanlun.html?demo=1
 * Android WebView 里已注入真实 HRBridge，本文件不会被加载。
 */
(function () {
  'use strict';
  if (window.HRBridge) return;

  var K1 = 'xuanlun_data', K2 = 'xuanlun_models';
  var imgs = {};

  function qs(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }

  // 预加载模板（同步 XHR，仅供本地 http 预览）
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'xuanlun/template.xlsx', false);
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.send(null);
    if (xhr.status === 200 || xhr.status === 0) {
      var txt = xhr.responseText, s = '';
      for (var i = 0; i < txt.length; i++) s += String.fromCharCode(txt.charCodeAt(i) & 0xff);
      localStorage.setItem('xuanlun_tpl_b64', btoa(s));
    }
  } catch (e) { /* ignore */ }

  var SAMPLE = {
    '轮对ID': '04B047-3', '车辆ID': '047048', '车辆方向': '0', '加工日期': '2026-10-13',
    '加工前': {
      '左轮': { '轮缘高度': 30.11, '轮缘厚度': 28.94, '直径': 813.38, '径向跳动量': 0.03 },
      '右轮': { '轮缘高度': 30.24, '轮缘厚度': 28.64, '直径': 813.77, '径向跳动量': 0.03 }
    },
    '加工后': {
      '左轮': { '轮缘高度': 27.98, '轮缘厚度': 28.98, '直径': 808.91, '径向跳动量': 0.02 },
      '右轮': { '轮缘高度': 28.00, '轮缘厚度': 29.06, '直径': 808.85, '径向跳动量': 0.02 }
    }
  };

  window.HRBridge = {
    getXuanlunData: function () { return localStorage.getItem(K1); },
    setXuanlunData: function (s) { try { localStorage.setItem(K1, s); } catch (e) {} },
    getXuanlunModels: function () { return localStorage.getItem(K2); },
    setXuanlunModels: function (s) { try { localStorage.setItem(K2, s); } catch (e) {} },
    openSite: function (site) {
      var map = { home: 'launcher.html', xuanlun: 'xuanlun.html', 'xuanlun-settings': 'xuanlun-settings.html' };
      if (map[site]) location.href = map[site];
    },
    toast: function (m) { alert(m); },
    llmRequest: function (url, method, body, apiKey) {
      if ((method || 'GET').toUpperCase() === 'GET') {
        return JSON.stringify({
          ok: true, status: 200,
          text: JSON.stringify({ data: [
            { id: 'mock-vl-1', context_length: 32768 },
            { id: 'mock-vl-2', context_length: 131072 }
          ] })
        });
      }
      return JSON.stringify({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) });
    },
    xuanlunPickImage: function (reqJson) {
      var req = {};
      try { req = JSON.parse(reqJson || '{}'); } catch (e) {}
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        var rd = new FileReader();
        rd.onload = function () {
          var path = 'mock://img/' + (req.axle || 'x') + '/' + Date.now();
          imgs[path] = rd.result;
          if (window.__xuanlunImagePicked) {
            window.__xuanlunImagePicked({ ok: true, path: path, origPath: path, dataUrl: rd.result, request: req });
          }
        };
        rd.readAsDataURL(f);
      };
      inp.click();
    },
    xuanlunImageData: function (path) {
      return JSON.stringify({ ok: !!imgs[path], dataUrl: imgs[path] || '' });
    },
    xuanlunRecognize: function (reqJson) {
      var req = {};
      try { req = JSON.parse(reqJson || '{}'); } catch (e) {}
      setTimeout(function () {
        var d = JSON.parse(JSON.stringify(SAMPLE));
        if (req.axle) d['轮对ID'] = req.axle;
        if (window.__xuanlunRecognized) {
          window.__xuanlunRecognized({ ok: true, data: d, model: 'mock-vl（浏览器预览）' });
        }
      }, 1200);
    },
    xuanlunTemplate: function () { return localStorage.getItem('xuanlun_tpl_b64') || ''; },
    xuanlunSaveXlsx: function (b64, name) {
      try {
        var bin = atob(b64), arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name || 'xuanlun.xlsx';
        a.click();
        return JSON.stringify({ ok: true, path: name });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    },
    xuanlunShareFile: function () { return JSON.stringify({ ok: true }); }
  };

  // ?demo=1 时注入一份示例作业，方便预览/截图（每次覆盖）
  if (qs('demo') === '1') {
    var job = {
      id: 'jdemo', line: '04', car: '047048', created: Date.now(),
      sections: ['04A047', '04B047', '04C047', '04C048', '04B048', '04A048'], sheets: {}
    };
    job.sections.forEach(function (sec) {
      job.sheets[sec] = { date: '', maker: '', checker: '', time: '', axles: {} };
      for (var i = 1; i <= 4; i++) job.sheets[sec].axles[sec + '-' + i] = { dir: 'A-B', data: null };
    });
    var sheet = job.sheets['04B047'];
    sheet.date = '2026-10-13';
    sheet.maker = '示例镟修人';
    var ax = sheet.axles['04B047-3'];
    ax.recStatus = 'ok';
    ax.recModel = 'mock-vl';
    ax.imagePath = 'mock://demo/04B047-3';
    imgs[ax.imagePath] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">' +
      '<rect width="160" height="160" fill="#eef1f5"/>' +
      '<rect x="18" y="26" width="124" height="108" fill="#fff" stroke="#9aa4b2"/>' +
      '<text x="80" y="86" font-size="13" text-anchor="middle" fill="#5b6470">示例图片</text></svg>'
    );
    // 演示失败任务（红色报错展示）
    var axFail = sheet.axles['04B047-4'];
    axFail.imagePath = 'mock://demo/04B047-4';
    imgs[axFail.imagePath] = imgs[ax.imagePath];
    axFail.recStatus = 'fail';
    axFail.recError = 'HTTP 401：API Key 无效（示例错误）';
    ax.data = {
      axleId: '04B047-3', carId: '047048', date: '2026-10-13',
      before: { left: { lh: '30.11', le: '28.94', dia: '813.38', rt: '0.03' }, right: { lh: '30.24', le: '28.64', dia: '813.77', rt: '0.03' } },
      after: { left: { lh: '27.98', le: '28.98', dia: '808.91', rt: '0.02' }, right: { lh: '28.00', le: '29.06', dia: '808.85', rt: '0.02' } }
    };
    localStorage.setItem(K1, JSON.stringify({ jobs: [job] }));
  }
})();
