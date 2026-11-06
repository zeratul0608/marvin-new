import type { AtomSubstructure, ChemicalDocument } from '../core/types';
import { scopeElements } from './xml-scope';
import { fail } from './shared';

/** Remap the generated child document's IDs into its parent's object namespace. */
export function embeddedFragments(group: AtomSubstructure, nextId: () => string, write: (doc: ChemicalDocument) => string): string {
  return group.fragments.map(fragment => {
    const input = new DOMParser().parseFromString(write(fragment.document), 'application/xml');
    const root = scopeElements(input, 'fragment')[0]; if (!root) fail('内部片段输出缺少根片段');
    const nodes = scopeElements(input, 'n'), ids = Object.keys(fragment.document.graph.atoms);
    const byModel = new Map(ids.map((id, i) => [id, nodes[i].getAttribute('id')!]));
    const objects = [root, ...root.getElementsByTagName('*')], references = new Set(['B', 'E', 'BondOrdering', 'BondCircularOrdering', 'CrossingBonds', 'ConnectionOrder']);
    const remap = new Map(objects.filter(el => el.hasAttribute('id')).map(el => [el.getAttribute('id')!, nextId()]));
    for (const el of objects) for (const attribute of [...el.attributes]) {
      if (attribute.name === 'id') el.setAttribute('id', remap.get(attribute.value)!);
      else if (references.has(attribute.name)) el.setAttribute(attribute.name, attribute.value.split(/\s+/).map(ref => ref === '0' ? '0' : remap.get(ref) ?? fail('内部片段含无效对象引用')).join(' '));
    }
    if (fragment.attachmentOrder.length) root.setAttribute('ConnectionOrder', fragment.attachmentOrder.map(id => remap.get(byModel.get(id)!) ?? fail('内部连接点未输出')).join(' '));
    return new XMLSerializer().serializeToString(root);
  }).join('');
}
