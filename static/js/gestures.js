import { t } from "./i18n.js";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const HOLD_MS = 650;
const COOLDOWN_MS = 1200;
const SWIPE_DIST = 0.22;
const SWIPE_MS = 350;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Webcam hand-gesture control (processed locally in the browser with MediaPipe):
 * pinch + move = pan, two open hands apart/together = zoom, pointing finger up/down = scroll,
 * open-palm swipe = next/previous, fist = minimize, thumbs-down = close, thumbs-up = restore.
 */
export class HandGestures {
  constructor(host, onCommand) {
    this.host = host;
    this.onCommand = onCommand;
    this.running = false;
    this.recognizer = null;
    this.stream = null;
    this.el = null;
    this.reset();
  }

  reset() {
    this.pinch = null;
    this.zoom = null;
    this.point = null;
    this.trail = [];
    this.hold = { name: null, since: 0 };
    this.cooldownUntil = 0;
  }

  async start() {
    if (this.running) return;
    this.#mountPreview();
    this.label(t("gesturesStarting"));
    const { FilesetResolver, GestureRecognizer } = await import("mediapipe");
    if (!this.recognizer) {
      const vision = await FilesetResolver.forVisionTasks(WASM);
      this.recognizer = await GestureRecognizer.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
      });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.reset();
    this.label(t("gesture_idle"));
    this.#loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.el?.remove();
    this.el = null;
  }

  #mountPreview() {
    this.el?.remove();
    this.el = document.createElement("div");
    this.el.className = "gesture-cam";
    this.el.innerHTML = '<video playsinline muted></video><canvas></canvas><div class="gesture-label"></div>';
    this.video = this.el.querySelector("video");
    this.overlay = this.el.querySelector("canvas");
    this.labelEl = this.el.querySelector(".gesture-label");
    this.host.appendChild(this.el);
  }

  label(text) {
    if (this.labelEl) this.labelEl.textContent = text;
  }

  #loop() {
    if (!this.running) return;
    const now = performance.now();
    if (this.video.readyState >= 2 && this.video.currentTime !== this.lastTime) {
      this.lastTime = this.video.currentTime;
      try {
        this.#handle(this.recognizer.recognizeForVideo(this.video, now), now);
      } catch {
        /* dropped frame */
      }
    }
    requestAnimationFrame(() => this.#loop());
  }

  #draw(hands) {
    const c = this.overlay;
    c.width = this.video.videoWidth;
    c.height = this.video.videoHeight;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "rgba(95, 212, 234, 0.9)";
    hands.forEach((lm) =>
      lm.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x * c.width, p.y * c.height, 3, 0, Math.PI * 2);
        ctx.fill();
      }),
    );
  }

  #emit(command, arg, text) {
    this.onCommand(command, arg);
    if (text) this.label(text);
  }

  #handle(result, now) {
    const hands = result.landmarks || [];
    const names = (result.gestures || []).map((g) => g[0]?.categoryName || "None");
    this.#draw(hands);
    if (!hands.length) {
      this.reset();
      this.label(t("gesture_idle"));
      return;
    }

    // Two open hands: zoom by the change in distance between palms.
    if (hands.length === 2 && names.every((n) => n === "Open_Palm")) {
      const d = dist(hands[0][9], hands[1][9]);
      if (this.zoom) {
        const ratio = d / this.zoom;
        if (Math.abs(ratio - 1) > 0.04) {
          this.#emit("zoomBy", ratio, t("gesture_zoom"));
          this.zoom = d;
        }
      } else {
        this.zoom = d;
      }
      return;
    }
    this.zoom = null;

    const lm = hands[0];
    const name = names[0];
    const size = dist(lm[0], lm[9]) || 0.1;
    const pinching = dist(lm[4], lm[8]) / size < 0.35;
    // The preview is mirrored, so invert x to match the user's perspective.
    const mid = { x: 1 - (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };

    if (pinching) {
      if (this.pinch) {
        const dx = (mid.x - this.pinch.x) * 1400;
        const dy = (mid.y - this.pinch.y) * 1100;
        if (Math.abs(dx) + Math.abs(dy) > 1.5) this.#emit("panBy", { dx, dy }, t("gesture_pan"));
      }
      this.pinch = mid;
      this.trail = [];
      return;
    }
    this.pinch = null;

    if (name === "Pointing_Up") {
      const y = lm[8].y;
      if (this.point !== null) {
        const dy = (y - this.point) * 1600;
        if (Math.abs(dy) > 2) this.#emit("panBy", { dx: 0, dy }, t("gesture_scroll"));
      }
      this.point = y;
      return;
    }
    this.point = null;

    if (now < this.cooldownUntil) return;

    if (name === "Open_Palm") {
      this.trail.push({ x: 1 - lm[9].x, t: now });
      this.trail = this.trail.filter((p) => now - p.t < SWIPE_MS);
      const dx = this.trail[this.trail.length - 1].x - this.trail[0].x;
      if (Math.abs(dx) > SWIPE_DIST) {
        this.#emit(dx < 0 ? "next" : "prev", null, t("gesture_swipe"));
        this.trail = [];
        this.cooldownUntil = now + 700;
      }
      return;
    }
    this.trail = [];

    const held = { Closed_Fist: "minimize", Thumb_Down: "close", Thumb_Up: "restore" }[name];
    if (!held) {
      this.hold = { name: null, since: 0 };
      return;
    }
    if (this.hold.name !== name) {
      this.hold = { name, since: now };
      return;
    }
    if (now - this.hold.since > HOLD_MS) {
      this.#emit(held, null, t(`gesture_${held}`));
      this.hold = { name: null, since: 0 };
      this.cooldownUntil = now + COOLDOWN_MS;
    }
  }
}
