import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDirectory = appDirectory;
const root = path.join(projectDirectory, '.test-data', 'camera-smoke-' + Date.now());
const artifacts = path.join(projectDirectory, 'test-output', 'camera');
const reportPath = path.join(artifacts, 'test-report.json');
const sourceA = path.join(root, '测试照片 A.png');
const sourceB = path.join(root, '测试照片 B.png');
const title = '胶片相机 测试相册';
const albumDirectory = path.join(root, title);
const relocatedDirectory = path.join(root, '迁移后的相册');
const manifestName = 'photobook.json';
const report = {
  status: 'running',
  startedAt: new Date().toISOString(),
  isolatedRoot: root,
  application: process.env.PHOTOBOOK_EXE || electronPath,
  checks: [],
  screenshots: [],
  runtimeErrors: [],

};
let application = null;
let page = null;
let currentCheck = '';
const sourceHashes = new Map();
let mechanicsDiagnostics = null;

function withinTestRoot(target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    '拒绝修改隔离测试目录以外的路径：' + resolvedTarget);
  return resolvedTarget;
}
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
async function manifest(directory = albumDirectory) {
  return JSON.parse(await fs.readFile(path.join(directory, manifestName), 'utf8'));
}
async function check(name, action) {
  currentCheck = name;
  const started = Date.now();
  const detail = await action();
  report.checks.push({ name, status: 'passed', milliseconds: Date.now() - started, ...(detail ? { detail } : {}) });
}
async function ready() {
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 30000 });
}
async function photoCount(count) {
  await page.waitForFunction((expected) => Number(document.documentElement.dataset.photoCount) === expected, count, { timeout: 30000 });
}
async function selected(id) {
  await page.waitForFunction((expected) => document.documentElement.dataset.currentPhotoId === expected && document.documentElement.dataset.displayedPhotoId === expected, id, { timeout: 15000 });
}
async function imageReady(selector) {
  await page.waitForFunction((target) => {
    const image = document.querySelector(target);
    return image?.complete && image.naturalWidth > 0;
  }, selector, { timeout: 30000 });
}
async function ensurePanel() {
  if (await page.locator('#workspace-panel').evaluate((element) => element.hidden)) await page.click('#toggle-editor');
  await page.waitForFunction(() => !document.querySelector('#workspace-panel').hidden);
}
async function saveNow() {
  await ensurePanel();
  await page.click('#save-book');
  await page.waitForFunction(() => !document.querySelector('#save-book').disabled, null, { timeout: 30000 });
}
async function resizeWindow(width, height) {
  await application.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
  }, { width, height });
  await page.waitForFunction((size) => window.innerWidth === size.width && window.innerHeight === size.height,
    { width, height }, { timeout: 15000 });
}
async function crankSequence() {
  return page.evaluate(() => Number(document.documentElement.dataset.windSequence || 0));
}
async function windingDone(id) {
  await selected(id);
  await page.waitForFunction(() => document.documentElement.dataset.crankState === 'idle', null, { timeout: 15000 });
}
async function audioProbe() {
  return page.evaluate(() => ({
    probe: structuredClone(window.__cameraInteractionProbe),
    audio: { source: document.querySelector('#wind-audio').currentSrc, duration: document.querySelector('#wind-audio').duration,
      muted: document.querySelector('#wind-audio').muted, volume: document.querySelector('#wind-audio').volume },
  }));
}
async function focusReady() {
  await page.waitForFunction(() => {
    const shell = document.querySelector('.app-shell');
    const camera = document.querySelector('.camera-figure');
    const panel = document.querySelector('#photo-panel');
    if (!shell?.classList.contains('is-photo-focus') || !camera || !panel) return false;
    const image = document.querySelector('#focus-photo');
    const cameraBox = camera.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const width = shell.getBoundingClientRect().width;
    return image?.complete && image.naturalWidth > 0 && panelBox.width > width * 0.55
      && cameraBox.left + cameraBox.width / 2 < width * 0.25
      && Number(getComputedStyle(panel).opacity) > 0.95
      && !camera.getAnimations().some((animation) => animation.playState === 'running')
      && !panel.getAnimations().some((animation) => animation.playState === 'running');
  }, null, { timeout: 15000 });
}
async function focusGeometry() {
  return page.evaluate(() => {
    const shell = document.querySelector('.app-shell').getBoundingClientRect();
    const camera = document.querySelector('.camera-figure').getBoundingClientRect();
    const panel = document.querySelector('#photo-panel').getBoundingClientRect();
    const image = document.querySelector('#focus-photo');
    const imageBox = image.getBoundingClientRect();
    const frame = (image.closest('.focus-photo-wrap') || image.parentElement).getBoundingClientRect();
    const style = getComputedStyle(image);
    const transform = style.transform === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(style.transform);
    const scale = Math.min(image.clientWidth / image.naturalWidth, image.clientHeight / image.naturalHeight);
    const contentWidth = image.naturalWidth * scale;
    const contentHeight = image.naturalHeight * scale;
    const projectedWidth = Math.abs(contentWidth * transform.a) + Math.abs(contentHeight * transform.c);
    const projectedHeight = Math.abs(contentWidth * transform.b) + Math.abs(contentHeight * transform.d);
    const centerX = (imageBox.left + imageBox.right) / 2;
    const centerY = (imageBox.top + imageBox.bottom) / 2;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      camera: { left: camera.left, right: camera.right, width: camera.width, centerRatio: ((camera.left + camera.right) / 2 - shell.left) / shell.width },
      panel: { left: panel.left, right: panel.right, width: panel.width, leftRatio: (panel.left - shell.left) / shell.width, widthRatio: panel.width / shell.width },
      image: { source: image.currentSrc, objectFit: style.objectFit, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, rotation: Math.atan2(transform.b, transform.a) * 180 / Math.PI },
      paintedBounds: { left: centerX - projectedWidth / 2, right: centerX + projectedWidth / 2, top: centerY - projectedHeight / 2, bottom: centerY + projectedHeight / 2 },
      frame: { left: frame.left, right: frame.right, top: frame.top, bottom: frame.bottom },
      caption: document.querySelector('#focus-caption').textContent,
      counter: document.querySelector('#focus-counter').textContent,
      documentOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}
function assertFocusGeometry(geometry) {
  assert(geometry.camera.centerRatio > 0 && geometry.camera.centerRatio < 0.25, '相机应处于左侧约四分之一区域');
  assert(geometry.panel.leftRatio >= 0.20 && geometry.panel.leftRatio <= 0.36, '照片区应从约四分之一位置开始');
  assert(geometry.panel.widthRatio >= 0.60 && geometry.panel.widthRatio <= 0.82, '右侧照片区应占约四分之三宽度');
  assert(geometry.camera.right <= geometry.panel.left + 12, '相机不应遮住右侧照片');
  assert.equal(geometry.image.objectFit, 'contain', '照片应完整适配，不裁切填满');
  assert(geometry.paintedBounds.left >= geometry.frame.left - 3
    && geometry.paintedBounds.right <= geometry.frame.right + 3
    && geometry.paintedBounds.top >= geometry.frame.top - 3
    && geometry.paintedBounds.bottom <= geometry.frame.bottom + 3, '旋转后的完整照片也应落在显示区域内');
  assert.equal(geometry.documentOverflows, false, '分区模式不能横向溢出');
}
async function leaveFocus() {
  if (await page.locator('.app-shell').evaluate((element) => element.classList.contains('is-photo-focus'))) {
    await page.click('#back-to-camera');
  }
  await page.waitForFunction(() => !document.querySelector('.app-shell').classList.contains('is-photo-focus')
    && !document.querySelector('.camera-figure').getAnimations().some((animation) => animation.playState === 'running'));
}

async function screenshot(name, width, height) {
  await resizeWindow(width, height);
  const destination = path.join(artifacts, name);
  await page.screenshot({ path: destination, scale: 'css' });
  report.screenshots.push({ path: destination, width, height });
}
async function launch() {
  const environment = {
    ...process.env,
    PHOTOBOOK_SMOKE_ROOT: root,
    PHOTOBOOK_SMOKE_IMAGE: sourceA,
    PHOTOBOOK_SMOKE_COUNT: '2',
    PHOTOBOOK_SMOKE_IMAGES: JSON.stringify([sourceA, sourceB]),
    PHOTOBOOK_SMOKE_OPEN_DIR: relocatedDirectory,
    PHOTOBOOK_SMOKE_SKIP_DEFAULT: '1',
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.PHOTOBOOK_EXE || electronPath,
    args: process.env.PHOTOBOOK_EXE ? [] : ['.'],
    cwd: appDirectory,
    env: environment,
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => report.runtimeErrors.push({ type: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') report.runtimeErrors.push({ type: 'console', message: message.text() });
  });
  page.on('request', (request) => {
    if (/^https?:/i.test(request.url())) report.runtimeErrors.push({ type: 'network', message: request.url() });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await ready();
}
async function closeApplication() {
  if (!application) return;
  const closing = application;
  application = null;
  await closing.close();
}

await fs.mkdir(root, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
try {
  await launch();
  await check('首次启动为空相册且页面离线', async () => {
    assert(await page.locator('#workspace-panel').evaluate((element) => element.hidden), '启动时相册管理面板应隐藏');
    await photoCount(0);
    for (const selector of ['#camera-stage', '#previous-photo', '#next-photo', '#view-photo', '#slideshow']) {
      assert.equal(await page.locator(selector).isDisabled(), true, '空相册的浏览操作应禁用：' + selector);
    }
    const initialData = await page.evaluate(async () => ({
      defaultAlbum: await window.photobookApi.defaultAlbum(),
      recent: await window.photobookApi.recent(),
      currentPhotoId: document.documentElement.dataset.currentPhotoId,
    }));
    assert.equal(initialData.defaultAlbum, null, '发布版不能内置默认用户相册');
    assert.deepEqual(initialData.recent, [], '独立测试资料目录应没有最近相册');
    assert.equal(initialData.currentPhotoId || '', '');
    assert.equal(await page.locator('#recent-list button').count(), 0);
    assert.equal(await page.locator('#filmstrip button[data-photo-id]').count(), 0);
    return { photoCount: 0, defaultAlbum: null, recentCount: 0 };
  });
  await check('准备两个不同的隔离测试原图', async () => {
    const images = await page.evaluate(() => ['A', 'B'].map((label, index) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 800;
      const context = canvas.getContext('2d');
      const gradient = context.createLinearGradient(0, 0, 1200, 800);
      gradient.addColorStop(0, index ? '#286567' : '#bd8354');
      gradient.addColorStop(1, index ? '#a6c6ad' : '#efd0a5');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 1200, 800);
      context.fillStyle = '#fcf1d7';
      context.fillRect(index ? 650 : 150, 150, 300, 440);
      context.fillStyle = '#273a38';
      context.font = 'bold 150px sans-serif';
      context.fillText(label, 520, 480);
      return canvas.toDataURL('image/png').split(',')[1];
    }));
    await fs.writeFile(withinTestRoot(sourceA), Buffer.from(images[0], 'base64'));
    await fs.writeFile(withinTestRoot(sourceB), Buffer.from(images[1], 'base64'));
    sourceHashes.set(sourceA, sha256(await fs.readFile(sourceA)));
    sourceHashes.set(sourceB, sha256(await fs.readFile(sourceB)));
    assert.notEqual(sourceHashes.get(sourceA), sourceHashes.get(sourceB));
  });
  await check('新建空相册', async () => {
    await ensurePanel();
    await page.click('#new-book');
    await page.fill('#new-title', title);
    await page.click('#choose-directory');
    await page.click('#create-book');
    await page.waitForFunction(() => !document.querySelector('#new-dialog').open
      && !document.querySelector('#create-book').disabled, null, { timeout: 30000 });
    await photoCount(0);
    const data = await manifest();
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.photos.length, 0);
    assert.equal(data.pages.length, 0);
    assert.deepEqual(data.renderedPages, []);
  });
  let firstId;
  let secondId;
  let copiedFiles;
  await check('导入两个原图并保存缩略图', async () => {
    await page.click('#import-photos');
    await photoCount(2);
    await page.waitForFunction(() => !document.querySelector('#import-photos').disabled, null, { timeout: 30000 });
    const data = await manifest();
    assert.equal(data.photos.length, 2);
    assert.equal(data.photoOrder.length, 2);
    assert.deepEqual(data.photos.map((photo) => photo.name).sort(), [path.basename(sourceA), path.basename(sourceB)].sort(),
      '后端需支持 PHOTOBOOK_SMOKE_IMAGES，以导入两个不同测试文件');
    firstId = data.photoOrder[0];
    secondId = data.photoOrder[1];
    copiedFiles = data.photos.map((photo) => path.join(albumDirectory, 'photos', photo.file));
    for (const photo of data.photos) {
      const source = photo.name === path.basename(sourceA) ? sourceA : sourceB;
      assert.equal(sha256(await fs.readFile(path.join(albumDirectory, 'photos', photo.file))), sourceHashes.get(source));
      assert(photo.thumbnail);
      assert((await fs.stat(path.join(albumDirectory, 'thumbnails', photo.thumbnail))).size > 200);
    }
    assert.equal((await fs.readdir(path.join(albumDirectory, 'pages'))).length, 0, '相册浏览器不应生成旧书页');
    await imageReady('#viewfinder-photo');
  });
  await check('胶片导航切换真实照片', async () => {
    if (!await page.locator('#workspace-panel').evaluate((element) => element.hidden)) await page.click('#close-panel');
    await selected(firstId);
    const firstSource = await page.locator('#viewfinder-photo').getAttribute('src');
    await page.click('#next-photo');
    await selected(secondId);
    await imageReady('#viewfinder-photo');
    assert.notEqual(await page.locator('#viewfinder-photo').getAttribute('src'), firstSource);
    await page.click('#previous-photo');
    await selected(firstId);
    await page.locator('#filmstrip button[data-photo-id="' + secondId + '"]').click();
    await selected(secondId);
    await page.locator('#filmstrip button[data-photo-id="' + firstId + '"]').click();
    await selected(firstId);
    assert((await page.locator('#photo-counter').textContent()).includes('2'));
  });
  await check('自动播放切图后仍保持播放状态', async () => {
    await selected(firstId);
    await page.click('#slideshow');
    await page.waitForFunction(() => document.querySelector('#slideshow-label').textContent === '暂停播放');
    await selected(secondId);
    assert.equal(await page.locator('#slideshow-label').textContent(), '暂停播放');
    await page.click('#slideshow');
    await page.waitForFunction(() => document.querySelector('#slideshow-label').textContent === '自动播放');
    await page.click('#previous-photo');
    await selected(firstId);
  });
  await check('色调、说明、旋转与顺序持久保存', async () => {
    await page.selectOption('#film-look', 'warm');
    await ensurePanel();
    await page.locator('#page-list .page-card').first().locator('input[aria-label="照片说明"]').fill('胶片相机的新界面测试');
    await page.locator('#page-list .page-card').first().locator('input[aria-label="照片说明"]').press('Tab');
    await page.locator('#page-list .page-card').first().locator('button[aria-label="照片旋转 90°"]').click();
    await page.locator('#page-list .page-card').nth(1).locator('button[aria-label="上移照片"]').click();
    await saveNow();
    const data = await manifest();
    assert.equal(data.filmLook, 'warm');
    assert.equal(data.photoEdits[firstId].caption, '胶片相机的新界面测试');
    assert.equal(data.photoEdits[firstId].rotation, 1);
    assert.deepEqual(data.photoOrder, [secondId, firstId]);
    assert.equal(data.selectedPhotoId, firstId);
  });
  await check('相机卷片推进、末张循环与真实音频播放', async () => {
    if (!await page.locator('#workspace-panel').evaluate((element) => element.hidden)) await page.click('#close-panel');
    await resizeWindow(1440, 900);
    await selected(firstId);
    await page.evaluate(() => {
      const audio = document.querySelector('#wind-audio');
      if (!audio) throw new Error('缺少本地卷片声音元素 #wind-audio');
      const probe = window.__cameraInteractionProbe = { playRequests: 0, playResolutions: 0, playingEvents: 0, failures: [] };
      const nativePlay = audio.play.bind(audio);
      audio.play = (...args) => {
        probe.playRequests += 1;
        const request = nativePlay(...args);
        request?.then(() => probe.playResolutions += 1).catch((error) => probe.failures.push(error.message));
        return request;
      };
      audio.addEventListener('playing', () => probe.playingEvents += 1);
    });
    const initialSequence = await crankSequence();
    const initialMechanics = await page.evaluate(() => window.__cameraCrankDiagnostic());
    await page.click('#slideshow');
    await page.waitForFunction(() => document.querySelector('#slideshow-label').textContent === '暂停播放');
    await page.click('#camera-stage');
    await windingDone(secondId);
    await focusReady();
    assert.equal(await crankSequence(), initialSequence + 1, '单次卷片只应接受一次动作');
    assert.equal(await page.locator('#slideshow-label').textContent(), '自动播放', '卷片点击应停止自动播放');
    assert.equal(await page.locator('#photo-dialog').evaluate((element) => element.open), false, '相机点击应进入分区，不直接弹出大图');
    assert.equal(await page.locator('#focus-photo').getAttribute('src'), await page.locator('#viewfinder-photo').getAttribute('src'));
    assert.equal(await page.locator('#focus-counter').textContent(), '01 / 02', '末张卷片应循环到第一张');
    await page.click('#camera-stage');
    await windingDone(firstId);
    assert.equal(await crankSequence(), initialSequence + 2, '完成后再次卷片应接受一次动作');
    mechanicsDiagnostics = { initial: initialMechanics, completed: await page.evaluate(() => window.__cameraCrankDiagnostic()) };
    assert.equal(await page.locator('#focus-counter').textContent(), '02 / 02', '再次卷片应进入下一张');
    await page.waitForFunction(() => window.__cameraInteractionProbe.playResolutions === 2
      && window.__cameraInteractionProbe.playingEvents === 2, null, { timeout: 15000 });
    const details = await audioProbe();
    assert.equal(details.probe.playRequests, 2);
    assert.deepEqual(details.probe.failures, []);
    assert(details.audio.source.endsWith('/film/wind.wav'));
    assert(details.audio.duration > 0 && details.audio.duration < 5);
    assert.equal(details.audio.muted, false);
    assert(details.audio.volume > 0);
    assert.equal(await page.locator('#sound-toggle').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    await leaveFocus();
    return { ...details, initialSequence, finalSequence: await crankSequence(), order: [secondId, firstId] };
  });
  await check('真实侧轴3D卷片的固定轴心与窄椭圆投影', async () => {
    const { initial, completed: state } = mechanicsDiagnostics;
    const canvas = await page.locator('#camera-crank').evaluate((host) => {
      const element = host.querySelector('canvas');
      return { count: host.querySelectorAll('canvas').length, bitmapCount: host.querySelectorAll('img').length,
        width: element?.width || 0, height: element?.height || 0, renderer: host.dataset.crankRenderer };
    });
    assert.equal(canvas.count, 1, '机械杆应由 canvas 绘制');
    assert.equal(canvas.bitmapCount, 0, '不能沿用平面 PNG 摇杆旋转');
    assert(canvas.width > 0 && canvas.height > 0);
    assert(['webgl', 'canvas2d'].includes(state.backend));
    assert.equal(canvas.renderer, state.backend);
    assert.deepEqual(state.pivot, initial.pivot, '运动前后固定轴心应一致');
    assert.deepEqual(state.pivotWorld, initial.pivotWorld);
    assert(Math.abs(state.axis[0]) > 0.85 && Math.abs(state.axis[1]) < 0.001 && Math.abs(state.axis[2]) > 0.15,
      '轴必须朝相机侧面，不能朝屏幕法线');
    assert.equal(state.winding, false);
    assert.equal(state.stroke, 'one-revolution-forward');
    assert(state.duration >= 900 && state.duration <= 1300);
    assert(state.cycleSamples.length >= 8, '整圈动作应包含连续实际渲染采样');
    const samples = state.cycleSamples;
    const xs = samples.map((sample) => sample.tip[0]);
    const ys = samples.map((sample) => sample.tip[1]);
    const zs = samples.map((sample) => sample.tipWorld[2]);
    const angles = samples.map((sample) => sample.angle);
    const projectedWidth = Math.max(...xs) - Math.min(...xs);
    const projectedHeight = Math.max(...ys) - Math.min(...ys);
    const ratio = projectedWidth / projectedHeight;
    const depthRange = Math.max(...zs) - Math.min(...zs);
    const angleSpan = Math.max(...angles) - Math.min(...angles);
    assert(projectedHeight > state.rigidLength * 1.8);
    assert(ratio > 0.15 && ratio < 0.60, '侧轴旋转应投影为窄椭圆，而不是平面圆周');
    assert(depthRange > state.rigidLength, '杆端应实际向前后运动，不能只有屏幕平面坐标变化');
    assert(Math.abs(angleSpan - Math.PI * 2) < 0.001, '每次动作应完成一整圈');
    assert(Math.hypot(samples[0].tip[0] - samples.at(-1).tip[0], samples[0].tip[1] - samples.at(-1).tip[1]) < 0.001,
      '完整卷片后应回到静止位置');
    let maxLengthError = 0;
    let maxPlaneError = 0;
    let maxProjectionError = 0;
    for (const sample of samples) {
      const radial = sample.tipWorld.map((value, index) => value - state.pivotWorld[index]);
      const lengthError = Math.abs(Math.hypot(...radial) - state.rigidLength);
      const planeError = Math.abs(radial.reduce((sum, value, index) => sum + value * state.axis[index], 0));
      const projectionError = Math.max(Math.abs(sample.tip[0] - (sample.tipWorld[0] + state.designSize[0] / 2)),
        Math.abs(sample.tip[1] - (state.designSize[1] / 2 - sample.tipWorld[1])));
      maxLengthError = Math.max(maxLengthError, lengthError);
      maxPlaneError = Math.max(maxPlaneError, planeError);
      maxProjectionError = Math.max(maxProjectionError, projectionError);
    }
    assert(maxLengthError < 0.001, '杆长与固定轴心距离在全过程必须保持');
    assert(maxPlaneError < 0.001, '轨迹必须位于侧轴的垂直平面内');
    assert(maxProjectionError < 0.001, '诊断投影应来自真实三维杆端坐标');
    return { canvas, backend: state.backend, axis: state.axis, pivot: state.pivot, rigidLength: state.rigidLength,
      duration: state.duration, sampleCount: samples.length, angleSpan, projectedWidth, projectedHeight, ratio,
      depthRange, maxLengthError, maxPlaneError, maxProjectionError };
  });
  await check('卷片期间快速连续点击防重入', async () => {
    await selected(firstId);
    const initialSequence = await crankSequence();
    const initialAudio = await audioProbe();
    await page.click('#camera-stage');
    await page.waitForFunction(() => document.documentElement.dataset.crankState !== 'idle'
      && Number(document.documentElement.dataset.windSequence) > 0, null, { timeout: 5000 });
    const busyState = await page.evaluate(() => {
      const stage = document.querySelector('#camera-stage');
      const before = document.documentElement.dataset.crankState;
      for (let index = 0; index < 6; index++) stage.click();
      for (let index = 0; index < 6; index++) stage.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { before, after: document.documentElement.dataset.crankState, photoId: document.documentElement.dataset.currentPhotoId,
        disabled: stage.disabled, ariaBusy: stage.getAttribute('aria-busy') };
    });
    assert.equal(busyState.photoId, firstId, '卷片动作结束前应继续显示原照片');
    assert.equal(busyState.disabled, true);
    assert.equal(busyState.ariaBusy, 'true');
    await windingDone(secondId);
    assert.equal(await crankSequence(), initialSequence + 1, '动作和图片加载期间的连续点击应只推进一张');
    let details = await audioProbe();
    assert.equal(details.probe.playRequests, initialAudio.probe.playRequests + 1, '被防重入拦下的点击不能重复播放声音');
    assert.deepEqual(details.probe.failures, []);
    await page.click('#camera-stage');
    await windingDone(firstId);
    assert.equal(await crankSequence(), initialSequence + 2, '动作完成后应允许下一次卷片');
    details = await audioProbe();
    assert.equal(details.probe.playRequests, initialAudio.probe.playRequests + 2);
    await leaveFocus();
    return { busyState, ignoredClickBurst: 12, initialSequence, finalSequence: await crankSequence(), audio: details };
  });
  await check('查看当前照片不卷片及双尺寸完整显示', async () => {
    const before = { id: await page.evaluate(() => document.documentElement.dataset.currentPhotoId), sequence: await crankSequence(), audio: await audioProbe() };
    await page.click('#view-photo');
    await focusReady();
    await selected(before.id);
    assert.equal(await crankSequence(), before.sequence, '查看这一帧不能触发卷片');
    assert.equal((await audioProbe()).probe.playRequests, before.audio.probe.playRequests, '查看这一帧不能播放卷片声');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.crankState), 'idle');
    assert.equal(await page.locator('#focus-photo').getAttribute('src'), await page.locator('#viewfinder-photo').getAttribute('src'));
    const measurements = [];
    for (const size of [{ width: 1440, height: 900, name: 'camera-focus-wide.png' }, { width: 900, height: 650, name: 'camera-focus-small.png' }]) {
      await resizeWindow(size.width, size.height);
      await focusReady();
      const geometry = await focusGeometry();
      assertFocusGeometry(geometry);
      assert.equal(geometry.caption, '胶片相机的新界面测试');
      assert(geometry.counter.includes('2'));
      measurements.push(geometry);
      await screenshot(size.name, size.width, size.height);
    }
    await leaveFocus();
    return { measurements };
  });
  await check('大图查看与查看器导航', async () => {
    if (!await page.locator('#workspace-panel').evaluate((element) => element.hidden)) await page.click('#close-panel');
    await page.click('#view-photo');
    await focusReady();
    await page.click('#expand-photo');
    await page.waitForFunction(() => document.querySelector('#photo-dialog').open);
    await imageReady('#large-photo');
    await page.click('#viewer-previous');
    await selected(secondId);
    await imageReady('#large-photo');
    await page.click('#viewer-next');
    await selected(firstId);
    await imageReady('#large-photo');
    await screenshot('camera-large.png', 1440, 900);
    await page.click('#close-photo');
    await page.waitForFunction(() => !document.querySelector('#photo-dialog').open);
    await leaveFocus();
  });

  await check('原生全屏切换', async () => {
    const entered = application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window.isFullScreen()) await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('进入全屏超时')), 10000); window.once('enter-full-screen', () => { clearTimeout(timer); resolve(); }); });
      return window.isFullScreen();
    });
    await page.click('#fullscreen');
    assert.equal(await entered, true);
    const exited = application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isFullScreen()) await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('退出全屏超时')), 10000); window.once('leave-full-screen', () => { clearTimeout(timer); resolve(); }); });
      return !window.isFullScreen();
    });
    await page.click('#fullscreen');
    assert.equal(await exited, true);
  });
  await check('1440×900及900×650窗口适配', async () => {
    if (!await page.locator('#workspace-panel').evaluate((element) => element.hidden)) await page.click('#close-panel');
    await page.waitForFunction(() => document.querySelector('#workspace-panel').hidden);
    await screenshot('camera-wide.png', 1440, 900);
    await screenshot('camera-small.png', 900, 650);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false,
      '小窗口不应出现整个页面的横向溢出');
    await saveNow();
    await page.click('#close-panel');
    await page.click('#camera-stage');
    await windingDone(secondId);
    await saveNow();
    assert.equal((await manifest()).selectedPhotoId, secondId, '卷片后的阅读位置应保存');
  });
  await closeApplication();
  await launch();
  await check('重新启动后从最近列表恢复卷片阅读位置', async () => {
    if (await page.locator('#workspace-panel').evaluate((element) => element.hidden)) await page.click('#toggle-editor');
    await page.locator('#recent-list button').filter({ hasText: title }).click();
    await photoCount(2);
    await selected(secondId);
    await page.waitForFunction(() => !document.querySelector('#open-book').disabled);
    const data = await manifest();
    assert.equal(data.selectedPhotoId, secondId, '重启应恢复由卷片切换得到的照片');
    assert.equal(data.filmLook, 'warm');
    assert.equal(await page.locator('#film-look').inputValue(), 'warm');
    assert.equal(data.photoEdits[firstId].rotation, 1);
    assert.equal(data.photoEdits[firstId].caption, '胶片相机的新界面测试');
    assert.deepEqual(data.photoOrder, [secondId, firstId]);
    await imageReady('#viewfinder-photo');
    await page.click('#close-panel');
    await leaveFocus();
    await page.locator('#filmstrip button[data-photo-id="' + firstId + '"]').click();
    await selected(firstId);
  });
  await check('相册整体迁移后重新打开', async () => {
    await saveNow();
    await page.reload();
    await ready();
    // Verified absolute paths remain inside this run's isolated test directory.
    await fs.rename(withinTestRoot(albumDirectory), withinTestRoot(relocatedDirectory));
    await ensurePanel();
    await page.click('#open-book');
    await photoCount(2);
    await selected(firstId);
    await page.waitForFunction(() => !document.querySelector('#open-book').disabled);
    await imageReady('#viewfinder-photo');
    const data = await manifest(relocatedDirectory);
    assert.deepEqual(data.photoOrder, [secondId, firstId]);
    assert.equal(data.photoEdits[firstId].caption, '胶片相机的新界面测试');
    assert.equal(data.filmLook, 'warm');
    for (const file of copiedFiles) {
      await fs.access(path.join(relocatedDirectory, 'photos', path.basename(file)));
    }
  });
  await check('移除登记保留原图并支持空相册', async () => {
    for (let remaining = 1; remaining >= 0; remaining--) {
      await page.locator('#page-list .page-card').first().locator('button[aria-label="从相册移除"]').click();
      await photoCount(remaining);
      await saveNow();
    }
    const data = await manifest(relocatedDirectory);
    assert.equal(data.photos.length, 0);
    assert.equal(data.photoOrder.length, 0);
    assert.equal(data.selectedPhotoId, null);
    for (const file of copiedFiles) await fs.access(path.join(relocatedDirectory, 'photos', path.basename(file)));
    for (const [source, hash] of sourceHashes) assert.equal(sha256(await fs.readFile(source)), hash);
  });
  await check('无网页错误及外部网络请求', async () => {
    assert.deepEqual(report.runtimeErrors, []);
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { check: currentCheck, message: error.message, stack: error.stack };
  if (page && !page.isClosed()) {
    try { await page.screenshot({ path: path.join(artifacts, 'camera-failure.png'), scale: 'css' }); } catch {}
  }
} finally {
  try { await closeApplication(); } catch (error) { report.runtimeErrors.push({ type: 'close', message: error.message }); }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: reportPath, failure: report.failure?.message || null }));
if (report.status !== 'passed') process.exitCode = 1;
