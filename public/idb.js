'use strict';
// Tiny IndexedDB wrapper for storing the reference image and any
// other large blobs that don't belong in localStorage.
//
// We previously kept state.reference (a data: URL of the resized
// reference image) inside the project blob in localStorage. A 1600
// px JPEG at quality 0.9 is 0.8-2.5 MB; the project blob also
// includes the script and metadata; together they can approach or
// exceed the ~5 MB per-origin localStorage quota. When that
// happened, projectSnapshot() silently failed and the user lost
// their work the next time they refreshed.
//
// IndexedDB has no such quota (the browser will prompt the user
// at GB-scale, not MB), so the reference image now lives here.
// The project blob in localStorage still carries the script and
// scene descriptions, but the reference is fetched on demand.

const DB_NAME = 'curtis-studio';
const DB_VERSION = 1;
const STORE_REFERENCE = 'reference';
const KEY_REFERENCE = 'current';

function isAvailable() {
  return typeof globalThis.indexedDB !== 'undefined';
}

function openDb() {
  if (!isAvailable()) return Promise.reject(new Error('IndexedDB unavailable'));
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_REFERENCE)) {
        db.createObjectStore(STORE_REFERENCE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    // If another tab has the DB open, the request blocks until the
    // user closes the other tab. We surface this as a recoverable
    // error instead of hanging forever.
    request.onblocked = () => reject(new Error('IndexedDB is open in another tab. Close it and reload.'));
  });
}

async function putReference(dataUrl) {
  if (!isAvailable()) throw new Error('IndexedDB unavailable');
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_REFERENCE, 'readwrite');
      tx.objectStore(STORE_REFERENCE).put(dataUrl, KEY_REFERENCE);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB put failed'));
    });
  } finally {
    db.close();
  }
}

async function getReference() {
  if (!isAvailable()) return null;
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_REFERENCE, 'readonly');
      const request = tx.objectStore(STORE_REFERENCE).get(KEY_REFERENCE);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('IndexedDB get failed'));
    });
  } catch (error) {
    // log so app.js / the smoke tests can still see the difference
    // between "no reference yet" (null return from onsuccess) and
    // "IndexedDB actually broke" (error path here).
    console.warn('[CurtisIndexedDb] getReference failed:', error && error.message);
    return null;
  } finally {
    db.close();
  }
}

async function deleteReference() {
  if (!isAvailable()) return;
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_REFERENCE, 'readwrite');
      tx.objectStore(STORE_REFERENCE).delete(KEY_REFERENCE);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
    });
  } finally {
    db.close();
  }
}

globalThis.CurtisIndexedDb = { isAvailable, putReference, getReference, deleteReference };
