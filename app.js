const DB_NAME = 'worshipchord-local';
const DB_VERSION = 4;
const TODAY_SETLIST_ID = 'today';
const API_BASE = String(window.WORSHIPCHORD_CONFIG?.apiBase || '').replace(/\/+$/, '');
const LAST_USER_KEY = `${DB_NAME}-last-user`;
const KEY_NAMES = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_SPELLING_KEYS = new Set(['F', 'Db', 'Eb', 'Gb', 'Ab', 'Bb']);
const SHARP_SPELLING_KEYS = new Set(['C#', 'D#', 'F#', 'G#', 'A#']);
const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const $ = (id) => document.getElementById(id);
let pageScrollLockActive = false;
let pageScrollPosition = 0;

function lockPageScroll() {
  if (pageScrollLockActive) return;
  pageScrollPosition = window.scrollY || document.documentElement.scrollTop || 0;
  const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  document.body.style.setProperty('--dialog-scroll-top', `-${pageScrollPosition}px`);
  document.body.style.setProperty('--dialog-scrollbar-compensation', `${scrollbarWidth}px`);
  document.body.classList.add('dialog-scroll-locked');
  pageScrollLockActive = true;
}

function unlockPageScroll() {
  if (!pageScrollLockActive) return;
  document.body.classList.remove('dialog-scroll-locked');
  document.body.style.removeProperty('--dialog-scroll-top');
  document.body.style.removeProperty('--dialog-scrollbar-compensation');
  pageScrollLockActive = false;
  window.scrollTo(0, pageScrollPosition);
}

function syncPageScrollLock() {
  if (document.querySelector('dialog[open]')) lockPageScroll();
  else unlockPageScroll();
}

function openAppDialog(dialog) {
  if (!dialog || dialog.open) return;
  lockPageScroll();
  dialog.showModal();
}

function observeDialogScrollState() {
  const observer = new MutationObserver(syncPageScrollLock);
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('close', syncPageScrollLock));
  syncPageScrollLock();
}

let db;
let songs = [];
let todaySetlist = { id: TODAY_SETLIST_ID, name: 'เพลงวันนี้', songIds: [] };
let legacySongs = [];
let legacyTodaySetlist = { id: TODAY_SETLIST_ID, name: 'เพลงวันนี้', songIds: [] };
let editingId = null;
let currentSong = null;
let readerSongIds = [];
let readerContext = 'library';
let editingGroupId = null;
let editingGroupSetId = null;
let authUser = null;
let offlineMode = false;
let previousFormatText = null;
let pendingBackupImport = null;
let pendingBackupTarget = { type: 'personal', groupId: null };
const READER_PREFS_KEY = 'worshipchord.readerPreferences.v1';
const VIEW_STATE_KEY = 'worshipchord.viewState.v1';
let songOrderRevision = 0;
let syncInProgress = false;
let reconnectInProgress = false;
let pendingSyncConflict = null;
let groups = [];
let activeGroup = null;
let sharedSongs = [];
let sharedSongsGroupId = null;
let activeSetSongs = [];
let activeWeeklySet = null;
let activeMainTab = 'today';
let searchScope = 'all';
let searchRequestToken = 0;
const searchGroupLibraries = new Map();
const pendingSearchGroupLoads = new Map();
let groupSongPickerSource = 'group';
let groupSuggestions = [];
let editorSourceKeyConfirmed = false;
let offlineGroupSnapshot = false;
const SONGS_PER_PAGE = 12;
const songPages = { today: 0, personal: 0, group: 0, groupLibrary: 0 };
const bulkSelection = { today: new Set(), personal: new Set(), groupSet: new Set(), groupLibrary: new Set() };
let restoringViewState = false;
let memberPageOffset = 0;
let memberSearchTimer = null;
let memberRequestToken = 0;
const MEMBER_PAGE_SIZE = 25;
let notifications = [];
let realtimeSocket = null;
let authMode = 'login';
let toastTimer;
let libraryRefreshTimer = null;
let lastPersonalMutationAt = 0;

function readViewState() {
  try { return JSON.parse(sessionStorage.getItem(VIEW_STATE_KEY) || '{}'); } catch { return {}; }
}

function saveViewState() {
  if (restoringViewState) return;
  const state = {
    userId: authUser?.id || null,
    tab: activeMainTab,
    groupId: activeGroup?.id || null,
    setId: activeWeeklySet?.id || null,
    page: !$('readerView')?.hidden ? 'reader' : 'library',
    readerContext,
    songId: currentSong?.id || null,
    queueOpen: $('readerView')?.classList.contains('show-reader-queue') || false,
  };
  try { sessionStorage.setItem(VIEW_STATE_KEY, JSON.stringify(state)); } catch { /* Route state is a convenience; the current view still works. */ }
}

function openDatabase(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('songs')) database.createObjectStore('songs', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('setlists')) database.createObjectStore('setlists', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('syncQueue')) database.createObjectStore('syncQueue', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('groupSnapshots')) database.createObjectStore('groupSnapshots', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeSongs(mode = 'readonly') { return db.transaction('songs', mode).objectStore('songs'); }
function storeSetlists(mode = 'readonly') { return db.transaction('setlists', mode).objectStore('setlists'); }
function storeSyncQueue(mode = 'readonly') { return db.transaction('syncQueue', mode).objectStore('syncQueue'); }
function storeGroupSnapshots(mode = 'readonly') { return db.transaction('groupSnapshots', mode).objectStore('groupSnapshots'); }
function saveGroupSnapshot(snapshot) {
  return new Promise((resolve, reject) => {
    const request = storeGroupSnapshots('readwrite').put(snapshot);
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
  });
}
function getGroupSnapshot(id) {
  return new Promise((resolve, reject) => {
    const request = storeGroupSnapshots().get(id);
    request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
  });
}
async function getPinnedGroupSnapshot() {
  try {
    const id = localStorage.getItem(`${READER_PREFS_KEY}.offlineGroup`);
    return id ? getGroupSnapshot(id) : null;
  } catch { return null; }
}
function getAllSongs() {
  return new Promise((resolve, reject) => {
    const request = storeSongs().getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.order - b.order));
    request.onerror = () => reject(request.error);
  });
}
function saveToDb(song) {
  return new Promise((resolve, reject) => {
    const request = storeSongs('readwrite').put(song);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}
function deleteFromDb(id) {
  return new Promise((resolve, reject) => {
    const request = storeSongs('readwrite').delete(id);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}
function getSetlist(id) {
  return new Promise((resolve, reject) => {
    const request = storeSetlists().get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
function saveSetlist(setlist) {
  return new Promise((resolve, reject) => {
    const request = storeSetlists('readwrite').put({ ...setlist, updatedAt: Date.now() });
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

function getSyncQueue() {
  return new Promise((resolve, reject) => {
    const request = storeSyncQueue().getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function saveSyncItem(item) {
  return new Promise((resolve, reject) => {
    const request = storeSyncQueue('readwrite').put({ ...item, queuedAt: item.queuedAt || Date.now() });
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

function deleteSyncItem(id) {
  return new Promise((resolve, reject) => {
    const request = storeSyncQueue('readwrite').delete(id);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

function newLocalId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isTransientApiError(error) {
  return !error?.status || error.status >= 500;
}

function setConnectivityBanner(message = '') {
  const banner = $('connectivityBanner');
  if (!banner) return;
  banner.hidden = !message;
  $('connectivityText').textContent = message;
  $('syncNowButton').hidden = !message;
  $('syncNowButton').textContent = offlineMode ? 'ลองเชื่อมต่อ' : 'ซิงก์ตอนนี้';
  banner.classList.toggle('is-offline', offlineMode);
}

async function enterOfflineMode(message = 'ฐานข้อมูล/อินเทอร์เน็ตขาดการเชื่อมต่อ') {
  let snapshot = activeGroup?.id ? await getGroupSnapshot(activeGroup.id).catch(() => null) : null;
  if (!snapshot) snapshot = await getPinnedGroupSnapshot();
  offlineMode = true;
  realtimeSocket?.close();
  realtimeSocket = null;
  groups = snapshot ? [snapshot.group] : []; activeGroup = snapshot?.group || null; sharedSongs = snapshot?.songs || []; sharedSongsGroupId = snapshot?.id || null; activeWeeklySet = snapshot?.activeSet || null; activeSetSongs = snapshot?.setSongs || [];
  offlineGroupSnapshot = Boolean(snapshot);
  if (editingGroupId && !$('editorView').hidden) {
    editingGroupId = null;
    editingGroupSetId = null;
    showView('library');
    notify('การแก้เพลงกลุ่มต้องเชื่อมต่ออินเทอร์เน็ต');
  }
  if (['group', 'groupLibrary'].includes(readerContext) && !$('readerView').hidden && !offlineGroupSnapshot) showView('library');
  if (['group', 'groupLibrary'].includes(readerContext) && !$('readerView').hidden && offlineGroupSnapshot) {
    $('readerEditButton').hidden = true;
    setReaderKeyGuidance(readerContext);
  }
  const count = await getSyncQueue().then((queue) => queue.length).catch(() => 0);
  const snapshotNote = snapshot ? ` · กลุ่ม “${snapshot.group.name}” เปิดสำเนาล่าสุดได้ · ซิงก์ ${new Date(snapshot.savedAt).toLocaleString('th-TH')}` : '';
  setConnectivityBanner(`ออฟไลน์ · ${message}${snapshotNote} · แก้เพลงส่วนตัว/เพลงวันนี้ได้ · ${count} รายการรอซิงก์`);
  renderGroupPanel();
  renderSongRows();
}

function clearLocalLibrary() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['songs', 'setlists'], 'readwrite');
    transaction.objectStore('songs').clear();
    transaction.objectStore('setlists').clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function cacheRemoteLibrary(library) {
  await clearLocalLibrary();
  await Promise.all(library.songs.map(saveToDb));
  todaySetlist = library.todaySetlist || { id: TODAY_SETLIST_ID, name: 'เพลงวันนี้', songIds: [], revision: 0 };
  songOrderRevision = Number(library.songOrderRevision || 0);
  await saveSetlist(todaySetlist);
  songs = library.songs;
}

function loadRememberedUser() {
  try {
    const user = JSON.parse(localStorage.getItem(LAST_USER_KEY) || 'null');
    return user?.id && user?.email ? user : null;
  } catch { return null; }
}

async function restoreQueuedLocalChanges() {
  const queue = await getSyncQueue();
  if (!queue.length) return;
  queue.sort((a, b) => ({ song: 0, setlist: 1, order: 2 }[a.type] ?? 9) - ({ song: 0, setlist: 1, order: 2 }[b.type] ?? 9));
  const updated = [...songs];
  for (const item of queue) {
    if (item.type === 'song') {
      const index = updated.findIndex((song) => song.id === item.songId);
      if (item.operation === 'delete') {
        if (index >= 0) updated.splice(index, 1);
      } else if (index >= 0) updated[index] = { ...item.song, order: updated[index].order };
      else updated.push({ ...item.song, order: item.song.order ?? updated.length });
    }
    if (item.type === 'order') {
      const order = new Map(item.songIds.map((id, index) => [id, index]));
      updated.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.order - b.order);
    }
    if (item.type === 'setlist') todaySetlist = { ...item.setlist };
  }
  songs = updated.map((song, order) => ({ ...song, order }));
  await clearLocalLibrary();
  await Promise.all(songs.map(saveToDb));
  await saveSetlist(todaySetlist);
}

async function readCachedLibrary() {
  songs = await getAllSongs();
  todaySetlist = await getSetlist(TODAY_SETLIST_ID) || { id: TODAY_SETLIST_ID, name: 'เพลงวันนี้', songIds: [], revision: 0 };
  await restoreQueuedLocalChanges();
}

async function saveOfflineSong(song, previousSong = null) {
  const queueId = `song:${song.id}`;
  const queued = (await getSyncQueue()).find((item) => item.id === queueId);
  const baseSong = queued?.baseSong ?? (previousSong?.revision ? { ...previousSong } : null);
  const baseRevision = queued?.baseRevision ?? Number(previousSong?.revision || 0);
  const localSong = { ...song, revision: Number(previousSong?.revision || song.revision || 0) };
  await saveSyncItem({ id: queueId, type: 'song', operation: 'upsert', songId: song.id, song: localSong, baseRevision, baseSong });
  await saveToDb(localSong);
  songs = await getAllSongs();
  return localSong;
}

async function queueOfflineSongDelete(song) {
  const queueId = `song:${song.id}`;
  const queue = await getSyncQueue();
  const queued = queue.find((item) => item.id === queueId);
  if (queued?.operation === 'upsert' && !queued.baseRevision) {
    await deleteSyncItem(queueId);
  } else {
    await saveSyncItem({
      id: queueId, type: 'song', operation: 'delete', songId: song.id,
      baseRevision: queued?.baseRevision ?? Number(song.revision || 0),
      baseSong: queued?.baseSong ?? { ...song }
    });
  }
  await deleteFromDb(song.id);
  songs = await getAllSongs();
  const orderItem = queue.find((item) => item.type === 'order');
  if (orderItem) {
    orderItem.songIds = orderItem.songIds.filter((id) => id !== song.id);
    await saveSyncItem(orderItem);
  }
  await queueOfflineSetlist(todaySetlist.songIds.filter((id) => id !== song.id));
}

async function queueOfflineSetlist(songIds, baseSetlist = todaySetlist) {
  const queueId = 'setlist:today';
  const queued = (await getSyncQueue()).find((item) => item.id === queueId);
  const current = { ...todaySetlist };
  const base = queued?.baseSetlist ?? baseSetlist;
  const baseSongIds = queued?.baseSongIds ?? [...(base.songIds || [])];
  const baseRevision = queued?.baseRevision ?? Number(base.revision || 0);
  todaySetlist = { ...todaySetlist, songIds: [...songIds] };
  await saveSetlist(todaySetlist);
  await saveSyncItem({ id: queueId, type: 'setlist', setlist: { ...todaySetlist }, baseRevision, baseSongIds, baseSetlist: base || current });
  songs = await getAllSongs();
}

async function queueOfflineOrder(songIds, baseSongIds = songs.map((song) => song.id), baseRevision = songOrderRevision) {
  const queueId = 'order';
  const queued = (await getSyncQueue()).find((item) => item.id === queueId);
  const originalIds = queued?.baseSongIds ?? [...baseSongIds];
  const originalRevision = queued?.baseRevision ?? baseRevision;
  await saveSyncItem({ id: queueId, type: 'order', songIds: [...songIds], baseRevision: originalRevision, baseSongIds: originalIds });
}

function sameSongContent(left, right) {
  return ['title', 'artist', 'key', 'text', 'youtubeUrl', 'chordUrl'].every((field) => String(left?.[field] || '') === String(right?.[field] || ''));
}

function sameIdOrder(left = [], right = []) {
  return left.length === right.length && left.every((id, index) => String(id) === String(right[index]));
}

function mergeConflictResponse(item, error, library) {
  const merged = { ...library, songs: [...(library.songs || [])] };
  if (error.payload?.song && item.type === 'song') {
    const cloudSong = error.payload.song;
    merged.songs = merged.songs.filter((song) => song.id !== cloudSong.id).concat(cloudSong).sort((a, b) => a.order - b.order);
  }
  if (error.payload?.todaySetlist && item.type === 'setlist') merged.todaySetlist = error.payload.todaySetlist;
  if (Array.isArray(error.payload?.songIds) && item.type === 'order') {
    const byId = new Map(merged.songs.map((song) => [song.id, song]));
    merged.songs = error.payload.songIds.map((id) => byId.get(id)).filter(Boolean).concat(merged.songs.filter((song) => !error.payload.songIds.includes(song.id)));
    merged.songOrderRevision = error.payload.songOrderRevision;
  }
  return merged;
}

async function saveSyncConflict(item, library, cloudSong = undefined) {
  const updated = { ...item, conflictLibrary: library, conflictCloudSong: cloudSong, conflictAt: Date.now() };
  await saveSyncItem(updated);
  pendingSyncConflict = updated.id;
  setConnectivityBanner('พบฉบับที่แก้ต่างกัน · เลือกฉบับที่จะเก็บก่อนซิงก์ต่อ');
  showSyncConflict(updated);
}

function showSyncConflict(item) {
  const dialog = $('syncConflictDialog');
  if (!dialog || dialog.open) return;
  const isSong = item.type === 'song';
  const name = item.song?.title || item.baseSong?.title || 'เพลงนี้';
  $('syncConflictTitle').textContent = isSong ? `เพลง “${name}” ถูกแก้จากอุปกรณ์อื่น` : item.type === 'setlist' ? 'เพลงวันนี้ถูกจัดลำดับจากอุปกรณ์อื่น' : 'ลำดับเพลงส่วนตัวเปลี่ยนจากอุปกรณ์อื่น';
  const cloud = item.conflictLibrary;
  if (isSong) {
    const cloudSong = item.conflictCloudSong;
    $('syncConflictSummary').textContent = cloudSong
      ? `ฉบับคลาวด์: ${cloudSong.title || 'เพลงไม่มีชื่อ'} · ${cloudSong.artist || 'ไม่ระบุศิลปิน'} · คีย์ ${cloudSong.key || 'C'}\nฉบับในเครื่อง: ${item.song?.title || 'เพลงไม่มีชื่อ'} · ${item.song?.artist || 'ไม่ระบุศิลปิน'} · คีย์ ${item.song?.key || 'C'}`
      : 'ไม่พบเพลงฉบับคลาวด์แล้ว แต่ยังมีฉบับที่แก้ไว้ในเครื่อง';
  } else if (item.type === 'setlist') {
    $('syncConflictSummary').textContent = `เพลงในคลาวด์ ${cloud?.todaySetlist?.songIds?.length || 0} เพลง · เพลงในเครื่อง ${item.setlist?.songIds?.length || 0} เพลง`;
  } else {
    $('syncConflictSummary').textContent = `เพลงในคลาวด์ ${cloud?.songs?.length || 0} เพลง · ตรวจรายการเพลงก่อนเลือกลำดับที่จะเก็บ`;
  }
  $('syncConflictBoth').hidden = !isSong || item.operation === 'delete' || !item.conflictCloudSong;
  openAppDialog(dialog);
}

async function syncPendingChanges() {
  if (!authUser || !navigator.onLine || syncInProgress) return;
  let queue = await getSyncQueue();
  const blocked = queue.find((item) => item.conflictLibrary);
  if (blocked) { pendingSyncConflict = blocked.id; showSyncConflict(blocked); return; }
  if (!queue.length) {
    offlineMode = false;
    setConnectivityBanner('');
    return;
  }

  syncInProgress = true;
  setConnectivityBanner(`กำลังซิงก์ ${queue.length} รายการ…`);
  try {
    let library = await api('/api/library');
    const priority = { song: 0, setlist: 1, order: 2 };
    queue.sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9) || a.queuedAt - b.queuedAt);
    for (const item of queue) {
      if ((await getSyncQueue()).some((latest) => latest.id === item.id && latest.conflictLibrary)) {
        const latest = (await getSyncQueue()).find((entry) => entry.id === item.id);
        pendingSyncConflict = latest.id;
        showSyncConflict(latest);
        return;
      }
      try {
        if (item.type === 'song') {
          const cloudSong = library.songs.find((song) => song.id === item.songId);
          if (item.operation === 'delete') {
            if (!cloudSong) { await deleteSyncItem(item.id); continue; }
            if (Number(cloudSong.revision || 0) !== Number(item.baseRevision || 0)) {
              await saveSyncConflict(item, library, cloudSong);
              return;
            }
            await api(`/api/library/songs/${encodeURIComponent(item.songId)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: item.baseRevision }) });
          } else if (!Number(item.baseRevision || 0)) {
            if (cloudSong) {
              if (sameSongContent(cloudSong, item.song)) { await deleteSyncItem(item.id); continue; }
              await saveSyncConflict(item, library, cloudSong);
              return;
            }
            await api('/api/library/songs', { method: 'POST', body: JSON.stringify({ song: item.song }) });
          } else {
            if (!cloudSong) { await saveSyncConflict(item, library, null); return; }
            if (Number(cloudSong.revision || 0) !== Number(item.baseRevision) && !sameSongContent(cloudSong, item.song)) {
              await saveSyncConflict(item, library, cloudSong);
              return;
            }
            if (!sameSongContent(cloudSong, item.song)) {
              await api(`/api/library/songs/${encodeURIComponent(item.songId)}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: item.baseRevision, song: item.song }) });
            }
          }
        } else if (item.type === 'setlist') {
          const remoteIds = library.todaySetlist?.songIds || [];
          if (sameIdOrder(remoteIds, item.setlist.songIds)) { await deleteSyncItem(item.id); continue; }
          if (Number(library.todaySetlist?.revision || 0) !== Number(item.baseRevision || 0)) {
            await saveSyncConflict(item, library);
            return;
          }
          await api('/api/library/setlist', { method: 'PATCH', body: JSON.stringify({ songIds: item.setlist.songIds, expectedRevision: item.baseRevision }) });
        } else if (item.type === 'order') {
          const remoteIds = library.songs.map((song) => song.id);
          if (sameIdOrder(remoteIds, item.songIds)) { await deleteSyncItem(item.id); continue; }
          if (Number(library.songOrderRevision || 0) !== Number(item.baseRevision || 0)) {
            await saveSyncConflict(item, library);
            return;
          }
          await api('/api/library/order', { method: 'PATCH', body: JSON.stringify({ songIds: item.songIds, expectedRevision: item.baseRevision }) });
        }
        await deleteSyncItem(item.id);
        library = await api('/api/library');
      } catch (error) {
        if (error.status === 409) {
          let latest = library;
          try { latest = await api('/api/library'); } catch { /* Use the last successful cloud snapshot. */ }
          latest = mergeConflictResponse(item, error, latest);
          const cloudSong = error.payload?.song || latest.songs?.find((song) => song.id === item.songId) || null;
          await saveSyncConflict(item, latest, cloudSong);
          return;
        }
        throw error;
      }
    }
    library = await api('/api/library');
    await cacheRemoteLibrary(library);
    offlineMode = false;
    setConnectivityBanner('');
    renderSongRows();
    if (!$('editorView').hidden && !editingGroupId && currentSong) {
      const updatedSong = songs.find((song) => song.id === currentSong.id);
      if (updatedSong) currentSong = updatedSong;
    }
    if (!$('readerView').hidden && readerContext !== 'group' && currentSong) {
      currentSong = songs.find((song) => song.id === currentSong.id) || currentSong;
      renderChordContent($('readerChords'), currentSong, $('readerKeySelect').value);
      readerSongIds = (readerContext === 'today' ? todaySongs() : songs).map((song) => song.id);
      renderReaderPosition();
      renderReaderQueue();
    }
    notify('ซิงก์เพลงที่แก้ในเครื่องแล้ว');
  } catch (error) {
    if (isTransientApiError(error)) {
      offlineMode = true;
      const remaining = (await getSyncQueue()).length;
      setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${remaining} รายการรอซิงก์`);
      renderGroupPanel();
    } else notify(error.message || 'ซิงก์ข้อมูลไม่สำเร็จ');
  } finally {
    syncInProgress = false;
  }
}

async function applyConflictChoice(choice) {
  const queue = await getSyncQueue();
  const item = queue.find((entry) => entry.id === pendingSyncConflict);
  if (!item) { $('syncConflictDialog').close(); return; }
  const library = item.conflictLibrary;
  const cloudSong = item.conflictCloudSong;
  if (choice === 'cloud') {
    if (library) await cacheRemoteLibrary(library);
    await deleteSyncItem(item.id);
    await restoreQueuedLocalChanges();
  } else if (choice === 'offline') {
    if (item.type === 'song') {
      if (item.operation === 'delete' && !cloudSong) await deleteSyncItem(item.id);
      else {
        item.baseRevision = Number(cloudSong?.revision || 0);
        item.baseSong = cloudSong ? { ...cloudSong } : null;
        delete item.conflictLibrary; delete item.conflictCloudSong; delete item.conflictAt;
        await saveSyncItem(item);
      }
    } else if (item.type === 'setlist') {
      item.baseRevision = Number(library?.todaySetlist?.revision || 0);
      item.baseSongIds = [...(library?.todaySetlist?.songIds || [])];
      delete item.conflictLibrary; delete item.conflictCloudSong; delete item.conflictAt;
      await saveSyncItem(item);
    } else {
      item.baseRevision = Number(library?.songOrderRevision || 0);
      const cloudIds = (library?.songs || []).map((song) => song.id);
      item.songIds = [...item.songIds.filter((id) => cloudIds.includes(id)), ...cloudIds.filter((id) => !item.songIds.includes(id))];
      item.baseSongIds = cloudIds;
      const byId = new Map((library?.songs || []).map((song) => [song.id, song]));
      const pendingAdds = queue.filter((entry) => entry.type === 'song' && entry.operation === 'upsert').map((entry) => entry.songId);
      const pendingDeletes = new Set(queue.filter((entry) => entry.type === 'song' && entry.operation === 'delete').map((entry) => entry.songId));
      item.songIds = [
        ...item.songIds.filter((id) => !pendingDeletes.has(id) && (cloudIds.includes(id) || pendingAdds.includes(id))),
        ...cloudIds.filter((id) => !item.songIds.includes(id) && !pendingDeletes.has(id)),
        ...pendingAdds.filter((id) => !item.songIds.includes(id))
      ];
      songs = item.songIds.map((id, order) => ({ ...(byId.get(id) || songs.find((song) => song.id === id)), order })).filter((song) => song.id);
      await clearLocalLibrary();
      await Promise.all(songs.map(saveToDb));
      await saveSetlist(todaySetlist);
      delete item.conflictLibrary; delete item.conflictCloudSong; delete item.conflictAt;
      await saveSyncItem(item);
    }
  } else if (choice === 'both' && item.type === 'song' && item.operation === 'upsert' && cloudSong) {
    if (library) await cacheRemoteLibrary(library);
    const newId = newLocalId();
    const duplicate = { ...item.song, id: newId, revision: 0, order: songs.length };
    songs = [...songs, duplicate];
    await saveToDb(duplicate);
    await saveSyncItem({ id: `song:${newId}`, type: 'song', operation: 'upsert', songId: newId, song: duplicate, baseRevision: 0, baseSong: null });
    await deleteSyncItem(item.id);
    const oldListItem = queue.find((entry) => entry.type === 'setlist');
    const desiredTodayIds = oldListItem?.setlist?.songIds || todaySetlist.songIds || [];
    if (desiredTodayIds.includes(item.songId)) {
      const ids = desiredTodayIds.map((id) => id === item.songId ? newId : id);
      await queueOfflineSetlist(ids);
      if (oldListItem) {
        const currentListItem = (await getSyncQueue()).find((entry) => entry.id === 'setlist:today');
        if (currentListItem) { currentListItem.baseRevision = oldListItem.baseRevision; currentListItem.baseSongIds = oldListItem.baseSongIds; currentListItem.baseSetlist = oldListItem.baseSetlist; await saveSyncItem(currentListItem); }
      }
    }
  }
  pendingSyncConflict = null;
  $('syncConflictDialog').close();
  renderSongRows();
  const remaining = (await getSyncQueue()).length;
  if (remaining) setConnectivityBanner(`${offlineMode ? 'ออฟไลน์ · ' : ''}${remaining} รายการรอซิงก์`);
  else if (!offlineMode) setConnectivityBanner('');
  if (choice === 'cloud') notify('ใช้ฉบับจากคลาวด์แล้ว');
  else if (choice === 'both') notify('เก็บทั้งฉบับคลาวด์และฉบับในเครื่องแล้ว');
  else notify('เลือกฉบับในเครื่อง · กำลังซิงก์');
  await syncPendingChanges();
}

async function loadPrivateLibrary(user, allowLegacyPrompt = true) {
  if (authUser?.id !== user.id) {
    searchGroupLibraries.clear();
    pendingSearchGroupLoads.clear();
  }
  const accountDbName = `${DB_NAME}-${user.id}`;
  if (db?.name !== accountDbName) {
    db?.close();
    db = await openDatabase(accountDbName);
  }
  authUser = user;
  localStorage.setItem(LAST_USER_KEY, JSON.stringify({ id: user.id, email: user.email, displayName: user.displayName || user.email.split('@')[0] }));
  let library;
  try {
    library = await api('/api/library');
  } catch (error) {
    if (!isTransientApiError(error)) throw error;
    await readCachedLibrary();
    const queue = await getSyncQueue();
    const conflict = queue.find((item) => item.conflictLibrary);
    if (conflict) { pendingSyncConflict = conflict.id; showSyncConflict(conflict); }
    await enterOfflineMode('แสดงเพลงที่บันทึกในเครื่อง');
    notify(songs.length ? 'ออฟไลน์: แก้ไขเพลงส่วนตัวและเพลงวันนี้ได้' : 'ออฟไลน์: ยังไม่มีเพลงที่บันทึกในเครื่อง');
    return;
  }

  const migrationKey = `${DB_NAME}-legacy-import-complete`;
  const skipKey = `${DB_NAME}-legacy-import-skip-${user.id}`;
  if (allowLegacyPrompt && legacySongs.length && localStorage.getItem(migrationKey) !== 'done' && !localStorage.getItem(skipKey)) {
    const shouldImport = await confirmAction({ title: 'นำเพลงเดิมเข้าในบัญชีนี้?', message: `พบเพลงเก่า ${legacySongs.length} เพลงในอุปกรณ์นี้ ต้องการนำเข้าไปยังบัญชี ${user.email} เพื่อซิงก์ผ่าน MongoDB หรือไม่?`, confirmLabel: 'นำเข้าเพลง' });
    if (shouldImport) {
      const result = await api('/api/library/import', {
        method: 'POST',
        body: JSON.stringify({ songs: legacySongs, todaySetlist: legacyTodaySetlist })
      });
      library = result.library;
      localStorage.setItem(migrationKey, 'done');
    } else {
      localStorage.setItem(skipKey, 'skip');
    }
  }

  await cacheRemoteLibrary(library);
  await restoreQueuedLocalChanges();
  offlineMode = false;
  setConnectivityBanner('');
}

async function refreshPersonalLibraryRealtime() {
  if (!authUser || offlineMode) return;
  if ((await getSyncQueue()).length) { await syncPendingChanges(); return; }
  if (!$('editorView').hidden && !editingGroupId) {
    notify('เพลงส่วนตัวเปลี่ยนจากอุปกรณ์อื่นแล้ว บันทึกอาจแจ้งว่ามีเวอร์ชันใหม่');
    return;
  }
  const readerWasOpen = !$('readerView').hidden && !['group', 'groupLibrary'].includes(readerContext);
  const currentId = currentSong?.id;
  const displayKey = $('readerKeySelect').value;
  let library;
  try { library = await api('/api/library'); }
  catch (error) {
    if (isTransientApiError(error)) { await enterOfflineMode('ฐานข้อมูลไม่พร้อมใช้งาน'); return; }
    throw error;
  }
  await cacheRemoteLibrary(library);
  await restoreQueuedLocalChanges();
  renderSongRows();
  if (readerWasOpen) {
    const updatedSong = songs.find((song) => song.id === currentId);
    if (!updatedSong) { showView('library'); notify('เพลงนี้ถูกลบจากบัญชีแล้ว'); return; }
    currentSong = updatedSong;
    readerSongIds = (readerContext === 'today' ? todaySongs() : songs).map((song) => song.id);
    $('readerTitle').textContent = updatedSong.title || 'เพลงไม่มีชื่อ';
    $('readerArtist').textContent = updatedSong.artist || 'WORSHIP SONG';
    keyOptions($('readerKeySelect'), displayKey || updatedSong.key || 'C');
    renderChordContent($('readerChords'), updatedSong, $('readerKeySelect').value);
    renderReaderPosition();
    renderReaderQueue();
  }
}

function notify(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function pageItems(items, key, pagerId) {
  const pages = Math.max(1, Math.ceil(items.length / SONGS_PER_PAGE));
  songPages[key] = Math.min(songPages[key], pages - 1);
  const start = songPages[key] * SONGS_PER_PAGE;
  const shown = items.slice(start, start + SONGS_PER_PAGE);
  const pager = $(pagerId);
  pager.hidden = pages < 2;
  pager.innerHTML = pages < 2 ? '' : `<span>${start + 1}–${Math.min(start + SONGS_PER_PAGE, items.length)} จาก ${items.length} เพลง</span><div><button type="button" class="quiet-button" data-song-page="${key}" data-delta="-1" ${songPages[key] === 0 ? 'disabled' : ''}>ก่อนหน้า</button><span>หน้า ${songPages[key] + 1}/${pages}</span><button type="button" class="quiet-button" data-song-page="${key}" data-delta="1" ${songPages[key] >= pages - 1 ? 'disabled' : ''}>ถัดไป</button></div>`;
  return shown.map((song, index) => ({ song, index: start + index }));
}

function renderBulkToolbar(context, ids, actions = []) {
  const selected = bulkSelection[context];
  const valid = new Set(ids);
  for (const id of selected) if (!valid.has(id)) selected.delete(id);
  const toolbar = $(`${context}BulkToolbar`) || (context === 'groupSet' ? $('groupSetBulkToolbar') : null);
  if (!toolbar) return;
  toolbar.hidden = !selected.size || !actions.length;
  toolbar.innerHTML = !selected.size || !actions.length ? '' : `<strong>เลือก ${selected.size} เพลง</strong><div>${actions.map(([action, label, danger = false]) => `<button type="button" class="${danger ? 'danger-text-button' : 'quiet-button'}" data-bulk-action="${action}" data-bulk-context="${context}">${label}</button>`).join('')}<button type="button" class="quiet-button" data-bulk-action="clear" data-bulk-context="${context}">ยกเลิกการเลือก</button></div>`;
}

function renderAllBulkToolbars() {
  const canEditGroup = canEditActiveGroup() && !offlineMode;
  renderBulkToolbar('today', todaySongs().map((song) => song.id), [['remove', 'เอาออกจากเพลงวันนี้', true]]);
  renderBulkToolbar('personal', songs.map((song) => song.id), [['addToday', 'เพิ่มเข้าเพลงวันนี้'], ...(canEditGroup ? [['shareGroup', 'แชร์เข้าคลังกลุ่ม']] : []), ['delete', 'ลบจากคลังส่วนตัว', true]]);
  renderBulkToolbar('groupSet', activeSetSongs.map((song) => song.id), canEditGroup ? [['remove', 'เอาออกจากชุด', true]] : []);
  renderBulkToolbar('groupLibrary', sharedSongs.map((song) => song.id), canEditGroup ? [['addSet', 'เพิ่มในชุดที่เลือก'], ['removeLibrary', 'นำออกจากคลัง', true]] : []);
}

function clearBulkSelection(context) {
  bulkSelection[context].clear();
  document.querySelectorAll(`[data-bulk-select="${context}"]`).forEach((input) => { input.checked = false; });
  renderAllBulkToolbars();
}

async function runBulkAction(context, action) {
  if (action === 'clear') { clearBulkSelection(context); return; }
  const ids = [...bulkSelection[context]];
  if (!ids.length) return;
  try {
    if (context === 'today' && action === 'remove') {
      await persistTodaySetlist(todaySetlist.songIds.filter((id) => !bulkSelection.today.has(id)));
    } else if (context === 'personal' && action === 'addToday') {
      const existing = new Set(todaySetlist.songIds || []);
      await persistTodaySetlist([...(todaySetlist.songIds || []), ...ids.filter((id) => !existing.has(id))]);
    } else if (context === 'personal' && action === 'shareGroup') {
      if (!activeGroup || !canEditActiveGroup() || offlineMode) throw new Error('เลือกกลุ่มและเชื่อมต่ออินเทอร์เน็ตก่อนแชร์เพลง');
      let added = 0; const failed = [];
      for (const id of ids) {
        const song = songs.find((item) => item.id === id);
        if (!song) continue;
        try { await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/songs`, { method: 'POST', body: JSON.stringify({ song }) }); added += 1; }
        catch (error) { failed.push(`${song.title}: ${error.message}`); }
      }
      await loadActiveGroup();
      if (failed.length) notify(`แชร์สำเร็จ ${added} เพลง · ข้าม ${failed.length} เพลง (อาจซ้ำ)`);
      else notify(`เพิ่ม ${added} เพลงเข้าคลังกลุ่มแล้ว`);
    } else if (context === 'personal' && action === 'delete') {
      const selectedSongs = songs.filter((song) => bulkSelection.personal.has(song.id));
      if (!await confirmAction({ title: `ลบ ${selectedSongs.length} เพลงจากคลังส่วนตัว?`, message: 'เพลงจะถูกนำออกจากเพลงของฉันและเพลงวันนี้ การลบชุดนี้ไม่กระทบสำเนาที่แชร์เข้ากลุ่มแล้ว', confirmLabel: 'ลบเพลง', danger: true })) return;
      if (offlineMode || !navigator.onLine) {
        for (const song of selectedSongs) await queueOfflineSongDelete(song);
        setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${(await getSyncQueue()).length} รายการรอซิงก์`);
      } else {
        lastPersonalMutationAt = Date.now();
        try {
          const result = await api('/api/library/songs', { method: 'DELETE', body: JSON.stringify({ songIds: selectedSongs.map((song) => song.id) }) });
          songOrderRevision = result.songOrderRevision ?? songOrderRevision;
          const removed = new Set(selectedSongs.map((song) => song.id));
          for (const id of removed) await deleteFromDb(id);
          songs = await getAllSongs();
          const todayIds = (todaySetlist.songIds || []).filter((id) => !removed.has(id));
          todaySetlist = { ...todaySetlist, songIds: todayIds, revision: Number(todaySetlist.revision || 0) + (todayIds.length !== (todaySetlist.songIds || []).length ? 1 : 0) };
          await saveSetlist(todaySetlist);
        } catch (error) {
          if (!isTransientApiError(error)) throw error;
          offlineMode = true;
          for (const song of selectedSongs) await queueOfflineSongDelete(song);
          setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${(await getSyncQueue()).length} รายการรอซิงก์`);
        }
      }
    } else if (context === 'groupSet' && action === 'remove') {
      if (!activeGroup || !activeWeeklySet || !canEditActiveGroup() || offlineMode) throw new Error('เชื่อมต่อเพื่อแก้ไขชุดเพลงกลุ่ม');
      const selected = new Set(ids);
      await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/setlist`, { method: 'PATCH', body: JSON.stringify({ setId: activeWeeklySet.id, songIds: activeSetSongs.filter((song) => !selected.has(song.id)).map((song) => song.id) }) });
      await loadActiveGroup();
    } else if (context === 'groupLibrary' && action === 'addSet') {
      if (!activeGroup || !activeWeeklySet || !canEditActiveGroup() || offlineMode) throw new Error('เชื่อมต่อเพื่อแก้ไขชุดเพลงกลุ่ม');
      const current = new Set(activeSetSongs.map((song) => song.id));
      const songIds = [...activeSetSongs.map((song) => song.id), ...ids.filter((id) => !current.has(id))];
      await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/setlist`, { method: 'PATCH', body: JSON.stringify({ setId: activeWeeklySet.id, songIds }) });
      await loadActiveGroup();
    } else if (context === 'groupLibrary' && action === 'removeLibrary') {
      if (!activeGroup || !canEditActiveGroup() || offlineMode) throw new Error('เชื่อมต่อเพื่อแก้ไขคลังเพลงกลุ่ม');
      if (!await confirmAction({ title: `นำ ${ids.length} เพลงออกจากคลังกลุ่ม?`, message: 'เพลงจะหายจากคลังที่ใช้ซ้ำ แต่ชุดเพลงที่บันทึกไว้แล้วจะเก็บสำเนาเดิมไว้', confirmLabel: 'นำออกจากคลัง', danger: true })) return;
      await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/songs`, { method: 'DELETE', body: JSON.stringify({ songIds: ids }) });
      await loadActiveGroup();
    }
    clearBulkSelection(context);
    renderGroupPanel(); renderSongRows();
    if (context !== 'personal' || action !== 'shareGroup') notify('จัดการเพลงที่เลือกแล้ว');
  } catch (error) { notify(error.message || 'จัดการเพลงที่เลือกไม่สำเร็จ'); }
}

function bindSongPagers() {
  document.querySelectorAll('.song-pagination').forEach((pager) => pager.addEventListener('click', (event) => {
    const button = event.target.closest('[data-song-page]');
    if (!button || button.disabled) return;
    const { songPage, delta } = { songPage: button.dataset.songPage, delta: Number(button.dataset.delta) };
    songPages[songPage] += delta;
    if (songPage === 'today') renderTodaySongs();
    if (songPage === 'personal') renderSongRows();
    if (songPage === 'group') renderGroupSongs();
    if (songPage === 'groupLibrary') renderGroupLibrary();
  }));
}

function confirmAction({ title, message, confirmLabel = 'ยืนยัน', danger = false }) {
  const dialog = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmAcceptButton').textContent = confirmLabel;
  $('confirmAcceptButton').classList.toggle('danger-button', danger);
  $('confirmAcceptButton').classList.toggle('primary-button', !danger);
  return new Promise((resolve) => {
    const finish = (accepted) => { dialog.close(); resolve(accepted); };
    $('confirmAcceptButton').onclick = () => finish(true);
    $('confirmCancelButton').onclick = () => finish(false);
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.addEventListener('cancel', () => resolve(false), { once: true });
    openAppDialog(dialog);
  });
}

let activeApiRequests = 0;
let requestLoadingTimer = 0;

function setRequestLoading(active, options = {}) {
  activeApiRequests = Math.max(0, activeApiRequests + (active ? 1 : -1));
  const indicator = $('requestLoading');
  if (!indicator) return;
  clearTimeout(requestLoadingTimer);
  if (activeApiRequests > 0) {
    $('requestLoadingText').textContent = options.mutating ? 'กำลังบันทึกข้อมูล…' : 'กำลังโหลดข้อมูล…';
    requestLoadingTimer = setTimeout(() => { indicator.hidden = activeApiRequests === 0; }, 160);
  } else {
    indicator.hidden = true;
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  setRequestLoading(true, { mutating: !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase()) });
  try {
    let response;
    try { response = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' }); }
    catch (error) {
      if (authUser) await enterOfflineMode('อินเทอร์เน็ตหรือเซิร์ฟเวอร์ขาดการเชื่อมต่อ');
      throw error;
    }
    let result = {};
    try { result = await response.json(); } catch { /* Surface a readable status below. */ }
    if (!response.ok) {
      const error = new Error(result.error || `Request failed (${response.status}).`);
      error.status = response.status;
      error.payload = result;
      if (isTransientApiError(error) && authUser) await enterOfflineMode('ฐานข้อมูล/เซิร์ฟเวอร์ไม่พร้อมใช้งาน');
      throw error;
    }
    return result;
  } finally {
    setRequestLoading(false);
  }
}

function sendRealtime(message) {
  if (realtimeSocket?.readyState === 1) realtimeSocket.send(JSON.stringify(message));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function keyIndex(value) {
  const normalized = String(value || 'C').replace('♯', '#').replace('♭', 'b');
  const names = [...SHARP_NAMES, ...FLAT_NAMES];
  const index = names.indexOf(normalized);
  return index < 0 ? 0 : index % 12;
}

function parseRoot(note) {
  const match = /^([A-G])([#b]?)(.*)$/.exec(note);
  if (!match) return null;
  const semitones = (NATURAL[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0) + 12) % 12;
  return { semitones, suffix: match[3] };
}

function strictChordToken(rawToken) {
  const token = String(rawToken || '').replace(/[\[\](){}.,;:|]/g, '').replace(/♯/g, '#').replace(/♭/g, 'b').trim();
  const quality = '(?:(?:maj|min|m|dim|aug|sus2|sus4|sus|add)(?:\\d{1,2})?|\\d{1,2}(?:sus2|sus4|sus|add\\d{1,2})?|-)?';
  const pattern = new RegExp(`^[A-G](?:#|b)?${quality}(?:\\/[A-G](?:#|b)?)?$`);
  return pattern.test(token) ? token : null;
}

function transposeChord(chord, shift, targetKey = 'C') {
  const match = /^([A-G][#b]?)(.*)$/.exec(chord);
  if (!match) return chord;
  const root = parseRoot(match[1]);
  if (!root) return chord;
  let suffix = match[2];
  let bass = '';
  const preferFlatsFor = (note) => FLAT_SPELLING_KEYS.has(targetKey)
    || (!SHARP_SPELLING_KEYS.has(targetKey) && shift === 0 && note.includes('b'));
  const slash = /^(.*)\/([A-G][#b]?)$/.exec(suffix);
  if (slash) {
    suffix = slash[1];
    const bassRoot = parseRoot(slash[2]);
    const names = preferFlatsFor(slash[2]) ? FLAT_NAMES : SHARP_NAMES;
    bass = `/${names[(bassRoot.semitones + shift + 120) % 12]}`;
  }
  const useFlat = preferFlatsFor(match[1]);
  const names = useFlat ? FLAT_NAMES : SHARP_NAMES;
  return `${names[(root.semitones + shift + 120) % 12]}${suffix}${bass}`;
}

// Keep this in sync with strictChordToken: chord quality extensions belong
// after the quality too (e.g. Dm7, Em7, Fmaj7), not only after a bare root.
const CHORD_EXPRESSION_PATTERN = /[A-G](?:#|b)?(?:(?:(?:maj|min|m|dim|aug|sus2|sus4|sus|add)(?:\d{1,2})?)|(?:\d{1,2}(?:sus2|sus4|sus|add\d{1,2})?)|-)?(?:\/[A-G](?:#|b)?)?/g;

function isChordExpression(value) {
  const chords = value.match(CHORD_EXPRESSION_PATTERN) || [];
  const residue = value.replace(CHORD_EXPRESSION_PATTERN, '');
  return chords.length > 0 && /^[\s|,;:/(){}-]*$/.test(residue);
}

function transposeChordExpression(value, shift, targetKey) {
  return value.replace(CHORD_EXPRESSION_PATTERN, (chord) => {
    const parsed = strictChordToken(chord);
    return parsed ? transposeChord(parsed, shift, targetKey) : chord;
  });
}

function displayText(song, targetKey = song?.key || 'C') {
  if (!song) return '';
  const shift = (keyIndex(targetKey) - keyIndex(song.key || 'C') + 12) % 12;
  return String(song.text || '').split(/\r?\n/).map((line) => {
    // Chord lists after section labels (e.g. "INTRO: | A | F#m | E | D |")
    // are plain text rather than [chord] tokens. Only transpose when every
    // non-chord character in the labeled suffix is a list separator.
    const labeledList = /^(\s*(?:intro|midtro|interlude|ending|outro|bridge|tag|verse\s*\d*|pre[-\s]?chorus|chorus|post[-\s]?chorus|vamp|refrain|instrumental)\s*:\s*)(.*)$/i.exec(line);
    if (labeledList) {
      const suffix = labeledList[2];
      if (isChordExpression(suffix)) return labeledList[1] + transposeChordExpression(suffix, shift, targetKey);
    }
    // Older imported songs may have an untagged chord-only row (for example "G C").
    // Transpose those rows too, but never scan ordinary lyrics for chord letters.
    const plainTokens = line.trim().split(/\s+/).filter(Boolean);
    const plainChordRow = !line.includes('[') && !/[\u0E00-\u0E7F]/.test(line) && plainTokens.length > 0
      && plainTokens.some(isChordExpression)
      && plainTokens.every((token) => isChordExpression(token) || /^[|,;:/]+$/.test(token));
    if (plainChordRow) return transposeChordExpression(line, shift, targetKey);

    return line.replace(/\[([^\]]+)\]/g, (whole, value) => {
      const singleChord = strictChordToken(value.trim());
      if (singleChord) return `[${transposeChord(singleChord, shift, targetKey)}]`;
      if (isChordExpression(value.trim())) return `[${transposeChordExpression(value.trim(), shift, targetKey)}]`;
      const tokens = value.trim().split(/(\s+)/);
      const transposed = tokens.map((token) => strictChordToken(token) ? transposeChord(strictChordToken(token), shift, targetKey) : token);
      return `[${transposed.join('')}]`;
    });
  }).join('\n');
}

function chordTokensForKeyEstimate(text) {
  const found = [];
  const addExpression = (value) => {
    const trimmed = value.trim();
    if (!isChordExpression(trimmed)) return;
    for (const match of trimmed.matchAll(CHORD_EXPRESSION_PATTERN)) {
      const token = strictChordToken(match[0]);
      if (token) found.push(token);
    }
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const bracket of line.matchAll(/\[([^\]]+)\]/g)) addExpression(bracket[1]);
    const labeled = /^\s*(?:intro|midtro|interlude|ending|outro|bridge|tag|verse\s*\d*|pre[-\s]?chorus|chorus|post[-\s]?chorus|vamp|refrain|instrumental)\s*:\s*(.*)$/i.exec(line);
    const row = labeled?.[1] || (!line.includes('[') && !/[\u0E00-\u0E7F]/.test(line) ? line : '');
    if (row) addExpression(row);
  }
  return found;
}

function suggestSourceKey(text) {
  const chords = chordTokensForKeyEstimate(text);
  if (!chords.length) return null;
  const majorScale = [0, 2, 4, 5, 7, 9, 11];
  const minorScale = [0, 2, 3, 5, 7, 8, 10];
  const majorQualities = ['major', 'minor', 'minor', 'major', 'major', 'minor', 'dim'];
  const minorQualities = ['minor', 'dim', 'major', 'minor', 'minor', 'major', 'major'];
  const parsed = chords.map((token) => {
    const rootMatch = /^([A-G](?:#|b)?)/.exec(token);
    const root = parseRoot(rootMatch?.[1] || '');
    const suffix = token.slice(rootMatch?.[0].length || 0).split('/')[0].toLowerCase();
    const quality = /dim/.test(suffix) ? 'dim' : /aug/.test(suffix) ? 'aug' : /m|min/.test(suffix) && !/maj/.test(suffix) ? 'minor' : /sus/.test(suffix) ? 'sus' : 'major';
    return root ? { pitch: root.semitones, quality } : null;
  }).filter(Boolean);
  if (!parsed.length) return null;
  const candidates = [];
  for (let tonic = 0; tonic < 12; tonic += 1) for (const mode of ['major', 'minor']) {
    const scale = mode === 'major' ? majorScale : minorScale;
    const qualities = mode === 'major' ? majorQualities : minorQualities;
    let score = 0;
    for (let i = 0; i < parsed.length; i += 1) {
      const chord = parsed[i];
      const degree = scale.indexOf((chord.pitch - tonic + 12) % 12);
      if (degree < 0) { score -= 1.1; continue; }
      score += 1;
      if (chord.quality === 'sus') score += 0.15;
      else score += chord.quality === qualities[degree] ? 0.7 : chord.quality === 'major' && mode === 'minor' && degree === 4 ? 0.35 : -0.4;
      if (degree === 0) score += 0.2;
      if (degree === 4 && parsed[i + 1]?.pitch === tonic) score += 0.65;
    }
    candidates.push({ key: `${SHARP_NAMES[tonic]}${mode === 'minor' ? 'm' : ''}`, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const gap = candidates[0].score - candidates[1].score;
  return { key: candidates[0].key, clarity: parsed.length < 4 || gap < 1 ? 'ไม่ชัด' : gap < 2.2 ? 'พอเป็นไปได้' : 'ค่อนข้างชัด', chordCount: parsed.length };
}

function updateSourceKeyStatus() {
  const suggestion = suggestSourceKey($('chordText').value);
  $('sourceKeySuggestion').hidden = !suggestion;
  $('applyKeySuggestionButton').hidden = !suggestion;
  if (suggestion) $('sourceKeySuggestion').textContent = `จากคอร์ด ระบบคาดว่าอาจเป็น ${suggestion.key} · ความชัดเจน${suggestion.clarity} · ตรวจฟังอีกครั้งก่อนยืนยัน`;
  $('sourceKeyStatus').textContent = editorSourceKeyConfirmed
    ? `ยืนยันคีย์ต้นฉบับ ${$('sourceKeySelect').value} แล้ว`
    : `คีย์ที่เลือก ${$('sourceKeySelect').value} ยังไม่ยืนยัน · ต้องตรงกับคอร์ดในข้อความ`;
  $('confirmSourceKeyButton').textContent = editorSourceKeyConfirmed ? 'ยืนยันแล้ว ✓' : 'ยืนยันคีย์ต้นฉบับ';
  $('confirmSourceKeyButton').disabled = editorSourceKeyConfirmed;
}

function chordHtml(text) {
  return escapeHtml(text).replace(/\[([^\]]+)\]/g, '<span class="chord-token">[$1]</span>');
}

function keyOptionsMarkup(value = 'C') {
  return KEY_NAMES.map((name) => `<option value="${name}" ${name === value ? 'selected' : ''}>${name}</option>`).join('');
}

function keyOptions(select, value = 'C') {
  select.innerHTML = keyOptionsMarkup(value);
  select.title = 'เลือกชื่อคีย์ที่ต้องการ เช่น A# หรือ Bb (เสียงเดียวกัน แต่สะกดต่างกัน)';
}

function activeGroupRole() {
  return activeGroup?.members?.find((member) => member.userId === authUser?.id)?.role || null;
}

function canEditActiveGroup() { return ['owner', 'editor'].includes(activeGroupRole()); }

function weekStartForServiceDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function nextAvailableServiceDate(sets = []) {
  const nowBangkok = new Date(Date.now() + 7 * 60 * 60 * 1000);
  nowBangkok.setUTCDate(nowBangkok.getUTCDate() + ((7 - nowBangkok.getUTCDay()) % 7));
  void sets;
  return nowBangkok.toISOString().slice(0, 10);
}

function updateWeeklyCreateDateHint() {
  const value = $('weeklyServiceDate').value;
  $('weeklyCreateDateHint').textContent = value ? 'ใช้วันเดียวกันสร้างหลายชุดได้ · แต่ละชุดมีลำดับและชื่อแยกกัน' : 'เลือกวันที่ใช้เล่นชุดนี้';
  $('createWeeklySetButton').disabled = !value;
  $('createEmptyWeeklySetButton').disabled = !value;
}

function serviceDateForSet(set) { return set?.serviceDate || set?.end || set?.start || ''; }

function renderWeeklyRecords() {
  if (!activeGroup) return;
  const allSets = activeGroup.weeklySets || [];
  const activeSets = allSets.filter((set) => !set.deletedAt);
  const trashed = allSets.filter((set) => Boolean(set.deletedAt)).sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const history = activeSets.filter((set) => serviceDateForSet(set) < today && set.id !== activeGroup.activeSetId && set.id !== activeWeeklySet?.id).sort((a, b) => serviceDateForSet(b).localeCompare(serviceDateForSet(a)));
  const query = $('weeklyHistorySearch').value.trim().toLocaleLowerCase('th-TH');
  const filtered = history.filter((set) => `${set.name || ''} ${serviceDateForSet(set)}`.toLocaleLowerCase('th-TH').includes(query));
  $('weeklyHistoryCount').textContent = `${history.length} ชุด`;
  $('weeklyTrashCount').textContent = `${trashed.length} ชุด`;
  $('weeklyHistoryList').innerHTML = filtered.map((set) => `<article class="weekly-record-row"><button type="button" class="weekly-record-open" data-open-weekly-set="${escapeHtml(set.id)}"><strong>${escapeHtml(set.name || 'ชุดเพลง')}</strong><small>${escapeHtml(serviceDateForSet(set))} · ${(set.songIds || []).length} เพลง · เปิดดูชุดนี้</small></button>${canEditActiveGroup() && !offlineMode && activeSets.length > 1 ? `<button type="button" class="quiet-button danger-text-button" data-trash-weekly-set="${escapeHtml(set.id)}">ย้ายไปถังขยะ</button>` : ''}</article>`).join('') || `<p class="group-empty">${query ? 'ไม่พบชุดที่ค้นหา' : 'ยังไม่มีชุดย้อนหลัง'}</p>`;
  $('weeklyTrashList').innerHTML = trashed.map((set) => {
    const daysLeft = Math.max(0, Math.ceil((new Date(set.expiresAt || new Date(new Date(set.deletedAt).getTime() + 30 * 86400000)).getTime() - Date.now()) / 86400000));
    return `<article class="weekly-record-row"><span><strong>${escapeHtml(set.name || 'ชุดเพลง')}</strong><small>${escapeHtml(serviceDateForSet(set))} · ${(set.songIds || []).length} เพลง · ลบถาวรใน ${daysLeft} วัน</small></span>${canEditActiveGroup() && !offlineMode ? `<button type="button" class="quiet-button" data-restore-weekly-set="${escapeHtml(set.id)}">กู้คืน</button>` : ''}</article>`;
  }).join('') || '<p class="group-empty">ไม่มีชุดในถังขยะ</p>';
}

function renderGroupPanel() {
  const signedOut = !authUser;
  $('groupPanel').hidden = activeMainTab !== 'group' || (offlineMode && !offlineGroupSnapshot);
  $('groupSignInPrompt').hidden = !signedOut;
  $('groupTools').hidden = signedOut;
  $('inboxButton').hidden = !authUser || offlineMode;
  $('accountButtonLabel').textContent = authUser ? (authUser.displayName || authUser.email.split('@')[0]) : 'เข้าสู่ระบบ';
  $('localBadgeText').textContent = offlineMode ? 'ออฟไลน์ · แก้ไขรอซิงก์' : authUser ? 'ซิงก์เพลงกับบัญชี' : 'เข้าสู่ระบบเพื่อดูเพลง';
  $('newSongButton').disabled = !authUser;
  $('backupButton').disabled = !authUser;
  $('chooseImportFileButton').disabled = !authUser || offlineMode;
  $('exportPersonalButton').disabled = !authUser;
  $('exportGroupButton').disabled = !authUser || offlineMode || groups.length === 0;
  $('createGroupButton').disabled = !authUser || offlineMode;
  $('groupSelect').innerHTML = groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('');
  for (const selectId of ['exportGroupSelect', 'importGroupSelect']) {
    const transferSelect = $(selectId);
    transferSelect.innerHTML = groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('');
    if (activeGroup && groups.some((group) => group.id === activeGroup.id)) transferSelect.value = activeGroup.id;
    transferSelect.disabled = !groups.length || offlineMode;
  }
  updateImportTargetHelp();
  $('groupSelect').disabled = groups.length === 0 || offlineMode;
  if (activeGroup) $('groupSelect').value = activeGroup.id;
  $('weeklySetTools').hidden = !activeGroup || signedOut;
  const allSets = activeGroup?.weeklySets || [];
  const sets = allSets.filter((set) => !set.deletedAt);
  const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const selectableSets = offlineMode
    ? sets.filter((set) => set.id === activeWeeklySet?.id)
    : sets.filter((set) => {
      const date = serviceDateForSet(set);
      return !date || date >= today || set.id === activeGroup?.activeSetId || set.id === activeWeeklySet?.id;
    });
  $('weeklySetSelectLabel').textContent = offlineMode ? 'ชุดที่บันทึกไว้' : 'เลือกชุดเล่น';
  $('weeklySetSelect').innerHTML = selectableSets.slice().sort((a, b) => String(serviceDateForSet(b)).localeCompare(String(serviceDateForSet(a)))).map((set) => {
    const date = serviceDateForSet(set);
    const label = date ? new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)) : (set.name || 'ชุดเพลง');
    return `<option value="${escapeHtml(set.id)}">${escapeHtml(set.name || label)} · ${label}${set.id === activeGroup?.activeSetId ? ' · ชุดหลัก' : ''} · ${(set.songIds || []).length} เพลง</option>`;
  }).join('');
  if (activeWeeklySet) $('weeklySetSelect').value = activeWeeklySet.id;
  $('weeklySetSelect').disabled = offlineMode || selectableSets.length < 2;
  $('weeklySetSelect').title = offlineMode ? 'ออฟไลน์เปิดได้เฉพาะชุดที่บันทึกไว้ · เชื่อมต่อเพื่อเลือกชุดอื่น' : '';
  $('weeklySetSelectHelp').textContent = offlineMode
    ? 'ออฟไลน์เปิดได้เฉพาะชุดที่บันทึกไว้ · ชุดอื่นต้องเชื่อมต่ออินเทอร์เน็ต'
    : 'ชุดที่เล่นแล้วเปิดจาก “ชุดย้อนหลัง”';
  if (!$('weeklyServiceDate').value) {
    $('weeklyServiceDate').value = nextAvailableServiceDate(sets);
  }
  $('createWeeklySetButton').hidden = !canEditActiveGroup() || offlineMode;
  $('createWeeklySetDetails').hidden = !canEditActiveGroup() || offlineMode;
  const activeServiceDate = activeWeeklySet?.serviceDate || activeWeeklySet?.end || '';
  const activeServiceLabel = activeServiceDate ? new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${activeServiceDate}T12:00:00Z`)) : '';
  $('weeklySetHeading').textContent = activeWeeklySet ? `เพลงสำหรับ${activeServiceLabel || 'วันที่เล่น'}${activeWeeklySet.id === activeGroup?.activeSetId ? ' · ชุดปัจจุบัน' : ' · ชุดย้อนหลัง'}` : 'เพลงในชุดที่เลือก';
  $('groupSetPlayCard').hidden = signedOut || !activeGroup;
  $('groupSetPlayDate').textContent = activeServiceLabel || 'ยังไม่กำหนดวัน';
  $('groupSetPlayTitle').textContent = activeWeeklySet?.name || (activeWeeklySet ? 'ชุดเพลงนมัสการ' : 'เลือกชุดเพลงเพื่อเริ่มเล่น');
  const groupSetCount = activeSetSongs.length;
  const nextGroupSong = activeSetSongs[0]?.title || '';
  $('groupSetPlayMeta').textContent = activeWeeklySet
    ? `${groupSetCount} เพลง${nextGroupSong ? ` · เพลงแรก: ${nextGroupSong}` : ' · เพิ่มเพลงเพื่อเริ่มจัดชุด'}`
    : 'เลือกชุดเพลงจากรายการด้านบน';
  $('startGroupSetButton').disabled = !activeWeeklySet || groupSetCount === 0;
  $('startGroupSetButton').title = groupSetCount ? 'เปิดเพลงแรกและแสดงรายการเพลงชุดนี้' : 'เพิ่มเพลงในชุดก่อนเริ่มเล่น';
  $('editWeeklyServiceDateButton').hidden = !activeWeeklySet || !canEditActiveGroup() || offlineMode;
  $('trashWeeklySetButton').hidden = !activeWeeklySet || !canEditActiveGroup() || offlineMode || sets.length <= 1;
  $('weeklyRecordTools').hidden = signedOut || !activeGroup;
  $('weeklyHistoryDetails').hidden = !activeGroup || offlineMode;
  $('weeklyTrashDetails').hidden = !activeGroup || !canEditActiveGroup() || offlineMode;
  renderWeeklyRecords();
  updateWeeklyCreateDateHint();
  const offlineGroupPrepared = Boolean(activeGroup && activeWeeklySet && localStorage.getItem(`${READER_PREFS_KEY}.offlineGroup`) === activeGroup.id && localStorage.getItem(`${READER_PREFS_KEY}.offlineGroupSet`) === activeWeeklySet.id);
  $('prepareOfflineGroupButton').hidden = !activeGroup;
  $('prepareOfflineGroupButton').disabled = offlineMode || !activeGroup;
  $('prepareOfflineGroupButton').textContent = offlineGroupPrepared ? 'ชุดนี้บันทึกแล้ว ✓' : 'บันทึกชุดนี้ไว้ออฟไลน์';
  $('manageGroupButton').hidden = !activeGroup || offlineMode || activeGroupRole() !== 'owner';
  $('groupOfflineHelp').hidden = !activeGroup || offlineMode;
  $('groupOfflineHelp').textContent = offlineGroupPrepared
    ? `บันทึก “${activeWeeklySet?.name || 'ชุดที่เลือก'}” ไว้ในอุปกรณ์แล้ว · เปิดอ่านได้เมื่อออฟไลน์`
    : 'บันทึกชุดที่เลือกไว้ในอุปกรณ์นี้ เพื่อเปิดอ่านเมื่อออฟไลน์ · ใช้ได้เฉพาะเครื่องนี้ และแก้เพลงกลุ่มไม่ได้';
  $('groupOfflineStatus').hidden = !offlineGroupSnapshot;
  if (offlineGroupSnapshot) $('groupOfflineStatus').textContent = `กำลังเปิด “${activeWeeklySet?.name || 'ชุดที่บันทึกไว้'}” จากอุปกรณ์นี้ · อ่านอย่างเดียว · การเปลี่ยนคีย์มีผลเฉพาะอุปกรณ์นี้`;
  $('inviteGroupButton').disabled = offlineMode || !activeGroup || !activeGroupRole();
  $('addGroupSongButton').hidden = !canEditActiveGroup() || offlineMode;
  $('groupLibraryDetails').hidden = !activeGroup;
  $('groupSuggestionDetails').hidden = !activeGroup || !canEditActiveGroup() || offlineMode;
  $('groupDropHint').hidden = !canEditActiveGroup() || offlineMode;
  $('libraryDropHint').hidden = !activeGroup || offlineMode;
  $('groupEmptyState').hidden = signedOut || Boolean(activeGroup);
  $('groupEmptyState').textContent = groups.length ? 'เลือกกลุ่มเพื่อดูเพลงและสมาชิก' : 'สร้างกลุ่มเพื่อแชร์เพลงและลำดับเพลงกับทีมแบบเรียลไทม์';
  $('weeklySongsHeading').hidden = signedOut || !activeGroup;
  renderGroupMembers();
  renderGroupSongs();
  renderGroupLibrary();
  renderGroupSuggestions();
  renderAllBulkToolbars();
  syncSearchVisibility();
}

function renderGroupMembers() {
  if (!activeGroup) { $('groupMembers').innerHTML = ''; return; }
  const members = activeGroup.members || [];
  const canManageMembers = !offlineMode && activeGroupRole() === 'owner';
  $('groupMembers').innerHTML = `<div class="member-summary"><div class="member-summary-copy"><strong>สมาชิก</strong><span>${members.length} คน</span></div><button type="button" id="manageGroupMembersButton" class="quiet-button member-manage-button">${canManageMembers ? 'จัดการสมาชิก' : 'ดูสมาชิก'}</button></div>`;
}

function renderMemberDirectory(members, total, offset, query, role) {
  const ownerCanManage = !offlineMode && activeGroupRole() === 'owner';
  const roleNames = { owner: 'เจ้าของกลุ่ม', editor: 'แก้ไขเพลง', viewer: 'ดูเพลง' };
  $('groupMemberList').innerHTML = members.map((member) => {
    const label = member.displayName || 'สมาชิก WorshipChord';
    const isYou = member.userId === authUser?.id;
    const roleControl = ownerCanManage && member.role !== 'owner'
      ? `<label class="member-role-field"><span>สิทธิ์</span><select data-member-role data-user-id="${escapeHtml(member.userId)}" aria-label="เปลี่ยนสิทธิ์ของ ${escapeHtml(label)}"><option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>ดูเพลง</option><option value="editor" ${member.role === 'editor' ? 'selected' : ''}>แก้ไขเพลง</option></select></label>`
      : `<span class="member-role-badge role-${escapeHtml(member.role || 'viewer')}">${roleNames[member.role] || 'สมาชิก'}</span>`;
    const initial = Array.from(label.trim())[0] || '♪';
    return `<article class="group-member-card"><span class="member-avatar" aria-hidden="true">${escapeHtml(initial)}</span><div class="member-identity"><strong>${escapeHtml(label)}${isYou ? '<span class="member-you">คุณ</span>' : ''}</strong><small>${isYou ? 'บัญชีของคุณ' : 'สมาชิกกลุ่ม'}</small></div>${roleControl}</article>`;
  }).join('');
  $('memberDirectoryEmpty').hidden = total > 0;
  const start = total ? offset + 1 : 0;
  const end = Math.min(offset + members.length, total);
  $('memberPageSummary').textContent = total ? `${start}–${end} จาก ${total} คน` : '0 คน';
  $('memberPrevPage').disabled = offset <= 0;
  $('memberNextPage').disabled = offset + members.length >= total;
  $('memberDialogSubtitle').textContent = `${activeGroup?.name || 'กลุ่ม'} · ${role ? roleNames[role] : 'สมาชิกทั้งหมด'}${query ? ` · ค้นหา “${query}”` : ''}`;
}

async function loadMemberDirectory(offset = 0) {
  if (!activeGroup) return;
  const requestToken = ++memberRequestToken;
  const groupId = activeGroup.id;
  const query = $('memberSearchInput').value.trim();
  const role = $('memberRoleFilter').value;
  memberPageOffset = offset;
  if (offlineMode) {
    const all = activeGroup.members || [];
    const filtered = all.filter((member) => (!role || member.role === role) && (!query || (member.displayName || '').toLocaleLowerCase('th-TH').includes(query.toLocaleLowerCase('th-TH'))));
    renderMemberDirectory(filtered.slice(offset, offset + MEMBER_PAGE_SIZE), filtered.length, offset, query, role);
    return;
  }
  try {
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/members?offset=${offset}&limit=${MEMBER_PAGE_SIZE}&q=${encodeURIComponent(query)}&role=${encodeURIComponent(role)}`);
    if (requestToken !== memberRequestToken || activeGroup?.id !== groupId) return;
    renderMemberDirectory(result.members, result.total, offset, query, role);
  } catch (error) { notify(error.message || 'โหลดรายชื่อสมาชิกไม่สำเร็จ'); }
}

function renderGroupSongs() {
  if (!activeGroup) { $('groupSongList').innerHTML = ''; $('groupSongsPager').hidden = true; return; }
  const canEdit = canEditActiveGroup() && !offlineMode;
  const canCopy = !offlineMode;
  $('groupSongList').innerHTML = pageItems(activeSetSongs, 'group', 'groupSongsPager').map(({ song, index }) => `<article class="group-song-row" data-id="${escapeHtml(song.id)}" draggable="true" aria-grabbed="false">
    ${canEdit ? `<input class="bulk-song-checkbox" type="checkbox" data-bulk-select="groupSet" value="${escapeHtml(song.id)}" aria-label="เลือกเพลง ${escapeHtml(song.title || 'เพลงไม่มีชื่อ')} ในชุด" ${bulkSelection.groupSet.has(song.id) ? 'checked' : ''} />` : ''}<span class="today-order">${String(index + 1).padStart(2, '0')}</span>
    <button class="group-song-open" data-open-group="${escapeHtml(song.id)}"><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${escapeHtml(song.artist || 'ไม่ระบุศิลปิน')} · คีย์ ${escapeHtml(song.displayKey || song.key || 'C')}${song.sourceKeyConfirmed === true ? '' : ' · คีย์ต้นฉบับรอตรวจ'}</small></button>
    <div class="group-song-actions">${canCopy ? `<button class="group-song-copy" data-group-action="copy" data-id="${escapeHtml(song.id)}" aria-label="คัดลอกเพลงไปเพลงของฉัน" title="คัดลอกเป็นเพลงส่วนตัว ไม่กระทบต้นฉบับ">＋ คัดลอก</button>` : ''}${canEdit ? `<button data-group-action="up" data-id="${escapeHtml(song.id)}" aria-label="เลื่อนเพลงกลุ่มขึ้น">↑</button><button data-group-action="down" data-id="${escapeHtml(song.id)}" aria-label="เลื่อนเพลงกลุ่มลง">↓</button><button data-group-action="edit" data-id="${escapeHtml(song.id)}">แก้ไข</button><button data-group-action="remove" data-id="${escapeHtml(song.id)}" aria-label="นำเพลงออกจากกลุ่ม">เอาออก</button>` : ''}</div>
  </article>`).join('');
  const canSuggest = Boolean(activeGroup && activeGroupRole() && !offlineMode && !canEditActiveGroup());
  $('addGroupSongButton').hidden = !canEdit && !canSuggest;
  $('addGroupSongButton').textContent = canEdit ? '＋ เพิ่มเพลง' : '＋ ขอเพิ่มเพลง';
  renderAllBulkToolbars();
}

function renderGroupLibrary() {
  if (!$('groupLibraryDetails')) return;
  if (!activeGroup) { $('groupLibraryList').innerHTML = ''; $('groupLibraryPager').hidden = true; return; }
  const query = $('groupLibrarySearch').value.trim().toLocaleLowerCase('th-TH');
  const items = sharedSongs.filter((song) => `${song.title} ${song.artist || ''}`.toLocaleLowerCase('th-TH').includes(query));
  $('groupLibraryCount').textContent = `${sharedSongs.length} เพลง`;
  $('groupLibraryList').innerHTML = pageItems(items, 'groupLibrary', 'groupLibraryPager').map(({ song, index }) => {
    const confirmed = song.sourceKeyConfirmed === true;
    const inSet = activeSetSongs.some((item) => item.id === song.id);
    const canEdit = canEditActiveGroup() && !offlineMode;
    return `<article class="group-song-row group-library-row"><span class="today-order">${String(index + 1).padStart(2, '0')}</span>${canEdit ? `<input class="bulk-song-checkbox" type="checkbox" data-bulk-select="groupLibrary" value="${escapeHtml(song.id)}" aria-label="เลือกเพลง ${escapeHtml(song.title || 'เพลงไม่มีชื่อ')} ในคลังกลุ่ม" ${bulkSelection.groupLibrary.has(song.id) ? 'checked' : ''} />` : ''}<button type="button" class="group-library-open" data-open-group-library="${escapeHtml(song.id)}"><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${escapeHtml(song.artist || 'ไม่ระบุศิลปิน')} · คีย์ต้นฉบับ ${escapeHtml(song.key || 'C')} · ${confirmed ? 'ยืนยันคีย์แล้ว' : 'คีย์รอตรวจ'}</small></button><div class="group-song-actions">${canEdit ? `<button class="quiet-button" data-add-catalog-song="${escapeHtml(song.id)}" ${inSet ? 'disabled' : ''}>${inSet ? 'อยู่ในชุดแล้ว' : 'เพิ่มในชุดนี้'}</button><button class="quiet-button" data-edit-catalog-song="${escapeHtml(song.id)}">แก้ข้อมูล</button><button class="quiet-button" data-remove-catalog-song="${escapeHtml(song.id)}">นำออก</button>` : ''}</div></article>`;
  }).join('') || `<p class="group-empty">${query ? 'ไม่พบเพลงในคลังกลุ่ม' : 'ยังไม่มีเพลงในคลังกลุ่ม · แชร์จากเพลงของฉันหรือรออนุมัติเพลงที่สมาชิกเสนอ'}</p>`;
  renderAllBulkToolbars();
}

function renderGroupSuggestions() {
  if (!$('groupSuggestionDetails')) return;
  $('groupSuggestionCount').textContent = `${groupSuggestions.length} เพลง`;
  $('groupSuggestionList').innerHTML = groupSuggestions.map((suggestion) => {
    const song = suggestion.song || {};
    const estimate = suggestSourceKey(song.text);
    const suggested = estimate?.key.replace(/m$/, '') || song.key || 'C';
    const options = keyOptionsMarkup(suggested);
    return `<article class="group-suggestion-row"><div class="suggestion-heading"><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><span>เสนอโดย ${escapeHtml(suggestion.suggestedByName || 'สมาชิก')}</span></div><small>${escapeHtml(song.artist || 'ไม่ระบุศิลปิน')} · คีย์ที่ระบุ ${escapeHtml(song.key || 'C')} · ยังไม่ยืนยัน</small><details><summary>ตรวจเนื้อเพลงและคอร์ด</summary><pre>${escapeHtml(song.text || 'ไม่มีเนื้อเพลงแนบ')}</pre></details>${estimate ? `<p class="hint">จากคอร์ดอาจเป็น ${escapeHtml(estimate.key)} · ความชัดเจน${escapeHtml(estimate.clarity)} · คำแนะนำเท่านั้น</p>` : ''}<label class="suggestion-key-label">ยืนยันคีย์ต้นฉบับ<select data-review-key="${escapeHtml(suggestion.id)}">${options}</select></label><div class="group-song-actions"><button class="primary-button" data-review-suggestion="approve" data-id="${escapeHtml(suggestion.id)}">ยืนยันคีย์และเพิ่มเข้าคลัง</button><button class="quiet-button" data-review-suggestion="reject" data-id="${escapeHtml(suggestion.id)}">ปฏิเสธ</button></div></article>`;
  }).join('');
}

async function loadGroupSuggestions() {
  if (!activeGroup || !canEditActiveGroup() || offlineMode) { groupSuggestions = []; renderGroupSuggestions(); return; }
  const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/suggestions`);
  groupSuggestions = result.suggestions || [];
  renderGroupSuggestions();
}

function renderGroupSongPicker() {
  const query = $('groupSongPickerSearch').value.trim().toLocaleLowerCase('th-TH');
  document.querySelectorAll('[data-picker-source]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.pickerSource === groupSongPickerSource)));
  const personalSource = groupSongPickerSource === 'personal';
  const canSuggest = activeGroupRole() === 'viewer';
  document.querySelector('[data-picker-source="group"]').hidden = canSuggest;
  document.querySelector('[data-picker-source="personal"]').hidden = false;
  document.querySelector('.song-picker-sources').classList.toggle('single-source', canSuggest);
  if (canSuggest) groupSongPickerSource = 'personal';
  $('groupSongPickerTitle').textContent = canSuggest ? 'ขอเพิ่มเพลงเข้ากลุ่ม' : 'เพิ่มเพลงในชุดนี้';
  $('groupSongPickerSearch').placeholder = personalSource ? 'ค้นเพลงของฉัน' : 'ค้นเพลงในคลังกลุ่ม';
  $('groupSongPickerHelp').textContent = canSuggest
    ? 'เลือกเพลงส่วนตัวเพื่อส่งคำขอ · เจ้าของหรือผู้แก้ไขจะตรวจคอร์ดและคีย์ก่อนเพิ่มเข้าคลังกลุ่ม'
    : personalSource
    ? 'เพลงที่เลือกจะถูกคัดลอกเข้าคลังเพลงกลุ่มและชุดนี้ · ต้นฉบับส่วนตัวไม่เปลี่ยน'
    : 'เลือกเพลงที่แชร์ไว้ในคลังกลุ่ม เพื่อเพิ่มลงชุดนี้';
  const sourceSongs = personalSource ? songs : sharedSongs;
  const available = sourceSongs.filter((song) => `${song.title} ${song.artist || ''}`.toLocaleLowerCase('th-TH').includes(query));
  $('groupSongPickerEmpty').hidden = available.length > 0;
  $('groupSongPickerEmpty').textContent = available.length ? '' : query ? 'ไม่พบเพลงที่ตรงกัน' : personalSource ? 'ยังไม่มีเพลงส่วนตัวให้เพิ่ม' : 'คลังเพลงกลุ่มยังว่าง';
  $('groupSongPickerList').innerHTML = available.map((song) => {
    if (!personalSource) {
      const alreadyAdded = activeSetSongs.some((item) => item.id === song.id);
      return `<article class="group-song-row"><span><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${escapeHtml(song.artist || 'ไม่ระบุศิลปิน')}</small></span><button class="quiet-button" data-add-to-week="${escapeHtml(song.id)}" ${alreadyAdded ? 'disabled' : ''}>${alreadyAdded ? 'อยู่ในชุดแล้ว' : 'เพิ่มในชุดนี้'}</button></article>`;
    }
    const normalize = (value) => String(value || '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('th-TH');
    const duplicate = sharedSongs.find((item) => normalize(item.title) === normalize(song.title) && normalize(item.artist) === normalize(song.artist));
    const duplicateInSet = duplicate && activeSetSongs.some((item) => item.id === duplicate.id);
    const action = canSuggest
      ? `<button class="quiet-button" data-suggest-personal="${escapeHtml(song.id)}">ขอเพิ่มเพลง</button>`
      : duplicateInSet ? `<button class="quiet-button" disabled>อยู่ในชุดแล้ว</button>` : `<button class="quiet-button" data-import-personal="${escapeHtml(song.id)}">${duplicate ? 'ใช้เพลงในคลังกลุ่ม' : 'คัดลอกเข้ากลุ่ม + ชุดนี้'}</button>`;
    return `<article class="group-song-row"><span><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${escapeHtml(song.artist || 'ไม่ระบุศิลปิน')}${duplicate ? ' · มีในคลังกลุ่มแล้ว' : ''}</small></span>${action}</article>`;
  }).join('');
  $('groupSongPickerWeek').textContent = activeWeeklySet?.name || 'ชุดสัปดาห์';
}

async function importPersonalSongToWeek(songId) {
  if (!activeGroup || !activeWeeklySet || !canEditActiveGroup() || offlineMode) return notify('เพิ่มเพลงจากคลังส่วนตัวต้องออนไลน์และมีสิทธิ์แก้ไขชุด');
  const song = songs.find((item) => item.id === songId);
  if (!song) return notify('ไม่พบเพลงในคลังส่วนตัว');
  const button = [...$('groupSongPickerList').querySelectorAll('[data-import-personal]')].find((item) => item.dataset.importPersonal === songId);
  if (button) { button.disabled = true; button.textContent = 'กำลังเพิ่ม…'; }
  try {
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/sets/${encodeURIComponent(activeWeeklySet.id)}/songs/import`, { method: 'POST', body: JSON.stringify({ song }) });
    await loadActiveGroup();
    renderGroupSongPicker();
    notify(result.imported ? 'คัดลอกเพลงเข้าคลังกลุ่มและเพิ่มลงชุดนี้แล้ว · เพลงส่วนตัวเดิมไม่เปลี่ยน' : 'ใช้เพลงที่มีในคลังกลุ่มและเพิ่มลงชุดนี้แล้ว');
  } catch (error) {
    if (error.payload?.alreadyInSet) { await loadActiveGroup(); renderGroupSongPicker(); }
    else { renderGroupSongPicker(); notify(error.message || 'เพิ่มเพลงลงชุดไม่สำเร็จ'); }
  }
  if (!personalSource && available.length === 0 && activeGroupRole() === 'viewer') $('groupSongPickerEmpty').textContent = 'สมาชิกที่ดูอย่างเดียวส่งคำขอเพลงได้จากแท็บ “เพลงของฉัน”';
}

async function loadGroups(preferredId = activeGroup?.id) {
  if (!authUser || offlineMode) return;
  const previousGroupId = activeGroup?.id;
  const result = await api('/api/groups');
  groups = result.groups;
  searchGroupLibraries.clear();
  const pinnedOfflineGroup = localStorage.getItem(`${READER_PREFS_KEY}.offlineGroup`);
  if (pinnedOfflineGroup && !groups.some((group) => group.id === pinnedOfflineGroup)) {
    localStorage.removeItem(`${READER_PREFS_KEY}.offlineGroup`);
    localStorage.removeItem(`${READER_PREFS_KEY}.offlineGroupSet`);
  }
  offlineGroupSnapshot = false;
  activeGroup = groups.find((group) => group.id === preferredId) || groups[0] || null;
  if (previousGroupId && previousGroupId !== activeGroup?.id) sendRealtime({ type: 'unsubscribe', groupId: previousGroupId });
  renderGroupPanel();
  if (activeGroup) await loadActiveGroup();
  else { sharedSongs = []; sharedSongsGroupId = null; renderGroupPanel(); }
  renderSongRows();
}

async function restoreViewState() {
  const state = readViewState();
  if (!state || !['today', 'group', 'personal'].includes(state.tab)) return;
  if (state.userId && authUser?.id && state.userId !== authUser.id) return;
  restoringViewState = true;
  try {
    if (state.groupId && groups.some((group) => group.id === state.groupId)) {
      activeGroup = groups.find((group) => group.id === state.groupId);
      activeWeeklySet = activeGroup.weeklySets?.find((set) => set.id === state.setId && !set.deletedAt) || null;
      renderGroupPanel();
      await loadActiveGroup();
    }
    activeMainTab = state.tab;
    setMainTab(state.tab);
    if (state.page === 'reader' && state.songId) {
      readerContext = state.readerContext || 'library';
      const contextSongs = readerContextSongs();
      const song = contextSongs.find((item) => item.id === state.songId);
      if (song) {
        openReader(song, readerContext);
        $('readerView').classList.toggle('show-reader-queue', Boolean(state.queueOpen));
        $('readerQueueToggle').setAttribute('aria-expanded', String(Boolean(state.queueOpen)));
        renderReaderQueue();
      }
    } else showView('library');
  } catch (error) {
    console.warn('Could not restore the last view:', error);
    showView('library');
  } finally {
    restoringViewState = false;
    saveViewState();
  }
}

async function loadActiveGroup() {
  if (!authUser || offlineMode || !activeGroup) return;
  const id = activeGroup.id;
  const setId = activeWeeklySet?.id;
  const result = await api(`/api/groups/${encodeURIComponent(id)}${setId ? `?setId=${encodeURIComponent(setId)}` : ''}`);
  if (activeGroup?.id !== id) return;
  activeGroup = result.group;
  sharedSongs = result.librarySongs || result.songs;
  sharedSongsGroupId = id;
  searchGroupLibraries.set(id, { songs: sharedSongs, loadedAt: Date.now() });
  activeWeeklySet = result.activeSet;
  activeSetSongs = result.songs;
  const snapshot = { id: activeGroup.id, group: activeGroup, songs: sharedSongs, activeSet: activeWeeklySet, setSongs: activeSetSongs, savedAt: Date.now() };
  await saveGroupSnapshot(snapshot).catch(() => {});
  await loadGroupSuggestions().catch(() => { groupSuggestions = []; });
  renderGroupPanel();
  sendRealtime({ type: 'subscribe', groupId: id });
}

async function prepareActiveGroupOffline() {
  if (!activeGroup || !activeWeeklySet || offlineMode || (!sharedSongs.length && !activeSetSongs.length)) { notify('เชื่อมต่อและเลือกชุดเพลงก่อน'); return; }
  try {
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}?setId=${encodeURIComponent(activeWeeklySet.id)}`);
    activeGroup = result.group;
    sharedSongs = result.librarySongs || result.songs; sharedSongsGroupId = activeGroup.id; activeWeeklySet = result.activeSet; activeSetSongs = result.songs;
    await saveGroupSnapshot({ id: activeGroup.id, group: activeGroup, songs: sharedSongs, activeSet: activeWeeklySet, setSongs: activeSetSongs, savedAt: Date.now() });
    localStorage.setItem(`${READER_PREFS_KEY}.offlineGroup`, activeGroup.id);
    localStorage.setItem(`${READER_PREFS_KEY}.offlineGroupSet`, activeWeeklySet.id);
    offlineGroupSnapshot = false;
    renderGroupPanel();
    notify(`บันทึก “${activeWeeklySet.name || 'ชุดที่เลือก'}” ไว้เปิดอ่านออฟไลน์แล้ว`);
  } catch (error) { notify(error.message || 'เตรียมกลุ่มออฟไลน์ไม่สำเร็จ'); }
}

function connectRealtime() {
  realtimeSocket?.close();
  if (!authUser || offlineMode || !window.WebSocket) return;
  const socketUrl = new URL(`${API_BASE || location.origin}/realtime`);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketUrl);
  realtimeSocket = socket;
  socket.addEventListener('open', () => {
    if (activeGroup) socket.send(JSON.stringify({ type: 'subscribe', groupId: activeGroup.id }));
    refreshNotifications().catch(() => {});
  });
  socket.addEventListener('message', async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'notification.created') {
      await refreshNotifications();
      notify(message.notificationType === 'group_song_suggestion' ? `มีคำขอเพิ่มเพลง “${message.songTitle || ''}” ให้ตรวจ` : 'มีการแจ้งเตือนใหม่');
    }
    if (message.type === 'library.changed') {
      if (Date.now() - lastPersonalMutationAt < 1500) return;
      clearTimeout(libraryRefreshTimer);
      libraryRefreshTimer = setTimeout(() => refreshPersonalLibraryRealtime().catch((error) => notify(error.message)), 120);
    }
    if (message.type === 'groups.changed') {
      try { await loadGroups(); } catch { /* Keep the current local songbook usable. */ }
    }
    if (message.type === 'group.changed' && message.groupId === activeGroup?.id) {
      if (message.change === 'group_deleted') {
        if (!$('readerView').hidden && ['group', 'groupLibrary'].includes(readerContext)) showView('library');
        activeGroup = null; sharedSongs = []; sharedSongsGroupId = null;
        try { await loadGroups(); } catch { renderGroupPanel(); }
        return;
      }
      try {
        const readerWasOpen = !$('readerView').hidden && ['group', 'groupLibrary'].includes(readerContext);
        const currentId = currentSong?.id;
        await loadActiveGroup();
        if (readerWasOpen) syncGroupSongInReader(currentId);
        if (message.change === 'song_key_changed' && message.updatedBy !== authUser?.id) notify('คีย์เพลงกลุ่มอัปเดตแล้ว');
      } catch { /* A later refresh will repair the view. */ }
    }
  });
  socket.addEventListener('close', () => {
    activeSocketsafeClose(socket);
  });
  function activeSocketsafeClose(closedSocket) {
    if (realtimeSocket !== closedSocket || !authUser) return;
    setTimeout(() => { if (realtimeSocket === closedSocket && authUser) connectRealtime(); }, 3500);
  }
}

async function refreshNotifications() {
  if (!authUser || offlineMode) return;
  const result = await api('/api/notifications');
  notifications = result.notifications;
  const unread = notifications.filter((item) => !item.readAt).length;
  $('inboxBadge').textContent = unread > 99 ? '99+' : String(unread);
  $('inboxBadge').hidden = unread === 0;
  renderNotifications();
}

async function openSongSuggestionFromNotification(notification) {
  if (offlineMode) { notify('เปิดคำขอเพลงต้องเชื่อมต่ออินเทอร์เน็ต'); return; }
  if (notification.id) {
    await api(`/api/notifications/${encodeURIComponent(notification.id)}`, { method: 'PATCH', body: '{}' });
    await refreshNotifications();
  }
  await loadGroups(notification.groupId);
  $('inboxDialog').close();
  if (!activeGroup || activeGroup.id !== notification.groupId) { notify('ไม่พบกลุ่มนี้หรือคุณไม่มีสิทธิ์แล้ว'); return; }
  setMainTab('group');
  if (!canEditActiveGroup()) { notify('ตอนนี้บัญชีนี้ไม่มีสิทธิ์ตรวจคำขอเพลง'); return; }
  $('groupSuggestionDetails').open = true;
  $('groupSuggestionDetails').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (notification.suggestionStatus === 'approved') notify(`คำขอ “${notification.songTitle || 'เพลง'}” ได้รับอนุมัติแล้ว`);
  else if (notification.suggestionStatus === 'rejected') notify(`คำขอ “${notification.songTitle || 'เพลง'}” ถูกปฏิเสธแล้ว`);
  else notify('เปิดคิวคำขอเพลงแล้ว');
}

function renderNotifications() {
  $('notificationEmpty').hidden = notifications.length > 0;
  $('notificationList').innerHTML = notifications.map((item) => {
    const invitePending = item.type === 'group_invite' && item.invitationStatus === 'pending';
    const message = item.type === 'group_invite'
      ? `${escapeHtml(item.inviterName || 'สมาชิก')} เชิญเข้ากลุ่ม “${escapeHtml(item.groupName || '')}” (${item.role === 'editor' ? 'แก้ไขได้' : 'ดูได้'})`
      : item.type === 'group_owner_transferred'
        ? `โอนสิทธิ์เจ้าของกลุ่ม “${escapeHtml(item.groupName || '')}” จาก ${escapeHtml(item.previousOwnerName || 'เจ้าของเดิม')} ให้ ${escapeHtml(item.newOwnerName || 'เจ้าของใหม่')} แล้ว`
      : item.type === 'group_song_suggestion'
        ? item.suggestionStatus === 'approved'
          ? `คำขอเพิ่มเพลง “${escapeHtml(item.songTitle || '')}” ของ ${escapeHtml(item.requesterName || 'สมาชิก')} ในกลุ่ม “${escapeHtml(item.groupName || '')}” ได้รับอนุมัติแล้ว`
          : item.suggestionStatus === 'rejected'
            ? `คำขอเพิ่มเพลง “${escapeHtml(item.songTitle || '')}” ของ ${escapeHtml(item.requesterName || 'สมาชิก')} ในกลุ่ม “${escapeHtml(item.groupName || '')}” ถูกปฏิเสธแล้ว`
            : `${escapeHtml(item.requesterName || 'สมาชิก')} ขอเพิ่มเพลง “${escapeHtml(item.songTitle || '')}” เข้ากลุ่ม “${escapeHtml(item.groupName || '')}”`
      : item.type === 'invitation_response'
        ? `${escapeHtml(item.recipientEmail || 'สมาชิก')} ${item.decision === 'accepted' ? 'ตอบรับ' : 'ปฏิเสธ'}คำเชิญเข้ากลุ่ม “${escapeHtml(item.groupName || '')}”`
        : `มีความเปลี่ยนแปลงในกลุ่ม “${escapeHtml(item.groupName || '')}”`;
    const date = item.createdAt ? new Date(item.createdAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const actions = invitePending
      ? `<div class="notification-actions"><button class="accept-invite" data-notification-action="accept" data-id="${escapeHtml(item.invitationId)}">เข้าร่วมกลุ่ม</button><button data-notification-action="decline" data-id="${escapeHtml(item.invitationId)}">ปฏิเสธ</button></div>`
      : item.type === 'group_song_suggestion' && item.suggestionStatus === 'pending'
        ? `<div class="notification-actions"><button data-notification-action="open-suggestions" data-id="${escapeHtml(item.id)}" data-group-id="${escapeHtml(item.groupId || '')}">ตรวจคำขอ</button></div>`
        : !item.readAt ? `<div class="notification-actions"><button data-notification-action="read" data-id="${escapeHtml(item.id)}">ทำเครื่องหมายว่าอ่านแล้ว</button></div>` : '';
    return `<article class="notification-item ${item.readAt ? '' : 'unread'}"><div class="notification-copy">${message}</div><div class="notification-time">${escapeHtml(date)}</div>${actions}</article>`;
  }).join('');
}

async function respondToInvitation(invitationId, decision) {
  if (offlineMode) { notify('การตอบรับคำเชิญต้องเชื่อมต่ออินเทอร์เน็ต'); return; }
  await api(`/api/invitations/${encodeURIComponent(invitationId)}/respond`, { method: 'POST', body: JSON.stringify({ decision }) });
  await Promise.all([refreshNotifications(), loadGroups()]);
  notify(decision === 'accept' ? 'เข้าร่วมกลุ่มแล้ว' : 'ปฏิเสธคำเชิญแล้ว');
}

async function shareSongToGroup(songId) {
  if (offlineMode) { notify('การแชร์เพลงเข้ากลุ่มต้องเชื่อมต่ออินเทอร์เน็ต'); return; }
  if (!activeGroup || !canEditActiveGroup()) return;
  const song = songs.find((item) => item.id === songId);
  if (!song) return;
  try {
    await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/songs`, { method: 'POST', body: JSON.stringify({ song }) });
    await loadActiveGroup();
    notify('เพิ่มเพลงเข้าคลังกลุ่มแล้ว · เพิ่มลงชุดเล่นได้จากคลัง');
  } catch (error) {
    notify(error.message || 'แชร์เพลงไม่สำเร็จ');
  }
}

async function suggestSongToGroup(songId) {
  if (offlineMode) { notify('การเสนอเพลงเข้ากลุ่มต้องเชื่อมต่ออินเทอร์เน็ต'); return; }
  if (!activeGroup) return notify('เลือกกลุ่มก่อนเสนอเพลง');
  const song = songs.find((item) => item.id === songId);
  if (!song) return;
  await submitSongSuggestion(song);
}

async function submitSongSuggestion(song) {
  if (offlineMode) { notify('การเสนอเพลงเข้ากลุ่มต้องเชื่อมต่ออินเทอร์เน็ต'); return; }
  if (!activeGroup || !song) return;
  try {
    await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/suggestions`, { method: 'POST', body: JSON.stringify({ song }) });
    notify('ส่งคำขอแล้ว · ผู้แก้ไขจะตรวจคอร์ดและคีย์ก่อนเพิ่มเข้าคลังกลุ่ม');
    return true;
  } catch (error) { notify(error.message || 'เสนอเพลงไม่สำเร็จ'); }
  return false;
}

async function reviewGroupSuggestion(suggestionId, action) {
  if (!activeGroup || !canEditActiveGroup() || offlineMode) return;
  const select = [...$('groupSuggestionList').querySelectorAll('[data-review-key]')].find((item) => item.dataset.reviewKey === suggestionId);
  const body = action === 'approve' ? { action, key: select?.value || 'C', confirmSourceKey: true } : { action };
  try {
    await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/suggestions/${encodeURIComponent(suggestionId)}`, { method: 'PATCH', body: JSON.stringify(body) });
    await loadActiveGroup();
    notify(action === 'approve' ? 'ยืนยันคีย์และเพิ่มเพลงเข้าคลังกลุ่มแล้ว · เพิ่มลงชุดที่ต้องการได้จากคลัง' : 'ปฏิเสธเพลงที่เสนอแล้ว');
  } catch (error) { notify(error.message || 'จัดการเพลงที่เสนอไม่สำเร็จ'); }
}

async function removeSongFromGroupLibrary(songId) {
  const song = sharedSongs.find((item) => item.id === songId);
  if (!song || !activeGroup || !canEditActiveGroup() || offlineMode) return;
  if (!await confirmAction({ title: 'นำเพลงออกจากคลังกลุ่ม?', message: `“${song.title}” จะหายจากคลังที่ใช้เพิ่มเพลงใหม่ ชุดที่บันทึกไว้แล้วจะยังเก็บสำเนาของเพลงไว้`, confirmLabel: 'นำออกจากคลัง', danger: true })) return;
  try {
    await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/songs/${encodeURIComponent(song.id)}`, { method: 'DELETE' });
    await loadActiveGroup();
    notify('นำเพลงออกจากคลังกลุ่มแล้ว · ชุดเดิมยังเปิดดูได้');
  } catch (error) { notify(error.message || 'นำเพลงออกจากคลังไม่สำเร็จ'); }
}

async function copyGroupSongToLibrary(songId) {
  if (!authUser) return;
  const source = sharedSongs.find((song) => song.id === songId);
  if (!source) return;
  const key = source.displayKey || source.key || 'C';
  const song = {
    title: source.title,
    artist: source.artist,
    key,
    text: displayText(source, key),
    youtubeUrl: source.youtubeUrl || '',
    chordUrl: source.chordUrl || '',
    sourceKeyConfirmed: source.sourceKeyConfirmed === true
  };
  try {
    lastPersonalMutationAt = Date.now();
    const result = await api('/api/library/songs', { method: 'POST', body: JSON.stringify({ song }) });
    await saveToDb(result.song);
    songs = await getAllSongs();
    renderSongRows();
    notify(`คัดลอกไปเพลงของฉันแล้ว · คีย์ ${key} · ต้นฉบับในกลุ่มไม่เปลี่ยน`);
  } catch (error) {
    notify(error.message || 'คัดลอกเพลงไม่สำเร็จ');
  }
}

async function refreshInvalidGroupSongId() {
  if (/^[a-f\d]{24}$/i.test(String(currentSong?.id || ''))) return true;
  if (!activeGroup || offlineMode) return false;
  const title = String(currentSong?.title || '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('th-TH');
  const artist = String(currentSong?.artist || '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('th-TH');
  try {
    await loadActiveGroup();
    const candidates = readerContext === 'groupLibrary' ? sharedSongs : activeSetSongs;
    const refreshed = candidates.find((song) => /^[a-f\d]{24}$/i.test(String(song.id || ''))
      && String(song.title || '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('th-TH') === title
      && String(song.artist || '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('th-TH') === artist);
    if (!refreshed) return false;
    currentSong = refreshed;
    return true;
  } catch { return false; }
}

async function setGroupDisplayKey(key) {
  if (readerContext !== 'group' || !currentSong || !activeGroup || !activeWeeklySet || (!canEditActiveGroup() && !(offlineMode && offlineGroupSnapshot))) return false;
  if (!offlineMode && !await refreshInvalidGroupSongId()) {
    notify('รหัสเพลงในหน้าที่เปิดไม่ตรงกับคลังกลุ่มล่าสุด โหลดเพลงใหม่แล้วลองเปลี่ยนคีย์อีกครั้ง');
    return false;
  }
  if (key === (currentSong.displayKey || currentSong.key || 'C')) return true;
  if (offlineMode && offlineGroupSnapshot) {
    return setOfflineGroupDisplayKey(key);
  }
  try {
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/sets/${encodeURIComponent(activeWeeklySet.id)}/songs/${encodeURIComponent(currentSong.id)}/display-key`, {
      method: 'PATCH',
      body: JSON.stringify({ key, expectedRevision: currentSong.revision || 1 })
    });
    currentSong = result.song;
    activeSetSongs = activeSetSongs.map((song) => song.id === result.song.id ? result.song : song);
    activeWeeklySet = { ...activeWeeklySet, songSnapshots: result.activeSet.songSnapshots };
    await saveGroupSnapshot({ id: activeGroup.id, group: activeGroup, songs: sharedSongs, activeSet: activeWeeklySet, setSongs: activeSetSongs, savedAt: Date.now() }).catch(() => {});
    $('readerKeySelect').value = result.song.displayKey || result.song.key;
    renderChordContent($('readerChords'), result.song, $('readerKeySelect').value);
    renderGroupSongs();
    notify(`เปลี่ยนคีย์เฉพาะชุดนี้เป็น ${key} แล้ว`);
    return true;
  } catch (error) {
    notify(error.message || 'เปลี่ยนคีย์กลุ่มไม่สำเร็จ');
    const latest = error.payload?.song || activeSetSongs.find((song) => song.id === currentSong?.id);
    if (latest) {
      currentSong = latest;
      activeSetSongs = activeSetSongs.map((song) => song.id === latest.id ? latest : song);
      $('readerKeySelect').value = latest.displayKey || latest.key || 'C';
      renderChordContent($('readerChords'), latest, $('readerKeySelect').value);
      renderGroupSongs();
    }
    return false;
  }
}

async function setOfflineGroupDisplayKey(key) {
  if (!offlineMode || !offlineGroupSnapshot || !currentSong || !activeGroup) return false;
  currentSong = { ...currentSong, displayKey: key };
  if (readerContext === 'group') activeSetSongs = activeSetSongs.map((song) => song.id === currentSong.id ? currentSong : song);
  else if (readerContext === 'groupLibrary') sharedSongs = sharedSongs.map((song) => song.id === currentSong.id ? currentSong : song);
  await saveGroupSnapshot({ id: activeGroup.id, group: activeGroup, songs: sharedSongs, activeSet: activeWeeklySet, setSongs: activeSetSongs, savedAt: Date.now() }).catch(() => {});
  renderGroupSongs();
  renderGroupLibrary();
  $('readerKeySelect').value = key;
  renderChordContent($('readerChords'), currentSong, key);
  renderReaderQueue();
  notify(`เปลี่ยนคีย์เฉพาะเครื่องนี้เป็น ${key} · ไม่ได้เปลี่ยนเพลงในกลุ่ม`);
  return true;
}

function syncGroupSongInReader(songId) {
  if (!songId || currentSong?.id !== songId) return;
  const updated = readerContext === 'groupLibrary'
    ? sharedSongs.find((song) => song.id === songId)
    : activeSetSongs.find((song) => song.id === songId) || sharedSongs.find((song) => song.id === songId);
  if (!updated) { showView('library'); notify('เพลงนี้ถูกนำออกจากกลุ่มแล้ว'); return; }
  currentSong = updated;
  $('readerTitle').textContent = updated.title || 'เพลงไม่มีชื่อ';
  $('readerArtist').textContent = updated.artist || 'WORSHIP SONG';
  $('readerEditButton').hidden = !canEditActiveGroup() || offlineMode;
  setReaderKeyGuidance(readerContext);
  keyOptions($('readerKeySelect'), updated.displayKey || updated.key || 'C');
  renderChordContent($('readerChords'), updated, $('readerKeySelect').value);
  renderReaderQueue();
}

function setReaderKeyGuidance(context) {
  const groupContext = context === 'group' || context === 'groupLibrary';
  const groupLibraryContext = context === 'groupLibrary';
  const offlineGroupEditor = groupContext && canEditActiveGroup() && offlineMode && offlineGroupSnapshot;
  const sharedEditor = groupContext && canEditActiveGroup() && !offlineMode;
  const sharedViewer = groupContext && !sharedEditor;
  $('readerKeyLabel').textContent = sharedEditor ? (groupLibraryContext ? 'คีย์คลังกลุ่ม' : 'คีย์เพลงชุดนี้') : offlineGroupEditor ? 'คีย์เฉพาะเครื่องนี้' : sharedViewer ? 'คีย์ส่วนตัว' : 'คีย์แสดงผล';
  $('readerKeyScopeHint').textContent = sharedEditor
    ? (groupLibraryContext ? 'สมาชิกกลุ่มเห็นคีย์นี้ร่วมกัน · ชุดที่บันทึกไว้ไม่เปลี่ยน' : 'สมาชิกที่เปิดชุดนี้เห็นทันที · ชุดอื่นไม่เปลี่ยน')
    : offlineGroupEditor
      ? 'ออฟไลน์ · เปลี่ยนคีย์ได้เฉพาะอุปกรณ์นี้ และเก็บไว้กับสำเนาออฟไลน์'
      : sharedViewer
      ? 'ปรับเฉพาะหน้าคุณ · ไม่เปลี่ยนคีย์ที่สมาชิกคนอื่นเห็น'
      : 'ปรับคอร์ดที่แสดงสำหรับคุณ · ไม่แก้เนื้อเพลงหรือคีย์ต้นฉบับ';
  $('readerKeySelect').setAttribute('aria-label', sharedEditor ? 'เปลี่ยนคีย์เพลงสำหรับชุดที่เลือก' : offlineGroupEditor || sharedViewer ? 'ปรับคีย์เฉพาะอุปกรณ์นี้' : 'เลือกคีย์แสดงผล');
  $('readerSourceKeyButton').title = sharedEditor
    ? (groupLibraryContext ? 'ตั้งคีย์ในคลังกลุ่มกลับเป็นคีย์ต้นฉบับ' : 'ตั้งคีย์ชุดนี้กลับเป็นคีย์ต้นฉบับ')
    : offlineGroupEditor ? 'แสดงเพลงในคีย์ต้นฉบับเฉพาะอุปกรณ์นี้' : 'แสดงเพลงในคีย์ต้นฉบับ';
  $('readerSourceKeyWarning').hidden = !groupContext || currentSong?.sourceKeyConfirmed === true;
}

async function setGroupLibraryDisplayKey(key) {
  if (offlineMode && offlineGroupSnapshot) return setOfflineGroupDisplayKey(key);
  if (!currentSong || !activeGroup || !canEditActiveGroup() || offlineMode) return false;
  if (!await refreshInvalidGroupSongId()) {
    notify('รหัสเพลงในหน้าที่เปิดไม่ตรงกับคลังกลุ่มล่าสุด โหลดเพลงใหม่แล้วลองเปลี่ยนคีย์อีกครั้ง');
    return false;
  }
  if (key === (currentSong.displayKey || currentSong.key || 'C')) return true;
  try {
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/songs/${encodeURIComponent(currentSong.id)}/display-key`, { method: 'PATCH', body: JSON.stringify({ key, expectedRevision: currentSong.revision || 1 }) });
    currentSong = result.song;
    sharedSongs = sharedSongs.map((song) => song.id === currentSong.id ? currentSong : song);
    $('readerKeySelect').value = currentSong.displayKey || currentSong.key;
    renderChordContent($('readerChords'), currentSong, $('readerKeySelect').value);
    renderGroupLibrary();
    notify(`เปลี่ยนคีย์ในคลังกลุ่มเป็น ${key} แล้ว`);
    return true;
  } catch (error) { notify(error.message || 'เปลี่ยนคีย์คลังกลุ่มไม่สำเร็จ'); return false; }
}

async function hydrateAccount() {
  let user;
  try {
    const result = await api('/api/me');
    user = result.user;
    await loadPrivateLibrary(user);
  } catch (error) {
    if (isTransientApiError(error)) {
      const remembered = loadRememberedUser();
      if (remembered) {
        try {
          await loadPrivateLibrary(remembered, false);
          renderGroupPanel();
          renderSongRows();
          const queue = await getSyncQueue();
          if (queue.some((item) => item.conflictLibrary)) {
            const conflict = queue.find((item) => item.conflictLibrary);
            pendingSyncConflict = conflict.id;
            showSyncConflict(conflict);
          } else if (queue.length) await syncPendingChanges();
          if (offlineMode) { await restoreViewState(); return; }
          try {
            await Promise.all([loadGroups(), refreshNotifications()]);
            connectRealtime();
            await restoreViewState();
          } catch (groupError) {
            if (isTransientApiError(groupError)) await enterOfflineMode('ฐานข้อมูลไม่พร้อมใช้งาน');
            else notify(`โหลดกลุ่มไม่สำเร็จ: ${groupError.message}`);
          }
          return;
        } catch { /* A stale profile without a local database cannot open private data. */ }
      }
    } else {
      localStorage.removeItem(LAST_USER_KEY);
    }
    authUser = null;
    offlineMode = false;
    songs = [];
    todaySetlist = { id: TODAY_SETLIST_ID, name: 'เพลงวันนี้', songIds: [] };
    groups = [];
    activeGroup = null;
    sharedSongs = [];
    sharedSongsGroupId = null;
    searchGroupLibraries.clear();
    pendingSearchGroupLoads.clear();
    renderGroupPanel();
    renderSongRows();
    setConnectivityBanner('');
    return;
  }
  renderGroupPanel();
  renderSongRows();
  const queue = await getSyncQueue();
  if (queue.some((item) => item.conflictLibrary)) {
    const conflict = queue.find((item) => item.conflictLibrary);
    pendingSyncConflict = conflict.id;
    showSyncConflict(conflict);
  } else if (queue.length && !offlineMode) await syncPendingChanges();
  if (offlineMode) return;
  try {
    await Promise.all([loadGroups(), refreshNotifications()]);
    connectRealtime();
    await restoreViewState();
  } catch (error) {
    if (isTransientApiError(error)) await enterOfflineMode('ฐานข้อมูลไม่พร้อมใช้งาน');
    else notify(`โหลดกลุ่มไม่สำเร็จ: ${error.message}`);
  }
}

function updateAccountDialog() {
  $('accountDialogHeading').textContent = authUser ? 'บัญชีของฉัน' : (authMode === 'register' ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ');
  $('accountForm').hidden = Boolean(authUser);
  $('signedInPanel').hidden = !authUser;
  $('displayNameField').hidden = authMode !== 'register' || Boolean(authUser);
  $('accountSubmitButton').textContent = authMode === 'register' ? 'สร้างบัญชี' : 'เข้าสู่ระบบ';
  $('accountModeButton').textContent = authMode === 'register' ? 'มีบัญชีแล้ว? เข้าสู่ระบบ' : 'ยังไม่มีบัญชี? สมัครสมาชิก';
  $('accountPassword').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
  $('forgotPasswordButton').hidden = authMode !== 'login' || Boolean(authUser);
  $('accountError').hidden = true;
  $('signedInLabel').textContent = authUser ? `${authUser.displayName || authUser.email} · ${authUser.email}` : '';
  $('accountPublicId').textContent = authUser?.publicId ? `ID สำหรับค้นหา: ${authUser.publicId}` : 'กำลังเตรียม ID บัญชี…';
}

function openGroupSettings(create = false) {
  if (offlineMode) { notify('การจัดการกลุ่มต้องเชื่อมต่ออินเทอร์เน็ต'); return; }
  $('groupSettingsTitle').textContent = create ? 'สร้างกลุ่มเพลง' : 'ตั้งค่ากลุ่ม';
  $('groupSettingsHelp').textContent = create ? 'สร้างพื้นที่แชร์เพลงและลำดับเพลงกับทีม' : `แก้ชื่อกลุ่ม “${activeGroup?.name || ''}”`;
  $('groupNameInput').value = create ? '' : activeGroup?.name || '';
  $('groupSettingsError').hidden = true;
  $('deleteGroupButton').hidden = create;
  const transferSection = $('groupOwnerTransfer');
  const eligibleOwners = (activeGroup?.members || []).filter((item) => item.userId !== authUser?.id);
  transferSection.hidden = create || activeGroupRole() !== 'owner' || eligibleOwners.length === 0;
  $('groupOwnerTarget').innerHTML = eligibleOwners.map((item) => {
    const roleName = item.role === 'editor' ? 'ผู้แก้ไข' : 'ผู้ดู';
    const account = item.email || item.userId;
    return `<option value="${escapeHtml(item.userId)}">${escapeHtml(item.displayName || account)} · ${escapeHtml(account)} · ${roleName}</option>`;
  }).join('');
  $('saveGroupNameButton').textContent = create ? 'สร้างกลุ่ม' : 'บันทึกชื่อ';
  $('groupNameForm').dataset.mode = create ? 'create' : 'rename';
  openAppDialog($('groupSettingsDialog'));
  $('groupNameInput').focus();
}

async function transferActiveGroupOwnership() {
  if (!activeGroup || offlineMode || activeGroupRole() !== 'owner') return;
  const group = activeGroup;
  const targetId = $('groupOwnerTarget').value;
  const target = group.members?.find((item) => item.userId === targetId);
  if (!target) { notify('เลือกสมาชิกที่จะรับโอนก่อน'); return; }
  const targetName = target.displayName || target.email || 'สมาชิก';
  const confirmed = await confirmAction({
    title: 'โอนสิทธิ์เจ้าของกลุ่ม?',
    message: `โอนกลุ่ม “${group.name}” ให้ ${targetName} หรือไม่?\n\nหลังโอน ${targetName} จะเป็นเจ้าของกลุ่ม และคุณจะเป็นผู้แก้ไข สามารถแก้ไขเพลงได้แต่จัดการเจ้าของกลุ่มไม่ได้`,
    confirmLabel: 'โอนสิทธิ์'
  });
  if (!confirmed) return;
  const button = $('transferGroupOwnerButton');
  button.disabled = true;
  try {
    await api(`/api/groups/${encodeURIComponent(group.id)}/transfer-owner`, { method: 'POST', body: JSON.stringify({ newOwnerId: targetId }) });
    $('groupSettingsDialog').close();
    await loadGroups(group.id);
    connectRealtime();
    notify(`โอนสิทธิ์เจ้าของให้ ${targetName} แล้ว · คุณเป็นผู้แก้ไข`);
  } catch (error) {
    $('groupSettingsError').textContent = error.message || 'โอนสิทธิ์เจ้าของไม่สำเร็จ';
    $('groupSettingsError').hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function saveGroupName(event) {
  event.preventDefault();
  const create = $('groupNameForm').dataset.mode === 'create';
  const name = $('groupNameInput').value.trim();
  try {
    const result = create
      ? await api('/api/groups', { method: 'POST', body: JSON.stringify({ name }) })
      : await api(`/api/groups/${encodeURIComponent(activeGroup.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    $('groupSettingsDialog').close();
    await loadGroups(result.group.id);
    connectRealtime();
    notify(create ? 'สร้างกลุ่มแล้ว' : 'เปลี่ยนชื่อกลุ่มแล้ว');
  } catch (error) { $('groupSettingsError').textContent = error.message; $('groupSettingsError').hidden = false; }
}

async function deleteActiveGroup() {
  if (!activeGroup || offlineMode || activeGroupRole() !== 'owner') return;
  const group = activeGroup;
  const confirmed = await confirmAction({ title: 'ลบกลุ่มนี้หรือไม่?', message: `กลุ่ม “${group.name}” และเพลงที่แชร์ทั้งหมดจะถูกลบ สมาชิกจะไม่เห็นกลุ่มนี้อีก การลบย้อนกลับไม่ได้`, confirmLabel: 'ลบกลุ่ม', danger: true });
  if (!confirmed) return;
  try {
    await api(`/api/groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
    if (localStorage.getItem(`${READER_PREFS_KEY}.offlineGroup`) === group.id) {
      localStorage.removeItem(`${READER_PREFS_KEY}.offlineGroup`);
      localStorage.removeItem(`${READER_PREFS_KEY}.offlineGroupSet`);
    }
    $('groupSettingsDialog').close();
    activeGroup = null; sharedSongs = []; sharedSongsGroupId = null; offlineGroupSnapshot = false;
    await loadGroups();
    connectRealtime();
    notify('ลบกลุ่มแล้ว');
  } catch (error) { $('groupSettingsError').textContent = error.message; $('groupSettingsError').hidden = false; }
}

async function createWeeklySet(copyPrevious = true) {
  if (!activeGroup || !canEditActiveGroup() || offlineMode) return;
  try {
    const serviceDate = $('weeklyServiceDate').value;
    if (!serviceDate) { notify('เลือกวันที่ใช้เล่นชุดก่อน'); return; }
    const name = $('weeklyServiceName').value.trim();
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/sets`, { method: 'POST', body: JSON.stringify({ copyPrevious, copyFrom: activeWeeklySet?.id, serviceDate, name }) });
    activeGroup = result.group; activeWeeklySet = result.activeSet; activeSetSongs = sharedSongs.filter((song) => activeWeeklySet.songIds.includes(song.id));
    $('weeklyServiceName').value = '';
    await loadActiveGroup();
    saveViewState();
    notify(`สร้าง “${activeWeeklySet.name}” แล้ว`);
  } catch (error) { notify(error.message); }
}

async function trashWeeklySet(setId = activeWeeklySet?.id) {
  if (!activeGroup || !setId || !canEditActiveGroup() || offlineMode) return;
  const set = activeGroup.weeklySets?.find((item) => item.id === setId);
  if (!set) return;
  const isActive = set.id === activeGroup.activeSetId;
  if (!await confirmAction({ title: 'ย้ายชุดเพลงไปถังขยะ?', message: `“${set.name || 'ชุดเพลง'}” จะซ่อนจากรายการใช้งาน แต่กู้คืนได้จากถังขยะ${isActive ? ' และระบบจะเลือกชุดอื่นเป็นชุดหลัก' : ''}`, confirmLabel: 'ย้ายไปถังขยะ', danger: true })) return;
  try {
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/sets/${encodeURIComponent(setId)}`, { method: 'DELETE' });
    activeGroup = result.group;
    if (isActive) activeWeeklySet = activeGroup.weeklySets.find((item) => item.id === activeGroup.activeSetId) || null;
    await loadActiveGroup();
    renderGroupPanel();
    saveViewState();
    notify('ย้ายชุดไปถังขยะแล้ว · กู้คืนได้ในภายหลัง');
  } catch (error) { notify(error.message || 'ย้ายชุดไปถังขยะไม่สำเร็จ'); }
}

async function restoreWeeklySet(setId) {
  if (!activeGroup || !setId || !canEditActiveGroup() || offlineMode) return;
  try {
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/sets/${encodeURIComponent(setId)}/restore`, { method: 'PATCH', body: '{}' });
    activeGroup = result.group;
    renderGroupPanel();
    notify('กู้คืนชุดเพลงแล้ว');
  } catch (error) { notify(error.message || 'กู้คืนชุดเพลงไม่สำเร็จ'); }
}

async function openWeeklySet(setId) {
  if (offlineMode) { notify('เชื่อมต่ออินเทอร์เน็ตเพื่อเปิดชุดย้อนหลัง'); return; }
  const set = activeGroup?.weeklySets?.find((item) => item.id === setId && !item.deletedAt);
  if (!set) return;
  activeWeeklySet = set;
  $('weeklySetSelect').value = setId;
  songPages.group = 0;
  saveViewState();
  try { await loadActiveGroup(); } catch (error) { notify(error.message || 'เปิดชุดเพลงไม่สำเร็จ'); }
}

async function saveWeeklyServiceDate(event) {
  event.preventDefault();
  if (!activeGroup || !activeWeeklySet || !canEditActiveGroup() || offlineMode) return;
  try {
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/sets/${encodeURIComponent(activeWeeklySet.id)}`, { method: 'PATCH', body: JSON.stringify({ serviceDate: $('editServiceDateInput').value, name: $('editServiceNameInput').value.trim() }) });
    activeGroup = result.group;
    activeWeeklySet = result.activeSet;
    await loadActiveGroup();
    $('editServiceDateDialog').close();
    notify('เปลี่ยนวันเล่นแล้ว');
  } catch (error) { $('editServiceDateError').textContent = error.message; $('editServiceDateError').hidden = false; }
}

async function addLibrarySongToWeek(songId) {
  if (!activeGroup || !canEditActiveGroup() || !activeWeeklySet) return;
  if (activeSetSongs.some((song) => song.id === songId)) return notify('เพลงนี้อยู่ในชุดแล้ว');
  try { await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/setlist`, { method: 'PATCH', body: JSON.stringify({ setId: activeWeeklySet.id, songIds: [...activeSetSongs.map((song) => song.id), songId] }) }); await loadActiveGroup(); }
  catch (error) { notify(error.message); }
}

async function moveSharedSong(songId, delta) {
  if (!activeGroup || !canEditActiveGroup()) return;
  const ids = activeSetSongs.map((song) => song.id);
  const index = ids.indexOf(songId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  try {
    await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/setlist`, { method: 'PATCH', body: JSON.stringify({ songIds: ids, setId: activeWeeklySet?.id }) });
    await loadActiveGroup();
  } catch (error) { notify(error.message); }
}

async function removeSharedSong(songId) {
  if (!activeGroup || !canEditActiveGroup()) return;
  const song = activeSetSongs.find((item) => item.id === songId);
  if (!song || !await confirmAction({ title: 'นำเพลงออกจากชุดนี้?', message: `“${song.title}” จะถูกนำออกจากชุดที่เลือก แต่ยังอยู่ในคลังเพลงกลุ่มและชุดอื่น`, confirmLabel: 'นำออกจากชุด', danger: true })) return;
  try {
    await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/setlist`, { method: 'PATCH', body: JSON.stringify({ setId: activeWeeklySet?.id, songIds: activeSetSongs.filter((item) => item.id !== songId).map((item) => item.id) }) });
    await loadActiveGroup();
    notify('นำเพลงออกจากชุดสัปดาห์นี้แล้ว · ยังอยู่ในคลังเพลงกลุ่ม');
  } catch (error) { notify(error.message); }
}

function normalizeSearchValue(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('th-TH');
}

function searchSongMatches(song, query) {
  const needle = normalizeSearchValue(query);
  const matches = new Set();
  if (!needle) return matches;
  if (normalizeSearchValue(song.title).includes(needle)) matches.add('title');
  if (normalizeSearchValue(song.artist).includes(needle)) matches.add('artist');

  const lines = String(song.text || '').split(/\r?\n/);
  const chordRows = lines.filter((line) => {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && !/[\u0E00-\u0E7F]/.test(line) && tokens.every((token) => /^[|,;:/]+$/.test(token) || strictChordToken(token));
  });
  const bracketedChords = lines.flatMap((line) => [...line.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1])).filter((chord) => isChordExpression(chord));
  const chordHit = [...bracketedChords, ...chordRows.flatMap((line) => line.trim().split(/\s+/))]
    .some((chord) => normalizeSearchValue(chord).includes(needle) && (isChordExpression(chord) || strictChordToken(chord)));
  if (chordHit) matches.add('chord');

  const lyricText = lines.filter((line) => {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) return false;
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    return !(tokens.length > 0 && !/[\u0E00-\u0E7F]/.test(line) && tokens.every((token) => /^[|,;:/]+$/.test(token) || strictChordToken(token)));
  }).map((line) => line.replace(/\[[^\]]+\]/g, ' ')).join(' ');
  if (normalizeSearchValue(lyricText).includes(needle)) matches.add('lyrics');
  return matches;
}

function searchSongIdentity(song) {
  const title = normalizeSearchValue(song.title);
  const artist = normalizeSearchValue(song.artist);
  return title ? `${title}\u0000${artist}` : `id:${song.id}`;
}

async function loadSearchGroupLibrary(group) {
  if (offlineMode) {
    if (group.id === activeGroup?.id && sharedSongsGroupId === group.id) return sharedSongs;
    const snapshot = await getGroupSnapshot(group.id).catch(() => null);
    return snapshot?.songs || [];
  }
  if (group.id === activeGroup?.id && sharedSongsGroupId === group.id) {
    searchGroupLibraries.set(group.id, { songs: sharedSongs, loadedAt: Date.now() });
    return sharedSongs;
  }
  const cached = searchGroupLibraries.get(group.id);
  if (cached && Date.now() - cached.loadedAt < 30000) return cached.songs;
  if (pendingSearchGroupLoads.has(group.id)) return pendingSearchGroupLoads.get(group.id);

  const loading = api(`/api/groups/${encodeURIComponent(group.id)}`)
    .then((result) => {
      const library = result.librarySongs || result.songs || [];
      searchGroupLibraries.set(group.id, { songs: library, loadedAt: Date.now() });
      return library;
    })
    .finally(() => pendingSearchGroupLoads.delete(group.id));
  pendingSearchGroupLoads.set(group.id, loading);
  return loading;
}

function searchSourceOrder(source) {
  return ({ today: 0, personal: 1, group: 2 })[source.type] ?? 3;
}

function preferredSearchSource(sources) {
  const activeGroupSource = sources.find((source) => source.type === 'group' && source.groupId === activeGroup?.id);
  if (activeMainTab === 'group' && activeGroupSource) return activeGroupSource;
  if (activeMainTab === 'today') {
    const todaySource = sources.find((source) => source.type === 'today');
    if (todaySource) return todaySource;
  }
  if (activeMainTab === 'personal') {
    const personalSource = sources.find((source) => source.type === 'personal');
    if (personalSource) return personalSource;
  }
  return sources.find((source) => source.type === 'personal') || sources[0];
}

function renderSearchSourceButton(source, label) {
  const key = source.song.displayKey || source.song.key || 'C';
  const groupId = source.groupId || '';
  return `<button type="button" class="search-source-chip" data-open-search-song="${escapeHtml(source.song.id)}" data-search-context="${escapeHtml(source.context)}" data-search-group-id="${escapeHtml(groupId)}" aria-label="เปิดเพลง ${escapeHtml(source.song.title || 'เพลงไม่มีชื่อ')} จาก${escapeHtml(label)} คีย์ ${escapeHtml(key)}"><span>${escapeHtml(label)}</span><small>${escapeHtml(key)}</small></button>`;
}

async function renderSearchResults(query) {
  const results = $('searchResults');
  const token = ++searchRequestToken;
  const needle = query.trim();
  results.hidden = !needle;
  results.setAttribute('aria-busy', 'false');
  if (!needle) { results.innerHTML = ''; return; }
  if (!authUser) {
    results.innerHTML = '<div class="search-empty"><strong>เข้าสู่ระบบเพื่อค้นหาเพลงในคลัง</strong><button type="button" id="searchLoginButton" class="quiet-button">เข้าสู่ระบบ / สมัครสมาชิก</button></div>';
    return;
  }

  results.setAttribute('aria-busy', 'true');
  results.innerHTML = '<div class="search-loading"><span class="search-spinner" aria-hidden="true"></span>กำลังค้นหาในคลังเพลง…</div>';
  const groupLoads = await Promise.allSettled(groups.map(async (group) => ({ group, songs: await loadSearchGroupLibrary(group) })));
  if (token !== searchRequestToken || needle !== $('searchInput').value.trim()) return;

  const failedGroups = groupLoads.filter((result) => result.status === 'rejected').length;
  const sources = [];
  for (const song of songs) {
    const matches = searchSongMatches(song, needle);
    if (!matches.size) continue;
    sources.push({ song, type: 'personal', context: 'library', label: 'เพลงของฉัน', matches });
    if ((todaySetlist.songIds || []).includes(song.id)) {
      sources.push({ song, type: 'today', context: 'today', label: 'เพลงวันนี้', matches });
    }
  }
  for (const result of groupLoads) {
    if (result.status !== 'fulfilled') continue;
    const { group, songs: library } = result.value;
    for (const song of library) {
      const matches = searchSongMatches(song, needle);
      if (matches.size) sources.push({ song, type: 'group', context: 'groupLibrary', groupId: group.id, label: `กลุ่ม · ${group.name || 'กลุ่มเพลง'}`, matches });
    }
  }

  const grouped = new Map();
  for (const source of sources) {
    const identity = searchSongIdentity(source.song);
    if (!grouped.has(identity)) grouped.set(identity, { title: source.song.title || 'เพลงไม่มีชื่อ', artist: source.song.artist || '', sources: [], matches: new Set() });
    const item = grouped.get(identity);
    if (!item.sources.some((existing) => existing.type === source.type && existing.groupId === source.groupId && existing.song.id === source.song.id)) item.sources.push(source);
    source.matches.forEach((match) => item.matches.add(match));
  }

  const scope = searchScope;
  const resultsToRender = [...grouped.values()].map((item) => ({
    ...item,
    sources: item.sources.filter((source) => scope === 'all' || source.type === scope).sort((a, b) => searchSourceOrder(a) - searchSourceOrder(b)),
  })).filter((item) => item.sources.length > 0).map((item) => ({
    ...item,
    matches: new Set(item.sources.flatMap((source) => [...source.matches])),
  }));
  const matchLabels = { title: 'ชื่อเพลง', artist: 'ศิลปิน/ผู้แต่ง', lyrics: 'เนื้อเพลง', chord: 'คอร์ด' };
  const rank = (item) => Math.min(...[...item.matches].map((match) => ({ title: 0, artist: 1, chord: 2, lyrics: 3 })[match] ?? 4));
  resultsToRender.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, 'th'));

  const cards = resultsToRender.map((item) => {
    const preferred = preferredSearchSource(item.sources);
    const artist = item.artist || 'ยังไม่ระบุศิลปิน';
    const foundIn = [...item.matches].map((match) => matchLabels[match]).filter(Boolean).join(' · ');
    const mainAction = `<button type="button" class="search-result-main" data-open-search-song="${escapeHtml(preferred.song.id)}" data-search-context="${escapeHtml(preferred.context)}" data-search-group-id="${escapeHtml(preferred.groupId || '')}"><span><strong>${escapeHtml(item.title)}</strong><span class="search-result-main-key">${escapeHtml(preferred.song.displayKey || preferred.song.key || 'C')}</span></span><small>${escapeHtml(artist)} · พบใน ${escapeHtml(foundIn)}</small></button>`;
    const sourceActions = item.sources.map((source) => renderSearchSourceButton(source, source.label)).join('');
    return `<article class="search-result-card">${mainAction}<div class="search-result-sources" role="group" aria-label="เลือกแหล่งเพลง">${sourceActions}</div></article>`;
  }).join('');
  const failureMessage = failedGroups ? `<p class="search-partial-warning" role="status">ค้นหาใน ${failedGroups} กลุ่มไม่สำเร็จ · ลองอีกครั้งเมื่อต่อเน็ต</p>` : '';
  const emptyState = !resultsToRender.length
    ? failedGroups
      ? '<div class="search-empty"><strong>ค้นหาในบางกลุ่มไม่สำเร็จ</strong><span>เชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง</span><button type="button" class="quiet-button" id="retrySearchButton">ลองค้นหาอีกครั้ง</button></div>'
      : `<div class="search-empty"><strong>ไม่พบเพลงที่ตรงกับ “${escapeHtml(needle)}”</strong><span>ลองเปลี่ยนคำค้น หรือเพิ่มเพลงใหม่</span><button type="button" class="primary-button" id="searchAddSongButton">＋ เพิ่มเพลงใหม่</button></div>`
    : '';
  const resultCount = resultsToRender.length ? `<p class="search-result-count">พบ ${resultsToRender.length} เพลง</p>` : '';
  results.innerHTML = `${failureMessage}${resultCount}${cards}${emptyState}`;
  results.setAttribute('aria-busy', 'false');
}

function syncSearchVisibility() {
  const query = $('searchInput')?.value.trim() || '';
  const searching = Boolean(query);
  $('searchHelp').textContent = offlineMode
    ? 'ค้นในเพลงวันนี้ เพลงของฉัน และกลุ่มที่บันทึกไว้ในเครื่อง'
    : 'ค้นในเพลงวันนี้ เพลงของฉัน และกลุ่มที่คุณเข้าถึงได้';
  document.querySelectorAll('[data-search-scope]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.searchScope === searchScope)));
  $('searchHelp').hidden = false;
  $('searchScopeFilters').hidden = !searching || !authUser;
  $('clearSearchButton').hidden = !searching;
  $('mainViewTabs').hidden = searching;
  $('todaySetlistPanel').hidden = searching || activeMainTab !== 'today';
  $('personalLibraryDropZone').hidden = searching || activeMainTab !== 'personal';
  $('groupPanel').hidden = searching || activeMainTab !== 'group' || (offlineMode && !offlineGroupSnapshot);
}

async function openSearchSong(button) {
  const songId = button.dataset.openSearchSong;
  const context = button.dataset.searchContext;
  activeMainTab = context === 'groupLibrary' ? 'group' : context === 'today' ? 'today' : 'personal';
  document.querySelectorAll('[data-main-tab]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.mainTab === activeMainTab)));
  if (context === 'groupLibrary') {
    const groupId = button.dataset.searchGroupId;
    const group = groups.find((item) => item.id === groupId);
    if (!group) { notify('ไม่พบกลุ่มนี้ในบัญชีของคุณ'); return; }
    if (activeGroup?.id !== groupId) {
      if (offlineMode) { notify('ออฟไลน์เปิดได้เฉพาะกลุ่มที่บันทึกไว้ในเครื่อง'); return; }
      activeGroup = group;
      activeWeeklySet = group.weeklySets?.find((set) => set.id === group.activeSetId && !set.deletedAt) || null;
      try { await loadActiveGroup(); }
      catch (error) { notify(error.message || 'เปิดเพลงกลุ่มไม่สำเร็จ'); return; }
    }
    const song = sharedSongs.find((item) => item.id === songId);
    if (!song) { notify('เพลงนี้ถูกนำออกจากคลังกลุ่มแล้ว'); return; }
    openReader(song, 'groupLibrary');
    return;
  }

  const song = context === 'today' ? todaySongs().find((item) => item.id === songId) : songs.find((item) => item.id === songId);
  if (!song) { notify('ไม่พบเพลงนี้ในรายการแล้ว'); return; }
  openReader(song, context === 'today' ? 'today' : 'library');
}

function renderSongRows() {
  $('personalSongCount').textContent = `${songs.length} เพลงทั้งหมด`;
  $('todayAddSongButton').disabled = !authUser;
  $('todayStartPlaybackButton').disabled = !authUser || todaySongs().length === 0;
  const query = $('searchInput').value.trim();
  renderSearchResults(query);
  syncSearchVisibility();
  if (!authUser) {
    $('songList').innerHTML = '';
    $('emptyState').hidden = false;
    $('emptyState').querySelector('h2').textContent = 'เข้าสู่ระบบเพื่อเปิดสมุดเพลง';
    $('emptyState').querySelector('p').textContent = 'เพลงส่วนตัวและเพลงวันนี้เก็บแยกตามบัญชีใน MongoDB เมื่อเข้าสู่ระบบแล้วจะซิงก์ข้ามอุปกรณ์';
    $('emptyNewSongButton').textContent = 'เข้าสู่ระบบ / สมัครสมาชิก';
    $('todaySetlistEmpty').hidden = false;
    $('todaySetlistEmpty').textContent = 'เข้าสู่ระบบเพื่อโหลดเพลงวันนี้';
    $('todaySongCount').textContent = '0 เพลง';
    $('todaySongList').innerHTML = '';
    return;
  }
  if (query) {
    songPages.personal = 0;
    syncSearchVisibility();
    return;
  }
  const visible = songs;
  const shareButton = authUser && canEditActiveGroup()
    ? '<button data-action="shareGroup" title="แชร์เข้าคลังกลุ่ม · ยังไม่เพิ่มลงชุดเล่น" aria-label="แชร์เพลงเข้าคลังกลุ่ม">คลังกลุ่ม +</button>'
    : '';
  const suggestionButton = authUser && activeGroup && activeGroupRole() === 'viewer' && !offlineMode
    ? '<button data-action="suggestGroup" title="ขอเพิ่มเพลงเข้ากลุ่ม ให้ผู้แก้ไขตรวจคอร์ดและคีย์ก่อน">ขอเพิ่ม</button>'
    : '';
  $('songList').hidden = Boolean(query);
  $('songList').innerHTML = pageItems(visible, 'personal', 'personalSongsPager').map(({ song, index }) => {
    const inToday = todaySetlist.songIds.includes(song.id);
    return `<article class="song-row" data-id="${song.id}" draggable="true" aria-grabbed="false">
      <span class="song-index"><input class="bulk-song-checkbox" type="checkbox" data-bulk-select="personal" value="${escapeHtml(song.id)}" aria-label="เลือกเพลง ${escapeHtml(song.title || 'เพลงไม่มีชื่อ')} ในคลังส่วนตัว" ${bulkSelection.personal.has(song.id) ? 'checked' : ''} />${String(index + 1).padStart(2, '0')}</span>
      <div class="song-main" data-open="${song.id}" tabindex="0" role="button" aria-label="เปิดเพลง ${escapeHtml(song.title)}"><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${escapeHtml(song.artist || 'ยังไม่ระบุศิลปิน')}</small></div>
      <span class="song-key">${escapeHtml(song.key || 'C')}</span>
      <div class="row-actions"><button data-action="today" data-id="${song.id}" title="${inToday ? 'อยู่ในเพลงวันนี้แล้ว' : 'เพิ่มเข้าเพลงวันนี้'}" aria-label="${inToday ? 'อยู่ในเพลงวันนี้แล้ว' : 'เพิ่มเข้าเพลงวันนี้'}" ${inToday ? 'disabled' : ''}>${inToday ? '✓' : '+ วันนี้'}</button>${shareButton.replaceAll('data-action="shareGroup"', `data-action="shareGroup" data-id="${song.id}"`)}${suggestionButton.replaceAll('data-action="suggestGroup"', `data-action="suggestGroup" data-id="${song.id}"`)}<button data-action="up" data-id="${song.id}" title="เลื่อนขึ้น" aria-label="เลื่อนเพลงขึ้น">↑</button><button data-action="down" data-id="${song.id}" title="เลื่อนลง" aria-label="เลื่อนเพลงลง">↓</button><button data-action="edit" data-id="${song.id}" title="แก้ไข" aria-label="แก้ไขเพลง">✎</button><button data-action="delete" data-id="${song.id}" title="ลบ" aria-label="ลบเพลง">×</button></div>
    </article>`;
  }).join('');
  $('emptyState').hidden = songs.length > 0;
  $('emptyState').querySelector('h2').textContent = 'เริ่มทำสมุดเพลงของคุณ';
  $('emptyState').querySelector('p').textContent = 'เพิ่มเพลง พิมพ์เนื้อเพลงและคอร์ด แล้วเรียงลำดับตามชุดนมัสการ';
  $('emptyNewSongButton').textContent = '＋ เพิ่มเพลงแรก';
  $('todaySetlistEmpty').textContent = 'กด “+ วันนี้” ที่เพลง หรือ ลากเพลงจากคลังมาวางที่นี่';
  renderTodaySongs();
  renderAllBulkToolbars();
  syncSearchVisibility();
}

function normalizeChordSpacing(value) {
  const trimmed = String(value || '').split(/\r?\n/).map((line) => {
    const clean = line.replace(/[\t ]+$/g, '');
    const tokens = clean.trim().split(/\s+/).filter(Boolean);
    const chordOnly = tokens.length > 0 && !/[\u0E00-\u0E7F]/.test(clean) && tokens.every((token) => /^[|,;:/]+$/.test(token) || strictChordToken(token));
    return chordOnly ? tokens.join(' ') : clean;
  });
  const compact = [];
  let blank = false;
  for (const line of trimmed) {
    if (!line.trim()) { if (!blank) compact.push(''); blank = true; }
    else { compact.push(line); blank = false; }
  }
  while (compact[0] === '') compact.shift();
  while (compact.at(-1) === '') compact.pop();
  return compact.join('\n');
}

function setFitLayout(container, fit, columns) {
  container.classList.toggle('fit-layout', fit);
  container.classList.toggle('two-columns', columns);
  const existing = container.querySelector(':scope > .song-columns');
  if (existing) {
    const nodes = [...existing.querySelectorAll(':scope > .song-column > *')]
      .filter((node) => node.dataset.sectionRepeat !== 'true');
    existing.replaceWith(...nodes);
  }
  if (columns && window.matchMedia('(min-width: 761px)').matches) {
    const nodes = [...container.children];
    const headings = nodes.filter((node) => node.matches('.song-title-preview, .song-artist-preview'));
    const songPairs = nodes.filter((node) => node.matches('.song-pair'));
    if (songPairs.length < 2) return;

    const fontSize = Number.parseFloat(window.getComputedStyle(container).fontSize) || 16;
    const columnWidth = Math.max(140, (container.clientWidth - 48) / 2);
    const estimatePairHeight = (node) => {
      const lines = [...node.querySelectorAll('.song-line')];
      return Math.max(1, lines.reduce((height, line) => {
        const text = line.textContent.trim();
        if (!text) return height + 0.7;
        const units = [...text].reduce((count, character) => count + (/^[\u0E00-\u0E7F]$/u.test(character) ? 1 : /\s/u.test(character) ? 0.35 : 0.58), 0);
        return height + Math.max(1, Math.ceil((units * fontSize) / columnWidth));
      }, 0) + 0.25);
    };

    let sectionId = 0;
    let activeHeading = null;
    const blocks = songPairs.map((node) => {
      const isHeading = node.matches('.section-pair');
      if (isHeading) { sectionId += 1; activeHeading = node; }
      return { node, sectionId, heading: activeHeading, isHeading, weight: estimatePairHeight(node) };
    });
    const totalHeight = blocks.reduce((sum, block) => sum + block.weight, 0);
    let cutAt = Math.ceil(blocks.length / 2);
    let bestDifference = Number.POSITIVE_INFINITY;
    let leftHeight = 0;
    for (let index = 1; index < blocks.length; index += 1) {
      leftHeight += blocks[index - 1].weight;
      if (blocks[index - 1].isHeading) continue;
      const repeatsHeading = blocks[index - 1].sectionId > 0 && blocks[index - 1].sectionId === blocks[index].sectionId;
      const difference = Math.abs(totalHeight - leftHeight * 2) + (repeatsHeading ? blocks[index - 1].heading?.querySelectorAll('.song-line').length || 1 : 0);
      if (difference < bestDifference) { bestDifference = difference; cutAt = index; }
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'song-columns';
    const left = document.createElement('div'); left.className = 'song-column';
    const right = document.createElement('div'); right.className = 'song-column';
    blocks.slice(0, cutAt).forEach((block) => left.append(block.node));
    const rightBlocks = blocks.slice(cutAt);
    if (rightBlocks.length && blocks[cutAt - 1].sectionId > 0 && blocks[cutAt - 1].sectionId === rightBlocks[0].sectionId && blocks[cutAt - 1].heading) {
      const repeatedHeading = blocks[cutAt - 1].heading.cloneNode(true);
      repeatedHeading.dataset.sectionRepeat = 'true';
      right.append(repeatedHeading);
    }
    rightBlocks.forEach((block) => right.append(block.node));
    wrapper.append(left, right);
    container.replaceChildren(...headings, wrapper);
  }
}

function getReaderPreferences() {
  try {
    const prefs = JSON.parse(localStorage.getItem(READER_PREFS_KEY) || '{}');
    return {
      fontSize: Math.min(28, Math.max(14, Number(prefs.fontSize) || 20)),
      lineSpacing: Math.min(21, Math.max(12, Number(prefs.lineSpacing) || 17)),
      fit: Boolean(prefs.fit),
      columns: Boolean(prefs.columns),
    };
  } catch { return { fontSize: 20, lineSpacing: 17, fit: false, columns: false }; }
}

function applyCompactText(container, fontSize, lineSpacing, compact) {
  container.style.fontSize = `${compact ? Math.min(fontSize, 18) : fontSize}px`;
  container.style.lineHeight = String(compact ? Math.min(lineSpacing / 10, 1.34) : lineSpacing / 10);
}

function saveReaderPreferences() {
  const prefs = {
    fontSize: Number($('readerFontSize').value),
    lineSpacing: Number($('readerLineSpacing').value),
    fit: $('readerFitButton').getAttribute('aria-pressed') === 'true',
    columns: $('readerColumnsButton').getAttribute('aria-pressed') === 'true',
  };
  try { localStorage.setItem(READER_PREFS_KEY, JSON.stringify(prefs)); } catch { /* Preferences remain usable for this open page. */ }
}

function applyReaderPreferences() {
  const prefs = getReaderPreferences();
  $('readerFontSize').value = String(prefs.fontSize);
  $('readerLineSpacing').value = String(prefs.lineSpacing);
  $('readerFitButton').setAttribute('aria-pressed', String(prefs.fit));
  $('readerColumnsButton').setAttribute('aria-pressed', String(prefs.columns));
  applyCompactText($('readerChords'), prefs.fontSize, prefs.lineSpacing, prefs.fit);
  setFitLayout($('readerChords'), prefs.fit, prefs.columns);
}

function todaySongs() {
  return (todaySetlist.songIds || []).map((id) => songs.find((song) => song.id === id)).filter(Boolean);
}

function renderTodaySongs() {
  const ordered = todaySongs();
  $('todaySongCount').textContent = `${ordered.length} เพลง`;
  $('todayStartPlaybackButton').disabled = !authUser || ordered.length === 0;
  $('todayStartPlaybackButton').title = ordered.length ? 'เปิดเพลงแรกและแสดงรายการเพลงวันนี้' : 'เพิ่มเพลงลงเพลงวันนี้ก่อนเริ่มเล่น';
  $('todaySetlistEmpty').hidden = ordered.length > 0;
  $('todaySongList').innerHTML = pageItems(ordered, 'today', 'todaySongsPager').map(({ song, index }) => `<article class="today-song-row" data-id="${song.id}" draggable="true" aria-grabbed="false">
    <span class="today-drag-handle" aria-hidden="true">⠿</span>
    <input class="bulk-song-checkbox" type="checkbox" data-bulk-select="today" value="${escapeHtml(song.id)}" aria-label="เลือกเพลง ${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}" ${bulkSelection.today.has(song.id) ? 'checked' : ''} />
    <button class="today-song-open" data-open-today="${song.id}" aria-label="เปิด ${escapeHtml(song.title || 'เพลงไม่มีชื่อ')} คอร์ด ${escapeHtml(song.key || 'C')}"><span class="today-order">${String(index + 1).padStart(2, '0')}</span><span class="today-song-copy"><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${escapeHtml(song.artist || 'ยังไม่ระบุศิลปิน')}</small></span><span class="song-key">${escapeHtml(song.key || 'C')}</span></button>
    <div class="today-row-actions"><button data-action="todayUp" data-id="${song.id}" aria-label="เลื่อนขึ้น" title="เลื่อนขึ้น">↑</button><button data-action="todayDown" data-id="${song.id}" aria-label="เลื่อนลง" title="เลื่อนลง">↓</button><button data-action="todayRemove" data-id="${song.id}" aria-label="เอาออกจากเพลงวันนี้" title="เอาออก">×</button></div>
  </article>`).join('');
  renderAllBulkToolbars();
}

function renderTodaySongPicker() {
  if (!$('todaySongPickerDialog')) return;
  const query = $('todaySongPickerSearch').value.trim().toLocaleLowerCase('th-TH');
  const available = songs.filter((song) => `${song.title || ''} ${song.artist || ''}`.toLocaleLowerCase('th-TH').includes(query));
  $('todaySongPickerEmpty').hidden = available.length > 0;
  $('todaySongPickerEmpty').textContent = available.length ? '' : query ? 'ไม่พบเพลงในคลังส่วนตัวที่ตรงกัน' : 'ยังไม่มีเพลงในคลังส่วนตัว · ไปที่คลังส่วนตัวเพื่อเพิ่มเพลงก่อน';
  $('todaySongPickerList').innerHTML = available.map((song) => {
    const alreadyAdded = (todaySetlist.songIds || []).includes(song.id);
    return `<article class="group-song-row"><span><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${escapeHtml(song.artist || 'ยังไม่ระบุศิลปิน')} · คีย์ ${escapeHtml(song.key || 'C')}</small></span><button type="button" class="quiet-button" data-add-to-today="${escapeHtml(song.id)}" ${alreadyAdded ? 'disabled' : ''}>${alreadyAdded ? 'อยู่ในเพลงวันนี้แล้ว' : 'เพิ่มวันนี้'}</button></article>`;
  }).join('');
}

function showView(view) {
  $('libraryView').hidden = view !== 'library';
  $('editorView').hidden = view !== 'editor';
  $('readerView').hidden = view !== 'reader';
  window.scrollTo(0, 0);
  saveViewState();
}

function setMainTab(tab) {
  const nextTab = ['today', 'group', 'personal'].includes(tab) ? tab : 'today';
  if (nextTab !== activeMainTab) Object.values(bulkSelection).forEach((selection) => selection.clear());
  activeMainTab = nextTab;
  $('todaySetlistPanel').hidden = activeMainTab !== 'today';
  $('personalLibraryDropZone').hidden = activeMainTab !== 'personal';
  document.querySelectorAll('[data-main-tab]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.mainTab === activeMainTab)));
  renderGroupPanel();
  renderSongRows();
  saveViewState();
}

function makeBlankSong() {
  return { id: newLocalId(), title: '', artist: '', key: 'C', text: '', order: songs.length ? Math.max(...songs.map((song) => song.order)) + 1 : 0, updatedAt: Date.now() };
}

function openEditor(song = makeBlankSong(), groupId = null, setId = null) {
  if (groupId && (offlineMode || !canEditActiveGroup())) {
    notify(offlineMode ? 'แก้ไขเพลงกลุ่มต้องเชื่อมต่ออินเทอร์เน็ต' : 'คุณไม่มีสิทธิ์แก้ไขเพลงในกลุ่มนี้');
    return;
  }
  if (!groupId && !authUser) {
    updateAccountDialog();
    openAppDialog($('accountDialog'));
    notify('เข้าสู่ระบบก่อนบันทึกเพลงส่วนตัว');
    return;
  }
  currentSong = song;
  editingGroupId = groupId;
  editingGroupSetId = groupId && song.id && setId ? setId : null;
  editorSourceKeyConfirmed = song.sourceKeyConfirmed === true;
  editingId = song.id;
  $('backButton').querySelector('span').textContent = groupId ? 'กลับไปเพลงกลุ่ม' : 'เพลงของฉัน';
  $('songTitle').value = song.title || '';
  $('songArtist').value = song.artist || '';
  $('chordText').value = song.text || '';
  keyOptions($('sourceKeySelect'), song.key || 'C');
  keyOptions($('keySelect'), song.key || 'C');
  updateSourceKeyStatus();
  $('fontSizeRange').value = '16';
  $('lineSpacingRange').value = '16';
  $('saveSongButton').textContent = editingGroupSetId ? 'บันทึกการแก้ไขชุดนี้' : groupId ? 'บันทึกเพลงร่วมกัน' : 'บันทึกเพลง';
  updatePreview();
  showView('editor');
}

function readEditor() {
  return { ...(currentSong || makeBlankSong()), id: editingId || newLocalId(), title: $('songTitle').value.trim(), artist: $('songArtist').value.trim(), text: $('chordText').value, key: $('sourceKeySelect').value, sourceKeyConfirmed: editorSourceKeyConfirmed, updatedAt: Date.now() };
}

function renderChordContent(target, song, key) {
  if (!song?.text?.trim()) {
    target.innerHTML = '<div class="preview-placeholder">เพิ่มเนื้อเพลงและคอร์ดเพื่อดูตัวอย่าง</div>';
    return;
  }
  const text = displayText(song, key);
  const lines = text.split(/\r?\n/);
  const title = target.classList.contains('reader-chords') ? '' : `<h2 class="song-title-preview">${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</h2><p class="song-artist-preview">${escapeHtml(song.artist || '')}</p>`;
  const isSection = (line) => /^\s*\[(?!\s*[A-G][#b]?(?:m|maj|sus|dim|aug|add|[0-9]|\/|\s|\)|\()*)[^\]]+\]\s*$/.test(line);
  const isChordRow = (line) => {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && !/[\u0E00-\u0E7F]/.test(line) && tokens.every((token) => /^[|,;:/]+$/.test(token) || strictChordToken(token));
  };
  const renderLine = (line, extra = '') => `<div class="song-line ${extra}">${line.trim() ? chordHtml(line) : '&nbsp;'}</div>`;
  const body = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isSection(line)) { body.push(`<div class="song-pair section-pair">${renderLine(line, 'section-line')}</div>`); continue; }
    if (isChordRow(line) && lines[i + 1]?.trim() && !isSection(lines[i + 1])) {
      body.push(`<div class="song-pair">${renderLine(line)}${renderLine(lines[++i])}</div>`);
    } else body.push(`<div class="song-pair">${renderLine(line)}</div>`);
  }
  const renderedBody = body.join('');
  target.innerHTML = `${title}${renderedBody}`;
  if (target.classList.contains('two-columns')) setFitLayout(target, target.classList.contains('fit-layout'), true);
}

function updatePreview() {
  const song = readEditor();
  updateSourceKeyStatus();
  renderChordContent($('songPreview'), song, $('keySelect').value);
  applyCompactText($('songPreview'), Number($('fontSizeRange').value), Number($('lineSpacingRange').value), $('previewFitButton').getAttribute('aria-pressed') === 'true');
}

async function saveCurrentSong() {
  const song = readEditor();
  if (!song.title) { $('songTitle').focus(); notify('ใส่ชื่อเพลงก่อนบันทึก'); return; }
  try {
    if (editingGroupId && editingGroupSetId) {
      const result = await api(`/api/groups/${encodeURIComponent(editingGroupId)}/sets/${encodeURIComponent(editingGroupSetId)}/songs/${encodeURIComponent(song.id)}`, {
        method: 'PUT', body: JSON.stringify({ expectedRevision: currentSong.revision || 1, song })
      });
      currentSong = result.song;
      activeSetSongs = activeSetSongs.map((item) => item.id === result.song.id ? result.song : item);
      activeWeeklySet = { ...activeWeeklySet, songSnapshots: result.activeSet.songSnapshots };
      await saveGroupSnapshot({ id: activeGroup.id, group: activeGroup, songs: sharedSongs, activeSet: activeWeeklySet, setSongs: activeSetSongs, savedAt: Date.now() }).catch(() => {});
      renderGroupSongs();
      notify('บันทึกการแก้ไขไว้ในชุดนี้แล้ว · ชุดอื่นไม่เปลี่ยน');
    } else if (editingGroupId && !currentSong?.revision) {
      const result = await api(`/api/groups/${encodeURIComponent(editingGroupId)}/songs`, {
        method: 'POST', body: JSON.stringify({ song })
      });
      currentSong = result.song;
      editingId = result.song.id;
      await loadActiveGroup();
      $('saveSongButton').textContent = 'บันทึกเพลงร่วมกัน';
      notify('เพิ่มเพลงเข้าเพลงของกลุ่มแล้ว');
    } else if (editingGroupId) {
      const result = await api(`/api/groups/${encodeURIComponent(editingGroupId)}/songs/${encodeURIComponent(song.id)}`, {
        method: 'PUT', body: JSON.stringify({ expectedRevision: currentSong.revision || 1, song })
      });
      currentSong = result.song;
      sharedSongs = sharedSongs.map((item) => item.id === result.song.id ? result.song : item);
      renderGroupSongs();
      renderGroupLibrary();
      notify('บันทึกข้อมูลในคลังกลุ่มแล้ว · ชุดที่บันทึกไว้ไม่เปลี่ยน');
    } else {
      if (!authUser) { notify('เข้าสู่ระบบก่อนบันทึกเพลงส่วนตัว'); return; }
      lastPersonalMutationAt = Date.now();
      if (offlineMode || !navigator.onLine) {
        offlineMode = true;
        currentSong = await saveOfflineSong(song, currentSong);
        editingId = currentSong.id;
        const queue = await getSyncQueue();
        setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${queue.length} รายการรอซิงก์`);
        renderGroupPanel();
        renderSongRows();
        notify('บันทึกเพลงไว้ในเครื่องแล้ว รอซิงก์เมื่อออนไลน์');
        return;
      }
      try {
        const result = currentSong?.revision
          ? await api(`/api/library/songs/${encodeURIComponent(song.id)}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: currentSong.revision, song }) })
          : await api('/api/library/songs', { method: 'POST', body: JSON.stringify({ song }) });
        currentSong = result.song;
        editingId = result.song.id;
        await saveToDb(currentSong);
        songs = await getAllSongs();
        renderSongRows();
        notify('บันทึกเพลงส่วนตัวในบัญชีแล้ว');
      } catch (error) {
        if (error.payload?.duplicateSongId) { notify(error.message || 'มีเพลงชื่อและศิลปินนี้อยู่ในเพลงของฉันแล้ว'); return; }
        if (!isTransientApiError(error) && error.status !== 409) throw error;
        offlineMode = isTransientApiError(error);
        const previous = currentSong?.revision ? { ...currentSong } : null;
        currentSong = await saveOfflineSong(song, previous);
        editingId = currentSong.id;
        if (error.status === 409) {
          let library = { songs: [], todaySetlist, songOrderRevision };
          try { library = await api('/api/library'); } catch { /* Preserve the local edit if the service went away. */ }
          const cloudSong = error.payload?.song || library.songs?.find((item) => item.id === song.id) || null;
          const queueId = `song:${song.id}`;
          const queued = (await getSyncQueue()).find((item) => item.id === queueId);
          await saveSyncConflict(queued, mergeConflictResponse(queued, error, library), cloudSong);
          notify('มีฉบับใหม่บนคลาวด์ เลือกฉบับที่จะเก็บ');
        } else {
          const queue = await getSyncQueue();
          setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${queue.length} รายการรอซิงก์`);
          renderGroupPanel();
          notify('บันทึกไว้ในเครื่องแล้ว รอซิงก์เมื่อออนไลน์');
        }
        renderSongRows();
      }
    }
  } catch (error) {
    notify(error.message || 'บันทึกไม่สำเร็จ');
  }
}

function openReader(song, context = 'library') {
  const queueWasOpen = !$('readerView').hidden && readerContext === context && $('readerView').classList.contains('show-reader-queue');
  currentSong = song;
  readerContext = context;
  readerSongIds = readerContextSongs().map((item) => item.id);
  const groupContext = context === 'group' || context === 'groupLibrary';
  $('readerEditButton').hidden = groupContext && (!canEditActiveGroup() || offlineMode);
  setReaderKeyGuidance(context);
  $('readerTitle').textContent = song.title || 'เพลงไม่มีชื่อ';
  $('readerArtist').textContent = song.artist || 'WORSHIP SONG';
  const readerKey = groupContext ? (song.displayKey || song.key || 'C') : (song.key || 'C');
  keyOptions($('readerKeySelect'), readerKey);
  applyReaderPreferences();
  $('readerView').classList.toggle('show-reader-queue', queueWasOpen);
  renderReaderPosition();
  renderReaderQueue();
  renderChordContent($('readerChords'), song, readerKey);
  applyReaderPreferences();
  showView('reader');
  saveViewState();
}

function readerContextSongs() {
  return readerContext === 'today' ? todaySongs() : readerContext === 'group' ? activeSetSongs : readerContext === 'groupLibrary' ? sharedSongs : songs;
}

function renderReaderPosition() {
  const index = readerSongIds.indexOf(currentSong?.id);
  $('readerSetPosition').textContent = index < 0 ? '' : `${String(index + 1).padStart(2, '0')} / ${String(readerSongIds.length).padStart(2, '0')}`;
  $('readerPrevButton').disabled = index <= 0;
  $('readerNextButton').disabled = index < 0 || index >= readerSongIds.length - 1;
  renderReaderQueue();
}

function renderReaderQueue() {
  const queue = readerContextSongs();
  readerSongIds = queue.map((song) => song.id);
  const index = readerSongIds.indexOf(currentSong?.id);
  const nextSong = index >= 0 ? queue[index + 1] : null;
  $('readerQueueToggle').hidden = queue.length === 0;
  $('readerQueueSummary').textContent = index < 0
    ? `${queue.length} เพลงในรายการนี้`
    : `${String(index + 1).padStart(2, '0')} / ${String(queue.length).padStart(2, '0')} · ${currentSong?.title || 'เพลงไม่มีชื่อ'}${nextSong ? ` · ถัดไป: ${nextSong.title || 'เพลงไม่มีชื่อ'}` : ' · เพลงสุดท้าย'}`;
  $('readerQueueToggle').textContent = `รายการ ${index < 0 ? '—' : `${index + 1}/${queue.length}`}`;
  $('readerQueueToggle').setAttribute('aria-label', `เปิดรายการเพลง ${index < 0 ? '' : `กำลังดู ${currentSong?.title || 'เพลงไม่มีชื่อ'}${nextSong ? ` เพลงถัดไป ${nextSong.title || 'เพลงไม่มีชื่อ'}` : ''}`}`.trim());
  const queueOpen = !window.matchMedia('(max-width: 720px)').matches || $('readerView').classList.contains('show-reader-queue');
  $('readerQueueToggle').setAttribute('aria-expanded', String(queueOpen));
  $('readerQueue').innerHTML = queue.map((song, songIndex) => `<li><button type="button" data-reader-queue-song="${escapeHtml(song.id)}" class="reader-queue-song ${song.id === currentSong?.id ? 'is-current' : ''}" ${song.id === currentSong?.id ? 'aria-current="true"' : ''}><span class="today-order">${String(songIndex + 1).padStart(2, '0')}</span><span><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${songIndex === index ? 'กำลังดู' : songIndex === index + 1 ? 'เพลงถัดไป' : escapeHtml(song.artist || 'ไม่ระบุศิลปิน')}</small></span><span class="song-key">${escapeHtml(['group', 'groupLibrary'].includes(readerContext) ? song.displayKey || song.key || 'C' : song.key || 'C')}</span></button></li>`).join('');
  $('readerQueue').parentElement.hidden = queue.length === 0;
}

function navigateReader(delta) {
  const index = readerSongIds.indexOf(currentSong?.id);
  const nextId = readerSongIds[index + delta];
  if (!nextId) return;
  const song = readerContextSongs().find((item) => item.id === nextId);
  if (song) openReader(song, readerContext);
}

async function moveSong(id, delta) {
  if (!authUser) return;
  const previous = songs.map((song) => ({ ...song }));
  const previousIds = previous.map((song) => song.id);
  const index = songs.findIndex((song) => song.id === id);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= songs.length) return;
  [songs[index], songs[next]] = [songs[next], songs[index]];
  songs.forEach((song, order) => { song.order = order; });
  if (offlineMode || !navigator.onLine) {
    offlineMode = true;
    await queueOfflineOrder(songs.map((song) => song.id), previousIds, songOrderRevision);
    await Promise.all(songs.map(saveToDb));
    setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${(await getSyncQueue()).length} รายการรอซิงก์`);
    renderGroupPanel(); renderSongRows();
    return;
  }
  try {
    lastPersonalMutationAt = Date.now();
    const result = await api('/api/library/order', { method: 'PATCH', body: JSON.stringify({ songIds: songs.map((song) => song.id), expectedRevision: songOrderRevision }) });
    songOrderRevision = result.songOrderRevision;
    await Promise.all(songs.map(saveToDb));
  } catch (error) {
    if (isTransientApiError(error) || error.status === 409) {
      offlineMode = isTransientApiError(error);
      await queueOfflineOrder(songs.map((song) => song.id), previousIds, songOrderRevision);
      await Promise.all(songs.map(saveToDb));
      if (error.status === 409) {
        let library = { songs: previous, todaySetlist, songOrderRevision };
        try { library = await api('/api/library'); } catch { /* Keep the last cached snapshot. */ }
        const item = (await getSyncQueue()).find((entry) => entry.id === 'order');
        await saveSyncConflict(item, mergeConflictResponse(item, error, library));
        notify('ลำดับเพลงเปลี่ยนจากอุปกรณ์อื่น เลือกฉบับที่จะเก็บ');
      } else setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${(await getSyncQueue()).length} รายการรอซิงก์`);
    } else { songs = previous; notify(error.message); }
  }
  if (offlineMode) renderGroupPanel();
  renderSongRows();
}

async function reorderLibrarySong(songId, targetId, after = false) {
  if (!authUser) return;
  if (targetId === songId) return;
  const previous = [...songs];
  const previousIds = previous.map((song) => song.id);
  const ordered = [...songs];
  const from = ordered.findIndex((song) => song.id === songId);
  if (from < 0) return;
  const [song] = ordered.splice(from, 1);
  let to = targetId ? ordered.findIndex((item) => item.id === targetId) : ordered.length;
  if (to < 0) to = ordered.length;
  if (after && targetId) to += 1;
  ordered.splice(Math.min(to, ordered.length), 0, song);
  songs = ordered.map((item, order) => ({ ...item, order }));
  if (offlineMode || !navigator.onLine) {
    offlineMode = true;
    await queueOfflineOrder(songs.map((item) => item.id), previousIds, songOrderRevision);
    await Promise.all(songs.map(saveToDb));
    setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${(await getSyncQueue()).length} รายการรอซิงก์`);
    renderGroupPanel(); renderSongRows();
    return;
  }
  try {
    lastPersonalMutationAt = Date.now();
    const result = await api('/api/library/order', { method: 'PATCH', body: JSON.stringify({ songIds: songs.map((item) => item.id), expectedRevision: songOrderRevision }) });
    songOrderRevision = result.songOrderRevision;
    await Promise.all(songs.map(saveToDb));
  } catch (error) {
    if (isTransientApiError(error) || error.status === 409) {
      offlineMode = isTransientApiError(error);
      await queueOfflineOrder(songs.map((item) => item.id), previousIds, songOrderRevision);
      await Promise.all(songs.map(saveToDb));
      if (error.status === 409) {
        let library = { songs: previous, todaySetlist, songOrderRevision };
        try { library = await api('/api/library'); } catch { /* Keep the last cached snapshot. */ }
        const item = (await getSyncQueue()).find((entry) => entry.id === 'order');
        await saveSyncConflict(item, mergeConflictResponse(item, error, library));
        notify('ลำดับเพลงเปลี่ยนจากอุปกรณ์อื่น เลือกฉบับที่จะเก็บ');
      } else setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${(await getSyncQueue()).length} รายการรอซิงก์`);
    } else { songs = previous; notify(error.message); }
  }
  if (offlineMode) renderGroupPanel();
  renderSongRows();
}

async function persistTodaySetlist(songIds) {
  if (!authUser) return;
  const previous = { ...todaySetlist };
  const desired = { ...todaySetlist, songIds: [...songIds] };
  todaySetlist = desired;
  if (offlineMode || !navigator.onLine) {
    offlineMode = true;
    await queueOfflineSetlist(songIds, previous);
    setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${(await getSyncQueue()).length} รายการรอซิงก์`);
    renderGroupPanel(); renderSongRows();
    return;
  }
  try {
    lastPersonalMutationAt = Date.now();
    const result = await api('/api/library/setlist', { method: 'PATCH', body: JSON.stringify({ songIds, expectedRevision: previous.revision || 0 }) });
    todaySetlist = result.todaySetlist;
    await saveSetlist(todaySetlist);
  } catch (error) {
    if (error.status === 409 && error.payload?.duplicateSongId) {
      todaySetlist = previous;
      notify(error.message || 'มีเพลงชื่อและศิลปินนี้อยู่ในเพลงวันนี้แล้ว');
      renderGroupPanel();
      renderSongRows();
      return;
    }
    if (error.status === 409 && error.payload?.todaySetlist) {
      try {
        const latest = await api('/api/library');
        const remoteSetlist = latest.todaySetlist || error.payload.todaySetlist;
        const baseIds = previous.songIds || [];
        const baseSet = new Set(baseIds);
        const desiredSet = new Set(songIds);
        const addedIds = songIds.filter((id) => !baseSet.has(id));
        const removedIds = baseIds.filter((id) => !desiredSet.has(id));
        const remoteIds = remoteSetlist.songIds || [];
        const remoteSet = new Set(remoteIds);
        let mergedIds;
        if (addedIds.length && !removedIds.length) {
          mergedIds = [...remoteIds, ...addedIds.filter((id) => !remoteSet.has(id))];
        } else if (removedIds.length && !addedIds.length) {
          const removedSet = new Set(removedIds);
          mergedIds = remoteIds.filter((id) => !removedSet.has(id));
        } else if (baseSet.size === desiredSet.size && [...baseSet].every((id) => desiredSet.has(id))) {
          mergedIds = [...songIds, ...remoteIds.filter((id) => !baseSet.has(id))];
        }
        if (mergedIds) {
          const result = await api('/api/library/setlist', { method: 'PATCH', body: JSON.stringify({ songIds: mergedIds, expectedRevision: remoteSetlist.revision || 0 }) });
          todaySetlist = result.todaySetlist;
          await saveSetlist(todaySetlist);
          notify('เพิ่มเพลงแล้ว โดยอัปเดตตามรายการล่าสุด');
          renderGroupPanel();
          renderSongRows();
          return;
        }
      } catch (retryError) {
        if (retryError.status === 409 && retryError.payload?.duplicateSongId) {
          todaySetlist = previous;
          notify(retryError.message || 'มีเพลงชื่อและศิลปินนี้อยู่ในเพลงวันนี้แล้ว');
          renderGroupPanel();
          renderSongRows();
          return;
        }
        if (!isTransientApiError(retryError) && retryError.status !== 409) notify(retryError.message || 'บันทึกเพลงวันนี้ไม่สำเร็จ');
      }
    }
    if (isTransientApiError(error) || error.status === 409) {
      offlineMode = isTransientApiError(error);
      await queueOfflineSetlist(songIds, previous);
      if (error.status === 409) {
        let library = { songs, todaySetlist: error.payload?.todaySetlist || previous, songOrderRevision };
        try { library = await api('/api/library'); } catch { /* Keep the last cached snapshot. */ }
        const item = (await getSyncQueue()).find((entry) => entry.id === 'setlist:today');
        await saveSyncConflict(item, mergeConflictResponse(item, error, library));
        notify('เพลงวันนี้เปลี่ยนจากอุปกรณ์อื่น เลือกฉบับที่จะเก็บ');
      } else setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${(await getSyncQueue()).length} รายการรอซิงก์`);
    } else { todaySetlist = previous; notify(error.message); }
  }
  if (offlineMode) renderGroupPanel();
  renderSongRows();
}

async function deletePersonalSong(song) {
  if (!song || !authUser) return;
  const previousSetlist = { ...todaySetlist, songIds: [...(todaySetlist.songIds || [])] };
  if (offlineMode || !navigator.onLine) {
    offlineMode = true;
    await queueOfflineSongDelete(song);
    setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${(await getSyncQueue()).length} รายการรอซิงก์`);
    renderGroupPanel(); renderSongRows();
    notify('ลบเพลงจากเครื่องแล้ว รอซิงก์เมื่อออนไลน์');
    return;
  }
  try {
    lastPersonalMutationAt = Date.now();
    await api(`/api/library/songs/${encodeURIComponent(song.id)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: song.revision || 1 }) });
    await deleteFromDb(song.id);
    songs = await getAllSongs();
    const wasInSetlist = previousSetlist.songIds.includes(song.id);
    todaySetlist = { ...previousSetlist, songIds: previousSetlist.songIds.filter((id) => id !== song.id), revision: Number(previousSetlist.revision || 0) + (wasInSetlist ? 1 : 0) };
    await saveSetlist(todaySetlist);
    renderSongRows();
    notify('ลบเพลงแล้ว');
  } catch (error) {
    if (isTransientApiError(error) || error.status === 409) {
      offlineMode = isTransientApiError(error);
      await queueOfflineSongDelete(song);
      if (error.status === 409) {
        let library = { songs, todaySetlist, songOrderRevision };
        try { library = await api('/api/library'); } catch { /* Keep the last cached snapshot. */ }
        const cloudSong = error.payload?.song || library.songs?.find((item) => item.id === song.id) || null;
        const item = (await getSyncQueue()).find((entry) => entry.id === `song:${song.id}`);
        await saveSyncConflict(item, mergeConflictResponse(item, error, library), cloudSong);
        notify('เพลงเปลี่ยนจากอุปกรณ์อื่น เลือกฉบับที่จะเก็บ');
      } else setConnectivityBanner(`ออฟไลน์ · แก้ไขในเครื่องได้ · ${(await getSyncQueue()).length} รายการรอซิงก์`);
      renderGroupPanel(); renderSongRows();
      if (isTransientApiError(error)) notify('ลบเพลงจากเครื่องแล้ว รอซิงก์เมื่อออนไลน์');
    } else notify(error.message || 'ลบเพลงไม่สำเร็จ');
  }
}

async function placeSongInToday(songId, targetId = null, after = false) {
  if (!songs.some((song) => song.id === songId)) return;
  if (targetId === songId && todaySetlist.songIds.includes(songId)) return;
  const ids = (todaySetlist.songIds || []).filter((id) => songs.some((song) => song.id === id) && id !== songId);
  let index = targetId ? ids.indexOf(targetId) : ids.length;
  if (index < 0) index = ids.length;
  if (after && targetId) index += 1;
  ids.splice(Math.min(index, ids.length), 0, songId);
  await persistTodaySetlist(ids);
}

async function reorderTodaySong(songId, targetId = null, after = false) {
  const ids = (todaySetlist.songIds || []).filter((id) => songs.some((song) => song.id === id));
  const from = ids.indexOf(songId);
  if (from < 0 || targetId === songId) return;
  const [movingId] = ids.splice(from, 1);
  let to = targetId ? ids.indexOf(targetId) : ids.length;
  if (to < 0) to = ids.length;
  if (after && targetId) to += 1;
  ids.splice(Math.min(to, ids.length), 0, movingId);
  await persistTodaySetlist(ids);
}

async function moveTodaySong(songId, delta) {
  const ids = [...(todaySetlist.songIds || [])];
  const index = ids.indexOf(songId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  await persistTodaySetlist(ids);
}

async function removeSongFromToday(songId) {
  await persistTodaySetlist(todaySetlist.songIds.filter((id) => id !== songId));
}

function downloadJsonBackup(backup, filename) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

function downloadBackup() {
  const date = new Date().toISOString().slice(0, 10);
  downloadJsonBackup({ format: 'worshipchord-backup', version: 3, scope: 'personal', songs, setlists: [todaySetlist] }, `worshipchord-personal-${date}.json`);
  notify('ส่งออกคลังส่วนตัวและลำดับเพลงวันนี้แล้ว');
}

async function downloadGroupBackup() {
  const groupId = $('exportGroupSelect').value;
  if (!groupId || offlineMode) { notify('เลือกกลุ่มและเชื่อมต่ออินเทอร์เน็ตก่อนส่งออก'); return; }
  try {
    const result = await api(`/api/groups/${encodeURIComponent(groupId)}`);
    const group = groups.find((item) => item.id === groupId);
    const songs = result.librarySongs || [];
    const date = new Date().toISOString().slice(0, 10);
    downloadJsonBackup({ format: 'worshipchord-backup', version: 3, scope: 'group-library', exportedGroupName: result.group?.name || group?.name || 'group', songs }, `worshipchord-group-${date}.json`);
    notify(`ส่งออกคลังเพลงกลุ่ม “${result.group?.name || group?.name || ''}” แล้ว ${songs.length} เพลง`);
  } catch (error) { notify(error.message || 'ส่งออกคลังเพลงกลุ่มไม่สำเร็จ'); }
}

async function importBackup(backup) {
  try {
    if (!authUser) throw new Error('เข้าสู่ระบบก่อนนำเข้าข้อมูลเพลง');
    if (offlineMode) throw new Error('นำเข้าข้อมูลต้องเชื่อมต่ออินเทอร์เน็ต');
    if (backup.format !== 'worshipchord-backup' || !Array.isArray(backup.songs)) throw new Error('ไฟล์นี้ไม่ใช่ไฟล์สำรอง WorshipChord');
    let message;
    if (pendingBackupTarget.type === 'group') {
      const groupId = pendingBackupTarget.groupId;
      if (!groupId) throw new Error('เลือกกลุ่มปลายทางก่อนนำเข้า');
      const result = await api(`/api/groups/${encodeURIComponent(groupId)}/import`, { method: 'POST', body: JSON.stringify({ songs: backup.songs }) });
      if (activeGroup?.id === groupId) await loadActiveGroup();
      message = `นำเข้าเข้าคลังกลุ่มแล้ว ${result.imported} เพลง · ข้ามซ้ำ ${result.duplicatesSkipped} · ใช้ไม่ได้ ${result.invalidSkipped}`;
    } else {
      const sourceSetlist = backup.setlists?.find((setlist) => setlist.id === TODAY_SETLIST_ID || setlist.name === 'เพลงวันนี้');
      if (pendingBackupTarget.type === 'today' && !sourceSetlist) throw new Error('ไฟล์นี้ไม่มีรายการเพลงวันนี้ ให้เลือกนำเข้าไปคลังส่วนตัวแทน');
      lastPersonalMutationAt = Date.now();
      const result = await api('/api/library/import', {
        method: 'POST',
        body: JSON.stringify({ songs: backup.songs, ...(pendingBackupTarget.type === 'today' ? { todaySetlist: sourceSetlist } : {}) })
      });
      await cacheRemoteLibrary(result.library);
      renderSongRows();
      message = pendingBackupTarget.type === 'today'
        ? `นำเข้าเพลงวันนี้แล้ว · เพิ่มในคลังส่วนตัว ${result.imported} เพลง · ข้ามซ้ำ ${Number(result.duplicatesSkipped || 0) + Number(result.setlistDuplicatesSkipped || 0)} รายการ`
        : `นำเข้าคลังส่วนตัวแล้ว · เพิ่ม ${result.imported} เพลง · ข้ามซ้ำ ${result.duplicatesSkipped || 0} รายการ`;
    }
    $('importPreviewDialog').close();
    $('fileTransferDialog').close();
    pendingBackupImport = null;
    notify(message);
  } catch (error) { notify(error.message || 'นำเข้าไฟล์สำรองไม่สำเร็จ'); }
}

function updateImportTargetHelp() {
  const target = $('importTargetSelect').value;
  $('importGroupField').hidden = target !== 'group';
  $('importTargetHelp').textContent = target === 'personal'
    ? 'เพิ่มเพลงใหม่ในคลังส่วนตัวเท่านั้น · ไม่เปลี่ยนเพลงวันนี้'
    : target === 'today'
      ? 'เพิ่มเพลงที่ยังไม่มีในคลังส่วนตัว แล้วจัดเข้าลำดับเพลงวันนี้จากไฟล์'
      : 'เพิ่มไว้ในคลังกลุ่มเพื่อใช้ซ้ำ · ไม่เปลี่ยนชุดเพลงใด · นำเข้าได้เฉพาะเจ้าของหรือผู้แก้ไข';
  const groupId = $('importGroupSelect').value;
  const group = groups.find((item) => item.id === groupId);
  const role = group?.members?.find((member) => member.userId === authUser?.id)?.role;
  $('chooseImportFileButton').disabled = !authUser || offlineMode || (target === 'group' && (!groupId || !['owner', 'editor'].includes(role)));
  $('chooseImportFileButton').textContent = target === 'today' ? 'เลือกไฟล์เพื่อนำเข้าเพลงวันนี้' : target === 'group' ? 'เลือกไฟล์เพื่อนำเข้าคลังกลุ่ม' : 'เลือกไฟล์เพื่อนำเข้าคลังส่วนตัว';
}

async function previewBackupImport(file) {
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 2 MB');
    const backup = JSON.parse(await file.text());
    if (backup.format !== 'worshipchord-backup' || !Array.isArray(backup.songs)) throw new Error('ไฟล์นี้ไม่ใช่ไฟล์สำรอง WorshipChord');
    if (backup.songs.length > 500) throw new Error('ไฟล์ต้องมีเพลงไม่เกิน 500 รายการ');
    const targetType = $('importTargetSelect').value;
    const groupId = targetType === 'group' ? $('importGroupSelect').value : null;
    if (targetType === 'group' && !groupId) throw new Error('เลือกกลุ่มปลายทางก่อน');
    const targetGroup = groupId ? groups.find((item) => item.id === groupId) : null;
    const role = targetGroup?.members?.find((member) => member.userId === authUser?.id)?.role;
    if (targetType === 'group' && !['owner', 'editor'].includes(role)) throw new Error('เฉพาะเจ้าของกลุ่มหรือผู้แก้ไขนำเข้าเพลงได้');
    if (targetType === 'today' && !backup.setlists?.some((item) => item.id === TODAY_SETLIST_ID || item.name === 'เพลงวันนี้')) throw new Error('ไฟล์นี้ไม่มีรายการเพลงวันนี้ ให้เลือกนำเข้าไปคลังส่วนตัวแทน');
    const keyOf = (song) => JSON.stringify([song.title, song.artist || ''].map((value) => String(value).normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('th-TH')));
    let destinationSongs = songs;
    if (targetType === 'group') {
      const result = await api(`/api/groups/${encodeURIComponent(groupId)}`);
      destinationSongs = result.librarySongs || [];
    }
    const existing = new Set(destinationSongs.map(keyOf));
    const importable = [];
    let duplicateCount = 0;
    let invalidCount = 0;
    for (const song of backup.songs) {
      if (!String(song?.title || '').trim()) { invalidCount += 1; continue; }
      const key = keyOf(song);
      if (existing.has(key)) duplicateCount += 1;
      else { importable.push(song); existing.add(key); }
    }
    const setlist = backup.setlists?.find((item) => item.id === TODAY_SETLIST_ID || item.name === 'เพลงวันนี้');
    const setlistCount = Array.isArray(setlist?.songIds) ? setlist.songIds.length : 0;
    pendingBackupTarget = { type: targetType, groupId };
    pendingBackupImport = backup;
    const targetLabel = targetType === 'today' ? 'เพลงวันนี้' : targetType === 'group' ? `คลังกลุ่ม “${targetGroup?.name || ''}”` : 'คลังส่วนตัว';
    $('importPreviewSummary').textContent = `ปลายทาง: ${targetLabel} · ในไฟล์ ${backup.songs.length} เพลง · เพลงใหม่ ${importable.length} · ซ้ำ ${duplicateCount} · ไม่มีชื่อ ${invalidCount}${targetType === 'today' ? ` · ลำดับเพลงวันนี้ ${setlistCount} เพลง` : ''}`;
    $('importPreviewHelp').textContent = targetType === 'group'
      ? 'เพลงซ้ำจะจับคู่กับเพลงเดิมและไม่เขียนทับข้อมูล · เพลงใหม่จะเข้าเฉพาะคลังกลุ่ม ไม่เพิ่มลงชุดเล่น'
      : targetType === 'today'
        ? 'เพลงที่ยังไม่มีจะถูกเพิ่มเข้าคลังส่วนตัวก่อน เพราะเพลงวันนี้ใช้เพลงจากคลังส่วนตัว · รายการซ้ำจะใช้เพลงเดิม'
        : 'เพลงใหม่จะเพิ่มในคลังส่วนตัวเท่านั้น · ไม่เปลี่ยนเพลงวันนี้ · เพลงซ้ำจะข้ามโดยเก็บฉบับเดิมไว้';
    $('confirmImportButton').disabled = importable.length === 0 && duplicateCount === 0;
    openAppDialog($('importPreviewDialog'));
  } catch (error) { notify(error.message || 'อ่านไฟล์สำรองไม่สำเร็จ'); }
}

function bindEvents() {
  observeDialogScrollState();
  bindSongPagers();
  document.addEventListener('change', (event) => {
    const input = event.target.closest('[data-bulk-select]');
    if (!input) return;
    const context = input.dataset.bulkSelect;
    if (!bulkSelection[context]) return;
    if (input.checked) bulkSelection[context].add(input.value);
    else bulkSelection[context].delete(input.value);
    renderAllBulkToolbars();
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-bulk-action]');
    if (button) await runBulkAction(button.dataset.bulkContext, button.dataset.bulkAction);
    const openSet = event.target.closest('[data-open-weekly-set]');
    if (openSet) await openWeeklySet(openSet.dataset.openWeeklySet);
    const trashSet = event.target.closest('[data-trash-weekly-set]');
    if (trashSet) await trashWeeklySet(trashSet.dataset.trashWeeklySet);
    const restoreSet = event.target.closest('[data-restore-weekly-set]');
    if (restoreSet) await restoreWeeklySet(restoreSet.dataset.restoreWeeklySet);
  });
  document.querySelectorAll('[data-main-tab]').forEach((button) => button.addEventListener('click', () => setMainTab(button.dataset.mainTab)));
  document.querySelectorAll('[data-picker-source]').forEach((button) => button.addEventListener('click', () => {
    groupSongPickerSource = button.dataset.pickerSource;
    $('groupSongPickerSearch').value = '';
    renderGroupSongPicker();
    $('groupSongPickerSearch').focus();
  }));
  $('newSongButton').addEventListener('click', () => openEditor());
  $('emptyNewSongButton').addEventListener('click', () => openEditor());
  $('todayStartPlaybackButton').addEventListener('click', () => {
    const firstSong = todaySongs()[0];
    if (!firstSong) { notify('เพิ่มเพลงลงเพลงวันนี้ก่อนเริ่มเล่น'); return; }
    openReader(firstSong, 'today');
  });
  $('todayAddSongButton').addEventListener('click', () => {
    if (!authUser) { updateAccountDialog(); openAppDialog($('accountDialog')); return; }
    $('todaySongPickerSearch').value = '';
    renderTodaySongPicker();
    openAppDialog($('todaySongPickerDialog'));
    $('todaySongPickerSearch').focus();
  });
  $('todaySongPickerSearch').addEventListener('input', renderTodaySongPicker);
  $('todaySongPickerList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-add-to-today]');
    if (!button || button.disabled) return;
    await placeSongInToday(button.dataset.addToToday);
    renderTodaySongPicker();
  });
  $('accountButton').addEventListener('click', () => { updateAccountDialog(); openAppDialog($('accountDialog')); });
  $('accountModeButton').addEventListener('click', () => { authMode = authMode === 'login' ? 'register' : 'login'; updateAccountDialog(); });
  $('accountForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const registering = authMode === 'register';
    const endpoint = registering ? '/api/auth/register' : '/api/auth/login';
    const body = { email: $('accountEmail').value, password: $('accountPassword').value, displayName: $('accountDisplayName').value };
    try {
      const result = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      if (registering && result.recoveryCode) {
        $('accountDialog').close();
        $('recoveryCodeValue').textContent = result.recoveryCode;
        openAppDialog($('recoveryCodeDialog'));
      }
      await loadPrivateLibrary(result.user);
      renderGroupPanel();
      renderSongRows();
      updateAccountDialog();
      $('accountDialog').close();
      notify(registering ? 'สร้างบัญชีแล้ว' : 'เข้าสู่ระบบแล้ว');
      try {
        await Promise.all([loadGroups(), refreshNotifications()]);
        connectRealtime();
      } catch (error) { notify(`โหลดกลุ่มไม่สำเร็จ: ${error.message}`); }
    } catch (error) {
      $('accountError').textContent = error.message;
      $('accountError').hidden = false;
    }
  });
  $('forgotPasswordButton').addEventListener('click', () => {
    $('resetEmail').value = $('accountEmail').value.trim();
    $('resetPasswordError').hidden = true;
    openAppDialog($('resetPasswordDialog'));
  });
  $('resetPasswordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email: $('resetEmail').value, recoveryCode: $('resetRecoveryCode').value, password: $('resetNewPassword').value }) });
      $('resetPasswordDialog').close();
      $('accountEmail').value = $('resetEmail').value;
      $('accountPassword').value = '';
      notify('เปลี่ยนรหัสผ่านแล้ว เข้าสู่ระบบด้วยรหัสใหม่ได้เลย');
    } catch (error) {
      $('resetPasswordError').textContent = error.message;
      $('resetPasswordError').hidden = false;
    }
  });
  $('copyRecoveryCodeButton').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('recoveryCodeValue').textContent); notify('คัดลอก recovery code แล้ว'); }
    catch { notify('คัดลอกไม่ได้ กรุณาจดรหัสนี้ไว้'); }
  });
  $('recoveryCodeDoneButton').addEventListener('click', () => $('recoveryCodeDialog').close());
  $('recoveryCodeDialog').addEventListener('cancel', (event) => event.preventDefault());
  $('copyPublicIdButton').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(authUser?.publicId || ''); notify('คัดลอก ID แล้ว'); }
    catch { notify(`ID ของคุณ: ${authUser?.publicId || ''}`); }
  });
  $('generateRecoveryCodeButton').addEventListener('click', async () => {
    try {
      const result = await api('/api/me/recovery-code', { method: 'POST', body: '{}' });
      $('recoveryCodeValue').textContent = result.recoveryCode;
      openAppDialog($('recoveryCodeDialog'));
    } catch (error) { notify(error.message || 'สร้าง recovery code ไม่สำเร็จ'); }
  });
  $('logoutButton').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* Clear the local view even if offline. */ }
    realtimeSocket?.close();
    realtimeSocket = null;
    authUser = null;
    offlineMode = false;
    localStorage.removeItem(LAST_USER_KEY);
    sessionStorage.removeItem(VIEW_STATE_KEY);
    Object.values(bulkSelection).forEach((selection) => selection.clear());
    db?.close();
    db = await openDatabase(DB_NAME);
    songs = [];
    todaySetlist = { id: TODAY_SETLIST_ID, name: 'เพลงวันนี้', songIds: [] };
    groups = [];
    activeGroup = null;
    sharedSongs = [];
    sharedSongsGroupId = null;
    searchGroupLibraries.clear();
    pendingSearchGroupLoads.clear();
    $('searchInput').value = '';
    searchScope = 'all';
    notifications = [];
    activeMainTab = 'today';
    renderGroupPanel();
    renderSongRows();
    updateAccountDialog();
    $('accountDialog').close();
    notify('ออกจากระบบแล้ว');
  });
  $('inboxButton').addEventListener('click', async () => {
    try { await refreshNotifications(); } catch (error) { notify(error.message); }
    openAppDialog($('inboxDialog'));
  });
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(button.dataset.closeDialog).close()));
  $('notificationList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-notification-action]');
    if (!button) return;
    try {
      const action = button.dataset.notificationAction;
      if (action === 'accept' || action === 'decline') await respondToInvitation(button.dataset.id, action);
      if (action === 'open-suggestions') {
        const notification = notifications.find((item) => item.id === button.dataset.id);
        if (notification) await openSongSuggestionFromNotification(notification);
      }
      if (action === 'read') {
        await api(`/api/notifications/${encodeURIComponent(button.dataset.id)}`, { method: 'PATCH', body: '{}' });
        await refreshNotifications();
      }
    } catch (error) { notify(error.message); }
  });
  $('createGroupButton').addEventListener('click', () => openGroupSettings(true));
  $('manageGroupButton').addEventListener('click', () => openGroupSettings(false));
  $('startGroupSetButton').addEventListener('click', () => {
    const firstSong = activeSetSongs[0];
    if (!firstSong) { notify('เพิ่มเพลงลงชุดนี้ก่อนเริ่มเล่น'); return; }
    openReader(firstSong, 'group');
  });
  $('groupNameForm').addEventListener('submit', saveGroupName);
  $('transferGroupOwnerButton').addEventListener('click', transferActiveGroupOwnership);
  $('deleteGroupButton').addEventListener('click', deleteActiveGroup);
  $('addGroupSongButton').addEventListener('click', () => { groupSongPickerSource = canEditActiveGroup() ? 'group' : 'personal'; $('groupSongPickerSearch').value = ''; renderGroupSongPicker(); openAppDialog($('groupSongPickerDialog')); $('groupSongPickerSearch').focus(); });
  $('groupSongPickerSearch').addEventListener('input', renderGroupSongPicker);
  $('groupLibrarySearch').addEventListener('input', () => { songPages.groupLibrary = 0; renderGroupLibrary(); });
  $('weeklyHistorySearch').addEventListener('input', renderWeeklyRecords);
  $('groupLibraryList').addEventListener('click', async (event) => {
    const add = event.target.closest('[data-add-catalog-song]');
    const edit = event.target.closest('[data-edit-catalog-song]');
    const remove = event.target.closest('[data-remove-catalog-song]');
    if (add && !add.disabled) await addLibrarySongToWeek(add.dataset.addCatalogSong);
    if (edit) openEditor(sharedSongs.find((song) => song.id === edit.dataset.editCatalogSong), activeGroup?.id);
    if (remove) await removeSongFromGroupLibrary(remove.dataset.removeCatalogSong);
    const opener = event.target.closest('[data-open-group-library]');
    if (opener) openReader(sharedSongs.find((song) => song.id === opener.dataset.openGroupLibrary), 'groupLibrary');
  });
  $('groupSuggestionList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-review-suggestion]');
    if (button) await reviewGroupSuggestion(button.dataset.id, button.dataset.reviewSuggestion);
  });
  $('groupSelect').addEventListener('change', async () => {
    const previousId = activeGroup?.id;
    if (previousId) sendRealtime({ type: 'unsubscribe', groupId: previousId });
    activeGroup = groups.find((group) => group.id === $('groupSelect').value) || null;
    activeWeeklySet = null;
    bulkSelection.groupSet.clear(); bulkSelection.groupLibrary.clear();
    sharedSongs = []; sharedSongsGroupId = null;
    saveViewState();
    renderGroupPanel();
    try { if (activeGroup) await loadActiveGroup(); renderSongRows(); }
    catch (error) { notify(error.message); }
  });
  $('weeklySetSelect').addEventListener('change', async () => {
    if (offlineMode) { renderGroupPanel(); notify('เชื่อมต่ออินเทอร์เน็ตเพื่อเปิดชุดอื่น'); return; }
    activeWeeklySet = activeGroup?.weeklySets?.find((set) => set.id === $('weeklySetSelect').value) || null;
    bulkSelection.groupSet.clear();
    songPages.group = 0;
    saveViewState();
    try { await loadActiveGroup(); } catch (error) { notify(error.message); }
  });
  $('weeklyServiceDate').addEventListener('change', updateWeeklyCreateDateHint);
  $('editWeeklyServiceDateButton').addEventListener('click', () => {
    if (!activeWeeklySet) return;
    $('editServiceDateInput').value = activeWeeklySet.serviceDate || activeWeeklySet.end || activeWeeklySet.start;
    $('editServiceNameInput').value = activeWeeklySet.name || '';
    $('editServiceDateWeek').textContent = `เลือกวันเล่นใหม่ได้ · ชุดอื่นในวันเดียวกันยังแยกกันอยู่`;
    $('editServiceDateError').hidden = true;
    openAppDialog($('editServiceDateDialog'));
  });
  $('editServiceDateForm').addEventListener('submit', saveWeeklyServiceDate);
  const createWeek = (copyPrevious) => {
    if (!activeGroup) return;
    createWeeklySet(copyPrevious);
  };
  $('createWeeklySetButton').addEventListener('click', () => createWeek(true));
  $('createEmptyWeeklySetButton').addEventListener('click', () => createWeek(false));
  $('trashWeeklySetButton').addEventListener('click', () => trashWeeklySet());
  $('groupSongPickerList').addEventListener('click', async (event) => {
    const suggestButton = event.target.closest('[data-suggest-personal]');
    if (suggestButton) {
      const song = songs.find((item) => item.id === suggestButton.dataset.suggestPersonal);
      if (await submitSongSuggestion(song)) $('groupSongPickerDialog').close();
      return;
    }
    const personalButton = event.target.closest('[data-import-personal]');
    if (personalButton) { await importPersonalSongToWeek(personalButton.dataset.importPersonal); return; }
    const groupButton = event.target.closest('[data-add-to-week]');
    if (!groupButton || groupButton.disabled) return;
    await addLibrarySongToWeek(groupButton.dataset.addToWeek);
    renderGroupSongPicker();
  });
  $('prepareOfflineGroupButton').addEventListener('click', prepareActiveGroupOffline);
  $('inviteGroupButton').addEventListener('click', () => {
    if (!activeGroup || !activeGroupRole() || offlineMode) return;
    $('inviteError').hidden = true;
    $('inviteSearch').value = '';
    $('invitePublicId').value = '';
    $('inviteSearchResults').innerHTML = '';
    $('inviteSearchResults').hidden = true;
    $('inviteRole').disabled = activeGroupRole() === 'viewer';
    $('inviteRole').value = 'viewer';
    $('inviteRoleHint').textContent = activeGroupRole() === 'viewer'
      ? 'สิทธิ์ของคุณเชิญได้เฉพาะสมาชิกที่ดูเพลงได้'
      : 'ผู้ดูเชิญได้เฉพาะผู้ดู · เจ้าของหรือผู้แก้ไขเลือกผู้ดูหรือผู้แก้ไขได้';
    openAppDialog($('inviteDialog'));
  });
  $('inviteSearch').addEventListener('input', async () => {
    const query = $('inviteSearch').value.trim();
    $('invitePublicId').value = '';
    if (query.length < 2) { $('inviteSearchResults').hidden = true; return; }
    try {
      const result = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
      if ($('inviteSearch').value.trim() !== query) return;
      $('inviteSearchResults').innerHTML = result.users.length
        ? result.users.map((item) => `<button type="button" class="invite-result" data-public-id="${escapeHtml(item.publicId)}"><strong>${escapeHtml(item.displayName)}</strong><small>${escapeHtml(item.publicId)}</small></button>`).join('')
        : '<p class="hint">ไม่พบบัญชี ลองค้นด้วย ID ที่ตรงกัน</p>';
      $('inviteSearchResults').hidden = false;
    } catch (error) { $('inviteError').textContent = error.message; $('inviteError').hidden = false; }
  });
  $('inviteSearchResults').addEventListener('click', (event) => {
    const button = event.target.closest('[data-public-id]');
    if (!button) return;
    $('invitePublicId').value = button.dataset.publicId;
    $('inviteSearch').value = `${button.querySelector('strong').textContent} · ${button.dataset.publicId}`;
    $('inviteSearchResults').hidden = true;
  });
  $('inviteForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!activeGroup) return;
    if (!$('invitePublicId').value) { $('inviteError').textContent = 'เลือกบัญชีจากผลการค้นหาก่อนส่งคำเชิญ'; $('inviteError').hidden = false; return; }
    try {
      const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/invitations`, { method: 'POST', body: JSON.stringify({ publicId: $('invitePublicId').value, role: $('inviteRole').value }) });
      $('inviteDialog').close();
      notify(result.registered ? 'ส่งคำเชิญและแจ้งเตือนแล้ว' : 'ส่งคำเชิญแล้ว');
    } catch (error) {
      $('inviteError').textContent = error.message;
      $('inviteError').hidden = false;
    }
  });
  $('groupMembers').addEventListener('click', (event) => {
    if (!event.target.closest('#manageGroupMembersButton') || !activeGroup) return;
    $('memberSearchInput').value = '';
    $('memberRoleFilter').value = '';
    openAppDialog($('groupMembersDialog'));
    loadMemberDirectory(0);
  });
  $('groupSignInButton').addEventListener('click', () => {
    updateAccountDialog();
    openAppDialog($('accountDialog'));
  });
  $('memberSearchInput').addEventListener('input', () => {
    clearTimeout(memberSearchTimer);
    memberSearchTimer = setTimeout(() => loadMemberDirectory(0), 220);
  });
  $('memberRoleFilter').addEventListener('change', () => loadMemberDirectory(0));
  $('memberPrevPage').addEventListener('click', () => loadMemberDirectory(Math.max(0, memberPageOffset - MEMBER_PAGE_SIZE)));
  $('memberNextPage').addEventListener('click', () => loadMemberDirectory(memberPageOffset + MEMBER_PAGE_SIZE));
  $('groupMemberList').addEventListener('change', async (event) => {
    const select = event.target.closest('[data-member-role]');
    if (!select || !activeGroup || activeGroupRole() !== 'owner') return;
    try {
      const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/members/${encodeURIComponent(select.dataset.userId)}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) });
      activeGroup = result.group;
      renderGroupMembers();
      await loadMemberDirectory(memberPageOffset);
      notify('อัปเดตสิทธิ์สมาชิกแล้ว');
    } catch (error) { notify(error.message); await loadMemberDirectory(memberPageOffset); }
  });
  $('groupSongList').addEventListener('click', async (event) => {
    const actionButton = event.target.closest('[data-group-action]');
    if (actionButton) {
      const { groupAction, id } = { groupAction: actionButton.dataset.groupAction, id: actionButton.dataset.id };
      if (groupAction === 'copy') await copyGroupSongToLibrary(id);
      if (groupAction === 'up') await moveSharedSong(id, -1);
      if (groupAction === 'down') await moveSharedSong(id, 1);
      if (groupAction === 'edit') openEditor(activeSetSongs.find((song) => song.id === id), activeGroup?.id, activeWeeklySet?.id);
      if (groupAction === 'remove') await removeSharedSong(id);
      return;
    }
    const opener = event.target.closest('[data-open-group]');
    if (opener) openReader(activeSetSongs.find((song) => song.id === opener.dataset.openGroup) || sharedSongs.find((song) => song.id === opener.dataset.openGroup), 'group');
  });
  $('backButton').addEventListener('click', () => { showView('library'); renderSongRows(); });
  $('readerBackButton').addEventListener('click', () => showView('library'));
  $('readerEditButton').addEventListener('click', () => openEditor(currentSong, ['group', 'groupLibrary'].includes(readerContext) ? activeGroup?.id : null, readerContext === 'group' ? activeWeeklySet?.id : null));
  $('readerPrevButton').addEventListener('click', () => navigateReader(-1));
  $('readerNextButton').addEventListener('click', () => navigateReader(1));
  $('readerQueue').addEventListener('click', (event) => {
    const button = event.target.closest('[data-reader-queue-song]');
    if (!button) return;
    const song = readerContextSongs().find((item) => item.id === button.dataset.readerQueueSong);
    if (song) openReader(song, readerContext);
  });
  $('readerQueueToggle').addEventListener('click', () => {
    const isOpen = $('readerView').classList.toggle('show-reader-queue');
    $('readerQueueToggle').setAttribute('aria-expanded', String(isOpen));
    saveViewState();
  });
  $('syncConflictCloud').addEventListener('click', () => applyConflictChoice('cloud'));
  $('syncConflictOffline').addEventListener('click', () => applyConflictChoice('offline'));
  $('syncConflictBoth').addEventListener('click', () => applyConflictChoice('both'));
  $('syncNowButton').addEventListener('click', async () => {
    if (!navigator.onLine) { notify('อุปกรณ์ยังออฟไลน์อยู่'); return; }
    if (reconnectInProgress) return;
    reconnectInProgress = true;
    try { await hydrateAccount(); } catch (error) { notify(error.message || 'เชื่อมต่อไม่สำเร็จ'); }
    finally { reconnectInProgress = false; }
  });
  $('readerSourceKeyButton').addEventListener('click', async () => {
    const originalKey = currentSong?.key || 'C';
    if (readerContext === 'group' && canEditActiveGroup()) {
      await setGroupDisplayKey(originalKey);
    } else if (readerContext === 'groupLibrary' && canEditActiveGroup()) {
      await setGroupLibraryDisplayKey(originalKey);
    } else {
      $('readerKeySelect').value = originalKey;
      renderChordContent($('readerChords'), currentSong, originalKey);
    }
  });
  $('formatSpacingButton').addEventListener('click', () => {
    const field = $('chordText');
    previousFormatText = field.value;
    field.value = normalizeChordSpacing(field.value);
    $('undoFormatButton').disabled = field.value === previousFormatText;
    updatePreview();
  });
  $('undoFormatButton').addEventListener('click', () => {
    if (previousFormatText === null) return;
    $('chordText').value = previousFormatText;
    previousFormatText = null;
    $('undoFormatButton').disabled = true;
    updatePreview();
  });
  for (const [fitId, columnsId, targetId] of [['previewFitButton', 'previewColumnsButton', 'songPreview'], ['readerFitButton', 'readerColumnsButton', 'readerChords']]) {
    $(fitId).addEventListener('click', () => {
      const button = $(fitId);
      button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
      setFitLayout($(targetId), button.getAttribute('aria-pressed') === 'true', $(columnsId).getAttribute('aria-pressed') === 'true');
      const isReader = targetId === 'readerChords';
      applyCompactText($(targetId), Number($(isReader ? 'readerFontSize' : 'fontSizeRange').value), Number($(isReader ? 'readerLineSpacing' : 'lineSpacingRange').value), button.getAttribute('aria-pressed') === 'true');
      if (isReader) saveReaderPreferences();
    });
    $(columnsId).addEventListener('click', () => {
      const button = $(columnsId);
      const isEnabled = button.getAttribute('aria-pressed') === 'true';
      if (!isEnabled && !window.matchMedia('(min-width: 761px)').matches) {
        notify('สองคอลัมน์ใช้ได้บนจอกว้าง เช่น iPad จอคอม');
        return;
      }
      button.setAttribute('aria-pressed', String(!isEnabled));
      setFitLayout($(targetId), $(fitId).getAttribute('aria-pressed') === 'true', button.getAttribute('aria-pressed') === 'true');
      if (targetId === 'readerChords') saveReaderPreferences();
    });
  }
  $('searchResults').addEventListener('click', async (event) => {
    const result = event.target.closest('[data-open-search-song]');
    if (result) {
      await openSearchSong(result);
      return;
    }
    if (event.target.closest('#searchAddSongButton')) openEditor(makeBlankSong());
    if (event.target.closest('#retrySearchButton')) renderSearchResults($('searchInput').value.trim());
    if (event.target.closest('#searchLoginButton')) {
      updateAccountDialog();
      openAppDialog($('accountDialog'));
    }
  });
  $('clearSearchButton').addEventListener('click', () => {
    $('searchInput').value = '';
    searchScope = 'all';
    document.querySelectorAll('[data-search-scope]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.searchScope === 'all')));
    renderSongRows();
    $('searchInput').focus();
  });
  $('searchScopeFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-search-scope]');
    if (!button) return;
    searchScope = button.dataset.searchScope;
    document.querySelectorAll('[data-search-scope]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    renderSearchResults($('searchInput').value.trim());
  });
  $('saveSongButton').addEventListener('click', saveCurrentSong);
  $('searchInput').addEventListener('input', () => {
    if ($('searchInput').value.trim()) {
      syncSearchVisibility();
      renderSearchResults($('searchInput').value.trim());
    } else renderSongRows();
  });
  ['songTitle', 'songArtist'].forEach((id) => $(id).addEventListener('input', updatePreview));
  $('chordText').addEventListener('input', () => {
    previousFormatText = null;
    $('undoFormatButton').disabled = true;
    editorSourceKeyConfirmed = false;
    updatePreview();
  });
  $('keySelect').addEventListener('change', updatePreview);
  $('sourceKeySelect').addEventListener('change', () => { editorSourceKeyConfirmed = false; $('keySelect').value = $('sourceKeySelect').value; updatePreview(); });
  $('confirmSourceKeyButton').addEventListener('click', () => { editorSourceKeyConfirmed = true; updateSourceKeyStatus(); notify(`ยืนยันคีย์ต้นฉบับ ${$('sourceKeySelect').value} แล้ว`); });
  $('applyKeySuggestionButton').addEventListener('click', () => {
    const suggestion = suggestSourceKey($('chordText').value);
    if (!suggestion) return;
    editorSourceKeyConfirmed = false;
    const root = suggestion.key.replace(/m$/, '');
    $('sourceKeySelect').value = root;
    $('keySelect').value = root;
    updatePreview();
    notify(`ตั้งคีย์แนะนำเป็น ${suggestion.key} แล้ว · โปรดตรวจฟังก่อนยืนยัน`);
  });
  $('fontSizeRange').addEventListener('input', updatePreview);
  $('readerKeySelect').addEventListener('change', async () => {
    const targetKey = $('readerKeySelect').value;
    if (offlineMode && offlineGroupSnapshot && ['group', 'groupLibrary'].includes(readerContext) && canEditActiveGroup()) {
      await setOfflineGroupDisplayKey(targetKey);
    } else if (readerContext === 'group' && canEditActiveGroup()) {
      await setGroupDisplayKey(targetKey);
    } else if (readerContext === 'groupLibrary' && canEditActiveGroup()) {
      await setGroupLibraryDisplayKey(targetKey);
    } else {
      renderChordContent($('readerChords'), currentSong, targetKey);
    }
  });
  $('readerFontSize').addEventListener('input', () => { applyCompactText($('readerChords'), Number($('readerFontSize').value), Number($('readerLineSpacing').value), $('readerFitButton').getAttribute('aria-pressed') === 'true'); saveReaderPreferences(); });
  $('lineSpacingRange').addEventListener('input', updatePreview);
  $('readerLineSpacing').addEventListener('input', () => { applyCompactText($('readerChords'), Number($('readerFontSize').value), Number($('readerLineSpacing').value), $('readerFitButton').getAttribute('aria-pressed') === 'true'); saveReaderPreferences(); });
  $('backupButton').addEventListener('click', () => openAppDialog($('fileTransferDialog')));
  $('exportPersonalButton').addEventListener('click', downloadBackup);
  $('exportGroupButton').addEventListener('click', downloadGroupBackup);
  $('importTargetSelect').addEventListener('change', updateImportTargetHelp);
  $('importGroupSelect').addEventListener('change', updateImportTargetHelp);
  $('chooseImportFileButton').addEventListener('click', () => $('backupFile').click());
  $('backupFile').addEventListener('change', (event) => { if (event.target.files[0]) previewBackupImport(event.target.files[0]); event.target.value = ''; });
  $('confirmImportButton').addEventListener('click', () => { if (pendingBackupImport) importBackup(pendingBackupImport); });
  $('songList').addEventListener('click', async (event) => {
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      const { action, id } = actionButton.dataset;
      if (action === 'today') await placeSongInToday(id);
      if (action === 'shareGroup') await shareSongToGroup(id);
      if (action === 'suggestGroup') await suggestSongToGroup(id);
      if (action === 'up') await moveSong(id, -1);
      if (action === 'down') await moveSong(id, 1);
      if (action === 'edit') openEditor(songs.find((song) => song.id === id));
      if (action === 'delete') {
        const song = songs.find((item) => item.id === id);
        if (!song || !await confirmAction({ title: 'ลบเพลงนี้หรือไม่?', message: `“${song.title}” จะถูกลบออกจากเพลงของคุณและเพลงวันนี้`, confirmLabel: 'ลบเพลง', danger: true })) return;
        await deletePersonalSong(song);
      }
      return;
    }
    const opener = event.target.closest('[data-open]');
    if (opener) openReader(songs.find((song) => song.id === opener.dataset.open));
  });
  $('todaySongList').addEventListener('click', async (event) => {
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      const { action, id } = actionButton.dataset;
      if (action === 'todayUp') await moveTodaySong(id, -1);
      if (action === 'todayDown') await moveTodaySong(id, 1);
      if (action === 'todayRemove') await removeSongFromToday(id);
      return;
    }
    const opener = event.target.closest('[data-open-today]');
    if (opener) openReader(songs.find((song) => song.id === opener.dataset.openToday), 'today');
  });
  $('songList').addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-open]')) {
      event.preventDefault();
      openReader(songs.find((song) => song.id === event.target.dataset.open));
    }
  });

  const clearDropMarkers = () => document.querySelectorAll('.drag-over').forEach((row) => row.classList.remove('drag-over'));
  const onDragStart = (event) => {
    const row = event.target.closest('.song-row, .today-song-row, .group-song-row');
    const clickedButton = event.target.closest('button');
    if (!row || (clickedButton && !clickedButton.matches('.group-song-open'))) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', row.dataset.id);
    event.dataTransfer.setData('application/x-worship-origin', row.classList.contains('today-song-row') ? 'today' : row.classList.contains('group-song-row') ? 'group' : 'library');
    row.classList.add('dragging');
  };
  const onDragEnd = (event) => { event.target.closest('.song-row, .today-song-row, .group-song-row')?.classList.remove('dragging'); clearDropMarkers(); };
  const onDragOver = (event) => {
    if (!Array.from(event.dataTransfer.types || []).includes('text/plain')) return;
    event.preventDefault();
    clearDropMarkers();
    event.target.closest('.song-row, .today-song-row, .today-panel, .group-panel, .group-song-row, .personal-library-drop-zone, .song-list')?.classList.add('drag-over');
  };
  $('songList').addEventListener('dragstart', onDragStart);
  $('todaySongList').addEventListener('dragstart', onDragStart);
  $('groupSongList').addEventListener('dragstart', onDragStart);
  $('songList').addEventListener('dragend', onDragEnd);
  $('todaySongList').addEventListener('dragend', onDragEnd);
  $('groupSongList').addEventListener('dragend', onDragEnd);
  $('personalLibraryDropZone').addEventListener('dragover', onDragOver);
  $('todaySetlistPanel').addEventListener('dragover', onDragOver);
  $('personalLibraryDropZone').addEventListener('dragleave', (event) => { if (!event.currentTarget.contains(event.relatedTarget)) clearDropMarkers(); });
  $('todaySetlistPanel').addEventListener('dragleave', (event) => { if (!event.currentTarget.contains(event.relatedTarget)) clearDropMarkers(); });
  $('groupSongList').addEventListener('dragover', onDragOver);
  $('groupSongList').addEventListener('dragleave', (event) => { if (!event.currentTarget.contains(event.relatedTarget)) clearDropMarkers(); });
  $('groupPanel').addEventListener('dragover', onDragOver);
  $('groupPanel').addEventListener('dragleave', (event) => { if (!event.currentTarget.contains(event.relatedTarget)) clearDropMarkers(); });
  $('groupSongList').addEventListener('drop', async (event) => {
    event.preventDefault();
    const songId = event.dataTransfer.getData('text/plain');
    const origin = event.dataTransfer.getData('application/x-worship-origin');
    const target = event.target.closest('.group-song-row');
    if (origin === 'group' && songId && activeGroup && canEditActiveGroup()) {
      if (target?.dataset.id === songId) { clearDropMarkers(); return; }
      const ids = activeSetSongs.map((song) => song.id);
      const movingIndex = ids.indexOf(songId);
      if (movingIndex < 0) { clearDropMarkers(); return; }
      ids.splice(movingIndex, 1);
      let index = target ? ids.indexOf(target.dataset.id) : ids.length;
      const rect = target?.getBoundingClientRect();
      if (index < 0) index = ids.length;
      if (rect && event.clientY > rect.top + rect.height / 2) index += 1;
      ids.splice(Math.min(index, ids.length), 0, songId);
      try {
        await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/setlist`, { method: 'PATCH', body: JSON.stringify({ songIds: ids, setId: activeWeeklySet?.id }) });
        await loadActiveGroup();
      } catch (error) { notify(error.message); }
    }
    clearDropMarkers();
  });
  $('groupPanel').addEventListener('drop', async (event) => {
    event.preventDefault();
    const songId = event.dataTransfer.getData('text/plain');
    const origin = event.dataTransfer.getData('application/x-worship-origin');
    if (origin === 'library' && songId && canEditActiveGroup()) {
      try { await shareSongToGroup(songId); }
      catch (error) { notify(error.message || 'เพิ่มเพลงเข้ากลุ่มไม่สำเร็จ'); }
    }
    clearDropMarkers();
  });
  $('personalLibraryDropZone').addEventListener('drop', async (event) => {
    event.preventDefault();
    const songId = event.dataTransfer.getData('text/plain');
    const origin = event.dataTransfer.getData('application/x-worship-origin');
    const target = event.target.closest('.song-row');
    if (origin === 'library' && songId) {
      const rect = target?.getBoundingClientRect();
      await reorderLibrarySong(songId, target?.dataset.id || null, Boolean(rect && event.clientY > rect.top + rect.height / 2));
    }
    if (origin === 'group' && songId) await copyGroupSongToLibrary(songId);
    clearDropMarkers();
  });
  $('todaySetlistPanel').addEventListener('drop', async (event) => {
    event.preventDefault();
    const songId = event.dataTransfer.getData('text/plain');
    const origin = event.dataTransfer.getData('application/x-worship-origin');
    const target = event.target.closest('.today-song-row');
    const rect = target?.getBoundingClientRect();
    const after = Boolean(rect && event.clientY > rect.top + rect.height / 2);
    if (origin === 'today') await reorderTodaySong(songId, target?.dataset.id || null, after);
    else if (origin === 'library') await placeSongInToday(songId, target?.dataset.id || null, after);
    clearDropMarkers();
  });

  window.addEventListener('offline', async () => {
    if (!authUser) return;
    await enterOfflineMode('ไม่มีอินเทอร์เน็ต');
    notify('ออฟไลน์: เพลงกลุ่มและคำเชิญใช้ไม่ได้');
  });
  window.addEventListener('online', async () => {
    if (!authUser || reconnectInProgress) return;
    reconnectInProgress = true;
    try { await hydrateAccount(); }
    catch (error) { notify(error.message || 'เชื่อมต่อไม่สำเร็จ'); }
    finally { reconnectInProgress = false; }
  });
}

async function init() {
  try {
    db = await openDatabase();
    legacySongs = await getAllSongs();
    legacyTodaySetlist = await getSetlist(TODAY_SETLIST_ID) || { id: TODAY_SETLIST_ID, name: 'เพลงวันนี้', songIds: [] };
    const legacyIds = new Set(legacySongs.map((song) => song.id));
    legacyTodaySetlist = { ...legacyTodaySetlist, songIds: legacyTodaySetlist.songIds.filter((id) => legacyIds.has(id)) };
    songs = [];
    todaySetlist = { id: TODAY_SETLIST_ID, name: 'เพลงวันนี้', songIds: [] };
    renderSongRows();
    bindEvents();
    renderGroupPanel();
    updateAccountDialog();
    hydrateAccount().catch(() => {});
  } catch {
    $('emptyState').hidden = false;
    notify('เบราว์เซอร์ปิดการเก็บข้อมูล กรุณาเปิดใช้งานพื้นที่จัดเก็บ');
  }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}

init();
