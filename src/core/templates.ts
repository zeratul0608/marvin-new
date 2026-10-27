import { addAtom, addBond, emptyDocument } from './model';
import type { ChemicalDocument, Point } from './types';
export function insertRing(doc: ChemicalDocument, center: Point, aromatic = false): string[] {
  const atoms = Array.from({ length: 6 }, (_, i) => {
    const angle = i * Math.PI / 3 + Math.PI / 6;
    return addAtom(doc, 'C', { x: center.x + 1.5 * Math.cos(angle), y: center.y + 1.5 * Math.sin(angle) });
  });
  for (let i = 0; i < 6; i++) addBond(doc, atoms[i], atoms[(i + 1) % 6], aromatic && i % 2 === 0 ? 2 : 1);
  return atoms;
}
export function exampleDocument(name: 'aspirin' | 'caffeine' | 'ethanol' | 'benzene' = 'aspirin'): ChemicalDocument {
  const doc = emptyDocument({ aspirin: '阿司匹林', caffeine: '咖啡因', ethanol: '乙醇', benzene: '苯' }[name]);
  if (name === 'ethanol') {
    const a = addAtom(doc, 'C', { x: -1.3, y: 0 }), b = addAtom(doc, 'C', { x: 0, y: .75 }), c = addAtom(doc, 'O', { x: 1.3, y: 0 });
    addBond(doc, a, b); addBond(doc, b, c); return doc;
  }
  if (name === 'caffeine') {
    // Explicit Kekulé representation of caffeine, with a fused six/five membered ring.
    const symbols = ['N', 'C', 'N', 'C', 'C', 'C', 'N', 'C', 'N'];
    const positions = [[-1.3, .75], [-1.3, -.75], [0, -1.5], [1.3, -.75], [1.3, .75], [0, 1.5], [2.73, 1.21], [3.62, 0], [2.73, -1.21]];
    const atoms = symbols.map((s, i) => addAtom(doc, s, { x: positions[i][0], y: positions[i][1] }));
    [[0,1,1],[1,2,1],[2,3,1],[3,4,2],[4,5,1],[5,0,1],[4,6,1],[6,7,1],[7,8,2],[8,3,1]].forEach(([a,b,o]) => addBond(doc, atoms[a], atoms[b], o as 1 | 2));
    for (const [index, x, y] of [[1,-2.6,-1.5],[5,0,3]] as const) addBond(doc, atoms[index], addAtom(doc, 'O', { x, y }), 2);
    for (const [index, x, y] of [[0,-2.6,1.5],[2,0,-3],[6,3.2,2.64]] as const) addBond(doc, atoms[index], addAtom(doc, 'C', { x, y }));
    return doc;
  }
  const ring = insertRing(doc, { x: 0, y: 0 }, true);
  if (name === 'benzene') return doc;
  const carboxyl = addAtom(doc, 'C', { x: 2.6, y: 1.5 }); addBond(doc, ring[0], carboxyl);
  addBond(doc, carboxyl, addAtom(doc, 'O', { x: 2.6, y: 3 }), 2);
  addBond(doc, carboxyl, addAtom(doc, 'O', { x: 3.9, y: .75 }));
  const oxygen = addAtom(doc, 'O', { x: 2.6, y: -1.5 }); addBond(doc, ring[5], oxygen);
  const acetyl = addAtom(doc, 'C', { x: 3.9, y: -.75 }); addBond(doc, oxygen, acetyl);
  addBond(doc, acetyl, addAtom(doc, 'O', { x: 3.9, y: .75 }), 2);
  // Avoid overlapping the separate carboxyl oxygen in the published example layout.
  doc.depiction.positions[Object.keys(doc.graph.atoms)[8]] = { x: 3.9, y: 2.25 };
  addBond(doc, acetyl, addAtom(doc, 'C', { x: 5.2, y: -1.5 }));
  return doc;
}
