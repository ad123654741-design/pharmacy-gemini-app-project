/**
 * 藥品近效期智慧監控與作業系統 (Pharmacy Expiry Tracker)
 * -----------------------------------------------------------------------------
 * 三層資料分離架構 (Three-Tier Data Architecture):
 *   1. 原始匯入層 (IndexedDB): expiryRows (效期快照)、masterMap (精簡基本檔)
 *      -> 每 3~6 個月重新上傳時直接安全覆蓋，自動產出差異摘要 (Diff)。
 *   2. 永續作業紀錄層 (IndexedDB): actionLogs (Key = 藥碼__批號__效期YYYYMMDD)
 *      -> 永久保存貼標/下架/備註/經手人，重新上傳時自動繼承，消失批號轉歷史封存。
 *   3. 系統設定層 (IndexedDB + localStorage 備援): settings
 *      -> 排除基準日、分級門檻、特定排除藥碼、雲端同步設定。
 */

(() => {
  'use strict';

  // ===========================================================================
  // 1. 常數與預設設定
  // ===========================================================================
  const DB_NAME = 'PharmacyExpiryTrackerDB';
  const DB_VERSION = 1;
  const STORE_KV = 'kv';
  const PAGE_SIZE = 150;

  const DEFAULT_SETTINGS = {
    cutoffDate: '2026-06-01', // YYYY-MM-DD (此日期不含之前排除)
    maxAlertDays: 0,          // 0 = 顯示全部
    showExpired: true,        // 顯示已過期藥品
    excludeZeroStock: true,   // 排除庫存 <= 0
    excludeNoteS: true,       // 基本檔 使用註記 = S
    excludePropRG: true,      // 基本檔 調劑特性 = UDDCLRG
    urgentDays: 30,           // 緊急 / 建議下架門檻 (天內)
    nearDays: 90,             // 近效期 / 建議貼標門檻 (天內)
    watchDays: 180,           // 注意 / 定期巡檢門檻 (天內)
    autoExcludeCDC: false,    // 自動排除批號含 -CDC
    excludedCodes: [],        // 特定排除藥碼 (大寫陣列，如疫苗等)
    operatorName: '',         // 預設操作藥師簡稱
    hideRemoved: true,        // 主清單預設隱藏已下架
    gasUrl: '',               // Google Apps Script Web App URL
    gasToken: '',             // 選填存取金鑰
    gasAutoSync: true,        // 開啟時自動拉取
    gasSyncInventory: true,   // 一併同步效期與精簡基本檔
  };

  // ===========================================================================
  // 2. 應用狀態
  // ===========================================================================
  const state = {
    settings: { ...DEFAULT_SETTINGS },
    expiryRows: [],   // [{ code, name, stock, dept, lot, expYmd, expStr }]
    masterMap: {},    // { [CODE]: { n: name, u: unit, s: 0|1 (note=S), r: 0|1 (prop=UDDCLRG) } }
    actionLogs: {},   // { [key]: { key, code, name, lot, expYmd, dept, labeled, labeledAt, removed, removedAt, note, operator, updatedAt } }
    meta: {
      expiryFileName: '',
      expiryUploadedAt: '',
      expiryReportDate: '',
      expiryRowCount: 0,
      masterFileName: '',
      masterUploadedAt: '',
      masterRowCount: 0,
      lastCloudSyncAt: '',
    },
    // UI 狀態
    activeFilter: 'todo', // todo | expired | urgent | near | labeled | near_all | removed | all | archived
    searchQuery: '',
    sortBy: 'expiry_asc',
    renderLimit: PAGE_SIZE,
    selectedKeys: new Set(),
    editingKey: null,
    computedAll: [],      // 通過基礎/設定過濾後的所有效期資料
    filteredRows: [],     // 目前畫面上應顯示的資料
    stats: {
      total: 0,
      todo: 0,
      expired: 0,
      expiredUnremoved: 0,
      urgent: 0,
      urgentUnremoved: 0,
      near: 0,
      nearUnlabeled: 0,
      labeledActive: 0,
      removedActive: 0,
      excludedCount: 0,
    },
    cloudPushTimer: null,
  };

  // ===========================================================================
  // 3. IndexedDB 儲存層
  // ===========================================================================
  const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function dbGet(key) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readonly');
      const req = tx.objectStore(STORE_KV).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbSet(key, val) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      const req = tx.objectStore(STORE_KV).put(val, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function loadAllFromDB() {
    try {
      const [settings, expiryRows, masterMap, actionLogs, meta] = await Promise.all([
        dbGet('settings'),
        dbGet('expiryRows'),
        dbGet('masterMap'),
        dbGet('actionLogs'),
        dbGet('meta'),
      ]);
      if (settings) state.settings = { ...DEFAULT_SETTINGS, ...settings };
      if (Array.isArray(expiryRows)) state.expiryRows = expiryRows;
      if (masterMap && typeof masterMap === 'object') state.masterMap = masterMap;
      if (actionLogs && typeof actionLogs === 'object') state.actionLogs = actionLogs;
      if (meta && typeof meta === 'object') state.meta = { ...state.meta, ...meta };
    } catch (err) {
      console.error('IndexedDB load error:', err);
      showToast('讀取本機資料庫失敗，將以預設狀態啟動', 'error');
    }
  }

  async function saveSettings() {
    await dbSet('settings', state.settings);
    scheduleCloudPush('settings');
  }

  async function saveActionLogs() {
    await dbSet('actionLogs', state.actionLogs);
    scheduleCloudPush('logs');
  }

  // ===========================================================================
  // 4. 工具函式 (清理、日期、數字、Key)
  // ===========================================================================
  function cleanText(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/\u3000/g, ' ')
      .replace(/\u00A0/g, ' ')
      .replace(/^=/, '')
      .replace(/"/g, '')
      .trim();
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function makeItemKey(code, lot, expYmd) {
    const c = cleanText(code).toUpperCase();
    const l = cleanText(lot).toUpperCase() || 'NOLOT';
    const d = String(expYmd || '').replace(/\D/g, '');
    return `${c}__${l}__${d}`;
  }

  function parseStockNumber(v) {
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    let s = cleanText(v).replace(/,/g, '');
    if (!s) return 0;
    if (s.endsWith('.')) s = s.slice(0, -1);
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 智慧解析日期：支援
   *  - 西元 8 碼 (20290326)
   *  - 民國 7 碼 (1150630) / 6 碼 (991231)
   *  - Excel 序列數字 (如 46285)
   *  - 標準字串 (2026/12/04, 2026-12-04)
   * 回傳 { ymd: 'YYYYMMDD', iso: 'YYYY-MM-DD', display: 'YYYY/MM/DD', utcMs: number } 或 null
   */
  function parseFlexibleDate(v) {
    if (v === null || v === undefined || v === '') return null;

    let y = 0, m = 0, d = 0;

    // Excel 序列日期 (一般介於 20000 ~ 73050，約 1954 ~ 2100 年)
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v >= 20000 && v <= 80000) {
        const utcDays = Math.floor(v) - 25569;
        const dt = new Date(utcDays * 86400 * 1000);
        y = dt.getUTCFullYear();
        m = dt.getUTCMonth() + 1;
        d = dt.getUTCDate();
      } else {
        return parseFlexibleDate(String(Math.trunc(v)));
      }
    } else if (v instanceof Date && !Number.isNaN(v.getTime())) {
      y = v.getFullYear();
      m = v.getMonth() + 1;
      d = v.getDate();
    } else {
      const raw = cleanText(v);
      if (!raw) return null;

      // 嘗試標準 YYYY/MM/DD 或 YYYY-MM-DD 或 YYY/MM/DD
      const sepMatch = raw.match(/^(\d{2,4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
      if (sepMatch) {
        y = parseInt(sepMatch[1], 10);
        m = parseInt(sepMatch[2], 10);
        d = parseInt(sepMatch[3], 10);
        if (y < 1911) y += 1911;
      } else {
        const digits = raw.replace(/[\/\-\.\s]/g, '');
        if (!/^\d+$/.test(digits)) return null;
        if (digits.length === 8) {
          y = parseInt(digits.slice(0, 4), 10);
          m = parseInt(digits.slice(4, 6), 10);
          d = parseInt(digits.slice(6, 8), 10);
        } else if (digits.length === 7) {
          y = parseInt(digits.slice(0, 3), 10) + 1911;
          m = parseInt(digits.slice(3, 5), 10);
          d = parseInt(digits.slice(5, 7), 10);
        } else if (digits.length === 6) {
          y = parseInt(digits.slice(0, 2), 10) + 1911;
          m = parseInt(digits.slice(2, 4), 10);
          d = parseInt(digits.slice(4, 6), 10);
        } else if (digits.length === 5 && Number(digits) >= 20000 && Number(digits) <= 80000) {
          return parseFlexibleDate(Number(digits));
        } else {
          return null;
        }
      }
    }

    if (y < 1912 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const utcMs = Date.UTC(y, m - 1, d);
    const check = new Date(utcMs);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== m || check.getUTCDate() !== d) {
      return null;
    }

    const mm = String(m).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    return {
      ymd: `${y}${mm}${dd}`,
      iso: `${y}-${mm}-${dd}`,
      display: `${y}/${mm}/${dd}`,
      utcMs,
    };
  }

  function getTodayUtcMs() {
    const now = new Date();
    return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function formatNowStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function formatTodayIso() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function diffDaysFromToday(ymd) {
    const parsed = parseFlexibleDate(ymd);
    if (!parsed) return 0;
    return Math.round((parsed.utcMs - getTodayUtcMs()) / 86400000);
  }

  // ===========================================================================
  // 5. 通用 Excel / HTML(.xls) / CSV 解析引擎
  // ===========================================================================

  /**
   * 讀取上傳檔案，自動判斷：
   *   A. 醫院 HIS HTML 偽裝的 .xls (UTF-8 或 Big5)
   *   B. 標準 Excel (.xlsx / .xlsm / 二進位 .xls / .csv) via SheetJS
   * 回傳 { sheets: { [sheetName]: string[][] }, reportDate?: string, isHtmlXls: boolean }
   */
  async function readSpreadsheetFile(file) {
    const buf = await file.arrayBuffer();
    const headBytes = new Uint8Array(buf.slice(0, Math.min(4096, buf.byteLength)));
    const headAscii = new TextDecoder('ascii', { fatal: false }).decode(headBytes).toLowerCase();

    const looksLikeHtml =
      headAscii.includes('<table') ||
      headAscii.includes('<html') ||
      headAscii.includes('<meta') ||
      headAscii.includes('<!doctype');

    if (looksLikeHtml) {
      // 先嘗試 UTF-8，若偵測到 charset=big5 或含大量替換字元則切換 Big5
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      const isBig5Declared = /charset\s*=\s*["']?big5/i.test(headAscii);
      const replacementCount = (text.match(/\uFFFD/g) || []).length;
      if (isBig5Declared || replacementCount > 10) {
        try {
          text = new TextDecoder('big5', { fatal: false }).decode(buf);
        } catch (_) {
          // 瀏覽器若不支援 big5 則維持 utf-8
        }
      }

      // 擷取標題列中的報表日期，如 "日期：2026/11/24 17:25"
      let reportDate = '';
      const dateMatch = text.match(/日期[：:]\s*([0-9]{4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,2}(?:\s+[0-9]{1,2}:[0-9]{2})?)/);
      if (dateMatch) reportDate = dateMatch[1].trim();

      const doc = new DOMParser().parseFromString(text, 'text/html');
      const tables = Array.from(doc.querySelectorAll('table'));
      if (tables.length === 0) {
        throw new Error('偵測為 HTML 格式但找不到任何 <table> 資料表');
      }
      // 取列數最多的主表格
      tables.sort((a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length);
      const mainTable = tables[0];
      const rows = Array.from(mainTable.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th, td')).map((cell) => cleanText(cell.textContent))
      );

      return { sheets: { Sheet1: rows }, reportDate, isHtmlXls: true };
    }

    // 使用 SheetJS 讀取 .xlsx / .xlsm / 二進位 .xls / .csv
    if (typeof XLSX === 'undefined') {
      throw new Error('SheetJS 函式庫尚未載入，請確認網路連線後重試');
    }
    const wb = XLSX.read(buf, { type: 'array', raw: true, cellDates: false });
    const sheets = {};
    let reportDate = '';

    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      sheets[name] = aoa;
      if (!reportDate && aoa.length > 0 && aoa[0][0]) {
        const m = String(aoa[0][0]).match(/日期[：:]\s*([0-9]{4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,2}(?:\s+[0-9]{1,2}:[0-9]{2})?)/);
        if (m) reportDate = m[1].trim();
      }
    }

    return { sheets, reportDate, isHtmlXls: false };
  }

  function findHeaderRow(rows, key1, key2, key2Alt = '') {
    const limit = Math.min(rows.length, 20);
    for (let r = 0; r < limit; r++) {
      const row = rows[r] || [];
      let has1 = false, has2 = false;
      for (let c = 0; c < Math.min(row.length, 30); c++) {
        const val = cleanText(row[c]);
        if (!val) continue;
        if (val.includes(key1)) has1 = true;
        if (val.includes(key2)) has2 = true;
        if (key2Alt && val.includes(key2Alt)) has2 = true;
      }
      if (has1 && has2) return r;
    }
    return -1;
  }

  function findColIndex(headerRow, candidates) {
    // 優先完全符合
    for (const cand of candidates) {
      const idx = headerRow.findIndex((cell) => cleanText(cell).toLowerCase() === cand.toLowerCase());
      if (idx !== -1) return idx;
    }
    // 次之包含比對
    for (const cand of candidates) {
      const idx = headerRow.findIndex((cell) => cleanText(cell).toLowerCase().includes(cand.toLowerCase()));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  /**
   * 解析「效期查詢」資料表
   */
  function parseExpiryRows(aoa) {
    const headerIdx = findHeaderRow(aoa, '藥碼', '效期', '有效日期');
    if (headerIdx === -1) {
      throw new Error('找不到標題列（需同時包含「藥碼」與「效期」或「有效日期」欄位）');
    }
    const header = aoa[headerIdx];
    const colDept = findColIndex(header, ['部門代碼', '儲位代碼', '儲位']);
    const colCode = findColIndex(header, ['藥碼']);
    const colName = findColIndex(header, ['藥名', '藥品名稱']);
    const colLot = findColIndex(header, ['批號']);
    const colDate = findColIndex(header, ['效期', '有效日期']);
    const colStock = findColIndex(header, ['庫存量', '現有庫存', '庫存']);

    if (colCode === -1 || colDate === -1) {
      throw new Error('缺少必要欄位「藥碼」或「效期」');
    }

    const parsed = [];
    let skippedBadDate = 0;
    let dateCorruptedCodes = 0;

    for (let r = headerIdx + 1; r < aoa.length; r++) {
      const row = aoa[r];
      if (!row || row.length === 0) continue;
      let code = cleanText(row[colCode]);
      if (!code || code === '藥碼') continue;

      // 偵測是否為被 Excel 轉成日期序號的異常藥碼 (例如 JUL01 -> 46204)
      if (/^\d{5}$/.test(code) && Number(code) >= 40000 && Number(code) <= 55000) {
        dateCorruptedCodes++;
      }

      const dt = parseFlexibleDate(row[colDate]);
      if (!dt) {
        skippedBadDate++;
        continue;
      }

      const name = colName !== -1 ? cleanText(row[colName]) : '';
      const dept = colDept !== -1 ? cleanText(row[colDept]) : '';
      const lot = colLot !== -1 ? cleanText(row[colLot]) : '';
      const stock = colStock !== -1 ? parseStockNumber(row[colStock]) : 0;

      parsed.push({
        code: code.toUpperCase(),
        name,
        stock,
        dept,
        lot,
        expYmd: dt.ymd,
        expStr: dt.display,
      });
    }

    return { rows: parsed, skippedBadDate, dateCorruptedCodes };
  }

  /**
   * 解析「基本檔清單」資料表 -> 精簡壓縮物件，大幅減少儲存與同步體積
   */
  function parseMasterRows(aoa) {
    let headerIdx = findHeaderRow(aoa, '藥碼', '調劑特性', '使用註記');
    if (headerIdx === -1) {
      headerIdx = findHeaderRow(aoa, '藥碼', '商品名', '螢幕顯示用藥名');
    }
    if (headerIdx === -1) {
      throw new Error('找不到基本檔標題列（需包含「藥碼」與「使用註記」或「藥品調劑特性」欄位）');
    }

    const header = aoa[headerIdx];
    const colCode = findColIndex(header, ['藥碼']);
    const colName = findColIndex(header, ['螢幕顯示用藥名(MDP)', '商品名', '藥品名稱']);
    const colUnit = findColIndex(header, ['配出數量之最小單位', '最小單位', '單位']);
    const colNote = findColIndex(header, ['使用註記']);
    const colProp = findColIndex(header, ['藥品調劑特性', '調劑特性']);

    if (colCode === -1) throw new Error('基本檔缺少「藥碼」欄位');

    const map = {};
    let count = 0;
    let countNoteS = 0;
    let countPropRG = 0;

    for (let r = headerIdx + 1; r < aoa.length; r++) {
      const row = aoa[r];
      if (!row || row.length === 0) continue;
      const code = cleanText(row[colCode]).toUpperCase();
      if (!code || code === '藥碼') continue;

      const name = colName !== -1 ? cleanText(row[colName]) : '';
      const unit = colUnit !== -1 ? cleanText(row[colUnit]) : '';
      const note = colNote !== -1 ? cleanText(row[colNote]).toUpperCase() : '';
      const prop = colProp !== -1 ? cleanText(row[colProp]).toUpperCase() : '';

      const isS = note === 'S' ? 1 : 0;
      const isRG = prop === 'UDDCLRG' ? 1 : 0;
      if (isS) countNoteS++;
      if (isRG) countPropRG++;

      map[code] = { n: name, u: unit, s: isS, r: isRG };
      count++;
    }

    return { map, count, countNoteS, countPropRG };
  }

  // ===========================================================================
  // 6. 匯入處理流程（含三層保留與智慧差異摘要 Diff）
  // ===========================================================================
  async function handleImportExpiry(file) {
    try {
      const { sheets, reportDate, isHtmlXls } = await readSpreadsheetFile(file);
      // 優先尋找名為「效期查詢貼這裡」的工作表，否則取第一張
      const targetName = Object.keys(sheets).find((n) => n.includes('效期查詢')) || Object.keys(sheets)[0];
      const { rows, skippedBadDate, dateCorruptedCodes } = parseExpiryRows(sheets[targetName]);

      if (rows.length === 0) {
        throw new Error('解析結果為 0 筆，請確認上傳的是否為效期查詢檔案');
      }

      // 計算與舊檔的差異 (Diff) 與既有紀錄繼承數
      const oldKeySet = new Set(state.expiryRows.map((x) => makeItemKey(x.code, x.lot, x.expYmd)));
      const newKeySet = new Set(rows.map((x) => makeItemKey(x.code, x.lot, x.expYmd)));
      let addedCount = 0;
      let depletedCount = 0;
      let inheritedLogs = 0;

      if (oldKeySet.size > 0) {
        for (const k of newKeySet) if (!oldKeySet.has(k)) addedCount++;
        for (const k of oldKeySet) if (!newKeySet.has(k)) depletedCount++;
      }
      for (const k of newKeySet) {
        const log = state.actionLogs[k];
        if (log && (log.labeled || log.removed || log.note)) inheritedLogs++;
      }

      state.expiryRows = rows;
      state.meta.expiryFileName = file.name;
      state.meta.expiryUploadedAt = new Date().toISOString();
      state.meta.expiryReportDate = reportDate || '';
      state.meta.expiryRowCount = rows.length;

      await Promise.all([dbSet('expiryRows', state.expiryRows), dbSet('meta', state.meta)]);

      const notes = [
        `成功匯入 <b>${rows.length.toLocaleString()}</b> 筆效期資料（格式：${isHtmlXls ? '醫院 HIS 原生 .xls' : 'Excel / CSV'}）`,
      ];
      if (reportDate) notes.push(`報表匯出時間：<b>${escapeHtml(reportDate)}</b>`);
      if (oldKeySet.size > 0) {
        notes.push(`版本比對：新增 <b class="text-sky-600">+${addedCount}</b> 批、已耗盡消失 <b class="text-slate-500">-${depletedCount}</b> 批`);
      }
      if (inheritedLogs > 0) {
        notes.push(`已無縫繼承 <b class="text-emerald-600">${inheritedLogs}</b> 筆既有貼標/下架紀錄`);
      }
      if (skippedBadDate > 0) notes.push(`略過 ${skippedBadDate} 筆無效日期列`);
      if (dateCorruptedCodes > 0) {
        notes.push(`<span class="text-amber-600 font-bold">⚠️ 偵測到 ${dateCorruptedCodes} 筆藥碼呈現 5 位純數字（可能被 Excel 誤轉為日期如 JUL01→46204），建議直接上傳庫存系統匯出的原始 .xls！</span>`);
      }

      showImportResult('success', '效期查詢資料更新完成', notes);
      showToast(`已更新效期資料 (${rows.length} 筆)`, 'success');

      recomputeAndRender();
      scheduleCloudPush('all');
    } catch (err) {
      console.error(err);
      showImportResult('error', '匯入效期資料失敗', [escapeHtml(err.message)]);
      showToast('匯入效期資料失敗', 'error');
    }
  }

  async function handleImportMaster(file) {
    try {
      const { sheets } = await readSpreadsheetFile(file);
      const targetName = Object.keys(sheets).find((n) => n.includes('基本檔')) || Object.keys(sheets)[0];
      const { map, count, countNoteS, countPropRG } = parseMasterRows(sheets[targetName]);

      if (count === 0) throw new Error('基本檔解析結果為 0 筆');

      state.masterMap = map;
      state.meta.masterFileName = file.name;
      state.meta.masterUploadedAt = new Date().toISOString();
      state.meta.masterRowCount = count;

      await Promise.all([dbSet('masterMap', state.masterMap), dbSet('meta', state.meta)]);

      showImportResult('success', '藥品基本檔更新完成', [
        `成功建立 <b>${count.toLocaleString()}</b> 筆基本檔藥碼索引`,
        `其中含停用註記 (S)：<b>${countNoteS.toLocaleString()}</b> 筆、試劑/非處方 (UDDCLRG)：<b>${countPropRG.toLocaleString()}</b> 筆`,
        `既有貼標/下架紀錄與排除清單完全保留不受影響`,
      ]);
      showToast(`已更新基本檔 (${count.toLocaleString()} 筆)`, 'success');

      recomputeAndRender();
      scheduleCloudPush('all');
    } catch (err) {
      console.error(err);
      showImportResult('error', '匯入基本檔失敗', [escapeHtml(err.message)]);
      showToast('匯入基本檔失敗', 'error');
    }
  }

  async function handleImportXlsmBoth(file) {
    try {
      const { sheets, reportDate } = await readSpreadsheetFile(file);
      const expSheetName = Object.keys(sheets).find((n) => n.includes('效期查詢'));
      const masSheetName = Object.keys(sheets).find((n) => n.includes('基本檔'));

      if (!expSheetName && !masSheetName) {
        throw new Error('此活頁簿中找不到「效期查詢貼這裡」或「基本檔清單貼這裡」工作表');
      }

      const msgs = [];
      if (masSheetName) {
        const { map, count, countNoteS, countPropRG } = parseMasterRows(sheets[masSheetName]);
        state.masterMap = map;
        state.meta.masterFileName = `${file.name} (${masSheetName})`;
        state.meta.masterUploadedAt = new Date().toISOString();
        state.meta.masterRowCount = count;
        await dbSet('masterMap', state.masterMap);
        msgs.push(`基本檔：匯入 <b>${count.toLocaleString()}</b> 筆（S=${countNoteS}、UDDCLRG=${countPropRG}）`);
      }

      if (expSheetName) {
        const { rows, dateCorruptedCodes } = parseExpiryRows(sheets[expSheetName]);
        state.expiryRows = rows;
        state.meta.expiryFileName = `${file.name} (${expSheetName})`;
        state.meta.expiryUploadedAt = new Date().toISOString();
        state.meta.expiryReportDate = reportDate || '';
        state.meta.expiryRowCount = rows.length;
        await dbSet('expiryRows', state.expiryRows);
        msgs.push(`效期清單：匯入 <b>${rows.length.toLocaleString()}</b> 筆`);
        if (dateCorruptedCodes > 0) {
          msgs.push(`<span class="text-amber-600 font-bold">💡 提示：舊 .xlsm 內含 ${dateCorruptedCodes} 筆已被 Excel 轉成日期的藥碼，之後改直接上傳庫存系統原始 .xls 即可徹底避免！</span>`);
        }
      }

      await dbSet('meta', state.meta);
      showImportResult('success', '舊版 .xlsm 一鍵匯入完成', msgs);
      showToast('已從舊版 .xlsm 匯入完成', 'success');
      recomputeAndRender();
      scheduleCloudPush('all');
    } catch (err) {
      console.error(err);
      showImportResult('error', '匯入 .xlsm 失敗', [escapeHtml(err.message)]);
      showToast('匯入 .xlsm 失敗', 'error');
    }
  }

  function showImportResult(type, title, lines) {
    const box = document.getElementById('importResultBox');
    box.classList.remove('hidden', 'bg-emerald-50', 'border-emerald-200', 'text-emerald-900', 'dark:bg-emerald-950/40', 'dark:border-emerald-800', 'dark:text-emerald-200', 'bg-rose-50', 'border-rose-200', 'text-rose-900', 'dark:bg-rose-950/40', 'dark:border-rose-800', 'dark:text-rose-200');
    if (type === 'success') {
      box.classList.add('bg-emerald-50', 'border-emerald-200', 'text-emerald-900', 'dark:bg-emerald-950/40', 'dark:border-emerald-800', 'dark:text-emerald-200');
    } else {
      box.classList.add('bg-rose-50', 'border-rose-200', 'text-rose-900', 'dark:bg-rose-950/40', 'dark:border-rose-800', 'dark:text-rose-200');
    }
    box.innerHTML = `<div class="font-extrabold">${title}</div><ul class="list-disc pl-4 space-y-0.5">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
    updateImportModalMeta();
  }

  // ===========================================================================
  // 7. 核心篩選、狀態判定與自動整理引擎
  // ===========================================================================
  function recomputeAndRender() {
    const s = state.settings;
    const cutoffParsed = parseFlexibleDate(s.cutoffDate);
    const cutoffMs = cutoffParsed ? cutoffParsed.utcMs : 0;
    const todayMs = getTodayUtcMs();
    const excludedSet = new Set((s.excludedCodes || []).map((c) => c.toUpperCase()));

    const out = [];
    const stats = {
      total: 0,
      todo: 0,
      expired: 0,
      expiredUnremoved: 0,
      urgent: 0,
      urgentUnremoved: 0,
      near: 0,
      nearUnlabeled: 0,
      labeledActive: 0,
      removedActive: 0,
      excludedCount: 0,
    };

    for (const row of state.expiryRows) {
      const code = row.code;

      // 1. 排除特定藥碼 (疫苗/雜訊黑名單)
      if (excludedSet.has(code)) {
        stats.excludedCount++;
        continue;
      }

      // 2. 自動排除批號含 -CDC
      if (s.autoExcludeCDC && row.lot.toUpperCase().includes('-CDC')) {
        stats.excludedCount++;
        continue;
      }

      // 3. 基本檔過濾規則 (使用註記=S 或 調劑特性=UDDCLRG)
      const master = state.masterMap[code];
      let drugName = row.name;
      let unit = '';
      if (master) {
        if (!drugName && master.n) drugName = master.n;
        unit = master.u || '';
        if ((s.excludeNoteS && master.s === 1) || (s.excludePropRG && master.r === 1)) {
          stats.excludedCount++;
          continue;
        }
      }

      // 4. 排除庫存 <= 0
      if (s.excludeZeroStock && row.stock <= 0) continue;

      // 5. 解析效期 & 排除基準日期之前者
      const expParsed = parseFlexibleDate(row.expYmd);
      if (!expParsed) continue;
      if (cutoffMs && expParsed.utcMs < cutoffMs) continue;

      // 6. 動態計算距離今天之剩餘天數
      const remainDays = Math.round((expParsed.utcMs - todayMs) / 86400000);

      // 7. 顯示已過期開關 & 預警天數上限
      if (!s.showExpired && remainDays < 0) continue;
      if (s.maxAlertDays > 0 && remainDays > s.maxAlertDays) continue;

      // 8. 關聯永久作業紀錄 (貼標 / 下架 / 備註)
      const key = makeItemKey(code, row.lot, row.expYmd);
      const log = state.actionLogs[key] || { labeled: false, removed: false, note: '', operator: '', labeledAt: '', removedAt: '' };

      // 9. 判定效期等級與待辦優先權
      let tier = 'normal'; // expired | urgent | near | watch | normal
      let statusLabel = '';
      if (remainDays < 0) {
        tier = 'expired';
        statusLabel = `已過期 (${Math.abs(remainDays)}天)`;
      } else if (remainDays <= s.urgentDays) {
        tier = 'urgent';
        statusLabel = `緊急 (${s.urgentDays}天內)`;
      } else if (remainDays <= s.nearDays) {
        tier = 'near';
        statusLabel = `近效期 (${s.urgentDays + 1}~${s.nearDays}天)`;
      } else if (remainDays <= s.watchDays) {
        tier = 'watch';
        statusLabel = `注意 (${s.nearDays + 1}~${s.watchDays}天)`;
      } else {
        tier = 'normal';
        statusLabel = `正常 (>${s.watchDays}天)`;
      }

      // 兩段式防漏核心邏輯：
      // - needsRemoval: 已過期或進入緊急門檻，且尚未下架 (即使已貼標也會升級警示！)
      // - needsLabel: 進入近效期門檻，且尚未貼標也尚未下架
      const needsRemoval = !log.removed && remainDays <= s.urgentDays;
      const needsLabel = !log.removed && !log.labeled && remainDays > s.urgentDays && remainDays <= s.nearDays;
      const isTodo = needsRemoval || needsLabel;
      const isEscalatedRemoval = needsRemoval && log.labeled; // 已貼標但屆期尚未下架！

      // 優先級分數 (數字越小越優先)
      let priorityScore = 50;
      if (remainDays < 0 && !log.removed) priorityScore = 1;
      else if (isEscalatedRemoval) priorityScore = 2;
      else if (needsRemoval) priorityScore = 3;
      else if (needsLabel) priorityScore = 4;
      else if (log.labeled && !log.removed) priorityScore = 20;
      else if (log.removed) priorityScore = 90;

      // 累計統計
      stats.total++;
      if (isTodo) stats.todo++;
      if (tier === 'expired') {
        stats.expired++;
        if (!log.removed) stats.expiredUnremoved++;
      } else if (tier === 'urgent') {
        stats.urgent++;
        if (!log.removed) stats.urgentUnremoved++;
      } else if (tier === 'near') {
        stats.near++;
        if (!log.labeled && !log.removed) stats.nearUnlabeled++;
      }
      if (log.labeled && !log.removed) stats.labeledActive++;
      if (log.removed) stats.removedActive++;

      out.push({
        key,
        code,
        name: drugName,
        unit,
        stock: row.stock,
        dept: row.dept,
        lot: row.lot,
        expYmd: row.expYmd,
        expStr: expParsed.display,
        expMs: expParsed.utcMs,
        remainDays,
        tier,
        statusLabel,
        log,
        needsRemoval,
        needsLabel,
        isTodo,
        isEscalatedRemoval,
        priorityScore,
      });
    }

    state.computedAll = out;
    state.stats = stats;

    // 清理已不存在於清單中的勾選
    const validKeySet = new Set(out.map((r) => r.key));
    for (const k of state.selectedKeys) {
      if (!validKeySet.has(k)) state.selectedKeys.delete(k);
    }

    applyViewFilterAndSort();
    renderHeaderAndKpis();
    renderTable();
    renderBatchBar();
  }

  function applyViewFilterAndSort() {
    const f = state.activeFilter;
    const s = state.settings;
    const q = state.searchQuery.trim().toLowerCase();

    let rows = [];

    if (f === 'archived') {
      // 歷史封存：存在於 actionLogs 但已不在最新效期檔中的批號
      const currentKeys = new Set(state.expiryRows.map((r) => makeItemKey(r.code, r.lot, r.expYmd)));
      for (const [key, log] of Object.entries(state.actionLogs)) {
        if (currentKeys.has(key)) continue;
        if (!log.labeled && !log.removed && !log.note) continue;
        const expParsed = parseFlexibleDate(log.expYmd);
        const remainDays = expParsed ? diffDaysFromToday(log.expYmd) : 0;
        rows.push({
          key,
          code: log.code || key.split('__')[0],
          name: log.name || '(已耗盡/移除之歷史批號)',
          unit: '',
          stock: 0,
          dept: log.dept || '-',
          lot: log.lot || key.split('__')[1],
          expYmd: log.expYmd || '',
          expStr: expParsed ? expParsed.display : log.expYmd || '-',
          expMs: expParsed ? expParsed.utcMs : 0,
          remainDays,
          tier: 'archived',
          statusLabel: '已耗盡封存',
          log,
          isArchived: true,
          priorityScore: 99,
        });
      }
    } else {
      rows = state.computedAll.filter((item) => {
        // 隱藏已下架選項（在 removed 與 archived 視圖不套用）
        if (s.hideRemoved && f !== 'removed' && item.log.removed) return false;

        switch (f) {
          case 'todo': return item.isTodo;
          case 'expired': return item.tier === 'expired';
          case 'urgent': return item.tier === 'urgent';
          case 'near': return item.tier === 'near';
          case 'labeled': return item.log.labeled && !item.log.removed;
          case 'near_all': return item.remainDays <= s.watchDays;
          case 'removed': return item.log.removed;
          case 'all':
          default: return true;
        }
      });
    }

    // 關鍵字搜尋
    if (q) {
      rows = rows.filter((item) => {
        const hay = `${item.code} ${item.name} ${item.lot} ${item.dept} ${item.log?.note || ''} ${item.log?.operator || ''}`.toLowerCase();
        return hay.includes(q);
      });
    }

    // 排序
    const sortBy = state.sortBy;
    rows.sort((a, b) => {
      if (sortBy === 'expiry_asc') return a.expMs - b.expMs || a.code.localeCompare(b.code);
      if (sortBy === 'expiry_desc') return b.expMs - a.expMs || a.code.localeCompare(b.code);
      if (sortBy === 'code_asc') return a.code.localeCompare(b.code) || a.expMs - b.expMs;
      if (sortBy === 'stock_desc') return b.stock - a.stock || a.expMs - b.expMs;
      if (sortBy === 'priority') return a.priorityScore - b.priorityScore || a.expMs - b.expMs;
      return a.expMs - b.expMs;
    });

    state.filteredRows = rows;
  }

  // ===========================================================================
  // 8. 畫面渲染 (Header, KPIs, Table, Badges)
  // ===========================================================================
  function renderHeaderAndKpis() {
    const hasData = state.expiryRows.length > 0;
    document.getElementById('emptyWelcomeCard').classList.toggle('hidden', hasData);
    document.getElementById('dashboardContent').classList.toggle('hidden', !hasData);

    // Header 狀態摘要
    const headerStatus = document.getElementById('headerDataStatus');
    if (!hasData) {
      headerStatus.innerHTML = '<span>尚未匯入效期資料 · 請點擊右上角「匯入 Excel」</span>';
    } else {
      const expTime = state.meta.expiryReportDate || (state.meta.expiryUploadedAt ? state.meta.expiryUploadedAt.slice(0, 10) : '');
      const masText = state.meta.masterRowCount > 0 ? `基本檔 ${state.meta.masterRowCount.toLocaleString()} 筆` : '⚠️ 尚未匯入基本檔';
      headerStatus.innerHTML = `
        <span>效期快照：<b>${escapeHtml(expTime)}</b> (${state.expiryRows.length.toLocaleString()} 筆)</span>
        <span class="text-slate-300 dark:text-slate-600">|</span>
        <span>${masText}</span>
      `;
    }

    // 資料過舊提醒 (超過 30 天未重新匯入)
    const staleBanner = document.getElementById('staleDataBanner');
    if (hasData && state.meta.expiryUploadedAt) {
      const uploadedMs = new Date(state.meta.expiryUploadedAt).getTime();
      const daysSince = Math.floor((Date.now() - uploadedMs) / 86400000);
      if (daysSince >= 30) {
        staleBanner.classList.remove('hidden');
        document.getElementById('staleDataText').textContent =
          `提醒：距離上次匯入效期查詢檔已過 ${daysSince} 天（剩餘天數仍會每日自動倒數，但建議定期重新匯出以納入新到貨批號）。`;
      } else {
        staleBanner.classList.add('hidden');
      }
    } else {
      staleBanner.classList.add('hidden');
    }

    // 排除藥碼徽章
    const exclLen = (state.settings.excludedCodes || []).length;
    const badge = document.getElementById('excludedCountBadge');
    badge.textContent = exclLen;
    badge.classList.toggle('hidden', exclLen === 0);

    // KPI 數值
    const st = state.stats;
    const s = state.settings;
    document.getElementById('kpiTodo').textContent = st.todo.toLocaleString();
    document.getElementById('kpiTodoSub').textContent = st.todo > 0 ? `未下架 ${st.expiredUnremoved + st.urgentUnremoved} · 未貼標 ${st.nearUnlabeled}` : '目前待辦已全部完成 🎉';

    document.getElementById('kpiExpired').textContent = st.expired.toLocaleString();
    document.getElementById('kpiExpiredSub').textContent = `未下架 ${st.expiredUnremoved} 筆`;

    document.getElementById('kpiUrgentTitle').textContent = `緊急 (≤${s.urgentDays}天)`;
    document.getElementById('kpiUrgent').textContent = st.urgent.toLocaleString();
    document.getElementById('kpiUrgentSub').textContent = `未下架 ${st.urgentUnremoved} 筆`;

    document.getElementById('kpiNearTitle').textContent = `近效期 (${s.urgentDays + 1}~${s.nearDays}天)`;
    document.getElementById('kpiNear').textContent = st.near.toLocaleString();
    document.getElementById('kpiNearSub').textContent = `未貼標 ${st.nearUnlabeled} 筆`;

    document.getElementById('kpiLabeled').textContent = st.labeledActive.toLocaleString();
    document.getElementById('kpiTotal').textContent = st.total.toLocaleString();
    document.getElementById('kpiRemovedSub').textContent = `已下架 ${st.removedActive} 筆`;

    // 高亮目前選中的 KPI 卡與分頁籤
    document.querySelectorAll('.kpi-card').forEach((card) => {
      const active = card.dataset.kpi === state.activeFilter;
      card.classList.toggle('border-2', active);
      card.classList.toggle('border-sky-500', active);
      card.classList.toggle('ring-2', active);
      card.classList.toggle('ring-sky-500/20', active);
      card.classList.toggle('border', !active);
      card.classList.toggle('border-slate-200/90', !active);
      card.classList.toggle('dark:border-slate-800', !active);
    });

    document.querySelectorAll('.view-tab').forEach((btn) => {
      const active = btn.dataset.tab === state.activeFilter;
      btn.classList.toggle('bg-white', active);
      btn.classList.toggle('dark:bg-slate-900', active);
      btn.classList.toggle('text-sky-600', active);
      btn.classList.toggle('dark:text-sky-400', active);
      btn.classList.toggle('shadow-sm', active);
      btn.classList.toggle('text-slate-500', !active);
    });

    // 雲端同步狀態燈
    updateCloudStatusPill();
  }

  function renderTable() {
    const tbody = document.getElementById('resultTableBody');
    const emptyEl = document.getElementById('tableEmptyState');
    const paginationBar = document.getElementById('paginationBar');
    const rows = state.filteredRows;

    document.getElementById('tableShowingCount').textContent = rows.length.toLocaleString();

    const filterLabels = {
      todo: '🔥 急需處理待辦（未下架緊急/過期 ＋ 未貼標近效期）',
      expired: '已過期藥品',
      urgent: `緊急（${state.settings.urgentDays}天內）`,
      near: `近效期（${state.settings.urgentDays + 1}~${state.settings.nearDays}天）`,
      labeled: '🏷️ 已貼標追蹤中',
      near_all: `${state.settings.watchDays}天內全部近效期`,
      removed: '📦 已完成下架清單',
      all: '符合條件全部藥品',
      archived: '🗄️ 歷史封存紀錄（已從最新庫存檔消失之批號）',
    };
    document.getElementById('activeFilterHint').textContent = filterLabels[state.activeFilter] || '';

    const exclHint = document.getElementById('excludedSummaryHint');
    if (state.stats.excludedCount > 0 && state.activeFilter !== 'archived') {
      exclHint.textContent = `（已自動排除 ${state.stats.excludedCount} 筆停用/試劑/黑名單品項）`;
      exclHint.classList.remove('hidden');
    } else {
      exclHint.classList.add('hidden');
    }

    if (rows.length === 0) {
      tbody.innerHTML = '';
      emptyEl.classList.remove('hidden');
      paginationBar.classList.add('hidden');
      document.getElementById('tableEmptyTitle').textContent =
        state.activeFilter === 'todo' ? '太棒了！目前沒有急需貼標或下架的待辦藥品' : '目前篩選條件下沒有符合的藥品';
      return;
    }

    emptyEl.classList.add('hidden');
    const slice = rows.slice(0, state.renderLimit);

    const html = slice.map((item) => {
      const checked = state.selectedKeys.has(item.key) ? 'checked' : '';
      const log = item.log || {};

      // 列底色邏輯
      let rowBg = 'hover:bg-slate-50/90 dark:hover:bg-slate-800/60';
      if (log.removed) {
        rowBg = 'bg-emerald-50/40 dark:bg-emerald-950/15 opacity-75 hover:opacity-100';
      } else if (item.tier === 'expired') {
        rowBg = 'bg-rose-50/70 dark:bg-rose-950/25 hover:bg-rose-50 dark:hover:bg-rose-950/40';
      } else if (item.tier === 'urgent') {
        rowBg = 'bg-orange-50/60 dark:bg-orange-950/20 hover:bg-orange-50 dark:hover:bg-orange-950/35';
      }

      // 效期狀態徽章
      let statusBadge = '';
      if (item.isArchived) {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300">已耗盡封存</span>`;
      } else if (item.tier === 'expired') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-600 text-white shadow-xs">${escapeHtml(item.statusLabel)}</span>`;
      } else if (item.tier === 'urgent') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-orange-500 text-white">${escapeHtml(item.statusLabel)}</span>`;
      } else if (item.tier === 'near') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-300 text-amber-950">${escapeHtml(item.statusLabel)}</span>`;
      } else if (item.tier === 'watch') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200">${escapeHtml(item.statusLabel)}</span>`;
      } else {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">${escapeHtml(item.statusLabel)}</span>`;
      }

      // 升級警示：已貼標但已屆下架期
      const escalateTag = item.isEscalatedRemoval
        ? `<div class="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/70 text-rose-700 dark:text-rose-200 text-[10px] font-extrabold animate-pulse">🚨 已貼標，屆期待下架！</div>`
        : '';

      // 剩餘天數顏色
      let daysClass = 'text-slate-600 dark:text-slate-300';
      if (item.remainDays < 0) daysClass = 'text-rose-600 dark:text-rose-400 font-extrabold';
      else if (item.remainDays <= state.settings.urgentDays) daysClass = 'text-orange-600 dark:text-orange-400 font-extrabold';
      else if (item.remainDays <= state.settings.nearDays) daysClass = 'text-amber-600 dark:text-amber-400 font-bold';

      // 貼標 / 下架按鈕樣式
      const labelBtnClass = log.labeled
        ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
        : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:border-indigo-400 hover:text-indigo-600';
      const removeBtnClass = log.removed
        ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
        : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:border-emerald-500 hover:text-emerald-600';

      const noteMeta = [];
      if (log.labeledAt) noteMeta.push(`貼:${log.labeledAt.slice(5)}`);
      if (log.removedAt) noteMeta.push(`下:${log.removedAt.slice(5)}`);
      if (log.operator) noteMeta.push(log.operator);
      const subMetaStr = noteMeta.length > 0 ? noteMeta.join(' · ') : '';

      return `
        <tr class="${rowBg} transition-colors" data-key="${escapeHtml(item.key)}">
          <td class="no-print py-2.5 px-3 text-center">
            <input type="checkbox" class="row-checkbox rounded border-slate-300 dark:border-slate-600 text-sky-600 focus:ring-0 cursor-pointer" data-key="${escapeHtml(item.key)}" ${checked} />
          </td>
          <td class="py-2.5 px-3 font-mono font-bold text-slate-800 dark:text-slate-100 whitespace-nowrap">
            <div class="flex items-center gap-1">
              <span>${escapeHtml(item.code)}</span>
              ${!item.isArchived ? `<button type="button" class="no-print btn-quick-exclude opacity-30 hover:opacity-100 text-slate-400 hover:text-rose-500 p-0.5 rounded transition cursor-pointer" data-code="${escapeHtml(item.code)}" title="永久排除藥碼 ${escapeHtml(item.code)}">✕</button>` : ''}
            </div>
          </td>
          <td class="py-2.5 px-3">
            <div class="font-semibold text-slate-800 dark:text-slate-100 leading-snug">${escapeHtml(item.name)}</div>
            ${log.note ? `<div class="text-[11px] text-sky-700 dark:text-sky-400 mt-0.5 flex items-center gap-1">📝 ${escapeHtml(log.note)}</div>` : ''}
          </td>
          <td class="py-2.5 px-3 text-right font-mono font-bold whitespace-nowrap">
            ${item.isArchived ? '-' : `${item.stock.toLocaleString()}${item.unit ? `<span class="text-[10px] font-sans font-normal text-slate-400 ml-0.5">${escapeHtml(item.unit)}</span>` : ''}`}
          </td>
          <td class="py-2.5 px-3 text-slate-500 dark:text-slate-400 whitespace-nowrap text-xs">${escapeHtml(item.dept)}</td>
          <td class="py-2.5 px-3 font-mono text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">${escapeHtml(item.lot || '-')}</td>
          <td class="py-2.5 px-3 text-center font-mono font-semibold whitespace-nowrap ${item.tier === 'expired' ? 'text-rose-600 dark:text-rose-400' : ''}">${escapeHtml(item.expStr)}</td>
          <td class="py-2.5 px-3 text-right font-mono whitespace-nowrap ${daysClass}">${item.isArchived ? '-' : item.remainDays.toLocaleString()}</td>
          <td class="py-2.5 px-3 text-center whitespace-nowrap">
            <div>${statusBadge}</div>
            ${escalateTag}
          </td>
          <td class="no-print py-2.5 px-3 text-center whitespace-nowrap">
            <div class="flex items-center justify-center gap-1.5">
              <button type="button" class="btn-toggle-label px-2.5 py-1 rounded-lg border text-[11px] font-bold transition cursor-pointer ${labelBtnClass}" data-key="${escapeHtml(item.key)}" title="點擊切換貼標狀態">
                ${log.labeled ? '✓ 已貼標' : '🏷️ 貼標'}
              </button>
              <button type="button" class="btn-toggle-remove px-2.5 py-1 rounded-lg border text-[11px] font-bold transition cursor-pointer ${removeBtnClass}" data-key="${escapeHtml(item.key)}" title="點擊切換下架狀態">
                ${log.removed ? '✓ 已下架' : '📦 下架'}
              </button>
              <button type="button" class="btn-open-note p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 transition cursor-pointer" data-key="${escapeHtml(item.key)}" title="編輯備註與查看同藥批號">
                <i data-lucide="message-square-plus" class="w-3.5 h-3.5"></i>
              </button>
            </div>
            ${subMetaStr ? `<div class="text-[10px] text-slate-400 mt-0.5 font-mono">${escapeHtml(subMetaStr)}</div>` : ''}
          </td>
          <td class="print-checkbox-col text-center">${log.labeled ? '☑' : '☐'}</td>
          <td class="print-checkbox-col text-center">${log.removed ? '☑' : '☐'}</td>
          <td class="print-checkbox-col text-left">${escapeHtml(log.note || '')}</td>
        </tr>
      `;
    }).join('');

    tbody.innerHTML = html;
    lucide.createIcons({ nodes: [tbody] });

    // 分頁控制
    if (rows.length > slice.length) {
      paginationBar.classList.remove('hidden');
      document.getElementById('paginationInfo').textContent = `已顯示 ${slice.length.toLocaleString()} / ${rows.length.toLocaleString()} 筆`;
    } else {
      paginationBar.classList.add('hidden');
    }

    // 同步全選核取方塊
    const allSelected = slice.length > 0 && slice.every((r) => state.selectedKeys.has(r.key));
    document.getElementById('chkSelectAll').checked = allSelected;
  }

  function renderBatchBar() {
    const count = state.selectedKeys.size;
    const bar = document.getElementById('batchActionBar');
    bar.classList.toggle('hidden', count === 0);
    document.getElementById('batchSelectedCount').textContent = `已選 ${count} 筆`;
  }

  // ===========================================================================
  // 9. 作業註記操作 (貼標 / 下架 / 備註 / 批次 / 排除藥碼)
  // ===========================================================================
  function findItemByKey(key) {
    return (
      state.computedAll.find((x) => x.key === key) ||
      state.filteredRows.find((x) => x.key === key) ||
      null
    );
  }

  async function toggleRowAction(key, field) {
    const item = findItemByKey(key);
    const existing = state.actionLogs[key] || {
      key,
      code: item ? item.code : key.split('__')[0],
      name: item ? item.name : '',
      lot: item ? item.lot : key.split('__')[1],
      expYmd: item ? item.expYmd : key.split('__')[2],
      dept: item ? item.dept : '',
      labeled: false,
      labeledAt: '',
      removed: false,
      removedAt: '',
      note: '',
      operator: '',
      updatedAt: '',
    };

    const today = formatTodayIso();
    const op = state.settings.operatorName || existing.operator || '';

    if (field === 'labeled') {
      existing.labeled = !existing.labeled;
      existing.labeledAt = existing.labeled ? today : '';
    } else if (field === 'removed') {
      existing.removed = !existing.removed;
      existing.removedAt = existing.removed ? today : '';
    }
    if (op) existing.operator = op;
    existing.updatedAt = new Date().toISOString();
    if (item) {
      existing.name = item.name;
      existing.dept = item.dept;
    }

    state.actionLogs[key] = existing;
    await saveActionLogs();

    const msg =
      field === 'labeled'
        ? `${existing.code} (${existing.lot || '無批號'}) ${existing.labeled ? '已標記「貼標完成」' : '已取消貼標'}`
        : `${existing.code} (${existing.lot || '無批號'}) ${existing.removed ? '已標記「下架完成」' : '已取消下架'}`;
    showToast(msg, 'success');
    recomputeAndRender();
  }

  async function batchApplyAction(field) {
    if (state.selectedKeys.size === 0) return;
    const today = formatTodayIso();
    const op = state.settings.operatorName || '';
    let count = 0;

    for (const key of state.selectedKeys) {
      const item = findItemByKey(key);
      if (!item) continue;
      const existing = state.actionLogs[key] || {
        key,
        code: item.code,
        name: item.name,
        lot: item.lot,
        expYmd: item.expYmd,
        dept: item.dept,
        labeled: false,
        labeledAt: '',
        removed: false,
        removedAt: '',
        note: '',
        operator: '',
        updatedAt: '',
      };
      if (field === 'labeled') {
        existing.labeled = true;
        existing.labeledAt = existing.labeledAt || today;
      } else if (field === 'removed') {
        existing.removed = true;
        existing.removedAt = existing.removedAt || today;
      }
      if (op) existing.operator = op;
      existing.updatedAt = new Date().toISOString();
      state.actionLogs[key] = existing;
      count++;
    }

    state.selectedKeys.clear();
    await saveActionLogs();
    showToast(`已批次標記 ${count} 筆為「${field === 'labeled' ? '已貼標' : '已下架'}」`, 'success');
    recomputeAndRender();
  }

  async function addExcludedCodes(codesArray, silent = false) {
    const cleaned = codesArray
      .map((c) => cleanText(c).toUpperCase())
      .filter((c) => c.length > 0);
    if (cleaned.length === 0) return 0;

    const set = new Set(state.settings.excludedCodes || []);
    let added = 0;
    for (const c of cleaned) {
      if (!set.has(c)) {
        set.add(c);
        added++;
      }
    }
    state.settings.excludedCodes = Array.from(set).sort();
    await saveSettings();
    renderExcludedTags();
    recomputeAndRender();

    if (!silent && added > 0) {
      showToast(`已將 ${cleaned.join(', ')} 加入永久排除清單`, 'info', {
        actionText: '復原',
        onAction: async () => {
          const cur = new Set(state.settings.excludedCodes);
          cleaned.forEach((c) => cur.delete(c));
          state.settings.excludedCodes = Array.from(cur).sort();
          await saveSettings();
          renderExcludedTags();
          recomputeAndRender();
          showToast('已復原排除設定', 'info');
        },
      });
    }
    return added;
  }

  function openNoteModal(key) {
    const item = findItemByKey(key);
    if (!item) return;
    state.editingKey = key;
    const log = state.actionLogs[key] || { labeled: false, removed: false, note: '', operator: '', labeledAt: '', removedAt: '' };

    document.getElementById('noteDrugInfo').innerHTML = `
      <div class="flex items-center justify-between">
        <span class="font-mono font-extrabold text-sm text-sky-700 dark:text-sky-400">${escapeHtml(item.code)}</span>
        <span class="font-mono text-xs text-slate-500">效期 ${escapeHtml(item.expStr)}（剩 ${item.remainDays} 天）</span>
      </div>
      <div class="font-bold text-slate-800 dark:text-slate-100">${escapeHtml(item.name)}</div>
      <div class="text-slate-500 font-mono">批號：${escapeHtml(item.lot || '-')} ｜ 庫存：${item.stock.toLocaleString()} ${escapeHtml(item.unit || '')} ｜ ${escapeHtml(item.dept)}</div>
    `;

    document.getElementById('noteLabeled').checked = !!log.labeled;
    document.getElementById('noteRemoved').checked = !!log.removed;
    document.getElementById('noteLabeledAt').textContent = log.labeledAt ? `貼標日：${log.labeledAt}` : '尚未貼標';
    document.getElementById('noteRemovedAt').textContent = log.removedAt ? `下架日：${log.removedAt}` : '尚未下架';
    document.getElementById('noteText').value = log.note || '';
    document.getElementById('noteOperator').value = log.operator || state.settings.operatorName || '';

    // 查詢同藥碼其他批號供藥師決策參考
    const siblings = state.expiryRows
      .filter((r) => r.code === item.code && makeItemKey(r.code, r.lot, r.expYmd) !== key && r.stock > 0)
      .sort((a, b) => a.expYmd.localeCompare(b.expYmd));

    const sibWrap = document.getElementById('siblingLotsWrap');
    const sibList = document.getElementById('siblingLotsList');
    if (siblings.length > 0) {
      sibWrap.classList.remove('hidden');
      sibList.innerHTML = siblings
        .map((r) => {
          const days = diffDaysFromToday(r.expYmd);
          return `<div class="flex items-center justify-between px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800">
            <span>批號 ${escapeHtml(r.lot || '-')}</span>
            <span>效期 ${escapeHtml(r.expStr)} (${days}天)</span>
            <span class="font-bold">庫存 ${r.stock.toLocaleString()}</span>
          </div>`;
        })
        .join('');
    } else {
      sibWrap.classList.add('hidden');
    }

    openModal('modalNote');
  }

  async function saveNoteModal() {
    const key = state.editingKey;
    if (!key) return;
    const item = findItemByKey(key);
    const prev = state.actionLogs[key] || {};
    const today = formatTodayIso();

    const labeled = document.getElementById('noteLabeled').checked;
    const removed = document.getElementById('noteRemoved').checked;
    const note = document.getElementById('noteText').value.trim();
    const operator = document.getElementById('noteOperator').value.trim();

    state.actionLogs[key] = {
      key,
      code: item ? item.code : prev.code || key.split('__')[0],
      name: item ? item.name : prev.name || '',
      lot: item ? item.lot : prev.lot || key.split('__')[1],
      expYmd: item ? item.expYmd : prev.expYmd || key.split('__')[2],
      dept: item ? item.dept : prev.dept || '',
      labeled,
      labeledAt: labeled ? prev.labeledAt || today : '',
      removed,
      removedAt: removed ? prev.removedAt || today : '',
      note,
      operator,
      updatedAt: new Date().toISOString(),
    };

    await saveActionLogs();
    closeModal('modalNote');
    showToast('已儲存作業註記', 'success');
    recomputeAndRender();
  }

  // ===========================================================================
  // 10. 進階設定 UI 同步 & 智慧疫苗掃描器
  // ===========================================================================
  function syncSettingsUI() {
    const s = state.settings;
    document.getElementById('inputCutoffDate').value = s.cutoffDate;
    document.getElementById('inputOperator').value = s.operatorName || '';
    document.getElementById('chkHideRemoved').checked = !!s.hideRemoved;

    document.getElementById('setMaxAlertDays').value = s.maxAlertDays;
    document.getElementById('setShowExpired').checked = !!s.showExpired;
    document.getElementById('setExcludeZeroStock').checked = !!s.excludeZeroStock;
    document.getElementById('setExcludeNoteS').checked = !!s.excludeNoteS;
    document.getElementById('setExcludePropRG').checked = !!s.excludePropRG;
    document.getElementById('setUrgentDays').value = s.urgentDays;
    document.getElementById('setNearDays').value = s.nearDays;
    document.getElementById('setWatchDays').value = s.watchDays;
    document.getElementById('setAutoExcludeCDC').checked = !!s.autoExcludeCDC;

    document.getElementById('setGasUrl').value = s.gasUrl || '';
    document.getElementById('setGasToken').value = s.gasToken || '';
    document.getElementById('setGasAutoSync').checked = !!s.gasAutoSync;
    document.getElementById('setGasSyncInventory').checked = !!s.gasSyncInventory;

    renderExcludedTags();
    updateImportModalMeta();
  }

  function renderExcludedTags() {
    const list = state.settings.excludedCodes || [];
    document.getElementById('excludedListCount').textContent = list.length;
    const container = document.getElementById('excludedTagsContainer');
    if (list.length === 0) {
      container.innerHTML = `<span class="text-xs text-slate-400">目前尚未設定排除藥碼（可在上方輸入，或在主表格藥碼旁點 ✕ 快速加入）</span>`;
      return;
    }
    container.innerHTML = list
      .map((code) => {
        const drug = state.masterMap[code]?.n || state.expiryRows.find((r) => r.code === code)?.name || '';
        return `
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-mono font-bold text-slate-700 dark:text-slate-200 shadow-2xs" title="${escapeHtml(drug)}">
            <span>${escapeHtml(code)}</span>
            ${drug ? `<span class="font-sans font-normal text-[10px] text-slate-400 max-w-[120px] truncate">${escapeHtml(drug)}</span>` : ''}
            <button type="button" class="btn-remove-excluded text-slate-400 hover:text-rose-500 cursor-pointer" data-code="${escapeHtml(code)}">✕</button>
          </span>
        `;
      })
      .join('');
  }

  function scanPotentialVaccines() {
    const pattern = /疫苗|vac|cdc|公費|疾管|卡介苗|流感|肺炎|水痘|腦炎|猴痘|狂犬|shingrix|gardasil|adacel|rotateq|rotarix|abrysvo|prevenar|pneumovax|paxlovid|veklury|molnupiravir|xocova/i;
    const existingSet = new Set(state.settings.excludedCodes || []);
    const candidates = new Map();

    for (const r of state.expiryRows) {
      if (existingSet.has(r.code)) continue;
      if (pattern.test(r.name) || /-CDC/i.test(r.lot)) {
        if (!candidates.has(r.code)) candidates.set(r.code, r.name);
      }
    }

    const panel = document.getElementById('vaccineScanPanel');
    const listEl = document.getElementById('vaccineScanList');
    panel.classList.remove('hidden');

    if (candidates.size === 0) {
      document.getElementById('vaccineScanTitle').textContent = '未掃描到尚未排除的疑似疫苗 / CDC 公費藥碼';
      listEl.innerHTML = '';
      return;
    }

    document.getElementById('vaccineScanTitle').textContent = `掃描到 ${candidates.size} 個疑似疫苗 / 公費品項（勾選後按加入）：`;
    listEl.innerHTML = Array.from(candidates.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([code, name]) => `
        <label class="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-amber-200/70 dark:border-amber-800/50 cursor-pointer">
          <input type="checkbox" class="chk-scanned-vaccine rounded text-sky-600" value="${escapeHtml(code)}" checked />
          <span class="font-mono font-bold text-slate-800 dark:text-slate-100">${escapeHtml(code)}</span>
          <span class="text-slate-500 truncate">${escapeHtml(name)}</span>
        </label>
      `
      )
      .join('');
  }

  function updateImportModalMeta() {
    document.getElementById('importExpiryCurrentMeta').textContent =
      state.expiryRows.length > 0
        ? `目前：${state.expiryRows.length.toLocaleString()} 筆 (${state.meta.expiryReportDate || state.meta.expiryFileName})`
        : '尚未匯入';
    document.getElementById('importMasterCurrentMeta').textContent =
      state.meta.masterRowCount > 0
        ? `目前：${state.meta.masterRowCount.toLocaleString()} 筆`
        : '尚未匯入';
  }

  // ===========================================================================
  // 11. Google Sheets (Apps Script) 雲端雙向同步
  // ===========================================================================
  function updateCloudStatusPill(syncing = false, errMsg = '') {
    const dot = document.getElementById('cloudStatusDot');
    const txt = document.getElementById('cloudStatusText');
    if (!state.settings.gasUrl) {
      dot.className = 'w-2 h-2 rounded-full bg-slate-400';
      txt.textContent = '單機儲存';
      return;
    }
    if (syncing) {
      dot.className = 'w-2 h-2 rounded-full bg-sky-500 animate-ping';
      txt.textContent = '雲端同步中...';
      return;
    }
    if (errMsg) {
      dot.className = 'w-2 h-2 rounded-full bg-rose-500';
      txt.textContent = '同步異常';
      return;
    }
    dot.className = 'w-2 h-2 rounded-full bg-emerald-500';
    txt.textContent = '雲端已連線';
  }

  function setGasLog(msg, isError = false) {
    const el = document.getElementById('gasSyncLog');
    el.classList.remove('hidden', 'bg-emerald-50', 'text-emerald-800', 'dark:bg-emerald-950/40', 'dark:text-emerald-300', 'bg-rose-50', 'text-rose-800', 'dark:bg-rose-950/40', 'dark:text-rose-300');
    if (isError) el.classList.add('bg-rose-50', 'text-rose-800', 'dark:bg-rose-950/40', 'dark:text-rose-300');
    else el.classList.add('bg-emerald-50', 'text-emerald-800', 'dark:bg-emerald-950/40', 'dark:text-emerald-300');
    el.textContent = `[${formatNowStr()}] ${msg}`;
  }

  async function callGasApi(payload) {
    const url = (state.settings.gasUrl || '').trim();
    if (!url) throw new Error('請先填入 Google Apps Script Web App URL');

    // 使用 text/plain 避開 CORS Preflight (Google Apps Script 標準解法)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, token: state.settings.gasToken || '' }),
      redirect: 'follow',
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error('回傳非 JSON，請確認 Apps Script 部署權限設為「所有人 (Anyone)」');
    }
    if (!json.ok) throw new Error(json.error || '雲端 API 回傳錯誤');
    return json;
  }

  function scheduleCloudPush(scope = 'logs') {
    if (!state.settings.gasUrl) return;
    clearTimeout(state.cloudPushTimer);
    state.cloudPushTimer = setTimeout(() => {
      pushToCloud(scope, true);
    }, 1800);
  }

  async function pullFromCloud(silent = false) {
    if (!state.settings.gasUrl) return;
    updateCloudStatusPill(true);
    try {
      const res = await callGasApi({
        action: 'pull',
        includeInventory: !!state.settings.gasSyncInventory,
      });

      // 合併 Settings (保留本機 gasUrl/gasToken/operatorName)
      if (res.settings && typeof res.settings === 'object') {
        const keepLocal = {
          gasUrl: state.settings.gasUrl,
          gasToken: state.settings.gasToken,
          gasAutoSync: state.settings.gasAutoSync,
          gasSyncInventory: state.settings.gasSyncInventory,
          operatorName: state.settings.operatorName,
        };
        state.settings = { ...DEFAULT_SETTINGS, ...res.settings, ...keepLocal };
        await dbSet('settings', state.settings);
      }

      // 合併 ActionLogs (依 updatedAt 新覆蓋舊，避免互相洗掉)
      let mergedLogsCount = 0;
      if (res.actionLogs && typeof res.actionLogs === 'object') {
        for (const [k, remoteLog] of Object.entries(res.actionLogs)) {
          const localLog = state.actionLogs[k];
          if (!localLog || (remoteLog.updatedAt || '') > (localLog.updatedAt || '')) {
            state.actionLogs[k] = remoteLog;
            mergedLogsCount++;
          }
        }
        await dbSet('actionLogs', state.actionLogs);
      }

      // 合併效期與基本檔 (若雲端有更新版本)
      if (state.settings.gasSyncInventory && Array.isArray(res.expiryRows) && res.expiryRows.length > 0) {
        const remoteTime = res.meta?.expiryUploadedAt || '';
        if (!state.expiryRows.length || remoteTime > (state.meta.expiryUploadedAt || '')) {
          state.expiryRows = res.expiryRows;
          await dbSet('expiryRows', state.expiryRows);
        }
      }
      if (state.settings.gasSyncInventory && res.masterMap && Object.keys(res.masterMap).length > 0) {
        const remoteTime = res.meta?.masterUploadedAt || '';
        if (!Object.keys(state.masterMap).length || remoteTime > (state.meta.masterUploadedAt || '')) {
          state.masterMap = res.masterMap;
          await dbSet('masterMap', state.masterMap);
        }
      }
      if (res.meta) {
        state.meta = { ...state.meta, ...res.meta, lastCloudSyncAt: new Date().toISOString() };
        await dbSet('meta', state.meta);
      }

      syncSettingsUI();
      recomputeAndRender();
      updateCloudStatusPill(false);
      setGasLog(`拉取成功！合併 ${mergedLogsCount} 筆作業紀錄`);
      if (!silent) showToast(`雲端同步完成（更新 ${mergedLogsCount} 筆紀錄）`, 'success');
    } catch (err) {
      console.error('Cloud pull error:', err);
      updateCloudStatusPill(false, err.message);
      setGasLog(`拉取失敗：${err.message}`, true);
      if (!silent) showToast(`雲端同步失敗：${err.message}`, 'error');
    }
  }

  async function pushToCloud(scope = 'all', silent = false) {
    if (!state.settings.gasUrl) return;
    updateCloudStatusPill(true);
    try {
      // 剔除機密 Token 與個人名稱再上傳設定
      const { gasUrl, gasToken, operatorName, ...sharedSettings } = state.settings;
      const payload = {
        action: 'push',
        scope,
        settings: sharedSettings,
        actionLogs: state.actionLogs,
        meta: state.meta,
      };
      if (scope === 'all' && state.settings.gasSyncInventory) {
        payload.expiryRows = state.expiryRows;
        payload.masterMap = state.masterMap;
      }

      await callGasApi(payload);
      state.meta.lastCloudSyncAt = new Date().toISOString();
      await dbSet('meta', state.meta);

      updateCloudStatusPill(false);
      setGasLog('已成功推送最新資料至 Google Sheets');
      if (!silent) showToast('已成功上傳同步至 Google Sheets', 'success');
    } catch (err) {
      console.error('Cloud push error:', err);
      updateCloudStatusPill(false, err.message);
      setGasLog(`上傳失敗：${err.message}`, true);
      if (!silent) showToast(`上傳雲端失敗：${err.message}`, 'error');
    }
  }

  // ===========================================================================
  // 12. 匯出 Excel、列印巡檢單與 JSON 備份還原
  // ===========================================================================
  function exportCurrentViewExcel() {
    if (typeof XLSX === 'undefined') return showToast('Excel 模組尚未就緒', 'error');
    if (state.filteredRows.length === 0) return showToast('目前列表沒有可匯出的資料', 'error');

    const data = state.filteredRows.map((item) => ({
      藥碼: item.code,
      藥品名稱: item.name,
      現有庫存: item.isArchived ? '' : item.stock,
      單位: item.unit || '',
      部門代碼: item.dept,
      批號: item.lot,
      有效日期: item.expStr,
      剩餘天數: item.isArchived ? '' : item.remainDays,
      效期狀態: item.statusLabel,
      是否貼標: item.log?.labeled ? '是' : '否',
      貼標日期: item.log?.labeledAt || '',
      是否下架: item.log?.removed ? '是' : '否',
      下架日期: item.log?.removedAt || '',
      經手藥師: item.log?.operator || '',
      處置備註: item.log?.note || '',
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '近效期篩選清單');
    XLSX.writeFile(wb, `藥品近效期清單_${formatTodayIso()}.xlsx`);
    showToast('已匯出 Excel 檔案', 'success');
  }

  function exportAllActionLogsExcel() {
    if (typeof XLSX === 'undefined') return showToast('Excel 模組尚未就緒', 'error');
    const entries = Object.values(state.actionLogs).filter((l) => l.labeled || l.removed || l.note);
    if (entries.length === 0) return showToast('目前尚無任何貼標或下架紀錄', 'info');

    const currentKeys = new Set(state.expiryRows.map((r) => makeItemKey(r.code, r.lot, r.expYmd)));
    const data = entries
      .sort((a, b) => (a.expYmd || '').localeCompare(b.expYmd || ''))
      .map((l) => {
        const dt = parseFlexibleDate(l.expYmd);
        return {
          藥碼: l.code,
          藥品名稱: l.name,
          批號: l.lot,
          有效日期: dt ? dt.display : l.expYmd,
          部門代碼: l.dept || '',
          庫存狀態: currentKeys.has(l.key) ? '在架/帳上' : '已耗盡封存',
          已貼標: l.labeled ? '✓' : '',
          貼標日期: l.labeledAt || '',
          已下架: l.removed ? '✓' : '',
          下架日期: l.removedAt || '',
          經手藥師: l.operator || '',
          處置備註: l.note || '',
          最後更新: l.updatedAt ? l.updatedAt.slice(0, 16).replace('T', ' ') : '',
        };
      });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '效期維護稽核紀錄');
    XLSX.writeFile(wb, `藥品近效期貼標下架稽核表_${formatTodayIso()}.xlsx`);
    showToast(`已匯出 ${entries.length} 筆稽核紀錄`, 'success');
  }

  function printChecklist() {
    // 暫時展開全部列以便完整列印
    const prevLimit = state.renderLimit;
    state.renderLimit = Math.max(state.filteredRows.length, PAGE_SIZE);
    renderTable();

    document.getElementById('printTime').textContent = formatNowStr();
    document.getElementById('printSubtitle').textContent =
      `篩選條件：${document.getElementById('activeFilterHint').textContent} ｜ 排除基準日：${state.settings.cutoffDate} ｜ 共 ${state.filteredRows.length} 筆`;

    setTimeout(() => {
      window.print();
      state.renderLimit = prevLimit;
      renderTable();
    }, 100);
  }

  function exportBackupJson() {
    const bundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      actionLogs: state.actionLogs,
      meta: state.meta,
      expiryRows: state.expiryRows,
      masterMap: state.masterMap,
    };
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pharmacy-expiry-backup_${formatTodayIso()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已下載完整 JSON 備份檔', 'success');
  }

  async function importBackupJson(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('無效的備份檔格式');

      if (data.settings) state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
      if (data.actionLogs) state.actionLogs = data.actionLogs;
      if (Array.isArray(data.expiryRows)) state.expiryRows = data.expiryRows;
      if (data.masterMap) state.masterMap = data.masterMap;
      if (data.meta) state.meta = { ...state.meta, ...data.meta };

      await Promise.all([
        dbSet('settings', state.settings),
        dbSet('actionLogs', state.actionLogs),
        dbSet('expiryRows', state.expiryRows),
        dbSet('masterMap', state.masterMap),
        dbSet('meta', state.meta),
      ]);

      syncSettingsUI();
      recomputeAndRender();
      showToast('已成功還原 JSON 備份檔！', 'success');
    } catch (err) {
      showToast(`還原失敗：${err.message}`, 'error');
    }
  }

  // ===========================================================================
  // 13. 模擬測試資料 (供未上傳檔案時體驗)
  // ===========================================================================
  async function loadDemoData() {
    const today = getTodayUtcMs();
    const mkDate = (offsetDays) => {
      const dt = new Date(today + offsetDays * 86400000);
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      return { ymd: `${y}${m}${d}`, str: `${y}/${m}/${d}` };
    };

    const samples = [
      { code: 'DEMO01', name: 'Demo-Antibiotic Inj 500mg', stock: 18, dept: 'PHR_院部藥局', lot: 'L2401A', off: -14, unit: 'VIAL' },
      { code: 'DEMO02', name: 'Demo-Eye Ointment 3% 4g', stock: 5, dept: 'PHR_院部藥局', lot: 'DR-24003', off: 12, unit: 'TUB' },
      { code: 'DEMO03', name: 'Demo-Dopamine Inj 200mg/5ml ★', stock: 120, dept: 'PHR_院部藥局', lot: '2RP0683', off: 22, unit: 'AMP' },
      { code: 'DEMO04', name: 'Demo-Insulin Pen 300U/3ml', stock: 24, dept: 'PHR_院部藥局', lot: 'INS881', off: 55, unit: 'PEN' },
      { code: 'DEMO05', name: 'Demo-Antihypertensive Tab 5mg', stock: 450, dept: 'PHR_院部藥局', lot: 'NT2509', off: 78, unit: 'TAB' },
      { code: 'DEMO06', name: 'Demo-Flu Vaccine 0.5mL (公費疫苗)', stock: 150, dept: 'PHR_院部藥局', lot: 'VAC2601-CDC', off: 18, unit: 'SYR' },
      { code: 'DEMO07', name: 'Demo-Analgesic Tab 500mg', stock: 3200, dept: 'PHR_院部藥局', lot: 'T26240', off: 320, unit: 'TAB' },
    ];

    state.expiryRows = samples.map((x) => {
      const dt = mkDate(x.off);
      return { code: x.code, name: x.name, stock: x.stock, dept: x.dept, lot: x.lot, expYmd: dt.ymd, expStr: dt.str };
    });
    state.masterMap = {};
    samples.forEach((x) => {
      state.masterMap[x.code] = { n: x.name, u: x.unit, s: 0, r: 0 };
    });

    // 預先模擬一筆「已貼標但進入緊急待下架」的情境
    const d2 = mkDate(12);
    const k2 = makeItemKey('DEMO02', 'DR-24003', d2.ymd);
    state.actionLogs[k2] = {
      key: k2,
      code: 'DEMO02',
      name: 'Demo-Eye Ointment 3% 4g',
      lot: 'DR-24003',
      expYmd: d2.ymd,
      dept: 'PHR_院部藥局',
      labeled: true,
      labeledAt: formatTodayIso(),
      removed: false,
      removedAt: '',
      note: '已貼紅標移前排（此為模擬範例）',
      operator: '測試藥師',
      updatedAt: new Date().toISOString(),
    };

    state.settings.cutoffDate = '2025-01-01';
    state.meta = {
      ...state.meta,
      expiryFileName: '模擬體驗資料',
      expiryUploadedAt: new Date().toISOString(),
      expiryReportDate: formatNowStr(),
      expiryRowCount: state.expiryRows.length,
      masterFileName: '模擬基本檔',
      masterUploadedAt: new Date().toISOString(),
      masterRowCount: samples.length,
    };

    await Promise.all([
      dbSet('settings', state.settings),
      dbSet('expiryRows', state.expiryRows),
      dbSet('masterMap', state.masterMap),
      dbSet('actionLogs', state.actionLogs),
      dbSet('meta', state.meta),
    ]);

    syncSettingsUI();
    recomputeAndRender();
    showToast('已載入模擬體驗資料，您可以試用貼標、下架與疫苗排除功能！', 'success');
  }

  // ===========================================================================
  // 14. Modal & Toast 控制
  // ===========================================================================
  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
    lucide.createIcons();
  }
  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  function showToast(message, type = 'info', opts = {}) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    const colors = {
      success: 'bg-emerald-600 text-white',
      error: 'bg-rose-600 text-white',
      info: 'bg-slate-800 dark:bg-slate-700 text-white',
    };
    toast.className = `pointer-events-auto px-4 py-2.5 rounded-xl shadow-lg text-xs font-bold flex items-center justify-between gap-3 animate-fade ${colors[type] || colors.info}`;
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    if (opts.actionText && typeof opts.onAction === 'function') {
      const btn = document.createElement('button');
      btn.className = 'px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-white underline shrink-0 cursor-pointer';
      btn.textContent = opts.actionText;
      btn.onclick = () => {
        opts.onAction();
        toast.remove();
      };
      toast.appendChild(btn);
    }
    container.appendChild(toast);
    setTimeout(() => toast.remove(), opts.actionText ? 5500 : 3200);
  }

  // ===========================================================================
  // 15. 事件綁定
  // ===========================================================================
  function bindEvents() {
    // 主題切換
    const applyTheme = (dark) => {
      document.documentElement.classList.toggle('dark', dark);
      localStorage.setItem('pet_theme', dark ? 'dark' : 'light');
    };
    const savedTheme = localStorage.getItem('pet_theme');
    if (savedTheme === 'dark') applyTheme(true);
    document.getElementById('btnToggleTheme').onclick = () => {
      applyTheme(!document.documentElement.classList.contains('dark'));
    };

    // Modal 開關
    document.getElementById('btnOpenImport').onclick = () => { updateImportModalMeta(); openModal('modalImport'); };
    document.getElementById('btnWelcomeImport').onclick = () => { updateImportModalMeta(); openModal('modalImport'); };
    document.getElementById('btnStaleImport').onclick = () => { updateImportModalMeta(); openModal('modalImport'); };
    document.getElementById('btnOpenSettings').onclick = () => { syncSettingsUI(); openModal('modalSettings'); };
    document.getElementById('btnCloudSync').onclick = () => {
      syncSettingsUI();
      openModal('modalSettings');
      switchSettingsTab('cloud');
    };
    document.getElementById('btnOpenHelp').onclick = () => openModal('modalHelp');
    document.getElementById('btnLoadDemoData').onclick = loadDemoData;

    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    ['modalImport', 'modalSettings', 'modalNote', 'modalHelp'].forEach((id) => {
      document.getElementById(id).addEventListener('click', (e) => {
        if (e.target.id === id) closeModal(id);
      });
    });

    // 匯出選單
    const exportMenu = document.getElementById('exportDropdown');
    document.getElementById('btnExportMenu').onclick = (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('hidden');
    };
    document.addEventListener('click', () => exportMenu.classList.add('hidden'));
    document.getElementById('btnExportCurrentXlsx').onclick = exportCurrentViewExcel;
    document.getElementById('btnExportActionLogsXlsx').onclick = exportAllActionLogsExcel;
    document.getElementById('btnPrintChecklist').onclick = printChecklist;

    // 拖拉與點擊上傳
    const setupDropZone = (zoneId, inputId, handler) => {
      const zone = document.getElementById(zoneId);
      const input = document.getElementById(inputId);
      zone.onclick = () => input.click();
      input.onchange = () => {
        if (input.files && input.files[0]) {
          handler(input.files[0]);
          input.value = '';
        }
      };
      zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('drop-active'); };
      zone.ondragleave = () => zone.classList.remove('drop-active');
      zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('drop-active');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          handler(e.dataTransfer.files[0]);
        }
      };
    };
    setupDropZone('dropZoneExpiry', 'fileInputExpiry', handleImportExpiry);
    setupDropZone('dropZoneMaster', 'fileInputMaster', handleImportMaster);
    document.getElementById('fileInputXlsm').onchange = (e) => {
      if (e.target.files?.[0]) {
        handleImportXlsmBoth(e.target.files[0]);
        e.target.value = '';
      }
    };

    // 主頁面控制項（即時自動重算）
    document.getElementById('inputCutoffDate').addEventListener('change', async (e) => {
      state.settings.cutoffDate = e.target.value;
      await saveSettings();
      recomputeAndRender();
    });

    document.getElementById('inputOperator').addEventListener('change', async (e) => {
      state.settings.operatorName = e.target.value.trim();
      await saveSettings();
    });

    document.getElementById('chkHideRemoved').addEventListener('change', async (e) => {
      state.settings.hideRemoved = e.target.checked;
      await saveSettings();
      applyViewFilterAndSort();
      renderTable();
    });

    const searchInput = document.getElementById('inputSearch');
    const clearSearchBtn = document.getElementById('btnClearSearch');
    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
      state.renderLimit = PAGE_SIZE;
      applyViewFilterAndSort();
      renderTable();
    });
    clearSearchBtn.onclick = () => {
      searchInput.value = '';
      state.searchQuery = '';
      clearSearchBtn.classList.add('hidden');
      applyViewFilterAndSort();
      renderTable();
    };

    document.getElementById('selectSort').addEventListener('change', (e) => {
      state.sortBy = e.target.value;
      applyViewFilterAndSort();
      renderTable();
    });

    // KPI 卡片與分頁籤切換
    const setFilter = (f) => {
      state.activeFilter = f;
      state.renderLimit = PAGE_SIZE;
      state.selectedKeys.clear();
      applyViewFilterAndSort();
      renderHeaderAndKpis();
      renderTable();
      renderBatchBar();
    };
    document.querySelectorAll('.kpi-card').forEach((el) => {
      el.addEventListener('click', () => setFilter(el.dataset.kpi));
    });
    document.querySelectorAll('.view-tab').forEach((el) => {
      el.addEventListener('click', () => setFilter(el.dataset.tab));
    });

    // 分頁展開
    document.getElementById('btnLoadMore').onclick = () => {
      state.renderLimit += PAGE_SIZE;
      renderTable();
    };
    document.getElementById('btnShowAllRows').onclick = () => {
      state.renderLimit = state.filteredRows.length;
      renderTable();
    };

    // 表格事件委派 (貼標 / 下架 / 備註 / 勾選 / 快速排除藥碼)
    document.getElementById('resultTableBody').addEventListener('click', (e) => {
      const labelBtn = e.target.closest('.btn-toggle-label');
      if (labelBtn) return toggleRowAction(labelBtn.dataset.key, 'labeled');

      const removeBtn = e.target.closest('.btn-toggle-remove');
      if (removeBtn) return toggleRowAction(removeBtn.dataset.key, 'removed');

      const noteBtn = e.target.closest('.btn-open-note');
      if (noteBtn) return openNoteModal(noteBtn.dataset.key);

      const exclBtn = e.target.closest('.btn-quick-exclude');
      if (exclBtn) return addExcludedCodes([exclBtn.dataset.code]);
    });

    document.getElementById('resultTableBody').addEventListener('change', (e) => {
      if (e.target.classList.contains('row-checkbox')) {
        const key = e.target.dataset.key;
        if (e.target.checked) state.selectedKeys.add(key);
        else state.selectedKeys.delete(key);
        renderBatchBar();
      }
    });

    document.getElementById('chkSelectAll').addEventListener('change', (e) => {
      const slice = state.filteredRows.slice(0, state.renderLimit);
      if (e.target.checked) slice.forEach((r) => state.selectedKeys.add(r.key));
      else slice.forEach((r) => state.selectedKeys.delete(r.key));
      renderTable();
      renderBatchBar();
    });

    // 批次操作鍵
    document.getElementById('btnBatchClearSelect').onclick = () => {
      state.selectedKeys.clear();
      renderTable();
      renderBatchBar();
    };
    document.getElementById('btnBatchLabel').onclick = () => batchApplyAction('labeled');
    document.getElementById('btnBatchRemove').onclick = () => batchApplyAction('removed');
    document.getElementById('btnBatchExclude').onclick = async () => {
      const codes = new Set();
      for (const k of state.selectedKeys) {
        const item = findItemByKey(k);
        if (item) codes.add(item.code);
      }
      if (codes.size === 0) return;
      if (!confirm(`確定要將所選的 ${codes.size} 個藥碼（${Array.from(codes).join(', ')}）加入永久排除清單嗎？`)) return;
      state.selectedKeys.clear();
      await addExcludedCodes(Array.from(codes));
    };

    // 單筆備註 Modal 事件
    document.querySelectorAll('.quick-note-btn').forEach((btn) => {
      btn.onclick = () => {
        const input = document.getElementById('noteText');
        const txt = btn.textContent.trim();
        input.value = input.value ? `${input.value}；${txt}` : txt;
      };
    });
    document.getElementById('btnSaveNote').onclick = saveNoteModal;
    document.getElementById('btnNoteExcludeCode').onclick = async () => {
      const item = findItemByKey(state.editingKey);
      if (!item) return;
      closeModal('modalNote');
      await addExcludedCodes([item.code]);
    };

    // 進階設定分頁切換
    const switchSettingsTab = (tabName) => {
      document.querySelectorAll('.settings-tab').forEach((t) => {
        const active = t.dataset.stab === tabName;
        t.classList.toggle('border-sky-600', active);
        t.classList.toggle('text-sky-600', active);
        t.classList.toggle('border-transparent', !active);
        t.classList.toggle('text-slate-500', !active);
      });
      document.querySelectorAll('.settings-panel').forEach((p) => {
        p.classList.toggle('hidden', p.id !== `stab-${tabName}`);
      });
    };
    window.switchSettingsTab = switchSettingsTab;
    document.querySelectorAll('.settings-tab').forEach((btn) => {
      btn.onclick = () => switchSettingsTab(btn.dataset.stab);
    });

    // 進階設定即時綁定
    const bindSetting = (id, key, transform = (v) => v) => {
      const el = document.getElementById(id);
      const evt = el.type === 'checkbox' ? 'change' : 'change';
      el.addEventListener(evt, async () => {
        state.settings[key] = el.type === 'checkbox' ? el.checked : transform(el.value);
        await saveSettings();
        recomputeAndRender();
      });
    };
    bindSetting('setMaxAlertDays', 'maxAlertDays', (v) => Math.max(0, parseInt(v, 10) || 0));
    bindSetting('setShowExpired', 'showExpired');
    bindSetting('setExcludeZeroStock', 'excludeZeroStock');
    bindSetting('setExcludeNoteS', 'excludeNoteS');
    bindSetting('setExcludePropRG', 'excludePropRG');
    bindSetting('setUrgentDays', 'urgentDays', (v) => Math.max(1, parseInt(v, 10) || 30));
    bindSetting('setNearDays', 'nearDays', (v) => Math.max(1, parseInt(v, 10) || 90));
    bindSetting('setWatchDays', 'watchDays', (v) => Math.max(1, parseInt(v, 10) || 180));
    bindSetting('setAutoExcludeCDC', 'autoExcludeCDC');

    // 排除藥碼管理
    document.getElementById('btnAddExcludedCodes').onclick = async () => {
      const input = document.getElementById('inputAddExcludedCodes');
      const parts = input.value.split(/[\s,，;；\n]+/).filter(Boolean);
      if (parts.length === 0) return;
      const added = await addExcludedCodes(parts, true);
      input.value = '';
      showToast(`已新增 ${added} 個排除藥碼`, 'success');
    };
    document.getElementById('inputAddExcludedCodes').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('btnAddExcludedCodes').click();
      }
    });
    document.getElementById('excludedTagsContainer').addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-remove-excluded');
      if (!btn) return;
      const code = btn.dataset.code;
      state.settings.excludedCodes = (state.settings.excludedCodes || []).filter((c) => c !== code);
      await saveSettings();
      renderExcludedTags();
      recomputeAndRender();
      showToast(`已移除排除藥碼 ${code}`, 'info');
    });
    document.getElementById('btnClearExcludedCodes').onclick = async () => {
      if ((state.settings.excludedCodes || []).length === 0) return;
      if (!confirm('確定要清空所有特定排除藥碼嗎？')) return;
      state.settings.excludedCodes = [];
      await saveSettings();
      renderExcludedTags();
      recomputeAndRender();
      showToast('已清空排除藥碼清單', 'info');
    };

    // 疫苗掃描
    document.getElementById('btnScanVaccines').onclick = scanPotentialVaccines;
    document.getElementById('btnSelectAllScanned').onclick = () => {
      const boxes = document.querySelectorAll('.chk-scanned-vaccine');
      const allChecked = Array.from(boxes).every((b) => b.checked);
      boxes.forEach((b) => (b.checked = !allChecked));
    };
    document.getElementById('btnAddScannedToBlacklist').onclick = async () => {
      const chosen = Array.from(document.querySelectorAll('.chk-scanned-vaccine:checked')).map((b) => b.value);
      if (chosen.length === 0) return showToast('請先勾選至少一個藥碼', 'info');
      const added = await addExcludedCodes(chosen, true);
      document.getElementById('vaccineScanPanel').classList.add('hidden');
      showToast(`已批次加入 ${added} 個疫苗/公費排除藥碼`, 'success');
    };

    // 雲端同步設定
    const saveGasFields = async () => {
      state.settings.gasUrl = document.getElementById('setGasUrl').value.trim();
      state.settings.gasToken = document.getElementById('setGasToken').value.trim();
      state.settings.gasAutoSync = document.getElementById('setGasAutoSync').checked;
      state.settings.gasSyncInventory = document.getElementById('setGasSyncInventory').checked;
      await dbSet('settings', state.settings);
      updateCloudStatusPill();
    };
    ['setGasUrl', 'setGasToken', 'setGasAutoSync', 'setGasSyncInventory'].forEach((id) => {
      document.getElementById(id).addEventListener('change', saveGasFields);
    });
    document.getElementById('btnGasTest').onclick = async () => {
      await saveGasFields();
      try {
        const res = await callGasApi({ action: 'ping' });
        setGasLog(`連線成功！試算表：${res.sheetName || 'OK'} (${res.serverTime || ''})`);
        showToast('Google Sheets 連線成功！', 'success');
      } catch (err) {
        setGasLog(`連線失敗：${err.message}`, true);
        showToast(`連線失敗：${err.message}`, 'error');
      }
    };
    document.getElementById('btnGasPull').onclick = async () => {
      await saveGasFields();
      await pullFromCloud(false);
    };
    document.getElementById('btnGasPush').onclick = async () => {
      await saveGasFields();
      await pushToCloud('all', false);
    };

    // 備份與資料維護
    document.getElementById('btnBackupJson').onclick = exportBackupJson;
    document.getElementById('fileInputBackup').onchange = (e) => {
      if (e.target.files?.[0]) {
        importBackupJson(e.target.files[0]);
        e.target.value = '';
      }
    };

    document.getElementById('btnClearExpiryOnly').onclick = async () => {
      if (!confirm('確定要清除目前的「效期查詢資料」嗎？（貼標/下架紀錄與排除藥碼會保留）')) return;
      state.expiryRows = [];
      state.meta.expiryRowCount = 0;
      state.meta.expiryFileName = '';
      state.meta.expiryReportDate = '';
      await Promise.all([dbSet('expiryRows', []), dbSet('meta', state.meta)]);
      recomputeAndRender();
      updateImportModalMeta();
      showToast('已清除效期查詢資料', 'info');
    };
    document.getElementById('btnClearMasterOnly').onclick = async () => {
      if (!confirm('確定要清除「藥品基本檔」對照表嗎？')) return;
      state.masterMap = {};
      state.meta.masterRowCount = 0;
      state.meta.masterFileName = '';
      await Promise.all([dbSet('masterMap', {}), dbSet('meta', state.meta)]);
      recomputeAndRender();
      updateImportModalMeta();
      showToast('已清除藥品基本檔', 'info');
    };
    document.getElementById('btnPruneArchived').onclick = async () => {
      const currentKeys = new Set(state.expiryRows.map((r) => makeItemKey(r.code, r.lot, r.expYmd)));
      const archivedKeys = Object.keys(state.actionLogs).filter((k) => !currentKeys.has(k));
      if (archivedKeys.length === 0) return showToast('目前沒有已封存的歷史紀錄', 'info');
      if (!confirm(`確定要刪除 ${archivedKeys.length} 筆已從最新庫存檔消失的歷史封存紀錄嗎？建議先匯出稽核表備份。`)) return;
      archivedKeys.forEach((k) => delete state.actionLogs[k]);
      await saveActionLogs();
      recomputeAndRender();
      showToast(`已清理 ${archivedKeys.length} 筆歷史封存紀錄`, 'info');
    };
    document.getElementById('btnResetSettings').onclick = async () => {
      if (!confirm('確定要恢復預設篩選參數嗎？（將保留您的貼標/下架紀錄與 Google Sheets 連線網址）')) return;
      const keep = {
        gasUrl: state.settings.gasUrl,
        gasToken: state.settings.gasToken,
        gasAutoSync: state.settings.gasAutoSync,
        gasSyncInventory: state.settings.gasSyncInventory,
        operatorName: state.settings.operatorName,
      };
      state.settings = { ...DEFAULT_SETTINGS, ...keep };
      await saveSettings();
      syncSettingsUI();
      recomputeAndRender();
      showToast('已恢復預設篩選參數', 'info');
    };
  }

  // ===========================================================================
  // 16. 初始化啟動（開啟網頁即自動整理！）
  // ===========================================================================
  async function init() {
    lucide.createIcons();
    bindEvents();
    await loadAllFromDB();
    syncSettingsUI();
    recomputeAndRender();

    // 若有設定 Google Sheets 且啟用自動同步，於背景自動拉取最新進度
    if (state.settings.gasUrl && state.settings.gasAutoSync) {
      pullFromCloud(true);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
