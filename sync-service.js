/**
 * QueenCosy Daily Parcel Checker - Real-Time Multi-Device Sync Service
 * Seamlessly connects Mobile Phone Scanners with Desktop / Tablet Dashboards.
 * Combines Supabase Realtime Broadcast, BroadcastChannel, and LocalStorage.
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
  let onRemoteOrdersCallback = null;

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
    onRemoteOrdersCallback = callbacks.onRemoteOrders || null;

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
          .on('broadcast', { event: 'request_state' }, () => {
            // If we have orders, send current state to the requesting client
            const orders = getLocalOrders();
            if (orders && orders.length > 0) {
              broadcastOrders(orders);
            }
          })
          .subscribe((status) => {
            console.log('Supabase Realtime Channel Status:', status);
            if (status === 'SUBSCRIBED') {
              // Request latest state from any peer
              realtimeChannel.send({
                type: 'broadcast',
                event: 'request_state',
                payload: { requester: cfg.deviceId }
              });
            }
          });
      } catch (err) {
        console.warn('Supabase Realtime setup failed, running offline/local mode:', err);
      }
    }
  }

  function handleIncomingMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'scan_action' && msg.data) {
      if (typeof onRemoteScanCallback === 'function') {
        onRemoteScanCallback(msg.data);
      }
    } else if (msg.type === 'orders_update' && msg.data) {
      if (typeof onRemoteOrdersCallback === 'function') {
        onRemoteOrdersCallback(msg.data);
      }
    }
  }

  // Broadcast a new scan event to all connected devices (Mobile -> Desktop & Vice versa)
  function broadcastScan(scanItem) {
    // 1. Broadcast locally
    if (localBc) {
      localBc.postMessage({ type: 'scan_action', data: scanItem });
    }

    // 2. Broadcast via Supabase Cloud Realtime
    if (realtimeChannel) {
      realtimeChannel.send({
        type: 'broadcast',
        event: 'scan_action',
        payload: scanItem
      });
    }
  }

  // Broadcast orders update
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

  // Local Storage Management
  function getLocalOrders() {
    try {
      const s = localStorage.getItem(STORAGE_ORDERS_KEY);
      if (s) return JSON.parse(s);
    } catch (e) {}
    return [];
  }

  function saveLocalOrders(orders) {
    localStorage.setItem(STORAGE_ORDERS_KEY, JSON.stringify(orders));
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
    localStorage.setItem(STORAGE_SCANS_KEY, JSON.stringify(scans));
  }

  function addLocalScan(scanItem) {
    const list = getLocalScans();
    list.unshift(scanItem); // Newest first
    saveLocalScans(list);
    broadcastScan(scanItem);
    return list;
  }

  function clearAllData() {
    localStorage.removeItem(STORAGE_ORDERS_KEY);
    localStorage.removeItem(STORAGE_SCANS_KEY);
    if (localBc) {
      localBc.postMessage({ type: 'orders_update', data: [] });
    }
    if (realtimeChannel) {
      realtimeChannel.send({
        type: 'broadcast',
        event: 'orders_update',
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
    broadcastOrders
  };
})();
