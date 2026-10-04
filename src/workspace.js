const api = window.photobookApi;
const $ = (selector) => document.querySelector(selector);
const panel = $('#workspace-panel');
const editor = $('#editor-section');
const statusNode = $('#workspace-status');
const pageList = $('#page-list');
const coverSelect = $('#cover-select');
let book = null;
let directory = null;
let chosenParent = null;
let busy = false;
let generation = 0;
let revision = 0;
let dirty = false;
let saveTimer = null;
let saveChain = Promise.resolve();

function status(message, error = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle('error', error);
}
function asset(kind, file) {
  return 'photobook://asset/' + kind + '/' + encodeURIComponent(file);
}
function validLook(value) {
  return ['original', 'warm', 'bw'].includes(value) ? value : 'original';
}
function rotation(value) {
  const turns = Number(value);
  return Number.isFinite(turns) ? ((Math.round(turns) % 4) + 4) % 4 : 0;
}
function orderedPhotos() {
  if (!book) return [];
  const photos = new Map(book.photos.map((photo) => [photo.id, photo]));
  return book.photoOrder.map((id) => photos.get(id)).filter(Boolean);
}
function photoEdit(id) {
  return book?.photoEdits?.[id] || { caption: '', rotation: 0 };
}
function normalizeAlbum(data) {
  const photos = new Map(data.photos.map((photo) => [photo.id, photo]));
  const order = [];
  const add = (id) => {
    if (photos.has(id) && !order.includes(id)) order.push(id);
  };
  if (Array.isArray(data.photoOrder)) data.photoOrder.forEach(add);
  else {
    for (const page of data.pages) {
      if (Array.isArray(page.photoIds)) page.photoIds.forEach(add);
    }
  }
  data.photos.forEach((photo) => add(photo.id));
  data.photoOrder = order;
  if (!data.photoEdits || typeof data.photoEdits !== 'object' || Array.isArray(data.photoEdits)) data.photoEdits = {};
  for (const photo of data.photos) {
    const legacy = data.pages.find((page) => Array.isArray(page.photoIds) && page.photoIds.includes(photo.id));
    const saved = data.photoEdits[photo.id];
    const edit = saved && typeof saved === 'object' ? saved : {};
    data.photoEdits[photo.id] = {
      ...edit,
      caption: String(edit.caption ?? edit.text ?? legacy?.text ?? ''),
      rotation: rotation(edit.rotation ?? legacy?.rotation ?? 0),
    };
  }
  data.filmLook = validLook(data.filmLook);
  if (!order.includes(data.selectedPhotoId)) {
    data.selectedPhotoId = order.includes(data.coverPhotoId) ? data.coverPhotoId : order[0] || null;
  }
  if (data.coverPhotoId && !photos.has(data.coverPhotoId)) data.coverPhotoId = order[0] || null;
  return data;
}
function emitAlbum() {
  if (!book) return;
  window.dispatchEvent(new CustomEvent('film-album', {
    detail: {
      title: book.title,
      directory,
      photos: orderedPhotos().map((photo) => {
        const edit = photoEdit(photo.id);
        return {
          id: photo.id,
          name: photo.name,
          src: asset('photos', photo.previewFile || photo.file),
          thumbnail: photo.thumbnail ? asset('thumbnails', photo.thumbnail) : asset('photos', photo.previewFile || photo.file),
          caption: edit.caption,
          rotation: edit.rotation,
        };
      }),
      selectedId: book.selectedPhotoId,
      filmLook: book.filmLook,
    },
  }));
}
function togglePanel(show) {
  panel.hidden = typeof show === 'boolean' ? !show : !panel.hidden;
  const label = $('#toggle-editor span');
  if (label) label.textContent = panel.hidden ? '相册' : '收起';
}
function updateSelection() {
  for (const card of pageList.children) {
    const selected = card.dataset.photoId === book?.selectedPhotoId;
    card.classList.toggle('is-selected', selected);
    card.setAttribute('aria-current', selected ? 'true' : 'false');
  }
}
function markDirty() {
  if (!book) return;
  book.updatedAt = Date.now();
  revision += 1;
  dirty = true;
}
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!api || !book || !dirty) return saveChain;
  const snapshot = structuredClone(book);
  const snapshotGeneration = generation;
  const snapshotRevision = revision;
  dirty = false;
  saveChain = saveChain.catch(() => {}).then(async () => {
    if (snapshotGeneration !== generation) return;
    try {
      await api.save(snapshot);
      if (snapshotGeneration === generation && !busy && snapshotRevision === revision) {
        status('已保存，共 ' + book.photoOrder.length + ' 张照片。');
      }
    } catch (error) {
      if (snapshotGeneration === generation) {
        dirty = true;
        status('保存失败：' + error.message, true);
      }
      throw error;
    }
  });
  return saveChain;
}
function scheduleSave() {
  markDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    queueSave().catch(() => {});
  }, 300);
}
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (dirty) await queueSave();
  await saveChain;
}
function setBusy(value) {
  busy = value;
  for (const id of ['new-book', 'open-book', 'import-photos', 'hero-import', 'save-book', 'choose-directory', 'create-book']) {
    const element = $('#' + id);
    if (element) element.disabled = value;
  }
  for (const element of [$('#book-title'), coverSelect, ...pageList.querySelectorAll('button,input,select')]) {
    if (element) element.disabled = value;
  }
  for (const button of $('#recent-list')?.querySelectorAll('button') || []) button.disabled = value;
  if (!value && book) refreshEditor();
}
async function runTask(action) {
  if (busy) return;
  if (!api) {
    status('本地导入请使用桌面版');
    return;
  }
  setBusy(true);
  try {
    // The main process has one current album directory. Finish old saves first.
    await flushSave();
    await action();
  } catch (error) {
    status(error.message || '操作未完成，请重试。', true);
  } finally {
    setBusy(false);
  }
}
function selectPhoto(id, persist = true, emit = true) {
  if (!book || busy || !book.photoOrder.includes(id)) return;
  if (book.selectedPhotoId === id) return;
  book.selectedPhotoId = id;
  updateSelection();
  if (emit) emitAlbum();
  if (persist) scheduleSave();
}
function makeButton(label, ariaLabel, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.disabled = busy;
  button.addEventListener('click', action);
  return button;
}
function modifyPhoto(id, action) {
  if (!book || busy) return;
  const index = book.photoOrder.indexOf(id);
  if (index < 0) return;
  if (action === 'up' && index > 0) {
    [book.photoOrder[index - 1], book.photoOrder[index]] = [book.photoOrder[index], book.photoOrder[index - 1]];
  } else if (action === 'down' && index < book.photoOrder.length - 1) {
    [book.photoOrder[index + 1], book.photoOrder[index]] = [book.photoOrder[index], book.photoOrder[index + 1]];
  } else if (action === 'remove') {
    // Remove the registration only. Original and copied photo files stay intact.
    book.photoOrder = book.photoOrder.filter((photoId) => photoId !== id);
    book.photos = book.photos.filter((photo) => photo.id !== id);
    delete book.photoEdits[id];
    book.pages = book.pages.map((page) => Array.isArray(page.photoIds)
      ? { ...page, photoIds: page.photoIds.filter((photoId) => photoId !== id) }
      : page);
    if (book.coverPhotoId === id) book.coverPhotoId = book.photoOrder[0] || null;
    if (book.selectedPhotoId === id) {
      book.selectedPhotoId = book.photoOrder[Math.min(index, book.photoOrder.length - 1)] || null;
    }
  } else return;
  refreshEditor();
  emitAlbum();
  scheduleSave();
}
function refreshEditor() {
  if (!book) return;
  editor.hidden = false;
  $('#book-title').value = book.title;
  $('#book-location').textContent = directory;
  coverSelect.replaceChildren();
  coverSelect.add(new Option('未选择封面', ''));
  for (const photo of orderedPhotos()) coverSelect.add(new Option(photo.name, photo.id));
  coverSelect.value = book.coverPhotoId || '';
  pageList.replaceChildren();
  const photos = orderedPhotos();
  if (!photos.length) {
    const empty = document.createElement('p');
    empty.className = 'album-empty';
    empty.textContent = '相册还没有照片，点击“添加照片”开始。';
    pageList.append(empty);
  }
  photos.forEach((photo, index) => {
    const card = document.createElement('div');
    card.className = 'photo-card page-card';
    card.dataset.photoId = photo.id;
    const header = document.createElement('div');
    header.className = 'photo-header page-header';
    const preview = makeButton('', '浏览照片：' + photo.name, () => selectPhoto(photo.id));
    preview.className = 'photo-preview';
    const image = document.createElement('img');
    image.className = 'photo-thumb page-thumb';
    image.src = photo.thumbnail ? asset('thumbnails', photo.thumbnail) : asset('photos', photo.previewFile || photo.file);
    image.alt = photo.name;
    image.loading = 'lazy';
    image.style.transform = 'rotate(' + photoEdit(photo.id).rotation * 90 + 'deg)';
    preview.append(image);
    const title = document.createElement('strong');
    title.textContent = index + 1 + '. ' + photo.name;
    header.append(preview, title);
    const up = makeButton('↑', '上移照片', () => modifyPhoto(photo.id, 'up'));
    const down = makeButton('↓', '下移照片', () => modifyPhoto(photo.id, 'down'));
    const remove = makeButton('×', '从相册移除', () => modifyPhoto(photo.id, 'remove'));
    up.disabled = busy || index === 0;
    down.disabled = busy || index === photos.length - 1;
    header.append(up, down, remove);
    const fields = document.createElement('div');
    fields.className = 'photo-fields page-fields';
    const rotate = makeButton('旋转 90°', '照片旋转 90°', () => {
      if (busy) return;
      book.photoEdits[photo.id].rotation = (photoEdit(photo.id).rotation + 1) % 4;
      refreshEditor();
      emitAlbum();
      scheduleSave();
    });
    const caption = document.createElement('input');
    caption.type = 'text';
    caption.className = 'photo-caption';
    caption.placeholder = '写一句照片说明';
    caption.maxLength = 160;
    caption.value = photoEdit(photo.id).caption;
    caption.setAttribute('aria-label', '照片说明');
    caption.disabled = busy;
    caption.addEventListener('input', () => {
      if (busy) return;
      book.photoEdits[photo.id].caption = caption.value;
      emitAlbum();
      scheduleSave();
    });
    caption.addEventListener('change', () => {
      if (!busy) queueSave().catch(() => {});
    });
    fields.append(rotate, caption);
    card.append(header, fields);
    pageList.append(card);
  });
  $('#book-title').disabled = busy;
  coverSelect.disabled = busy;
  updateSelection();
}
async function refreshRecent() {
  if (!api) return;
  const items = await api.recent();
  const section = $('#recent-section');
  const list = $('#recent-list');
  section.hidden = items.length === 0;
  list.replaceChildren();
  for (const item of items) {
    const button = makeButton(item.title, '打开相册：' + item.title, () => runTask(async () => {
      let result;
      try { result = await api.openPath(item.path); }
      catch { throw new Error('原位置无法打开，请选择相册的新位置。'); }
      await loadAlbum(result);
    }));
    button.title = item.path;
    list.append(button);
  }
}
async function loadAlbum(result, options = {}) {
  if (!result) return false;
  generation += 1;
  revision = 0;
  dirty = false;
  book = normalizeAlbum(result.data);
  directory = result.directory;
  refreshEditor();
  togglePanel(options.showPanel !== false);
  emitAlbum();
  markDirty();
  await queueSave();
  status('已打开相册，共 ' + book.photoOrder.length + ' 张照片。');
  await refreshRecent();
  return true;
}
function showNewAlbum() {
  if (busy) return;
  if (!api) {
    status('本地导入请使用桌面版');
    togglePanel(true);
    return;
  }
  $('#new-title').value = '';
  chosenParent = null;
  $('#chosen-directory').textContent = '尚未选择保存位置';
  const dialog = $('#new-dialog');
  if (!dialog.open) dialog.showModal();
  $('#new-title').focus();
}
async function createThumbnail(photo, image) {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 160;
  const context = canvas.getContext('2d');
  context.fillStyle = '#eee7dc';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  return api.writeThumbnail({ id: photo.id, dataUrl: canvas.toDataURL('image/jpeg', 0.82) });
}
async function importPhotos() {
  if (!book) {
    showNewAlbum();
    return;
  }
  await runTask(async () => {
    status('正在导入照片…');
    const imported = await api.importPhotos();
    if (!imported.length) {
      status('已取消导入，相册内容未改变。');
      return;
    }
    const valid = [];
    const failed = imported.filter((photo) => photo.error);
    const candidates = imported.filter((photo) => !photo.error);
    for (let index = 0; index < candidates.length; index++) {
      const photo = candidates[index];
      status('正在准备照片 ' + (index + 1) + '/' + candidates.length + '…');
      try {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.src = asset('photos', photo.previewFile || photo.file);
        await image.decode();
        photo.thumbnail = await createThumbnail(photo, image);
        valid.push(photo);
      } catch (error) {
        failed.push({ name: photo.name, error: error.message || '图片无法读取' });
        // Only clean up this unsuccessful import's copy, never its source.
        await api.discardPhoto(photo.file).catch(() => {});
      }
    }
    for (const photo of valid) {
      book.photos.push(photo);
      book.photoOrder.push(photo.id);
      book.photoEdits[photo.id] = { caption: '', rotation: 0 };
    }
    if (!book.coverPhotoId && valid.length) book.coverPhotoId = valid[0].id;
    if (!book.selectedPhotoId && valid.length) book.selectedPhotoId = valid[0].id;
    if (valid.length) {
      markDirty();
      await queueSave();
      emitAlbum();
      await refreshRecent();
    }
    refreshEditor();
    if (failed.length) {
      status('已导入 ' + valid.length + ' 张，' + failed.length + ' 张失败：' + failed[0].name + '（' + failed[0].error + '）', true);
    } else {
      status('已保存，共 ' + book.photoOrder.length + ' 张照片。');
    }
  });
}

$('#toggle-editor').addEventListener('click', () => togglePanel());
$('#close-panel').addEventListener('click', () => togglePanel(false));
$('#new-book').addEventListener('click', showNewAlbum);
$('#open-book').addEventListener('click', () => runTask(async () => {
  const result = await api.openDialog();
  if (!result) {
    status('已取消打开，当前相册保持原样。');
    return;
  }
  await loadAlbum(result);
}));
$('#choose-directory').addEventListener('click', () => runTask(async () => {
  chosenParent = await api.chooseDirectory();
  $('#chosen-directory').textContent = chosenParent || '尚未选择保存位置';
}));
$('#create-book').addEventListener('click', () => runTask(async () => {
  const title = $('#new-title').value.trim();
  if (!chosenParent || !title) throw new Error('请填写相册名称并选择保存位置。');
  const result = await api.create({ parent: chosenParent, title });
  $('#new-dialog').close();
  await loadAlbum(result);
  status('相册已创建，可以添加照片。');
}));
$('#import-photos').addEventListener('click', importPhotos);
$('#hero-import').addEventListener('click', importPhotos);
$('#save-book').addEventListener('click', () => runTask(async () => {
  if (!book) {
    status('请先新建或打开相册。');
    return;
  }
  markDirty();
  await queueSave();
  await refreshRecent();
  status('已保存，共 ' + book.photoOrder.length + ' 张照片。');
}));
$('#fullscreen').addEventListener('click', async () => {
  try {
    if (api) await api.fullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) { status('无法进入全屏：' + error.message, true); }
});
$('#book-title').addEventListener('change', () => {
  if (!book || busy) return;
  book.title = $('#book-title').value.trim() || '未命名相册';
  $('#book-title').value = book.title;
  emitAlbum();
  scheduleSave();
});
coverSelect.addEventListener('change', () => {
  if (!book || busy) return;
  book.coverPhotoId = coverSelect.value || null;
  scheduleSave();
});
window.addEventListener('film-select', (event) => {
  const id = typeof event.detail === 'string' ? event.detail : event.detail?.id;
  selectPhoto(id, true, false);
});
window.addEventListener('film-look', (event) => {
  if (!book || busy || !['original', 'warm', 'bw'].includes(event.detail)) return;
  if (book.filmLook === event.detail) return;
  book.filmLook = event.detail;
  scheduleSave();
});
window.addEventListener('film-edit-selected', (event) => {
  if (busy) return;
  if (!book) {
    showNewAlbum();
    return;
  }
  const id = typeof event.detail === 'string' ? event.detail : event.detail?.id || book.selectedPhotoId;
  selectPhoto(id);
  togglePanel(true);
  const card = [...pageList.children].find((element) => element.dataset.photoId === id);
  card?.scrollIntoView({ block: 'nearest' });
});
window.addEventListener('beforeunload', () => {
  if (api && book && dirty) queueSave().catch(() => {});
});
if (api) {
  if (typeof api.defaultAlbum === 'function') {
    runTask(async () => {
      const result = await api.defaultAlbum();
      if (result) await loadAlbum(result, { showPanel: false });
      else await refreshRecent();
    });
  } else refreshRecent().catch((error) => status('最近相册暂时无法读取：' + error.message, true));
} else status('本地导入请使用桌面版');
