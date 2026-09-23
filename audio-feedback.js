/**
 * QueenCosy Audio Feedback Synthesizer using Web Audio API
 * Works 100% offline without requiring any mp3 audio assets.
 * Configured specifically for warehouse & barcode scanning operations.
 */
const AudioFeedback = (function () {
  'use strict';

  let audioCtx = null;

  function getContext() {
    if (!audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        audioCtx = new AudioContext();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  // Play Success Sound (2-tone ascending bell chime) - Match found & scanned
  function success() {
    try {
      const ctx = getContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880.00, now + 0.1); // A5

      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.35);

      if (navigator.vibrate) {
        navigator.vibrate(80);
      }
    } catch (e) {
      console.warn('AudioFeedback error:', e);
    }
  }

  // Play Error Sound (Low buzz rejection tone) - Not found in today's order list!
  function error() {
    try {
      const ctx = getContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.linearRampToValueAtTime(100, now + 0.25);

      gain.gain.setValueAtTime(0.4, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.3);

      if (navigator.vibrate) {
        navigator.vibrate([150, 80, 150]);
      }
    } catch (e) {
      console.warn('AudioFeedback error:', e);
    }
  }

  // Play Duplicate Warning Sound (2 quick distinct beeps) - Already scanned earlier
  function duplicate() {
    try {
      const ctx = getContext();
      if (!ctx) return;

      const now = ctx.currentTime;

      // Beep 1
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(659.25, now); // E5
      gain1.gain.setValueAtTime(0.3, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.12);

      // Beep 2
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(659.25, now + 0.16); // E5
      gain2.gain.setValueAtTime(0.3, now + 0.16);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.16);
      osc2.stop(now + 0.28);

      if (navigator.vibrate) {
        navigator.vibrate([80, 50, 80]);
      }
    } catch (e) {
      console.warn('AudioFeedback error:', e);
    }
  }

  // Play Warning / Notice Sound (Single short beep)
  function warning() {
    try {
      const ctx = getContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now); // A4

      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.2);

      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
    } catch (e) {
      console.warn('AudioFeedback error:', e);
    }
  }

  return {
    init: getContext,
    success,
    error,
    duplicate,
    warning
  };
})();
