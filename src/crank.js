import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Design coordinates register directly with the unmodified 1086 × 1448 camera.
// The spindle is a side-facing axis. The lever rotates in its perpendicular
// plane, rather than rotating the camera photograph around the screen normal.
const WIDTH = 1086;
const HEIGHT = 1448;
const TAU = Math.PI * 2;
const DURATION = 1020;
const PIVOT_PIXEL = [947, 847];
const PIVOT = new THREE.Vector3(PIVOT_PIXEL[0] - WIDTH / 2, HEIGHT / 2 - PIVOT_PIXEL[1], 70);
const AXIS = new THREE.Vector3(0.925, 0, 0.38).normalize();
const SIDE = new THREE.Vector3(AXIS.z, 0, -AXIS.x);
const UP = new THREE.Vector3(0, 1, 0);
const REST = SIDE.clone().multiplyScalar(98).addScaledVector(UP, 197);
const LENGTH = REST.length();
const HANDLE_LENGTH = 48;
const GRIP_RADIUS = 28;

const pixel = (v) => [v.x + WIDTH / 2, HEIGHT / 2 - v.y];
const radialAt = (angle) => REST.clone().applyAxisAngle(AXIS, -angle);
const smoothProgress = (t) => {
  // A long nearly uniform middle, with physical acceleration and deceleration.
  const ramp = 0.16;
  const speed = 1 / (1 - ramp);
  if (t < ramp) return speed * t * t / (2 * ramp);
  if (t > 1 - ramp) return 1 - speed * (1 - t) * (1 - t) / (2 * ramp);
  return speed * (t - ramp / 2);
};

export function createCrank(host, { reducedMotion = false } = {}) {
  if (!host) throw new Error("Missing camera crank host");
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-WIDTH / 2, WIDTH / 2, HEIGHT / 2, -HEIGHT / 2, 1, 2400);
  camera.position.set(0, 0, 1200);
  camera.lookAt(0, 0, 0);
  const moving = new THREE.Group();
  moving.position.copy(PIVOT);
  scene.add(moving);
  let angle = 0;
  let winding = false;
  let disposed = false;
  let frame = 0;
  let activePromise = null;
  let settle = null;
  let samples = [];
  let lastSamples = [];
  let renderer = null;
  let backend = "webgl";
  let environment = null;
  let generator = null;
  let maskImage = null;
  let maskTexture = null;
  let context = null;
  const canvas = document.createElement("canvas");
  canvas.className = "camera-crank-canvas";
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "display:block;width:100%;height:100%;pointer-events:none;";
  host.replaceChildren(canvas);

  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    generator = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    environment = generator.fromScene(room, 0.045);
    room.dispose();
    scene.environment = environment.texture;
  } catch (error) {
    // Canvas2D uses the same rigid 3D coordinates and orthographic projection.
    // This keeps the interaction available on machines without WebGL.
    backend = "canvas2d";
    const replacement = canvas.cloneNode(false);
    canvas.replaceWith(replacement);
    context = replacement.getContext("2d");
    renderer?.dispose();
    renderer = null;
  }

  const targetCanvas = renderer ? canvas : host.querySelector("canvas");
  const silver = new THREE.MeshPhysicalMaterial({
    color: 0x9c988d, metalness: 0.96, roughness: 0.28, envMapIntensity: 0.8,
    clearcoat: 0.55, clearcoatRoughness: 0.2,
  });
  const edgeSilver = new THREE.MeshStandardMaterial({ color: 0xcac5b9, metalness: 0.96, roughness: 0.24, envMapIntensity: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d1e1a, metalness: 0.68, roughness: 0.42 });
  const knurl = new THREE.MeshStandardMaterial({ color: 0x575950, metalness: 0.82, roughness: 0.37, envMapIntensity: 0.8 });
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xfff2df, 1.7);
  key.position.set(-450, 620, 700);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xceddea, 1.4);
  rim.position.set(650, -180, 450);
  scene.add(rim);

  const cylinderRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), AXIS);
  function cylinder(radius, length, material, position, parent = scene, segments = 48) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material);
    mesh.quaternion.copy(cylinderRotation);
    mesh.position.copy(position);
    parent.add(mesh);
    return mesh;
  }

  // This axle and its concentric bearing caps never rotate with the arm.
  cylinder(33, 17, dark, PIVOT.clone().addScaledVector(AXIS, -9));
  cylinder(29, 17, silver, PIVOT.clone());
  cylinder(20, 5, edgeSilver, PIVOT.clone().addScaledVector(AXIS, 11));

  const direction = REST.clone().normalize();
  const across = direction.clone().cross(AXIS).normalize();
  const basis = new THREE.Matrix4().makeBasis(across, direction, AXIS);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(40, LENGTH, 17), silver);
  bar.quaternion.setFromRotationMatrix(basis);
  bar.position.copy(REST).multiplyScalar(0.5);
  moving.add(bar);
  // Chamfer-like narrow highlights preserve the solid lever's thickness.
  for (const sign of [-1, 1]) {
    const highlight = new THREE.Mesh(new THREE.BoxGeometry(2.5, LENGTH - 20, 3), edgeSilver);
    highlight.quaternion.copy(bar.quaternion);
    highlight.position.copy(bar.position).addScaledVector(across, sign * 19).addScaledVector(AXIS, 9.5);
    moving.add(highlight);
  }
  cylinder(25, 16, silver, new THREE.Vector3(), moving);
  cylinder(16, 16, silver, REST, moving);
  const grip = new THREE.Group();
  grip.position.copy(REST);
  moving.add(grip);
  // The grip cylinder's axis stays parallel to the side spindle. Its surface
  // counter-rotates relative to the arm, like a free-spinning hand grip.
  const gripMiddle = AXIS.clone().multiplyScalar(HANDLE_LENGTH / 2 + 10);
  cylinder(GRIP_RADIUS, HANDLE_LENGTH, dark, gripMiddle, grip);
  cylinder(GRIP_RADIUS + 1.6, 5, edgeSilver, AXIS.clone().multiplyScalar(12), grip);
  cylinder(GRIP_RADIUS + 1.6, 5, edgeSilver, AXIS.clone().multiplyScalar(HANDLE_LENGTH + 8), grip);
  for (let i = 0; i < 13; i++) {
    cylinder(GRIP_RADIUS + 0.8, 1.2, knurl, AXIS.clone().multiplyScalar(15 + i * 3.1), grip, 48);
  }
  // Longitudinal ridges make the grip cylindrical in all projected views.
  for (let i = 0; i < 32; i++) {
    const phase = i / 32 * TAU;
    const offset = SIDE.clone().multiplyScalar(Math.cos(phase) * GRIP_RADIUS)
      .addScaledVector(UP, Math.sin(phase) * GRIP_RADIUS);
    const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, HANDLE_LENGTH - 8, 6), knurl);
    ridge.quaternion.copy(cylinderRotation);
    ridge.position.copy(gripMiddle).add(offset);
    grip.add(ridge);
  }

  if (renderer) {
    const maskUrl = import.meta.env.BASE_URL + "film/camera-body.png";
    new THREE.TextureLoader().load(maskUrl, (texture) => {
      if (disposed) { texture.dispose(); return; }
      maskTexture = texture;
      const occluder = new THREE.Mesh(
        new THREE.PlaneGeometry(WIDTH, HEIGHT),
        new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, colorWrite: false, depthWrite: true, side: THREE.DoubleSide }),
      );
      // The cutout writes only depth: a rearward arm segment can disappear
      // behind the fixed camera silhouette, while protruding portions remain.
      occluder.position.z = 78;
      occluder.renderOrder = -1;
      scene.add(occluder);
      render();
    }, undefined, () => {});
  } else {
    maskImage = new Image();
    maskImage.onload = () => render();
    maskImage.src = import.meta.env.BASE_URL + "film/camera-body.png";
  }

  function modelState() {
    const radial = radialAt(angle);
    const tip = PIVOT.clone().add(radial);
    const gripCenter = tip.clone().addScaledVector(AXIS, HANDLE_LENGTH / 2 + 10);
    return {
      backend, winding, angle, signedAngle: -angle, duration: DURATION,
      designSize: [WIDTH, HEIGHT], pivot: [...PIVOT_PIXEL], pivotWorld: PIVOT.toArray(),
      axis: AXIS.toArray(), rigidLength: LENGTH, tip: pixel(tip), tipWorld: tip.toArray(),
      gripCenter: pixel(gripCenter), gripAxis: AXIS.toArray(), gripRelativeSpin: angle,
      stroke: "one-revolution-forward", cycleSamples: (winding ? samples : lastSamples).map((sample) => ({ ...sample, tip: [...sample.tip], tipWorld: [...sample.tipWorld] })),
    };
  }

  function sample(now) {
    const state = modelState();
    samples.push({ time: now, angle, tip: state.tip, tipWorld: state.tipWorld, length: LENGTH });
  }

  function renderFallback() {
    if (!context || !targetCanvas.width) return;
    context.setTransform(targetCanvas.width / WIDTH, 0, 0, targetCanvas.height / HEIGHT, 0, 0);
    context.clearRect(0, 0, WIDTH, HEIGHT);
    const r = radialAt(angle);
    const tip = PIVOT.clone().add(r);
    const tangent = r.clone().normalize().cross(AXIS);
    const chunks = [];
    for (let i = 0; i < 32; i++) {
      const a = PIVOT.clone().addScaledVector(r, i / 32);
      const b = PIVOT.clone().addScaledVector(r, (i + 1) / 32);
      const polygon = [a.clone().addScaledVector(tangent, 15), b.clone().addScaledVector(tangent, 15),
        b.clone().addScaledVector(tangent, -15), a.clone().addScaledVector(tangent, -15)].map(pixel);
      chunks.push({ polygon, behind: (a.z + b.z) / 2 < 78 });
    }
    function drawRod(behind) {
      chunks.filter((part) => part.behind === behind).forEach(({ polygon }) => {
        const gradient = context.createLinearGradient(polygon[0][0], polygon[0][1], polygon[3][0], polygon[3][1]);
        gradient.addColorStop(0, "#f3efe4"); gradient.addColorStop(0.34, "#afa99e"); gradient.addColorStop(0.68, "#f0e9dc"); gradient.addColorStop(1, "#5d5c55");
        context.beginPath(); context.moveTo(...polygon[0]); polygon.slice(1).forEach((point) => context.lineTo(...point)); context.closePath();
        context.fillStyle = gradient; context.fill(); context.strokeStyle = "#ddd7cc"; context.lineWidth = 1; context.stroke();
      });
    }
    function drawCylinder(center, radius, length) {
      const first = pixel(center.clone().addScaledVector(AXIS, -length / 2));
      const last = pixel(center.clone().addScaledVector(AXIS, length / 2));
      const gradient = context.createLinearGradient(0, first[1] - radius, 0, first[1] + radius);
      gradient.addColorStop(0, "#e8e0d3"); gradient.addColorStop(.2, "#9d988f"); gradient.addColorStop(.5, "#ded8cc"); gradient.addColorStop(1, "#3e3e38");
      context.fillStyle = gradient; context.beginPath();
      context.rect(first[0], first[1] - radius, last[0] - first[0], radius * 2); context.fill();
      for (const point of [first, last]) {
        context.beginPath(); context.ellipse(point[0], point[1], radius * Math.abs(AXIS.z), radius, 0, 0, TAU);
        context.fill(); context.strokeStyle = "#ddd6cb"; context.lineWidth = 1.2; context.stroke();
      }
      context.strokeStyle = "#403f38"; context.lineWidth = 1.1;
      for (let i = 0; i < 12; i++) {
        const x = first[0] + (last[0] - first[0]) * i / 12;
        context.beginPath(); context.ellipse(x, first[1], radius * Math.abs(AXIS.z), radius - 1, 0, 0, TAU); context.stroke();
      }
    }
    drawRod(true);
    const gripCenter = tip.clone().addScaledVector(AXIS, HANDLE_LENGTH / 2 + 10);
    if (gripCenter.z < 78) drawCylinder(gripCenter, GRIP_RADIUS, HANDLE_LENGTH);
    if (maskImage?.complete && maskImage.naturalWidth) {
      context.globalCompositeOperation = "destination-out";
      context.drawImage(maskImage, 0, 0, WIDTH, HEIGHT);
      context.globalCompositeOperation = "source-over";
    }
    drawRod(false);
    if (gripCenter.z >= 78) drawCylinder(gripCenter, GRIP_RADIUS, HANDLE_LENGTH);
    drawCylinder(PIVOT.clone().addScaledVector(AXIS, 2), 25, 20);
  }

  function render() {
    if (disposed) return;
    moving.quaternion.setFromAxisAngle(AXIS, -angle);
    grip.quaternion.setFromAxisAngle(AXIS, angle);
    if (renderer) renderer.render(scene, camera);
    else renderFallback();
    host.dataset.crankRenderer = backend;
    host.dataset.crankAngle = angle.toFixed(5);
  }

  function resize() {
    if (disposed) return;
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (renderer) renderer.setSize(rect.width, rect.height, false);
    else { targetCanvas.width = Math.round(rect.width * ratio); targetCanvas.height = Math.round(rect.height * ratio); }
    render();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  function finish(cancelled = false) {
    cancelAnimationFrame(frame);
    frame = 0;
    winding = false;
    if (!cancelled) angle = TAU;
    else angle = 0;
    render();
    lastSamples = samples;
    const resolve = settle;
    settle = null;
    activePromise = null;
    resolve?.({ completed: !cancelled, cancelled });
  }

  function wind() {
    if (disposed) return Promise.resolve({ completed: false, cancelled: true });
    if (winding) return activePromise;
    winding = true;
    angle = 0;
    samples = [];
    const started = performance.now();
    sample(0);
    activePromise = new Promise((resolve) => { settle = resolve; });
    render();
    if (reducedMotion) {
      angle = TAU;
      sample(DURATION);
      const pending = activePromise;
      finish();
      return pending;
    }
    function tick(now) {
      if (!winding || disposed) return;
      const elapsed = Math.min(DURATION, now - started);
      angle = smoothProgress(elapsed / DURATION) * TAU;
      sample(elapsed);
      render();
      if (elapsed < DURATION) frame = requestAnimationFrame(tick);
      else finish();
    }
    frame = requestAnimationFrame(tick);
    return activePromise;
  }

  function cancel() {
    if (winding) finish(true);
    else { angle = 0; render(); }
  }

  function dispose() {
    if (disposed) return;
    cancel();
    disposed = true;
    observer.disconnect();
    scene.traverse((node) => {
      node.geometry?.dispose();
      if (Array.isArray(node.material)) node.material.forEach((material) => material.dispose());
      else node.material?.dispose();
    });
    maskTexture?.dispose();
    environment?.dispose();
    generator?.dispose();
    renderer?.dispose();
    targetCanvas.remove();
  }

  return { wind, cancel, dispose, getState: modelState };
}


