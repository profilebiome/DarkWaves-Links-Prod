/* Motor de reproducción compartido por los 5 modelos de DarkWaves. */

export const icons = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor"/></svg>',
  prev:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5.2v13.6L8 12z" fill="currentColor"/><rect x="4.4" y="5" width="2.6" height="14" rx="1" fill="currentColor"/></svg>',
  next:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5.2v13.6L16 12z" fill="currentColor"/><rect x="17" y="5" width="2.6" height="14" rx="1" fill="currentColor"/></svg>',
  shuffle:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h3.5c1.2 0 2.3.6 3 1.6l5 6.8c.7 1 1.8 1.6 3 1.6H21"/><path d="M18 4l3 3-3 3"/><path d="M3 17h3.5c1.2 0 2.3-.6 3-1.6l.9-1.2"/><path d="M13.2 9.4l.8-1.2c.7-1 1.8-1.6 3-1.6H21"/><path d="M18 14l3 3-3 3"/></svg>',
  repeat:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3l3 3-3 3"/><path d="M20 6H8a4 4 0 0 0-4 4v1"/><path d="M7 21l-3-3 3-3"/><path d="M4 18h12a4 4 0 0 0 4-4v-1"/></svg>',
  volume:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3L11.5 6v12L7 14.5H4z" fill="currentColor" stroke="none"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  music:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V6.4l10-2v11.2"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15.6" r="2.5"/></svg>',
};

export function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const svg = icons[el.dataset.icon];
    if (svg) el.innerHTML = svg;
  });
}

export function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

export function initialsOf(track) {
  if (!track) return "DW";
  const source = track.title || track.artist || "DW";
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

export function artFor(seed = "darkwaves") {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i) * (i + 3)) >>> 0;
  }
  const hueA = 202 + (hash % 34);
  const hueB = 246 + ((hash >> 5) % 42);
  const angle = 115 + (hash % 90);
  return {
    css: `linear-gradient(${angle}deg, hsl(${hueA} 92% 58%) 0%, hsl(${hueB} 88% 36%) 48%, hsl(220 92% 7%) 100%)`,
    glow: `hsl(${hueA} 95% 60% / 0.45)`,
  };
}

export class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = "metadata";
    this.audio.crossOrigin = "same-origin";
    this.audio.volume = this._readVolume();
    this.tracks = [];
    this.index = -1;
    this.shuffle = false;
    this.repeat = "off";
    this._ctx = null;
    this._analyser = null;
    this._freq = null;
    this._smoothed = null;

    const emit = (name, detail) => this.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));

    this.audio.addEventListener("timeupdate", () =>
      emit("time", { current: this.audio.currentTime, duration: this.duration() })
    );
    this.audio.addEventListener("loadedmetadata", () =>
      emit("meta", { duration: this.duration(), track: this.current })
    );
    this.audio.addEventListener("play", () => emit("state", { playing: true }));
    this.audio.addEventListener("pause", () => emit("state", { playing: false }));
    this.audio.addEventListener("ended", () => this._onEnded());
    this.audio.addEventListener("waiting", () => emit("buffering", { buffering: true }));
    this.audio.addEventListener("playing", () => emit("buffering", { buffering: false }));
    this.audio.addEventListener("error", () => {
      if (this.current) emit("error", { track: this.current });
    });
  }

  get current() {
    return this.tracks[this.index] || null;
  }

  get playing() {
    return !this.audio.paused;
  }

  duration() {
    const value = this.audio.duration;
    return Number.isFinite(value) ? value : 0;
  }

  _readVolume() {
    const stored = Number(localStorage.getItem("dw:volume"));
    return Number.isFinite(stored) && stored > 0 ? Math.min(stored, 1) : 0.85;
  }

  async load() {
    const response = await fetch("/api/tracks", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo leer la carpeta de música.");
    const data = await response.json();
    this.tracks = Array.isArray(data.tracks) ? data.tracks : [];
    if (this.tracks.length && this.index < 0) this.index = 0;
    if (this.index >= this.tracks.length) this.index = this.tracks.length ? 0 : -1;
    this.dispatchEvent(new CustomEvent("tracks", { detail: { tracks: this.tracks } }));
    return this.tracks;
  }

  ensureAnalyser() {
    if (this._analyser) {
      if (this._ctx.state === "suspended") this._ctx.resume();
      return this._analyser;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    this._ctx = new AudioCtx();
    const source = this._ctx.createMediaElementSource(this.audio);
    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._analyser.smoothingTimeConstant = 0.82;
    source.connect(this._analyser);
    this._analyser.connect(this._ctx.destination);
    this._freq = new Uint8Array(this._analyser.frequencyBinCount);
    this._smoothed = new Float32Array(this._analyser.frequencyBinCount);
    return this._analyser;
  }

  /** Devuelve 32 valores 0..1 suavizados (silencio si no hay audio). */
  levels(count = 32) {
    const out = new Array(count).fill(0);
    if (!this._analyser || this.audio.paused) {
      if (this._smoothed) {
        for (let i = 0; i < this._smoothed.length; i += 1) this._smoothed[i] *= 0.9;
      }
      return out;
    }
    this._analyser.getByteFrequencyData(this._freq);
    const usable = Math.floor(this._freq.length * 0.7);
    for (let i = 0; i < count; i += 1) {
      const from = Math.floor((i / count) * usable);
      const to = Math.max(from + 1, Math.floor(((i + 1) / count) * usable));
      let sum = 0;
      for (let j = from; j < to; j += 1) sum += this._freq[j];
      const raw = sum / (to - from) / 255;
      this._smoothed[i] = this._smoothed[i] * 0.72 + raw * 0.28;
      out[i] = Math.min(1, this._smoothed[i] * (1 + i / count));
    }
    return out;
  }

  async playIndex(index, autoplay = true) {
    if (!this.tracks[index]) return;
    this.index = index;
    const track = this.current;
    this.audio.src = track.url;
    this.audio.load();
    this.dispatchEvent(new CustomEvent("trackchange", { detail: { track, index } }));
    this.dispatchEvent(new CustomEvent("time", { detail: { current: 0, duration: 0 } }));
    if (autoplay) await this.play();
  }

  async play() {
    if (!this.current) return;
    this.ensureAnalyser();
    try {
      await this.audio.play();
    } catch {
      this.dispatchEvent(new CustomEvent("blocked", {}));
    }
  }

  pause() {
    this.audio.pause();
  }

  toggle() {
    if (this.audio.paused) this.play();
    else this.pause();
  }

  seek(seconds) {
    if (!Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration - 0.15));
    this.dispatchEvent(
      new CustomEvent("time", { detail: { current: this.audio.currentTime, duration: this.duration() } })
    );
  }

  setVolume(value) {
    const volume = Math.max(0, Math.min(1, value));
    this.audio.volume = volume;
    localStorage.setItem("dw:volume", String(volume));
    this.dispatchEvent(new CustomEvent("volume", { volume }));
  }

  _pickShuffle() {
    if (this.tracks.length < 2) return this.index;
    let next = this.index;
    while (next === this.index) next = Math.floor(Math.random() * this.tracks.length);
    return next;
  }

  next(auto = false) {
    if (!this.tracks.length) return;
    if (this.shuffle) return this.playIndex(this._pickShuffle());
    if (this.index < this.tracks.length - 1) return this.playIndex(this.index + 1);
    if (this.repeat === "all" || !auto) return this.playIndex(0);
    this.audio.pause();
    this.audio.currentTime = 0;
  }

  prev() {
    if (!this.tracks.length) return;
    if (this.audio.currentTime > 3) {
      this.seek(0);
      return;
    }
    if (this.shuffle) return this.playIndex(this._pickShuffle());
    if (this.index > 0) return this.playIndex(this.index - 1);
    return this.playIndex(this.tracks.length - 1);
  }

  _onEnded() {
    if (this.repeat === "one") {
      this.seek(0);
      this.play();
      return;
    }
    this.next(true);
  }
}

export function hotkeys(player) {
  const handler = (event) => {
    const tag = (event.target && event.target.tagName) || "";
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (event.code === "Space") {
      event.preventDefault();
      player.toggle();
    } else if (event.key === "ArrowRight") {
      player.seek(player.audio.currentTime + 5);
    } else if (event.key === "ArrowLeft") {
      player.seek(player.audio.currentTime - 5);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      player.setVolume(player.audio.volume + 0.05);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      player.setVolume(player.audio.volume - 0.05);
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}

/** Visualizador simple: modo "bars" o "ring". Devuelve un handle con stop(). */
export function spectrum(canvas, player, options = {}) {
  const ctx = canvas.getContext("2d");
  const {
    mode = "bars",
    colorA = "#3b82f6",
    colorB = "#7dd3fc",
    gap = 3,
    radius = 2,
    minScale = 0.06,
  } = options;

  const state = { width: 0, height: 0, dpr: 1 };
  let frame = 0;
  let levels = new Array(mode === "ring" ? 64 : 48).fill(0);

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.width = Math.max(1, Math.round(rect.width * state.dpr));
    state.height = Math.max(1, Math.round(rect.height * state.dpr));
    canvas.width = state.width;
    canvas.height = state.height;
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const draw = () => {
    frame = requestAnimationFrame(draw);
    const { width, height, dpr } = state;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const nextLevels = player.levels(levels.length);
    levels = levels.map((value, i) => value * 0.6 + nextLevels[i] * 0.4);

    if (mode === "ring") {
      const cx = width / 2;
      const cy = height / 2;
      const base = Math.min(width, height) * 0.345;
      const maxLength = Math.min(width, height) * 0.11;
      ctx.save();
      ctx.translate(cx, cy);
      const count = levels.length;
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
        const value = levels[i];
        const length = maxLength * (minScale + value * 0.94);
        const start = base;
        const end = base + length;
        ctx.beginPath();
        ctx.lineCap = "round";
        ctx.lineWidth = Math.max(2 * dpr, (Math.PI * base) / count - 2.4 * dpr);
        const gradient = ctx.createLinearGradient(
          Math.cos(angle) * start,
          Math.sin(angle) * start,
          Math.cos(angle) * end,
          Math.sin(angle) * end
        );
        gradient.addColorStop(0, colorA);
        gradient.addColorStop(1, colorB);
        ctx.strokeStyle = gradient;
        ctx.globalAlpha = 0.25 + value * 0.75;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * start, Math.sin(angle) * start);
        ctx.lineTo(Math.cos(angle) * end, Math.sin(angle) * end);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    const count = levels.length;
    const barWidth = (width - gap * dpr * (count - 1)) / count;
    for (let i = 0; i < count; i += 1) {
      const value = levels[i];
      const barHeight = Math.max(height * 0.035, height * (minScale + value * 0.9));
      const x = i * (barWidth + gap * dpr);
      const y = height - barHeight;
      const gradient = ctx.createLinearGradient(0, height, 0, y);
      gradient.addColorStop(0, colorA);
      gradient.addColorStop(1, colorB);
      ctx.fillStyle = gradient;
      ctx.globalAlpha = 0.4 + value * 0.6;
      ctx.beginPath();
      const r = Math.min(radius * dpr, barWidth / 2);
      ctx.roundRect(x, y, barWidth, barHeight, r);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  draw();

  return {
    stop() {
      cancelAnimationFrame(frame);
      observer.disconnect();
    },
  };
}
