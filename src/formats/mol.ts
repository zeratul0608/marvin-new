import type { Atom, BondOrder, ChemicalDocument, Diagnostic, Format, ImportResult } from '../core/types';
import { GraphReader, boundCount, fail, finish, integer, numeric } from './shared';

const masses: Record<string, number> = { H: 1, B: 11, C: 12, N: 14, O: 16, F: 19, Si: 28, P: 31, S: 32, Cl: 35, Br: 79, I: 127 };
export function readMol(raw: string, name?: string): ImportResult {
  if (raw.includes('$$$$')) fail('当前导入入口接受单个 MOL 结构；SDF 批量记录尚未实现', 'UNSUPPORTED_SDF');
  const lines = raw.replaceAll('\r', '').split('\n');
  if (lines.length < 5) fail('MOL 文件不完整');
  if (lines[3].includes('V3000')) return readV3000(raw, lines, name);
  if (!lines[3].includes('V2000')) fail('需要有效的 MOL V2000 或 V3000 文件');
  const n = integer(lines[3].slice(0, 3)), m = integer(lines[3].slice(3, 6)); boundCount(n); boundCount(m);
  if (integer(lines[3].slice(12, 15), 0) !== 0) fail('当前版本尚未解释分子级绝对手性标志', 'UNSUPPORTED_STEREO');
  if (lines.length < 4 + n + m || !lines.some(l => l.trim() === 'M  END')) fail('MOL 记录被截断');
  const reader = new GraphReader(lines[0]);
  for (let i = 0; i < n; i++) {
    const line = lines[4 + i];
    const element = line.slice(31, 34).trim(), massDiff = integer(line.slice(34, 36), 0), chargeCode = integer(line.slice(36, 39), 0);
    if (numeric(line.slice(20, 30)) !== 0) fail('首版只支持二维 MOL 坐标，三维结构尚未实现', 'UNSUPPORTED_3D');
    if (integer(line.slice(39, 42), 0) !== 0) fail('原子 parity 立体编码尚未实现；请使用二维楔线键', 'UNSUPPORTED_STEREO');
    if (chargeCode === 4 || chargeCode < 0 || chargeCode > 7) fail('当前版本尚未支持此自由基／电荷编码', 'UNSUPPORTED_RADICAL');
    if (integer(line.slice(45, 48), 0) || integer(line.slice(48, 51), 0) || integer(line.slice(51, 54), 0)) fail('当前版本尚未支持原子查询或显式价态约束', 'UNSUPPORTED_QUERY');
    const hCode = integer(line.slice(42, 45), 0), map = integer(line.slice(60, 63), 0);
    if (hCode < 0 || hCode > 5) fail('无效的 MOL 氢数编码');
    if (massDiff && !masses[element]) fail('此元素的相对同位素编码尚未实现', 'UNSUPPORTED_ISOTOPE');
    const props: Partial<Atom> = { charge: chargeCode ? 4 - chargeCode : 0 };
    if (massDiff) props.isotope = masses[element] + massDiff;
    if (map) props.atomMap = map;
    if (hCode) props.hydrogens = { mode: 'fixed', count: hCode - 1 };
    reader.atom(String(i + 1), element, numeric(line.slice(0, 10)), numeric(line.slice(10, 20)), props);
  }
  for (let i = 0; i < m; i++) {
    const line = lines[4 + n + i], order = integer(line.slice(6, 9)), stereo = integer(line.slice(9, 12), 0);
    if (![1, 2, 3, 4].includes(order)) fail('查询键类型尚未实现', 'UNSUPPORTED_QUERY');
    if (![0, 1, 4, 6].includes(stereo)) fail('此键立体编码尚未实现', 'UNSUPPORTED_STEREO');
    if (integer(line.slice(15, 18), 0) || integer(line.slice(18, 21), 0)) fail('键的拓扑／反应中心查询尚未实现', 'UNSUPPORTED_QUERY');
    reader.bond(String(integer(line.slice(0, 3))), String(integer(line.slice(3, 6))), order === 4 ? 'aromatic' : order as BondOrder, stereo === 1 ? 'wedge' : stereo === 6 ? 'hashed' : stereo === 4 ? 'wavy' : undefined);
  }
  const issues: Diagnostic[] = [];
  let ended = false;
  let hasChargeRecord = false;
  let hasIsotopeRecord = false;
  for (const line of lines.slice(4 + n + m)) {
    if (line.trim() === 'M  END') { ended = true; continue; }
    if (!line.trim()) continue;
    if (ended) fail('MOL 结束标记后还有未支持的数据段', 'UNSUPPORTED_MOL_DATA');
    if (/^M  (CHG|ISO)\s/.test(line)) {
      const tokens = line.trim().split(/\s+/), count = integer(tokens[2]);
      if (tokens.length !== 3 + count * 2) fail('MOL 属性记录长度无效');
      if (tokens[1] === 'CHG' && !hasChargeRecord) { for (const atom of Object.values(reader.document.graph.atoms)) atom.charge = 0; hasChargeRecord = true; }
      if (tokens[1] === 'ISO' && !hasIsotopeRecord) { for (const atom of Object.values(reader.document.graph.atoms)) delete atom.isotope; hasIsotopeRecord = true; }
      for (let i = 0; i < count; i++) {
        const ref = reader.refs.get(String(integer(tokens[3 + 2 * i]))); if (!ref) fail('MOL 属性引用无效');
        const atom = reader.document.graph.atoms[ref], value = integer(tokens[4 + 2 * i]);
        if (tokens[1] === 'CHG') atom.charge = value; else atom.isotope = value;
      }
    } else fail(`尚未支持的 MOL 属性：${line.slice(0, 12).trim()}`, 'UNSUPPORTED_MOL_PROPERTY');
  }
  return finish(reader.document, raw, 'mol', issues, name);
}
function readV3000(raw: string, lines: string[], name?: string): ImportResult {
  const records: string[] = [];
  for (let i = 4; i < lines.length; i++) {
    if (!lines[i].startsWith('M  V30 ')) continue;
    let content = lines[i].slice(7);
    while (content.endsWith('-')) {
      content = content.slice(0, -1); i++;
      if (!lines[i]?.startsWith('M  V30 ')) fail('V3000 续行无效');
      content += lines[i].slice(7);
    }
    records.push(content.trim());
  }
  const countRecord = records.find(l => l.startsWith('COUNTS '))?.split(/\s+/);
  if (!countRecord || !records.includes('END CTAB') || !lines.some(l => l.trim() === 'M  END')) fail('V3000 CTAB 不完整');
  const n = integer(countRecord[1]), m = integer(countRecord[2]); boundCount(n); boundCount(m);
  if (countRecord.slice(3).some(x => integer(x) !== 0)) fail('V3000 查询或分子手性属性尚未实现', 'UNSUPPORTED_QUERY');
  const reader = new GraphReader(lines[0]);
  let section = '';
  for (const record of records) {
    if (record.startsWith('BEGIN ')) { section = record.slice(6); if (!['CTAB', 'ATOM', 'BOND'].includes(section)) fail(`尚未支持 V3000 ${section}`, 'UNSUPPORTED_MOL_PROPERTY'); continue; }
    if (record.startsWith('END ')) { section = ''; continue; }
    if (record.startsWith('COUNTS ')) continue;
    const t = record.split(/\s+/);
    if (section === 'ATOM') {
      if (t.length < 6) fail('V3000 原子记录不完整');
      if (numeric(t[4]) !== 0) fail('当前版本只支持二维结构', 'UNSUPPORTED_3D');
      const props: Partial<Atom> = {};
      if (integer(t[5])) props.atomMap = integer(t[5]);
      for (const prop of t.slice(6)) {
        const [key, value] = prop.split('=');
        if (key === 'CHG') props.charge = integer(value);
        else if (key === 'MASS') props.isotope = integer(value);
        else if (key === 'HCOUNT') props.hydrogens = { mode: 'fixed', count: integer(value) === -1 ? 0 : integer(value) };
        else fail(`尚未支持的 V3000 原子属性：${key}`, 'UNSUPPORTED_MOL_PROPERTY');
      }
      reader.atom(t[0], t[1], numeric(t[2]), numeric(t[3]), props);
    } else if (section === 'BOND') {
      const order = integer(t[1]);
      if (![1, 2, 3, 4].includes(order)) fail('此 V3000 键类型尚未实现', 'UNSUPPORTED_QUERY');
      let style: 'wedge' | 'hashed' | 'wavy' | undefined;
      for (const prop of t.slice(4)) {
        if (!/^CFG=[123]$/.test(prop)) fail(`尚未支持的 V3000 键属性：${prop}`, 'UNSUPPORTED_MOL_PROPERTY');
        style = prop === 'CFG=1' ? 'wedge' : prop === 'CFG=3' ? 'hashed' : 'wavy';
      }
      reader.bond(t[2], t[3], order === 4 ? 'aromatic' : order as BondOrder, style);
    } else fail(`未识别的 V3000 记录：${record.slice(0, 40)}`);
  }
  if (Object.keys(reader.document.graph.atoms).length !== n || Object.keys(reader.document.graph.bonds).length !== m) fail('V3000 计数与记录不一致');
  return finish(reader.document, raw, 'mol-v3000', [], name);
}
export function writeMol(doc: ChemicalDocument, format: Format): string {
  const atoms = Object.values(doc.graph.atoms), bonds = Object.values(doc.graph.bonds);
  const indices = new Map(atoms.map((a, i) => [a.id, i + 1]));
  const title = doc.title.replace(/[\r\n]/g, ' ');
  const out = [title, '  Molecule  2D', ''];
  if (format === 'mol-v3000') {
    out.push('  0  0  0     0  0            999 V3000', 'M  V30 BEGIN CTAB', `M  V30 COUNTS ${atoms.length} ${bonds.length} 0 0 0`, 'M  V30 BEGIN ATOM');
    atoms.forEach((a, i) => {
      const p = doc.depiction.positions[a.id];
      out.push(`M  V30 ${i + 1} ${a.element} ${p.x.toFixed(6)} ${p.y.toFixed(6)} 0 ${a.atomMap ?? 0}${a.charge ? ` CHG=${a.charge}` : ''}${a.isotope ? ` MASS=${a.isotope}` : ''}${a.hydrogens.mode === 'fixed' ? ` HCOUNT=${a.hydrogens.count || -1}` : ''}`);
    });
    out.push('M  V30 END ATOM', 'M  V30 BEGIN BOND');
    bonds.forEach((b, i) => {
      let [a, c] = b.atoms;
      const d = doc.depiction.bonds[b.id];
      if (d && d.from === c) [a, c] = [c, a];
      const cfg = d?.style === 'wedge' ? 1 : d?.style === 'hashed' ? 3 : d?.style === 'wavy' ? 2 : 0;
      out.push(`M  V30 ${i + 1} ${b.order === 'aromatic' ? 4 : b.order} ${indices.get(a)} ${indices.get(c)}${cfg ? ` CFG=${cfg}` : ''}`);
    });
    out.push('M  V30 END BOND', 'M  V30 END CTAB', 'M  END'); return out.join('\n');
  }
  if (atoms.length > 999 || bonds.length > 999) fail('V2000 最多支持 999 个原子／键，请选择 V3000', 'FORMAT_LIMIT');
  const pad = (n: number) => String(n).padStart(3);
  out.push(`${pad(atoms.length)}${pad(bonds.length)}  0  0  0  0            999 V2000`);
  for (const a of atoms) {
    const p = doc.depiction.positions[a.id];
    if (Math.abs(p.x) >= 10000 || Math.abs(p.y) >= 10000 || (a.atomMap ?? 0) > 999 || (a.hydrogens.mode === 'fixed' && a.hydrogens.count > 4)) fail('此坐标、映射编号或指定氢数超出 V2000 支持范围，请选择 V3000', 'FORMAT_LIMIT');
    if (p.x.toFixed(4).length > 10 || p.y.toFixed(4).length > 10 || String(a.charge).length > 3 || String(a.isotope ?? 0).length > 3) fail('属性数值超出 V2000 字段宽度，请选择 V3000', 'FORMAT_LIMIT');
    const fields = Array(69).fill(' ');
    const put = (start: number, str: string) => [...str].forEach((c, i) => { fields[start + i] = c; });
    put(0, p.x.toFixed(4).padStart(10)); put(10, p.y.toFixed(4).padStart(10)); put(20, '0.0000'.padStart(10));
    put(31, a.element.padEnd(3)); put(34, ' 0');
    for (const pos of [36,39,42,45,48,51,54,57,60,63,66]) put(pos, '  0');
    if (a.hydrogens.mode === 'fixed') put(42, pad(a.hydrogens.count + 1));
    if (a.atomMap) put(60, pad(a.atomMap));
    out.push(fields.join(''));
  }
  for (const b of bonds) {
    let [a, c] = b.atoms;
    const d = doc.depiction.bonds[b.id]; if (d?.from === c) [a, c] = [c, a];
    const stereo = d?.style === 'wedge' ? 1 : d?.style === 'hashed' ? 6 : d?.style === 'wavy' ? 4 : 0;
    out.push(`${pad(indices.get(a)!)}${pad(indices.get(c)!)}${pad(b.order === 'aromatic' ? 4 : b.order)}${pad(stereo)}  0  0  0`);
  }
  for (const [key, list] of [['CHG', atoms.filter(a => a.charge !== 0)], ['ISO', atoms.filter(a => a.isotope !== undefined)]] as const) {
    for (let i = 0; i < list.length; i += 8) {
      const group = list.slice(i, i + 8);
      out.push(`M  ${key}${pad(group.length)}${group.map(a => ` ${pad(indices.get(a.id)!)} ${pad(key === 'CHG' ? a.charge : a.isotope!)}`).join('')}`);
    }
  }
  out.push('M  END'); return out.join('\n');
}
