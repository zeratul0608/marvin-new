import { clone, fingerprint, validateDocument } from '../core/model';
import type { ChemicalDocument, Diagnostic, ExportResult, Format, FormatCapability, ImportResult } from '../core/types';
import { readMol, writeMol } from './mol';
import { fail, FormatError } from './shared';
import { readCdxml, readMrv, writeCdxml, writeMrv } from './xml';
export { FormatError } from './shared';
export const formats: FormatCapability[] = [
  { format: 'json', name: 'Molecule JSON', extension: '.molecule.json', description: '原生文档 · 保存稳定 ID、结构与布局' },
  { format: 'cdxml', name: 'ChemDraw XML', extension: '.cdxml', description: 'ChemDraw · 普通分子与二维键描绘' },
  { format: 'mrv', name: 'Marvin Document', extension: '.mrv', description: 'Marvin JS · 普通分子与二维键描绘' },
  { format: 'mol', name: 'MOL V2000', extension: '.mol', description: '通用交换 · 单结构，最多 999 个原子／键' },
  { format: 'mol-v3000', name: 'MOL V3000', extension: '.mol', description: '通用交换 · 支持更大结构与原子映射' },
];
export function detectFormat(data: string): Format {
  if (/^\s*\{/.test(data)) return 'json';
  if (/<CDXML[\s>]/i.test(data)) return 'cdxml';
  if (/<(?:\w+:)?(?:cml|MDocument|molecule)[\s>]/.test(data)) return 'mrv';
  if (/V3000/.test(data)) return 'mol-v3000';
  if (/V2000/.test(data)) return 'mol';
  fail('未识别格式。首版支持 JSON、CDXML、MRV 和 MOL V2000/V3000；CDX 二进制与 SMILES 尚未接入。', 'UNKNOWN_FORMAT');
}
export function importDocument(input: { data: string; format?: Format; name?: string }): ImportResult {
  if (typeof input.data !== 'string' || !input.data.trim()) fail('请输入或选择一个结构文件');
  if (input.data.length > 2_000_000) fail('首版文件大小上限为 2 MB', 'SIZE_LIMIT');
  const format = input.format ?? detectFormat(input.data);
  try {
    if (format === 'json') {
      const document = JSON.parse(input.data) as ChemicalDocument;
      validateDocument(document);
      if (Object.keys(document.graph.atoms).length > 2000 || Object.keys(document.graph.bonds).length > 2000) fail('首版文档最多支持 2000 个原子／键', 'SIZE_LIMIT');
      return { document: clone(document), issues: document.source?.issues ?? [] };
    }
    if (format === 'mol' || format === 'mol-v3000') return readMol(input.data, input.name);
    if (format === 'cdxml') return readCdxml(input.data, input.name);
    if (format === 'mrv') return readMrv(input.data, input.name);
    return fail('未支持的格式');
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError(`导入失败：${(error as Error).message}`);
  }
}
export function exportDocument(document: ChemicalDocument, input: { format: Format; allowLossy?: boolean }): ExportResult {
  const doc = clone(document); validateDocument(doc);
  const issues: Diagnostic[] = [];
  if (!formats.some(f => f.format === input.format)) fail('未支持的导出格式');
  if (input.format === 'json') return { data: JSON.stringify(doc, null, 2), format: 'json', issues, passthrough: false };
  if (doc.source?.format === input.format && doc.source.fingerprint === fingerprint(doc)) return { data: doc.source.raw, format: input.format, issues: doc.source.issues, passthrough: true };
  if (doc.source?.issues.some(i => i.severity !== 'info')) {
    issues.push({ code: 'SOURCE_DATA_LOSS', severity: 'warning', message: '源文件包含未解释的信息。转换格式或编辑后重建文件，将无法保留这部分内容。原生 JSON 可完整保留源文件记录。' });
  }
  if (input.format === 'cdxml' && Object.values(doc.graph.atoms).some(a => a.atomMap !== undefined)) issues.push({ code: 'ATOM_MAP_LOSS', severity: 'warning', message: 'CDXML 适配器尚未写入原子映射编号；请使用 MRV 或 MOL 保存。' });
  if (issues.length && !input.allowLossy) throw new FormatError('导出已阻止：请查看兼容报告，或明确允许有损导出。', 'LOSSY_EXPORT_BLOCKED', [{ severity: 'error', code: 'LOSSY_EXPORT_BLOCKED', message: '为避免静默丢失信息，默认阻止此次导出。' }, ...issues]);
  let data: string;
  if (input.format === 'cdxml') data = writeCdxml(doc);
  else if (input.format === 'mrv') data = writeMrv(doc);
  else data = writeMol(doc, input.format);
  return { data, format: input.format, issues, passthrough: false };
}
