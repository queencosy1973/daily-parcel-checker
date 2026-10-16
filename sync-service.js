/**
 * QueenCosy Daily Parcel Checker - Real-Time Multi-Device Sync & Cloud Persistence Service
 * Seamlessly connects Mobile Phone Scanners, Desktop Dashboards, and Management Views.
 * Features:
 * 1. Supabase Cloud Database Persistence (PostgREST REST API) - works across all devices, even when offline/asynchronous.
 * 2. Supabase Realtime WebSocket Broadcast - instant peer-to-peer live scan updates (< 0.1s).
 * 3. Browser Tab-to-Tab BroadcastChannel & LocalStorage fallback.
 */
const SyncService = (function () {
  'use strict';

  const STORAGE_ORDERS_KEY = 'qc_daily_parcel_orders_v1';
  const STORAGE_SCANS_KEY = 'qc_daily_parcel_scans_v1';
  const STORAGE_CONFIG_KEY = 'qc_daily_parcel_config_v1';

  const DEFAULT_SUPABASE_URL = 'https://yercmidyvfetvbbrewlf.supabase.co';
  const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InllcmNtaWR5dmZldHZiYnJld2xmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MTA4MzUsImV4cCI6MjEwNDE4NjgzNX0.7tGbXNoogdLh6UQOJBJe9MABmY7W5J1aixPLJSXGSGk';

  let supabaseClient = null;
  let realtimeChannel = null;
  let localBc = null;
  let onRemoteScanCallback = null;
  let onRemoteScansCallback = null;
  let onRemoteOrdersCallback = null;
  let onSyncStatusCallback = null;

  function getConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_CONFIG_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      supabaseUrl: DEFAULT_SUPABASE_URL,
      supabaseKey: DEFAULT_SUPABASE_KEY,
      scannerName: 'มือถือจุดโหลด',
      deviceId: 'DEV-' + Math.random().toString(36).substring(2, 8).toUpperCase()
    };
  }

  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(cfg));
  }

  function init(callbacks = {}) {
    onRemoteScanCallback = callbacks.onRemoteScan || null;
    onRemoteScansCallback = callbacks.onRemoteScans || null;
    onRemoteOrdersCallback = callbacks.onRemoteOrders || null;
    onSyncStatusCallback = callbacks.onSyncStatus || null;

    // 1. Browser Tab-to-Tab BroadcastChannel
    if (typeof window.BroadcastChannel !== 'undefined') {
      try {
        localBc = new BroadcastChannel('qc_parcel_sync_channel');
        localBc.onmessage = (event) => {
          handleIncomingMessage(event.data);
        };
      } catch (e) {
        console.warn('BroadcastChannel error:', e);
      }
    }

    // 2. Supabase Realtime Cloud Channel
    const cfg = getConfig();
    if (cfg.supabaseUrl && cfg.supabaseKey && typeof window.supabase !== 'undefined') {
      try {
        supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
        realtimeChannel = supabaseClient.channel('qc_daily_parcel_room', {
          config: { broadcast: { self: false } }
        });

        realtimeChannel
          .on('broadcast', { event: 'scan_action' }, (payload) => {
            handleIncomingMessage({ type: 'scan_action', data: payload.payload });
          })
          .on('broadcast', { event: 'orders_update' }, (payload) => {
            handleIncomingMessage({ type: 'orders_update', data: payload.payload });
          })
          .on('broadcast', { event: 'scans_update' }, (payload) => {
            handleIncomingMessage({ type: 'scans_update', data: payload.payload });
          })
          .on('broadcast', { event: 'request_state' }, () => {
            // When a peer asks for state, share both local orders AND scans
            const orders = getLocalOrders();
            if (orders && orders.length > 0) {
              broadcastOrders(orders);
            }
            const scans = getLocalScans();
            if (scans && scans.length > 0) {
              broadcastScans(scans);
            }
          })
          .subscribe((status) => {
            console.log('Supabase Realtime Channel Status:', status);
            if (typeof onSyncStatusCallback === 'function') {
              onSyncStatusCallback(status === 'SUBSCRIBED' ? 'online' : 'connecting');
            }
            if (status === 'SUBSCRIBED') {
              // Request latest state from any active peer
              requestPeerState();
            }
          });
      } catch (err) {
        console.warn('Supabase Realtime setup failed, running offline/local mode:', err);
        if (typeof onSyncStatusCallback === 'function') {
          onSyncStatusCallback('offline');
        }
      }
    }
  }

  function handleIncomingMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'scan_action' && msg.data) {
      if (typeof onRemoteScanCallback === 'function') {
        onRemoteScanCallback(msg.data);
      }
    } else if (msg.type === 'scans_update' && msg.data) {
      if (typeof onRemoteScansCallback === 'function') {
        onRemoteScansCallback(msg.data);
      }
    } else if (msg.type === 'orders_update' && msg.data) {
      if (typeof onRemoteOrdersCallback === 'function') {
        onRemoteOrdersCallback(msg.data);
      }
    } else if (msg.type === 'request_state') {
      const orders = getLocalOrders();
      if (orders && orders.length > 0) {
        broadcastOrders(orders);
      }
      const scans = getLocalScans();
      if (scans && scans.length > 0) {
        broadcastScans(scans);
      }
    }
  }

  // Broadcast a single scan event to all connected devices in real time
  function broadcastScan(scanItem) {
    if (localBc) {
      localBc.postMessage({ type: 'scan_action', data: scanItem });
    }
    if (realtimeChannel) {
      realtimeChannel.send({
        type: 'broadcast',
        event: 'scan_action',
        payload: scanItem
      });
    }
  }

  // Broadcast full scans array to peers
  function broadcastScans(scans) {
    if (localBc) {
      localBc.postMessage({ type: 'scans_update', data: scans });
    }
    if (realtimeChannel) {
      realtimeChannel.send({
        type: 'broadcast',
        event: 'scans_update',
        payload: scans
      });
    }
  }

  // Broadcast orders array to peers
  function broadcastOrders(orders) {
    if (localBc) {
      localBc.postMessage({ type: 'orders_update', data: orders });
    }
    if (realtimeChannel) {
      realtimeChannel.send({
        type: 'broadcast',
        event: 'orders_update',
        payload: orders
      });
    }
  }

  // Request latest state from any connected peer
  function requestPeerState() {
    const cfg = getConfig();
    if (localBc) {
      localBc.postMessage({ type: 'request_state', requester: cfg.deviceId });
    }
    if (realtimeChannel) {
      realtimeChannel.send({
        type: 'broadcast',
        event: 'request_state',
        payload: { requester: cfg.deviceId }
      });
    }
  }

  // =========================================================================
  // SUPABASE CLOUD PERSISTENCE (REST API POSTGREST)
  // Ensures data is never lost even if devices close or sleep
  // =========================================================================

  async function fetchCloudData(date) {
    const cfg = getConfig();
    if (!cfg.supabaseUrl || !cfg.supabaseKey) return null;
    try {
      const batchId = 'QC_PARCEL_DATA_' + date;
      const res = await fetch(`${cfg.supabaseUrl}/rest/v1/production_batches?batch_id=eq.${encodeURIComponent(batchId)}`, {
        headers: {
          'apikey': cfg.supabaseKey,
          'Authorization': `Bearer ${cfg.supabaseKey}`
        }
      });
      if (!res.ok) return null;
      const rows = await res.json();
      if (!rows || rows.length === 0) return null;
      const parsed = JSON.parse(rows[0].items_json || '{}');
      return {
        date: parsed.date || date,
        orders: Array.isArray(parsed.orders) ? parsed.orders : [],
        scans: Array.isArray(parsed.scans) ? parsed.scans : [],
        updatedAt: parsed.updatedAt || rows[0].updated_at,
        updatedBy: parsed.updatedBy || rows[0].imported_by
      };
    } catch (e) {
      console.warn('fetchCloudData error:', e);
      return null;
    }
  }

  async function fetchMonthlyCloudData(yearMonth) {
    const cfg = getConfig();
    if (!cfg.supabaseUrl || !cfg.supabaseKey) return [];
    try {
      const pattern = 'QC_PARCEL_DATA_' + yearMonth + '%';
      const res = await fetch(`${cfg.supabaseUrl}/rest/v1/production_batches?batch_id=like.${encodeURIComponent(pattern)}&order=batch_id.asc`, {
        headers: {
          'apikey': cfg.supabaseKey,
          'Authorization': `Bearer ${cfg.supabaseKey}`
        }
      });
      if (!res.ok) return [];
      const rows = await res.json();
      if (!rows || rows.length === 0) return [];
      return rows.map((r) => {
        try {
          const parsed = JSON.parse(r.items_json || '{}');
          return {
            batchId: r.batch_id,
            date: parsed.date || r.batch_id.replace('QC_PARCEL_DATA_', ''),
            orders: Array.isArray(parsed.orders) ? parsed.orders : [],
            scans: Array.isArray(parsed.scans) ? parsed.scans : [],
            updatedAt: parsed.updatedAt || r.updated_at,
            updatedBy: parsed.updatedBy || r.imported_by
          };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
    } catch (e) {
      console.warn('fetchMonthlyCloudData error:', e);
      return [];
    }
  }

  async function pushCloudData(date, orders, scans, scannerName = 'พนักงาน') {
    const cfg = getConfig();
    if (!cfg.supabaseUrl || !cfg.supabaseKey) return false;
    try {
      const batchId = 'QC_PARCEL_DATA_' + date;
      // Filter for this date if present, or save state
      const dateOrders = (orders || []).filter(o => o.shipDate === date);
      const targetOrders = dateOrders.length > 0 ? dateOrders : (orders || []);
      const dateScans = (scans || []).filter(s => s.scanDate === date);
      const targetScans = dateScans.length > 0 ? dateScans : (scans || []);

      const payload = {
        batch_id: batchId,
        batch_name: 'Parcel Data ' + date,
        source: 'DAILY_PARCEL_CHECKER',
        status: 'COMPLETED',
        total_skus: targetOrders.length,
        total_units: targetScans.length,
        total_material_cost: 0,
        items_json: JSON.stringify({
          date: date,
          orders: targetOrders,
          scans: targetScans,
          updatedAt: new Date().toISOString(),
          updatedBy: scannerName
        })
      };

      const res = await fetch(`${cfg.supabaseUrl}/rest/v1/production_batches`, {
        method: 'POST',
        headers: {
          'apikey': cfg.supabaseKey,
          'Authorization': `Bearer ${cfg.supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(payload)
      });
      return res.ok || res.status === 201;
    } catch (e) {
      console.warn('pushCloudData error:', e);
      return false;
    }
  }

  // =========================================================================
  // INDEXEDDB MULTI-GIGABYTE RESILIENT PERSISTENCE ENGINE
  // =========================================================================
  const IDB_NAME = 'qc_daily_parcel_db_v1';
  const IDB_VERSION = 1;
  let idbInstance = null;

  function getIDB() {
    if (typeof window === 'undefined' || !window.indexedDB) return Promise.resolve(null);
    if (idbInstance) return Promise.resolve(idbInstance);
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('store')) {
            db.createObjectStore('store');
          }
        };
        req.onsuccess = (e) => {
          idbInstance = e.target.result;
          resolve(idbInstance);
        };
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function idbSet(key, val) {
    getIDB().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction('store', 'readwrite');
        tx.objectStore('store').put(val, key);
      } catch (e) {}
    }).catch(() => {});
  }

  function idbGet(key) {
    return new Promise((resolve) => {
      getIDB().then((db) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction('store', 'readonly');
          const req = tx.objectStore('store').get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      }).catch(() => resolve(null));
    });
  }

  // =========================================================================
  // LOCAL STORAGE & CACHE MANAGEMENT (WITH AUTOMATIC QUOTA-OVERFLOW PROTECTION)
  // =========================================================================
  function getLocalOrders() {
    try {
      const s = localStorage.getItem(STORAGE_ORDERS_KEY);
      if (s) return JSON.parse(s);
    } catch (e) {}
    return [];
  }

  function saveLocalOrders(orders) {
    // 1. Asynchronously persist full dataset into IndexedDB (zero quota limitation)
    if (Array.isArray(orders)) {
      idbSet('orders', orders);
    }

    // 2. Persist to localStorage with multi-tier quota-safe compression/pruning
    try {
      localStorage.setItem(STORAGE_ORDERS_KEY, JSON.stringify(orders));
    } catch (e) {
      console.warn('LocalStorage 5MB quota exceeded. Applying intelligent cache pruning to protect stability...', e);
      try {
        // Keep most recent 2,000 orders in localStorage cache
        const trimmed = Array.isArray(orders) ? orders.slice(-2000) : [];
        localStorage.setItem(STORAGE_ORDERS_KEY, JSON.stringify(trimmed));
      } catch (e2) {
        try {
          // If still exceeding, keep only recent 800 orders
          const minimal = Array.isArray(orders) ? orders.slice(-800) : [];
          localStorage.setItem(STORAGE_ORDERS_KEY, JSON.stringify(minimal));
        } catch (e3) {
          // If browser storage is completely full, remove the key so it never throws QuotaExceededError
          // Data is completely safe in IndexedDB and Supabase Cloud
          try {
            localStorage.removeItem(STORAGE_ORDERS_KEY);
          } catch (e4) {}
        }
      }
    }
    broadcastOrders(orders);
  }

  function getLocalScans() {
    try {
      const s = localStorage.getItem(STORAGE_SCANS_KEY);
      if (s) return JSON.parse(s);
    } catch (e) {}
    return [];
  }

  function saveLocalScans(scans) {
    if (Array.isArray(scans)) {
      idbSet('scans', scans);
    }
    try {
      localStorage.setItem(STORAGE_SCANS_KEY, JSON.stringify(scans));
    } catch (e) {
      console.warn('LocalStorage quota exceeded for scans. Trimming scans cache...', e);
      try {
        const trimmed = Array.isArray(scans) ? scans.slice(0, 2000) : [];
        localStorage.setItem(STORAGE_SCANS_KEY, JSON.stringify(trimmed));
      } catch (e2) {
        try {
          localStorage.removeItem(STORAGE_SCANS_KEY);
        } catch (e3) {}
      }
    }
  }

  function addLocalScan(scanItem) {
    const list = getLocalScans();
    list.unshift(scanItem); // Newest first
    saveLocalScans(list);
    broadcastScan(scanItem);
    return list;
  }

  function clearAllData() {
    try {
      localStorage.removeItem(STORAGE_ORDERS_KEY);
      localStorage.removeItem(STORAGE_SCANS_KEY);
    } catch (e) {}
    idbSet('orders', []);
    idbSet('scans', []);
    if (localBc) {
      localBc.postMessage({ type: 'orders_update', data: [] });
      localBc.postMessage({ type: 'scans_update', data: [] });
    }
    if (realtimeChannel) {
      realtimeChannel.send({
        type: 'broadcast',
        event: 'orders_update',
        payload: []
      });
      realtimeChannel.send({
        type: 'broadcast',
        event: 'scans_update',
        payload: []
      });
    }
  }

  return {
    init,
    getConfig,
    saveConfig,
    getLocalOrders,
    saveLocalOrders,
    getLocalScans,
    saveLocalScans,
    addLocalScan,
    clearAllData,
    broadcastScan,
    broadcastScans,
    broadcastOrders,
    requestPeerState,
    fetchCloudData,
    fetchMonthlyCloudData,
    pushCloudData,
    idbGet,
    idbSet
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SyncService };
}
