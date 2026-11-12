/**
 * QueenCosy Daily Parcel Checker - Automated Folder Sync Engine
 * ดึงไฟล์คำสั่งซื้อจากโฟลเดอร์ "ของส่งแต่ละวัน/<เดือน>/<วันที่>/*.xlsx" ขึ้นระบบ Cloud อัตโนมัติ
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('./vendor/xlsx.full.min.js');
const { SyncService } = require('./sync-service.js');

const DEFAULT_BASE_DIR = 'd:\\Furniture project\\lazada,shopee,tiktok\\tiktok Queencosy\\ของส่งแต่ละวัน';

const THAI_MONTH_MAP = {
  'มค': '01', 'ม.ค': '01',
  'กพ': '02', 'ก.พ': '02',
  'มีค': '03', 'มี.ค': '03',
  'เมย': '04', 'เม.ย': '04',
  'พค': '05', 'พ.ค': '05',
  'มิย': '06', 'มิ.ย': '06',
  'กค': '07', 'ก.ค': '07',
  'สค': '08', 'ส.ค': '08',
  'กย': '09', 'ก.ย': '09',
  'ตค': '10', 'ต.ค': '10',
  'พย': '11', 'พ.ย': '11',
  'ธค': '12', 'ธ.ค': '12'
};

function parseMonthFolder(folderName) {
  const clean = String(folderName || '').trim();
  for (const [thaiKey, monthNum] of Object.entries(THAI_MONTH_MAP)) {
    if (clean.startsWith(thaiKey)) {
      const yearPart = clean.replace(thaiKey, '').replace(/[\.\s\-_]/g, '');
      let year = parseInt(yearPart, 10);
      if (isNaN(year)) year = new Date().getFullYear();
      else if (year === 69 || year === 26) year = 2026;
      else if (year === 68 || year === 25) year = 2025;
      else if (year === 70 || year === 27) year = 2027;
      else if (year > 2500) year -= 543;
      else if (year < 100) year += 2000;
      return `${year}-${monthNum}`;
    }
  }
  return null;
}

function normalizeTracking(str) {
  if (!str) return '';
  return String(str).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function detectCarrier(tracking, rawCarrier) {
  if (rawCarrier && String(rawCarrier).trim()) {
    const rc = String(rawCarrier).trim();
    if (/flash/i.test(rc)) return 'Flash Express';
    if (/best/i.test(rc)) return 'BEST Express';
    if (/j&t|jnt/i.test(rc)) return 'J&T Express';
    if (/spx|shopee/i.test(rc)) return 'SPX Express';
    if (/kerry|kex/i.test(rc)) return 'KEX Express';
    if (/lex|lazada/i.test(rc)) return 'LEX Express';
    if (/thai\s*post|ไปรษณีย์/i.test(rc)) return 'ไปรษณีย์ไทย';
    return rc;
  }
  const t = normalizeTracking(tracking);
  if (!t) return 'ไม่ระบุขนส่ง';
  if (/^TH/i.test(t)) return 'Flash Express';
  if (/^66\d{12}$/.test(t)) return 'BEST Express';
  if (/^(SPXTH|TH\d{12})/i.test(t)) return 'SPX Express';
  if (/^(KEX|KER|SDOF)/i.test(t)) return 'KEX Express';
  if (/^(82|83|86|61)\d{10}$/.test(t) || /^TIK/i.test(t)) return 'J&T Express';
  if (/^[E,R,C,L][A-Z]\d{9}TH$/i.test(t)) return 'ไปรษณีย์ไทย';
  return 'ไม่ระบุขนส่ง';
}

function inferColumnIndicesFromData(cols) {
  if (!cols) return null;
  const denseCols = [];
  for (let i = 0; i < (cols.length || 0); i++) {
    const val = cols[i];
    denseCols.push(String(val !== null && val !== undefined ? val : '').trim());
  }

  let idxOrder = -1;
  let idxTrack = -1;
  let idxSku = -1;
  let idxVariation = -1;
  let idxQty = -1;
  let idxCarrier = -1;

  for (let i = 0; i < denseCols.length; i++) {
    const val = denseCols[i];
    if (!val) continue;

    // Skip date timestamps like 14/10/2025 14:43:08
    if (/^\d{1,4}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(val)) {
      continue;
    }

    if (idxTrack === -1 && (
      /^(THT|TIK|SPXTH|KEX|KER|JNT)[0-9A-Z]+$/i.test(val) ||
      (/^TH[0-9A-Z]{8,}$/i.test(val) && !val.includes(' ') && val.length <= 22) ||
      (/^\d{13,15}$/.test(val) && val.startsWith('66'))
    )) {
      idxTrack = i;
      continue;
    }

    if (idxQty === -1 && /^\d{1,3}$/.test(val) && parseInt(val, 10) > 0 && parseInt(val, 10) < 500) {
      idxQty = i;
      continue;
    }

    if (idxCarrier === -1 && /^(Flash|BEST|Shopee|SPX|Kerry|KEX|J&T|EMS|ไปรษณีย์)/i.test(val)) {
      idxCarrier = i;
      continue;
    }

    if (idxSku === -1 && (/^Qs[\-_]/i.test(val) || val.includes('โซฟา') || val.includes('สตูล') || val.includes('หมอน') || val.includes('เตียง'))) {
      idxSku = i;
      continue;
    }

    if (idxOrder === -1 && /^[0-9A-Za-z]{12,25}$/.test(val)) {
      idxOrder = i;
      continue;
    }
  }

  if (idxSku !== -1 && idxVariation === -1 && idxSku + 1 < denseCols.length) {
    const nextIdx = idxSku + 1;
    if (nextIdx !== idxQty && nextIdx !== idxTrack && nextIdx !== idxOrder && nextIdx !== idxCarrier && denseCols[nextIdx]) {
      idxVariation = nextIdx;
    }
  }

  if (idxOrder === -1 && idxTrack === -1) return null;

  return {
    idxOrder,
    idxTrack,
    idxDate: -1,
    idxSku,
    idxVariation,
    idxQty,
    idxCarrier,
    idxPacker: -1,
    idxNotes: -1,
    idxStatus: -1
  };
}

function resolveColumnIndices(headerRow) {
  if (!headerRow) return null;
  const len = headerRow.length || 0;
  const headers = [];
  for (let i = 0; i < len; i++) {
    const val = headerRow[i];
    headers.push(String(val !== null && val !== undefined ? val : '').trim().toLowerCase().replace(/[\*\_\-]/g, ' '));
  }

  const findExactOrInc = (keywords, excludeKeywords = []) => {
    for (const kw of keywords) {
      const idx = headers.findIndex((h) => h === kw && !excludeKeywords.some((ex) => h.includes(ex)));
      if (idx !== -1) return idx;
    }
    for (const kw of keywords) {
      const idx = headers.findIndex((h) => h && h.includes(kw) && !excludeKeywords.some((ex) => h.includes(ex)));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const idxTrack = findExactOrInc(
    ['tracking id', 'tracking number', 'tracking no', 'หมายเลขติดตามพัสดุ', 'เลขพัสดุ', 'tracking', 'เลขแทรค', 'แทรคกิ้ง', 'รหัสติดตามพัสดุ', 'หมายเลขพัสดุ', 'เลขติดตามพัสดุ'],
    ['status', 'สถานะ']
  );

  const idxOrder = findExactOrInc(
    ['order id', 'หมายเลขคำสั่งซื้อ', 'รหัสคำสั่งซื้อ', 'เลขที่คำสั่งซื้อ', 'order number', 'order no', 'รายการสั่งซื้อ', 'คำสั่งซื้อ', 'order'],
    ['วัน', 'date', 'เวลา', 'time', 'สถานะ', 'status', 'tracking', 'พัสดุ', 'type', 'ประเภท', 'substatus']
  );

  const idxDate = findExactOrInc(
    ['เวลานัดรับสินค้าโดยประมาณ', 'วันจัดส่ง', 'วันที่จัดส่ง', 'ship date', 'shipping date', 'estimated delivery date', 'วันที่ส่งของ', 'ส่งภายใน', 'วันส่ง', 'date'],
    ['created', 'สร้าง', 'paid', 'ชำระ', 'rts', 'ready to ship', 'time', 'เวลา']
  );

  let idxSku = findExactOrInc([
    'seller sku', 'เลขอ้างอิง sku (sku reference no.)', 'เลขอ้างอิง sku', 'sku reference no', 'seller_sku', 'รหัสสินค้าของร้าน', 'รหัสสินค้า'
  ]);
  if (idxSku === -1) {
    idxSku = findExactOrInc(
      ['ชื่อสินค้า', 'product name', 'item name', 'สินค้า', 'รุ่น', 'รายการสินค้า', 'รายละเอียดสินค้า', 'sku'],
      ['parent', 'sku id', 'เพจ', 'ราคา', 'จำนวน', 'หมายเลข', 'สถานะ', 'ตัวเลือก', 'variation', 'sold']
    );
  }

  const idxVariation = findExactOrInc(
    ['variation', 'ชื่อตัวเลือก', 'ตัวเลือกสินค้า', 'สี', 'ขนาด', 'ตัวเลือก'],
    ['ราคา', 'จำนวน']
  );

  const idxQty = findExactOrInc(
    ['quantity', 'จำนวน', 'qty', 'amount', 'จำนวนสินค้า', 'ชิ้น'],
    ['คืน', 'return', 'cancel', 'ยกเลิก', 'ราคา', 'price']
  );

  const idxCarrier = findExactOrInc(
    ['shipping provider name', 'shipping provider', 'ตัวเลือกการจัดส่ง', 'ผู้ให้บริการขนส่ง', 'บริษัทขนส่ง', 'ขนส่ง', 'carrier', 'วิธีการจัดส่ง', 'ช่องทางการจัดส่ง'],
    ['ค่า', 'fee', 'type']
  );

  const idxPacker = findExactOrInc(['ผู้แพ็ค', 'คนแพ็ค', 'packer', 'พนักงานแพ็ค', 'ผู้รับผิดชอบ']);
  const idxNotes = findExactOrInc(['หมายเหตุ', 'note', 'notes', 'remark', 'ข้อความจากผู้ซื้อ', 'buyer message', 'comment']);
  const idxStatus = findExactOrInc(['สถานะการยกเลิก/คืนสินค้า', 'cancelation/return type', 'สถานะคำสั่งซื้อ', 'order status', 'สถานะ', 'status'], ['substatus']);

  return { idxOrder, idxTrack, idxDate, idxSku, idxVariation, idxQty, idxCarrier, idxPacker, idxNotes, idxStatus };
}

function parseExcelFile(filePath, targetDate) {
  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true });
  let sheetName = wb.SheetNames.find((s) =>
    typeof s === 'string' && (s.includes('รายการที่ต้องส่ง') || s.toLowerCase().includes('order') || s.includes('คำสั่งซื้อ'))
  ) || wb.SheetNames[0];

  const ws = wb.Sheets[sheetName];
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const rowProps = ws['!rows'] || [];

  // Skip rows hidden by Excel Filter
  const rows = allRows.filter((r, idx) => !(rowProps[idx] && rowProps[idx].hidden));

  let headerRowIdx = -1;
  let colIndices = null;
  let maxMatchCount = 0;

  for (let r = 0; r < Math.min(10, rows.length); r++) {
    const candidateRow = rows[r];
    if (!candidateRow) continue;
    const candidateIndices = resolveColumnIndices(candidateRow);
    if (!candidateIndices) continue;
    let matchCount = 0;
    if (candidateIndices.idxOrder !== -1) matchCount++;
    if (candidateIndices.idxTrack !== -1) matchCount++;
    if (candidateIndices.idxSku !== -1) matchCount++;
    if (candidateIndices.idxQty !== -1) matchCount++;
    if (candidateIndices.idxCarrier !== -1) matchCount++;
    if (matchCount >= 2 && matchCount > maxMatchCount) {
      maxMatchCount = matchCount;
      headerRowIdx = r;
      colIndices = candidateIndices;
    }
  }

  if (!colIndices && rows.length > 0) {
    colIndices = inferColumnIndicesFromData(rows[0]);
  }
  if (!colIndices) return { totalRawRows: allRows.length, hiddenRows: allRows.length - rows.length, parsedOrders: [] };

  const dataStartRow = headerRowIdx !== -1 ? headerRowIdx + 1 : 0;
  const result = [];
  const now = Date.now();

  for (let r = dataStartRow; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;

    let rawOrder = colIndices.idxOrder !== -1 && row[colIndices.idxOrder] !== undefined ? String(row[colIndices.idxOrder] || '').trim().replace(/^[\/'"]+|[\/'"]+$/g, '') : '';
    let rawTrack = colIndices.idxTrack !== -1 && row[colIndices.idxTrack] !== undefined ? String(row[colIndices.idxTrack] || '').trim().replace(/^[\/'"]+|[\/'"]+$/g, '') : '';
    let rawSku = colIndices.idxSku !== -1 && row[colIndices.idxSku] !== undefined ? String(row[colIndices.idxSku] || '').trim() : '';
    let rawVariation = colIndices.idxVariation !== -1 && row[colIndices.idxVariation] !== undefined ? String(row[colIndices.idxVariation] || '').trim() : '';
    let rawCarrier = colIndices.idxCarrier !== -1 && row[colIndices.idxCarrier] !== undefined ? String(row[colIndices.idxCarrier] || '').trim() : '';
    let rawPacker = colIndices.idxPacker !== -1 && row[colIndices.idxPacker] !== undefined ? String(row[colIndices.idxPacker] || '').trim() : '';
    let rawNotes = colIndices.idxNotes !== -1 && row[colIndices.idxNotes] !== undefined ? String(row[colIndices.idxNotes] || '').trim() : '';
    let rawStatus = colIndices.idxStatus !== -1 && row[colIndices.idxStatus] !== undefined ? String(row[colIndices.idxStatus] || '').trim() : '';

    if (!rawOrder && !rawTrack && !rawSku) continue;

    const lowerOrder = rawOrder.toLowerCase();
    const lowerTrack = rawTrack.toLowerCase();
    const lowerSku = rawSku.toLowerCase();
    if (
      lowerOrder.includes('unique order id') ||
      lowerOrder.includes('platform unique') ||
      lowerOrder.includes('order id.') ||
      lowerTrack.includes("the order's tracking") ||
      lowerTrack.includes('tracking number.') ||
      lowerSku.includes('seller sku input') ||
      (lowerSku.includes('sku id') && lowerOrder.includes('order'))
    ) {
      continue;
    }

    let finalSku = rawSku;
    if (rawVariation && finalSku && !finalSku.includes(rawVariation)) {
      finalSku = `${finalSku} [${rawVariation}]`;
    } else if (rawVariation && !finalSku) {
      finalSku = rawVariation;
    }
    if (!finalSku) finalSku = 'โซฟา/เก้าอี้สตูล';

    let qty = 1;
    if (colIndices.idxQty !== -1 && row[colIndices.idxQty] !== undefined && row[colIndices.idxQty] !== '') {
      const num = parseInt(String(row[colIndices.idxQty]).replace(/[^0-9]/g, ''), 10);
      if (!isNaN(num) && num > 0) qty = num;
    }

    const carrier = detectCarrier(rawTrack, rawCarrier);
    const cleanTrk = normalizeTracking(rawTrack);
    const isCancelled = Boolean(rawStatus && (rawStatus.includes('ยกเลิก') || rawStatus.toLowerCase().includes('cancel') || rawStatus.toLowerCase().includes('void')));

    result.push({
      id: 'ORD-' + now + '-' + Math.random().toString(36).substring(2, 7) + '-' + r,
      shipDate: targetDate,
      orderId: rawOrder,
      trackingId: rawTrack,
      cleanTracking: cleanTrk,
      sku: finalSku,
      qty: qty,
      carrier: carrier,
      packer: rawPacker || 'ทีมแพ็ค',
      notes: rawNotes || '',
      orderStatus: rawStatus || '',
      isCancelled: isCancelled
    });
  }

  return { totalRawRows: allRows.length, hiddenRows: allRows.length - rows.length, parsedOrders: result };
}

function mergeAndDeduplicateOrders(baseOrders, incomingOrders, targetDate) {
  const resultOrders = [...baseOrders];
  const trackingSkuMap = new Map();
  const trackingOnlyMap = new Map();
  const orderSkuMap = new Map();
  const orderOnlyMap = new Map();

  resultOrders.forEach((o) => {
    const cleanTrk = o.cleanTracking ? String(o.cleanTracking).trim() : '';
    const orderId = o.orderId ? String(o.orderId).trim() : '';
    const sku = o.sku ? String(o.sku).trim() : '';
    if (cleanTrk) {
      trackingSkuMap.set(`TRK:${cleanTrk}|${sku}`, o);
      if (!trackingOnlyMap.has(cleanTrk)) trackingOnlyMap.set(cleanTrk, o);
    }
    if (orderId) {
      orderSkuMap.set(`ORD:${orderId}|${sku}`, o);
      if (!orderOnlyMap.has(orderId)) orderOnlyMap.set(orderId, []);
      orderOnlyMap.get(orderId).push(o);
    }
  });

  let added = 0;
  let updatedTracking = 0;

  incomingOrders.forEach((no) => {
    no.shipDate = targetDate;
    const cleanTrk = no.cleanTracking ? String(no.cleanTracking).trim() : '';
    const orderId = no.orderId ? String(no.orderId).trim() : '';
    const sku = no.sku ? String(no.sku).trim() : '';
    const trkKey = cleanTrk ? `TRK:${cleanTrk}|${sku}` : null;
    const ordKey = orderId ? `ORD:${orderId}|${sku}` : null;

    if (trkKey && trackingSkuMap.has(trkKey)) {
      const existing = trackingSkuMap.get(trkKey);
      existing.shipDate = targetDate;
      if (no.carrier && !existing.carrier) existing.carrier = no.carrier;
      if (no.orderStatus) existing.orderStatus = no.orderStatus;
      return;
    }

    if (cleanTrk && trackingOnlyMap.has(cleanTrk)) {
      const existing = trackingOnlyMap.get(cleanTrk);
      if (existing.sku === no.sku || !existing.sku || !no.sku) {
        existing.shipDate = targetDate;
        if (no.carrier && !existing.carrier) existing.carrier = no.carrier;
        if (no.orderStatus) existing.orderStatus = no.orderStatus;
        return;
      }
    }

    if (ordKey && orderSkuMap.has(ordKey)) {
      const existing = orderSkuMap.get(ordKey);
      if (!existing.cleanTracking && cleanTrk) {
        existing.cleanTracking = cleanTrk;
        existing.trackingId = no.trackingId || cleanTrk;
        existing.shipDate = targetDate;
        if (no.carrier) existing.carrier = no.carrier;
        if (no.orderStatus) existing.orderStatus = no.orderStatus;
        trackingSkuMap.set(trkKey, existing);
        trackingOnlyMap.set(cleanTrk, existing);
        updatedTracking++;
        return;
      } else {
        existing.shipDate = targetDate;
        return;
      }
    }

    if (orderId && orderOnlyMap.has(orderId)) {
      const existingList = orderOnlyMap.get(orderId);
      const untracked = existingList.find((x) => !x.cleanTracking);
      if (untracked && cleanTrk && (existingList.length === 1 || untracked.sku === no.sku)) {
        untracked.cleanTracking = cleanTrk;
        untracked.trackingId = no.trackingId || cleanTrk;
        untracked.shipDate = targetDate;
        if (no.carrier) untracked.carrier = no.carrier;
        if (no.orderStatus) untracked.orderStatus = no.orderStatus;
        if (trkKey) trackingSkuMap.set(trkKey, untracked);
        trackingOnlyMap.set(cleanTrk, untracked);
        updatedTracking++;
        return;
      }
    }

    resultOrders.push(no);
    added++;
    if (trkKey) trackingSkuMap.set(trkKey, no);
    if (cleanTrk) trackingOnlyMap.set(cleanTrk, no);
    if (ordKey) orderSkuMap.set(ordKey, no);
    if (orderId) {
      if (!orderOnlyMap.has(orderId)) orderOnlyMap.set(orderId, []);
      orderOnlyMap.get(orderId).push(no);
    }
  });

  return { orders: resultOrders, added, updatedTracking };
}

function reconcileScansWithOrders(scans, orders, targetDate) {
  let matchedCount = 0;
  scans.forEach((scan) => {
    const clean = scan.cleanTracking || normalizeTracking(scan.trackingId);
    if (!clean) return;
    const matched = orders.find((o) => o.cleanTracking === clean || o.orderId === scan.trackingId);
    if (matched) {
      scan.matchedOrderId = matched.orderId;
      scan.matchedSku = matched.sku;
      scan.matchedQty = matched.qty;
      scan.matchedCarrier = matched.carrier;
      scan.matchResult = matched.isCancelled ? 'ลูกค้ายกเลิกคำสั่งซื้อ' : 'พบในรายการส่ง';
      matchedCount++;
    }
  });
  return matchedCount;
}

async function syncDayFolder(dayFolderPath, targetDate, replaceBloated = true) {
  if (!fs.existsSync(dayFolderPath) || !fs.statSync(dayFolderPath).isDirectory()) return null;

  const files = fs.readdirSync(dayFolderPath).filter((f) => /\.(xlsx|xls|csv)$/i.test(f) && !f.startsWith('~$'));
  if (files.length === 0) return null;

  let folderOrders = [];
  const fileSummaries = [];

  for (const f of files) {
    const fullPath = path.join(dayFolderPath, f);
    try {
      const parsed = parseExcelFile(fullPath, targetDate);
      const merged = mergeAndDeduplicateOrders(folderOrders, parsed.parsedOrders, targetDate);
      folderOrders = merged.orders;
      fileSummaries.push({
        file: f,
        orders: parsed.parsedOrders.length,
        hiddenSkipped: parsed.hiddenRows
      });
    } catch (err) {
      console.warn(`  ⚠️ อ่านไฟล์ ${f} ไม่สำเร็จ:`, err.message);
    }
  }

  // Fetch existing cloud batch for this date
  const cloudBatch = await SyncService.fetchCloudData(targetDate);
  const existingScans = cloudBatch && Array.isArray(cloudBatch.scans) ? cloudBatch.scans : [];
  const existingOrders = cloudBatch && Array.isArray(cloudBatch.orders) ? cloudBatch.orders : [];

  let finalOrders;
  if (replaceBloated) {
    // Use the exact clean orders from the day's folder as the source of truth
    finalOrders = folderOrders;
  } else {
    const mergedCloud = mergeAndDeduplicateOrders(existingOrders, folderOrders, targetDate);
    finalOrders = mergedCloud.orders;
  }

  // Reconcile existing scans with the clean orders
  reconcileScansWithOrders(existingScans, finalOrders, targetDate);

  // Push to Supabase Cloud
  const ok = await SyncService.pushCloudData(targetDate, finalOrders, existingScans, 'Folder Auto-Sync');
  return {
    date: targetDate,
    filesCount: files.length,
    fileSummaries,
    previousCloudOrders: existingOrders.length,
    finalOrdersCount: finalOrders.length,
    scansCount: existingScans.length,
    synced: ok
  };
}

async function syncMonthFolder(baseDir, monthFolderName, replaceBloated = true) {
  const yearMonth = parseMonthFolder(monthFolderName);
  if (!yearMonth) {
    console.log(`⏩ ข้ามโฟลเดอร์ "${monthFolderName}" (ไม่ตรงรูปแบบเดือน เช่น พย.26)`);
    return [];
  }

  const monthPath = path.join(baseDir, monthFolderName);
  if (!fs.existsSync(monthPath) || !fs.statSync(monthPath).isDirectory()) return [];

  console.log(`\n=============================================================`);
  console.log(`📂 กำลังซิงค์โฟลเดอร์เดือน: ${monthFolderName} (${yearMonth})`);
  console.log(`=============================================================`);

  const entries = fs.readdirSync(monthPath).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const results = [];

  for (const entry of entries) {
    const dayNum = parseInt(entry, 10);
    if (isNaN(dayNum) || dayNum < 1 || dayNum > 31) continue;

    const targetDate = `${yearMonth}-${String(dayNum).padStart(2, '0')}`;
    const dayPath = path.join(monthPath, entry);
    const res = await syncDayFolder(dayPath, targetDate, replaceBloated);
    if (res) {
      results.push(res);
      console.log(`✅ วันที่ ${res.date} (${res.filesCount} ไฟล์): นำเข้าสำเร็จ ${res.finalOrdersCount} ออเดอร์ (เดิมใน Cloud: ${res.previousCloudOrders} | สแกนแล้ว: ${res.scansCount})`);
      res.fileSummaries.forEach((fsItem) => {
        const hiddenNote = fsItem.hiddenSkipped > 0 ? ` [ข้ามแถวที่ซ่อนใน Filter ${fsItem.hiddenSkipped} แถว]` : '';
        console.log(`   └─ 📄 ${fsItem.file}: ${fsItem.orders} รายการ${hiddenNote}`);
      });
    }
  }

  return results;
}

async function runCli() {
  const args = process.argv.slice(2);
  const targetMonthArg = args.find((a) => !a.startsWith('--'));
  const isWatch = args.includes('--watch');
  const isAll = args.includes('--all');
  const baseDir = DEFAULT_BASE_DIR;

  if (!fs.existsSync(baseDir)) {
    console.error(`❌ ไม่พบโฟลเดอร์: ${baseDir}`);
    process.exit(1);
  }

  console.log(`=============================================================`);
  console.log(`🚀 QueenCosy Daily Parcel Checker - ระบบซิงค์โฟลเดอร์อัตโนมัติ`);
  console.log(`=============================================================`);

  if (targetMonthArg) {
    await syncMonthFolder(baseDir, targetMonthArg, true);
  } else {
    const monthDirs = fs.readdirSync(baseDir)
      .filter((d) => {
        const full = path.join(baseDir, d);
        return fs.statSync(full).isDirectory() && parseMonthFolder(d);
      })
      .sort((a, b) => parseMonthFolder(a).localeCompare(parseMonthFolder(b)));

    if (isAll) {
      for (const mDir of monthDirs) {
        await syncMonthFolder(baseDir, mDir, true);
      }
    } else if (monthDirs.length > 0) {
      // Sync the latest month folder by default (e.g., พย.26) for fast 2-second daily sync
      const latestMonth = monthDirs[monthDirs.length - 1];
      await syncMonthFolder(baseDir, latestMonth, true);
    }
  }

  console.log(`\n=============================================================`);
  console.log(`🎉 ซิงค์ข้อมูลขึ้น Cloud เสร็จสมบูรณ์! เปิดดูบนหน้าเว็บได้เลยครับ`);
  console.log(`=============================================================`);

  if (isWatch) {
    console.log(`\n👀 เปิดโหมดเฝ้าดูโฟลเดอร์อัตโนมัติ (Auto-Watch): ${baseDir}`);
    console.log(`   เมื่อคุณวางไฟล์ Excel ใหม่ในโฟลเดอร์วันที่ ระบบจะอัปเดตขึ้นเว็บให้อัตโนมัติทันที...`);
    let debounceTimer = null;
    fs.watch(baseDir, { recursive: true }, (eventType, filename) => {
      if (!filename || filename.includes('~$') || !/\.(xlsx|xls|csv)$/i.test(filename)) return;
      const parts = filename.split(path.sep);
      if (parts.length < 2) return;
      const monthFolder = parts[0];
      const dayFolder = parts[1];
      const yearMonth = parseMonthFolder(monthFolder);
      const dayNum = parseInt(dayFolder, 10);
      if (!yearMonth || isNaN(dayNum)) return;

      const targetDate = `${yearMonth}-${String(dayNum).padStart(2, '0')}`;
      const dayPath = path.join(baseDir, monthFolder, dayFolder);

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        console.log(`\n🔄 ตรวจพบการเปลี่ยนแปลงไฟล์ใน ${monthFolder}/${dayFolder} (${filename}) -> กำลังซิงค์วันที่ ${targetDate}...`);
        const res = await syncDayFolder(dayPath, targetDate, true);
        if (res) {
          console.log(`✨ ซิงค์อัตโนมัติสำเร็จ! วันที่ ${res.date}: รวม ${res.finalOrdersCount} ออเดอร์`);
        }
      }, 2500);
    });
  }
}

if (require.main === module) {
  runCli();
}

module.exports = { syncDayFolder, syncMonthFolder, parseMonthFolder };
