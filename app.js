/**
 * QueenCosy Daily Outgoing Parcel Checking System - Core Application
 * Translates and enhances Google Sheet logic:
 * - Tab 1: สรุปรายวัน (9 KPIs & Real-time Delivery Progress)
 * - Tab 2: รายการที่ต้องส่ง (Outgoing Orders with Auto-matching)
 * - Tab 3: รายการสแกน (Barcode Gun & Mobile Camera Scanner with Real-time Sync)
 */

(function () {
  'use strict';

  // Application State
  const state = {
    activeTab: 'tab-summary',
    activeDate: getTodayString(),
    orders: [],
    scans: [],
    scannerName: 'เจ้าหน้าที่คลัง',
    currentFilter: 'all', // 'all', 'missing', 'scanned', 'extra', 'issues'
    searchQuery: '',
    carrierFilter: 'all',
    mobileScannerActive: false
  };

  function getTodayString() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function normalizeTracking(str) {
    if (!str) return '';
    // Strip all spaces, non-breaking spaces (char 160), control chars, and uppercase
    return String(str)
      .replace(/[\s\u00A0\u200B-\u200D\uFEFF]/g, '')
      .toUpperCase();
  }

  // DOM Elements Helper
  const $ = (id) => document.getElementById(id);

  // Initialize Application
  window.addEventListener('DOMContentLoaded', () => {
    initApp();
  });

  function initApp() {
    // 1. Load saved data
    state.orders = SyncService.getLocalOrders();
    state.scans = SyncService.getLocalScans();

    const cfg = SyncService.getConfig();
    if (cfg.scannerName) {
      state.scannerName = cfg.scannerName;
      if ($('input-scanner-name')) $('input-scanner-name').value = state.scannerName;
      if ($('input-mobile-scanner-name')) $('input-mobile-scanner-name').value = state.scannerName;
    }

    // Set default date input
    if ($('selected-date')) {
      $('selected-date').value = state.activeDate;
    }

    // 2. Initialize Realtime Sync Callbacks
    SyncService.init({
      onRemoteScan: (remoteScan) => {
        handleRemoteScan(remoteScan);
      },
      onRemoteOrders: (remoteOrders) => {
        state.orders = remoteOrders;
        const count = reconcileScansAndOrders();
        renderAll();
        if (count > 0) {
          const toast = $('desktop-remote-toast');
          if (toast) {
            toast.innerText = `✨ ได้รับคำสั่งซื้อใหม่และจับคู่ย้อนหลังสำเร็จ ${count} รายการ`;
            toast.classList.remove('hidden');
            setTimeout(() => toast.classList.add('hidden'), 4000);
          }
        }
      }
    });

    // Run Initial Reconciliation in case orders or scans were imported previously
    reconcileScansAndOrders();

    // 3. Setup Event Listeners
    setupTabs();
    setupDateControls();
    setupBarcodeGunInput();
    setupCameraButtons();
    setupImportModal();
    setupExportButton();
    setupSampleDataButton();
    setupClearButton();
    setupQrConnectModal();
    setupFilters();
    setupReMatchButton();

    // 4. Check if Mobile View requested via URL hash
    if (window.location.hash === '#scanner' || window.innerWidth < 768) {
      switchTab('tab-scan');
    }

    // 5. Initial Render
    renderAll();
    lucide.createIcons();
  }

  // =========================================================================
  // TAB NAVIGATION & UI SWITCHING
  // =========================================================================
  function setupTabs() {
    const tabs = document.querySelectorAll('.tab-button');
    tabs.forEach((tab) => {
      tab.addEventListener('click', (e) => {
        const target = tab.dataset.tab;
        switchTab(target);
      });
    });
  }

  function switchTab(tabId) {
    state.activeTab = tabId;

    // Update Tab Buttons
    document.querySelectorAll('.tab-button').forEach((btn) => {
      if (btn.dataset.tab === tabId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Show/Hide Sections
    ['tab-summary', 'tab-orders', 'tab-scan'].forEach((id) => {
      const el = $(id);
      if (el) {
        if (id === tabId) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      }
    });

    // Focus Gun Input if on scan tab
    if (tabId === 'tab-scan') {
      const gunInput = $('input-barcode-gun');
      if (gunInput) {
        setTimeout(() => gunInput.focus(), 150);
      }
    } else {
      // If leaving scan tab, stop camera
      if (CameraScanner.isRunning()) {
        CameraScanner.stop();
        updateCameraButtons(false);
      }
    }

    lucide.createIcons();
  }

  function setupDateControls() {
    const dateInput = $('selected-date');
    if (dateInput) {
      dateInput.addEventListener('change', (e) => {
        state.activeDate = e.target.value || getTodayString();
        renderAll();
      });
    }

    const btnPrev = $('btn-prev-date');
    const btnNext = $('btn-next-date');
    const btnToday = $('btn-today-date');

    if (btnPrev) {
      btnPrev.addEventListener('click', () => {
        const d = new Date(state.activeDate);
        d.setDate(d.getDate() - 1);
        state.activeDate = formatDate(d);
        if (dateInput) dateInput.value = state.activeDate;
        renderAll();
      });
    }

    if (btnNext) {
      btnNext.addEventListener('click', () => {
        const d = new Date(state.activeDate);
        d.setDate(d.getDate() + 1);
        state.activeDate = formatDate(d);
        if (dateInput) dateInput.value = state.activeDate;
        renderAll();
      });
    }

    if (btnToday) {
      btnToday.addEventListener('click', () => {
        state.activeDate = getTodayString();
        if (dateInput) dateInput.value = state.activeDate;
        renderAll();
      });
    }
  }

  function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // =========================================================================
  // CORE CALCULATION ENGINE (GOOGLE SHEET FORMULAS IMPLEMENTATION)
  // =========================================================================
  function calculateKPIs() {
    const targetDate = state.activeDate;

    // Filter Outgoing Orders for Target Date
    const todayOrders = state.orders.filter((o) => o.shipDate === targetDate);

    // Map of clean tracking -> count in today's orders
    const orderTrackingCounts = {};
    todayOrders.forEach((o) => {
      const trk = o.cleanTracking;
      if (trk) {
        orderTrackingCounts[trk] = (orderTrackingCounts[trk] || 0) + 1;
      }
    });

    // 1. พัสดุต้องส่ง (Tracking ไม่ซ้ำ) - SUMIFS(M, N, Date)
    const uniqueOrdersCount = Object.keys(orderTrackingCounts).length;

    // Filter Scans for Target Date
    const todayScans = state.scans.filter((s) => s.scanDate === targetDate);

    // Map of clean tracking -> count of scans today
    const scanTrackingCounts = {};
    todayScans.forEach((s) => {
      const trk = s.cleanTracking;
      if (trk) {
        scanTrackingCounts[trk] = (scanTrackingCounts[trk] || 0) + 1;
      }
    });

    // 4. สแกนทั้งหมด (ครั้ง) - COUNTIFS(K, Date, E, "<>")
    const totalScansCount = todayScans.filter((s) => Boolean(s.cleanTracking)).length;

    // 5. สแกนเลขไม่ซ้ำ (พัสดุ) - SUMIFS(J, K, Date)
    const uniqueScansCount = Object.keys(scanTrackingCounts).length;

    // 2. พบสแกนตรงวันแล้ว (พัสดุ) - Outgoing orders with at least 1 scan today
    let scannedOrdersCount = 0;
    Object.keys(orderTrackingCounts).forEach((trk) => {
      if (scanTrackingCounts[trk] && scanTrackingCounts[trk] > 0) {
        scannedOrdersCount++;
      }
    });

    // 3. ยังไม่สแกน / ตกหล่น (พัสดุ) = uniqueOrdersCount - scannedOrdersCount
    const notScannedOrdersCount = Math.max(0, uniqueOrdersCount - scannedOrdersCount);

    // 6. สแกนเกินรายการส่ง (พัสดุ) - Unique scans not present in today's orders
    let extraScansCount = 0;
    Object.keys(scanTrackingCounts).forEach((trk) => {
      if (!orderTrackingCounts[trk]) {
        extraScansCount++;
      }
    });

    // 7. สแกนซ้ำในวันเดียวกัน (ครั้งเกิน) = totalScansCount - uniqueScansCount
    const duplicateScansCount = Math.max(0, totalScansCount - uniqueScansCount);

    // 8. แถวรายการส่งที่ Tracking ซ้ำ = COUNTIFS(N, Date, K, "Tracking ซ้ำ")
    let duplicateOrdersCount = 0;
    todayOrders.forEach((o) => {
      if (o.cleanTracking && orderTrackingCounts[o.cleanTracking] > 1) {
        duplicateOrdersCount++;
      }
    });

    // 9. ข้อมูลไม่ครบ / จำนวนผิด (ทุกวัน)
    let invalidDataCount = 0;
    state.orders.forEach((o) => {
      const status = getOrderStatus(o);
      if (status === 'ข้อมูลไม่ครบ/รูปแบบผิด' || status === 'ตรวจจำนวนสินค้า') {
        invalidDataCount++;
      }
    });

    // Completion Rate %
    const completionRate = uniqueOrdersCount > 0 ? ((scannedOrdersCount / uniqueOrdersCount) * 100).toFixed(1) : 0;

    return {
      uniqueOrdersCount,
      scannedOrdersCount,
      notScannedOrdersCount,
      totalScansCount,
      uniqueScansCount,
      extraScansCount,
      duplicateScansCount,
      duplicateOrdersCount,
      invalidDataCount,
      completionRate
    };
  }

  // Get verification status for an order row (Matching Google Sheet Col L formula)
  function getOrderStatus(order) {
    if (!order.shipDate || !order.orderId || !order.cleanTracking || !order.sku || order.qty === undefined || order.qty === null || order.qty === '') {
      return 'ข้อมูลไม่ครบ/รูปแบบผิด';
    }
    const numQty = Number(order.qty);
    if (isNaN(numQty) || numQty <= 0 || !Number.isInteger(numQty)) {
      return 'ตรวจจำนวนสินค้า';
    }

    // Check duplicate in same date's orders
    const sameDateOrders = state.orders.filter((o) => o.shipDate === order.shipDate && o.cleanTracking === order.cleanTracking);
    if (sameDateOrders.length > 1) {
      return 'ตรวจ Tracking ซ้ำ';
    }

    // Count scans for this tracking on this ship date
    const scanCount = state.scans.filter((s) => s.scanDate === order.shipDate && s.cleanTracking === order.cleanTracking).length;

    if (scanCount === 0) {
      return 'ยังไม่สแกน / ตกหล่น';
    } else if (scanCount > 1) {
      return 'สแกนซ้ำ';
    } else {
      return 'สแกนแล้ว';
    }
  }

  // =========================================================================
  // DYNAMIC RECONCILIATION & RESOLUTION ENGINE (TWO-WAY RETROACTIVE MATCHING)
  // =========================================================================
  function resolveScanMatch(scan) {
    const targetDate = scan.scanDate;
    const clean = scan.cleanTracking;
    if (!clean) return { result: 'ข้อมูลไม่ครบ/รูปแบบผิด', order: null, statusType: 'invalid' };

    const matchedOrders = state.orders.filter((o) => o.shipDate === targetDate && o.cleanTracking === clean);
    const totalOrdersThisDate = state.orders.filter((o) => o.shipDate === targetDate).length;

    if (matchedOrders.length === 1) {
      return {
        result: 'พบในรายการส่ง',
        order: matchedOrders[0],
        statusType: 'matched'
      };
    } else if (matchedOrders.length > 1) {
      return {
        result: 'รายการส่งซ้ำ',
        order: matchedOrders[0],
        statusType: 'dup_order'
      };
    } else {
      if (totalOrdersThisDate === 0) {
        return {
          result: 'รอนำเข้าคำสั่งซื้อ',
          order: null,
          statusType: 'pending_orders'
        };
      } else {
        return {
          result: 'ไม่พบในรายการส่งของวันนี้',
          order: null,
          statusType: 'unmatched'
        };
      }
    }
  }

  function reconcileScansAndOrders() {
    let reMatchedCount = 0;
    state.scans.forEach((scan) => {
      const resolution = resolveScanMatch(scan);
      if (resolution.order) {
        if (!scan.matchedOrderId || scan.matchedOrderId !== resolution.order.orderId || scan.matchResult !== resolution.result) {
          scan.matchedOrderId = resolution.order.orderId;
          scan.matchedSku = resolution.order.sku;
          scan.matchedQty = resolution.order.qty;
          scan.matchedCarrier = resolution.order.carrier;
          scan.matchResult = resolution.result;
          reMatchedCount++;
        }
      } else {
        if (scan.matchResult !== resolution.result) {
          scan.matchResult = resolution.result;
          scan.matchedOrderId = '';
          scan.matchedSku = '';
          scan.matchedQty = '';
          scan.matchedCarrier = '';
        }
      }
    });

    if (reMatchedCount > 0) {
      SyncService.saveLocalScans(state.scans);
    }
    return reMatchedCount;
  }

  // =========================================================================
  // BARCODE SCANNING & AUTO-MATCHING ENGINE
  // =========================================================================
  async function processScannedBarcode(rawBarcode, source = 'ปืนสแกน') {
    AudioFeedback.init(); // Ensure Web Audio context is alive

    const clean = normalizeTracking(rawBarcode);
    if (!clean) return;

    const targetDate = state.activeDate;
    const scannerName = (source.includes('มือถือ') ? ($('input-mobile-scanner-name')?.value || state.scannerName) : ($('input-scanner-name')?.value || state.scannerName)).trim() || 'พนักงานคลัง';

    state.scannerName = scannerName;
    SyncService.saveConfig({ ...SyncService.getConfig(), scannerName });

    // Check if this tracking was already scanned today
    const existingScansToday = state.scans.filter((s) => s.scanDate === targetDate && s.cleanTracking === clean);
    const isDuplicate = existingScansToday.length > 0;

    // Dynamically resolve match against today's orders
    const dummyScan = { scanDate: targetDate, cleanTracking: clean };
    const resolution = resolveScanMatch(dummyScan);
    const matchedOrder = resolution.order;
    const matchResult = resolution.result;

    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];

    const newScanRecord = {
      id: 'SCAN-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      scanDate: targetDate,
      scanTime: timeStr,
      trackingId: rawBarcode.trim(),
      cleanTracking: clean,
      scanner: scannerName,
      source: source,
      matchResult: matchResult,
      isDuplicateScan: isDuplicate,
      matchedOrderId: matchedOrder ? matchedOrder.orderId : '',
      matchedSku: matchedOrder ? matchedOrder.sku : '',
      matchedQty: matchedOrder ? matchedOrder.qty : '',
      matchedCarrier: matchedOrder ? matchedOrder.carrier : ''
    };

    // Save and broadcast to all devices
    SyncService.addLocalScan(newScanRecord);
    state.scans.unshift(newScanRecord);

    // Trigger Audio & Visual HUD Feedback
    const matchedCount = state.orders.filter((o) => o.shipDate === targetDate && o.cleanTracking === clean).length;
    showScanFeedback(newScanRecord, isDuplicate, matchedCount);

    // Re-render UI
    renderAll();
  }

  function showScanFeedback(scanRecord, isDuplicate, matchCount) {
    const hud = $('scan-hud-banner');
    const hudMobile = $('scan-hud-mobile');

    let bgClass = '';
    let iconName = '';
    let title = '';
    let subtitle = '';

    if (scanRecord.matchResult === 'พบในรายการส่ง') {
      if (!isDuplicate) {
        // SUCCESS ✅
        AudioFeedback.success();
        CameraScanner.flashBox('success');
        bgClass = 'bg-emerald-50 border-emerald-500 text-emerald-900';
        iconName = 'check-circle-2';
        title = `สแกนสำเร็จ: ${scanRecord.trackingId}`;
        subtitle = `คำสั่งซื้อ: ${scanRecord.matchedOrderId || '-'} | ขนส่ง: ${scanRecord.matchedCarrier || '-'} | สินค้า: ${scanRecord.matchedSku || '-'} (${scanRecord.matchedQty || 1} ชิ้น)`;
      } else {
        // DUPLICATE SCAN 🔁
        AudioFeedback.duplicate();
        CameraScanner.flashBox('duplicate');
        bgClass = 'bg-amber-50 border-amber-500 text-amber-900';
        iconName = 'alert-triangle';
        title = `⚠️ สแกนซ้ำ: ${scanRecord.trackingId}`;
        subtitle = `เลขพัสดุนี้ถูกสแกนไปแล้วในวันนี้! (คำสั่งซื้อ: ${scanRecord.matchedOrderId || '-'})`;
      }
    } else if (scanRecord.matchResult === 'รอนำเข้าคำสั่งซื้อ') {
      // PENDING ORDERS IMPORT ⏳ (Scan before order manifest is keyed)
      AudioFeedback.warning();
      CameraScanner.flashBox('duplicate');
      bgClass = 'bg-sky-50 border-sky-500 text-sky-900';
      iconName = 'clock';
      title = `📦 บันทึกการสแกนแล้ว: ${scanRecord.trackingId}`;
      subtitle = `บันทึกเวลาเรียบร้อย (ยังไม่มีคำสั่งซื้อในระบบ ระบบจะจับคู่ย้อนหลังให้อัตโนมัติเมื่อคีย์ข้อมูลเข้า)`;
    } else if (scanRecord.matchResult === 'ไม่พบในรายการส่งของวันนี้') {
      // NOT FOUND 🚨
      AudioFeedback.error();
      CameraScanner.flashBox('error');
      bgClass = 'bg-rose-50 border-rose-500 text-rose-900';
      iconName = 'x-circle';
      title = `🚨 ไม่พบในรายการส่งวันนี้: ${scanRecord.trackingId}`;
      subtitle = `ไม่อยู่ในรายการส่งของวันที่ ${state.activeDate} (หากยังไม่ได้คีย์เข้าระบบ เมื่อคีย์เข้าแล้วระบบจะจับคู่ย้อนหลังให้อัตโนมัติ)`;
    } else {
      // DUPLICATE IN ORDER LIST ⚠️
      AudioFeedback.warning();
      CameraScanner.flashBox('duplicate');
      bgClass = 'bg-purple-50 border-purple-500 text-purple-900';
      iconName = 'help-circle';
      title = `⚠️ คำสั่งซื้อซ้ำ: ${scanRecord.trackingId}`;
      subtitle = `พบเลขพัสดุนี้ซ้ำในรายการส่ง ${matchCount} รายการ! กรุณาตรวจสอบแท็บคำสั่งซื้อ`;
    }

    [hud, hudMobile].forEach((el) => {
      if (!el) return;
      el.className = `p-3.5 rounded-xl border-2 flex items-start gap-3 shadow-md transition-all ${bgClass}`;
      el.innerHTML = `
        <div class="shrink-0 mt-0.5"><i data-lucide="${iconName}" class="w-6 h-6"></i></div>
        <div class="flex-1 min-w-0">
          <div class="font-bold text-sm sm:text-base tracking-tight leading-snug">${escapeHtml(title)}</div>
          <div class="text-xs sm:text-sm mt-0.5 opacity-90 leading-tight truncate">${escapeHtml(subtitle)}</div>
        </div>
      `;
    });

    lucide.createIcons();
  }

  function handleRemoteScan(remoteScan) {
    // Received scan from another device via Supabase/BroadcastChannel
    // Check if we already have it
    const exists = state.scans.some((s) => s.id === remoteScan.id);
    if (!exists) {
      state.scans.unshift(remoteScan);
      SyncService.saveLocalScans(state.scans);
      renderAll();

      // Show brief notification on desktop
      const toast = $('desktop-remote-toast');
      if (toast) {
        toast.innerText = `📲 มือถือ (${remoteScan.scanner}) สแกน: ${remoteScan.trackingId}`;
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 3500);
      }
    }
  }

  // =========================================================================
  // BARCODE GUN & CAMERA CONTROLS
  // =========================================================================
  function setupBarcodeGunInput() {
    const input = $('input-barcode-gun');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = input.value.trim();
          if (val) {
            processScannedBarcode(val, 'ปืนสแกน');
            input.value = '';
          }
        }
      });
    }

    // Auto-focus button
    const btnFocus = $('btn-refocus-gun');
    if (btnFocus && input) {
      btnFocus.addEventListener('click', () => {
        input.focus();
      });
    }
  }

  function setupCameraButtons() {
    // Desktop Camera Toggle
    const btnCam = $('btn-toggle-camera');
    if (btnCam) {
      btnCam.addEventListener('click', async () => {
        if (CameraScanner.isRunning()) {
          await CameraScanner.stop();
          updateCameraButtons(false);
        } else {
          const ok = await CameraScanner.start('reader', 'camera-box', (decodedText) => {
            processScannedBarcode(decodedText, 'กล้องเว็บแคม');
          });
          updateCameraButtons(ok);
        }
      });
    }

    // Mobile Camera Toggle
    const btnMobileCam = $('btn-toggle-mobile-camera');
    if (btnMobileCam) {
      btnMobileCam.addEventListener('click', async () => {
        if (CameraScanner.isRunning()) {
          await CameraScanner.stop();
          updateCameraButtons(false);
        } else {
          const ok = await CameraScanner.start('reader-mobile', 'camera-box-mobile', (decodedText) => {
            processScannedBarcode(decodedText, 'กล้องมือถือ');
          });
          updateCameraButtons(ok);
        }
      });
    }
  }

  function updateCameraButtons(running) {
    const btnCam = $('btn-toggle-camera');
    const btnMobileCam = $('btn-toggle-mobile-camera');

    if (btnCam) {
      btnCam.innerHTML = running
        ? '<i data-lucide="camera-off" class="w-4 h-4"></i> ปิดกล้องสแกน'
        : '<i data-lucide="camera" class="w-4 h-4"></i> เปิดกล้องสแกนเนอร์';
    }
    if (btnMobileCam) {
      btnMobileCam.innerHTML = running
        ? '<i data-lucide="camera-off" class="w-4 h-4"></i> ปิดกล้อง'
        : '<i data-lucide="camera" class="w-4 h-4"></i> เปิดกล้องสแกนเนอร์';
    }
    lucide.createIcons();
  }

  // =========================================================================
  // RENDERING ENGINE
  // =========================================================================
  function renderAll() {
    renderKPIs();
    renderOrdersTable();
    renderScansTable();
    updateCarrierDropdown();
  }

  function renderKPIs() {
    const kpis = calculateKPIs();

    // 1. Unique Orders (พัสดุต้องส่ง)
    if ($('kpi-unique-orders')) $('kpi-unique-orders').innerText = kpis.uniqueOrdersCount.toLocaleString();

    // 2. Scanned Today (พบสแกนตรงวันแล้ว)
    if ($('kpi-scanned-orders')) $('kpi-scanned-orders').innerText = kpis.scannedOrdersCount.toLocaleString();

    // 3. Not Scanned / Missing (ยังไม่สแกน / ตกหล่น) - Alert highlight!
    const elMissing = $('kpi-missing-orders');
    if (elMissing) {
      elMissing.innerText = kpis.notScannedOrdersCount.toLocaleString();
      if (kpis.notScannedOrdersCount > 0) {
        elMissing.parentElement.classList.add('border-rose-400', 'bg-rose-50/40');
      } else {
        elMissing.parentElement.classList.remove('border-rose-400', 'bg-rose-50/40');
      }
    }

    // 4. Total Scans (สแกนทั้งหมด ครั้ง)
    if ($('kpi-total-scans')) $('kpi-total-scans').innerText = kpis.totalScansCount.toLocaleString();

    // 5. Unique Scans (สแกนเลขไม่ซ้ำ พัสดุ)
    if ($('kpi-unique-scans')) $('kpi-unique-scans').innerText = kpis.uniqueScansCount.toLocaleString();

    // 6. Extra Scans (สแกนเกินรายการส่ง พัสดุ)
    if ($('kpi-extra-scans')) $('kpi-extra-scans').innerText = kpis.extraScansCount.toLocaleString();

    // 7. Duplicate Scans (สแกนซ้ำในวันเดียวกัน ครั้งเกิน)
    if ($('kpi-duplicate-scans')) $('kpi-duplicate-scans').innerText = kpis.duplicateScansCount.toLocaleString();

    // 8. Duplicate in Orders (Tracking ซ้ำในรายการส่ง)
    if ($('kpi-duplicate-orders')) $('kpi-duplicate-orders').innerText = kpis.duplicateOrdersCount.toLocaleString();

    // 9. Invalid Data (ข้อมูลไม่ครบ / จำนวนผิด)
    if ($('kpi-invalid-data')) $('kpi-invalid-data').innerText = kpis.invalidDataCount.toLocaleString();

    // Progress Bar & Percentage
    const progressBar = $('progress-bar-fill');
    const progressText = $('progress-bar-text');
    const progressDetail = $('progress-bar-detail');

    if (progressBar) {
      progressBar.style.width = `${kpis.completionRate}%`;
    }
    if (progressText) {
      progressText.innerText = `${kpis.completionRate}%`;
    }
    if (progressDetail) {
      progressDetail.innerText = `ส่งมอบแล้ว ${kpis.scannedOrdersCount} จาก ${kpis.uniqueOrdersCount} กล่อง`;
    }

    // Update Quick Filter Badges
    if ($('badge-count-all')) $('badge-count-all').innerText = kpis.uniqueOrdersCount;
    if ($('badge-count-missing')) $('badge-count-missing').innerText = kpis.notScannedOrdersCount;
    if ($('badge-count-scanned')) $('badge-count-scanned').innerText = kpis.scannedOrdersCount;
    if ($('badge-count-extra')) $('badge-count-extra').innerText = kpis.extraScansCount;
  }

  function renderOrdersTable() {
    const tbody = $('orders-table-body');
    if (!tbody) return;

    const targetDate = state.activeDate;
    let list = state.orders.filter((o) => o.shipDate === targetDate);

    // Apply Filter
    if (state.currentFilter === 'missing') {
      list = list.filter((o) => getOrderStatus(o) === 'ยังไม่สแกน / ตกหล่น');
    } else if (state.currentFilter === 'scanned') {
      list = list.filter((o) => getOrderStatus(o) === 'สแกนแล้ว' || getOrderStatus(o) === 'สแกนซ้ำ');
    } else if (state.currentFilter === 'issues') {
      list = list.filter((o) => {
        const s = getOrderStatus(o);
        return s === 'ตรวจ Tracking ซ้ำ' || s === 'ข้อมูลไม่ครบ/รูปแบบผิด' || s === 'ตรวจจำนวนสินค้า';
      });
    }

    // Apply Carrier Filter
    if (state.carrierFilter !== 'all') {
      list = list.filter((o) => o.carrier === state.carrierFilter);
    }

    // Apply Search Query
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      list = list.filter((o) =>
        (o.orderId && o.orderId.toLowerCase().includes(q)) ||
        (o.trackingId && o.trackingId.toLowerCase().includes(q)) ||
        (o.sku && o.sku.toLowerCase().includes(q)) ||
        (o.carrier && o.carrier.toLowerCase().includes(q)) ||
        (o.packer && o.packer.toLowerCase().includes(q))
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="py-12 text-center text-slate-400">
            <i data-lucide="package-search" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>
            <div>ไม่พบรายการคำสั่งซื้อของวันที่ ${state.activeDate}</div>
            <div class="text-xs text-slate-400 mt-1">กดปุ่ม "วางรายการจาก Excel" หรือ "โหลดข้อมูลตัวอย่าง" เพื่อเริ่มต้น</div>
          </td>
        </tr>
      `;
      lucide.createIcons();
      return;
    }

    let html = '';
    list.forEach((order, idx) => {
      const status = getOrderStatus(order);
      const badge = getStatusBadge(status);
      const scanCount = state.scans.filter((s) => s.scanDate === targetDate && s.cleanTracking === order.cleanTracking).length;

      let rowClass = 'hover:bg-slate-50 transition-colors';
      if (status === 'สแกนแล้ว') {
        rowClass += ' row-scanned';
      } else if (status === 'ยังไม่สแกน / ตกหล่น') {
        rowClass += ' row-missing';
      }

      html += `
        <tr class="${rowClass} border-b border-slate-100">
          <td class="py-3 px-3.5 text-xs text-slate-400 font-mono text-center">${idx + 1}</td>
          <td class="py-3 px-3.5 text-xs font-semibold text-slate-800 font-mono">${escapeHtml(order.orderId || '-')}</td>
          <td class="py-3 px-3.5 text-xs font-bold text-slate-900 font-mono tracking-wide">
            ${escapeHtml(order.trackingId || '-')}
          </td>
          <td class="py-3 px-3.5 text-xs text-slate-700 max-w-[200px] truncate" title="${escapeHtml(order.sku || '')}">${escapeHtml(order.sku || '-')}</td>
          <td class="py-3 px-3.5 text-xs text-center font-bold text-slate-800">${escapeHtml(String(order.qty || 1))}</td>
          <td class="py-3 px-3.5 text-xs">
            <span class="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">${escapeHtml(order.carrier || 'ทั่วไป')}</span>
          </td>
          <td class="py-3 px-3.5 text-xs text-slate-600">${escapeHtml(order.packer || '-')}</td>
          <td class="py-3 px-3.5 text-center">${badge}</td>
          <td class="py-3 px-3.5 text-center text-xs">
            <button class="btn-delete-order p-1 hover:text-rose-600 rounded text-slate-400" data-id="${order.id}" title="ลบรายการนี้">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
    lucide.createIcons();

    // Setup Delete Buttons
    tbody.querySelectorAll('.btn-delete-order').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = btn.dataset.id;
        deleteOrder(id);
      });
    });
  }

  function renderScansTable() {
    const tbody = $('scans-table-body');
    if (!tbody) return;

    const targetDate = state.activeDate;
    const todayScans = state.scans.filter((s) => s.scanDate === targetDate);

    if (todayScans.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="py-10 text-center text-slate-400">
            <i data-lucide="scan-barcode" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>
            <div>ยังไม่มีการสแกนพัสดุในวันที่ ${state.activeDate}</div>
            <div class="text-xs text-slate-400 mt-0.5">ใช้ปืนสแกนเนอร์หรือเปิดกล้องเพื่อเริ่มยิงพัสดุ</div>
          </td>
        </tr>
      `;
      lucide.createIcons();
      return;
    }

    let html = '';
    todayScans.forEach((scan, idx) => {
      const match = resolveScanMatch(scan);
      const matchBadge = getScanMatchBadge(match.result, scan.isDuplicateScan);
      const displayOrderId = match.order ? match.order.orderId : (scan.matchedOrderId || '-');
      const displaySku = match.order 
        ? `${match.order.sku} (${match.order.qty} ชิ้น)` 
        : (scan.matchedSku ? `${scan.matchedSku} (${scan.matchedQty} ชิ้น)` : '-');
      const displayCarrier = match.order ? match.order.carrier : (scan.matchedCarrier || '');

      html += `
        <tr class="hover:bg-slate-50 transition-colors border-b border-slate-100">
          <td class="py-2.5 px-3.5 text-xs text-slate-400 font-mono text-center">${todayScans.length - idx}</td>
          <td class="py-2.5 px-3.5 text-xs font-mono font-medium text-slate-600">${escapeHtml(scan.scanTime || '')}</td>
          <td class="py-2.5 px-3.5 text-xs font-bold text-slate-900 font-mono tracking-wider">${escapeHtml(scan.trackingId)}</td>
          <td class="py-2.5 px-3.5 text-xs font-mono font-semibold text-slate-800">${escapeHtml(displayOrderId)}</td>
          <td class="py-2.5 px-3.5 text-xs text-slate-600">
            ${escapeHtml(displaySku)}
            ${displayCarrier ? `<span class="ml-1 text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 font-medium">${escapeHtml(displayCarrier)}</span>` : ''}
          </td>
          <td class="py-2.5 px-3.5 text-xs text-slate-600">
            <span class="inline-flex items-center gap-1">
              <i data-lucide="${scan.source.includes('มือถือ') ? 'smartphone' : 'barcode'}" class="w-3.5 h-3.5 text-slate-400"></i>
              ${escapeHtml(scan.scanner || '-')}
            </span>
          </td>
          <td class="py-2.5 px-3.5 text-center">${matchBadge}</td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
    lucide.createIcons();
  }

  function getStatusBadge(status) {
    if (status === 'สแกนแล้ว') {
      return '<span class="badge-status bg-emerald-50 text-emerald-700 border-emerald-300"><i data-lucide="check" class="w-3.5 h-3.5"></i> สแกนแล้ว</span>';
    } else if (status === 'ยังไม่สแกน / ตกหล่น') {
      return '<span class="badge-status bg-rose-50 text-rose-700 border-rose-300 font-bold"><i data-lucide="alert-circle" class="w-3.5 h-3.5"></i> ตกหล่น / ยังไม่สแกน</span>';
    } else if (status === 'สแกนซ้ำ') {
      return '<span class="badge-status bg-purple-50 text-purple-700 border-purple-300"><i data-lucide="repeat" class="w-3.5 h-3.5"></i> สแกนซ้ำ</span>';
    } else if (status === 'ตรวจ Tracking ซ้ำ') {
      return '<span class="badge-status bg-rose-100 text-rose-800 border-rose-400 font-bold"><i data-lucide="copy" class="w-3.5 h-3.5"></i> ตรวจ Tracking ซ้ำ</span>';
    } else {
      return `<span class="badge-status bg-amber-50 text-amber-700 border-amber-300">${escapeHtml(status)}</span>`;
    }
  }

  function getScanMatchBadge(matchResult, isDuplicate) {
    if (matchResult === 'พบในรายการส่ง') {
      if (!isDuplicate) {
        return '<span class="badge-status bg-emerald-50 text-emerald-700 border-emerald-300 font-bold"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> พบในรายการส่ง</span>';
      } else {
        return '<span class="badge-status bg-amber-50 text-amber-800 border-amber-300"><i data-lucide="repeat" class="w-3.5 h-3.5"></i> สแกนซ้ำตรงวัน</span>';
      }
    } else if (matchResult === 'รอนำเข้าคำสั่งซื้อ') {
      return '<span class="badge-status bg-sky-50 text-sky-700 border-sky-300 font-semibold"><i data-lucide="clock" class="w-3.5 h-3.5"></i> รอนำเข้าออเดอร์</span>';
    } else if (matchResult === 'ไม่พบในรายการส่งของวันนี้') {
      return '<span class="badge-status bg-rose-50 text-rose-700 border-rose-300 font-bold"><i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i> ไม่พบในรายการส่ง</span>';
    } else {
      return `<span class="badge-status bg-purple-50 text-purple-700 border-purple-300">${escapeHtml(matchResult)}</span>`;
    }
  }

  function updateCarrierDropdown() {
    const sel = $('filter-carrier');
    if (!sel) return;

    const current = sel.value;
    const carriers = new Set();
    state.orders.forEach((o) => {
      if (o.carrier) carriers.add(o.carrier.trim());
    });

    let opts = '<option value="all">ขนส่งทั้งหมด</option>';
    carriers.forEach((c) => {
      opts += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`;
    });
    sel.innerHTML = opts;
    sel.value = current || 'all';
  }

  // =========================================================================
  // DATA IMPORT & EXPORT
  // =========================================================================
  function setupImportModal() {
    const btnOpen = $('btn-open-import');
    const modal = $('modal-import');
    const btnClose = $('btn-close-import');
    const btnApply = $('btn-apply-import');
    const textarea = $('textarea-import-data');
    const fileInput = $('file-import-excel');

    if (btnOpen && modal) {
      btnOpen.addEventListener('click', () => {
        modal.classList.remove('hidden');
        if (textarea) textarea.focus();
      });
    }

    if (btnClose && modal) {
      btnClose.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }

    // Apply Imported Data
    if (btnApply && textarea) {
      btnApply.addEventListener('click', () => {
        const text = textarea.value.trim();
        if (!text) {
          alert('กรุณาวางข้อมูลก่อนกดยืนยัน');
          return;
        }

        const newOrders = parsePastedOrders(text);
        if (newOrders.length === 0) {
          alert('ไม่พบแถวข้อมูลที่ถูกต้อง กรุณาคัดลอกทั้งคอลัมน์จาก Excel (วัน/คำสั่งซื้อ/เลขพัสดุ/สินค้า/จำนวน/ขนส่ง)');
          return;
        }

        // Add to state and save
        state.orders = state.orders.concat(newOrders);
        const reMatched = reconcileScansAndOrders();
        SyncService.saveLocalOrders(state.orders);

        textarea.value = '';
        if (modal) modal.classList.add('hidden');

        renderAll();
        if (reMatched > 0) {
          alert(`นำเข้ารายการคำสั่งซื้อสำเร็จ ${newOrders.length} รายการ!\n\n✨ ระบบได้จับคู่ย้อนหลังกับพัสดุที่สแกนไว้ก่อนหน้านี้สำเร็จ ${reMatched} รายการเรียบร้อยแล้วครับ!`);
        } else {
          alert(`นำเข้ารายการคำสั่งซื้อสำเร็จ ${newOrders.length} รายการ!`);
        }
      });
    }

    // File Upload Handler
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const data = new Uint8Array(evt.target.result);
            const workbook = XLSX.read(data, { type: 'array' });

            // Look for sheet 'รายการที่ต้องส่ง' or first sheet
            let sheetName = workbook.SheetNames.find((s) => s.includes('รายการที่ต้องส่ง')) || workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

            const newOrders = parseExcelRows(rows);
            if (newOrders.length > 0) {
              state.orders = state.orders.concat(newOrders);
              const reMatched = reconcileScansAndOrders();
              SyncService.saveLocalOrders(state.orders);
              renderAll();
              if (reMatched > 0) {
                alert(`นำเข้าจากไฟล์ ${file.name} สำเร็จ ${newOrders.length} รายการ!\n\n✨ ระบบได้จับคู่ย้อนหลังกับพัสดุที่สแกนไว้ก่อนหน้านี้สำเร็จ ${reMatched} รายการเรียบร้อยแล้วครับ!`);
              } else {
                alert(`นำเข้าจากไฟล์ ${file.name} สำเร็จ ${newOrders.length} รายการ!`);
              }
              if (modal) modal.classList.add('hidden');
            } else {
              alert('ไม่พบข้อมูลรายการที่ตรงตามโครงสร้าง');
            }
          } catch (err) {
            alert('เกิดข้อผิดพลาดในการอ่านไฟล์ Excel: ' + err.message);
          }
        };
        reader.readAsArrayBuffer(file);
      });
    }
  }

  function setupReMatchButton() {
    const btn = $('btn-re-match');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const reMatched = reconcileScansAndOrders();
      renderAll();
      alert(`🔄 ตรวจสอบและประมวลผลการจับคู่ข้อมูลเรียบร้อย!\nพัสดุที่ตรงกับคำสั่งซื้อ: ${reMatched} รายการ`);
    });
  }

  function parsePastedOrders(text) {
    const lines = text.split(/\r?\n/);
    const result = [];
    const targetDate = state.activeDate;

    lines.forEach((line) => {
      const cols = line.split('\t');
      if (cols.length < 2) return;

      // Skip header row if pasted
      const col0 = (cols[0] || '').trim();
      const col1 = (cols[1] || '').trim();
      const col2 = (cols[2] || '').trim();

      if (col0.includes('วันที่') || col1.includes('Order') || col2.includes('Tracking')) {
        return;
      }

      let date = targetDate;
      let orderId = '';
      let tracking = '';
      let sku = '';
      let qty = 1;
      let carrier = '';
      let packer = '';
      let notes = '';

      if (cols.length >= 6) {
        // Standard full format (Date, OrderID, TrackingID, SKU, Qty, Carrier, Packer, Notes)
        date = parseDateCell(cols[0]) || targetDate;
        orderId = cols[1] ? cols[1].trim() : '';
        tracking = cols[2] ? cols[2].trim() : '';
        sku = cols[3] ? cols[3].trim() : '';
        qty = parseInt(cols[4], 10) || 1;
        carrier = cols[5] ? cols[5].trim() : '';
        packer = cols[6] ? cols[6].trim() : '';
        notes = cols[7] ? cols[7].trim() : '';
      } else if (cols.length >= 3) {
        // OrderID, TrackingID, SKU
        orderId = cols[0].trim();
        tracking = cols[1].trim();
        sku = cols[2].trim();
        qty = parseInt(cols[3], 10) || 1;
        carrier = cols[4] ? cols[4].trim() : '';
      } else {
        // Just OrderID, Tracking
        orderId = cols[0].trim();
        tracking = cols[1].trim();
      }

      const cleanTrk = normalizeTracking(tracking);
      if (orderId || cleanTrk) {
        result.push({
          id: 'ORD-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
          shipDate: date,
          orderId: orderId,
          trackingId: tracking,
          cleanTracking: cleanTrk,
          sku: sku || 'โซฟา/เก้าอี้สตูล',
          qty: qty,
          carrier: carrier || 'Flash Express',
          packer: packer || 'ทีมแพ็ค',
          notes: notes
        });
      }
    });

    return result;
  }

  function parseExcelRows(rows) {
    if (!rows || rows.length < 2) return [];

    const result = [];
    const targetDate = state.activeDate;

    // Check header row (row 0)
    const header = rows[0].map((h) => String(h || '').trim().toLowerCase());
    let idxDate = header.findIndex((h) => h.includes('วัน'));
    let idxOrder = header.findIndex((h) => h.includes('order'));
    let idxTrack = header.findIndex((h) => h.includes('track'));
    let idxSku = header.findIndex((h) => h.includes('sku') || h.includes('สินค้า'));
    let idxQty = header.findIndex((h) => h.includes('จำนวน'));
    let idxCarrier = header.findIndex((h) => h.includes('ขนส่ง'));
    let idxPacker = header.findIndex((h) => h.includes('ผู้จัด') || h.includes('แพ็ค'));

    // Default indices if not named
    if (idxDate === -1) idxDate = 0;
    if (idxOrder === -1) idxOrder = 1;
    if (idxTrack === -1) idxTrack = 2;
    if (idxSku === -1) idxSku = 3;
    if (idxQty === -1) idxQty = 4;
    if (idxCarrier === -1) idxCarrier = 5;
    if (idxPacker === -1) idxPacker = 6;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length === 0) continue;

      const rawTrack = row[idxTrack] ? String(row[idxTrack]).trim() : '';
      const rawOrder = row[idxOrder] ? String(row[idxOrder]).trim() : '';
      if (!rawTrack && !rawOrder) continue;

      const dateVal = parseDateCell(row[idxDate]) || targetDate;
      const cleanTrk = normalizeTracking(rawTrack);

      result.push({
        id: 'ORD-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7) + '-' + r,
        shipDate: dateVal,
        orderId: rawOrder,
        trackingId: rawTrack,
        cleanTracking: cleanTrk,
        sku: row[idxSku] ? String(row[idxSku]).trim() : '',
        qty: parseInt(row[idxQty], 10) || 1,
        carrier: row[idxCarrier] ? String(row[idxCarrier]).trim() : '',
        packer: row[idxPacker] ? String(row[idxPacker]).trim() : '',
        notes: ''
      });
    }

    return result;
  }

  function parseDateCell(cellVal) {
    if (!cellVal) return '';
    if (typeof cellVal === 'number') {
      // Excel serial date number
      const d = XLSX.SSF.parse_date_code(cellVal);
      if (d) {
        return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
      }
    }
    const str = String(cellVal).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return str;
    }
    // Check DD/MM/YYYY
    const dm = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dm) {
      let y = parseInt(dm[3], 10);
      if (y > 2500) y -= 543; // Buddhist era conversion
      return `${y}-${String(dm[2]).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;
    }
    return '';
  }

  function deleteOrder(id) {
    if (!confirm('ยืนยันลบรายการคำสั่งซื้อนี้?')) return;
    state.orders = state.orders.filter((o) => o.id !== id);
    SyncService.saveLocalOrders(state.orders);
    renderAll();
  }

  // =========================================================================
  // EXCEL EXPORT (EXACT GOOGLE SHEET 3 TABS REPLICATION)
  // =========================================================================
  function setupExportButton() {
    const btn = $('btn-export-excel');
    if (!btn) return;

    btn.addEventListener('click', () => {
      exportToExcel();
    });
  }

  function exportToExcel() {
    const kpis = calculateKPIs();
    const wb = XLSX.utils.book_new();

    // 1. Sheet 1: สรุปรายวัน
    const summaryData = [
      ['ตรวจเช็คพัสดุส่งออกต่อวัน', '', '', ''],
      ['', '', '', ''],
      ['วันที่ตรวจสอบ', state.activeDate, '', 'วิธีใช้งาน'],
      ['', '', '', '1. รายการที่ต้องส่ง: กรอก A:H เริ่มแถว 2 หนึ่งแถวต่อหนึ่งพัสดุ'],
      ['รายการตรวจ', 'จำนวน', '', '2. หลาย SKU ในกล่องเดียว ใส่ เช่น SKU-A x2, SKU-B x1 และจำนวนรวม 3'],
      ['พัสดุต้องส่ง (Tracking ไม่ซ้ำ)', kpis.uniqueOrdersCount, '', '3. รายการสแกน: วาง Tracking จาก Excel แบบค่าเท่านั้นใน B และใส่วันที่ใน A ทุกแถว'],
      ['พบสแกนตรงวันแล้ว (พัสดุ)', kpis.scannedOrdersCount, '', '4. เลือกวันที่ใน B3 แล้วใช้ตัวกรองคอลัมน์ผลตรวจเพื่อดูรายการที่ต้องแก้ไข'],
      ['ยังไม่สแกน (พัสดุ)', kpis.notScannedOrdersCount, '', '5. เลขซ้ำแสดงตัวแดงทั้งสองแท็บ ตรวจซ้ำรวมทุกวันที่เก็บไว้ จับคู่เฉพาะวันเดียวกัน'],
      ['สแกนทั้งหมด (ครั้ง)', kpis.totalScansCount, '', '6. ช่อง ID เป็นข้อความเพื่อรักษาเลขศูนย์นำหน้า ตัดช่องว่างและไม่แยกตัวพิมพ์เล็ก/ใหญ่'],
      ['สแกนเลขไม่ซ้ำ (พัสดุ)', kpis.uniqueScansCount, '', '7. กรอกได้แท็บละ 1,000 แถว (2–1001) ห้ามวางทับคอลัมน์สูตรด้านขวา'],
      ['สแกนเกินรายการส่ง (พัสดุ)', kpis.extraScansCount, '', '8. วันที่ต้องเป็นวันที่จริง ใช้ปี ค.ศ. หาก Excel ทำเลขศูนย์หาย ต้องแก้จากต้นทาง'],
      ['สแกนซ้ำในวันเดียวกัน (ครั้งเกิน)', kpis.duplicateScansCount, '', '9. เป็นการตรวจพัสดุจากลาเบล ไม่ยืนยัน SKU หรือจำนวนสินค้าที่อยู่ภายในกล่อง'],
      ['แถวรายการส่งที่ Tracking ซ้ำ', kpis.duplicateOrdersCount, '', ''],
      ['ข้อมูลไม่ครบ / จำนวนผิด (ทุกวัน)', kpis.invalidDataCount, '', '']
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'สรุปรายวัน');

    // 2. Sheet 2: รายการที่ต้องส่ง
    const ordersHeader = [
      'วันที่ต้องส่ง',
      'Order ID',
      'Tracking ID',
      'SKU สินค้า (รวมต่อกล่อง)',
      'จำนวนชิ้นรวม',
      'ขนส่ง',
      'ผู้จัดสินค้า',
      'หมายเหตุ / การแก้ไข',
      'Tracking สำหรับจับคู่',
      'จำนวนสแกนวันเดียวกัน',
      'Tracking ซ้ำในรายการส่ง',
      'ผลตรวจพัสดุ',
      'พัสดุไม่ซ้ำ (คำนวณ)',
      'วันที่สำหรับจับคู่'
    ];

    const ordersRows = [ordersHeader];
    state.orders.forEach((o) => {
      const scanCount = state.scans.filter((s) => s.scanDate === o.shipDate && s.cleanTracking === o.cleanTracking).length;
      const dupCount = state.orders.filter((x) => x.shipDate === o.shipDate && x.cleanTracking === o.cleanTracking).length;
      const status = getOrderStatus(o);

      ordersRows.push([
        o.shipDate,
        o.orderId,
        o.trackingId,
        o.sku,
        o.qty,
        o.carrier,
        o.packer,
        o.notes,
        o.cleanTracking,
        scanCount,
        dupCount > 1 ? 'Tracking ซ้ำ' : '',
        status,
        1,
        o.shipDate
      ]);
    });
    const wsOrders = XLSX.utils.aoa_to_sheet(ordersRows);
    XLSX.utils.book_append_sheet(wb, wsOrders, 'รายการที่ต้องส่ง');

    // 3. Sheet 3: รายการสแกน
    const scansHeader = [
      'วันที่สแกน',
      'Tracking ID จาก Excel',
      'ผู้สแกน',
      'ชื่อไฟล์ต้นทาง / หมายเหตุ',
      'Tracking สำหรับจับคู่',
      'จำนวนรายการส่งที่ตรงกัน',
      'จำนวนสแกนเลขนี้ในวันเดียวกัน',
      'ผลจับคู่',
      'เตือนเลขซ้ำ',
      'Tracking ไม่ซ้ำ (คำนวณ)',
      'วันที่สำหรับจับคู่'
    ];

    const scansRows = [scansHeader];
    state.scans.forEach((s) => {
      const matchCount = state.orders.filter((o) => o.shipDate === s.scanDate && o.cleanTracking === s.cleanTracking).length;
      const dupScanCount = state.scans.filter((x) => x.scanDate === s.scanDate && x.cleanTracking === s.cleanTracking).length;

      scansRows.push([
        s.scanDate,
        s.trackingId,
        s.scanner,
        s.source,
        s.cleanTracking,
        matchCount,
        dupScanCount,
        s.matchResult,
        dupScanCount > 1 ? 'Tracking ซ้ำ' : '',
        1,
        s.scanDate
      ]);
    });
    const wsScans = XLSX.utils.aoa_to_sheet(scansRows);
    XLSX.utils.book_append_sheet(wb, wsScans, 'รายการสแกน');

    // Save File
    const fileName = `ตรวจเช็คพัสดุส่งออก_${state.activeDate}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }

  // =========================================================================
  // SAMPLE DATA & RESET CONTROLS
  // =========================================================================
  function setupSampleDataButton() {
    const btn = $('btn-load-demo');
    if (!btn) return;

    btn.addEventListener('click', () => {
      loadDemoData();
    });
  }

  function loadDemoData() {
    const today = state.activeDate;
    const sampleOrders = [
      {
        id: 'ORD-DEMO-001',
        shipDate: today,
        orderId: '586178952893662219',
        trackingId: 'TH012489652174',
        cleanTracking: 'TH012489652174',
        sku: 'Qs-เก้าอี้สตูล-cu-เทา-PQ002C-46',
        qty: 2,
        carrier: 'Flash Express',
        packer: 'สมชาย',
        notes: ''
      },
      {
        id: 'ORD-DEMO-002',
        shipDate: today,
        orderId: '586178952893662220',
        trackingId: 'SPXTH0421896541',
        cleanTracking: 'SPXTH0421896541',
        sku: 'Qs-โซฟา3ที่นั่งเบาะกระดุมเล็ก-lz-สีเทาเข้ม',
        qty: 1,
        carrier: 'Shopee Xpress',
        packer: 'วิชัย',
        notes: ''
      },
      {
        id: 'ORD-DEMO-003',
        shipDate: today,
        orderId: '586178952893662221',
        trackingId: 'KERPU009845123',
        cleanTracking: 'KERPU009845123',
        sku: 'Qs-เก้าอี้สตูล-cu-น้ำตาล-PQ002C-12',
        qty: 1,
        carrier: 'Kerry Express',
        packer: 'สมชาย',
        notes: ''
      },
      {
        id: 'ORD-DEMO-004',
        shipDate: today,
        orderId: '586178952893662222',
        trackingId: 'JNTTH0998811223',
        cleanTracking: 'JNTTH0998811223',
        sku: 'Qs-โซฟาแอลเชพ-cu-ครีม-L90',
        qty: 1,
        carrier: 'J&T Express',
        packer: 'เอกชัย',
        notes: ''
      },
      {
        id: 'ORD-DEMO-005',
        shipDate: today,
        orderId: '586178952893662223',
        trackingId: 'TH019988776655',
        cleanTracking: 'TH019988776655',
        sku: 'Qs-เก้าอี้สตูล-cu-ดำ-PQ002C-17',
        qty: 3,
        carrier: 'Flash Express',
        packer: 'สมชาย',
        notes: ''
      },
      {
        id: 'ORD-DEMO-006',
        shipDate: today,
        orderId: '586178952893662224',
        trackingId: 'SPXTH0554433221',
        cleanTracking: 'SPXTH0554433221',
        sku: 'Qs-โซฟา2ที่นั่ง-ผ้าฮอลแลนด์-เขียวมรกต',
        qty: 1,
        carrier: 'Shopee Xpress',
        packer: 'วิชัย',
        notes: ''
      }
    ];

    state.orders = sampleOrders;
    SyncService.saveLocalOrders(state.orders);

    // Initial 2 Scans
    state.scans = [
      {
        id: 'SCAN-DEMO-001',
        scanDate: today,
        scanTime: '09:30:15',
        trackingId: 'TH012489652174',
        cleanTracking: 'TH012489652174',
        scanner: 'กล้องมือถือหน้ารถ',
        source: 'กล้องมือถือ',
        matchResult: 'พบในรายการส่ง',
        isDuplicateScan: false,
        matchedOrderId: '586178952893662219',
        matchedSku: 'Qs-เก้าอี้สตูล-cu-เทา-PQ002C-46',
        matchedQty: 2,
        matchedCarrier: 'Flash Express'
      },
      {
        id: 'SCAN-DEMO-002',
        scanDate: today,
        scanTime: '09:32:44',
        trackingId: 'SPXTH0421896541',
        cleanTracking: 'SPXTH0421896541',
        scanner: 'ปืนสแกนโต๊ะแพ็ค',
        source: 'ปืนสแกน',
        matchResult: 'พบในรายการส่ง',
        isDuplicateScan: false,
        matchedOrderId: '586178952893662220',
        matchedSku: 'Qs-โซฟา3ที่นั่งเบาะกระดุมเล็ก-lz-สีเทาเข้ม',
        matchedQty: 1,
        matchedCarrier: 'Shopee Xpress'
      }
    ];
    SyncService.saveLocalScans(state.scans);

    alert('โหลดข้อมูลตัวอย่างพร้อมส่ง 6 รายการ และสแกนแล้ว 2 รายการเรียบร้อยครับ!');
    renderAll();
  }

  function setupClearButton() {
    const btn = $('btn-clear-all');
    if (!btn) return;

    btn.addEventListener('click', () => {
      if (confirm('คุณต้องการล้างข้อมูลคำสั่งซื้อและประวัติการสแกนทั้งหมดหรือไม่?')) {
        state.orders = [];
        state.scans = [];
        SyncService.clearAllData();
        renderAll();
      }
    });
  }

  // =========================================================================
  // QR CODE MOBILE CONNECT MODAL
  // =========================================================================
  function setupQrConnectModal() {
    const btnOpen = $('btn-open-mobile-qr');
    const modal = $('modal-mobile-qr');
    const btnClose = $('btn-close-mobile-qr');

    if (btnOpen && modal) {
      btnOpen.addEventListener('click', () => {
        modal.classList.remove('hidden');
        renderConnectQr();
      });
    }

    if (btnClose && modal) {
      btnClose.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }
  }

  function renderConnectQr() {
    const qrContainer = $('qr-code-display');
    const urlText = $('qr-url-text');
    if (!qrContainer) return;

    qrContainer.innerHTML = '';

    // Generate URL with mobile hash
    const url = window.location.href.split('#')[0] + '#scanner';
    if (urlText) urlText.innerText = url;

    if (typeof window.QRCode !== 'undefined') {
      new window.QRCode(qrContainer, {
        text: url,
        width: 190,
        height: 190,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    }
  }

  function setupFilters() {
    // Quick Filter Buttons
    document.querySelectorAll('.filter-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-pill').forEach((b) => b.classList.remove('active', 'bg-emerald-600', 'text-white'));
        btn.classList.add('active', 'bg-emerald-600', 'text-white');
        state.currentFilter = btn.dataset.filter || 'all';
        renderOrdersTable();
      });
    });

    // Search Input
    const searchInput = $('input-search-orders');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.trim();
        renderOrdersTable();
      });
    }

    // Carrier Dropdown Filter
    const selCarrier = $('filter-carrier');
    if (selCarrier) {
      selCarrier.addEventListener('change', (e) => {
        state.carrierFilter = e.target.value;
        renderOrdersTable();
      });
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
})();
