import DOMPurify from "dompurify";
import * as pdfjs from "pdfjs";
import { icon, kindIcon } from "./icons.js";
import { sessionUrl } from "./api.js";
import { lang, t } from "./i18n.js";

pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const MIN_SCALE = 0.2;
const MAX_SCALE = 6;
const PAD = 16;
const PAGE_WIDTH = 820;
const coarse = window.matchMedia("(pointer: coarse)").matches;
let hintShown = false;
let zCounter = 100;

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

class DocWindow {
  constructor(workspace, doc, index) {
    this.ws = workspace;
    this.doc = doc;
    this.key = `${doc.origin}:${doc.id}`;
    this.view = { s: 1, x: PAD, y: PAD };
    this.fitMode = true;
    this.mode = "flow";
    this.pages = [];
    this.slide = 0;
    this.sheet = 0;
    this.minimized = false;
    this.#build(index);
    this.ready = this.#render();
  }

  #build(index) {
    const el = document.createElement("section");
    el.className = "win";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", this.doc.title);
    const originLabel = this.doc.origin === "knowledge" ? t("approvedSource") : t("uploaded");
    const subtitle = [originLabel, this.doc.approved_by ? `${t("approvedBy")} ${this.doc.approved_by}` : ""]
      .filter(Boolean)
      .join(" · ");
    el.innerHTML = `
      <header class="win-head">
        <span class="win-kind">${kindIcon(this.doc.kind, 18)}</span>
        <div class="win-title"><strong dir="auto">${escapeHtml(this.title)}</strong><small>${escapeHtml(subtitle)}</small></div>
        <div class="win-actions">
          <button class="icon-btn" data-act="minimize" title="${t("minimize")}" aria-label="${t("minimize")}">${icon("minimize")}</button>
          <button class="icon-btn" data-act="maximize" title="${t("maximize")}" aria-label="${t("maximize")}">${icon("maximize", 15)}</button>
          <button class="icon-btn" data-act="close" title="${t("close")}" aria-label="${t("close")}">${icon("close")}</button>
        </div>
      </header>
      <div class="win-toolbar">
        <button class="icon-btn" data-act="zoomOut" title="${t("zoomOut")}" aria-label="${t("zoomOut")}">${icon("zoomOut", 17)}</button>
        <span class="zoom-val">100%</span>
        <button class="icon-btn" data-act="zoomIn" title="${t("zoomIn")}" aria-label="${t("zoomIn")}">${icon("zoomIn", 17)}</button>
        <button class="icon-btn" data-act="fit" title="${t("fit")}" aria-label="${t("fit")}">${icon("fit", 17)}</button>
        <span class="sep nav-part"></span>
        <button class="icon-btn nav-part" data-act="prev" data-flip title="${t("prev")}" aria-label="${t("prev")}">${icon("prev", 17)}</button>
        <span class="page-val nav-part"></span>
        <button class="icon-btn nav-part" data-act="next" data-flip title="${t("next")}" aria-label="${t("next")}">${icon("next", 17)}</button>
        <div class="tabs"></div>
        <span class="spacer"></span>
        <button class="icon-btn gesture-btn" data-act="gestures" title="${t("gestures")}" aria-label="${t("gestures")}">${icon("hand", 17)}</button>
      </div>
      <div class="viewport" tabindex="0">
        <div class="canvas"></div>
        <div class="loading-view"></div>
        <div class="hint"></div>
        <div class="flash"></div>
      </div>
      <div class="win-resize" aria-hidden="true"></div>`;
    this.el = el;
    this.viewport = el.querySelector(".viewport");
    this.canvas = el.querySelector(".canvas");
    this.zoomVal = el.querySelector(".zoom-val");
    this.pageVal = el.querySelector(".page-val");
    this.tabs = el.querySelector(".tabs");
    this.gestureBtn = el.querySelector(".gesture-btn");
    this.gestureBtn.classList.toggle("active", this.ws.gesturesOn);

    const area = this.ws.root.getBoundingClientRect();
    const width = Math.min(920, Math.max(320, area.width - 48));
    const height = Math.max(240, Math.min(area.height - 32, area.height * 0.9));
    const offset = (index % 4) * 24;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.left = `${Math.max(12, Math.min(area.width - width - 12, (area.width - width) / 2 + offset))}px`;
    el.style.top = `${Math.max(12, Math.min(area.height - height - 12, (area.height - height) / 2 + offset))}px`;

    el.addEventListener("pointerdown", () => this.ws.focus(this), true);
    el.querySelectorAll("[data-act]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.command(btn.dataset.act);
      }),
    );
    el.querySelector(".win-head").addEventListener("dblclick", (e) => {
      if (!e.target.closest("button")) this.command("maximize");
    });
    this.#enableDrag(el.querySelector(".win-head"));
    this.#enableResize(el.querySelector(".win-resize"));
    this.#enableViewportGestures();
    new ResizeObserver(() => (this.fitMode ? this.fit() : this.apply())).observe(this.viewport);
  }

  get title() {
    return lang() === "ar" && this.doc.title_ar ? this.doc.title_ar : this.doc.title;
  }

  // ---------- Rendering ----------
  async #render() {
    const preview = this.doc.preview || {};
    try {
      if (preview.kind === "pdf") await this.#renderPdf();
      else if (preview.kind === "slides") this.#renderSlides(preview.slides || []);
      else if (preview.kind === "sheets") this.#renderSheets(preview.sheets || []);
      else if (preview.kind === "image") await this.#renderImage();
      else if (preview.kind === "html") this.#renderHtml(preview.html || "");
      else if (preview.kind === "text") this.#renderText(preview.text || "");
      else this.canvas.innerHTML = `<div class="empty-view">${t("noPreview")}</div>`;
    } catch {
      this.canvas.innerHTML = `<div class="empty-view">${t("noPreview")}</div>`;
    }
    this.el.querySelector(".loading-view").remove();
    this.el.querySelectorAll(".nav-part").forEach((n) => (n.hidden = this.mode === "flow"));
    this.fit();
    if (!hintShown) {
      hintShown = true;
      this.showHint(coarse ? t("hintTouch") : t("hintMouse"));
    }
  }

  async #renderPdf() {
    this.mode = "pages";
    const pdf = await pdfjs.getDocument({ url: sessionUrl(this.doc.raw_url), isEvalSupported: false }).promise;
    const ratio = Math.min(2.5, (window.devicePixelRatio || 1) * 1.6);
    const holders = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const holder = document.createElement("div");
      holder.className = "page";
      holder.style.width = `${PAGE_WIDTH}px`;
      holder.style.height = `${Math.round(PAGE_WIDTH * 1.294)}px`;
      this.canvas.appendChild(holder);
      holders.push(holder);
    }
    this.pages = holders;
    this.canvas.style.width = `${PAGE_WIDTH}px`;
    const renderPage = async (n) => {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (PAGE_WIDTH / base.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${PAGE_WIDTH}px`;
      canvas.style.height = `${viewport.height / ratio}px`;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const holder = holders[n - 1];
      holder.style.height = "";
      holder.appendChild(canvas);
    };
    await renderPage(1);
    (async () => {
      for (let n = 2; n <= pdf.numPages; n++) {
        if (!this.el.isConnected) return;
        await renderPage(n);
        this.apply();
      }
    })();
  }

  #renderSlides(slides) {
    this.mode = "slides";
    this.slides = slides;
    this.#showSlide(0);
  }

  #showSlide(i) {
    if (!this.slides?.length) {
      this.canvas.innerHTML = `<div class="empty-view">${t("noPreview")}</div>`;
      return;
    }
    this.slide = Math.max(0, Math.min(this.slides.length - 1, i));
    const s = this.slides[this.slide];
    const bullets = s.body
      .map((b) => `<li class="l${Math.min(2, b.level || 0)}" dir="auto">${escapeHtml(b.text)}</li>`)
      .join("");
    const images = s.images.map((n) => `<img src="${sessionUrl(`${this.doc.asset_base}${n}`)}" alt="" loading="lazy">`).join("");
    this.canvas.innerHTML = `
      <div class="slide">
        <div class="slide-num">${t("slide")} ${this.slide + 1} / ${this.slides.length}</div>
        ${s.title ? `<h2 dir="auto">${escapeHtml(s.title)}</h2>` : ""}
        <div class="slide-content">${bullets ? `<ul>${bullets}</ul>` : ""}${images ? `<div class="slide-images">${images}</div>` : ""}</div>
      </div>
      ${s.notes ? `<div class="slide-notes" dir="auto"><b>${t("notes")}</b>${escapeHtml(s.notes)}</div>` : ""}`;
    this.canvas.style.width = "960px";
    this.fitMode = true;
    this.fit();
    this.#updatePageLabel();
  }

  #renderSheets(sheets) {
    this.sheets = sheets;
    this.mode = sheets.length > 1 ? "sheets" : "flow";
    this.tabs.innerHTML = sheets.length > 1
      ? sheets.map((s, i) => `<button class="tab" data-sheet="${i}">${escapeHtml(s.name)}</button>`).join("")
      : "";
    this.tabs.querySelectorAll(".tab").forEach((tab) =>
      tab.addEventListener("click", () => this.#showSheet(Number(tab.dataset.sheet))),
    );
    this.#showSheet(0);
  }

  #showSheet(i) {
    const sheet = this.sheets[i];
    if (!sheet) {
      this.canvas.innerHTML = `<div class="empty-view">${t("noPreview")}</div>`;
      return;
    }
    this.sheet = i;
    this.tabs.querySelectorAll(".tab").forEach((tab, n) => tab.classList.toggle("active", n === i));
    const cols = sheet.rows[0]?.length || 0;
    const colName = (n) => {
      let s = "";
      for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
      return s;
    };
    const head = `<tr><th></th>${Array.from({ length: cols }, (_, n) => `<th>${colName(n)}</th>`).join("")}</tr>`;
    const body = sheet.rows
      .map((r, n) => `<tr><td class="rownum">${n + 1}</td>${r.map((c) => `<td dir="auto" title="${escapeHtml(c)}">${escapeHtml(c)}</td>`).join("")}</tr>`)
      .join("");
    this.canvas.innerHTML = `<table class="sheet-table">${head}${body}</table>${sheet.truncated ? `<div class="sheet-note">${t("truncated")}</div>` : ""}`;
    this.canvas.style.width = "max-content";
    this.fitMode = false;
    this.view = { s: 1, x: PAD, y: PAD };
    this.apply();
    this.#updatePageLabel();
  }

  #renderImage() {
    this.mode = "flow";
    return new Promise((resolve) => {
      const img = new Image();
      img.className = "img-view";
      img.alt = this.doc.title;
      img.onload = img.onerror = () => resolve();
      img.src = sessionUrl(this.doc.raw_url);
      this.canvas.appendChild(img);
      this.canvas.style.width = "max-content";
      this.centered = true;
    });
  }

  #renderHtml(html) {
    this.mode = "flow";
    const page = document.createElement("article");
    page.className = "page doc-page";
    page.dir = "auto";
    page.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input"], FORBID_ATTR: ["style"] });
    page.querySelectorAll("a[href]").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
    this.canvas.appendChild(page);
    this.canvas.style.width = `${PAGE_WIDTH}px`;
  }

  #renderText(text) {
    this.mode = "flow";
    const page = document.createElement("article");
    page.className = "page doc-page";
    page.innerHTML = `<pre dir="auto">${escapeHtml(text)}</pre>`;
    this.canvas.appendChild(page);
    this.canvas.style.width = `${PAGE_WIDTH}px`;
  }

  // ---------- View transform ----------
  get size() {
    return { w: this.canvas.offsetWidth, h: this.canvas.offsetHeight };
  }

  fit() {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const { w, h } = this.size;
    if (!vw || !w) return;
    const whole = this.mode === "slides" || this.centered;
    let s = (vw - PAD * 2) / w;
    if (whole) s = Math.min(s, (vh - PAD * 2) / h, this.centered ? 1 : Infinity);
    this.view = { s: Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)), x: PAD, y: PAD };
    this.fitMode = true;
    this.apply();
  }

  clamp() {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const { w, h } = this.size;
    const sw = w * this.view.s;
    const sh = h * this.view.s;
    const v = this.view;
    if (sw + PAD * 2 <= vw) v.x = (vw - sw) / 2;
    else v.x = Math.min(PAD, Math.max(vw - sw - PAD, v.x));
    if (sh + PAD * 2 <= vh) v.y = this.mode === "slides" || this.centered ? (vh - sh) / 2 : PAD;
    else v.y = Math.min(PAD, Math.max(vh - sh - PAD, v.y));
  }

  apply() {
    this.clamp();
    const { s, x, y } = this.view;
    this.canvas.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    this.zoomVal.textContent = `${Math.round(s * 100)}%`;
    if (this.mode === "pages") this.#updatePageLabel();
  }

  zoomAt(factor, cx, cy) {
    const v = this.view;
    const rect = this.viewport.getBoundingClientRect();
    cx = cx ?? rect.width / 2;
    cy = cy ?? rect.height / 2;
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.s * factor));
    v.x = cx - (cx - v.x) * (s / v.s);
    v.y = cy - (cy - v.y) * (s / v.s);
    v.s = s;
    this.fitMode = false;
    this.apply();
  }

  panBy(dx, dy) {
    this.view.x += dx;
    this.view.y += dy;
    this.apply();
  }

  get currentPage() {
    if (!this.pages.length) return 0;
    const probe = (-this.view.y + this.viewport.clientHeight * 0.35) / this.view.s;
    let current = 0;
    this.pages.forEach((p, i) => {
      if (p.offsetTop <= probe) current = i;
    });
    return current;
  }

  #updatePageLabel() {
    if (this.mode === "pages") this.pageVal.textContent = `${this.currentPage + 1} / ${this.pages.length}`;
    else if (this.mode === "slides") this.pageVal.textContent = `${this.slide + 1} / ${this.slides.length}`;
    else if (this.mode === "sheets") this.pageVal.textContent = `${this.sheet + 1} / ${this.sheets.length}`;
  }

  goToPage(i) {
    if (!this.pages.length) return;
    i = Math.max(0, Math.min(this.pages.length - 1, i));
    this.view.y = PAD - this.pages[i].offsetTop * this.view.s;
    this.apply();
    return i;
  }

  step(direction) {
    if (this.mode === "pages") {
      const page = this.goToPage(this.currentPage + direction);
      this.flash(`${t("page")} ${page + 1}`);
    } else if (this.mode === "slides") {
      this.#showSlide(this.slide + direction);
      this.flash(`${t("slide")} ${this.slide + 1}`);
    } else if (this.mode === "sheets") {
      this.#showSheet((this.sheet + direction + this.sheets.length) % this.sheets.length);
      this.flash(`${t("sheet")} ${this.sheets[this.sheet].name}`);
    } else {
      this.panBy(0, -direction * this.viewport.clientHeight * 0.85);
    }
  }

  goTo(anchor = {}) {
    this.ready.then(() => {
      if (anchor.page && this.mode === "pages") this.goToPage(anchor.page - 1);
      else if (anchor.slide && this.mode === "slides") this.#showSlide(anchor.slide - 1);
      else if (anchor.sheet && this.sheets) {
        const i = this.sheets.findIndex((s) => s.name === anchor.sheet);
        if (i >= 0) this.#showSheet(i);
      } else if (anchor.heading) {
        const target = [...this.canvas.querySelectorAll("h1,h2,h3,h4,h5,h6")].find(
          (h) => h.textContent.trim() === anchor.heading.trim(),
        );
        if (target) {
          const top = target.getBoundingClientRect().top - this.canvas.getBoundingClientRect().top;
          this.view.y = PAD - top;
          this.apply();
          target.animate(
            [{ backgroundColor: "rgba(95,212,234,0.35)" }, { backgroundColor: "transparent" }],
            { duration: 1800, easing: "ease-out" },
          );
        }
      }
    });
  }

  // ---------- Commands ----------
  command(name, arg) {
    switch (name) {
      case "zoomIn":
        this.zoomAt(1.25);
        this.flash(this.zoomVal.textContent);
        break;
      case "zoomOut":
        this.zoomAt(0.8);
        this.flash(this.zoomVal.textContent);
        break;
      case "fit":
        this.fit();
        break;
      case "zoomBy":
        this.zoomAt(arg);
        break;
      case "panBy":
        this.panBy(arg.dx, arg.dy);
        break;
      case "next":
        this.step(1);
        break;
      case "prev":
        this.step(-1);
        break;
      case "scrollDown":
        this.panBy(0, -(arg || this.viewport.clientHeight * 0.4));
        break;
      case "scrollUp":
        this.panBy(0, arg || this.viewport.clientHeight * 0.4);
        break;
      case "maximize":
        this.el.classList.toggle("maximized");
        break;
      case "minimize":
        this.ws.minimize(this);
        break;
      case "close":
        this.ws.close(this);
        break;
      case "gestures":
        this.ws.toggleGestures();
        break;
    }
  }

  showHint(text, ms = 3800) {
    const hint = this.el.querySelector(".hint");
    hint.textContent = text;
    hint.classList.add("show");
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => hint.classList.remove("show"), ms);
  }

  flash(text) {
    const flash = this.el.querySelector(".flash");
    flash.textContent = text;
    flash.classList.add("show");
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => flash.classList.remove("show"), 900);
  }

  // ---------- Pointer, touch, wheel, keyboard ----------
  #enableDrag(handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button") || this.el.classList.contains("maximized") || e.button !== 0) return;
      const startX = e.clientX, startY = e.clientY;
      const left = this.el.offsetLeft, top = this.el.offsetTop;
      const area = this.ws.root.getBoundingClientRect();
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const x = Math.min(area.width - 80, Math.max(80 - this.el.offsetWidth, left + ev.clientX - startX));
        const y = Math.min(area.height - 46, Math.max(0, top + ev.clientY - startY));
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  #enableResize(handle) {
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const w = this.el.offsetWidth, h = this.el.offsetHeight;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        this.el.style.width = `${Math.max(320, w + ev.clientX - startX)}px`;
        this.el.style.height = `${Math.max(240, h + ev.clientY - startY)}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  #enableViewportGestures() {
    const vp = this.viewport;
    const pointers = new Map();
    let pinch = null;
    let swipe = null;
    const local = (e) => {
      const r = vp.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    vp.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      vp.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      vp.classList.add("dragging");
      if (pointers.size === 1) {
        swipe = { ...local(e), t: performance.now(), y0: this.view.y, x0: this.view.x };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        swipe = null;
      }
    });

    vp.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const cur = local(e);
      pointers.set(e.pointerId, cur);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        this.view.x += cx - pinch.cx;
        this.view.y += cy - pinch.cy;
        this.zoomAt(d / pinch.d, cx, cy);
        pinch = { d, cx, cy };
      } else if (pointers.size === 1) {
        this.panBy(cur.x - prev.x, cur.y - prev.y);
      }
    });

    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const cur = local(e);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        vp.classList.remove("dragging");
        if (swipe) {
          const dx = cur.x - swipe.x, dy = cur.y - swipe.y;
          const dt = performance.now() - swipe.t;
          const fitsWidth = this.size.w * this.view.s <= vp.clientWidth + 1;
          if (fitsWidth && this.mode !== "flow" && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 500) {
            this.view.y = swipe.y0;
            this.step(dx < 0 ? 1 : -1);
          }
        }
        swipe = null;
      }
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);

    vp.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = local(e);
        if (e.ctrlKey || e.metaKey) this.zoomAt(Math.exp(-e.deltaY * 0.0022), p.x, p.y);
        else if (e.shiftKey) this.panBy(-e.deltaY, 0);
        else this.panBy(-e.deltaX, -e.deltaY);
      },
      { passive: false },
    );

    vp.addEventListener("keydown", (e) => {
      const rtl = document.documentElement.dir === "rtl";
      const map = {
        "+": "zoomIn", "=": "zoomIn", "-": "zoomOut", "0": "fit",
        ArrowRight: rtl ? "prev" : "next", ArrowLeft: rtl ? "next" : "prev",
        PageDown: "next", PageUp: "prev", Escape: "minimize",
      };
      if (e.key === "ArrowDown") this.panBy(0, -80);
      else if (e.key === "ArrowUp") this.panBy(0, 80);
      else if (map[e.key]) this.command(map[e.key]);
      else return;
      e.preventDefault();
    });
  }
}

export class Workspace {
  constructor(root, dock) {
    this.root = root;
    this.dock = dock;
    this.windows = [];
    this.focused = null;
    this.gesturesOn = false;
    this.onGesturesToggle = null;
  }

  get active() {
    if (this.focused && !this.focused.minimized) return this.focused;
    return [...this.windows].reverse().find((w) => !w.minimized) || null;
  }

  open(doc, anchor) {
    let win = this.windows.find((w) => w.key === `${doc.origin}:${doc.id}`);
    if (!win) {
      this.windows.filter((w) => !w.minimized).forEach((w) => this.minimize(w));
      win = new DocWindow(this, doc, this.windows.length);
      this.windows.push(win);
      this.root.appendChild(win.el);
    } else if (win.minimized) {
      this.restore(win);
    }
    this.focus(win);
    if (anchor && Object.keys(anchor).length) win.goTo(anchor);
    return win;
  }

  focus(win) {
    if (this.focused === win) return;
    this.windows.forEach((w) => w.el.classList.toggle("focused", w === win));
    win.el.style.zIndex = String(++zCounter);
    this.focused = win;
  }

  minimize(win) {
    if (win.minimized) return;
    win.minimized = true;
    win.el.classList.add("minimizing");
    setTimeout(() => {
      win.el.hidden = true;
      win.el.classList.remove("minimizing");
    }, 200);
    const item = document.createElement("button");
    item.className = "dock-item";
    item.type = "button";
    item.innerHTML = `${kindIcon(win.doc.kind, 15)}<span dir="auto">${escapeHtml(win.title)}</span>`;
    item.addEventListener("click", () => this.restore(win));
    win.dockItem = item;
    this.dock.appendChild(item);
    if (this.focused === win) this.focused = null;
  }

  restore(win) {
    win = win || [...this.windows].reverse().find((w) => w.minimized);
    if (!win) return;
    win.minimized = false;
    win.el.hidden = false;
    win.dockItem?.remove();
    win.dockItem = null;
    this.focus(win);
    win.apply();
  }

  close(win) {
    win.el.classList.add("closing");
    win.dockItem?.remove();
    this.windows = this.windows.filter((w) => w !== win);
    if (this.focused === win) this.focused = null;
    setTimeout(() => win.el.remove(), 170);
    if (!this.windows.length && this.gesturesOn) this.toggleGestures(false);
  }

  closeByKey(key) {
    const win = this.windows.find((w) => w.key === key);
    if (win) this.close(win);
  }

  toggleGestures(force) {
    this.gesturesOn = force ?? !this.gesturesOn;
    this.windows.forEach((w) => w.gestureBtn.classList.toggle("active", this.gesturesOn));
    this.onGesturesToggle?.(this.gesturesOn);
  }

  /** Run a command on the active window (voice commands and hand gestures). */
  command(name, arg) {
    if (name === "restore") return this.restore();
    const win = this.active;
    if (!win) return false;
    win.command(name, arg);
    return true;
  }
}
