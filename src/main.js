import "./style.css";
import "./workspace.js";
import { createCrank } from "./crank.js";

const $ = (selector) => document.querySelector(selector);
const asset = (file) => import.meta.env.BASE_URL + "film/" + file;
const demoPhotos = [];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let photos = demoPhotos;
let currentIndex = 0;
let liveAlbum = false;
let currentLook = "original";
let backgroundIndex = 0;
let selectionToken = 0;
let playing = false;
let playTimer = null;
let toastTimer = null;
let selectedPromise = Promise.resolve();
const imageCache = new Map();
const backgrounds = [$("#background-a"), $("#background-b")];
const dialog = $("#photo-dialog");
const shell = $(".app-shell");
const windAudio = $("#wind-audio");
let focusMode = false;
let winding = false;
let windToken = 0;
let albumRevision = 0;
let soundEnabled = true;
let windSequence = 0;
const crank = createCrank($("#camera-crank"), { reducedMotion });
window.__cameraCrankDiagnostic = () => crank.getState();
document.documentElement.dataset.windSequence = "0";
document.documentElement.dataset.crankState = "idle";
const lookFilters = { original: "none", warm: "sepia(.2) saturate(.85) contrast(1.03) brightness(1.02)", bw: "grayscale(1) contrast(1.08)" };
const labels = { original: "COLOR NEGATIVE", warm: "WARM TONES", bw: "MONOCHROME" };

function tell(message) {
  $("#photo-toast").textContent = message;
  $("#photo-toast").classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#photo-toast").classList.remove("is-visible"), 3500);
}
function preload(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const request = new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("照片无法显示"));
    image.src = url;
  });
  imageCache.set(url, request);
  while (imageCache.size > 6) imageCache.delete(imageCache.keys().next().value);
  request.catch(() => { if (imageCache.get(url) === request) imageCache.delete(url); });
  return request;
}
function rotateImage(node, turns) {
  node.style.setProperty("--photo-rotation", String((turns || 0) * 90) + "deg");
  node.classList.toggle("is-rotated", Boolean((turns || 0) % 2));
}
function photoName(photo) { return photo.name.replace(/\.(jpe?g|png|webp|nef)$/i, ""); }
function setLook(value, notify = true) {
  currentLook = Object.hasOwn(lookFilters, value) ? value : "original";
  document.documentElement.style.setProperty("--look-filter", lookFilters[currentLook]);
  $("#film-look").value = currentLook;
  $("#photo-format").textContent = labels[currentLook];
  if (notify && liveAlbum) window.dispatchEvent(new CustomEvent("film-look", { detail: currentLook }));
}
function renderStrip() {
  const strip = $("#filmstrip");
  strip.replaceChildren();
  if (!photos.length) {
    const placeholder = document.createElement("p");
    placeholder.className = "empty-card";
    placeholder.textContent = "从「添加照片」开始，收进你的第一帧";
    strip.append(placeholder);
    return;
  }
  photos.forEach((photo, index) => {
    const card = document.createElement("button");
    card.type = "button"; card.className = "film-card"; card.dataset.photoId = photo.id;
    card.setAttribute("aria-label", "查看照片：" + photo.name);
    card.title = photo.name;
    const image = document.createElement("img");
    image.src = photo.thumbnail || photo.src; image.alt = ""; image.loading = "lazy"; image.decoding = "async";
    const number = document.createElement("span"); number.className = "card-index"; number.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("span"); name.className = "card-name"; name.textContent = photoName(photo);
    const check = document.createElement("span"); check.className = "card-check"; check.textContent = "✓"; check.setAttribute("aria-hidden", "true");
    card.append(image, number, name, check);
    card.addEventListener("click", () => {
      cancelWinding();
      selectedPromise = selectPhoto(index);
    });
    strip.append(card);
  });
}
function updateFocusPhoto() {
  const photo = photos[currentIndex];
  if (!photo) return;
  $("#focus-title").textContent = photoName(photo);
  $("#focus-caption").textContent = photo.caption || "这一刻，值得留住。";
  $("#focus-counter").textContent = String(currentIndex + 1).padStart(2, "0") + " / " + String(photos.length).padStart(2, "0");
  if (!focusMode) return;
  $("#focus-photo").src = photo.src;
  $("#focus-photo").alt = photo.name;
  rotateImage($("#focus-photo"), photo.rotation);
}
function setWindingState(state) {
  document.documentElement.dataset.crankState = state;
  $("#camera-stage").disabled = state !== "idle" || !photos.length;
  $("#camera-stage").setAttribute("aria-busy", String(state !== "idle"));
}
function cancelWinding() {
  ++windToken;
  winding = false;
  crank.cancel();
  $("#camera-stage").classList.remove("is-winding");
  setWindingState("idle");
  windAudio.pause();
  windAudio.currentTime = 0;
  document.documentElement.dataset.windSound = soundEnabled ? "stopped" : "muted";
}
function openFocus() {
  if (!photos.length) return;
  focusMode = true;
  shell.classList.add("is-photo-focus");
  $("#photo-panel").hidden = false;
  $(".focus-actions").hidden = false;
  $("#workspace-panel").hidden = true;
  $("#toggle-editor span").textContent = "相册管理";
  $("#camera-stage").setAttribute("aria-expanded", "true");
  document.documentElement.dataset.focusMode = "true";
  updateFocusPhoto();
}
function leaveFocus() {
  cancelWinding();
  focusMode = false;
  shell.classList.remove("is-photo-focus");
  $("#camera-stage").setAttribute("aria-expanded", "false");
  $("#photo-panel").hidden = true;
  $(".focus-actions").hidden = true;
  document.documentElement.dataset.focusMode = "false";
  $("#camera-stage").focus({ preventScroll: true });
}
async function windCamera() {
  if (!photos.length || winding) return;
  stopPlaying();
  openFocus();
  const rig = $("#camera-stage");
  const token = ++windToken;
  const revision = albumRevision;
  const sourceId = photos[currentIndex].id;
  const nextIndex = (currentIndex + 1) % photos.length;
  const target = photos[nextIndex];
  ++windSequence;
  winding = true;
  setWindingState("winding");
  rig.classList.add("is-winding");
  rig.style.setProperty("--tilt-x", "0deg");
  rig.style.setProperty("--tilt-y", "0deg");
  rig.dataset.windSequence = String(windSequence);
  document.documentElement.dataset.windSequence = String(windSequence);
  preload(target.src).catch(() => {});
  if (soundEnabled) {
    windAudio.pause();
    windAudio.currentTime = 0;
    windAudio.volume = .65;
    windAudio.play().then(() => {
      if (token === windToken) document.documentElement.dataset.windSound = "playing";
    }).catch((error) => {
      if (token !== windToken || error.name === "AbortError") return;
      document.documentElement.dataset.windSound = "unavailable";
      tell("相机声音暂时无法播放，照片仍可正常浏览。");
    });
  }
  try {
    await crank.wind();
    if (token !== windToken || revision !== albumRevision || photos[currentIndex]?.id !== sourceId) return;
    setWindingState("loading");
    selectedPromise = selectPhoto(nextIndex);
    await selectedPromise;
  } catch {
    if (token === windToken) tell("卷片动作未完成，请再试一次。");
  } finally {
    if (token === windToken) {
      winding = false;
      rig.classList.remove("is-winding");
      setWindingState("idle");
    }
  }
}
function updateViewer() {
  const photo = photos[currentIndex];
  if (!photo || !dialog.open) return;
  $("#large-photo").src = photo.src;
  $("#large-photo").alt = photo.name;
  rotateImage($("#large-photo"), photo.rotation);
  $("#viewer-title").textContent = photo.name;
  $("#viewer-caption").textContent = photo.caption || "这一刻，值得留住。";
  $("#viewer-counter").textContent = String(currentIndex + 1) + " / " + String(photos.length);
  $("#viewer-previous").disabled = currentIndex <= 0;
  $("#viewer-next").disabled = currentIndex >= photos.length - 1;
}
async function selectPhoto(index, notify = true, initial = false) {
  currentIndex = Math.max(0, Math.min(photos.length - 1, index));
  const photo = photos[currentIndex];
  const token = ++selectionToken;
  document.documentElement.dataset.photoCount = String(photos.length);
  document.documentElement.dataset.currentPhotoId = photo?.id || "";
  document.body.classList.toggle("is-empty", !photo);
  for (const button of ["#previous-photo", "#next-photo", "#view-photo", "#camera-stage", "#slideshow"]) {
    $(button).disabled = !photo || (button === "#camera-stage" && winding);
  }
  if (!photo) {
    stopPlaying();
    if (focusMode) leaveFocus();
    $("#frame-title").textContent = "你的第一帧";
    $("#frame-caption").textContent = "添加喜欢的照片，\n从这里开始收藏时光。";
    $("#photo-counter").textContent = "00 / 00";
    document.documentElement.dataset.ready = "true";
    if (dialog.open) dialog.close();
    return;
  }
  $("#previous-photo").disabled = currentIndex === 0;
  $("#next-photo").disabled = currentIndex === photos.length - 1;
  $("#frame-title").textContent = photoName(photo);
  $("#frame-caption").textContent = photo.caption || "在这一帧里，重新遇见当时的光。";
  $("#photo-counter").textContent = String(currentIndex + 1).padStart(2, "0") + " / " + String(photos.length).padStart(2, "0");
  const cards = [...$("#filmstrip").children];
  cards.forEach((card, i) => {
    card.classList.toggle("is-active", i === currentIndex);
    card.setAttribute("aria-pressed", String(i === currentIndex));
  });
  const selectedCard = cards[currentIndex];
  if (selectedCard) {
    const viewport = $("#filmstrip-viewport");
    const cardBounds = selectedCard.getBoundingClientRect();
    const stripBounds = viewport.getBoundingClientRect();
    const left = viewport.scrollLeft + cardBounds.left - stripBounds.left - (viewport.clientWidth - cardBounds.width) / 2;
    viewport.scrollTo({ left, behavior: reducedMotion || initial ? "instant" : "smooth" });
  }
  updateViewer();
  updateFocusPhoto();
  if (notify && liveAlbum) window.dispatchEvent(new CustomEvent("film-select", { detail: photo.id }));
  try {
    await preload(photo.src);
    if (token !== selectionToken) return;
    const nextBackground = backgrounds[1 - backgroundIndex];
    nextBackground.src = photo.src;
    nextBackground.classList.add("is-visible");
    backgrounds[backgroundIndex].classList.remove("is-visible");
    backgroundIndex = 1 - backgroundIndex;
    const viewfinder = $("#viewfinder-photo");
    viewfinder.src = photo.src; viewfinder.alt = photo.name;
    rotateImage(viewfinder, photo.rotation);
    $("#camera-stage").classList.remove("is-changing");
    if (!initial && !reducedMotion) {
      void $("#camera-stage").offsetWidth;
      $("#camera-stage").classList.add("is-changing");
    }
    document.documentElement.dataset.ready = "true";
    document.documentElement.dataset.displayedPhotoId = photo.id;
    const adjacent = photos[currentIndex + 1] || photos[currentIndex - 1];
    if (adjacent) preload(adjacent.src).catch(() => {});
  } catch {
    if (token !== selectionToken) return;
    document.documentElement.dataset.ready = "true";
    document.documentElement.dataset.displayedPhotoId = "";
    tell("这张照片的预览无法读取，请在相册管理中检查文件。");
  }
}
function navigate(direction) {
  if (!photos.length) return;
  cancelWinding();
  if (playing) stopPlaying();
  selectedPromise = selectPhoto(currentIndex + direction);
}
function openViewer() {
  if (!photos.length) return;
  stopPlaying();
  if (!dialog.open) dialog.showModal();
  updateViewer();
}
function stopPlaying() {
  playing = false; clearTimeout(playTimer); playTimer = null;
  $("#slideshow-icon").textContent = "▷";
  $("#slideshow-label").textContent = "自动播放";
  $("#slideshow").setAttribute("aria-label", "开始自动播放");
}
function advanceSlideshow() {
  if (!playing || !photos.length) return;
  selectedPromise = selectPhoto((currentIndex + 1) % photos.length);
  selectedPromise.finally(() => { if (playing) playTimer = setTimeout(advanceSlideshow, 4500); });
}
function toggleSlideshow() {
  cancelWinding();
  if (playing) return stopPlaying();
  if (photos.length < 2) return tell("添加更多照片后，就可以自动播放了。");
  playing = true;
  $("#slideshow-icon").textContent = "Ⅱ";
  $("#slideshow-label").textContent = "暂停播放";
  $("#slideshow").setAttribute("aria-label", "暂停自动播放");
  playTimer = setTimeout(advanceSlideshow, 4500);
}
window.addEventListener("film-album", (event) => {
  cancelWinding();
  ++albumRevision;
  stopPlaying();
  liveAlbum = true;
  photos = event.detail.photos || [];
  const selected = photos.findIndex((photo) => photo.id === event.detail.selectedId);
  $("#album-title").textContent = event.detail.title;
  $("#deck-note").textContent = String(photos.length) + " 帧 · 收藏在本地";
  $(".local-badge").innerHTML = "<i></i> 本地相册";
  setLook(event.detail.filmLook, false);
  renderStrip();
  selectedPromise = selectPhoto(selected < 0 ? 0 : selected, false, true);
});
$("#previous-photo").addEventListener("click", () => navigate(-1));
$("#next-photo").addEventListener("click", () => navigate(1));
$("#viewer-previous").addEventListener("click", () => navigate(-1));
$("#viewer-next").addEventListener("click", () => navigate(1));
$("#view-photo").addEventListener("click", openFocus);
$("#camera-stage").addEventListener("click", windCamera);
$("#back-to-camera").addEventListener("click", leaveFocus);
$("#expand-photo").addEventListener("click", openViewer);
$("#focus-photo-frame").addEventListener("click", openViewer);
$("#sound-toggle").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  $("#sound-toggle").textContent = soundEnabled ? "声音 开" : "声音 关";
  $("#sound-toggle").setAttribute("aria-pressed", String(soundEnabled));
  $("#sound-toggle").setAttribute("aria-label", soundEnabled ? "关闭相机声音" : "开启相机声音");
  if (!soundEnabled) { windAudio.pause(); document.documentElement.dataset.windSound = "muted"; }
});
windAudio.addEventListener("ended", () => { document.documentElement.dataset.windSound = soundEnabled ? "ended" : "muted"; });
$("#close-photo").addEventListener("click", () => dialog.close());
$("#slideshow").addEventListener("click", toggleSlideshow);
$("#film-look").addEventListener("change", (event) => setLook(event.target.value));
$("#edit-selected").addEventListener("click", () => {
  dialog.close();
  if (!liveAlbum) return tell("先新建或打开本地相册，再编辑照片说明。");
  window.dispatchEvent(new CustomEvent("film-edit-selected", { detail: photos[currentIndex].id }));
});
$("#nav-photos").addEventListener("click", () => { $("#workspace-panel").hidden = true; $("#toggle-editor span").textContent = "相册管理"; $("#filmstrip-viewport").focus(); });
$(".brand").addEventListener("click", (event) => { event.preventDefault(); $("#workspace-panel").hidden = true; $("#toggle-editor span").textContent = "相册管理"; });
$("#strip-previous").addEventListener("click", () => $("#filmstrip-viewport").scrollBy({ left: -330, behavior: reducedMotion ? "instant" : "smooth" }));
$("#strip-next").addEventListener("click", () => $("#filmstrip-viewport").scrollBy({ left: 330, behavior: reducedMotion ? "instant" : "smooth" }));
$("#filmstrip-viewport").setAttribute("tabindex", "0");
document.addEventListener("keydown", (event) => {
  if (event.target.closest("input,textarea,select") || $("#new-dialog").open) return;
  if (event.key === "Escape" && focusMode && !dialog.open && $("#workspace-panel").hidden) { event.preventDefault(); leaveFocus(); }
  if (event.key === "ArrowRight") { event.preventDefault(); navigate(1); }
  if (event.key === "ArrowLeft") { event.preventDefault(); navigate(-1); }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) stopPlaying(); });
$("#camera-scene").addEventListener("pointermove", (event) => {
  if (reducedMotion || event.pointerType === "touch" || $("#camera-stage").classList.contains("is-winding")) return;
  if (focusMode && !event.target.closest("#camera-stage")) return;
  const bounds = $(focusMode ? "#camera-stage" : "#camera-scene").getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width - .5;
  const y = (event.clientY - bounds.top) / bounds.height - .5;
  $("#camera-stage").style.setProperty("--tilt-x", String(-y * 4) + "deg");
  $("#camera-stage").style.setProperty("--tilt-y", String(x * 6) + "deg");
});
$("#camera-scene").addEventListener("pointerleave", () => {
  $("#camera-stage").style.setProperty("--tilt-x", "0deg");
  $("#camera-stage").style.setProperty("--tilt-y", "0deg");
});
window.addEventListener("pagehide", () => crank.dispose(), { once: true });
renderStrip();
setLook("original", false);
selectedPromise = selectPhoto(0, false, true);

