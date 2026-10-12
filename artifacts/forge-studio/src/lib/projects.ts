export type LocalProject = { id: string; name: string; updatedAt: number; model: Blob | null; sources: { name: string; type: string; data: ArrayBuffer }[] };
const DB_NAME = 'forge-studio-local';
const STORE = 'projects';

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveProject(project: LocalProject) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(project); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
}
export async function listProjects() {
  const db = await openDb();
  const result = await new Promise<LocalProject[]>((resolve, reject) => { const request = db.transaction(STORE).objectStore(STORE).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  db.close(); return result.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function getProject(id: string) {
  const db = await openDb();
  const result = await new Promise<LocalProject | undefined>((resolve, reject) => { const request = db.transaction(STORE).objectStore(STORE).get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  db.close(); return result;
}
