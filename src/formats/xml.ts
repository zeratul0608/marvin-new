import { ELEMENTS } from '../core/model';
import type { Atom, BondOrder, ChemicalDocument, Diagnostic, ImportResult } from '../core/types';
import { escapeXml as esc, fail, finish, GraphReader, integer, numeric } from './shared';
import { readOrdering } from './stereo';
import { atomXmlProperties, bondXmlProperties, readXmlQuery } from './chemdraw-properties';
import { chemicalSymbol } from '../core/query';
import { fragmentXml, scopeElements } from './xml-scope';
import { embeddedFragments } from './xml-substructure';
import { atomCipLabels, reactionParticipations } from '../core/chemistry-annotations';
import { readXmlDocument } from './xml-document';
import {atomQueryXmlFields,readXmlQueryConstraints,readXmlBondTopology} from './query-properties';
import { drawingTags } from '../core/drawing';
import { geometryFromOrdering } from '../core/stereochemistry';
import { rebuildXmlDocument } from './xml-document-write';
import {readSubstructureDisplay,expandedViewXml} from './xml-substructure-display';

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
  const visual = ['color', 'fontScale', 'chargeAngle', 'Z', 'BoundingBox', 'DoublePosition', 'LabelDisplay', 'ShowAtomNumber', 'ShowAtomQuery', 'ShowAtomStereo', 'ShowAtomEnhancedStereo', 'ShowAtomMap', 'ShowSequenceTermini', 'ShowResidueID', 'ShowBondStereo', 'ShowBondQuery', 'ShowBondRxn', 'title', 'NeedsClean', 'AtomNumber', 'LabelFont', 'LabelSize', 'LabelFace', 'LabelColor', 'LabelJustification', 'LabelAlignment', 'Warning', 'Visible', 'LineWidth', 'BoldWidth', 'HashSpacing', 'BondSpacing', 'BondSpacingAbs', 'MarginWidth', 'BondLength', 'IgnoreWarnings'];
  visual.push('highlightColor', 'HideImplicitHydrogens', 'ShowPerspective');
  for (const a of [...el.attributes]) {
    if (!allowed.includes(a.name) && !a.name.startsWith('xmlns')) {
      if (!visual.includes(a.name)) fail(`源文件属性 ${el.localName}.${a.name} 尚未实现，为避免改变化学语义已停止导入`, 'UNSUPPORTED_PROPERTY');
      warning(issues, `源文件属性 ${el.localName}.${a.name} 暂未解释；编辑后导出可能无法保留`);
    }
  }
}
export function readCdxml(raw: string, name?: string, depth = 0): ImportResult {
  if (depth >= 16) fail('嵌套片段超过 16 层', 'SIZE_LIMIT');
  const input = xml(raw, ['CDXML']), issues: Diagnostic[] = [];
  const reader = new GraphReader(name?.replace(/\.cdxml$/i, '') || 'ChemDraw 结构');
  const fragments = scopeElements(input, 'fragment');
  if (all(input, 'scheme').some(scheme => !children(scheme, 'step').length)) fail('反应方案没有步骤', 'INVALID_REACTION');
  if (all(input, 'alternativegroup').length) fail('独立的 alternativegroup 尚未实现', 'UNSUPPORTED_GROUP');
  const ids = new Set<string>();
  const atomElements = new Map<Element, string>(), bondElements = new Map<Element, string>();
  for (const node of scopeElements(input, 'n')) {
    if (node.parentElement?.localName !== 'fragment') fail('CDXML 原子必须属于可识别的分子片段');
    const attachment = attr(node, 'NodeType') === 'ExternalConnectionPoint';
    const inner = children(node, 'fragment');
    const nested = inner.length > 0 && ['Fragment', 'Nickname', 'Unspecified', 'AnonymousAlternativeGroup'].includes(attr(node, 'NodeType'));
    const named = !nested && ['Fragment','Nickname'].includes(attr(node, 'NodeType'));
    const multi = attr(node, 'NodeType') === 'MultiAttachment';
    if (!nested && !named && !multi && attr(node, 'NodeType') && !['Element', 'ExternalConnectionPoint', 'ElementList', 'GenericNickname', 'Unspecified'].includes(attr(node, 'NodeType'))) fail(`尚未支持的 ChemDraw 原子类型：${attr(node, 'NodeType')}`, 'UNSUPPORTED_QUERY');
    const ref = attr(node, 'id'); if (ids.has(ref)) fail('重复的 ChemDraw 对象 ID'); ids.add(ref);
    const z = integer(attr(node, 'Element'), 6), p = attr(node, 'p').trim().split(/\s+/);
    if (!ELEMENTS[z - 1] || p.length !== 2) fail('CDXML 原子元素或二维坐标无效');
    if (attr(node, 'Radical') && !['None', 'Singlet', 'Doublet', 'Triplet'].includes(attr(node, 'Radical'))) fail('CDXML 自由基自旋态无效', 'UNSUPPORTED_RADICAL');
    if (node.hasAttribute('Geometry') && !['Unknown', 'Tetrahedral'].includes(attr(node, 'Geometry'))) fail('此 CDXML 原子几何类型尚未实现', 'UNSUPPORTED_STEREO');
    if (!nested && node.hasAttribute('BondOrdering') !== (attr(node, 'Geometry') === 'Tetrahedral')) fail('四面体几何需要明确的 BondOrdering；其他用途的键排序尚未实现', 'UNSUPPORTED_STEREO');
    if (node.hasAttribute('AS') && !['U', 'N', ...atomCipLabels].includes(attr(node, 'AS'))) fail('CDXML 来源 CIP 标签无效', 'UNSUPPORTED_STEREO');
    if (node.hasAttribute('Attachments') && !multi) fail('Attachments 需要明确的多中心连接节点', 'INVALID_ATTACHMENT');
    for (const key of ['Unsaturated']) {
      if (node.hasAttribute(key)) fail(`CDXML ${key} 语义尚未实现`, 'UNSUPPORTED_ATOM_PROPERTY');
    }
    const props: Partial<Atom> = { charge: integer(attr(node, 'Charge'), 0), ...(!nested ? readXmlQuery(node) : {}) };
    const constraints=readXmlQueryConstraints(node);if(constraints)props.queryConstraints=constraints;
    if (node.hasAttribute('xyz')) { const coords = attr(node, 'xyz').trim().split(/\s+/).map(numeric); if (coords.length !== 3) fail('三维原子坐标必须包含三个数值'); props.spatial = coords as [number,number,number]; }
    if (named) {
      const label = children(node, 't').map(el => el.textContent ?? '').join('').trim();
      if (!label) fail('命名片段缺少内部结构及名称', 'INVALID_FRAGMENT');
      props.namedFragment = { type: attr(node, 'NodeType') as 'Fragment' | 'Nickname', label };
      warning(issues, `源文件未提供 ${label} 的内部结构，保留其名称和真实外部连接；不能推测缺失的化学图`, 'UNRESOLVED_SOURCE_FRAGMENT');
    }
    if (multi) props.multiAttachment = [];
    if (node.hasAttribute('EnhancedStereoType')) props.enhancedStereo = { type: attr(node, 'EnhancedStereoType') as 'Absolute' | 'Or' | 'And', ...(node.hasAttribute('EnhancedStereoGroupNum') && attr(node, 'EnhancedStereoType') !== 'Absolute' ? { group: integer(attr(node, 'EnhancedStereoGroupNum')) } : {}) };
    else if (node.hasAttribute('EnhancedStereoGroupNum')) fail('增强立体组编号缺少类型', 'INVALID_STEREO');
    if (nested) {
      props.substructure = { kind: attr(node, 'NodeType') === 'AnonymousAlternativeGroup' ? 'alternatives' : 'abbreviation', label: children(node, 't').map(t => t.textContent).join('').trim() || attr(node, 'GenericNickname') || '片段', fragments: inner.map(fragment => {
        const document = readCdxml(fragmentXml(input, fragment), undefined, depth + 1).document;
        const sourceAtoms = children(fragment, 'n'), modelIds = Object.keys(document.graph.atoms), map = new Map(sourceAtoms.map((n, i) => [attr(n, 'id'), modelIds[i]]));
        const ports = attr(fragment, 'ConnectionOrder').trim();
        const attachmentOrder = ports ? ports.split(/\s+/).map(id => { const ref = map.get(id); if (!ref) fail('内部片段 ConnectionOrder 引用无效'); return ref; }) : sourceAtoms.filter(n => attr(n, 'NodeType') === 'ExternalConnectionPoint').sort((a,b) => integer(attr(a, 'ExternalConnectionNum'), 0) - integer(attr(b, 'ExternalConnectionNum'), 0)).map(n => map.get(attr(n, 'id'))!);
        return { document, attachmentOrder };
      }), connections: [] };
      if (node.hasAttribute('AtomID')) props.sourceNumber = integer(attr(node, 'AtomID'));
      if (node.hasAttribute('ResidueID')) props.residueId = integer(attr(node, 'ResidueID'));
      const connection = attr(node, 'ExternalConnectionType'); if (connection) props.connectionType = connection as Atom['connectionType'];
    }
    const display=readSubstructureDisplay(node,!!props.substructure);if(display)props.substructure!.display=display;
    const radical = ['None', 'Singlet', 'Doublet', 'Triplet'].indexOf(attr(node, 'Radical'));
    if (radical > 0) props.radical = radical as Atom['radical'];
    if (node.hasAttribute('Isotope')) { const isotope = integer(attr(node, 'Isotope')); if (isotope) props.isotope = isotope; }
    if (node.hasAttribute('NumHydrogens')) props.hydrogens = { mode: 'fixed', count: integer(attr(node, 'NumHydrogens')) };
    if (attachment) {
      if (node.hasAttribute('Element') || props.charge || props.isotope || props.radical || (props.hydrogens && (props.hydrogens.mode !== 'fixed' || props.hydrogens.count !== 0)) || node.children.length) fail('外部连接点包含不支持的附加化学信息', 'UNSUPPORTED_ATTACHMENT');
      props.attachment = 'external'; props.hydrogens = { mode: 'fixed', count: 0 };
    }
    atomElements.set(node, reader.atom(ref, attachment || props.query || props.substructure || props.namedFragment || props.multiAttachment ? '*' : ELEMENTS[z - 1], numeric(p[0]) / 20, -numeric(p[1]) / 20, props));
    checkAttributes(node, ['id', 'p', 'xyz', 'Element', 'NodeType', 'Charge', 'Isotope', 'NumHydrogens', 'Radical', 'AS', 'Geometry', 'BondOrdering', 'ElementList', 'GenericNickname', 'AtomID', 'ExternalConnectionNum', 'ExternalConnectionType', 'ResidueID', 'Attachments', 'EnhancedStereoType', 'EnhancedStereoGroupNum',...atomQueryXmlFields], issues);
    const labels = all(node, 't');
    if (labels.some(t => t.textContent?.trim() !== ELEMENTS[z - 1] || [...t.children].some(s => s.localName !== 's' || [...s.attributes].some(a => !['font', 'size'].includes(a.name)) || (s.hasAttribute('font') && attr(s, 'font') !== '3') || (s.hasAttribute('size') && attr(s, 'size') !== '10')))) warning(issues, 'ChemDraw 原子标签的字体与排版暂未解释');
  }
  for (const bond of scopeElements(input, 'b')) {
    // Bond IDs are optional in CDXML; endpoints still refer to required node IDs.
    const ref = attr(bond, 'id'); if (ref && ids.has(ref)) fail('重复的 ChemDraw 对象 ID'); if (ref) ids.add(ref);
    if (bond.parentElement?.localName !== 'fragment') fail('CDXML 键必须属于可识别的分子片段');
    const orderText = attr(bond, 'Order') || '1';
    if (!['1', '2', '2.5', '3', '1.5', 'any'].includes(orderText)) fail(`尚未支持的 ChemDraw 键型：${orderText}`, 'UNSUPPORTED_BOND');
    const display = attr(bond, 'Display') || 'Solid';
    const style = display.startsWith('WedgedHash') ? 'hashed' : display.startsWith('Wedge') ? 'wedge' : display === 'Wavy' ? 'wavy' : display === 'Dash' ? 'dashed' : display === 'Bold' ? 'bold' : display === 'Hash' ? 'hash' : undefined;
    if (!['Solid', 'WedgeBegin', 'WedgeEnd', 'WedgedHashBegin', 'WedgedHashEnd', 'Wavy', 'Dash', 'Bold', 'Hash'].includes(display)) fail(`尚未支持的 ChemDraw 键描绘：${display}`, 'UNSUPPORTED_BOND');
    if (bond.hasAttribute('BS') && !['U', 'N', 'E', 'Z'].includes(attr(bond, 'BS'))) fail('CDXML 双键来源 CIP 标签无效', 'UNSUPPORTED_STEREO');
    const nodeRefs = children(bond.parentElement!, 'n').map(n => attr(n, 'id'));
    if (![attr(bond, 'B'), attr(bond, 'E')].every(ref => nodeRefs.includes(ref))) fail('CDXML 键端点必须位于同一分子片段', 'INVALID_BOND_REFERENCE');
    const id = reader.bond(attr(bond, 'B'), attr(bond, 'E'), orderText === '1.5' ? 'aromatic' : orderText === 'any' ? 'any' : Number(orderText) as BondOrder, style, display.endsWith('End'));
    bondElements.set(bond, id);
    const modelBond = reader.document.graph.bonds[id];
    const topology=readXmlBondTopology(bond);if(topology!==undefined)modelBond.topology=topology;
    if (['E', 'Z'].includes(attr(bond, 'BS'))) modelBond.cipLabel = attr(bond, 'BS') as 'E' | 'Z';
    if (bond.hasAttribute('RxnParticipation') && attr(bond, 'RxnParticipation') !== 'Unspecified') { if (!(reactionParticipations as readonly string[]).includes(attr(bond, 'RxnParticipation'))) fail('反应键条件无效'); modelBond.reactionParticipation = attr(bond, 'RxnParticipation') as typeof modelBond.reactionParticipation; }
    if (bond.hasAttribute('Connectivity') && attr(bond, 'Connectivity') !== 'Unspecified') modelBond.sequenceConnectivity = attr(bond, 'Connectivity') as typeof modelBond.sequenceConnectivity;
    if (bond.hasAttribute('BeginExternalNum') || bond.hasAttribute('EndExternalNum')) modelBond.externalNumbers = [bond.hasAttribute('BeginExternalNum') ? integer(attr(bond, 'BeginExternalNum')) : null, bond.hasAttribute('EndExternalNum') ? integer(attr(bond, 'EndExternalNum')) : null];
    if (bond.hasAttribute('DoublePosition')) {
      const position = attr(bond, 'DoublePosition');
      if (!['Center', 'Left', 'Right'].includes(position) || orderText !== '2' || style) fail('CDXML 双键位置与键型不匹配', 'UNSUPPORTED_BOND');
      reader.document.depiction.bonds[id] = { style: 'plain', from: reader.document.graph.bonds[id].atoms[0], doublePosition: position.toLowerCase() as 'left' | 'right' | 'center' };
    }
    const offsets: [number, number] = [integer(attr(bond, 'BeginAttach'), 0), integer(attr(bond, 'EndAttach'), 0)];
    if (offsets.some(Boolean) || bond.hasAttribute('CrossingBonds') || bond.hasAttribute('Z')) reader.document.depiction.bonds[id] = { ...(reader.document.depiction.bonds[id] ?? { style: 'plain', from: reader.document.graph.bonds[id].atoms[0] }), ...(offsets.some(Boolean) ? { labelOffsets: offsets } : {}), ...(bond.hasAttribute('Z') ? { layer: integer(attr(bond, 'Z')) } : {}) };
    if (bond.hasAttribute('Display2')) { const value = attr(bond, 'Display2'); if (!['Dash','Solid'].includes(value)) fail('第二条键线的描绘尚未实现'); (reader.document.depiction.bonds[id] ??= { style: 'plain', from: modelBond.atoms[0] }).secondaryStyle = value === 'Dash' ? 'dashed' : 'plain'; }
    checkAttributes(bond, ['id', 'B', 'E', 'Order', 'Display', 'Display2', 'BS', 'DoublePosition', 'BondCircularOrdering', 'BeginAttach', 'EndAttach', 'CrossingBonds', 'RxnParticipation', 'Connectivity', 'BeginExternalNum', 'EndExternalNum','Topology'], issues);
  }
  for (const fragment of fragments) {
    const bondRefs = new Map(children(fragment, 'b').filter(b => attr(b, 'id')).map(b => [attr(b, 'id'), bondElements.get(b)!]));
    for (const node of children(fragment, 'n')) if (attr(node, 'Geometry') === 'Tetrahedral') { const atomId = atomElements.get(node)!; reader.document.graph.atoms[atomId].geometry = geometryFromOrdering(reader.document, atomId, readOrdering(attr(node, 'BondOrdering').trim().split(/\s+/), bondRefs)); }
    for (const bond of children(fragment, 'b')) if (bond.hasAttribute('BondCircularOrdering')) reader.document.graph.bonds[bondElements.get(bond)!].circularOrdering = readOrdering(attr(bond, 'BondCircularOrdering').trim().split(/\s+/), bondRefs);
    for (const bond of children(fragment, 'b')) if (bond.hasAttribute('CrossingBonds')) {
      const d = reader.document.depiction.bonds[bondElements.get(bond)!];
      const documentBonds = new Map([...bondElements].map(([el, id]) => [attr(el, 'id'), id]));
      d.crossings = attr(bond, 'CrossingBonds').trim().split(/\s+/).filter(Boolean).map(ref => { const id = documentBonds.get(ref); if (!id) fail('交叉键引用不存在'); return id; });
    }
    for (const node of children(fragment, 'n')) {
      const atom = reader.document.graph.atoms[atomElements.get(node)!], group = atom.substructure;
      if (atom.multiAttachment) atom.multiAttachment = attr(node, 'Attachments').trim().split(/\s+/).filter(Boolean).map(ref => { const target = reader.refs.get(ref); if (!target) fail('多中心连接引用不存在'); return target; });
      if (!group) continue;
      const adjacent = Object.values(reader.document.graph.bonds).filter(b => b.atoms.includes(atom.id));
      const refs = attr(node, 'BondOrdering').trim();
      if (adjacent.length > 1 && !refs) fail('多连接缩写缺少明确的外部键顺序', 'INVALID_FRAGMENT_PORT');
      const external = refs ? refs.split(/\s+/).map(ref => { const id = bondRefs.get(ref); if (!id) fail('缩写外部键引用无效'); return id; }) : adjacent.map(b => b.id);
      if (external.length && group.fragments.length !== 1) fail('带外部连接的备选组需要多分支端口映射', 'UNSUPPORTED_GROUP');
      const ports = group.fragments[0].attachmentOrder;
      if (external.length > ports.length) fail('缩写内部缺少外部连接点', 'INVALID_FRAGMENT_PORT');
      group.connections = external.map((bondId, i) => ({ bondId, fragment: 0, atomId: ports[i] }));
    }
  }
  readXmlDocument(input, reader.document, atomElements, bondElements);
  const known = new Set(['CDXML', 'page', 'fragment', 'n', 'b', 't', 's', 'fonttable', 'font', 'colortable', 'color', 'scheme', 'step', ...drawingTags]);
  for (const el of [...input.getElementsByTagName('*')]) {
    if (!known.has(el.localName)) warning(issues, `ChemDraw 文档对象 ${el.localName} 暂未解释`);
  }
  if (all(input, 'page').length > 1) warning(issues, '多页 ChemDraw 文档会在同一画布中显示');
  const defaultStyle: Record<string, string> = { BondLength: '30', LabelFont: '3', LabelSize: '10' };
  if ([...input.documentElement.attributes].some(a => defaultStyle[a.name] !== a.value)) warning(issues, 'ChemDraw 文档样式与页面设置暂未完整解释');
  if (all(input, 'fragment').some(f => [...f.attributes].some(a => a.name !== 'id')) || all(input, 'page').some(p => [...p.attributes].some(a => a.name !== 'id'))) warning(issues, 'ChemDraw 页面或片段属性暂未完整解释');
  return finish(reader.document, raw, 'cdxml', issues, name);
}
export function writeCdxml(doc: ChemicalDocument): string {
  const atoms = Object.values(doc.graph.atoms), indices = new Map(atoms.map((a, i) => [a.id, i + 3]));
  const bondRefs = new Map(Object.keys(doc.graph.bonds).map((id, i) => [id, atoms.length + 3 + i]));
  let extraId = atoms.length + Object.keys(doc.graph.bonds).length + 3;
  const ordering = (refs: (string | null)[]) => refs.map(id => id === null ? 0 : bondRefs.get(id)!).join(' ');
  const nodes = atoms.map(a => {
    const p = doc.depiction.positions[a.id];
    const properties = `${a.charge ? ` Charge="${a.charge}"` : ''}${a.isotope ? ` Isotope="${a.isotope}"` : ''}${a.radical ? ` Radical="${['None', 'Singlet', 'Doublet', 'Triplet'][a.radical]}"` : ''}${a.hydrogens.mode === 'fixed' ? ` NumHydrogens="${a.hydrogens.count}"` : ''}`;
    const label = a.attachment || a.multiAttachment || (a.query?.kind === 'any' && a.query.label === undefined) || (a.element === 'C' && !a.charge && !a.isotope) ? '' : `<t p="${(p.x * 20).toFixed(4)} ${(-p.y * 20).toFixed(4)}"><s font="${esc(doc.depiction.style?.attributes.LabelFont??doc.depiction.style?.fonts[0]?.id??'3')}" size="${esc(doc.depiction.style?.attributes.LabelSize??'10')}">${esc(chemicalSymbol(a))}</s></t>`;
    const nested = a.substructure ? embeddedFragments(a.substructure, () => String(extraId++), writeCdxml) : '';
    const connections = a.substructure?.connections.length ? ` BondOrdering="${a.substructure.connections.map(port => bondRefs.get(port.bondId)).join(' ')}"` : '';
    return `      <n id="${indices.get(a.id)}" p="${(p.x * 20).toFixed(4)} ${(-p.y * 20).toFixed(4)}"${Object.entries(atomXmlProperties(a)).map(([k,v]) => ` ${k}="${esc(v)}"`).join('')}${properties}${a.multiAttachment ? ` Attachments="${a.multiAttachment.map(id => indices.get(id)).join(' ')}"` : ''}${a.geometry ? ` Geometry="Tetrahedral" BondOrdering="${ordering(a.geometry.bondOrdering)}"` : ''}${connections}>${nested}${label}${a.substructure?.display==='expanded'?expandedViewXml:''}</n>`;
  });
  const bonds = Object.values(doc.graph.bonds).map((b, i) => {
    const d = doc.depiction.bonds[b.id], reverse = d?.from === b.atoms[1];
    const display = d?.style === 'wedge' ? `Wedge${reverse ? 'End' : 'Begin'}` : d?.style === 'hashed' ? `WedgedHash${reverse ? 'End' : 'Begin'}` : d?.style === 'wavy' ? 'Wavy' : d?.style === 'dashed' ? 'Dash' : d?.style === 'bold' ? 'Bold' : d?.style === 'hash' ? 'Hash' : 'Solid';
    const position = d?.doublePosition && reverse && d.doublePosition !== 'center' ? d.doublePosition === 'left' ? 'right' : 'left' : d?.doublePosition;
    const secondary = d?.secondaryStyle ? ` Display2="${d.secondaryStyle==='dashed'?'Dash':'Solid'}"` : '';
    return `      <b id="${atoms.length + 3 + i}" B="${indices.get(b.atoms[0])}" E="${indices.get(b.atoms[1])}" Order="${b.order === 'aromatic' ? '1.5' : b.order}" Display="${display}"${secondary}${position ? ` DoublePosition="${position[0].toUpperCase() + position.slice(1)}"` : ''}${b.circularOrdering ? ` BondCircularOrdering="${ordering(b.circularOrdering)}"` : ''}${d?.labelOffsets ? ` BeginAttach="${d.labelOffsets[0]}" EndAttach="${d.labelOffsets[1]}"` : ''}${d?.crossings ? ` CrossingBonds="${d.crossings.map(id => bondRefs.get(id)).join(' ')}"` : ''}${d?.layer !== undefined ? ` Z="${d.layer}"` : ''}${Object.entries(bondXmlProperties(b)).map(([k,v]) => ` ${k}="${esc(v)}"`).join('')}/>`;
  });
  const output = `<?xml version="1.0" encoding="UTF-8"?>\n<CDXML BondLength="30" LabelFont="3" LabelSize="10">\n  <fonttable><font id="3" charset="utf-8" name="Arial"/></fonttable>\n  <page id="1"><fragment id="2">\n${[...nodes, ...bonds].join('\n')}\n  </fragment></page>\n</CDXML>`;
  return Object.keys(doc.depiction.objects ?? {}).length || Object.keys(doc.graph.reactions ?? {}).length ? rebuildXmlDocument(doc,output) : output;
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
        for (const key of ['mrvQueryProps', 'mrvAlias', 'mrvStereoGroup', 'rgroupRef', 'lonePair', 'mrvValence', 'mrvLinkNodeOut', 'attachmentPoint', 'mrvPseudo', 'mrvExtraLabel']) if (atom.hasAttribute(key)) fail(`MRV 原子属性 ${key} 尚未实现`, 'UNSUPPORTED_ATOM_PROPERTY');
        const props: Partial<Atom> = { charge: integer(attr(atom, 'formalCharge'), 0) };
        if (atom.hasAttribute('radical')) {
          const radical = ({ monovalent: 2, 'divalent1': 1, 'divalent3': 3 } as const)[attr(atom, 'radical') as 'monovalent'];
          if (!radical) fail('MRV 自由基自旋态无效', 'UNSUPPORTED_RADICAL');
          props.radical = radical;
        }
        if (atom.hasAttribute('isotope')) props.isotope = integer(attr(atom, 'isotope'));
        if (atom.hasAttribute('mrvMap')) props.atomMap = integer(attr(atom, 'mrvMap'));
        if (atom.hasAttribute('hydrogenCount')) props.hydrogens = { mode: 'fixed', count: integer(attr(atom, 'hydrogenCount')) };
        if (!attr(atom, 'id')) fail('MRV 原子缺少 ID');
        reader.atom(prefix + attr(atom, 'id'), attr(atom, 'elementType'), numeric(attr(atom, 'x2')), numeric(attr(atom, 'y2')), props);
        if (atom.children.length) fail('MRV 原子级子对象尚未实现', 'UNSUPPORTED_ATOM_PROPERTY');
        checkAttributes(atom, ['id', 'elementType', 'x2', 'y2', 'formalCharge', 'isotope', 'mrvMap', 'hydrogenCount', 'radical'], issues);
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
  if(Object.values(doc.graph.atoms).some(a=>a.queryConstraints)||Object.values(doc.graph.bonds).some(b=>b.topology!==undefined))fail('MRV 尚未映射高级查询条件，请保存 CDXML、CDX 或 JSON','UNSUPPORTED_QUERY');
  const atoms = Object.values(doc.graph.atoms), indices = new Map(atoms.map((a, i) => [a.id, `a${i + 1}`]));
  const nodes = atoms.map(a => {
    const p = doc.depiction.positions[a.id];
    return `        <atom id="${indices.get(a.id)}" elementType="${a.element}" x2="${p.x.toFixed(6)}" y2="${p.y.toFixed(6)}"${a.charge ? ` formalCharge="${a.charge}"` : ''}${a.isotope ? ` isotope="${a.isotope}"` : ''}${a.radical ? ` radical="${['', 'divalent1', 'monovalent', 'divalent3'][a.radical]}"` : ''}${a.atomMap ? ` mrvMap="${a.atomMap}"` : ''}${a.hydrogens.mode === 'fixed' ? ` hydrogenCount="${a.hydrogens.count}"` : ''}/>`;
  });
  const bonds = Object.values(doc.graph.bonds).map((b, i) => {
    let [a, c] = b.atoms; const d = doc.depiction.bonds[b.id]; if (d?.from === c) [a, c] = [c, a];
    const stereo = d?.style === 'wedge' ? 'W' : d?.style === 'hashed' ? 'H' : d?.style === 'wavy' ? 'U' : '';
    return `        <bond id="b${i + 1}" atomRefs2="${indices.get(a)} ${indices.get(c)}" order="${b.order === 'aromatic' ? 'A' : b.order}">${stereo ? `<bondStereo>${stereo}</bondStereo>` : ''}</bond>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<cml xmlns="http://www.chemaxon.com">\n  <MDocument><MChemicalStruct>\n    <molecule molID="m1">\n      <atomArray>\n${nodes.join('\n')}\n      </atomArray>\n      <bondArray>\n${bonds.join('\n')}\n      </bondArray>\n    </molecule>\n  </MChemicalStruct></MDocument>\n</cml>`;
}
