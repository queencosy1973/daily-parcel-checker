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
    setupOrderActionModal();

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
    const allTodayOrders = state.orders.filter((o) => o.shipDate === targetDate);
    const cancelledOrders = allTodayOrders.filter((o) => o.isCancelled || (o.orderStatus && (o.orderStatus.includes('ยกเลิก') || o.orderStatus.toLowerCase().includes('cancel'))));
    
    // Active orders to be shipped (excluding cancelled orders)
    const todayOrders = allTodayOrders.filter((o) => !o.isCancelled && !(o.orderStatus && (o.orderStatus.includes('ยกเลิก') || o.orderStatus.toLowerCase().includes('cancel'))));
    const untrackedOrders = todayOrders.filter((o) => !o.cleanTracking);

    // Map of clean tracking -> count in today's active orders
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

    // Total Items Quantity & Total Rows (from active orders)
    const totalItemsQty = todayOrders.reduce((sum, o) => sum + (parseInt(o.qty, 10) || 1), 0);
    const totalRowsCount = todayOrders.length;

    // Completion Rate %
    const completionRate = uniqueOrdersCount > 0 ? ((scannedOrdersCount / uniqueOrdersCount) * 100).toFixed(1) : 0;

    return {
      totalItemsQty,
      totalRowsCount,
      uniqueOrdersCount,
      scannedOrdersCount,
      notScannedOrdersCount,
      totalScansCount,
      uniqueScansCount,
      extraScansCount,
      duplicateScansCount,
      duplicateOrdersCount,
      invalidDataCount,
      untrackedOrdersCount: untrackedOrders.length,
      cancelledOrdersCount: cancelledOrders.length,
      completionRate
    };
  }

  // Get verification status for an order row (Matching Google Sheet Col L formula)
  function getOrderStatus(order) {
    if (order.isCancelled || (order.orderStatus && (order.orderStatus.includes('ยกเลิก') || order.orderStatus.toLowerCase().includes('cancel')))) {
      return 'ลูกค้ายกเลิกคำสั่งซื้อ';
    }
    if (!order.cleanTracking) {
      return 'ไม่มีเลข Tracking (เช็คยกเลิก)';
    }
    if (!order.shipDate || !order.orderId || !order.sku || order.qty === undefined || order.qty === null || order.qty === '') {
      return 'ข้อมูลไม่ครบ/รูปแบบผิด';
    }
    const numQty = Number(order.qty);
    if (isNaN(numQty) || numQty <= 0 || !Number.isInteger(numQty)) {
      return 'ตรวจจำนวนสินค้า';
    }

    // Check duplicate in same date's orders (Only flag if different Order IDs share the same tracking)
    const sameDateOrders = state.orders.filter((o) => o.shipDate === order.shipDate && o.cleanTracking === order.cleanTracking && !o.isCancelled);
    if (sameDateOrders.length > 1) {
      const diffOrderIds = sameDateOrders.filter((o) => o.orderId !== order.orderId);
      if (diffOrderIds.length > 0) {
        return 'ตรวจ Tracking ซ้ำ';
      }
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
    const raw = String(scan.trackingId || '').trim();
    if (!clean && !raw) return { result: 'ข้อมูลไม่ครบ/รูปแบบผิด', order: null, statusType: 'invalid' };

    // 1. Try matching by tracking number
    const matchedOrders = clean ? state.orders.filter((o) => o.shipDate === targetDate && o.cleanTracking === clean) : [];

    if (matchedOrders.length >= 1) {
      const uniqueOrderIds = new Set(matchedOrders.map((o) => o.orderId));
      if (uniqueOrderIds.size === 1) {
        const order = matchedOrders[0];
        if (order.isCancelled || (order.orderStatus && (order.orderStatus.includes('ยกเลิก') || order.orderStatus.toLowerCase().includes('cancel')))) {
          return {
            result: 'ลูกค้ายกเลิกคำสั่งซื้อ',
            order: order,
            statusType: 'cancelled'
          };
        }
        return {
          result: 'พบในรายการส่ง',
          order: order,
          statusType: 'matched'
        };
      } else {
        return {
          result: 'รายการส่งซ้ำ',
          order: matchedOrders[0],
          statusType: 'dup_order'
        };
      }
    }

    // 2. Try matching by Order ID (in case warehouse scans Order ID barcode or pick slip)
    const matchedByOrderId = state.orders.filter((o) => 
      o.shipDate === targetDate && (
        o.orderId === raw || 
        (clean && normalizeTracking(o.orderId) === clean) ||
        (raw.length >= 12 && o.orderId.includes(raw))
      )
    );

    if (matchedByOrderId.length >= 1) {
      const order = matchedByOrderId[0];
      if (order.isCancelled || (order.orderStatus && (order.orderStatus.includes('ยกเลิก') || order.orderStatus.toLowerCase().includes('cancel')))) {
        return {
          result: 'ลูกค้ายกเลิกคำสั่งซื้อ',
          order: order,
          statusType: 'cancelled'
        };
      }
      if (!order.cleanTracking) {
        return {
          result: 'ไม่มีเลขพัสดุ (เช็คยกเลิก)',
          order: order,
          statusType: 'untracked'
        };
      }
      return {
        result: 'พบในรายการส่ง',
        order: order,
        statusType: 'matched'
      };
    }

    // 3. Fallback: pending orders
    return {
      result: 'รอนำเข้าออเดอร์',
      order: null,
      statusType: 'pending_orders'
    };
  }

  function reconcileScansAndOrders() {
    let reMatchedCount = 0;
    let updatedCount = 0;
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
          updatedCount++;
        }
      } else {
        if (scan.matchResult !== resolution.result) {
          scan.matchResult = resolution.result;
          scan.matchedOrderId = '';
          scan.matchedSku = '';
          scan.matchedQty = '';
          scan.matchedCarrier = '';
          updatedCount++;
        }
      }
    });

    if (updatedCount > 0) {
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
    const raw = String(rawBarcode || '').trim();
    if (!clean && !raw) return;

    const targetDate = state.activeDate;
    const scannerName = (source.includes('มือถือ') ? ($('input-mobile-scanner-name')?.value || state.scannerName) : ($('input-scanner-name')?.value || state.scannerName)).trim() || 'พนักงานคลัง';

    state.scannerName = scannerName;
    SyncService.saveConfig({ ...SyncService.getConfig(), scannerName });

    // Dynamically resolve match against today's orders (checks Tracking ID, then Order ID)
    const dummyScan = { scanDate: targetDate, cleanTracking: clean, trackingId: raw };
    const resolution = resolveScanMatch(dummyScan);
    const matchedOrder = resolution.order;
    const matchResult = resolution.result;

    // Use clean tracking from scan OR from matched order if scanned by Order ID
    const effectiveClean = clean || (matchedOrder ? matchedOrder.cleanTracking : '');

    // Check if this tracking was already scanned today
    const existingScansToday = effectiveClean ? state.scans.filter((s) => s.scanDate === targetDate && s.cleanTracking === effectiveClean) : [];
    const isDuplicate = existingScansToday.length > 0;

    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];

    const newScanRecord = {
      id: 'SCAN-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      scanDate: targetDate,
      scanTime: timeStr,
      trackingId: raw,
      cleanTracking: effectiveClean,
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
    const matchedCount = effectiveClean ? state.orders.filter((o) => o.shipDate === targetDate && o.cleanTracking === effectiveClean).length : 0;
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

    if (scanRecord.matchResult === 'ลูกค้ายกเลิกคำสั่งซื้อ') {
      // CANCELLED ORDER ALERT! 🚫
      AudioFeedback.error();
      CameraScanner.flashBox('error');
      bgClass = 'bg-rose-100 border-rose-600 text-rose-950 animate-pulse';
      iconName = 'x-octagon';
      title = `🚫 หยุดส่ง! ลูกค้ายกเลิกคำสั่งซื้อ: ${scanRecord.matchedOrderId || scanRecord.trackingId}`;
      subtitle = `สินค้า: ${scanRecord.matchedSku || '-'} (${scanRecord.matchedQty || 1} ชิ้น) | คำสั่งซื้อถูกยกเลิกบนแพลตฟอร์ม ห้ามนำสินค้าขึ้นรถเด็ดขาด!`;
    } else if (scanRecord.matchResult === 'ไม่มีเลขพัสดุ (เช็คยกเลิก)') {
      // UNTRACKED / SUSPECTED CANCELLED ALERT! ⚠️
      AudioFeedback.error();
      CameraScanner.flashBox('error');
      bgClass = 'bg-amber-100 border-amber-600 text-amber-950 animate-pulse';
      iconName = 'alert-triangle';
      title = `⚠️ ระวัง! ออเดอร์นี้ไม่มีเลข Tracking (เช็คยกเลิก): ${scanRecord.matchedOrderId || scanRecord.trackingId}`;
      subtitle = `สินค้า: ${scanRecord.matchedSku || '-'} (${scanRecord.matchedQty || 1} ชิ้น) | ยังไม่มีเลขพัสดุในระบบ (อาจถูกลูกค้ายกเลิกแล้ว) กรุณาเช็คแพลตฟอร์มก่อนส่ง!`;
    } else if (scanRecord.matchResult === 'พบในรายการส่ง') {
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
    } else if (scanRecord.matchResult === 'รอนำเข้าคำสั่งซื้อ' || scanRecord.matchResult === 'รอนำเข้าออเดอร์') {
      // PENDING ORDERS IMPORT ⏳ (Scan before order manifest is keyed)
      if (!isDuplicate) {
        AudioFeedback.pending();
        CameraScanner.flashBox('pending');
        bgClass = 'bg-sky-50 border-sky-500 text-sky-900';
        iconName = 'clock';
        title = `📦 บันทึกแล้ว (รอนำเข้าออเดอร์): ${scanRecord.trackingId}`;
        subtitle = `บันทึกเวลาเรียบร้อย (ระบบจะจับคู่ย้อนหลังให้อัตโนมัติเมื่อนำเข้าข้อมูลคำสั่งซื้อ)`;
      } else {
        AudioFeedback.duplicate();
        CameraScanner.flashBox('duplicate');
        bgClass = 'bg-amber-50 border-amber-500 text-amber-900';
        iconName = 'alert-triangle';
        title = `⚠️ สแกนซ้ำ: ${scanRecord.trackingId}`;
        subtitle = `เลขพัสดุนี้ถูกสแกนไปแล้วในวันนี้ (สถานะ: รอนำเข้าออเดอร์)`;
      }
    } else if (scanRecord.matchResult === 'ไม่พบในรายการส่งของวันนี้') {
      // NOT FOUND 🚨 (fallback if any)
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
    if ($('kpi-unique-orders-sub')) $('kpi-unique-orders-sub').innerText = `เป้าหมายส่งวันนี้ (รวม ${kpis.totalItemsQty} ชิ้น)`;

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
    if ($('badge-count-qty')) $('badge-count-qty').innerText = kpis.totalItemsQty;
    if ($('badge-count-missing')) $('badge-count-missing').innerText = kpis.notScannedOrdersCount;
    if ($('badge-count-scanned')) $('badge-count-scanned').innerText = kpis.scannedOrdersCount;
    if ($('badge-count-extra')) $('badge-count-extra').innerText = kpis.extraScansCount;
    if ($('badge-count-untracked')) $('badge-count-untracked').innerText = (kpis.untrackedOrdersCount + kpis.cancelledOrdersCount);

    renderUntrackedAlerts(kpis);
  }

  function renderUntrackedAlerts(kpis) {
    const dashAlert = $('dashboard-untracked-alert');
    const ordersAlert = $('orders-untracked-alert');

    const targetDate = state.activeDate;
    const allToday = state.orders.filter((o) => o.shipDate === targetDate);
    const problemOrders = allToday.filter((o) => !o.cleanTracking || o.isCancelled || (o.orderStatus && (o.orderStatus.includes('ยกเลิก') || o.orderStatus.toLowerCase().includes('cancel'))));

    if (problemOrders.length === 0) {
      if (dashAlert) {
        dashAlert.classList.add('hidden');
        dashAlert.innerHTML = '';
      }
      if (ordersAlert) {
        ordersAlert.classList.add('hidden');
        ordersAlert.innerHTML = '';
      }
      return;
    }

    const itemsHtml = problemOrders.map((o) => {
      const isCanc = o.isCancelled || (o.orderStatus && (o.orderStatus.includes('ยกเลิก') || o.orderStatus.toLowerCase().includes('cancel')));
      const statusText = isCanc ? 'ลูกค้ายกเลิก' : 'ยังไม่มีเลข Tracking';
      const badgeClass = isCanc ? 'bg-rose-100 text-rose-800 border-rose-300' : 'bg-amber-100 text-amber-900 border-amber-300';
      return `
        <div class="flex flex-wrap items-center justify-between gap-2 py-2 px-3 rounded-lg bg-white/90 border border-amber-200">
          <div class="flex items-center gap-2 min-w-0">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold border shrink-0 ${badgeClass}">${statusText}</span>
            <span class="font-mono font-bold text-slate-800 text-xs shrink-0">${escapeHtml(o.orderId)}</span>
            <span class="text-xs text-slate-600 truncate max-w-[200px] sm:max-w-[320px]">${escapeHtml(o.sku)} (${o.qty || 1} ชิ้น)</span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button class="btn-quick-manage px-2.5 py-1 text-xs font-semibold rounded-md bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 transition" data-id="${o.id}">
              ตรวจสอบ / จัดการ
            </button>
            <button class="btn-quick-delete p-1 text-slate-400 hover:text-rose-600 rounded transition" data-id="${o.id}" title="ลบรายการนี้">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');

    const bannerHtml = `
      <div class="p-4 bg-amber-50 border-2 border-amber-400 rounded-2xl shadow-xs space-y-2.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 font-bold text-amber-900 text-sm sm:text-base">
            <i data-lucide="shield-alert" class="w-5 h-5 text-amber-600 shrink-0"></i>
            <span>⚠️ ตรวจพบ ${problemOrders.length} คำสั่งซื้อที่ไม่มีเลขพัสดุ / ลูกค้ายกเลิก</span>
          </div>
          <button class="btn-jump-untracked text-xs font-bold text-amber-800 hover:text-amber-950 underline cursor-pointer">
            กรองดูเฉพาะรายการนี้ในตาราง →
          </button>
        </div>
        <p class="text-xs text-amber-800 leading-relaxed">
          ระบบตรวจพบคำสั่งซื้อที่ <b>ไม่มีเลข Tracking หรือมีสถานะยกเลิก</b> ในไฟล์นำเข้า (เช่น ลูกค้ากดยกเลิกใน TikTok/Shopee ก่อนจัดส่ง) 
          กรุณาตรวจสอบในระบบร้านค้าก่อนแพ็คสินค้าขึ้นรถ เพื่อป้องกันการส่งของผิดพลาด
        </p>
        <div class="space-y-1.5 pt-1">
          ${itemsHtml}
        </div>
      </div>
    `;

    [dashAlert, ordersAlert].forEach((container) => {
      if (!container) return;
      container.classList.remove('hidden');
      container.innerHTML = bannerHtml;
    });

    document.querySelectorAll('.btn-jump-untracked').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab('tab-orders');
        document.querySelectorAll('.filter-pill').forEach((b) => b.classList.remove('active', 'bg-emerald-600', 'text-white'));
        const untrackedPill = document.querySelector('.filter-pill[data-filter="untracked"]');
        if (untrackedPill) {
          untrackedPill.classList.add('active', 'bg-emerald-600', 'text-white');
        }
        state.currentFilter = 'untracked';
        renderOrdersTable();
      });
    });

    document.querySelectorAll('.btn-quick-manage').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        openOrderActionModal(id);
      });
    });

    document.querySelectorAll('.btn-quick-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        deleteOrder(id);
      });
    });

    lucide.createIcons();
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
    } else if (state.currentFilter === 'untracked') {
      list = list.filter((o) => !o.cleanTracking || o.isCancelled || getOrderStatus(o) === 'ไม่มีเลข Tracking (เช็คยกเลิก)' || getOrderStatus(o) === 'ลูกค้ายกเลิกคำสั่งซื้อ');
    } else if (state.currentFilter === 'issues') {
      list = list.filter((o) => {
        const s = getOrderStatus(o);
        return s === 'ตรวจ Tracking ซ้ำ' || s === 'ข้อมูลไม่ครบ/รูปแบบผิด' || s === 'ตรวจจำนวนสินค้า' || s === 'ไม่มีเลข Tracking (เช็คยกเลิก)' || s === 'ลูกค้ายกเลิกคำสั่งซื้อ';
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
      } else if (status === 'ลูกค้ายกเลิกคำสั่งซื้อ') {
        rowClass += ' bg-rose-50/60 opacity-75';
      } else if (status === 'ไม่มีเลข Tracking (เช็คยกเลิก)') {
        rowClass += ' bg-amber-50/70';
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
          <td class="py-3 px-3.5 text-center text-xs whitespace-nowrap">
            <div class="flex items-center justify-center gap-1">
              <button class="btn-manage-order p-1 text-slate-400 hover:text-amber-600 rounded transition" data-id="${order.id}" title="จัดการคำสั่งซื้อ/ใส่เลขพัสดุ/เช็คยกเลิก">
                <i data-lucide="edit-3" class="w-4 h-4"></i>
              </button>
              <button class="btn-delete-order p-1 hover:text-rose-600 rounded text-slate-400 transition" data-id="${order.id}" title="ลบรายการนี้">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
    lucide.createIcons();

    // Setup Manage Buttons
    tbody.querySelectorAll('.btn-manage-order').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = btn.dataset.id;
        openOrderActionModal(id);
      });
    });

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
    } else if (status === 'ลูกค้ายกเลิกคำสั่งซื้อ') {
      return '<span class="badge-status bg-rose-100 text-rose-800 border-rose-300 font-bold line-through"><i data-lucide="x-circle" class="w-3.5 h-3.5 text-rose-600"></i> ลูกค้ายกเลิก</span>';
    } else if (status === 'ไม่มีเลข Tracking (เช็คยกเลิก)') {
      return '<span class="badge-status bg-amber-100 text-amber-900 border-amber-300 font-bold"><i data-lucide="alert-triangle" class="w-3.5 h-3.5 text-amber-600"></i> ไม่มี Tracking (เช็คยกเลิก)</span>';
    } else {
      return `<span class="badge-status bg-amber-50 text-amber-700 border-amber-300">${escapeHtml(status)}</span>`;
    }
  }

  function getScanMatchBadge(matchResult, isDuplicate) {
    if (matchResult === 'ลูกค้ายกเลิกคำสั่งซื้อ') {
      return '<span class="badge-status bg-rose-100 text-rose-800 border-rose-400 font-bold"><i data-lucide="x-octagon" class="w-3.5 h-3.5 text-rose-600"></i> ลูกค้ายกเลิก</span>';
    } else if (matchResult === 'ไม่มีเลขพัสดุ (เช็คยกเลิก)') {
      return '<span class="badge-status bg-amber-100 text-amber-900 border-amber-400 font-bold"><i data-lucide="alert-triangle" class="w-3.5 h-3.5 text-amber-600"></i> ไม่มี Tracking (เช็คยกเลิก)</span>';
    } else if (matchResult === 'พบในรายการส่ง') {
      if (!isDuplicate) {
        return '<span class="badge-status bg-emerald-50 text-emerald-700 border-emerald-300 font-bold"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> พบในรายการส่ง</span>';
      } else {
        return '<span class="badge-status bg-amber-50 text-amber-800 border-amber-300"><i data-lucide="repeat" class="w-3.5 h-3.5"></i> สแกนซ้ำตรงวัน</span>';
      }
    } else if (matchResult === 'รอนำเข้าคำสั่งซื้อ' || matchResult === 'รอนำเข้าออเดอร์') {
      if (!isDuplicate) {
        return '<span class="badge-status bg-sky-50 text-sky-700 border-sky-300 font-semibold"><i data-lucide="clock" class="w-3.5 h-3.5"></i> รอนำเข้าออเดอร์</span>';
      } else {
        return '<span class="badge-status bg-amber-50 text-amber-800 border-amber-300"><i data-lucide="repeat" class="w-3.5 h-3.5"></i> รอนำเข้า (สแกนซ้ำ)</span>';
      }
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

    // Apply Imported Data (Paste)
    if (btnApply && textarea) {
      btnApply.addEventListener('click', () => {
        const text = textarea.value.trim();
        if (!text) {
          alert('กรุณาวางข้อมูลก่อนกดยืนยัน');
          return;
        }

        const newOrders = parsePastedOrders(text);
        if (newOrders.length === 0) {
          alert('ไม่พบแถวข้อมูลที่ถูกต้อง กรุณาคัดลอกข้อมูลจาก Shopee, TikTok, หรือ Excel อีกครั้ง');
          return;
        }

        // Deduplicate against existing orders in state
        const existingKeys = new Set(state.orders.map((o) => `${o.shipDate}|${o.orderId}|${o.cleanTracking}|${o.sku}`));
        const filteredNewOrders = [];
        newOrders.forEach((no) => {
          const key = `${no.shipDate}|${no.orderId}|${no.cleanTracking}|${no.sku}`;
          if (!existingKeys.has(key)) {
            existingKeys.add(key);
            filteredNewOrders.push(no);
          }
        });

        state.orders = state.orders.concat(filteredNewOrders);
        const reMatched = reconcileScansAndOrders();
        SyncService.saveLocalOrders(state.orders);

        textarea.value = '';
        if (modal) modal.classList.add('hidden');

        renderAll();
        if (reMatched > 0) {
          alert(`นำเข้ารายการคำสั่งซื้อสำเร็จ ${filteredNewOrders.length} รายการ!\n\n✨ ระบบได้จับคู่ย้อนหลังกับพัสดุที่สแกนไว้ก่อนหน้านี้สำเร็จ ${reMatched} รายการเรียบร้อยแล้วครับ!`);
        } else {
          alert(`นำเข้ารายการคำสั่งซื้อสำเร็จ ${filteredNewOrders.length} รายการ!`);
        }
      });
    }

    // File Upload Handler (.xlsx, .xls, .csv)
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const data = new Uint8Array(evt.target.result);
            const workbook = XLSX.read(data, { type: 'array' });

            if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
              alert('ไม่พบแผ่นงาน (Sheet) ในไฟล์ Excel ที่เลือก');
              return;
            }

            // Look for sheet 'รายการที่ต้องส่ง', 'orders', 'คำสั่งซื้อ' or first sheet
            let sheetName = workbook.SheetNames.find((s) => 
              typeof s === 'string' && (
                s.includes('รายการที่ต้องส่ง') || 
                s.toLowerCase().includes('order') || 
                s.includes('คำสั่งซื้อ')
              )
            ) || workbook.SheetNames[0];

            const worksheet = workbook.Sheets[sheetName];
            if (!worksheet) {
              alert('ไม่สามารถอ่านข้อมูลแผ่นงานในไฟล์ได้');
              return;
            }

            // defval: '' guarantees all empty cells are dense empty strings rather than sparse holes
            const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

            const newOrders = parseExcelRows(rows);
            if (newOrders.length > 0) {
              // Deduplicate against existing orders in state
              const existingKeys = new Set(state.orders.map((o) => `${o.shipDate}|${o.orderId}|${o.cleanTracking}|${o.sku}`));
              const filteredNewOrders = [];
              newOrders.forEach((no) => {
                const key = `${no.shipDate}|${no.orderId}|${no.cleanTracking}|${no.sku}`;
                if (!existingKeys.has(key)) {
                  existingKeys.add(key);
                  filteredNewOrders.push(no);
                }
              });

              state.orders = state.orders.concat(filteredNewOrders);
              const reMatched = reconcileScansAndOrders();
              SyncService.saveLocalOrders(state.orders);
              fileInput.value = ''; // Reset input to allow re-upload

              renderAll();
              if (reMatched > 0) {
                alert(`นำเข้าจากไฟล์ ${file.name} สำเร็จ ${filteredNewOrders.length} รายการ!\n\n✨ ระบบได้จับคู่ย้อนหลังกับพัสดุที่สแกนไว้ก่อนหน้านี้สำเร็จ ${reMatched} รายการเรียบร้อยแล้วครับ!`);
              } else {
                alert(`นำเข้าจากไฟล์ ${file.name} สำเร็จ ${filteredNewOrders.length} รายการ!`);
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

  // =========================================================================
  // UNIFIED SMART IMPORT ENGINE (SHOPEE, TIKTOK SHOP, LAZADA, EXCEL)
  // =========================================================================

  function detectCarrier(rawTracking, explicitCarrier) {
    if (explicitCarrier) {
      const exp = String(explicitCarrier).trim();
      if (exp && !/^\d+$/.test(exp) && !exp.startsWith('Qs-') && exp !== '1') {
        return exp;
      }
    }
    const clean = normalizeTracking(rawTracking);
    if (!clean) return 'Flash Express';
    if (/^(THT|TH\d{10,}|TH[A-Z0-9]{8,})/i.test(clean)) return 'Flash Express';
    if (/^SPXTH/i.test(clean)) return 'Shopee Xpress';
    if (/^\d{14}$/.test(clean)) return 'BEST Express';
    if (/^(KER|KEX)/i.test(clean)) return 'KEX Express';
    if (/^(JNT|J&T)/i.test(clean)) return 'J&T Express';
    return 'Flash Express';
  }

  function parseDateCell(cellVal) {
    if (!cellVal) return '';
    if (typeof cellVal === 'number') {
      try {
        const d = XLSX.SSF.parse_date_code(cellVal);
        if (d && d.y) {
          return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
        }
      } catch (e) {}
    }
    const str = String(cellVal).trim();
    if (!str) return '';

    // Match YYYY-MM-DD or YYYY/MM/DD (with optional timestamp)
    const ym = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (ym) {
      let y = parseInt(ym[1], 10);
      if (y > 2500) y -= 543;
      return `${y}-${String(ym[2]).padStart(2, '0')}-${String(ym[3]).padStart(2, '0')}`;
    }

    // Match DD/MM/YYYY or DD-MM-YYYY (with optional timestamp)
    const dm = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (dm) {
      let y = parseInt(dm[3], 10);
      if (y > 2500) y -= 543; // Buddhist era conversion
      return `${y}-${String(dm[2]).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;
    }

    return '';
  }

  function resolveColumnIndices(headerRow) {
    if (!headerRow) return null;

    // Convert sparse array / array-like to dense array of clean strings safely
    const len = headerRow.length || 0;
    const headers = [];
    for (let i = 0; i < len; i++) {
      const val = headerRow[i];
      headers.push(String(val !== null && val !== undefined ? val : '').trim().toLowerCase().replace(/[\*\_\-]/g, ' '));
    }

    const findExactOrInc = (patterns, excludes = []) => {
      if (!Array.isArray(patterns)) return -1;
      const safeExcludes = Array.isArray(excludes) ? excludes.filter((ex) => typeof ex === 'string') : [];

      // 1. Exact match first
      for (const p of patterns) {
        if (typeof p !== 'string') continue;
        const idx = headers.findIndex((h) => {
          if (!h || typeof h !== 'string') return false;
          if (safeExcludes.some((ex) => ex && h.includes(ex))) return false;
          return h === p;
        });
        if (idx !== -1) return idx;
      }
      // 2. Includes match
      for (const p of patterns) {
        if (typeof p !== 'string') continue;
        const idx = headers.findIndex((h) => {
          if (!h || typeof h !== 'string') return false;
          if (safeExcludes.some((ex) => ex && h.includes(ex))) return false;
          return h.includes(p);
        });
        if (idx !== -1) return idx;
      }
      return -1;
    };

    // Tracking ID (High specificity, excludes date/time)
    const idxTrack = findExactOrInc(
      ['หมายเลขติดตามพัสดุ', 'tracking id', 'tracking number', 'tracking no', 'เลขติดตามพัสดุ', 'เลขพัสดุ', 'หมายเลขพัสดุ', 'tracking', 'waybill', 'airway bill'],
      ['วัน', 'date', 'เวลา', 'time']
    );

    // Order ID (High specificity, excludes date/time/tracking/status)
    const idxOrder = findExactOrInc(
      ['หมายเลขคำสั่งซื้อ', 'order id', 'รหัสคำสั่งซื้อ', 'order number', 'order no', 'คำสั่งซื้อ', 'เลขออเดอร์', 'หมายเลขออเดอร์', 'เลขที่คำสั่งซื้อ', 'order sn', 'order'],
      ['วัน', 'date', 'เวลา', 'time', 'สถานะ', 'status', 'tracking', 'พัสดุ']
    );

    // Ship Date (Prioritize 'วันที่คาดว่าจะทำการจัดส่งสินค้า' or 'วันที่ต้องส่ง')
    // Exclude 'created', 'paid', 'rts', 'time' to prevent pre-order timestamps from placing orders in past dates
    const idxDate = findExactOrInc(
      ['วันที่คาดว่าจะทำการจัดส่งสินค้า', 'วันที่ต้องส่ง', 'วันที่จัดส่ง', 'ship date', 'shipping date', 'estimated delivery date', 'วันที่นัดรับ', 'วันส่งของ', 'วันที่', 'date'],
      ['created', 'สร้าง', 'paid', 'ชำระ', 'rts', 'ready to ship', 'time', 'เวลา']
    );

    // SKU: Tier 1 (Merchant Seller SKU)
    let idxSku = findExactOrInc([
      'seller sku', 'เลขอ้างอิง sku (sku reference no.)', 'เลขอ้างอิง sku', 'sku reference no', 'seller_sku', 'รหัสสินค้าผู้ขาย', 'เลขอ้างอิง'
    ]);
    if (idxSku === -1) {
      idxSku = findExactOrInc(
        ['สินค้า (sku)', 'รหัสสินค้า', 'ชื่อสินค้า', 'product name', 'sku'],
        ['วัน', 'date', 'เวลา', 'time', 'quantity', 'จำนวน', 'sku id']
      );
    }
    if (idxSku === -1) {
      idxSku = findExactOrInc(['sku id', 'id สินค้า']);
    }

    // Variation
    const idxVariation = findExactOrInc(['ชื่อตัวเลือก', 'variation', 'ตัวเลือก', 'option', 'แบบ']);

    // Quantity (Exclude return / cancel)
    const idxQty = findExactOrInc(
      ['จำนวน', 'quantity', 'qty', 'จำนวนสินค้า', 'จำนวนชิ้น'],
      ['return', 'คืน', 'ยกเลิก', 'cancel']
    );

    // Carrier
    const idxCarrier = findExactOrInc(
      ['shipping provider name', 'shipping provider', 'ผู้ให้บริการจัดส่ง', 'บริษัทขนส่ง', 'ขนส่ง', 'carrier', 'courier', 'delivery option', 'การจัดส่ง'],
      ['วัน', 'date', 'เวลา', 'time']
    );

    // Packer
    const idxPacker = findExactOrInc(
      ['ผู้จัดสินค้า', 'ทีมแพ็ค', 'คนแพ็ค', 'ผู้แพ็ค', 'packer', 'packed by']
    );

    // Notes / Order Type
    const idxNotes = findExactOrInc(
      ['ประเภทคำสั่งซื้อ', 'normal or pre order', 'normal or pre-order', 'order type', 'หมายเหตุ', 'buyer message', 'seller note', 'บันทึก', 'note', 'notes']
    );

    // Order Status (High specificity, excludes date/time/tracking)
    const idxStatus = findExactOrInc(
      ['สถานะคำสั่งซื้อ', 'สถานะการสั่งซื้อ', 'order status', 'สถานะ', 'status'],
      ['วัน', 'date', 'เวลา', 'time', 'ขนส่ง', 'tracking', 'carrier', 'delivery']
    );

    return {
      idxOrder,
      idxTrack,
      idxDate,
      idxSku,
      idxVariation,
      idxQty,
      idxCarrier,
      idxPacker,
      idxNotes,
      idxStatus
    };
  }

  function inferColumnIndicesFromData(cols) {
    if (!cols) return { idxOrder: -1, idxTrack: -1, idxDate: -1, idxSku: -1, idxVariation: -1, idxQty: -1, idxCarrier: -1, idxPacker: -1, idxNotes: -1 };

    const len = cols.length || 0;
    const denseCols = [];
    for (let i = 0; i < len; i++) {
      const val = cols[i];
      denseCols.push(String(val !== null && val !== undefined ? val : '').trim());
    }

    let idxOrder = -1;
    let idxTrack = -1;
    let idxDate = -1;
    let idxSku = -1;
    let idxQty = -1;
    let idxCarrier = -1;
    let idxNotes = -1;

    for (let i = 0; i < denseCols.length; i++) {
      const val = denseCols[i];
      if (!val) continue;

      // Date check
      if (idxDate === -1 && parseDateCell(val)) {
        idxDate = i;
        continue;
      }

      // Tracking ID check: THT..., SPXTH..., 14-digit number like 6677..., or TH+alphanumeric
      if (idxTrack === -1 && (
        /^(THT|SPXTH|KEX|KER|JNT)[0-9A-Z]+$/i.test(val) ||
        (/^TH[0-9A-Z]{8,}$/i.test(val) && !val.includes(' ') && val.length <= 22) ||
        (/^\d{13,15}$/.test(val) && val.startsWith('66'))
      )) {
        idxTrack = i;
        continue;
      }

      // Quantity check: 1 to 999
      if (idxQty === -1 && /^\d{1,3}$/.test(val) && parseInt(val, 10) > 0 && parseInt(val, 10) < 500) {
        idxQty = i;
        continue;
      }

      // Carrier check: known courier name
      if (idxCarrier === -1 && /^(Flash|BEST|Shopee|SPX|Kerry|KEX|J&T|EMS|ไปรษณีย์)/i.test(val)) {
        idxCarrier = i;
        continue;
      }

      // SKU check: starts with Qs- or model code or furniture keywords
      if (idxSku === -1 && (/^Qs[\-_]/i.test(val) || val.includes('โซฟา') || val.includes('สตูล') || val.includes('หมอน'))) {
        idxSku = i;
        continue;
      }

      // Order ID: length 12-25 alphanumeric
      if (idxOrder === -1 && /^[0-9A-Za-z]{12,25}$/.test(val) && !parseDateCell(val)) {
        idxOrder = i;
        continue;
      }
    }

    if (idxTrack === -1 && denseCols.length >= 3) {
      if (idxDate === 0 && idxOrder === 1) idxTrack = 2;
      else if (idxOrder === 0) idxTrack = 1;
    }

    return {
      idxOrder: idxOrder !== -1 ? idxOrder : 0,
      idxTrack: idxTrack !== -1 ? idxTrack : (denseCols.length >= 2 ? 1 : 0),
      idxDate,
      idxSku: idxSku !== -1 ? idxSku : (denseCols.length >= 4 ? 3 : -1),
      idxVariation: -1,
      idxQty: idxQty !== -1 ? idxQty : (denseCols.length >= 5 ? 4 : -1),
      idxCarrier,
      idxPacker: -1,
      idxNotes,
      idxStatus: -1
    };
  }

  function textTo2DArray(text) {
    if (!text || !text.trim()) return [];
    const lines = text.trim().split(/\r?\n/);
    const rows = [];
    const hasTabs = lines.some((l) => l.includes('\t'));

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (hasTabs) {
        rows.push(line.split('\t').map((c) => c.trim()));
      } else if (line.includes(',')) {
        // Parse CSV line with quotes support
        const cols = [];
        let inQuotes = false;
        let cur = '';
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            cols.push(cur.trim());
            cur = '';
          } else {
            cur += char;
          }
        }
        cols.push(cur.trim());
        rows.push(cols);
      } else {
        rows.push(line.split(/\s{2,}/).map((c) => c.trim()));
      }
    });

    return rows;
  }

  function parseUnifiedRows(rows, targetDate) {
    if (!Array.isArray(rows) || rows.length === 0) return [];

    let headerRowIdx = -1;
    let colIndices = null;
    let maxMatchCount = 0;

    // Scan first 10 rows to detect header
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
      if (candidateIndices.idxDate !== -1) matchCount++;

      if (matchCount >= 2 && matchCount > maxMatchCount) {
        maxMatchCount = matchCount;
        headerRowIdx = r;
        colIndices = candidateIndices;
      }
    }

    let dataStartRow = 0;
    if (headerRowIdx !== -1 && colIndices) {
      dataStartRow = headerRowIdx + 1;
    } else {
      dataStartRow = 0;
      const firstRow = rows.find((r) => r && Array.from(r).some((c) => String(c || '').trim() !== ''));
      colIndices = inferColumnIndicesFromData(firstRow || rows[0]);
    }

    const result = [];
    const now = Date.now();

    for (let r = dataStartRow; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;

      let rawOrder = colIndices.idxOrder !== -1 && row[colIndices.idxOrder] !== undefined ? String(row[colIndices.idxOrder] || '').trim() : '';
      let rawTrack = colIndices.idxTrack !== -1 && row[colIndices.idxTrack] !== undefined ? String(row[colIndices.idxTrack] || '').trim() : '';
      let rawDate = colIndices.idxDate !== -1 && row[colIndices.idxDate] !== undefined ? String(row[colIndices.idxDate] || '').trim() : '';
      let rawSku = colIndices.idxSku !== -1 && row[colIndices.idxSku] !== undefined ? String(row[colIndices.idxSku] || '').trim() : '';
      let rawVariation = colIndices.idxVariation !== -1 && row[colIndices.idxVariation] !== undefined ? String(row[colIndices.idxVariation] || '').trim() : '';
      let rawCarrier = colIndices.idxCarrier !== -1 && row[colIndices.idxCarrier] !== undefined ? String(row[colIndices.idxCarrier] || '').trim() : '';
      let rawPacker = colIndices.idxPacker !== -1 && row[colIndices.idxPacker] !== undefined ? String(row[colIndices.idxPacker] || '').trim() : '';
      let rawNotes = colIndices.idxNotes !== -1 && row[colIndices.idxNotes] !== undefined ? String(row[colIndices.idxNotes] || '').trim() : '';
      let rawStatus = colIndices.idxStatus !== -1 && row[colIndices.idxStatus] !== undefined ? String(row[colIndices.idxStatus] || '').trim() : '';

      // Skip completely empty rows
      if (!rawOrder && !rawTrack && !rawSku) continue;

      // Skip description / instructional rows (e.g. TikTok template Row 1 descriptions)
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

      // Failsafe 1: If rawOrder is a Tracking ID and rawTrack is not, swap them!
      const isTrackLike = (val) => Boolean(val && (/^(THT|TH\d|SPXTH|KEX|KER|JNT)/i.test(val) || (/^\d{13,15}$/.test(val) && val.startsWith('66'))));
      const isOrderLike = (val) => Boolean(val && /^[0-9A-Za-z]{12,25}$/.test(val) && !isTrackLike(val));

      if (isTrackLike(rawOrder) && (!rawTrack || isOrderLike(rawTrack) || parseDateCell(rawTrack))) {
        const temp = rawOrder;
        rawOrder = isOrderLike(rawTrack) ? rawTrack : '';
        rawTrack = temp;
      }

      // Failsafe 2: If rawTrack is a Date string, clear it (NEVER allow date as tracking)
      if (rawTrack && parseDateCell(rawTrack) && !/^\d{14}$/.test(rawTrack) && !isTrackLike(rawTrack)) {
        if (!rawDate) rawDate = rawTrack;
        rawTrack = '';
      }

      // Parse Ship Date
      let shipDate = '';
      if (rawDate) {
        shipDate = parseDateCell(rawDate);
      }
      if (!shipDate) {
        shipDate = targetDate;
      }

      // Combine SKU and Variation
      let finalSku = rawSku;
      if (rawVariation && finalSku && typeof finalSku === 'string' && !finalSku.includes(rawVariation)) {
        finalSku = `${finalSku} [${rawVariation}]`;
      } else if (rawVariation && !finalSku) {
        finalSku = rawVariation;
      }
      if (!finalSku) {
        finalSku = 'โซฟา/เก้าอี้สตูล';
      }

      // Parse Quantity
      let qty = 1;
      if (colIndices.idxQty !== -1 && row[colIndices.idxQty] !== undefined && row[colIndices.idxQty] !== null && row[colIndices.idxQty] !== '') {
        const num = parseInt(String(row[colIndices.idxQty]).replace(/[^0-9]/g, ''), 10);
        if (!isNaN(num) && num > 0) {
          qty = num;
        }
      }

      // Auto-detect Carrier
      const carrier = detectCarrier(rawTrack, rawCarrier);

      // Clean Tracking
      const cleanTrk = normalizeTracking(rawTrack);

      // Check if status in source file is cancelled
      const isCancelled = Boolean(
        rawStatus && (
          rawStatus.includes('ยกเลิก') || 
          rawStatus.toLowerCase().includes('cancel') || 
          rawStatus.toLowerCase().includes('void')
        )
      );

      result.push({
        id: 'ORD-' + now + '-' + Math.random().toString(36).substring(2, 7) + '-' + r,
        shipDate: shipDate,
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

    return result;
  }

  function parseExcelRows(rows) {
    return parseUnifiedRows(rows, state.activeDate);
  }

  function parsePastedOrders(text) {
    const rows = textTo2DArray(text);
    return parseUnifiedRows(rows, state.activeDate);
  }

  function deleteOrder(id) {
    if (!confirm('ยืนยันลบรายการคำสั่งซื้อนี้?')) return;
    state.orders = state.orders.filter((o) => o.id !== id);
    SyncService.saveLocalOrders(state.orders);
    renderAll();
  }

  let activeModalOrderId = null;

  function openOrderActionModal(id) {
    const order = state.orders.find((o) => o.id === id);
    if (!order) return;

    activeModalOrderId = id;
    const modal = $('modal-order-action');
    if (!modal) return;

    if ($('modal-action-order-id')) $('modal-action-order-id').innerText = order.orderId || '-';
    if ($('modal-action-sku')) $('modal-action-sku').innerText = `${order.sku || '-'} [${order.carrier || '-'}]`;
    if ($('modal-action-qty')) $('modal-action-qty').innerText = `${order.qty || 1} ชิ้น`;

    const status = getOrderStatus(order);
    if ($('modal-action-status')) $('modal-action-status').innerHTML = getStatusBadge(status);

    const inputTrack = $('input-modal-tracking');
    if (inputTrack) {
      inputTrack.value = order.trackingId || '';
      setTimeout(() => inputTrack.focus(), 100);
    }

    modal.classList.remove('hidden');
    lucide.createIcons();
  }

  function setupOrderActionModal() {
    const modal = $('modal-order-action');
    const btnClose = $('btn-close-order-action');
    const btnSaveTracking = $('btn-save-modal-tracking');
    const inputTracking = $('input-modal-tracking');
    const btnMarkCancelled = $('btn-mark-modal-cancelled');
    const btnDeleteModalOrder = $('btn-delete-modal-order');

    if (btnClose && modal) {
      btnClose.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }

    if (btnSaveTracking && inputTracking) {
      btnSaveTracking.addEventListener('click', () => {
        if (!activeModalOrderId) return;
        const order = state.orders.find((o) => o.id === activeModalOrderId);
        if (!order) return;

        const val = inputTracking.value.trim();
        if (!val) {
          alert('กรุณาระบุเลขพัสดุ Tracking ID');
          return;
        }

        order.trackingId = val;
        order.cleanTracking = normalizeTracking(val);
        order.carrier = detectCarrier(val, order.carrier);
        order.isCancelled = false; // Reset cancelled flag if valid tracking is supplied

        reconcileScansAndOrders();
        SyncService.saveLocalOrders(state.orders);
        renderAll();

        if (modal) modal.classList.add('hidden');
        alert(`บันทึกเลขพัสดุ ${val} สำหรับคำสั่งซื้อ ${order.orderId} เรียบร้อยแล้วครับ!`);
      });

      inputTracking.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          btnSaveTracking.click();
        }
      });
    }

    if (btnMarkCancelled) {
      btnMarkCancelled.addEventListener('click', () => {
        if (!activeModalOrderId) return;
        const order = state.orders.find((o) => o.id === activeModalOrderId);
        if (!order) return;

        if (confirm(`ยืนยันทำเครื่องหมาย "ลูกค้ายกเลิกคำสั่งซื้อ" ${order.orderId} ใช่หรือไม่?\n\n(ระบบจะตัดรายการนี้ออกจากยอดพัสดุที่ต้องจัดส่งวันนี้)`)) {
          order.isCancelled = true;
          order.orderStatus = 'ลูกค้ายกเลิกคำสั่งซื้อ';
          reconcileScansAndOrders();
          SyncService.saveLocalOrders(state.orders);
          renderAll();

          if (modal) modal.classList.add('hidden');
          alert(`ทำเครื่องหมายยกเลิกคำสั่งซื้อ ${order.orderId} เรียบร้อยแล้ว`);
        }
      });
    }

    if (btnDeleteModalOrder) {
      btnDeleteModalOrder.addEventListener('click', () => {
        if (!activeModalOrderId) return;
        const id = activeModalOrderId;
        if (modal) modal.classList.add('hidden');
        deleteOrder(id);
      });
    }
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
