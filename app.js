const DB_NAME = 'worshipchord-local';
const DB_VERSION = 4;
const TODAY_SETLIST_ID = 'today';
const LAST_USER_KEY = `${DB_NAME}-last-user`;
const KEYS = ['C', 'C♯/D♭', 'D', 'D♯/E♭', 'E', 'F', 'F♯/G♭', 'G', 'G♯/A♭', 'A', 'A♯/B♭', 'B'];
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const $ = (id) => document.getElementById(id);
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
let authUser = null;
let offlineMode = false;
let previousFormatText = null;
let pendingBackupImport = null;
const READER_PREFS_KEY = 'worshipchord.readerPreferences.v1';
let songOrderRevision = 0;
let syncInProgress = false;
let reconnectInProgress = false;
let pendingSyncConflict = null;
let groups = [];
let activeGroup = null;
let sharedSongs = [];
let offlineGroupSnapshot = false;
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
  groups = snapshot ? [snapshot.group] : []; activeGroup = snapshot?.group || null; sharedSongs = snapshot?.songs || [];
  offlineGroupSnapshot = Boolean(snapshot);
  if (editingGroupId && !$('editorView').hidden) {
    editingGroupId = null;
    showView('library');
    notify('การแก้เพลงกลุ่มต้องเชื่อมต่ออินเทอร์เน็ต');
  }
  if (readerContext === 'group' && !$('readerView').hidden && !offlineGroupSnapshot) showView('library');
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
  dialog.showModal();
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
    const shouldImport = window.confirm(`พบเพลงเก่า ${legacySongs.length} เพลงที่ยังเก็บในเครื่อง ต้องการนำเข้าไปยังบัญชี ${user.email} เพื่อซิงก์ผ่าน MongoDB หรือไม่?`);
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
  const readerWasOpen = !$('readerView').hidden && readerContext !== 'group';
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

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response;
  try { response = await fetch(path, { ...options, headers, credentials: 'same-origin' }); }
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

function transposeChord(chord, shift) {
  const match = /^([A-G][#b]?)(.*)$/.exec(chord);
  if (!match) return chord;
  const root = parseRoot(match[1]);
  if (!root) return chord;
  let suffix = match[2];
  let bass = '';
  const slash = /^(.*)\/([A-G][#b]?)$/.exec(suffix);
  if (slash) {
    suffix = slash[1];
    const bassRoot = parseRoot(slash[2]);
    bass = `/${(FLAT_NAMES[(bassRoot.semitones + shift + 120) % 12])}`;
  }
  const useFlat = /b/.test(match[1]);
  const names = useFlat ? FLAT_NAMES : SHARP_NAMES;
  return `${names[(root.semitones + shift + 120) % 12]}${suffix}${bass}`;
}

const CHORD_EXPRESSION_PATTERN = /[A-G](?:#|b)?(?:(?:maj|min|m|dim|aug|sus2|sus4|sus|add\d{1,2}|\d{1,2})|-(?=$|[\s|,;:/(){}]))?(?:\/[A-G](?:#|b)?)?/g;

function isChordExpression(value) {
  const chords = value.match(CHORD_EXPRESSION_PATTERN) || [];
  const residue = value.replace(CHORD_EXPRESSION_PATTERN, '');
  return chords.length > 0 && /^[\s|,;:/(){}-]*$/.test(residue);
}

function transposeChordExpression(value, shift) {
  return value.replace(CHORD_EXPRESSION_PATTERN, (chord) => {
    const parsed = strictChordToken(chord);
    return parsed ? transposeChord(parsed, shift) : chord;
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
      if (isChordExpression(suffix)) return labeledList[1] + transposeChordExpression(suffix, shift);
    }
    // Older imported songs may have an untagged chord-only row (for example "G C").
    // Transpose those rows too, but never scan ordinary lyrics for chord letters.
    const plainTokens = line.trim().split(/\s+/).filter(Boolean);
    const plainChordRow = !line.includes('[') && !/[\u0E00-\u0E7F]/.test(line) && plainTokens.length > 0
      && plainTokens.some(isChordExpression)
      && plainTokens.every((token) => isChordExpression(token) || /^[|,;:/]+$/.test(token));
    if (plainChordRow) return transposeChordExpression(line, shift);

    return line.replace(/\[([^\]]+)\]/g, (whole, value) => {
      const singleChord = strictChordToken(value.trim());
      if (singleChord) return `[${transposeChord(singleChord, shift)}]`;
      if (isChordExpression(value.trim())) return `[${transposeChordExpression(value.trim(), shift)}]`;
      const tokens = value.trim().split(/(\s+)/);
      const transposed = tokens.map((token) => strictChordToken(token) ? transposeChord(strictChordToken(token), shift) : token);
      return `[${transposed.join('')}]`;
    });
  }).join('\n');
}

function chordHtml(text) {
  return escapeHtml(text).replace(/\[([^\]]+)\]/g, '<span class="chord-token">[$1]</span>');
}

function keyOptions(select, value = 'C') {
  select.innerHTML = KEYS.map((key, index) => `<option value="${SHARP_NAMES[index]}" ${SHARP_NAMES[index] === value ? 'selected' : ''}>${key}</option>`).join('');
}

function activeGroupRole() {
  return activeGroup?.members?.find((member) => member.userId === authUser?.id)?.role || null;
}

function canEditActiveGroup() { return ['owner', 'editor'].includes(activeGroupRole()); }

function renderGroupPanel() {
  $('groupPanel').hidden = !authUser || (offlineMode && !offlineGroupSnapshot);
  $('inboxButton').hidden = !authUser || offlineMode;
  $('accountButtonLabel').textContent = authUser ? (authUser.displayName || authUser.email.split('@')[0]) : 'เข้าสู่ระบบ';
  $('localBadgeText').textContent = offlineMode ? 'ออฟไลน์ · แก้ไขรอซิงก์' : authUser ? 'ซิงก์เพลงกับบัญชี' : 'เข้าสู่ระบบเพื่อดูเพลง';
  $('newSongButton').disabled = !authUser;
  $('backupButton').disabled = !authUser;
  $('importBackupButton').disabled = !authUser || offlineMode;
  $('createGroupButton').disabled = !authUser || offlineMode;
  $('groupSelect').innerHTML = groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('');
  $('groupSelect').disabled = groups.length === 0 || offlineMode;
  if (activeGroup) $('groupSelect').value = activeGroup.id;
  const offlineGroupPrepared = Boolean(activeGroup && localStorage.getItem(`${READER_PREFS_KEY}.offlineGroup`) === activeGroup.id);
  $('prepareOfflineGroupButton').hidden = !activeGroup;
  $('prepareOfflineGroupButton').disabled = offlineMode || !activeGroup;
  $('prepareOfflineGroupButton').textContent = offlineGroupPrepared ? 'บันทึกไว้แล้ว ✓' : 'บันทึกไว้ดูออฟไลน์';
  $('groupOfflineHelp').hidden = !activeGroup || offlineMode;
  $('groupOfflineHelp').textContent = offlineGroupPrepared
    ? 'บันทึกเพลงกลุ่มนี้ไว้ในอุปกรณ์แล้ว เปิดดูได้เมื่อไม่มีอินเทอร์เน็ต (อ่านอย่างเดียว) · ไม่ได้เพิ่มลงเพลงของฉัน'
    : 'บันทึกสำเนาเพลงกลุ่มไว้ในอุปกรณ์นี้ เพื่อเปิดดูเมื่อไม่มีอินเทอร์เน็ต · ใช้ได้เฉพาะเครื่องนี้ และขณะออฟไลน์จะอ่านได้อย่างเดียว';
  $('groupOfflineStatus').hidden = !offlineGroupSnapshot;
  if (offlineGroupSnapshot) $('groupOfflineStatus').textContent = 'กำลังเปิดสำเนาเพลงกลุ่มจากอุปกรณ์นี้ · อ่านอย่างเดียว · การเปลี่ยนคีย์มีผลเฉพาะอุปกรณ์นี้';
  $('inviteGroupButton').disabled = offlineMode || !activeGroup || !activeGroupRole();
  $('addGroupSongButton').hidden = !canEditActiveGroup() || offlineMode;
  $('groupDropHint').hidden = !canEditActiveGroup() || offlineMode;
  $('libraryDropHint').hidden = !activeGroup || offlineMode;
  $('groupEmptyState').hidden = Boolean(activeGroup);
  $('groupEmptyState').textContent = groups.length ? 'เลือกกลุ่มเพื่อดูเพลงและสมาชิก' : 'สร้างกลุ่มเพื่อแชร์เพลงและลำดับเพลงกับทีมแบบเรียลไทม์';
  renderGroupMembers();
  renderGroupSongs();
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
  if (!activeGroup) { $('groupSongList').innerHTML = ''; return; }
  const canEdit = canEditActiveGroup() && !offlineMode;
  const canCopy = !offlineMode;
  $('groupSongList').innerHTML = sharedSongs.map((song, index) => `<article class="group-song-row" data-id="${escapeHtml(song.id)}" draggable="true" aria-grabbed="false">
    <span class="today-order">${String(index + 1).padStart(2, '0')}</span>
    <button class="group-song-open" data-open-group="${escapeHtml(song.id)}"><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${escapeHtml(song.artist || 'ไม่ระบุศิลปิน')} · คีย์ ${escapeHtml(song.displayKey || song.key || 'C')}</small></button>
    <div class="group-song-actions">${canCopy ? `<button class="group-song-copy" data-group-action="copy" data-id="${escapeHtml(song.id)}" aria-label="คัดลอกเพลงไปเพลงของฉัน" title="คัดลอกเป็นเพลงส่วนตัว ไม่กระทบต้นฉบับ">＋ คัดลอก</button>` : ''}${canEdit ? `<button data-group-action="up" data-id="${escapeHtml(song.id)}" aria-label="เลื่อนเพลงกลุ่มขึ้น">↑</button><button data-group-action="down" data-id="${escapeHtml(song.id)}" aria-label="เลื่อนเพลงกลุ่มลง">↓</button><button data-group-action="edit" data-id="${escapeHtml(song.id)}">แก้ไข</button><button data-group-action="remove" data-id="${escapeHtml(song.id)}" aria-label="นำเพลงออกจากกลุ่ม">เอาออก</button>` : ''}</div>
  </article>`).join('');
}

async function loadGroups(preferredId = activeGroup?.id) {
  if (!authUser || offlineMode) return;
  const previousGroupId = activeGroup?.id;
  const result = await api('/api/groups');
  groups = result.groups;
  offlineGroupSnapshot = false;
  activeGroup = groups.find((group) => group.id === preferredId) || groups[0] || null;
  if (previousGroupId && previousGroupId !== activeGroup?.id) sendRealtime({ type: 'unsubscribe', groupId: previousGroupId });
  renderGroupPanel();
  if (activeGroup) await loadActiveGroup();
  else { sharedSongs = []; renderGroupPanel(); }
  renderSongRows();
}

async function loadActiveGroup() {
  if (!authUser || offlineMode || !activeGroup) return;
  const id = activeGroup.id;
  const result = await api(`/api/groups/${encodeURIComponent(id)}`);
  if (activeGroup?.id !== id) return;
  activeGroup = result.group;
  sharedSongs = result.songs;
  const snapshot = { id: activeGroup.id, group: activeGroup, songs: sharedSongs, savedAt: Date.now() };
  await saveGroupSnapshot(snapshot).catch(() => {});
  renderGroupPanel();
  sendRealtime({ type: 'subscribe', groupId: id });
}

async function prepareActiveGroupOffline() {
  if (!activeGroup || offlineMode || !sharedSongs.length) { notify('เชื่อมต่อและเลือกกลุ่มที่มีเพลงก่อน'); return; }
  try {
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}`);
    activeGroup = result.group;
    sharedSongs = result.songs;
    await saveGroupSnapshot({ id: activeGroup.id, group: activeGroup, songs: sharedSongs, savedAt: Date.now() });
    localStorage.setItem(`${READER_PREFS_KEY}.offlineGroup`, activeGroup.id);
    offlineGroupSnapshot = false;
    renderGroupPanel();
    notify(`เตรียม “${activeGroup.name}” ไว้เปิดอ่านออฟไลน์แล้ว`);
  } catch (error) { notify(error.message || 'เตรียมกลุ่มออฟไลน์ไม่สำเร็จ'); }
}

function connectRealtime() {
  realtimeSocket?.close();
  if (!authUser || offlineMode || !window.WebSocket) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/realtime`);
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
      notify('มีการแจ้งเตือนใหม่');
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
      try {
        const readerWasOpen = !$('readerView').hidden && readerContext === 'group';
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

function renderNotifications() {
  $('notificationEmpty').hidden = notifications.length > 0;
  $('notificationList').innerHTML = notifications.map((item) => {
    const invitePending = item.type === 'group_invite' && item.invitationStatus === 'pending';
    const message = item.type === 'group_invite'
      ? `${escapeHtml(item.inviterName || 'สมาชิก')} เชิญเข้ากลุ่ม “${escapeHtml(item.groupName || '')}” (${item.role === 'editor' ? 'แก้ไขได้' : 'ดูได้'})`
      : item.type === 'invitation_response'
        ? `${escapeHtml(item.recipientEmail || 'สมาชิก')} ${item.decision === 'accepted' ? 'ตอบรับ' : 'ปฏิเสธ'}คำเชิญเข้ากลุ่ม “${escapeHtml(item.groupName || '')}”`
        : `มีความเปลี่ยนแปลงในกลุ่ม “${escapeHtml(item.groupName || '')}”`;
    const date = item.createdAt ? new Date(item.createdAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const actions = invitePending
      ? `<div class="notification-actions"><button class="accept-invite" data-notification-action="accept" data-id="${escapeHtml(item.invitationId)}">เข้าร่วมกลุ่ม</button><button data-notification-action="decline" data-id="${escapeHtml(item.invitationId)}">ปฏิเสธ</button></div>`
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
    notify('เพิ่มเพลงเข้า list กลุ่มแล้ว');
  } catch (error) {
    notify(error.message || 'แชร์เพลงไม่สำเร็จ');
  }
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
    chordUrl: source.chordUrl || ''
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

async function setGroupDisplayKey(key) {
  if (readerContext !== 'group' || !currentSong || !activeGroup || (!canEditActiveGroup() && !(offlineMode && offlineGroupSnapshot))) return false;
  if (key === (currentSong.displayKey || currentSong.key || 'C')) return true;
  if (offlineMode && offlineGroupSnapshot) {
    currentSong = { ...currentSong, displayKey: key };
    $('readerKeySelect').value = key;
    renderChordContent($('readerChords'), currentSong, key);
    notify(`เปลี่ยนคีย์เฉพาะเครื่องนี้เป็น ${key} · ไม่ได้เปลี่ยนเพลงในกลุ่ม`);
    return true;
  }
  try {
    const result = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/songs/${encodeURIComponent(currentSong.id)}/display-key`, {
      method: 'PATCH',
      body: JSON.stringify({ key, expectedRevision: currentSong.revision || 1 })
    });
    currentSong = result.song;
    sharedSongs = sharedSongs.map((song) => song.id === result.song.id ? result.song : song);
    $('readerKeySelect').value = result.song.displayKey || result.song.key;
    renderChordContent($('readerChords'), result.song, $('readerKeySelect').value);
    renderGroupSongs();
    notify(`เปลี่ยนคีย์กลุ่มเป็น ${key} แล้ว`);
    return true;
  } catch (error) {
    notify(error.message || 'เปลี่ยนคีย์กลุ่มไม่สำเร็จ');
    const latest = error.payload?.song || sharedSongs.find((song) => song.id === currentSong?.id);
    if (latest) {
      currentSong = latest;
      sharedSongs = sharedSongs.map((song) => song.id === latest.id ? latest : song);
      $('readerKeySelect').value = latest.displayKey || latest.key || 'C';
      renderChordContent($('readerChords'), latest, $('readerKeySelect').value);
      renderGroupSongs();
    }
    return false;
  }
}

function syncGroupSongInReader(songId) {
  if (!songId || currentSong?.id !== songId) return;
  const updated = sharedSongs.find((song) => song.id === songId);
  if (!updated) { showView('library'); notify('เพลงนี้ถูกนำออกจากกลุ่มแล้ว'); return; }
  currentSong = updated;
  $('readerTitle').textContent = updated.title || 'เพลงไม่มีชื่อ';
  $('readerArtist').textContent = updated.artist || 'WORSHIP SONG';
  $('readerEditButton').hidden = !canEditActiveGroup();
  setReaderKeyGuidance('group');
  keyOptions($('readerKeySelect'), updated.displayKey || updated.key || 'C');
  renderChordContent($('readerChords'), updated, $('readerKeySelect').value);
  renderReaderQueue();
}

function setReaderKeyGuidance(context) {
  const sharedEditor = context === 'group' && canEditActiveGroup();
  const sharedViewer = context === 'group' && !sharedEditor;
  $('readerKeyLabel').textContent = sharedEditor ? 'คีย์เพลงในกลุ่ม' : sharedViewer ? 'คีย์ส่วนตัว' : 'คีย์แสดงผล';
  $('readerKeyScopeHint').textContent = sharedEditor
    ? 'เปลี่ยนแล้วทุกคนในกลุ่มเห็นทันที · คีย์ต้นฉบับยังคงเดิม'
    : sharedViewer
      ? 'ปรับเฉพาะหน้าคุณ · ไม่เปลี่ยนคีย์ที่สมาชิกคนอื่นเห็น'
      : 'ปรับคอร์ดที่แสดงสำหรับคุณ · ไม่แก้เนื้อเพลงหรือคีย์ต้นฉบับ';
  $('readerKeySelect').setAttribute('aria-label', sharedEditor ? 'เปลี่ยนคีย์เพลงในกลุ่มสำหรับสมาชิกทุกคน' : sharedViewer ? 'ปรับคีย์เฉพาะหน้าคุณ' : 'เลือกคีย์แสดงผล');
  $('readerSourceKeyButton').title = sharedEditor
    ? 'ตั้งคีย์เพลงในกลุ่มกลับเป็นคีย์ต้นฉบับให้ทุกคน'
    : 'แสดงเพลงในคีย์ต้นฉบับ';
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
          if (offlineMode) return;
          try {
            await Promise.all([loadGroups(), refreshNotifications()]);
            connectRealtime();
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

async function createGroup() {
  if (offlineMode) { notify('การจัดการกลุ่มต้องเชื่อมต่ออินเทอร์เน็ต'); return; }
  const name = window.prompt('ตั้งชื่อกลุ่มเพลง');
  if (name === null) return;
  try {
    const result = await api('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
    await loadGroups(result.group.id);
    connectRealtime();
    notify('สร้างกลุ่มแล้ว');
  } catch (error) { notify(error.message); }
}

async function moveSharedSong(songId, delta) {
  if (!activeGroup || !canEditActiveGroup()) return;
  const ids = [...activeGroup.songIds];
  const index = ids.indexOf(songId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  try {
    await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/setlist`, { method: 'PATCH', body: JSON.stringify({ songIds: ids }) });
    await loadActiveGroup();
  } catch (error) { notify(error.message); }
}

async function removeSharedSong(songId) {
  if (!activeGroup || !canEditActiveGroup()) return;
  const song = sharedSongs.find((item) => item.id === songId);
  if (!song || !window.confirm(`เอา “${song.title}” ออกจากเพลงของกลุ่มใช่ไหม?`)) return;
  try {
    await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/songs/${encodeURIComponent(songId)}`, { method: 'DELETE' });
    sharedSongs = sharedSongs.filter((item) => item.id !== songId);
    renderGroupSongs();
    notify('นำเพลงออกจากกลุ่มแล้ว');
  } catch (error) { notify(error.message); }
}

function renderSongRows() {
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
  const query = $('searchInput').value.trim().toLowerCase();
  const searchItems = [
    ...songs.map((song) => ({ song, context: 'library' })),
    ...(!offlineMode ? sharedSongs.map((song) => ({ song, context: 'group' })) : []),
  ];
  const visibleItems = searchItems.filter(({ song }) => `${song.title} ${song.artist || ''} ${song.text || ''}`.toLocaleLowerCase('th-TH').includes(query));
  const visible = visibleItems.filter(({ context }) => context === 'library').map(({ song }) => song);
  const results = $('searchResults');
  results.hidden = !query;
  $('searchHelp').hidden = Boolean(query);
  if (query) {
    const markup = visibleItems.map(({ song, context }) => {
      const title = (song.title || '').toLowerCase().includes(query);
      const artist = (song.artist || '').toLowerCase().includes(query);
      const chordHit = String(song.text || '').split(/\r?\n/).some((line) => {
        const bracketed = [...line.matchAll(/\[([^\]]+)\]/g)].some((match) => isChordExpression(match[1]) && match[1].toLowerCase().includes(query));
        const row = line.trim().split(/\s+/).filter(Boolean);
        const unbracketed = row.length > 0 && !/[\u0E00-\u0E7F]/.test(line) && row.every((token) => /^[|,;:/]+$/.test(token) || strictChordToken(token)) && row.some((token) => strictChordToken(token)?.toLowerCase().includes(query));
        return bracketed || unbracketed;
      });
      const source = title ? 'ชื่อเพลง' : artist ? 'ศิลปิน/ผู้แต่ง' : chordHit ? 'คอร์ด' : 'เนื้อเพลง';
      const contextLabel = context === 'group' ? 'เพลงในกลุ่ม' : 'เพลงของฉัน';
      return `<button type="button" class="search-result" data-open-search-song="${escapeHtml(song.id)}" data-search-context="${context}"><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><span>${escapeHtml(song.artist || 'ไม่ระบุศิลปิน')} · ${contextLabel} · พบใน${source} · คีย์ ${escapeHtml(song.key || 'C')}</span></button>`;
    }).join('');
    results.innerHTML = `<p class="search-result-count">${visibleItems.length ? `พบ ${visibleItems.length} เพลง` : 'ไม่พบเพลงที่ตรงกัน'}</p>${markup || `<button type="button" class="search-add-button" id="searchAddSongButton">＋ เพิ่มเพลง “${escapeHtml($('searchInput').value.trim())}”</button>`}`;
  } else results.innerHTML = '';
  const shareButton = authUser && canEditActiveGroup()
    ? '<button data-action="shareGroup" title="แชร์เข้า list กลุ่ม" aria-label="แชร์เพลงเข้ากลุ่ม">แชร์</button>'
    : '';
  $('songList').hidden = Boolean(query);
  $('songList').innerHTML = visible.map((song) => {
    const index = songs.findIndex((item) => item.id === song.id);
    const inToday = todaySetlist.songIds.includes(song.id);
    return `<article class="song-row" data-id="${song.id}" draggable="true" aria-grabbed="false">
      <span class="song-index">${String(index + 1).padStart(2, '0')}</span>
      <div class="song-main" data-open="${song.id}" tabindex="0" role="button" aria-label="เปิดเพลง ${escapeHtml(song.title)}"><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${escapeHtml(song.artist || 'ยังไม่ระบุศิลปิน')}</small></div>
      <span class="song-key">${escapeHtml(song.key || 'C')}</span>
      <div class="row-actions"><button data-action="today" data-id="${song.id}" title="${inToday ? 'อยู่ในเพลงวันนี้แล้ว' : 'เพิ่มเข้าเพลงวันนี้'}" aria-label="${inToday ? 'อยู่ในเพลงวันนี้แล้ว' : 'เพิ่มเข้าเพลงวันนี้'}" ${inToday ? 'disabled' : ''}>${inToday ? '✓' : '+ วันนี้'}</button>${shareButton.replaceAll('data-action="shareGroup"', `data-action="shareGroup" data-id="${song.id}"`)}<button data-action="up" data-id="${song.id}" title="เลื่อนขึ้น" aria-label="เลื่อนเพลงขึ้น">↑</button><button data-action="down" data-id="${song.id}" title="เลื่อนลง" aria-label="เลื่อนเพลงลง">↓</button><button data-action="edit" data-id="${song.id}" title="แก้ไข" aria-label="แก้ไขเพลง">✎</button><button data-action="delete" data-id="${song.id}" title="ลบ" aria-label="ลบเพลง">×</button></div>
    </article>`;
  }).join('');
  $('emptyState').hidden = songs.length > 0;
  $('emptyState').querySelector('h2').textContent = 'เริ่มทำสมุดเพลงของคุณ';
  $('emptyState').querySelector('p').textContent = 'เพิ่มเพลง พิมพ์เนื้อเพลงและคอร์ด แล้วเรียงลำดับตามชุดนมัสการ';
  $('emptyNewSongButton').textContent = '＋ เพิ่มเพลงแรก';
  $('todaySetlistEmpty').textContent = 'กด “+ วันนี้” ที่เพลง หรือ ลากเพลงจากคลังมาวางที่นี่';
  renderTodaySongs();
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
  $('todaySetlistEmpty').hidden = ordered.length > 0;
  $('todaySongList').innerHTML = ordered.map((song, index) => `<article class="today-song-row" data-id="${song.id}" draggable="true" aria-grabbed="false">
    <span class="today-drag-handle" aria-hidden="true">⠿</span>
    <button class="today-song-open" data-open-today="${song.id}" aria-label="เปิด ${escapeHtml(song.title || 'เพลงไม่มีชื่อ')} คอร์ด ${escapeHtml(song.key || 'C')}"><span class="today-order">${String(index + 1).padStart(2, '0')}</span><span class="today-song-copy"><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${escapeHtml(song.artist || 'ยังไม่ระบุศิลปิน')}</small></span><span class="song-key">${escapeHtml(song.key || 'C')}</span></button>
    <div class="today-row-actions"><button data-action="todayUp" data-id="${song.id}" aria-label="เลื่อนขึ้น" title="เลื่อนขึ้น">↑</button><button data-action="todayDown" data-id="${song.id}" aria-label="เลื่อนลง" title="เลื่อนลง">↓</button><button data-action="todayRemove" data-id="${song.id}" aria-label="เอาออกจากเพลงวันนี้" title="เอาออก">×</button></div>
  </article>`).join('');
}

function showView(view) {
  $('libraryView').hidden = view !== 'library';
  $('editorView').hidden = view !== 'editor';
  $('readerView').hidden = view !== 'reader';
  window.scrollTo(0, 0);
}

function makeBlankSong() {
  return { id: newLocalId(), title: '', artist: '', key: 'C', text: '', order: songs.length ? Math.max(...songs.map((song) => song.order)) + 1 : 0, updatedAt: Date.now() };
}

function openEditor(song = makeBlankSong(), groupId = null) {
  if (!groupId && !authUser) {
    updateAccountDialog();
    $('accountDialog').showModal();
    notify('เข้าสู่ระบบก่อนบันทึกเพลงส่วนตัว');
    return;
  }
  currentSong = song;
  editingGroupId = groupId;
  editingId = song.id;
  $('songTitle').value = song.title || '';
  $('songArtist').value = song.artist || '';
  $('chordText').value = song.text || '';
  keyOptions($('sourceKeySelect'), song.key || 'C');
  keyOptions($('keySelect'), song.key || 'C');
  $('fontSizeRange').value = '16';
  $('lineSpacingRange').value = '16';
  $('saveSongButton').textContent = groupId ? 'บันทึกเพลงร่วมกัน' : 'บันทึกเพลง';
  updatePreview();
  showView('editor');
}

function readEditor() {
  return { ...(currentSong || makeBlankSong()), id: editingId || newLocalId(), title: $('songTitle').value.trim(), artist: $('songArtist').value.trim(), text: $('chordText').value, key: $('sourceKeySelect').value, updatedAt: Date.now() };
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
  renderChordContent($('songPreview'), song, $('keySelect').value);
  applyCompactText($('songPreview'), Number($('fontSizeRange').value), Number($('lineSpacingRange').value), $('previewFitButton').getAttribute('aria-pressed') === 'true');
}

async function saveCurrentSong() {
  const song = readEditor();
  if (!song.title) { $('songTitle').focus(); notify('ใส่ชื่อเพลงก่อนบันทึก'); return; }
  try {
    if (editingGroupId && !currentSong?.revision) {
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
      notify('บันทึกเพลงให้สมาชิกในกลุ่มแล้ว');
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
  $('readerEditButton').hidden = context === 'group' && !canEditActiveGroup();
  setReaderKeyGuidance(context);
  $('readerTitle').textContent = song.title || 'เพลงไม่มีชื่อ';
  $('readerArtist').textContent = song.artist || 'WORSHIP SONG';
  const readerKey = context === 'group' ? (song.displayKey || song.key || 'C') : (song.key || 'C');
  keyOptions($('readerKeySelect'), readerKey);
  applyReaderPreferences();
  $('readerView').classList.toggle('show-reader-queue', queueWasOpen);
  renderReaderPosition();
  renderReaderQueue();
  renderChordContent($('readerChords'), song, readerKey);
  applyReaderPreferences();
  showView('reader');
}

function readerContextSongs() {
  return readerContext === 'today' ? todaySongs() : readerContext === 'group' ? sharedSongs : songs;
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
  $('readerQueue').innerHTML = queue.map((song, songIndex) => `<li><button type="button" data-reader-queue-song="${escapeHtml(song.id)}" class="reader-queue-song ${song.id === currentSong?.id ? 'is-current' : ''}" ${song.id === currentSong?.id ? 'aria-current="true"' : ''}><span class="today-order">${String(songIndex + 1).padStart(2, '0')}</span><span><strong>${escapeHtml(song.title || 'เพลงไม่มีชื่อ')}</strong><small>${songIndex === index ? 'กำลังดู' : songIndex === index + 1 ? 'เพลงถัดไป' : escapeHtml(song.artist || 'ไม่ระบุศิลปิน')}</small></span><span class="song-key">${escapeHtml(readerContext === 'group' ? song.displayKey || song.key || 'C' : song.key || 'C')}</span></button></li>`).join('');
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

function downloadBackup() {
  const blob = new Blob([JSON.stringify({ format: 'worshipchord-backup', version: 3, songs, setlists: [todaySetlist] }, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `worshipchord-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  notify('ดาวน์โหลดไฟล์สำรองแล้ว');
}

async function importBackup(backup) {
  try {
    if (!authUser) throw new Error('เข้าสู่ระบบก่อนนำเข้าข้อมูลเพลง');
    if (offlineMode) throw new Error('นำเข้าข้อมูลต้องเชื่อมต่ออินเทอร์เน็ต');
    if (backup.format !== 'worshipchord-backup' || !Array.isArray(backup.songs)) throw new Error('ไฟล์นี้ไม่ใช่ไฟล์สำรอง WorshipChord');
    const sourceSetlist = backup.setlists?.find((setlist) => setlist.id === TODAY_SETLIST_ID || setlist.name === 'เพลงวันนี้');
    lastPersonalMutationAt = Date.now();
    const result = await api('/api/library/import', {
      method: 'POST',
      body: JSON.stringify({ songs: backup.songs, todaySetlist: sourceSetlist || { songIds: [] } })
    });
    await cacheRemoteLibrary(result.library);
    renderSongRows();
    $('importPreviewDialog').close();
    pendingBackupImport = null;
    const skipped = Number(result.duplicatesSkipped || 0) + Number(result.setlistDuplicatesSkipped || 0);
    notify(skipped ? `นำเข้าแล้ว · เพิ่ม ${result.imported} เพลง · ข้ามรายการซ้ำ ${skipped} รายการ` : `นำเข้าแล้ว ${result.imported} เพลง`);
  } catch (error) { notify(error.message || 'นำเข้าไฟล์สำรองไม่สำเร็จ'); }
}

async function previewBackupImport(file) {
  try {
    const backup = JSON.parse(await file.text());
    if (backup.format !== 'worshipchord-backup' || !Array.isArray(backup.songs)) throw new Error('ไฟล์นี้ไม่ใช่ไฟล์สำรอง WorshipChord');
    const keyOf = (song) => JSON.stringify([song.title, song.artist || ''].map((value) => String(value).normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('th-TH')));
    const existing = new Set(songs.map(keyOf));
    const importable = [];
    let duplicateCount = 0;
    for (const song of backup.songs) {
      if (!song.title) continue;
      const key = keyOf(song);
      if (existing.has(key)) duplicateCount += 1;
      else { importable.push(song); existing.add(key); }
    }
    const setlist = backup.setlists?.find((item) => item.id === TODAY_SETLIST_ID || item.name === 'เพลงวันนี้');
    const setlistCount = Array.isArray(setlist?.songIds) ? setlist.songIds.length : 0;
    pendingBackupImport = backup;
    $('importPreviewSummary').textContent = `พบเพลง ${backup.songs.length} เพลง · เพิ่มได้ ${importable.length} เพลง · ซ้ำ ${duplicateCount} เพลง · เพลงวันนี้ ${setlistCount} เพลง`;
    $('importPreviewDialog').showModal();
  } catch (error) { notify(error.message || 'อ่านไฟล์สำรองไม่สำเร็จ'); }
}

function bindEvents() {
  $('newSongButton').addEventListener('click', () => openEditor());
  $('emptyNewSongButton').addEventListener('click', () => openEditor());
  $('accountButton').addEventListener('click', () => { updateAccountDialog(); $('accountDialog').showModal(); });
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
        $('recoveryCodeDialog').showModal();
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
    $('resetPasswordDialog').showModal();
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
      $('recoveryCodeDialog').showModal();
    } catch (error) { notify(error.message || 'สร้าง recovery code ไม่สำเร็จ'); }
  });
  $('logoutButton').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* Clear the local view even if offline. */ }
    realtimeSocket?.close();
    realtimeSocket = null;
    authUser = null;
    offlineMode = false;
    localStorage.removeItem(LAST_USER_KEY);
    db?.close();
    db = await openDatabase(DB_NAME);
    songs = [];
    todaySetlist = { id: TODAY_SETLIST_ID, name: 'เพลงวันนี้', songIds: [] };
    groups = [];
    activeGroup = null;
    sharedSongs = [];
    notifications = [];
    renderGroupPanel();
    renderSongRows();
    updateAccountDialog();
    $('accountDialog').close();
    notify('ออกจากระบบแล้ว');
  });
  $('inboxButton').addEventListener('click', async () => {
    try { await refreshNotifications(); } catch (error) { notify(error.message); }
    $('inboxDialog').showModal();
  });
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(button.dataset.closeDialog).close()));
  $('notificationList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-notification-action]');
    if (!button) return;
    try {
      const action = button.dataset.notificationAction;
      if (action === 'accept' || action === 'decline') await respondToInvitation(button.dataset.id, action);
      if (action === 'read') {
        await api(`/api/notifications/${encodeURIComponent(button.dataset.id)}`, { method: 'PATCH', body: '{}' });
        await refreshNotifications();
      }
    } catch (error) { notify(error.message); }
  });
  $('createGroupButton').addEventListener('click', createGroup);
  $('addGroupSongButton').addEventListener('click', () => {
    if (activeGroup && canEditActiveGroup()) openEditor(makeBlankSong(), activeGroup.id);
  });
  $('groupSelect').addEventListener('change', async () => {
    const previousId = activeGroup?.id;
    if (previousId) sendRealtime({ type: 'unsubscribe', groupId: previousId });
    activeGroup = groups.find((group) => group.id === $('groupSelect').value) || null;
    sharedSongs = [];
    renderGroupPanel();
    try { if (activeGroup) await loadActiveGroup(); renderSongRows(); }
    catch (error) { notify(error.message); }
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
    $('inviteDialog').showModal();
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
    $('groupMembersDialog').showModal();
    loadMemberDirectory(0);
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
      if (groupAction === 'edit') openEditor(sharedSongs.find((song) => song.id === id), activeGroup?.id);
      if (groupAction === 'remove') await removeSharedSong(id);
      return;
    }
    const opener = event.target.closest('[data-open-group]');
    if (opener) openReader(sharedSongs.find((song) => song.id === opener.dataset.openGroup), 'group');
  });
  $('backButton').addEventListener('click', () => { showView('library'); renderSongRows(); });
  $('readerBackButton').addEventListener('click', () => showView('library'));
  $('readerEditButton').addEventListener('click', () => openEditor(currentSong, readerContext === 'group' ? activeGroup?.id : null));
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
      button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
      setFitLayout($(targetId), $(fitId).getAttribute('aria-pressed') === 'true', button.getAttribute('aria-pressed') === 'true');
      if (targetId === 'readerChords') saveReaderPreferences();
    });
  }
  $('searchResults').addEventListener('click', (event) => {
    const result = event.target.closest('[data-open-search-song]');
    if (result) {
      const context = result.dataset.searchContext;
      const song = (context === 'group' ? sharedSongs : songs).find((item) => item.id === result.dataset.openSearchSong);
      if (song) openReader(song, context);
    }
    if (event.target.closest('#searchAddSongButton')) { openEditor(makeBlankSong()); $('songTitle').value = $('searchInput').value.trim(); }
  });
  $('saveSongButton').addEventListener('click', saveCurrentSong);
  $('searchInput').addEventListener('input', renderSongRows);
  ['songTitle', 'songArtist'].forEach((id) => $(id).addEventListener('input', updatePreview));
  $('chordText').addEventListener('input', () => {
    previousFormatText = null;
    $('undoFormatButton').disabled = true;
    updatePreview();
  });
  $('keySelect').addEventListener('change', updatePreview);
  $('sourceKeySelect').addEventListener('change', () => { $('keySelect').value = $('sourceKeySelect').value; updatePreview(); });
  $('fontSizeRange').addEventListener('input', updatePreview);
  $('readerKeySelect').addEventListener('change', async () => {
    const targetKey = $('readerKeySelect').value;
    if (readerContext === 'group' && canEditActiveGroup()) {
      await setGroupDisplayKey(targetKey);
    } else {
      renderChordContent($('readerChords'), currentSong, targetKey);
    }
  });
  $('readerFontSize').addEventListener('input', () => { applyCompactText($('readerChords'), Number($('readerFontSize').value), Number($('readerLineSpacing').value), $('readerFitButton').getAttribute('aria-pressed') === 'true'); saveReaderPreferences(); });
  $('lineSpacingRange').addEventListener('input', updatePreview);
  $('readerLineSpacing').addEventListener('input', () => { applyCompactText($('readerChords'), Number($('readerFontSize').value), Number($('readerLineSpacing').value), $('readerFitButton').getAttribute('aria-pressed') === 'true'); saveReaderPreferences(); });
  $('backupButton').addEventListener('click', downloadBackup);
  $('importBackupButton').addEventListener('click', () => $('backupFile').click());
  $('backupFile').addEventListener('change', (event) => { if (event.target.files[0]) previewBackupImport(event.target.files[0]); event.target.value = ''; });
  $('confirmImportButton').addEventListener('click', () => { if (pendingBackupImport) importBackup(pendingBackupImport); });
  $('songList').addEventListener('click', async (event) => {
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      const { action, id } = actionButton.dataset;
      if (action === 'today') await placeSongInToday(id);
      if (action === 'shareGroup') await shareSongToGroup(id);
      if (action === 'up') await moveSong(id, -1);
      if (action === 'down') await moveSong(id, 1);
      if (action === 'edit') openEditor(songs.find((song) => song.id === id));
      if (action === 'delete') {
        const song = songs.find((item) => item.id === id);
        if (!song || !window.confirm(`ลบ “${song.title}” ออกจากบัญชีของคุณหรือไม่?`)) return;
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
      const ids = activeGroup.songIds.filter((id) => id !== songId);
      let index = target ? ids.indexOf(target.dataset.id) : ids.length;
      const rect = target?.getBoundingClientRect();
      if (index < 0) index = ids.length;
      if (rect && event.clientY > rect.top + rect.height / 2) index += 1;
      ids.splice(Math.min(index, ids.length), 0, songId);
      try {
        await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/setlist`, { method: 'PATCH', body: JSON.stringify({ songIds: ids }) });
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
    const target = event.target.closest('.today-song-row');
    const rect = target?.getBoundingClientRect();
    await placeSongInToday(songId, target?.dataset.id || null, Boolean(rect && event.clientY > rect.top + rect.height / 2));
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
