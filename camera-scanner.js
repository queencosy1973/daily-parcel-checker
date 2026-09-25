/**
 * QueenCosy Camera Scanner Module (Html5Qrcode Engine)
 * Replicates the robust mobile camera scanner architecture from traceability-web.
 * Features:
 * - Anti-freeze guard (no scanner.pause on mobile)
 * - Auto-detects rear / environment camera
 * - Visual ring pulses for status feedback
 * - Barcode scan cooldown to prevent double-triggering
 */
const CameraScanner = (function () {
  'use strict';

  let html5QrCode = null;
  let isRunning = false;
  let isScanLocked = false;
  let lastScannedCode = '';
  let lastScannedTimestamp = 0;
  let currentContainerId = '';
  let currentBoxId = '';
  let onScanCallback = null;

  async function start(containerId, boxId, onScan) {
    if (typeof window.Html5Qrcode === 'undefined') {
      alert('โมดูลกล้องกำลังโหลด หรือเบราว์เซอร์ไม่รองรับ กรุณาใช้ช่องยิงบาร์โค้ด');
      return false;
    }

    if (isRunning) {
      await stop();
    }

    currentContainerId = containerId;
    currentBoxId = boxId;
    onScanCallback = onScan;

    const box = document.getElementById(boxId);
    if (box) box.classList.remove('hidden');

    html5QrCode = new window.Html5Qrcode(containerId);

    // Optimized for shipping label barcodes (wide aspect ratio 1D barcodes and QR)
    const config = {
      fps: 10,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
        const qrboxWidth = Math.floor(viewfinderWidth * 0.85);
        const qrboxHeight = Math.floor(Math.min(minEdge * 0.65, 200));
        return { width: Math.max(qrboxWidth, 240), height: Math.max(qrboxHeight, 140) };
      },
      aspectRatio: 1.333333
    };

    const handleSuccess = async (decodedText) => {
      const now = Date.now();
      const clean = String(decodedText || '').trim();
      if (!clean) return;

      // Lock guard against rapid repetitive scans
      if (isScanLocked) return;
      if (clean === lastScannedCode && (now - lastScannedTimestamp) < 2200) {
        return;
      }

      isScanLocked = true;
      lastScannedCode = clean;
      lastScannedTimestamp = now;

      // Visual trigger feedback ring
      const readerBox = document.getElementById(boxId);
      if (readerBox) {
        readerBox.classList.add('ring-4', 'ring-emerald-400', 'border-emerald-500');
      }

      // Execute scan callback (DO NOT pause scanner video, to prevent iOS Safari/Android freeze)
      try {
        if (typeof onScanCallback === 'function') {
          await onScanCallback(clean);
        }
      } catch (err) {
        console.error('Camera scan execution error:', err);
      }

      // Unlock after 1.4s cooldown
      setTimeout(() => {
        if (readerBox) {
          readerBox.classList.remove('ring-4', 'ring-emerald-400', 'border-emerald-500', 'ring-rose-500', 'border-rose-500', 'ring-amber-400', 'border-amber-500');
        }
        isScanLocked = false;
      }, 1400);
    };

    const handleFailure = () => {
      // Ignored for smoother continuous scanning
    };

    try {
      // Primary attempt: environment facing camera
      await html5QrCode.start({ facingMode: 'environment' }, config, handleSuccess, handleFailure);
      isRunning = true;
      return true;
    } catch (err) {
      console.warn('Environment camera failed, trying fallback camera device selector:', err);
      try {
        const devices = await window.Html5Qrcode.getCameras();
        if (devices && devices.length > 0) {
          const backCam = devices.find(d => /back|rear|environment/i.test(d.label)) || devices[devices.length - 1];
          await html5QrCode.start(backCam.id, config, handleSuccess, handleFailure);
          isRunning = true;
          return true;
        }
      } catch (devErr) {
        console.error('Fallback camera error:', devErr);
      }
      alert('ไม่สามารถเปิดกล้องได้: ' + (err.message || err));
      if (box) box.classList.add('hidden');
      return false;
    }
  }

  async function stop() {
    if (html5QrCode && isRunning) {
      try {
        await html5QrCode.stop();
      } catch (e) {
        console.warn('Camera stop error:', e);
      }
    }
    isRunning = false;
    html5QrCode = null;
    isScanLocked = false;

    if (currentBoxId) {
      const box = document.getElementById(currentBoxId);
      if (box) {
        box.classList.add('hidden');
        box.classList.remove('ring-4', 'ring-emerald-400', 'border-emerald-500', 'ring-rose-500', 'border-rose-500', 'ring-amber-400', 'border-amber-500', 'ring-sky-400', 'border-sky-500');
      }
    }
  }

  function flashBox(type) {
    if (!currentBoxId) return;
    const box = document.getElementById(currentBoxId);
    if (!box) return;

    box.classList.remove('ring-4', 'ring-8', 'ring-emerald-400', 'border-emerald-500', 'ring-rose-500', 'ring-rose-600', 'border-rose-500', 'border-rose-600', 'ring-amber-400', 'border-amber-500', 'ring-sky-400', 'border-sky-500', 'animate-pulse');

    if (type === 'success') {
      box.classList.add('ring-4', 'ring-emerald-400', 'border-emerald-500');
    } else if (type === 'blocked') {
      box.classList.add('ring-8', 'ring-rose-600', 'border-rose-600', 'animate-pulse');
    } else if (type === 'error') {
      box.classList.add('ring-4', 'ring-rose-500', 'border-rose-500');
    } else if (type === 'duplicate') {
      box.classList.add('ring-4', 'ring-amber-400', 'border-amber-500');
    } else if (type === 'pending') {
      box.classList.add('ring-4', 'ring-sky-400', 'border-sky-500');
    }

    setTimeout(() => {
      box.classList.remove('ring-4', 'ring-8', 'ring-emerald-400', 'border-emerald-500', 'ring-rose-500', 'ring-rose-600', 'border-rose-500', 'border-rose-600', 'ring-amber-400', 'border-amber-500', 'ring-sky-400', 'border-sky-500', 'animate-pulse');
    }, 1200);
  }

  return {
    start,
    stop,
    flashBox,
    isRunning: () => isRunning
  };
})();
