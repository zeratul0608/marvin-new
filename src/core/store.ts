import { clone, fingerprint, validateDocument } from './model';
import type { ChemicalDocument } from './types';

/** Every edit is an atomic transaction. History snapshots retain stable object IDs. */
export class DocumentStore {
  private current: ChemicalDocument;
  private past: ChemicalDocument[] = [];
  private future: ChemicalDocument[] = [];
  private listeners = new Set<() => void>();
  revision = 0;
  constructor(doc: ChemicalDocument) { validateDocument(doc); this.current = clone(doc); }
  get document(): ChemicalDocument { return clone(this.current); }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { this.revision++; for (const listener of this.listeners) listener(); }
  replace(doc: ChemicalDocument): void {
    validateDocument(doc);
    if (fingerprint(doc) === fingerprint(this.current) && JSON.stringify(doc.source) === JSON.stringify(this.current.source)) return;
    this.past.push(clone(this.current));
    if (this.past.length > 100) this.past.shift();
    this.current = clone(doc); this.future = []; this.emit();
  }
  transact(edit: (draft: ChemicalDocument) => void): void {
    const draft = this.document; edit(draft); this.replace(draft);
  }
  undo(): void { const prev = this.past.pop(); if (prev) { this.future.push(this.current); this.current = prev; this.emit(); } }
  redo(): void { const next = this.future.pop(); if (next) { this.past.push(this.current); this.current = next; this.emit(); } }
}
