import * as THREE from "three";

// Azure Speech viseme IDs (0-21) → mouth pose [jaw open, lip wide, lip round].
const VISEME_POSE = [
  [0, 0, 0], [0.5, 0.2, 0], [0.72, 0.1, 0], [0.55, 0, 0.45], [0.42, 0.3, 0.1], [0.32, 0, 0.4],
  [0.22, 0.55, 0], [0.18, 0, 0.8], [0.45, 0, 0.65], [0.62, 0.1, 0.3], [0.5, 0, 0.45], [0.62, 0.25, 0],
  [0.36, 0.1, 0], [0.28, 0, 0.42], [0.32, 0.15, 0], [0.14, 0.45, 0], [0.22, 0.1, 0.5], [0.24, 0.2, 0],
  [0.1, 0.2, 0], [0.24, 0.2, 0], [0.32, 0.15, 0], [0, 0, 0],
];
const VIEW = { cx: 0.487, cy: 0.45, size: 0.86 };
const BILABIAL = 21;
const NOSE = 4;
const BROWS = [70, 63, 105, 66, 107, 46, 53, 52, 65, 55, 300, 293, 334, 296, 336, 276, 283, 282, 295, 285];
const LIDS = [159, 386];
const IRIS = [468, 469, 470, 471, 472, 473, 474, 475, 476, 477];
const PHRASE_END = /[.,!?;:،؛؟…]$/;

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const bump = (u) => (u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u) ** 2);
const rand = (a, b) => a + Math.random() * (b - a);

/** Critically damped spring toward a moving target. */
function spring(state, target, omega, dt) {
  const x = state.x - target;
  const exp = Math.exp(-omega * dt);
  const v = state.v + omega * x;
  state.x = target + (x + v * dt) * exp;
  state.v = (state.v - omega * v * dt) * exp;
}

const FACE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FACE_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform vec2 texel;
  uniform float time;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(map, vUv);
    float edge = 0.0;
    for (int i = 0; i < 4; i++) {
      float a = float(i) * 1.5708 + 0.785;
      edge += texture2D(map, vUv + vec2(cos(a), sin(a)) * texel * 6.0).a;
    }
    edge = clamp(c.a - edge * 0.25, 0.0, 1.0);
    vec3 col = mix(c.rgb, c.rgb * vec3(0.9, 1.0, 1.06), 0.5);
    col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), 0.12);
    col += vec3(0.37, 0.83, 0.92) * edge * 0.9;
    float band = smoothstep(0.0, 0.02, abs(fract(vUv.y * 1.2 - time * 0.06) - 0.5) - 0.47);
    col += vec3(0.37, 0.83, 0.92) * (1.0 - band) * 0.035 * c.a;
    float fade = 1.0 - smoothstep(0.62, 0.98, 1.0 - vUv.y);
    gl_FragColor = vec4(col, c.a * fade);
  }`;

const MOUTH_VERT = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const MOUTH_FRAG = /* glsl */ `
  uniform vec4 lips; // center x, upper lip y, lower lip y, half width
  varying vec2 vPos;
  void main() {
    float nx = (vPos.x - lips.x) / max(lips.w, 1e-4);
    float fromTop = lips.y - vPos.y;
    float gap = max(lips.y - lips.z, 1e-4);
    vec3 col = mix(vec3(0.16, 0.05, 0.06), vec3(0.04, 0.01, 0.02), 1.0 - abs(nx));
    float tongue = smoothstep(0.55, 1.0, (vPos.y - lips.z) / gap * -1.0 + 1.0) * (1.0 - smoothstep(0.2, 0.75, abs(nx)));
    col = mix(col, vec3(0.42, 0.16, 0.17), tongue * 0.55);
    float teethH = min(0.011, gap * 0.45);
    float teeth = (1.0 - smoothstep(teethH * 0.45, teethH, fromTop)) * (1.0 - smoothstep(0.35, 0.7, abs(nx)));
    vec3 enamel = vec3(0.74, 0.72, 0.68) * (1.0 - 0.45 * abs(nx)) * (0.8 + 0.2 * fromTop / max(teethH, 1e-4));
    col = mix(col, enamel, teeth * 0.9);
    col *= smoothstep(0.0, 0.0018, fromTop) * 0.5 + 0.5;
    gl_FragColor = vec4(col, 1.0);
  }`;

/** Photo-realistic talking portrait: a landmark mesh warped by Azure Speech visemes. */
export class PortraitAvatar {
  constructor(node, { url }) {
    this.node = node;
    this.base = url.replace(/\.json$/, "");
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.source = null;
    this.speakingUntil = 0;
    this.endTimer = null;
    this.onEnd = null;
    this.track = null;
    this.pose = { jaw: 0, wide: 0, round: 0 };
    this.mouth = { jaw: { x: 0, v: 0 }, wide: { x: 0, v: 0 }, round: { x: 0, v: 0 } };
    this.blink = { next: performance.now() + 2000, start: 0, double: false };
    this.motion = {
      energy: 0, loud: 0, peak: 0.05,
      yaw: { x: 0, v: 0 }, pitch: { x: 0, v: 0 }, roll: { x: 0, v: 0 }, brow: { x: 0, v: 0 },
      target: { yaw: 0, pitch: 0, roll: 0, next: 0 },
      gaze: { x: 0, y: 0, tx: 0, ty: 0, next: 0 },
      gestures: [],
    };
  }

  async load() {
    const [data, texture] = await Promise.all([
      fetch(`${this.base}.json`).then((r) => {
        if (!r.ok) throw new Error("portrait data unavailable");
        return r.json();
      }),
      new THREE.TextureLoader().loadAsync(`${this.base}.webp`),
    ]);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.data = data;
    this.count = data.vertices.length / 2;
    this.rest = Float32Array.from(data.vertices);
    this.bases = Object.fromEntries(Object.entries(data.bases).map(([k, v]) => [k, Float32Array.from(v)]));
    this.head = Float32Array.from(data.head);
    this.work = new Float32Array(this.count * 2);
    this.#buildMotionWeights(data);

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.node.appendChild(this.renderer.domElement);
    const half = VIEW.size / 2;
    this.camera = new THREE.OrthographicCamera(
      VIEW.cx - 0.5 - half, VIEW.cx - 0.5 + half, 0.5 - VIEW.cy + half, 0.5 - VIEW.cy - half, -1, 1,
    );
    this.scene = new THREE.Scene();

    const uv = new Float32Array(this.count * 2);
    for (let i = 0; i < this.count; i++) {
      uv[i * 2] = data.uv[i * 2];
      uv[i * 2 + 1] = 1 - data.uv[i * 2 + 1];
    }
    const faceGeo = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(this.count * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    faceGeo.setAttribute("position", this.positions);
    faceGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    faceGeo.setIndex(data.triangles);
    this.uniforms = {
      map: { value: texture },
      texel: { value: new THREE.Vector2(1 / data.size, 1 / data.size) },
      time: { value: 0 },
    };
    const face = new THREE.Mesh(faceGeo, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: FACE_VERT, fragmentShader: FACE_FRAG,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }));
    face.renderOrder = 2;
    face.frustumCulled = false;

    this.ring = [...data.mouth.upper, ...data.mouth.lower];
    const mouthGeo = new THREE.BufferGeometry();
    this.mouthPositions = new THREE.BufferAttribute(new Float32Array((this.ring.length + 1) * 3), 3);
    this.mouthPositions.setUsage(THREE.DynamicDrawUsage);
    mouthGeo.setAttribute("position", this.mouthPositions);
    const fan = [];
    for (let i = 0; i < this.ring.length; i++) fan.push(this.ring.length, i, (i + 1) % this.ring.length);
    mouthGeo.setIndex(fan);
    this.lips = { value: new THREE.Vector4() };
    const mouth = new THREE.Mesh(mouthGeo, new THREE.ShaderMaterial({
      uniforms: { lips: this.lips }, vertexShader: MOUTH_VERT, fragmentShader: MOUTH_FRAG,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }));
    mouth.renderOrder = 1;
    mouth.frustumCulled = false;
    this.scene.add(mouth, face);

    this.resize();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.node);
    this.last = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Per-vertex weights for pseudo-3D head turns, eyebrow raises and gaze, derived from the landmarks. */
  #buildMotionWeights(data) {
    const v = this.rest, fw = data.face_width, n = this.count;
    const nx = v[NOSE * 2], ny = v[NOSE * 2 + 1];
    this.depth = new Float32Array(n);
    this.brow = new Float32Array(n);
    const browY = BROWS.reduce((a, i) => a + v[i * 2 + 1], 0) / BROWS.length;
    const lidY = LIDS.reduce((a, i) => a + v[i * 2 + 1], 0) / LIDS.length;
    const browX = [v[105 * 2], v[334 * 2]];
    for (let i = 0; i < n; i++) {
      const x = v[i * 2], y = v[i * 2 + 1];
      const d = Math.hypot((x - nx) / (0.62 * fw), (y - ny) / (0.8 * fw));
      this.depth[i] = (1 - smoothstep(0, 1, d)) * this.head[i];
      const dx = Math.min(Math.abs(x - browX[0]), Math.abs(x - browX[1]));
      const across = 1 - smoothstep(0.1 * fw, 0.24 * fw, dx);
      const below = y > browY ? 1 - smoothstep(0, 1, (y - browY) / Math.max(lidY - browY, 1e-4)) : 1;
      const above = y < browY ? 1 - smoothstep(0.02 * fw, 0.16 * fw, browY - y) : 1;
      this.brow[i] = across * below * above * this.head[i];
    }
    this.browLift = 0.04 * fw;
    this.turn = 0.034 * fw;
  }

  /** Plan nods, eyebrow raises and blinks from Azure word boundaries. */
  #planGestures(words) {
    const out = [];
    let phraseStart = true;
    words.forEach((w, i) => {
      const text = String(w.text || "");
      const long = (w.d || 0) > 320;
      if (phraseStart) {
        out.push({ t: w.t - 60, dur: rand(380, 520), kind: "nod", amp: rand(0.5, 0.9) });
        if (Math.random() < 0.55) out.push({ t: w.t - 40, dur: rand(520, 760), kind: "brow", amp: rand(0.45, 0.8) });
      } else if (long && Math.random() < 0.45) {
        out.push({ t: w.t, dur: rand(300, 440), kind: "nod", amp: rand(0.3, 0.6) });
      } else if (long && Math.random() < 0.2) {
        out.push({ t: w.t, dur: rand(450, 650), kind: "brow", amp: rand(0.3, 0.55) });
      }
      phraseStart = PHRASE_END.test(text);
      if (phraseStart) {
        const end = w.t + (w.d || 200);
        if (/[?؟]$/.test(text)) out.push({ t: end - 250, dur: 700, kind: "brow", amp: 0.8 });
        if (Math.random() < 0.6) out.push({ t: end + 60, dur: 0, kind: "blink", amp: 1 });
        out.push({ t: end, dur: 0, kind: "turn", amp: 1 });
      }
      if (i === words.length - 1) out.push({ t: (w.t || 0) + (w.d || 200) + 120, dur: rand(420, 560), kind: "nod", amp: 0.35 });
    });
    return out.sort((a, b) => a.t - b.t);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.node;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    const half = VIEW.size / 2;
    const aspect = w / h;
    this.camera.left = VIEW.cx - 0.5 - half * aspect;
    this.camera.right = VIEW.cx - 0.5 + half * aspect;
    this.camera.updateProjectionMatrix();
  }

  async resume() {
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
  }

  get speaking() {
    return performance.now() < this.speakingUntil;
  }

  /** Play Azure Speech audio with viseme-driven lip-sync. Resolves when playback ends or is stopped. */
  async speak({ audio_base64, visemes = [], words = [] }) {
    await this.resume();
    const bytes = Uint8Array.from(atob(audio_base64), (c) => c.charCodeAt(0));
    const buffer = await this.audioCtx.decodeAudioData(bytes.buffer);
    this.stop();
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(this.audioCtx.destination);
    const start = this.audioCtx.currentTime + 0.05;
    source.start(start);
    this.source = source;
    this.track = {
      start, visemes, words: words.map((w) => w.t), analyser,
      samples: new Float32Array(analyser.fftSize), index: 0,
    };
    this.motion.gestures = this.#planGestures(words);
    this.motion.target.next = 0;
    const duration = buffer.duration * 1000 + 150;
    this.speakingUntil = performance.now() + duration;
    return new Promise((resolve) => {
      this.onEnd = resolve;
      this.endTimer = setTimeout(() => this.#finish(), duration);
    });
  }

  #finish() {
    clearTimeout(this.endTimer);
    this.speakingUntil = 0;
    this.track = null;
    const done = this.onEnd;
    this.onEnd = null;
    done?.();
  }

  stop() {
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
    this.#finish();
  }

  setMood() {}

  lookAtUser() {}

  #targetPose() {
    const tr = this.track;
    if (!tr) return [0, 0, 0];
    const ms = (this.audioCtx.currentTime - tr.start) * 1000 + 30;
    if (ms < 0) return [0, 0, 0];
    const { visemes } = tr;
    if (!visemes.length) {
      tr.analyser.getFloatTimeDomainData(tr.samples);
      let sum = 0;
      for (const s of tr.samples) sum += s * s;
      return [Math.min(0.7, Math.sqrt(sum / tr.samples.length) * 6), 0.1, 0];
    }
    while (tr.index < visemes.length - 1 && visemes[tr.index + 1].t <= ms) tr.index++;
    const cur = visemes[tr.index];
    const next = visemes[tr.index + 1];
    const a = VISEME_POSE[cur.id] || VISEME_POSE[0];
    if (!next) return a;
    if (cur.id === BILABIAL) return [0, 0.05, 0.05];
    const span = Math.max(next.t - cur.t, 1);
    const b = VISEME_POSE[next.id] || VISEME_POSE[0];
    const k = smoothstep(0.35, 1, (ms - cur.t) / span) * (next.id === BILABIAL ? 0.9 : 0.55);
    const pose = a.map((v, i) => v + (b[i] - v) * k);
    if (span > 260 && cur.id !== 0) pose[0] *= 1 - 0.25 * smoothstep(0.5, 1, (ms - cur.t) / span);
    return pose;
  }

  #loudness(dt) {
    const tr = this.track, m = this.motion;
    let level = 0;
    if (tr) {
      tr.analyser.getFloatTimeDomainData(tr.samples);
      let sum = 0;
      for (const s of tr.samples) sum += s * s;
      level = Math.sqrt(sum / tr.samples.length);
    }
    m.peak = Math.max(0.03, m.peak * Math.exp(-dt * 0.4), level);
    const norm = Math.min(1, level / m.peak);
    m.loud += (norm - m.loud) * (1 - Math.exp(-dt * (norm > m.loud ? 30 : 9)));
    return m.loud;
  }

  #updateMotion(now, dt) {
    const m = this.motion, tr = this.track;
    const talking = !!tr;
    m.energy += ((talking ? 1 : 0) - m.energy) * (1 - Math.exp(-dt * (talking ? 3 : 1.2)));
    const ms = tr ? (this.audioCtx.currentTime - tr.start) * 1000 : -1;

    if (now > m.target.next) {
      const e = m.energy;
      m.target.yaw = rand(-1, 1) * (0.25 + 0.55 * e);
      m.target.pitch = rand(-0.4, 0.4) * (0.3 + 0.4 * e);
      m.target.roll = rand(-1, 1) * (0.004 + 0.008 * e);
      m.target.next = now + (talking ? rand(1400, 2600) : rand(2500, 5000));
    }

    let nod = 0, brow = 0;
    for (const g of m.gestures) {
      if (ms < g.t) break;
      if (g.kind === "blink" || g.kind === "turn") {
        if (!g.done && ms >= g.t) {
          g.done = true;
          if (g.kind === "blink" && !this.blink.start) this.blink.next = now;
          if (g.kind === "turn") m.target.next = 0;
        }
        continue;
      }
      const u = (ms - g.t) / g.dur;
      if (g.kind === "nod") nod += g.amp * (bump(u) - 0.35 * bump(u * 1.6 - 0.6));
      else brow += g.amp * bump(u);
    }
    if (!talking) m.gestures = [];

    const loud = this.#loudness(dt);
    spring(m.yaw, m.target.yaw, talking ? 3.2 : 1.8, dt);
    spring(m.pitch, m.target.pitch + nod * 1.1 + loud * 0.18 * m.energy, talking ? 9 : 3, dt);
    spring(m.roll, m.target.roll, 2, dt);
    spring(m.brow, Math.min(1, brow + loud * 0.12 * m.energy), 11, dt);

    const gz = m.gaze;
    if (now > gz.next) {
      const away = talking ? 0.35 : 1;
      gz.tx = rand(-1, 1) * 0.0022 * away;
      gz.ty = rand(-1, 1) * 0.0009 * away;
      gz.next = now + (talking ? rand(900, 2200) : rand(700, 2600));
      if (Math.abs(gz.tx) > 0.0016 && !this.blink.start && Math.random() < 0.3) this.blink.next = now;
    }
    const snap = 1 - Math.exp(-dt * 38);
    gz.x += (gz.tx - gz.x) * snap;
    gz.y += (gz.ty - gz.y) * snap;
  }

  #blinkAmount(now) {
    const b = this.blink;
    if (now >= b.next && !b.start) b.start = now;
    if (!b.start) return 0;
    const t = now - b.start;
    const amount = t < 70 ? t / 70 : t < 170 ? 1 - (t - 70) / 100 : 0;
    if (t >= 170) {
      b.start = 0;
      b.double = !b.double && Math.random() < 0.18;
      b.next = now + (b.double ? 140 : 2600 + Math.random() * 3400);
    }
    return amount;
  }

  frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const t = now / 1000;
    const talking = !!this.track;

    this.#updateMotion(now, dt);
    const m = this.motion;
    const [jaw, wide, round] = this.#targetPose();
    const gain = talking ? 0.85 + 0.35 * m.loud : 1;
    const omega = talking ? 40 : 14;
    spring(this.mouth.jaw, jaw * gain, jaw * gain < this.mouth.jaw.x ? omega * 1.2 : omega, dt);
    spring(this.mouth.wide, wide, omega * 0.8, dt);
    spring(this.mouth.round, round, omega * 0.8, dt);
    this.pose.jaw = Math.max(0, this.mouth.jaw.x);
    this.pose.wide = this.mouth.wide.x;
    this.pose.round = Math.max(0, this.mouth.round.x);
    const blink = this.#blinkAmount(now);

    const amp = 1 + 0.4 * m.energy;
    const angle = (0.009 * Math.sin(t * 0.37) + 0.004 * Math.sin(t * 0.83 + 1)) * amp + m.roll.x;
    const tx = 0.002 * Math.sin(t * 0.29) * amp;
    const ty = 0.0015 * Math.sin(t * 0.51);
    const breathe = 0.0012 * Math.sin(t * 1.1);
    const yaw = m.yaw.x * this.turn, pitch = m.pitch.x * this.turn * 0.55;
    const lift = m.brow.x * this.browLift;
    const depth = this.depth, browW = this.brow;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const [px, py] = this.data.pivot;
    const { jaw: J, wide: W, round: R } = this.bases;
    const { blinkL: BL, blinkR: BR } = this.bases;
    const w = this.work, rest = this.rest, head = this.head;
    const pos = this.positions.array;

    for (let i = 0; i < this.count; i++) {
      const ix = i * 2, iy = ix + 1;
      let x = rest[ix] + J[ix] * this.pose.jaw + W[ix] * this.pose.wide + R[ix] * this.pose.round;
      let y = rest[iy] + J[iy] * this.pose.jaw + W[iy] * this.pose.wide + R[iy] * this.pose.round
        + (BL[iy] + BR[iy]) * blink - browW[i] * lift;
      const h = head[i];
      const dp = depth[i];
      x += yaw * (0.3 * h + 0.7 * dp);
      y += pitch * (0.35 * h + 0.65 * dp);
      if (h > 0) {
        const dx = x - px, dy = y - py;
        const c = 1 + (cos - 1) * h, s = sin * h;
        x = px + dx * c - dy * s + tx * h;
        y = py + dx * s + dy * c + ty * h;
      }
      y -= breathe * (1 - h) * (y - 0.6);
      w[ix] = x;
      w[iy] = y;
      pos[i * 3] = x - 0.5;
      pos[i * 3 + 1] = 0.5 - y;
    }
    for (const i of IRIS) {
      pos[i * 3] += m.gaze.x;
      pos[i * 3 + 1] -= m.gaze.y;
    }
    this.positions.needsUpdate = true;

    const mp = this.mouthPositions.array;
    let cx = 0, cy = 0;
    this.ring.forEach((v, k) => {
      mp[k * 3] = w[v * 2] - 0.5;
      mp[k * 3 + 1] = 0.5 - w[v * 2 + 1];
      cx += mp[k * 3];
      cy += mp[k * 3 + 1];
    });
    const n = this.ring.length;
    mp[n * 3] = cx / n;
    mp[n * 3 + 1] = cy / n;
    this.mouthPositions.needsUpdate = true;
    const up = this.data.mouth.upper, lo = this.data.mouth.lower;
    const top = up[Math.floor(up.length / 2)], bottom = lo[Math.floor(lo.length / 2)];
    const left = up[0], right = up[up.length - 1];
    this.lips.value.set(
      cx / n, 0.5 - w[top * 2 + 1], 0.5 - w[bottom * 2 + 1], Math.abs(w[right * 2] - w[left * 2]) / 2,
    );

    this.uniforms.time.value = t;
    this.renderer.render(this.scene, this.camera);
  }
}
