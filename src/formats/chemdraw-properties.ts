import { atomicNumber, ELEMENTS } from '../core/model';
import type { Atom, Bond, BondOrder } from '../core/types';
import { fail, integer } from './shared';
import { atomCipLabels, connectionTypes } from '../core/chemistry-annotations';
import {queryConstraintXmlProperties,queryConstraintCdxProperties} from './query-properties';

export const cdxOrder = (order: BondOrder): number => order === 'any' ? 0xffff : order === 'aromatic' ? 128 : order === 2.5 ? 256 : order === 3 ? 4 : order;
export function readXmlQuery(node: Element): Partial<Atom> {
  const type = node.getAttribute('NodeType'), result: Partial<Atom> = {};
  if ((node.hasAttribute('ElementList') && type !== 'ElementList') || (node.hasAttribute('GenericNickname') && type !== 'GenericNickname')) fail('查询属性与原子类型不匹配', 'INVALID_QUERY');
  if (type === 'ElementList') {
    const values = (node.getAttribute('ElementList') ?? '').trim().split(/\s+/), exclude = values[0] === 'NOT';
    if (exclude) values.shift();
    result.query = { kind: 'elements', elements: values.map(v => { const e = ELEMENTS[integer(v) - 1]; if (!e) fail('查询元素列表无效'); return e; }), ...(exclude ? { exclude } : {}) };
  } else if (type === 'GenericNickname') result.query = { kind: 'generic', label: node.getAttribute('GenericNickname') ?? node.textContent?.trim() ?? '' };
  else if (type === 'Unspecified') { const label = node.textContent?.trim(); result.query = { kind: 'any', ...(label ? { label } : {}) }; }
  if (node.hasAttribute('AtomID')) result.sourceNumber = integer(node.getAttribute('AtomID')!);
  if (node.hasAttribute('ExternalConnectionNum')) result.attachmentIndex = integer(node.getAttribute('ExternalConnectionNum')!);
  if (node.hasAttribute('ResidueID')) result.residueId = integer(node.getAttribute('ResidueID')!);
  const connection = node.getAttribute('ExternalConnectionType');
  if (connection) { if (!(connectionTypes as readonly string[]).includes(connection)) fail('外部／生物连接类型无效'); result.connectionType = connection as Atom['connectionType']; }
  const cip = node.getAttribute('AS');
  if (cip && !['U', 'N'].includes(cip)) { if (!(atomCipLabels as readonly string[]).includes(cip)) fail('来源 CIP 标签无效'); result.cipLabel = cip as Atom['cipLabel']; }
  return result;
}

/** Known semantic fields shared by rebuilding and source-preserving XML writers. */
export function atomXmlProperties(atom: Atom): Record<string, string> {
  const result: Record<string, string> = {...queryConstraintXmlProperties(atom.queryConstraints)};
  if (atom.substructure) { result.NodeType = atom.substructure.kind === 'alternatives' ? 'AnonymousAlternativeGroup' : 'Fragment'; if (atom.substructure.kind === 'alternatives') result.GenericNickname = atom.substructure.label; }
  else if (atom.namedFragment) result.NodeType = atom.namedFragment.type;
  else if (atom.multiAttachment) result.NodeType = 'MultiAttachment';
  else if (atom.attachment) result.NodeType = 'ExternalConnectionPoint';
  else if (atom.query) {
    const q = atom.query;
    result.NodeType = q.kind === 'elements' ? 'ElementList' : q.kind === 'generic' ? 'GenericNickname' : 'Unspecified';
    if (q.kind === 'elements') result.ElementList = `${q.exclude ? 'NOT ' : ''}${q.elements.map(atomicNumber).join(' ')}`;
    if (q.kind === 'generic') result.GenericNickname = q.label;
  } else result.Element = String(atomicNumber(atom.element));
  if (atom.sourceNumber !== undefined) result.AtomID = String(atom.sourceNumber);
  if (atom.attachmentIndex !== undefined) result.ExternalConnectionNum = String(atom.attachmentIndex);
  if (atom.residueId !== undefined) result.ResidueID = String(atom.residueId);
  if (atom.connectionType !== undefined) result.ExternalConnectionType = atom.connectionType;
  if (atom.cipLabel !== undefined) result.AS = atom.cipLabel;
  if (atom.spatial) result.xyz = atom.spatial.join(' ');
  if (atom.enhancedStereo) { result.EnhancedStereoType = atom.enhancedStereo.type; if (atom.enhancedStereo.group !== undefined) result.EnhancedStereoGroupNum = String(atom.enhancedStereo.group); }
  return result;
}
export function atomCdxProperties(atom: Atom): Map<number, Uint8Array> {
  const uint = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
  const meta = queryConstraintCdxProperties(atom.queryConstraints);
  const uint32 = (n: number) => { if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) fail('来源编号超出 CDX 无符号整数范围', 'FORMAT_LIMIT'); const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, n, true); return data; };
  if (atom.sourceNumber !== undefined) meta.set(0x044d, uint32(atom.sourceNumber));
  if (atom.attachmentIndex !== undefined) meta.set(0x044b, uint32(atom.attachmentIndex));
  if (atom.cipLabel) { const code = ['U', 'N', 'R', 'S', 'r', 's', 'u'].indexOf(atom.cipLabel); if (code < 0) fail('此 CIP 标签的 CDX 枚举尚未实现', 'FORMAT_LIMIT'); meta.set(0x0437, new Uint8Array([code])); }
  if (atom.connectionType) { const code = connectionTypes.indexOf(atom.connectionType); if (code > 4) fail('此生物连接类型的 CDX 枚举尚未实现', 'FORMAT_LIMIT'); meta.set(0x0440, new Uint8Array([code])); }
  if (atom.attachment) return new Map([[0x0400, uint(12)], ...meta]);
  const q = atom.query;
  if (!q) return new Map([[0x0402, uint(atomicNumber(atom.element))], ...meta]);
  const result = new Map([[0x0400, uint(q.kind === 'elements' ? 2 : q.kind === 'generic' ? 7 : 0)], ...meta]);
  if (q.kind === 'elements') {
    const values = [uint(q.exclude ? -q.elements.length : q.elements.length), ...q.elements.map(e => uint(atomicNumber(e)))];
    const data = new Uint8Array(values.length * 2); values.forEach((v, i) => data.set(v, i * 2)); result.set(0x0403, data);
  } else if (q.kind === 'generic') {
    if (/[^\x20-\x7e]/.test(q.label)) fail('此 CDX 查询名称需要尚未实现的字符集映射，请保存 CDXML 或 JSON', 'FORMAT_LIMIT');
    const data = new Uint8Array(q.label.length + 2); data.set(new TextEncoder().encode(q.label), 2); result.set(0x0433, data);
  }
  return result;
}
export function bondXmlProperties(bond: Bond): Record<string, string> {
  return { ...(bond.topology!==undefined?{Topology:bond.topology}:{}), ...(bond.cipLabel ? { BS: bond.cipLabel } : {}), ...(bond.reactionParticipation ? { RxnParticipation: bond.reactionParticipation } : {}), ...(bond.sequenceConnectivity ? { Connectivity: bond.sequenceConnectivity } : {}),
    ...(bond.externalNumbers?.[0] !== undefined && bond.externalNumbers[0] !== null ? { BeginExternalNum: String(bond.externalNumbers[0]) } : {}),
    ...(bond.externalNumbers?.[1] !== undefined && bond.externalNumbers[1] !== null ? { EndExternalNum: String(bond.externalNumbers[1]) } : {}) };
}
