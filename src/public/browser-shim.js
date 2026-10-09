/* ============================================================================
 * browser-shim.js — Suno-Song-Remaster web patch
 *
 * When this app runs as a plain website (Vercel / any static host) there is
 * no Electron runtime, so `window.electronAPI` (normally injected by
 * electron/preload.js) does not exist and every file operation silently fails.
 *
 * This shim recreates the same `electronAPI` surface using browser APIs:
 *   - selectFile / selectFiles  -> hidden <input type="file">
 *   - getPathForFile           -> registers a dropped File, returns a fake path
 *   - readAudioFile            -> File.arrayBuffer()
 *   - saveFile / writeFile / selectDirectory -> Blob download to user's folder
 *   - getSystemInfo            -> static stub (only used by the debug dialog)
 *   - minimize/maximize/close  -> no-ops, window buttons are hidden via CSS
 *
 * Fake paths look like "webfile://f3/song.mp3". The app only ever uses them as
 * opaque keys (display name via split(/[\\/]/).pop(), queue identity), so this
 * is safe. Real file bytes live in the in-memory registry below.
 * ========================================================================== */
(function () {
  'use strict';

  // In Electron the preload script already defined this — don't override it.
  if (window.electronAPI) return;

  var registry = new Map(); // fakePath -> File
  var counter = 0;

  function registerFile(file) {
    var key = 'webfile://f' + (counter++) + '/' + file.name;
    registry.set(key, file);
    return key;
  }

  function baseName(p) {
    return String(p).split(/[\\/]/).pop();
  }

  function pickAudioFiles(multiple) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.mp3,.wav,.flac,.aac,.m4a,audio/mpeg,audio/wav,audio/flac,audio/aac,audio/mp4,audio/*';
      input.multiple = !!multiple;
      // Off-screen (not display:none) so programmatic click reliably opens it.
      input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
      var settled = false;

      function done(keys) {
        if (settled) return;
        settled = true;
        window.removeEventListener('focus', onWindowFocus);
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(keys);
      }
      // If the user cancels the dialog, no "change" fires — focus coming back
      // to the window is our only signal. Attach late to avoid catching the
      // focus churn of opening the dialog itself.
      function onWindowFocus() {
        setTimeout(function () { done([]); }, 400);
      }

      input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files || []);
        done(files.map(registerFile));
      });

      document.body.appendChild(input);
      input.click();
      setTimeout(function () {
        window.addEventListener('focus', onWindowFocus);
      }, 600);
    });
  }

  function downloadWav(uint8, filename) {
    var blob = new Blob([uint8], { type: 'audio/wav' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'mastered.wav';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 8000);
  }

  function currentUiFileStem() {
    // Single-file export doesn't know the source name; read it from the UI.
    var label = document.getElementById('fileName');
    var shown = label ? label.textContent.trim() : '';
    if (!shown || /no file/i.test(shown)) return 'audio';
    return shown.replace(/\.[^.]+$/, '');
  }

  window.electronAPI = {
    selectFile: function () {
      return pickAudioFiles(false).then(function (keys) {
        return keys[0] || null;
      });
    },

    selectFiles: function () {
      return pickAudioFiles(true);
    },

    selectDirectory: function () {
      // Browsers can't pick an export folder; mastered files download to the
      // user's download directory. The app joins names onto this fake dir.
      return Promise.resolve('downloads/');
    },

    saveFile: function () {
      // Sentinel: writeFile() turns this into a real browser download.
      return Promise.resolve('downloads/__single__');
    },

    getPathForFile: function (file) {
      if (file instanceof File) return registerFile(file);
      return null;
    },

    readAudioFile: function (key) {
      var file = registry.get(key);
      if (!file) {
        return Promise.reject(new Error('File tidak ditemukan di sesi browser ini.'));
      }
      return file.arrayBuffer().then(function (buf) {
        return Array.from(new Uint8Array(buf));
      });
    },

    writeFile: function (key, data) {
      var uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      var name = baseName(key);
      if (!name || name === '__single__') {
        name = currentUiFileStem() + '_mastered.wav';
      }
      downloadWav(uint8, name);
      return Promise.resolve();
    },

    getSystemInfo: function () {
      return Promise.resolve({
        platform: 'web',
        arch: 'browser',
        isPackaged: false,
        electronVersion: 'n/a (browser)',
        nodeVersion: 'n/a (browser)',
        appPath: 'browser'
      });
    },

    minimizeWindow: function () {},
    maximizeWindow: function () {},
    closeWindow: function () {}
  };

  // Electron window buttons make no sense on the web — hide them.
  function hideWindowControls() {
    var el = document.querySelector('.window-controls');
    if (el) el.style.display = 'none';
    var style = document.createElement('style');
    style.textContent = '.window-controls{display:none !important}';
    document.head.appendChild(style);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideWindowControls);
  } else {
    hideWindowControls();
  }
})();
