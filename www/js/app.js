/**
 * MelodyBox - 无损音乐播放器
 * 支持 FLAC/WAV/APE 解码、联网歌词、歌曲下载、插件扩展
 */

// ==================== 事件总线 ====================
class EventBus {
  constructor() { this._handlers = {}; }
  on(event, fn) { (this._handlers[event] ||= []).push(fn); return () => this.off(event, fn); }
  off(event, fn) { const h = this._handlers[event]; if (h) this._handlers[event] = h.filter(f => f !== fn); }
  emit(event, ...args) { (this._handlers[event] || []).forEach(fn => fn(...args)); }
}

// ==================== 存储管理器 ====================
class StorageManager {
  constructor() {
    this.db = null;
    this.DB_NAME = 'melodybox';
    this.DB_VER = 1;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('library')) {
          db.createObjectStore('library', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('playlists')) {
          db.createObjectStore('playlists', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('lyrics')) {
          db.createObjectStore('lyrics', { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror = reject;
    });
  }

  async get(store, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = reject;
    });
  }

  async getAll(store) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = reject;
    });
  }

  async put(store, data) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = reject;
    });
  }

  async delete(store, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = reject;
    });
  }

  async saveSetting(key, value) { return this.put('settings', { key, value }); }
  async getSetting(key) { const r = await this.get('settings', key); return r ? r.value : null; }
}

// ==================== 音频引擎 ====================
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.gainNode = null;
    this.analyser = null;
    this.currentTrack = null;
    this.isPlaying = false;
    this.startTime = 0;
    this.pauseTime = 0;
    this.audioBuffer = null;
    this.duration = 0;
    this.volume = 0.8;
    this.playbackRate = 1;
    this.onTimeUpdate = null;
    this.onStateChange = null;
    this.onTrackEnd = null;
    this._rafId = null;
  }

  init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.gainNode = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.setVolume(this.volume);
  }

  async decodeAudio(arrayBuffer) {
    try {
      this.audioBuffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
      this.duration = this.audioBuffer.duration;
      return this.audioBuffer;
    } catch (e) {
      // FLAC fallback: try re-encoding header if Chrome fails
      console.warn('Native decode failed, trying FLAC workaround:', e.message);
      throw e;
    }
  }

  async loadTrack(track) {
    this.stop();
    this.currentTrack = track;
    try {
      let buffer;
      if (track.file) {
        buffer = await track.file.arrayBuffer();
      } else if (track.data) {
        buffer = track.data;
      } else {
        throw new Error('No audio data');
      }
      await this.decodeAudio(buffer);
      this.emitState('loaded');
      this.play();
    } catch (e) {
      console.error('Failed to load track:', e);
      this.emitState('error');
      throw e;
    }
  }

  play() {
    if (!this.audioBuffer) return;
    this.stop();
    this.source = this.ctx.createGain();
    this.source.gain.value = 1;

    const bufferSource = this.ctx.createBufferSource();
    bufferSource.buffer = this.audioBuffer;
    bufferSource.playbackRate.value = this.playbackRate;

    const offset = this.pauseTime % this.duration;
    bufferSource.connect(this.source);
    this.source.connect(this.gainNode);

    bufferSource.start(0, offset);
    this.startTime = this.ctx.currentTime - offset;
    this.pauseTime = offset;
    this.isPlaying = true;
    this.emitState('playing');
    this._startRAF();

    bufferSource.onended = () => {
      if (this.isPlaying && this.ctx.currentTime - this.startTime >= this.duration - 0.1) {
        this.isPlaying = false;
        this.pauseTime = 0;
        this.emitState('ended');
        if (this.onTrackEnd) this.onTrackEnd();
      }
    };
    this._bufferSource = bufferSource;
  }

  pause() {
    if (!this.isPlaying) return;
    this.pauseTime = this.getCurrentTime();
    this.isPlaying = false;
    this._stopSource();
    this._stopRAF();
    this.emitState('paused');
  }

  resume() {
    if (this.isPlaying) return;
    this.play();
  }

  stop() {
    this.isPlaying = false;
    this._stopSource();
    this._stopRAF();
    this.pauseTime = 0;
  }

  _stopSource() {
    try { if (this._bufferSource) this._bufferSource.stop(); } catch (e) { /* ignore */ }
    this._bufferSource = null;
  }

  seek(time) {
    const wasPlaying = this.isPlaying;
    this._stopSource();
    this.pauseTime = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) this.play();
    else this.emitState('seeked');
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gainNode) this.gainNode.gain.value = this.volume;
  }

  setPlaybackRate(rate) {
    this.playbackRate = Math.max(0.5, Math.min(2, rate));
    if (this._bufferSource) this._bufferSource.playbackRate.value = this.playbackRate;
  }

  getCurrentTime() {
    if (this.isPlaying) {
      return (this.ctx.currentTime - this.startTime) % this.duration;
    }
    return this.pauseTime;
  }

  getProgress() {
    return this.duration > 0 ? this.getCurrentTime() / this.duration : 0;
  }

  getFrequencyData() {
    if (!this.analyser) return new Uint8Array(0);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }

  getWaveformData() {
    if (!this.analyser) return new Uint8Array(0);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    return data;
  }

  _startRAF() {
    const tick = () => {
      if (!this.isPlaying) return;
      if (this.onTimeUpdate) this.onTimeUpdate(this.getCurrentTime(), this.duration, this.getProgress());
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopRAF() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  emitState(state) {
    if (this.onStateChange) this.onStateChange(state);
  }
}

// ==================== 歌词引擎 ====================
class LyricsEngine {
  constructor() {
    this.lyrics = [];  // [{time, text}]
    this.offset = 0;   // ms adjustment
    this.currentIndex = -1;
    this.onLyricsUpdate = null;
  }

  async searchLyrics(title, artist, duration) {
    const queries = [
      `https://lrclib.net/api/search?q=${encodeURIComponent((artist || '') + ' ' + title)}`,
      `https://lrclib.net/api/search?q=${encodeURIComponent(title)}`
    ];

    for (const url of queries) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const results = await res.json();
        if (!results || results.length === 0) continue;

        // Match by duration proximity
        let best = results[0];
        if (duration) {
          results.forEach(r => {
            if (r.duration && Math.abs(r.duration - duration) < Math.abs((best.duration || 0) - duration)) {
              best = r;
            }
          });
        }

        // Get synced lyrics
        if (best.syncedLyrics) {
          return this.parseLRC(best.syncedLyrics);
        } else if (best.id) {
          const detailRes = await fetch(`https://lrclib.net/api/get/${best.id}`,
            { signal: AbortSignal.timeout(5000) });
          if (detailRes.ok) {
            const detail = await detailRes.json();
            if (detail.syncedLyrics) return this.parseLRC(detail.syncedLyrics);
            if (detail.plainLyrics) return [{ time: 0, text: detail.plainLyrics }];
          }
        }
      } catch (e) { continue; }
    }
    return [];
  }

  parseLRC(lrcText) {
    const lines = lrcText.split('\n');
    const result = [];
    const timeRe = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;

    lines.forEach(line => {
      const times = [];
      let match;
      while ((match = timeRe.exec(line)) !== null) {
        const ms = parseInt(match[1]) * 60000 + parseInt(match[2]) * 1000 +
                   parseInt(match[3].padEnd(3, '0'));
        times.push(ms);
      }
      const text = line.replace(/\[.*?\]/g, '').trim();
      if (text) times.forEach(t => result.push({ time: t, text }));
    });

    // Also parse offset tag
    const offsetMatch = lrcText.match(/\[offset:([+-]?\d+)\]/);
    if (offsetMatch) this.offset = parseInt(offsetMatch[1]);

    result.sort((a, b) => a.time - b.time);
    this.lyrics = result;
    return result;
  }

  getCurrentLine(currentTimeMs) {
    const t = currentTimeMs + this.offset;
    let idx = -1;
    for (let i = 0; i < this.lyrics.length; i++) {
      if (this.lyrics[i].time <= t) idx = i;
      else break;
    }
    if (idx !== this.currentIndex) {
      this.currentIndex = idx;
      if (this.onLyricsUpdate) this.onLyricsUpdate(idx, this.lyrics);
    }
    return idx;
  }

  setOffset(ms) { this.offset = ms; }
}

// ==================== 下载管理器 ====================
class DownloadManager {
  constructor() {
    this.queue = [];
    this.active = [];
    this.maxConcurrent = 2;
    this.sources = {};  // plugin sources
    this.onProgress = null;
    this.onComplete = null;
  }

  registerSource(id, handler) { this.sources[id] = handler; }

  async searchSongs(query, sourceId) {
    const results = [];
    const sources = sourceId ? { [sourceId]: this.sources[sourceId] } : this.sources;

    for (const [id, handler] of Object.entries(sources)) {
      try {
        if (handler.search) {
          const srcResults = await handler.search(query);
          srcResults.forEach(r => { r.source = id; results.push(r); });
        }
      } catch (e) { console.warn(`Search failed for source ${id}:`, e); }
    }
    return results;
  }

  addDownload(song, sourceId) {
    const task = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      song, sourceId,
      status: 'queued', // queued|downloading|complete|error
      progress: 0,
      startTime: null
    };
    this.queue.push(task);
    this._processQueue();
    return task.id;
  }

  async _processQueue() {
    while (this.active.length < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      this.active.push(task);
      this._downloadTask(task).finally(() => {
        this.active = this.active.filter(t => t !== task);
        this._processQueue();
      });
    }
  }

  async _downloadTask(task) {
    task.status = 'downloading';
    task.startTime = Date.now();
    try {
      const handler = this.sources[task.sourceId];
      if (!handler || !handler.download) throw new Error('No download handler');

      const blob = await handler.download(task.song, (progress) => {
        task.progress = progress;
        if (this.onProgress) this.onProgress(task);
      });

      task.status = 'complete';
      task.blob = blob;
      task.progress = 100;
      if (this.onComplete) this.onComplete(task);
    } catch (e) {
      task.status = 'error';
      task.error = e.message;
      console.error('Download failed:', e);
      if (this.onProgress) this.onProgress(task);
    }
  }

  getQueueStatus() {
    return {
      queued: this.queue.length,
      active: this.active.length,
      all: [...this.active, ...this.queue]
    };
  }
}

// ==================== 插件系统 ====================
class PluginSystem {
  constructor() {
    this.plugins = new Map();
    this.hooks = {
      'player:beforeLoad': [],
      'player:afterLoad': [],
      'player:stateChange': [],
      'lyrics:beforeSearch': [],
      'lyrics:afterSearch': [],
      'ui:render': [],
      'download:beforeStart': [],
      'download:complete': [],
      'app:init': [],
      'app:destroy': []
    };
  }

  registerHook(hookName, fn) {
    if (!this.hooks[hookName]) this.hooks[hookName] = [];
    this.hooks[hookName].push(fn);
    return () => {
      this.hooks[hookName] = this.hooks[hookName].filter(f => f !== fn);
    };
  }

  async runHook(hookName, context) {
    for (const fn of this.hooks[hookName] || []) {
      try { await fn(context); } catch (e) { console.warn(`Hook ${hookName} error:`, e); }
    }
  }

  registerPlugin(manifest, api) {
    if (this.plugins.has(manifest.id)) {
      console.warn(`Plugin ${manifest.id} already registered`);
      return false;
    }
    this.plugins.set(manifest.id, {
      manifest,
      api,
      enabled: true,
      hooks: []
    });
    return true;
  }

  unregisterPlugin(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return false;
    plugin.hooks.forEach(unsub => unsub());
    this.plugins.delete(id);
    return true;
  }

  enablePlugin(id) {
    const p = this.plugins.get(id);
    if (p) p.enabled = true;
  }

  disablePlugin(id) {
    const p = this.plugins.get(id);
    if (p) p.enabled = false;
  }

  getPlugins() {
    return Array.from(this.plugins.entries()).map(([id, p]) => ({
      id, name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      enabled: p.enabled
    }));
  }
}

// ==================== UI 渲染 ====================
class UI {
  constructor() {
    this.elements = {};
    this.currentView = 'player';
    this.visualizerActive = false;
    this._visRaf = null;
  }

  init() {
    this._cacheElements();
    this._bindEvents();
    this._renderVisualizer();
  }

  _cacheElements() {
    const ids = [
      'app', 'playerView', 'playlistView', 'searchView', 'settingsView', 'pluginsView',
      'albumArt', 'trackTitle', 'trackArtist', 'progressBar', 'progressFill',
      'currentTime', 'totalTime', 'playBtn', 'prevBtn', 'nextBtn',
      'shuffleBtn', 'repeatBtn', 'volumeSlider', 'lyricsContainer',
      'playlistItems', 'miniPlayer', 'miniTitle', 'miniArtist',
      'miniPlayBtn', 'navPlayer', 'navPlaylist', 'navSearch', 'navSettings',
      'searchInput', 'searchResults', 'lyricsBtn', 'downloadBtn',
      'pluginList', 'settingsContent', 'visualizer'
    ];
    ids.forEach(id => { this.elements[id] = document.getElementById(id); });
  }

  _bindEvents() {
    // Navigation
    this.elements.navPlayer?.addEventListener('click', () => this.showView('player'));
    this.elements.navPlaylist?.addEventListener('click', () => this.showView('playlist'));
    this.elements.navSearch?.addEventListener('click', () => this.showView('search'));
    this.elements.navSettings?.addEventListener('click', () => this.showView('settings'));

    // Player controls
    this.elements.playBtn?.addEventListener('click', () => App.togglePlay());
    this.elements.prevBtn?.addEventListener('click', () => App.prevTrack());
    this.elements.nextBtn?.addEventListener('click', () => App.nextTrack());
    this.elements.shuffleBtn?.addEventListener('click', () => App.toggleShuffle());
    this.elements.repeatBtn?.addEventListener('click', () => App.toggleRepeat());
    this.elements.volumeSlider?.addEventListener('input', (e) => App.setVolume(e.target.value / 100));
    this.elements.lyricsBtn?.addEventListener('click', () => App.searchLyrics());
    this.elements.downloadBtn?.addEventListener('click', () => App.toggleDownload());

    // Progress bar
    this.elements.progressBar?.addEventListener('click', (e) => {
      const rect = this.elements.progressBar.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      App.seek(pct * App.audio.duration);
    });

    // Search
    this.elements.searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') App.searchSongs(e.target.value);
    });

    // Mini player tap
    this.elements.miniPlayer?.addEventListener('click', () => this.showView('player'));

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      switch (e.code) {
        case 'Space': e.preventDefault(); App.togglePlay(); break;
        case 'ArrowLeft': App.seek(App.audio.getCurrentTime() - 5); break;
        case 'ArrowRight': App.seek(App.audio.getCurrentTime() + 5); break;
        case 'ArrowUp': App.setVolume(App.audio.volume + 0.05); break;
        case 'ArrowDown': App.setVolume(App.audio.volume - 0.05); break;
      }
    });
  }

  showView(view) {
    this.currentView = view;
    ['player', 'playlist', 'search', 'settings', 'plugins'].forEach(v => {
      const el = this.elements[v + 'View'];
      if (el) el.style.display = v === view ? 'flex' : 'none';
    });
    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const navMap = { player: 'navPlayer', playlist: 'navPlaylist', search: 'navSearch', settings: 'navSettings' };
    const navEl = this.elements[navMap[view]];
    if (navEl) navEl.classList.add('active');
  }

  updateTrackInfo(track) {
    if (!track) return;
    if (this.elements.trackTitle) this.elements.trackTitle.textContent = track.title || '未知曲目';
    if (this.elements.trackArtist) this.elements.trackArtist.textContent = track.artist || '';
    if (this.elements.miniTitle) this.elements.miniTitle.textContent = track.title || '未知曲目';
    if (this.elements.miniArtist) this.elements.miniArtist.textContent = track.artist || '';

    // Album art
    this._updateAlbumArt(track);

    // Mini player visibility
    if (this.elements.miniPlayer && track.title) {
      this.elements.miniPlayer.style.display = 'flex';
    }
  }

  _updateAlbumArt(track) {
    const artEl = this.elements.albumArt;
    if (!artEl) return;

    // Reset
    artEl.innerHTML = '';

    if (track.coverUrl) {
      const img = document.createElement('img');
      img.src = track.coverUrl;
      img.onerror = () => this._showDefaultArt(artEl, track);
      artEl.appendChild(img);
    } else if (track.file && track.file.type.startsWith('audio/')) {
      this._extractEmbeddedCover(track.file, artEl, track);
    } else {
      this._showDefaultArt(artEl, track);
    }
  }

  async _extractEmbeddedCover(file, artEl, track) {
    try {
      // Try to read ID3v2 cover or FLAC metadata cover
      const buffer = await file.arrayBuffer();
      const view = new DataView(buffer);
      const u8 = new Uint8Array(buffer);

      // Check for FLAC
      if (u8[0] === 0x66 && u8[1] === 0x4C && u8[2] === 0x61 && u8[3] === 0x43) {
        // FLAC: skip fLaC marker + STREAMINFO block
        let offset = 4;
        while (offset < buffer.byteLength - 4) {
          const isLast = (u8[offset] & 0x80) !== 0;
          const blockType = u8[offset] & 0x7F;
          const blockSize = (u8[offset + 1] << 16) | (u8[offset + 2] << 8) | u8[offset + 3];
          offset += 4;
          if (blockType === 6) {
            // Picture block
            const picType = (u8[offset] << 24) | (u8[offset + 1] << 16) | (u8[offset + 2] << 8) | u8[offset + 3];
            const mimeLen = (u8[offset + 4] << 24) | (u8[offset + 5] << 16) | (u8[offset + 6] << 8) | u8[offset + 7];
            const mime = new TextDecoder().decode(u8.slice(offset + 8, offset + 8 + mimeLen));
            const descLen = (u8[offset + 8 + mimeLen] << 24) | (u8[offset + 8 + mimeLen + 1] << 16) | (u8[offset + 8 + mimeLen + 2] << 8) | u8[offset + 8 + mimeLen + 3];
            const imgOffset = offset + 8 + mimeLen + 4 + descLen + 16;
            const imgData = u8.slice(imgOffset, offset + blockSize);
            const blob = new Blob([imgData], { type: mime });
            const img = document.createElement('img');
            img.src = URL.createObjectURL(blob);
            artEl.appendChild(img);
            return;
          }
          offset += blockSize;
          if (isLast) break;
        }
      }

      // Check for ID3v2
      if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
        const id3Size = ((u8[6] & 0x7F) << 21) | ((u8[7] & 0x7F) << 14) | ((u8[8] & 0x7F) << 7) | (u8[9] & 0x7F);
        let pos = 10;
        const flags = u8[5];
        if (flags & 0x10) pos += 10; // footer present

        while (pos < id3Size + 10 - 10) {
          const frameId = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
          const frameSize = (u8[pos + 4] << 24) | (u8[pos + 5] << 16) | (u8[pos + 6] << 8) | u8[pos + 7];
          if (frameSize <= 0 || frameSize > id3Size) break;

          if (frameId === 'APIC') {
            let p = pos + 10 + 1; // skip header + encoding
            const mimeEnd = u8.indexOf(0x00, p);
            const mime = new TextDecoder().decode(u8.slice(p, mimeEnd));
            p = mimeEnd + 2; // skip null + picture type
            const descEnd = u8.indexOf(0x00, p);
            p = (descEnd >= 0) ? descEnd + 1 : p;
            const imgData = u8.slice(p, pos + 10 + frameSize);
            const blob = new Blob([imgData], { type: mime });
            const img = document.createElement('img');
            img.src = URL.createObjectURL(blob);
            artEl.appendChild(img);
            return;
          }
          pos += 10 + frameSize;
        }
      }
    } catch (e) { /* fall through */ }
    this._showDefaultArt(artEl, track);
  }

  _showDefaultArt(artEl, track) {
    const div = document.createElement('div');
    div.className = 'default-art';
    div.innerHTML = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="50" cy="36" r="14" fill="currentColor"/><ellipse cx="50" cy="72" rx="28" ry="14" fill="currentColor"/></svg>`;
    div.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.2)';
    artEl.appendChild(div);
  }

  updateProgress(current, total) {
    const pct = total > 0 ? (current / total) * 100 : 0;
    if (this.elements.progressFill) this.elements.progressFill.style.width = pct + '%';
    if (this.elements.currentTime) this.elements.currentTime.textContent = this._formatTime(current);
    if (this.elements.totalTime) this.elements.totalTime.textContent = total ? this._formatTime(total) : '--:--';
  }

  updatePlayState(state) {
    const btn = this.elements.playBtn;
    if (!btn) return;
    if (state === 'playing') {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>';
      if (this.elements.miniPlayBtn) {
        this.elements.miniPlayBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>';
      }
    } else {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20" fill="currentColor"/></svg>';
      if (this.elements.miniPlayBtn) {
        this.elements.miniPlayBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20" fill="currentColor"/></svg>';
      }
    }
  }

  updateLyrics(index, lyrics) {
    const container = this.elements.lyricsContainer;
    if (!container || !lyrics || lyrics.length === 0) return;

    if (container.children.length === 0 || container.children.length !== lyrics.length) {
      container.innerHTML = lyrics.map((l, i) =>
        `<p class="lyric-line" data-index="${i}">${l.text || '...'}</p>`
      ).join('');
    }

    const lines = container.querySelectorAll('.lyric-line');
    lines.forEach((el, i) => {
      el.classList.toggle('active', i === index);
      el.classList.toggle('past', i < index);
    });

    if (index >= 0) {
      const activeLine = container.querySelector('.lyric-line.active');
      if (activeLine) {
        activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  updatePlaylist(playlist, currentIndex) {
    const container = this.elements.playlistItems;
    if (!container) return;

    container.innerHTML = playlist.map((track, i) => `
      <div class="playlist-item ${i === currentIndex ? 'active' : ''}" data-index="${i}">
        <div class="playlist-item-art">
          ${track.coverUrl ? `<img src="${track.coverUrl}">` : '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" fill="currentColor"/></svg>'}
        </div>
        <div class="playlist-item-info">
          <div class="playlist-item-title">${track.title || '未知曲目'}</div>
          <div class="playlist-item-artist">${track.artist || '未知歌手'}</div>
        </div>
        <div class="playlist-item-duration">${this._formatTime(track.duration || 0)}</div>
      </div>
    `).join('');

    container.querySelectorAll('.playlist-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        App.playTrackAt(idx);
      });
    });
  }

  updateRepeatMode(mode) {
    const btn = this.elements.repeatBtn;
    if (!btn) return;
    const labels = { none: '🔁', one: '🔂', all: '🔁' };
    btn.textContent = labels[mode] || '🔁';
    btn.style.opacity = mode === 'none' ? '0.5' : '1';
  }

  updateShuffleMode(enabled) {
    const btn = this.elements.shuffleBtn;
    if (btn) btn.style.opacity = enabled ? '1' : '0.5';
  }

  updateVolumeDisplay(vol) {
    if (this.elements.volumeSlider) this.elements.volumeSlider.value = vol * 100;
  }

  showSearchResults(results) {
    const container = this.elements.searchResults;
    if (!container) return;
    if (results.length === 0) {
      container.innerHTML = '<p class="empty-msg">未找到结果</p>';
      return;
    }
    container.innerHTML = results.map((song, i) => `
      <div class="search-result-item" data-index="${i}">
        <div class="sr-info">
          <div class="sr-title">${song.title || '未知'}</div>
          <div class="sr-artist">${song.artist || ''}</div>
          <div class="sr-source">来源: ${song.source || '未知'}</div>
        </div>
        <button class="sr-download btn-icon" data-action="download" data-index="${i}">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/></svg>
        </button>
      </div>
    `).join('');

    container.querySelectorAll('[data-action="download"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        App.downloadSong(results[idx]);
      });
    });

    container.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        App.addToPlaylist(results[idx]);
      });
    });
  }

  showPlugins(plugins) {
    const container = this.elements.pluginList;
    if (!container) return;
    container.innerHTML = plugins.map(p => `
      <div class="plugin-card">
        <div class="plugin-header">
          <strong>${p.name}</strong>
          <span class="version">v${p.version}</span>
        </div>
        <p class="plugin-desc">${p.description || ''}</p>
        <label class="toggle">
          <input type="checkbox" ${p.enabled ? 'checked' : ''} data-plugin="${p.id}">
          <span class="toggle-slider"></span>
          ${p.enabled ? '已启用' : '已禁用'}
        </label>
      </div>
    `).join('');

    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) App.enablePlugin(cb.dataset.plugin);
        else App.disablePlugin(cb.dataset.plugin);
      });
    });
  }

  _renderVisualizer() {
    const canvas = this.elements.visualizer;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      this._visRaf = requestAnimationFrame(draw);
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      if (!App.audio || !App.audio.isPlaying) return;

      const freqData = App.audio.getFrequencyData();
      const barCount = 32;
      const barWidth = w / barCount - 1;
      const step = Math.floor(freqData.length / barCount);

      for (let i = 0; i < barCount; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += freqData[i * step + j] || 0;
        const avg = sum / step;
        const barHeight = (avg / 255) * h * 0.8;
        const x = i * (barWidth + 1);
        const gradient = ctx.createLinearGradient(0, h, 0, h - barHeight);
        gradient.addColorStop(0, '#7c3aed');
        gradient.addColorStop(1, '#d946ef');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(x, h - barHeight, barWidth, barHeight, [2, 2, 0, 0]);
        ctx.fill();
      }
    };
    this._visRaf = requestAnimationFrame(draw);
  }

  _formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  async showToast(msg, duration = 2000) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:rgba(124,58,237,0.9);color:#fff;padding:10px 20px;border-radius:20px;font-size:14px;z-index:9999;transition:opacity 0.3s;pointer-events:none';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => { toast.style.opacity = '0'; }, duration);
  }
}

// ==================== 应用主控制器 ====================
class AppController {
  constructor() {
    this.audio = new AudioEngine();
    this.storage = new StorageManager();
    this.lyrics = new LyricsEngine();
    this.downloader = new DownloadManager();
    this.plugins = new PluginSystem();
    this.ui = new UI();

    this.playlist = [];
    this.currentIndex = -1;
    this.repeatMode = 'none'; // none|one|all
    this.shuffleMode = false;
    this.shuffleOrder = [];
    this.shuffleIdx = 0;

    // Expose for UI callbacks
    window.App = this;
  }

  async init() {
    this.audio.init();
    this.ui.init();
    await this.storage.init();

    // Wire up audio events
    this.audio.onTimeUpdate = (current, total, progress) => {
      this.ui.updateProgress(current, total);
      if (this.lyrics.lyrics.length > 0) {
        const idx = this.lyrics.getCurrentLine(current * 1000);
        this.ui.updateLyrics(idx, this.lyrics.lyrics);
      }
    };

    this.audio.onStateChange = (state) => {
      this.ui.updatePlayState(state);
      this.plugins.runHook('player:stateChange', { state });
    };

    this.audio.onTrackEnd = () => this._onTrackEnd();

    // Wire up lyrics events
    this.lyrics.onLyricsUpdate = (idx, lyrics) => {
      this.ui.updateLyrics(idx, lyrics);
    };

    // Wire up download events
    this.downloader.onProgress = (task) => {
      if (task.status === 'complete') {
        this.ui.showToast(`下载完成: ${task.song.title}`);
        this.addToPlaylist({
          id: task.id,
          title: task.song.title,
          artist: task.song.artist,
          data: task.blob,
          duration: task.song.duration
        });
      } else if (task.status === 'error') {
        this.ui.showToast(`下载失败: ${task.error}`);
      }
    };

    // Load saved state
    const savedVol = await this.storage.getSetting('volume');
    if (savedVol !== null) { this.audio.setVolume(savedVol); this.ui.updateVolumeDisplay(savedVol); }

    const savedPlaylist = await this.storage.getAll('library');
    if (savedPlaylist && savedPlaylist.length > 0) {
      this.playlist = savedPlaylist;
      this.ui.updatePlaylist(this.playlist, this.currentIndex);
    }

    // Setup file drop
    this._setupFileHandling();

    // Setup default download source (JSON-based search API)
    this._setupDefaultSources();

    // Load plugins
    await this._loadPlugins();

    // Show player view
    this.ui.showView('player');

    // Run init hook
    await this.plugins.runHook('app:init', {});

    console.log('MelodyBox initialized');
  }

  async togglePlay() {
    if (!this.audio.currentTrack) return;
    if (this.audio.isPlaying) this.audio.pause();
    else this.audio.resume();
  }

  async playTrackAt(index) {
    if (index < 0 || index >= this.playlist.length) return;
    this.currentIndex = index;
    const track = this.playlist[index];
    await this.plugins.runHook('player:beforeLoad', { track });
    this.ui.updateTrackInfo(track);
    this.ui.updatePlaylist(this.playlist, this.currentIndex);
    try {
      await this.audio.loadTrack(track);
      await this.plugins.runHook('player:afterLoad', { track });
      // Auto-search lyrics
      if (track.title) this.searchLyrics();
    } catch (e) {
      this.ui.showToast('播放失败: ' + e.message);
    }
  }

  nextTrack() { this._advanceTrack(1); }
  prevTrack() { this._advanceTrack(-1); }

  _advanceTrack(direction) {
    if (this.playlist.length === 0) return;
    let next;
    if (this.shuffleMode) {
      this.shuffleIdx += direction;
      if (this.shuffleIdx < 0) this.shuffleIdx = this.shuffleOrder.length - 1;
      if (this.shuffleIdx >= this.shuffleOrder.length) this.shuffleIdx = 0;
      next = this.shuffleOrder[this.shuffleIdx];
    } else if (this.repeatMode === 'one') {
      next = this.currentIndex;
    } else {
      next = this.currentIndex + direction;
      if (next < 0) next = this.repeatMode === 'all' ? this.playlist.length - 1 : -1;
      if (next >= this.playlist.length) next = this.repeatMode === 'all' ? 0 : -1;
    }
    if (next >= 0 && next < this.playlist.length) this.playTrackAt(next);
  }

  _onTrackEnd() {
    if (this.repeatMode === 'one') {
      this.audio.play();
    } else {
      this._advanceTrack(1);
    }
  }

  toggleRepeat() {
    const modes = ['none', 'all', 'one'];
    const idx = modes.indexOf(this.repeatMode);
    this.repeatMode = modes[(idx + 1) % modes.length];
    this.ui.updateRepeatMode(this.repeatMode);
  }

  toggleShuffle() {
    this.shuffleMode = !this.shuffleMode;
    if (this.shuffleMode) {
      this.shuffleOrder = Array.from({ length: this.playlist.length }, (_, i) => i);
      for (let i = this.shuffleOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.shuffleOrder[i], this.shuffleOrder[j]] = [this.shuffleOrder[j], this.shuffleOrder[i]];
      }
      this.shuffleIdx = this.shuffleOrder.indexOf(this.currentIndex);
      if (this.shuffleIdx < 0) this.shuffleIdx = 0;
    }
    this.ui.updateShuffleMode(this.shuffleMode);
  }

  seek(time) { this.audio.seek(time); }

  setVolume(vol) {
    this.audio.setVolume(vol);
    this.ui.updateVolumeDisplay(vol);
    this.storage.saveSetting('volume', vol);
  }

  async searchLyrics() {
    const track = this.audio.currentTrack;
    if (!track) return;
    this.ui.showToast('搜索歌词中...');
    const result = await this.lyrics.searchLyrics(track.title, track.artist, this.audio.duration);
    if (result.length === 0) {
      this.ui.showToast('未找到歌词');
      if (this.ui.elements.lyricsContainer) this.ui.elements.lyricsContainer.innerHTML = '<p class="empty-msg">未找到歌词</p>';
    } else {
      this.ui.showToast(`加载了 ${this.lyrics.lyrics.length} 行歌词`);
      this.ui.updateLyrics(-1, this.lyrics.lyrics);
      // Save to storage
      if (track.id) {
        this.storage.put('lyrics', { id: track.id, lyrics: this.lyrics.lyrics });
      }
    }
  }

  async searchSongs(query) {
    if (!query || query.length < 2) return;
    this.ui.showToast('搜索中...');
    const results = await this.downloader.searchSongs(query);
    this.ui.showSearchResults(results);
    this.ui.showView('search');
  }

  downloadSong(song) {
    if (!song.source) {
      this.ui.showToast('无法下载：缺少下载源');
      return;
    }
    this.downloader.addDownload(song, song.source);
    this.ui.showToast('已添加到下载队列');
  }

  addToPlaylist(track) {
    const t = { ...track, id: track.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
    // Check duplicate
    if (this.playlist.some(p => p.id === t.id)) return;
    this.playlist.push(t);
    this.ui.updatePlaylist(this.playlist, this.currentIndex);
    this.storage.put('library', t);
  }

  async playFile(file) {
    const track = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: file.name.replace(/\.[^/.]+$/, ''),
      artist: '',
      file: file,
      duration: 0
    };
    this.addToPlaylist(track);
    await this.playTrackAt(this.playlist.length - 1);
  }

  _setupFileHandling() {
    // File input for "open file"
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.flac,.wav,.ape,.ogg,.opus,.m4a,.aac,.wma';
    input.multiple = true;
    input.style.display = 'none';
    input.id = 'fileInput';
    document.body.appendChild(input);

    input.addEventListener('change', async () => {
      for (const file of input.files) {
        await this.playFile(file);
      }
    });

    // Also handle drag & drop
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      for (const file of e.dataTransfer.files) {
        if (file.type.startsWith('audio/') || /\.(flac|wav|ape|ogg|opus|m4a|aac|mp3)$/i.test(file.name)) {
          await this.playFile(file);
        }
      }
    });

    // Add file button to player
    const fileBtn = document.createElement('button');
    fileBtn.id = 'fileBtn';
    fileBtn.className = 'btn-icon';
    fileBtn.title = '打开文件';
    fileBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 2l5 5h-5V4zM8 15h8v2H8v-2zm0-4h8v2H8v-2z" fill="currentColor"/></svg>';
    fileBtn.addEventListener('click', () => input.click());
    const controls = document.getElementById('playerControls');
    if (controls) controls.prepend(fileBtn);
  }

  _setupDefaultSources() {
    // Register a JSON API source as default
    this.downloader.registerSource('json-api', {
      search: async (query) => {
        // This can be configured to point to any JSON API
        const apiUrl = await this.storage.getSetting('searchApiUrl');
        if (!apiUrl) return [];

        try {
          const res = await fetch(`${apiUrl}?q=${encodeURIComponent(query)}`,
            { signal: AbortSignal.timeout(5000) });
          if (!res.ok) return [];
          const data = await res.json();
          return (data.songs || data.results || data || []).map(s => ({
            id: s.id || s.song_id,
            title: s.title || s.name,
            artist: s.artist || s.singer,
            duration: s.duration || s.length,
            coverUrl: s.cover || s.cover_url || s.pic,
            downloadUrl: s.url || s.download_url || s.src,
            source: 'json-api'
          }));
        } catch (e) { return []; }
      },
      download: async (song, onProgress) => {
        if (!song.downloadUrl) throw new Error('No download URL');
        const res = await fetch(song.downloadUrl);
        if (!res.ok) throw new Error('Download failed: ' + res.status);
        const total = parseInt(res.headers.get('content-length') || '0');
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total) onProgress(Math.round((received / total) * 100));
        }
        const blob = new Blob(chunks, { type: 'audio/mpeg' });
        return blob;
      }
    });

    // Register Jamendo free music API
    this.downloader.registerSource('jamendo', {
      search: async (query) => {
        try {
          const res = await fetch(
            `https://api.jamendo.com/v3.0/tracks/?client_id=5f8e8f8b&format=json&limit=20&search=${encodeURIComponent(query)}`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (!res.ok) return [];
          const data = await res.json();
          return (data.results || []).map(t => ({
            id: t.id,
            title: t.name,
            artist: t.artist_name,
            duration: t.duration,
            coverUrl: t.image || t.album_image,
            downloadUrl: t.audio,
            source: 'jamendo',
            album: t.album_name
          }));
        } catch (e) { return []; }
      },
      download: async (song, onProgress) => {
        if (!song.downloadUrl) throw new Error('No download URL');
        const res = await fetch(song.downloadUrl);
        if (!res.ok) throw new Error('Download failed');
        const total = parseInt(res.headers.get('content-length') || '0');
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total) onProgress(Math.round((received / total) * 100));
        }
        return new Blob(chunks, { type: 'audio/mpeg' });
      }
    });
  }

  async _loadPlugins() {
    // Load plugins from storage
    const pluginData = await this.storage.getAll('plugins_meta') || [];
    pluginData.forEach(p => this.plugins.registerPlugin(p.manifest, p.api));
    this.ui.showPlugins(this.plugins.getPlugins());
  }

  enablePlugin(id) { this.plugins.enablePlugin(id); }
  disablePlugin(id) { this.plugins.disablePlugin(id); }

  // Plugin installation
  async installPlugin(manifest, setupFn) {
    const api = {
      registerHook: (hook, fn) => this.plugins.registerHook(hook, fn),
      emit: (event, data) => EventBus.emit(event, data),
      getAudio: () => this.audio,
      getPlaylist: () => this.playlist,
      getStorage: () => this.storage,
      showToast: (msg) => this.ui.showToast(msg)
    };

    if (setupFn) {
      try {
        await setupFn(api, manifest);
      } catch (e) {
        console.error('Plugin setup failed:', e);
        this.ui.showToast(`插件 ${manifest.name} 初始化失败`);
        return false;
      }
    }

    const success = this.plugins.registerPlugin(manifest, api);
    if (success) {
      await this.storage.put('plugins_meta', { id: manifest.id, manifest, api });
      this.ui.showPlugins(this.plugins.getPlugins());
      this.ui.showToast(`插件 ${manifest.name} 已安装`);
    }
    return success;
  }
}

// ==================== 启动 ====================
document.addEventListener('DOMContentLoaded', async () => {
  const app = new AppController();
  await app.init();
});
