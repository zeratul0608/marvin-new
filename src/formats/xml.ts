import { atomicNumber, ELEMENTS } from '../core/model';
import type { Atom, BondOrder, ChemicalDocument, Diagnostic, ImportResult } from '../core/types';
import { escapeXml as esc, fail, finish, GraphReader, integer, numeric } from './shared';

const all = (node: Document | Element, tag: string): Element[] => [...node.getElementsByTagName('*')].filter(e => e.localName === tag);
const children = (node: Element, tag: string): Element[] => [...node.children].filter(e => e.localName === tag);
const attr = (el: Element, name: string) => el.getAttribute(name) ?? '';
function xml(raw: string, expected: string[]): Document {
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(raw)) fail('XML 内部实体声明暂不支持', 'UNSUPPORTED_XML_ENTITY');
  // External DTDs are not fetched. Both formats have valid documents with an external DOCTYPE.
  const text = raw.replace(/<!DOCTYPE[^>]*>/gi, '');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (all(doc, 'parsererror').length || doc.documentElement.localName === 'parsererror') fail('XML 语法无效');
  if (!expected.includes(doc.documentElement.localName)) fail(`XML 根节点应为 ${expected.join(' / ')}`);
  return doc;
}
function warning(issues: Diagnostic[], message: string, code = 'UNSUPPORTED_SOURCE_CONTENT') {
  if (!issues.some(i => i.message === message)) issues.push({ severity: 'warning', code, message });
}
function checkAttributes(el: Element, allowed: string[], issues: Diagnostic[]) {
  const visual = ['color', 'fontScale', 'chargeAngle', 'Z', 'BoundingBox', 'DoublePosition', 'LabelDisplay', 'ShowAtomNumber', 'ShowAtomQuery', 'ShowAtomStereo', 'ShowAtomEnhancedStereo', 'ShowAtomMap', 'title'];
  for (const a of [...el.attributes]) {
    if (!allowed.includes(a.name) && !a.name.startsWith('xmlns')) {
      if (!visual.includes(a.name)) fail(`源文件属性 ${el.localName}.${a.name} 尚未实现，为避免改变化学语义已停止导入`, 'UNSUPPORTED_PROPERTY');
      warning(issues, `源文件属性 ${el.localName}.${a.name} 暂未解释；编辑后导出可能无法保留`);
    }
  }
}
export function readCdxml(raw: string, name?: string): ImportResult {
  const input = xml(raw, ['CDXML']), issues: Diagnostic[] = [];
  const reader = new GraphReader(name?.replace(/\.cdxml$/i, '') || 'ChemDraw 结构');
  const fragments = all(input, 'fragment');
  if (all(input, 'scheme').length || all(input, 'step').length) fail('CDXML 反应角色与步骤尚未实现，当前不进行降级导入', 'UNSUPPORTED_REACTION');
  if (all(input, 'bracketedgroup').length || all(input, 'alternativegroup').length) fail('CDXML 聚合物／Markush 基团尚未实现', 'UNSUPPORTED_GROUP');
  for (const fragment of fragments) if (all(fragment, 'fragment').length) fail('缩写或嵌套片段尚未实现', 'UNSUPPORTED_GROUP');
  const ids = new Set<string>();
  for (const node of all(input, 'n')) {
    if (node.parentElement?.localName !== 'fragment') fail('CDXML 原子必须属于可识别的分子片段');
    if (attr(node, 'NodeType') && attr(node, 'NodeType') !== 'Element') fail(`尚未支持的 ChemDraw 原子类型：${attr(node, 'NodeType')}`, 'UNSUPPORTED_QUERY');
    const ref = attr(node, 'id'); if (ids.has(ref)) fail('重复的 ChemDraw 对象 ID'); ids.add(ref);
    const z = integer(attr(node, 'Element'), 6), p = attr(node, 'p').trim().split(/\s+/);
    if (!ELEMENTS[z - 1] || p.length !== 2) fail('CDXML 原子元素或二维坐标无效');
    if (attr(node, 'xyz')) fail('三维 CDXML 结构暂不支持', 'UNSUPPORTED_3D');
    if (attr(node, 'Radical') && attr(node, 'Radical') !== 'None') fail('自由基语义尚未实现', 'UNSUPPORTED_RADICAL');
    for (const key of ['ElementList', 'GenericNickname', 'Attachments', 'AtomNumber', 'SubstituentsExactly', 'SubstituentsUpTo', 'RingBondCount', 'Unsaturated', 'RxnChange', 'RxnStereo', 'EnhancedStereoType', 'EnhancedStereoGroupNum']) {
      if (node.hasAttribute(key)) fail(`CDXML ${key} 语义尚未实现`, 'UNSUPPORTED_ATOM_PROPERTY');
    }
    const props: Partial<Atom> = { charge: integer(attr(node, 'Charge'), 0) };
    if (node.hasAttribute('Isotope')) props.isotope = integer(attr(node, 'Isotope'));
    if (node.hasAttribute('NumHydrogens')) props.hydrogens = { mode: 'fixed', count: integer(attr(node, 'NumHydrogens')) };
    reader.atom(ref, ELEMENTS[z - 1], numeric(p[0]) / 20, -numeric(p[1]) / 20, props);
    checkAttributes(node, ['id', 'p', 'Element', 'NodeType', 'Charge', 'Isotope', 'NumHydrogens', 'Radical'], issues);
    const labels = all(node, 't');
    if (labels.some(t => t.textContent?.trim() !== ELEMENTS[z - 1] || [...t.children].some(s => s.localName !== 's' || [...s.attributes].some(a => !['font', 'size'].includes(a.name)) || (s.hasAttribute('font') && attr(s, 'font') !== '3') || (s.hasAttribute('size') && attr(s, 'size') !== '10')))) warning(issues, 'ChemDraw 原子标签的字体与排版暂未解释');
  }
  for (const bond of all(input, 'b')) {
    const ref = attr(bond, 'id'); if (!ref || ids.has(ref)) fail('重复或缺失的 ChemDraw 对象 ID'); ids.add(ref);
    const orderText = attr(bond, 'Order') || '1';
    if (!['1', '2', '3', '1.5'].includes(orderText)) fail(`尚未支持的 ChemDraw 键型：${orderText}`, 'UNSUPPORTED_BOND');
    const display = attr(bond, 'Display') || 'Solid';
    const style = display.startsWith('WedgedHash') ? 'hashed' : display.startsWith('Wedge') ? 'wedge' : display === 'Wavy' ? 'wavy' : undefined;
    if (!['Solid', 'WedgeBegin', 'WedgeEnd', 'WedgedHashBegin', 'WedgedHashEnd', 'Wavy'].includes(display)) fail(`尚未支持的 ChemDraw 键描绘：${display}`, 'UNSUPPORTED_BOND');
    for (const key of ['BS', 'BondCircularOrdering', 'Topology', 'RxnParticipation']) if (bond.hasAttribute(key)) fail(`CDXML 键属性 ${key} 尚未实现`, 'UNSUPPORTED_BOND');
    reader.bond(attr(bond, 'B'), attr(bond, 'E'), orderText === '1.5' ? 'aromatic' : Number(orderText) as BondOrder, style, display.endsWith('End'));
    checkAttributes(bond, ['id', 'B', 'E', 'Order', 'Display'], issues);
  }
  if (!Object.keys(reader.document.graph.atoms).length && (fragments.length || all(input, 't').length)) fail('文件中没有可编辑的普通分子结构');
  const known = new Set(['CDXML', 'page', 'fragment', 'n', 'b', 't', 's', 'fonttable', 'font', 'colortable', 'color']);
  for (const el of [...input.getElementsByTagName('*')]) {
    if (!known.has(el.localName)) warning(issues, `ChemDraw 文档对象 ${el.localName} 暂未解释`);
  }
  if (all(input, 'page').some(p => children(p, 't').length)) warning(issues, '独立文本对象暂不在画布中显示');
  if (all(input, 'page').length > 1) warning(issues, '多页 ChemDraw 文档会在同一画布中显示');
  const defaultStyle: Record<string, string> = { BondLength: '30', LabelFont: '3', LabelSize: '10' };
  if ([...input.documentElement.attributes].some(a => defaultStyle[a.name] !== a.value)) warning(issues, 'ChemDraw 文档样式与页面设置暂未完整解释');
  if (all(input, 'fragment').some(f => [...f.attributes].some(a => a.name !== 'id')) || all(input, 'page').some(p => [...p.attributes].some(a => a.name !== 'id'))) warning(issues, 'ChemDraw 页面或片段属性暂未完整解释');
  return finish(reader.document, raw, 'cdxml', issues, name);
}
export function writeCdxml(doc: ChemicalDocument): string {
  const atoms = Object.values(doc.graph.atoms), indices = new Map(atoms.map((a, i) => [a.id, i + 3]));
  const nodes = atoms.map(a => {
    const p = doc.depiction.positions[a.id];
    const properties = `${a.charge ? ` Charge="${a.charge}"` : ''}${a.isotope ? ` Isotope="${a.isotope}"` : ''}${a.hydrogens.mode === 'fixed' ? ` NumHydrogens="${a.hydrogens.count}"` : ''}`;
    const label = a.element === 'C' && !a.charge && !a.isotope ? '' : `<t p="${(p.x * 20).toFixed(4)} ${(-p.y * 20).toFixed(4)}"><s font="3" size="10">${esc(a.element)}</s></t>`;
    return `      <n id="${indices.get(a.id)}" p="${(p.x * 20).toFixed(4)} ${(-p.y * 20).toFixed(4)}" Element="${atomicNumber(a.element)}"${properties}>${label}</n>`;
  });
  const bonds = Object.values(doc.graph.bonds).map((b, i) => {
    const d = doc.depiction.bonds[b.id], reverse = d?.from === b.atoms[1];
    const display = d?.style === 'wedge' ? `Wedge${reverse ? 'End' : 'Begin'}` : d?.style === 'hashed' ? `WedgedHash${reverse ? 'End' : 'Begin'}` : d?.style === 'wavy' ? 'Wavy' : 'Solid';
    return `      <b id="${atoms.length + 3 + i}" B="${indices.get(b.atoms[0])}" E="${indices.get(b.atoms[1])}" Order="${b.order === 'aromatic' ? '1.5' : b.order}" Display="${display}"/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CDXML BondLength="30" LabelFont="3" LabelSize="10">\n  <fonttable><font id="3" charset="utf-8" name="Arial"/></fonttable>\n  <page id="1"><fragment id="2">\n${[...nodes, ...bonds].join('\n')}\n  </fragment></page>\n</CDXML>`;
}
export function readMrv(raw: string, name?: string): ImportResult {
  const input = xml(raw, ['cml', 'MDocument', 'molecule']), issues: Diagnostic[] = [];
  if (all(input, 'reaction').length || all(input, 'Rgroup').length) fail('MRV 反应／R-group 定义尚未实现', 'UNSUPPORTED_REACTION');
  const molecules = [...input.getElementsByTagName('*')].filter(e => e.localName === 'molecule');
  if (molecules.some(m => m.hasAttribute('role') || all(m, 'molecule').length)) fail('MRV S-group／嵌套分子尚未实现', 'UNSUPPORTED_GROUP');
  const reader = new GraphReader(name?.replace(/\.mrv$/i, '') || 'Marvin 结构');
  for (let mi = 0; mi < molecules.length; mi++) {
    const molecule = molecules[mi], prefix = `m${mi}:`;
    checkAttributes(molecule, ['molID'], issues);
    for (const array of children(molecule, 'atomArray')) {
      if (array.hasAttribute('atomID')) {
        const ids = attr(array, 'atomID').trim().split(/\s+/), elements = attr(array, 'elementType').trim().split(/\s+/), xs = attr(array, 'x2').trim().split(/\s+/), ys = attr(array, 'y2').trim().split(/\s+/);
        if (ids.some(id => !id) || [elements, xs, ys].some(a => a.length !== ids.length)) fail('MRV 压缩原子数组长度不一致');
        for (let i = 0; i < ids.length; i++) reader.atom(prefix + ids[i], elements[i], numeric(xs[i]), numeric(ys[i]));
        checkAttributes(array, ['atomID', 'elementType', 'x2', 'y2'], issues);
        const chemicalColumns = [...array.attributes].filter(a => !['atomID', 'elementType', 'x2', 'y2'].includes(a.name));
        if (chemicalColumns.length) fail('压缩 MRV 原子数组的附加语义列尚未实现；请改用逐原子 MRV', 'UNSUPPORTED_ATOM_PROPERTY');
      } else for (const atom of children(array, 'atom')) {
        if (attr(atom, 'x3') || attr(atom, 'y3') || attr(atom, 'z3')) fail('三维 MRV 坐标尚未实现', 'UNSUPPORTED_3D');
        for (const key of ['radical', 'mrvQueryProps', 'mrvAlias', 'mrvStereoGroup', 'rgroupRef', 'lonePair', 'mrvValence', 'mrvLinkNodeOut', 'attachmentPoint', 'mrvPseudo', 'mrvExtraLabel']) if (atom.hasAttribute(key)) fail(`MRV 原子属性 ${key} 尚未实现`, 'UNSUPPORTED_ATOM_PROPERTY');
        const props: Partial<Atom> = { charge: integer(attr(atom, 'formalCharge'), 0) };
        if (atom.hasAttribute('isotope')) props.isotope = integer(attr(atom, 'isotope'));
        if (atom.hasAttribute('mrvMap')) props.atomMap = integer(attr(atom, 'mrvMap'));
        if (atom.hasAttribute('hydrogenCount')) props.hydrogens = { mode: 'fixed', count: integer(attr(atom, 'hydrogenCount')) };
        if (!attr(atom, 'id')) fail('MRV 原子缺少 ID');
        reader.atom(prefix + attr(atom, 'id'), attr(atom, 'elementType'), numeric(attr(atom, 'x2')), numeric(attr(atom, 'y2')), props);
        if (atom.children.length) fail('MRV 原子级子对象尚未实现', 'UNSUPPORTED_ATOM_PROPERTY');
        checkAttributes(atom, ['id', 'elementType', 'x2', 'y2', 'formalCharge', 'isotope', 'mrvMap', 'hydrogenCount'], issues);
      }
    }
    for (const array of children(molecule, 'bondArray')) {
      if (array.attributes.length) fail('MRV 压缩键数组尚未实现', 'UNSUPPORTED_BOND');
      for (const bond of children(array, 'bond')) {
        const refs = attr(bond, 'atomRefs2').trim().split(/\s+/), order = attr(bond, 'order') || '1';
        if (refs.length !== 2 || !['1', '2', '3', 'A'].includes(order)) fail('MRV 查询键或多中心连接尚未实现', 'UNSUPPORTED_BOND');
        const stereo = children(bond, 'bondStereo')[0]?.textContent?.trim() || '';
        if (!['', 'W', 'H', 'U'].includes(stereo)) fail('此 MRV 键立体编码尚未实现', 'UNSUPPORTED_STEREO');
        if ([...bond.children].some(e => e.localName !== 'bondStereo')) fail('MRV 键级子对象尚未实现', 'UNSUPPORTED_BOND');
        reader.bond(prefix + refs[0], prefix + refs[1], order === 'A' ? 'aromatic' : Number(order) as BondOrder, stereo === 'W' ? 'wedge' : stereo === 'H' ? 'hashed' : stereo === 'U' ? 'wavy' : undefined);
        checkAttributes(bond, ['id', 'atomRefs2', 'order'], issues);
      }
    }
    for (const el of [...molecule.children]) if (!['atomArray', 'bondArray'].includes(el.localName)) fail(`MRV 分子对象 ${el.localName} 尚未实现`, 'UNSUPPORTED_GROUP');
  }
  const graphical = [...input.getElementsByTagName('*')].filter(e => /^M/.test(e.localName) && !['MDocument', 'MChemicalStruct', 'MHead'].includes(e.localName));
  if (graphical.length) warning(issues, 'MRV 包含尚未显示的图形或文档对象');
  const known = new Set(['cml', 'MDocument', 'MChemicalStruct', 'molecule', 'atomArray', 'atom', 'bondArray', 'bond', 'bondStereo']);
  if ([...input.getElementsByTagName('*')].some(e => !known.has(e.localName))) warning(issues, 'MRV 包含尚未解释的附加文档数据');
  if (all(input, 'MDocument').some(e => e.attributes.length > 0) || all(input, 'MChemicalStruct').some(e => e.attributes.length > 0)) warning(issues, 'MRV 文档的显示属性暂未完整解释');
  return finish(reader.document, raw, 'mrv', issues, name);
}
export function writeMrv(doc: ChemicalDocument): string {
  const atoms = Object.values(doc.graph.atoms), indices = new Map(atoms.map((a, i) => [a.id, `a${i + 1}`]));
  const nodes = atoms.map(a => {
    const p = doc.depiction.positions[a.id];
    return `        <atom id="${indices.get(a.id)}" elementType="${a.element}" x2="${p.x.toFixed(6)}" y2="${p.y.toFixed(6)}"${a.charge ? ` formalCharge="${a.charge}"` : ''}${a.isotope ? ` isotope="${a.isotope}"` : ''}${a.atomMap ? ` mrvMap="${a.atomMap}"` : ''}${a.hydrogens.mode === 'fixed' ? ` hydrogenCount="${a.hydrogens.count}"` : ''}/>`;
  });
  const bonds = Object.values(doc.graph.bonds).map((b, i) => {
    let [a, c] = b.atoms; const d = doc.depiction.bonds[b.id]; if (d?.from === c) [a, c] = [c, a];
    const stereo = d?.style === 'wedge' ? 'W' : d?.style === 'hashed' ? 'H' : d?.style === 'wavy' ? 'U' : '';
    return `        <bond id="b${i + 1}" atomRefs2="${indices.get(a)} ${indices.get(c)}" order="${b.order === 'aromatic' ? 'A' : b.order}">${stereo ? `<bondStereo>${stereo}</bondStereo>` : ''}</bond>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<cml xmlns="http://www.chemaxon.com">\n  <MDocument><MChemicalStruct>\n    <molecule molID="m1">\n      <atomArray>\n${nodes.join('\n')}\n      </atomArray>\n      <bondArray>\n${bonds.join('\n')}\n      </bondArray>\n    </molecule>\n  </MChemicalStruct></MDocument>\n</cml>`;
}
