(function (global) {
  'use strict';
  var KEY = 'xuanlun_data';

  function load() {
    try {
      var s = (global.HRBridge && HRBridge.getXuanlunData) ? HRBridge.getXuanlunData() : localStorage.getItem(KEY);
      if (!s) return { jobs: [] };
      var d = JSON.parse(s);
      if (!d || !Array.isArray(d.jobs)) return { jobs: [] };
      return d;
    } catch (e) { return { jobs: [] }; }
  }
  function save(data) {
    try {
      var s = JSON.stringify(data);
      if (global.HRBridge && HRBridge.setXuanlunData) HRBridge.setXuanlunData(s);
      else localStorage.setItem(KEY, s);
    } catch (e) { /* ignore */ }
  }
  function pad2(n) { n = String(parseInt(n, 10)); return n.length < 2 ? '0' + n : n; }
  function sectionsFor(line, car) {
    var l = pad2(line);
    var a = car.slice(0, 3), b = car.slice(3, 6);
    return [l + 'A' + a, l + 'B' + a, l + 'C' + a, l + 'C' + b, l + 'B' + b, l + 'A' + b];
  }
  function blankSection(sec) {
    var axles = {};
    for (var i = 1; i <= 4; i++) axles[sec + '-' + i] = { dir: 'A-B', data: null };
    return { date: '', maker: '', checker: '', time: '', axles: axles };
  }
  function ensureJob(job) {
    if (!job.sections || !job.sections.length) job.sections = sectionsFor(job.line, job.car);
    if (!job.sheets) job.sheets = {};
    job.sections.forEach(function (s) { if (!job.sheets[s]) job.sheets[s] = blankSection(s); });
    return job;
  }
  function getJob(data, id) {
    for (var i = 0; i < data.jobs.length; i++) if (data.jobs[i].id === id) return data.jobs[i];
    return null;
  }
  function progress(job) {
    var total = 0, filled = 0;
    job.sections.forEach(function (s) {
      var sh = job.sheets[s];
      Object.keys(sh.axles).forEach(function (k) { total++; if (sh.axles[k] && sh.axles[k].data) filled++; });
    });
    return { total: total, filled: filled };
  }
  function goBack(fallbackSite) {
    if (history.length > 1) history.back();
    else if (global.HRBridge && HRBridge.openSite) HRBridge.openSite(fallbackSite || 'home');
  }

  var MK = 'xuanlun_models';

  // ---- 模型配置：服务商 / 模型库 / 当前与备选 ----
  function emptyModels() { return { providers: [], library: [], current: null, fallback: null }; }
  function loadModels() {
    var cfg = null;
    try {
      var s = (global.HRBridge && HRBridge.getXuanlunModels) ? HRBridge.getXuanlunModels() : localStorage.getItem(MK);
      if (s) cfg = JSON.parse(s);
    } catch (e) { cfg = null; }
    if (!cfg || !Array.isArray(cfg.providers)) cfg = migrateModels();
    if (!Array.isArray(cfg.library)) cfg.library = [];
    return cfg;
  }
  function saveModels(cfg) {
    try {
      var s = JSON.stringify(cfg);
      if (global.HRBridge && HRBridge.setXuanlunModels) HRBridge.setXuanlunModels(s);
      else localStorage.setItem(MK, s);
    } catch (e) { /* ignore */ }
  }
  // 兼容旧的单模型配置（xuanlun_llm）
  function migrateModels() {
    var old = null;
    try {
      var s = (global.HRBridge && HRBridge.getLlmConfig) ? HRBridge.getLlmConfig() : localStorage.getItem('xuanlun_llm');
      if (s) old = JSON.parse(s);
    } catch (e) { old = null; }
    var cfg = emptyModels();
    if (old && old.baseUrl && old.apiKey) {
      var pid = 'p' + Date.now();
      cfg.providers.push({ id: pid, name: '默认服务商', baseUrl: old.baseUrl, apiKey: old.apiKey, models: [] });
      if (old.model) {
        var mid = 'm' + Date.now();
        cfg.library.push({ id: mid, providerId: pid, modelId: old.model, ctx: old.contextLength || '', reasoning: old.reasoning || '' });
        cfg.current = mid;
      }
    }
    return cfg;
  }
  function normBase(url) {
    var s = String(url || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    return /\/v1$/i.test(s) ? s : s + '/v1';
  }
  function findProvider(cfg, id) {
    for (var i = 0; i < cfg.providers.length; i++) if (cfg.providers[i].id === id) return cfg.providers[i];
    return null;
  }
  function findLib(cfg, id) {
    for (var i = 0; i < cfg.library.length; i++) if (cfg.library[i].id === id) return cfg.library[i];
    return null;
  }
  function currentModel(cfg) {
    if (!cfg || !cfg.current) return null;
    var lib = findLib(cfg, cfg.current);
    if (!lib) return null;
    var p = findProvider(cfg, lib.providerId);
    if (!p) return null;
    return { lib: lib, provider: p };
  }
  function fallbackModel(cfg) {
    if (!cfg || !cfg.fallback) return null;
    var lib = findLib(cfg, cfg.fallback);
    if (!lib) return null;
    var p = findProvider(cfg, lib.providerId);
    if (!p) return null;
    return { lib: lib, provider: p };
  }

  global.XL = {
    load: load, save: save, pad2: pad2, sectionsFor: sectionsFor,
    ensureJob: ensureJob, getJob: getJob, progress: progress, goBack: goBack,
    loadModels: loadModels, saveModels: saveModels, normBase: normBase,
    findProvider: findProvider, findLib: findLib, currentModel: currentModel, fallbackModel: fallbackModel
  };
})(window);
