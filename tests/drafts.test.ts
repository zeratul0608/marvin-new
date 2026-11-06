import { describe, expect, it } from 'vitest';
import { BrowserDraftStore, type DraftBackend, type DraftRecord } from '../src/editor/drafts';
import { exampleDocument } from '../src/core/templates';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  copy(): MemoryStorage { const copy = new MemoryStorage(); for (const [key, value] of this.values) copy.setItem(key, value); return copy; }
}
/** In-memory atomic backend contract; actual cross-page IndexedDB transactions are browser-tested. */
class AtomicMemoryBackend implements DraftBackend {
  heads = new Map<string, string>();
  records = new Map<string, DraftRecord>();
  async save(record: DraftRecord, expectedHeadId: string | null) {
    await Promise.resolve();
    const key = JSON.stringify([record.namespace, record.documentId]);
    const accepted = (this.heads.get(key) ?? null) === expectedHeadId;
    this.records.set(record.saveId, structuredClone({...record, baseHeadId: accepted ? record.saveId : record.baseHeadId}));
    if (accepted) this.heads.set(key, record.saveId);
    return accepted;
  }
  async list(namespace: string) { return structuredClone([...this.records.values()].filter(record => record.namespace === namespace)); }
}
const create = (storage = new MemoryStorage(), sessionStorage = new MemoryStorage(), backend: DraftBackend = new AtomicMemoryBackend()) => {
  const store = new BrowserDraftStore({storageKey: 'test-draft', storage, sessionStorage, backend});
  return {store, storage, sessionStorage, backend};
};

describe('independent recoverable browser drafts', () => {
  it('migrates a legacy raw JSON draft without modifying or removing the original', async () => {
    const {store, storage} = create(), document = exampleDocument('ethanol');
    document.title = 'Legacy 18O solvent';
    Object.values(document.graph.atoms).find(atom => atom.element === 'O')!.isotope = 18;
    const raw = JSON.stringify(document); storage.setItem('test-draft', raw);
    const restored = store.restore();
    expect(restored?.legacy).toBe(true); expect(restored?.record.document).toEqual(document);
    expect((await store.save(document)).status).toBe('saved');
    expect(storage.getItem('test-draft')).toBe(raw);
    store.destroy();
  });

  it('preserves both simultaneous stale writers and restores each page own chemistry after reload', async () => {
    const shared = new MemoryStorage(), backend = new AtomicMemoryBackend();
    const sessionA = new MemoryStorage(), sessionB = new MemoryStorage();
    const a = create(shared, sessionA, backend).store;
    const initial = exampleDocument('ethanol'); await a.save(initial);
    const b = create(shared, sessionB, backend).store;
    const bDocument = b.restore()!.record.document;
    const aDocument = structuredClone(initial), oxygen = Object.values(initial.graph.atoms).find(atom => atom.element === 'O')!.id;
    aDocument.title = 'A renamed'; bDocument.graph.atoms[oxygen].charge = -1;
    const [resultA, resultB] = await Promise.all([a.save(aDocument), b.save(bDocument)]);
    expect([resultA.status, resultB.status].sort()).toEqual(['conflict', 'saved']);
    expect(resultA.recoverySaved && resultB.recoverySaved).toBe(true);
    const aReload = create(shared, sessionA, backend).store, bReload = create(shared, sessionB, backend).store;
    expect(aReload.restore()!.record.document).toEqual(aDocument);
    expect(bReload.restore()!.record.document).toEqual(bDocument);
    const versions = await aReload.list();
    expect(versions.some(version => version.document.title === 'A renamed')).toBe(true);
    expect(versions.some(version => version.document.graph.atoms[oxygen]?.charge === -1)).toBe(true);
    const newPage = create(shared, new MemoryStorage(), backend).store;
    expect(newPage.restore()!.record.document).toEqual(resultA.status === 'saved' ? aDocument : bDocument);
    for (const store of [a, b, aReload, bReload, newPage]) store.destroy();
  });

  it('assigns a fresh writer even when a new tab inherits a cloned sessionStorage pointer', async () => {
    const {store: parent, storage, sessionStorage, backend} = create();
    const document = exampleDocument('ethanol'); await parent.save(document);
    const childSession = sessionStorage.copy(), child = create(storage, childSession, backend).store;
    expect(child.writerId).not.toBe(parent.writerId);
    expect(child.restore()!.record.document).toEqual(document);
    const changed = structuredClone(document); changed.title = 'Child branch'; await child.save(changed);
    const parentReload = create(storage, sessionStorage, backend).store;
    expect(parentReload.restore()!.record.document.title).toBe(document.title);
    expect(create(storage, childSession, backend).store.restore()!.record.document.title).toBe('Child branch');
    parent.destroy(); child.destroy(); parentReload.destroy();
  });

  it('snapshots and recovers an edit synchronously before a pending database commit', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const backend = new AtomicMemoryBackend();
    const delayed: DraftBackend = {save: async (record, expected) => { await waiting; return backend.save(record, expected); }, list: key => backend.list(key)};
    const {store, storage, sessionStorage} = create(new MemoryStorage(), new MemoryStorage(), delayed);
    const document = exampleDocument('ethanol'); document.title = 'Must survive immediate reload';
    const save = store.save(document); document.title = 'Subsequent in-memory mutation';
    const reload = create(storage, sessionStorage, delayed).store;
    expect(reload.restore()!.record.document.title).toBe('Must survive immediate reload');
    store.destroy(); release(); expect((await save).status).toBe('saved'); reload.destroy();
  });

  it('serializes rapid own saves without treating its previous pending save as an external conflict', async () => {
    const {store, backend} = create(), document = exampleDocument('ethanol');
    const first = store.save(document); document.title = 'Second'; const second = store.save(document);
    document.title = 'Third'; const third = store.save(document);
    const results = await Promise.all([first, second, third]);
    expect(results.map(result => result.status)).toEqual(['saved', 'saved', 'saved']);
    expect(results[1].record.parentSaveId).toBe(results[0].record.saveId);
    expect(results[2].record.parentSaveId).toBe(results[1].record.saveId);
    expect((await backend.list('test-draft')).map(record => record.document.title)).toEqual(['乙醇', 'Second', 'Third']);
    expect((await store.list()).filter(record => record.documentId === document.id)).toHaveLength(3);
    store.destroy();
  });

  it('separates document identities and namespaces without comparing local editor revisions', async () => {
    const {store, storage, backend} = create();
    const first = exampleDocument('ethanol'), second = exampleDocument('benzene');
    expect((await store.save(first)).status).toBe('saved'); expect((await store.save(second)).status).toBe('saved');
    const other = new BrowserDraftStore({storageKey: 'another-workspace', storage, sessionStorage: new MemoryStorage(), backend});
    expect(other.restore()).toBeUndefined(); expect((await other.save(first)).status).toBe('saved');
    expect(await store.list()).toHaveLength(2); expect(await other.list()).toHaveLength(1);
    store.destroy(); other.destroy();
  });

  it('keeps recoverable per-document branches and the old shared value when the database fails', async () => {
    const broken: DraftBackend = {save: async () => { throw new Error('Database unavailable'); }, list: async () => { throw new Error('Database unavailable'); }};
    const {store, storage, sessionStorage} = create(new MemoryStorage(), new MemoryStorage(), broken);
    const first = exampleDocument('ethanol'), second = exampleDocument('benzene');
    storage.setItem('test-draft', JSON.stringify(first)); store.restore();
    const results = [await store.save(first), await store.save(second)];
    expect(results.map(result => result.status)).toEqual(['recovery-only', 'recovery-only']);
    expect(await store.list()).toHaveLength(2);
    expect(JSON.parse(storage.getItem('test-draft')!)).toEqual(first);
    expect(create(storage, sessionStorage, broken).store.restore()!.record.document).toEqual(second);
    store.destroy();
  });

  it('does not claim a local recovery copy exists when quota or session access fails', async () => {
    const quota = new MemoryStorage(); quota.setItem = () => { throw new DOMException('Quota', 'QuotaExceededError'); };
    const {store} = create(quota);
    const result = await store.save(exampleDocument('ethanol'));
    expect(result.status).toBe('saved'); expect(result.recoverySaved).toBe(false);
    expect(await store.list()).toHaveLength(1); store.destroy();
    const broken: DraftBackend = {save: async () => { throw new Error('Denied'); }, list: async () => []};
    const failed = create(quota, new MemoryStorage(), broken).store;
    expect((await failed.save(exampleDocument('ethanol'))).status).toBe('error'); failed.destroy();
  });

  it('restores an explicitly chosen branch without overwriting the current shared version', async () => {
    const {store, storage, backend} = create();
    const document = exampleDocument('ethanol'), original = await store.save(document);
    const other = create(storage, new MemoryStorage(), backend).store;
    other.restore(); document.title = 'Current shared version'; await other.save(document);
    store.restoreRecord(original.record);
    const result = await store.save(original.record.document);
    expect(result.status).toBe('conflict');
    expect(create(storage, new MemoryStorage(), backend).store.restore()!.record.document.title).toBe('Current shared version');
    store.destroy(); other.destroy();
  });

  it('reports corrupt recovery metadata and keeps the untouched valid legacy draft available', () => {
    const {store, storage} = create(), document = exampleDocument('ethanol');
    storage.setItem('test-draft:draft-v2:latest', JSON.stringify({version: 2, documentId: document.id, document, baseHeadId: 5}));
    const raw = JSON.stringify(document); storage.setItem('test-draft', raw);
    expect(store.restore()?.record.document).toEqual(document);
    expect(store.restoreWarning).toContain('无法读取');
    expect(storage.getItem('test-draft')).toBe(raw); store.destroy();
  });

  it('reports unreadable history rather than presenting both failed stores as an empty version list', async () => {
    const denied = new MemoryStorage();
    Object.defineProperty(denied, 'length', {get() { throw new Error('Storage denied'); }});
    const broken: DraftBackend = {save: async () => { throw new Error('Database denied'); }, list: async () => { throw new Error('Database denied'); }};
    const {store} = create(denied, new MemoryStorage(), broken);
    await expect(store.list()).rejects.toThrow('草稿版本无法读取'); store.destroy();
  });

  it('isolates malformed document maps and null atoms without hiding healthy recovery versions', async () => {
    const {store, storage, backend} = create();
    const healthy = await store.save(exampleDocument('ethanol'));
    const missingMap = structuredClone(healthy.record), nullAtom = structuredClone(healthy.record);
    missingMap.saveId = 'broken-map'; nullAtom.saveId = 'broken-atom';
    delete (missingMap.document.graph as Partial<typeof missingMap.document.graph>).atoms;
    Object.assign(nullAtom.document.graph.atoms, {broken: null});
    const backendRecords = (backend as AtomicMemoryBackend).records;
    backendRecords.set(missingMap.saveId, missingMap);
    const corruptRaw = JSON.stringify(nullAtom);
    storage.setItem('test-draft:draft-v2:branch:corrupt:example', corruptRaw);
    expect((await store.list()).map(record => record.saveId)).toEqual([healthy.record.saveId]);
    expect(storage.getItem('test-draft:draft-v2:branch:corrupt:example')).toBe(corruptRaw);
    expect(backendRecords.has('broken-map')).toBe(true); store.destroy();
  });
});
