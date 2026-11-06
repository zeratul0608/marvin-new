import type { ChemicalDocument } from '../core/types';

/** Independent save identity; editor revisions are deliberately never compared between tabs. */
export interface DraftRecord {
  version: 2;
  namespace: string;
  saveId: string;
  documentId: string;
  writerId: string;
  parentSaveId: string | null;
  baseHeadId: string | null;
  savedAt: number;
  document: ChemicalDocument;
}
export interface DraftRestore { record: DraftRecord; legacy: boolean }
export interface DraftSaveResult {
  status: 'saved' | 'conflict' | 'recovery-only' | 'error';
  record: DraftRecord;
  recoverySaved: boolean;
  error?: string;
}
/** A backend must compare and write a shared document head in one atomic transaction. */
export interface DraftBackend {
  save(record: DraftRecord, expectedHeadId: string | null): Promise<boolean>;
  list(namespace: string): Promise<DraftRecord[]>;
  destroy?(): void;
}
export interface DraftOptions {
  storageKey: string;
  onStatus?: (result: DraftSaveResult) => void;
  storage?: Storage;
  sessionStorage?: Storage;
  indexedDB?: IDBFactory;
  backend?: DraftBackend;
}
const uuid = () => crypto.randomUUID();
const problem = (error: unknown) => error instanceof Error ? error.message : String(error);
const scopeKey = (namespace: string, documentId: string) => JSON.stringify([namespace, documentId]);
const isMap = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function isRecord(value: unknown, namespace: string): value is DraftRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DraftRecord>;
  return record.version === 2 && record.namespace === namespace && typeof record.saveId === 'string'
    && typeof record.writerId === 'string' && typeof record.savedAt === 'number' && Number.isFinite(record.savedAt)
    && (record.parentSaveId === null || typeof record.parentSaveId === 'string')
    && (record.baseHeadId === null || typeof record.baseHeadId === 'string')
    && typeof record.documentId === 'string' && record.document?.id === record.documentId
    && record.document.schemaVersion === 1 && typeof record.document.title === 'string'
    && isMap(record.document.graph?.atoms) && isMap(record.document.graph.bonds)
    && isMap(record.document.depiction?.positions) && isMap(record.document.depiction.bonds)
    && Object.values(record.document.graph.atoms).every(atom => atom !== null && typeof atom === 'object'
      && typeof atom.element === 'string' && typeof atom.charge === 'number' && Number.isFinite(atom.charge)
      && (atom.isotope === undefined || typeof atom.isotope === 'number' && Number.isFinite(atom.isotope)));
}
function browserStorage(kind: 'localStorage' | 'sessionStorage'): Storage | undefined {
  try { return globalThis[kind]; } catch { return undefined; }
}

/** IndexedDB serializes readwrite transactions across tabs, including the read/compare phase. */
export class IndexedDbDraftBackend implements DraftBackend {
  private database?: Promise<IDBDatabase>;
  private closed = false;
  constructor(private readonly factory: IDBFactory, private readonly historyLimit = 20) {}
  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('Draft store is closed'));
    return this.database ??= new Promise((resolve, reject) => {
      const request = this.factory.open('molecule-workbench-drafts-v2', 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('heads', {keyPath: 'key'});
        const saves = database.createObjectStore('saves', {keyPath: 'saveId'});
        saves.createIndex('namespace', 'namespace');
        saves.createIndex('documentKey', 'documentKey');
      };
      request.onerror = () => { this.database = undefined; reject(request.error ?? new Error('Cannot open draft database')); };
      let blocked = false;
      request.onblocked = () => { blocked = true; this.database = undefined; reject(new Error('Draft database is blocked by another page')); };
      request.onsuccess = () => {
        if (this.closed || blocked) { request.result.close(); reject(new Error('Draft store is closed')); return; }
        request.result.onversionchange = () => { request.result.close(); this.database = undefined; };
        resolve(request.result);
      };
    });
  }
  async save(record: DraftRecord, expectedHeadId: string | null): Promise<boolean> {
    const database = await this.open(), documentKey = scopeKey(record.namespace, record.documentId);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['heads', 'saves'], 'readwrite');
      const heads = transaction.objectStore('heads'), saves = transaction.objectStore('saves');
      let accepted = false;
      const headRequest = heads.get(documentKey);
      headRequest.onsuccess = () => {
        const current = headRequest.result as {saveId: string} | undefined;
        accepted = (current?.saveId ?? null) === expectedHeadId;
        saves.put({...record, baseHeadId: accepted ? record.saveId : record.baseHeadId, documentKey});
        if (accepted) heads.put({key: documentKey, saveId: record.saveId});
        // Limit revision history while retaining every branch's latest version and the shared head.
        const request = saves.index('documentKey').getAll(documentKey);
        request.onsuccess = () => {
          const records = (request.result as DraftRecord[]).sort((a, b) => b.savedAt - a.savedAt);
          const keep = new Set(records.slice(0, this.historyLimit).map(item => item.saveId));
          keep.add(accepted ? record.saveId : current?.saveId ?? '');
          const writers = new Set<string>();
          for (const item of records) if (!writers.has(item.writerId)) { writers.add(item.writerId); keep.add(item.saveId); }
          for (const item of records) if (!keep.has(item.saveId)) saves.delete(item.saveId);
        };
      };
      transaction.oncomplete = () => resolve(accepted);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Draft transaction failed'));
    });
  }
  async list(namespace: string): Promise<DraftRecord[]> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('saves', 'readonly');
      const request = transaction.objectStore('saves').index('namespace').getAll(namespace);
      request.onsuccess = () => resolve(request.result as DraftRecord[]);
      request.onerror = () => reject(request.error ?? new Error('Cannot read draft history'));
    });
  }
  destroy(): void { this.closed = true; void this.database?.then(database => database.close(), () => undefined); }
}

/** Local recovery is synchronous; canonical publication is atomic and never replaces a conflicting head. */
export class BrowserDraftStore {
  readonly writerId = uuid();
  /** Nonfatal restore errors are observable; damaged source entries are never removed. */
  restoreWarning?: string;
  private readonly storage?: Storage;
  private readonly session?: Storage;
  private readonly backend?: DraftBackend;
  private readonly prefix: string;
  private readonly sessionKey: string;
  private readonly latestKey: string;
  private readonly branchPrefix: string;
  private bases = new Map<string, string | null>();
  private parents = new Map<string, string | null>();
  private latest?: DraftRecord;
  private lastSavedAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private destroyed = false;
  constructor(private readonly options: DraftOptions) {
    this.storage = options.storage ?? browserStorage('localStorage');
    this.session = options.sessionStorage ?? browserStorage('sessionStorage');
    this.prefix = `${options.storageKey}:draft-v2:`;
    this.sessionKey = `${this.prefix}session`;
    this.latestKey = `${this.prefix}latest`;
    this.branchPrefix = `${this.prefix}branch:${this.writerId}:`;
    let factory: IDBFactory | undefined = options.indexedDB;
    if (!options.backend && !factory) try { factory = globalThis.indexedDB; } catch { /* Browser policy may deny the getter itself. */ }
    this.backend = options.backend ?? (factory ? new IndexedDbDraftBackend(factory) : undefined);
  }
  private read(key: string | null): DraftRecord | undefined {
    if (!key) return undefined;
    try {
      const value = this.storage?.getItem(key);
      const record: unknown = value ? JSON.parse(value) : undefined;
      if (isRecord(record, this.options.storageKey)) return record;
      if (value) this.restoreWarning = '部分本地草稿无法读取，原始记录已保留';
      return undefined;
    } catch { this.restoreWarning = '部分本地草稿无法读取，原始记录已保留'; return undefined; }
  }
  restore(): DraftRestore | undefined {
    let pointer: string | null = null;
    try { pointer = this.session?.getItem(this.sessionKey) ?? null; } catch { /* Continue with the shared cache. */ }
    let record = this.read(pointer);
    if (!record) record = this.read(this.latestKey);
    if (record) {
      this.bases.set(record.documentId, record.baseHeadId);
      this.parents.set(record.documentId, record.saveId);
      return {record: structuredClone(record), legacy: false};
    }
    // The original entry is intentionally not modified or removed during migration.
    try {
      const raw = this.storage?.getItem(this.options.storageKey);
      if (!raw) return undefined;
      const document = JSON.parse(raw) as ChemicalDocument;
      if (document?.schemaVersion !== 1 || typeof document.id !== 'string' || !document.graph || !document.depiction) {
        this.restoreWarning = '旧版草稿格式无效，原始记录已保留'; return undefined;
      }
      record = {version: 2, namespace: this.options.storageKey, saveId: uuid(), documentId: document.id,
        writerId: this.writerId, parentSaveId: null, baseHeadId: null, savedAt: Date.now(), document};
      this.bases.set(document.id, null);
      this.parents.set(document.id, null);
      return {record, legacy: true};
    } catch { this.restoreWarning = '旧版草稿无法读取，原始记录已保留'; return undefined; }
  }
  private recovery(record: DraftRecord): boolean {
    try {
      if (!this.storage || !this.session) return false;
      const branchKey = this.branchPrefix + encodeURIComponent(record.documentId);
      this.storage.setItem(branchKey, JSON.stringify(record));
      this.session.setItem(this.sessionKey, branchKey);
      return true;
    } catch { return false; }
  }
  save(document: ChemicalDocument): Promise<DraftSaveResult> {
    if (this.destroyed) return Promise.reject(new Error('Draft store is closed'));
    const record: DraftRecord = {version: 2, namespace: this.options.storageKey, saveId: uuid(),
      documentId: document.id, writerId: this.writerId, parentSaveId: this.parents.get(document.id) ?? null,
      baseHeadId: this.bases.get(document.id) ?? null, savedAt: this.lastSavedAt = Math.max(Date.now(), this.lastSavedAt + 1), document: structuredClone(document)};
    this.parents.set(document.id, record.saveId);
    this.latest = record;
    // This runs before any await, so an immediate reload can recover this page's own edit.
    const recoverySaved = this.recovery(record);
    const perform = async (): Promise<DraftSaveResult> => {
      record.baseHeadId = this.bases.get(record.documentId) ?? null;
      let result: DraftSaveResult;
      try {
        if (!this.backend) throw new Error('Shared draft storage is unavailable');
        const accepted = await this.backend.save(record, record.baseHeadId);
        if (accepted) {
          record.baseHeadId = record.saveId;
          this.bases.set(record.documentId, record.saveId);
          try { this.storage?.setItem(this.latestKey, JSON.stringify(record)); } catch { /* Database save succeeded; session recovery status remains explicit. */ }
        }
        if (this.latest?.saveId === record.saveId) this.recovery(record);
        result = {status: accepted ? 'saved' : 'conflict', record, recoverySaved};
      } catch (error) {
        result = {status: recoverySaved ? 'recovery-only' : 'error', record, recoverySaved, error: problem(error)};
      }
      if (!this.destroyed && this.latest?.saveId === record.saveId) this.options.onStatus?.(structuredClone(result));
      return result;
    };
    const pending = this.queue.then(perform, perform);
    this.queue = pending;
    return pending;
  }
  /** Recovery chooses a version explicitly; it does not silently make a stale branch the shared head. */
  restoreRecord(record: DraftRecord): void {
    if (!isRecord(record, this.options.storageKey)) throw new Error('Invalid draft record');
    this.bases.set(record.documentId, record.baseHeadId);
    this.parents.set(record.documentId, record.saveId);
    this.latest = structuredClone(record);
    this.recovery(this.latest);
  }
  async list(): Promise<DraftRecord[]> {
    const records = new Map<string, DraftRecord>();
    let databaseReadable = false, storageReadable = false;
    try {
      if (this.backend) {
        for (const record of await this.backend.list(this.options.storageKey)) if (isRecord(record, this.options.storageKey)) records.set(record.saveId, record);
        databaseReadable = true;
      }
    } catch { /* Per-page recovery remains available when IndexedDB is unavailable. */ }
    try {
      if (this.storage) {
        for (let i = 0; i < this.storage.length; i++) {
          const key = this.storage.key(i);
          if (key?.startsWith(`${this.prefix}branch:`)) { const record = this.read(key); if (record && !records.has(record.saveId)) records.set(record.saveId, record); }
        }
        storageReadable = true;
      }
    } catch { /* Return database versions if browser-local storage is inaccessible. */ }
    if (!databaseReadable && !storageReadable) throw new Error('草稿版本无法读取，请导出当前结构保留修改');
    return structuredClone([...records.values()].sort((a, b) => b.savedAt - a.savedAt));
  }
  destroy(): void { this.destroyed = true; void this.queue.then(() => this.backend?.destroy?.(), () => this.backend?.destroy?.()); }
}
