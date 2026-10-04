const { app, BrowserWindow, dialog, ipcMain, protocol, net, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { extractNefPreview } = require('./nef.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'photobook', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let windowRef;
let bookDir = null;
const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.nef']);
const originalFilePattern = /^[a-f0-9-]+\.(jpg|jpeg|png|webp|nef)$/i;
const previewFilePattern = /^[a-f0-9-]+-preview\.jpe?g$/i;
const manifestName = 'photobook.json';
const defaultsFile = path.join(__dirname, '..', 'defaults.json');
const defaults = JSON.parse(fsSync.readFileSync(defaultsFile, 'utf8').replace(/^\uFEFF/, ''));
const smokeRoot = process.env.PHOTOBOOK_SMOKE_ROOT ? path.resolve(process.env.PHOTOBOOK_SMOKE_ROOT) : null;
const validateDefault = Boolean(smokeRoot && process.env.PHOTOBOOK_VALIDATE_DEFAULT === '1');
const defaultAlbumDirectory = process.env.PHOTOBOOK_SMOKE_SKIP_DEFAULT === '1' || (smokeRoot && !validateDefault) ? null : defaults.defaultAlbumDirectory;
const userDataDirectory = smokeRoot ? path.join(smokeRoot, 'appdata') : path.join(app.getPath('appData'), 'ShiguangFilm');

function configurePath(name, directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('应用配置包含无效目录：' + name);
  fsSync.mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
configurePath('userData', userDataDirectory);
configurePath('sessionData', path.join(userDataDirectory, 'session'));
configurePath('temp', path.join(userDataDirectory, 'temp'));
configurePath('crashDumps', path.join(userDataDirectory, 'crash-dumps'));
const logsDirectory = path.join(userDataDirectory, 'logs');
const cacheDirectory = path.join(userDataDirectory, 'chromium-cache');
fsSync.mkdirSync(logsDirectory, { recursive: true });
fsSync.mkdirSync(cacheDirectory, { recursive: true });
app.setAppLogsPath(logsDirectory);
app.commandLine.appendSwitch('disk-cache-dir', cacheDirectory);
app.setName('拾光胶片');

function inside(root, relative) {
  if (!root || typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('无效的文件路径');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('文件路径超出照片书目录');
  return resolved;
}
function safeName(name) {
  return String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 60) || '未命名照片书';
}
function checkPhotoNames(photo) {
  if (!photo || typeof photo.file !== 'string' || !originalFilePattern.test(photo.file)) throw new Error('照片书包含无效的照片路径');
  if (photo.previewFile && (typeof photo.previewFile !== 'string' || !previewFilePattern.test(photo.previewFile))) throw new Error('照片书包含无效的预览路径');
  if (/\.nef$/i.test(photo.file) && !photo.previewFile) throw new Error('NEF 照片缺少可读取的 JPEG 预览');
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function copyVerified(source, target) {
  const originalStat = await fs.stat(source);
  if (!originalStat.isFile() || !originalStat.size) throw new Error('照片文件为空或不是普通文件');
  await fs.copyFile(source, target);
  const copiedStat = await fs.stat(target);
  if (copiedStat.size !== originalStat.size) throw new Error('照片复制不完整');
  const sourceHash = await hashFile(source);
  if (sourceHash !== await hashFile(target)) throw new Error('照片复制校验失败');
  return { size: copiedStat.size, sourceHash };
}
async function writeJsonAtomic(file, data, backup = false) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  try {
    if (backup) await fs.copyFile(file, file + '.bak').catch(() => {});
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
async function readBook(directory) {
  const data = JSON.parse((await fs.readFile(path.join(directory, manifestName), 'utf8')).replace(/^\uFEFF/, ''));
  if (data.schemaVersion !== 1 || !Array.isArray(data.photos) || !Array.isArray(data.pages)) throw new Error('照片书格式不受支持');
  for (const photo of data.photos) {
    checkPhotoNames(photo);
    await fs.access(inside(directory, 'photos/' + photo.file)).catch(() => { throw new Error('照片文件缺失：' + (photo.name || photo.file)); });
    if (photo.previewFile) await fs.access(inside(directory, 'photos/' + photo.previewFile)).catch(() => { throw new Error('照片预览缺失：' + (photo.name || photo.file)); });
    if (photo.thumbnail) {
      if (!/^[a-f0-9-]+\.jpe?g$/i.test(photo.thumbnail)) throw new Error('照片书包含无效的缩略图路径');
      const exists = await fs.access(inside(directory, 'thumbnails/' + photo.thumbnail)).then(() => true).catch(() => false);
      if (!exists) photo.thumbnail = null;
    }
  }
  if (Array.isArray(data.renderedPages)) {
    for (const file of data.renderedPages) {
      if (!/^[a-zA-Z0-9._-]+$/.test(file) || !await fs.access(inside(directory, 'pages/' + file)).then(() => true).catch(() => false)) {
        data.renderedPages = [];
        data.pageSignatures = [];
        break;
      }
    }
  }
  bookDir = directory;
  await remember(directory, data.title);
  return data;
}
async function remember(directory, title) {
  const file = path.join(app.getPath('userData'), 'recent.json');
  let items = [];
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(saved)) items = saved.filter((item) => item && typeof item.path === 'string');
  } catch {}
  items = [{ path: directory, title }, ...items.filter((item) => item.path !== directory)].slice(0, 12);
  await writeJsonAtomic(file, items);
}
function isReadOnlyDefaultAlbum() {
  return validateDefault && defaultAlbumDirectory && bookDir &&
    path.resolve(bookDir) === path.resolve(defaultAlbumDirectory);
}
async function writeBook(data) {
  if (!bookDir || data?.schemaVersion !== 1 || !Array.isArray(data.photos) || !Array.isArray(data.pages)) throw new Error('照片书数据无效');
  data.photos.forEach(checkPhotoNames);
  if (isReadOnlyDefaultAlbum()) return true;
  await writeJsonAtomic(path.join(bookDir, manifestName), data, true);
  await remember(bookDir, data.title);
  return true;
}

app.whenReady().then(async () => {
  protocol.handle('photobook', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'asset' || !bookDir) throw new Error('照片书未打开');
      const relative = decodeURIComponent(url.pathname.slice(1));
      if (!/^(photos|pages|thumbnails)\/[a-zA-Z0-9._-]+$/.test(relative)) throw new Error('资源路径无效');
      const file = inside(bookDir, relative);
      return net.fetch(pathToFileURL(file).toString());
    } catch { return new Response('Not found', { status: 404 }); }
  });
  ipcMain.handle('book:choose-directory', async () => {
    if (smokeRoot) return smokeRoot;
    const result = await dialog.showOpenDialog(windowRef, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('book:create', async (_event, { parent, title }) => {
    if (!parent || !title?.trim()) throw new Error('请选择保存位置并填写书名');
    const base = safeName(title);
    let directory = path.join(parent, base);
    let index = 2;
    while (await fs.stat(directory).then(() => true).catch(() => false)) directory = path.join(parent, base + ' (' + index++ + ')');
    await fs.mkdir(path.join(directory, 'photos'), { recursive: true });
    await fs.mkdir(path.join(directory, 'pages'), { recursive: true });
    await fs.mkdir(path.join(directory, 'thumbnails'), { recursive: true });
    bookDir = directory;
    const data = { schemaVersion: 1, id: crypto.randomUUID(), title: title.trim(), coverPhotoId: null, selectedPhotoId: null, filmLook: 'original', photoOrder: [], photoEdits: {}, photos: [], pages: [], readingPage: 0, renderedPages: [], updatedAt: Date.now() };
    await writeBook(data);
    return { data, directory };
  });
  ipcMain.handle('book:default-album', async () => {
    if (!defaultAlbumDirectory) return null;
    const directory = path.resolve(defaultAlbumDirectory);
    if (!await fs.access(path.join(directory, manifestName)).then(() => true).catch(() => false)) return null;
    return { data: await readBook(directory), directory };
  });
  ipcMain.handle('book:open-dialog', async () => {
    if (process.env.PHOTOBOOK_SMOKE_OPEN_DIR) {
      const directory = process.env.PHOTOBOOK_SMOKE_OPEN_DIR;
      return { data: await readBook(directory), directory };
    }
    const result = await dialog.showOpenDialog(windowRef, { properties: ['openDirectory'] });
    if (result.canceled) return null;
    const directory = result.filePaths[0];
    return { data: await readBook(directory), directory };
  });
  ipcMain.handle('book:open-path', async (_event, directory) => ({ data: await readBook(directory), directory }));
  ipcMain.handle('book:recent', async () => {
    try { return JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'recent.json'), 'utf8')); } catch { return []; }
  });
  ipcMain.handle('book:import', async () => {
    if (!bookDir) throw new Error('请先打开一本照片书');
    if (isReadOnlyDefaultAlbum()) throw new Error('验收模式只允许浏览默认相册');
    const smokeImages = process.env.PHOTOBOOK_SMOKE_IMAGES ? JSON.parse(process.env.PHOTOBOOK_SMOKE_IMAGES) : null;
    if (smokeImages && (!Array.isArray(smokeImages) || smokeImages.some((file) => typeof file !== 'string'))) throw new Error('测试导入列表无效');
    const result = smokeImages || process.env.PHOTOBOOK_SMOKE_IMAGE
      ? { canceled: false, filePaths: [
        ...(smokeImages || Array.from({ length: Number(process.env.PHOTOBOOK_SMOKE_COUNT || 1) }, () => process.env.PHOTOBOOK_SMOKE_IMAGE)),
        ...(process.env.PHOTOBOOK_SMOKE_CORRUPT ? [process.env.PHOTOBOOK_SMOKE_CORRUPT] : []),
      ] }
      : await dialog.showOpenDialog(windowRef, { properties: ['openFile', 'multiSelections'], filters: [{ name: '照片（含 Nikon NEF）', extensions: ['jpg', 'jpeg', 'png', 'webp', 'nef'] }] });
    if (result.canceled) return [];
    await fs.mkdir(path.join(bookDir, 'photos'), { recursive: true });
    const imported = [];
    for (const source of result.filePaths) {
      const extension = path.extname(source).toLowerCase();
      if (!allowedExtensions.has(extension)) continue;
      const id = crypto.randomUUID();
      const file = id + extension;
      const target = inside(bookDir, 'photos/' + file);
      const previewFile = extension === '.nef' ? id + '-preview.jpg' : null;
      const previewTarget = previewFile ? inside(bookDir, 'photos/' + previewFile) : null;
      try {
        const verified = await copyVerified(source, target);
        const photo = { id, file, name: path.basename(source), sourceName: path.basename(source), sourceSize: verified.size, size: verified.size, sourceSha256: verified.sourceHash };
        let image;
        if (extension === '.nef') {
          const preview = extractNefPreview(await fs.readFile(target));
          image = nativeImage.createFromBuffer(preview.jpeg);
          if (image.isEmpty()) throw new Error('NEF 内嵌 JPEG 预览无法解码');
          await fs.writeFile(previewTarget, preview.jpeg);
          photo.previewFile = previewFile;
          photo.previewWidth = preview.width;
          photo.previewHeight = preview.height;
          photo.orientation = preview.orientation;
        } else {
          image = nativeImage.createFromPath(target);
          if (image.isEmpty()) throw new Error('图片损坏或格式不受支持');
        }
        const size = image.getSize();
        photo.width = size.width;
        photo.height = size.height;
        imported.push(photo);
      } catch (error) {
        await fs.rm(target, { force: true }).catch(() => {});
        if (previewTarget) await fs.rm(previewTarget, { force: true }).catch(() => {});
        imported.push({ name: path.basename(source), error: error.message });
      }
    }
    return imported;
  });
  ipcMain.handle('book:discard-photo', async (_event, file) => {
    if (isReadOnlyDefaultAlbum()) throw new Error('验收模式只允许浏览默认相册');
    if (!bookDir || !originalFilePattern.test(file)) throw new Error('无效的照片文件');
    await fs.rm(inside(bookDir, 'photos/' + file), { force: true });
    if (/\.nef$/i.test(file)) await fs.rm(inside(bookDir, 'photos/' + file.replace(/\.nef$/i, '-preview.jpg')), { force: true });
  });
  ipcMain.handle('book:save', (_event, data) => writeBook(data));
  ipcMain.handle('book:write-thumbnail', async (_event, { id, dataUrl }) => {
    if (isReadOnlyDefaultAlbum()) throw new Error('验收模式只允许浏览默认相册');
    if (!bookDir || !/^[a-f0-9-]+$/i.test(id) || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('缩略图数据无效');
    const file = id + '.jpg';
    await fs.mkdir(path.join(bookDir, 'thumbnails'), { recursive: true });
    await fs.writeFile(inside(bookDir, 'thumbnails/' + file), Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64'));
    return file;
  });
  ipcMain.handle('book:write-page', async (_event, { index, dataUrl, generation }) => {
    if (isReadOnlyDefaultAlbum()) throw new Error('验收模式只允许浏览默认相册');
    if (!bookDir || !Number.isInteger(index) || index < 0 || index > 10000 || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('页面数据无效');
    const safeGeneration = String(generation || Date.now()).replace(/[^0-9]/g, '');
    const file = 'page-' + safeGeneration + '-' + String(index).padStart(4, '0') + '.jpg';
    await fs.mkdir(path.join(bookDir, 'pages'), { recursive: true });
    await fs.writeFile(inside(bookDir, 'pages/' + file), Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64'));
    return file;
  });
  ipcMain.handle('window:fullscreen', () => {
    windowRef.setFullScreen(!windowRef.isFullScreen());
    return windowRef.isFullScreen();
  });
  windowRef = new BrowserWindow({ title: '拾光胶片', width: 1280, height: 860, minWidth: 800, minHeight: 600, show: false, backgroundColor: '#141713', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: !smokeRoot } });
  windowRef.once('ready-to-show', () => {
    if (smokeRoot && process.env.PHOTOBOOK_SMOKE_HIDE === '1') return;
    if (smokeRoot) windowRef.showInactive(); else windowRef.show();
  });
  const devUrl = process.env.PHOTOBOOK_DEV_URL;
  if (devUrl) await windowRef.loadURL(devUrl);
  else await windowRef.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
