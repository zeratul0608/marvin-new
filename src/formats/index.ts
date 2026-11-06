import { clone, fingerprint, validateDocument } from '../core/model';
import type { ChemicalDocument, Diagnostic, ExportResult, Format, FormatCapability, ImportData, ImportFormat, ImportInput, ImportResult } from '../core/types';
import { readMol, writeMol } from './mol';
import { fail, FormatError } from './shared';
import { readCdxml, readMrv, writeCdxml, writeMrv } from './xml';
import { CDX_BASE64_PREFIX, decodeCdx, isCdx, readCdx } from './cdx';
import { convertCdxDocumentToCdxml, exportSourceFile } from './preservation';
import { writeCdx } from './cdx-write';
import {readRxn,writeRxn,rxnExportIssues} from './rxn';
export { exportOriginalSource, exportSourceFile } from './preservation';
export { FormatError } from './shared';
export const formats: FormatCapability[] = [
  { format: 'json', name: 'Molecule JSON', extension: '.molecule.json', description: '原生文档 · 保存稳定 ID、结构与布局' },
  { format: 'cdxml', name: 'ChemDraw XML', extension: '.cdxml', description: 'ChemDraw · 普通分子与二维键描绘' },
  { format: 'cdx', name: 'ChemDraw 二进制', extension: '.cdx', description: 'ChemDraw · 二维结构、自由基与键描绘；优先保留来源 CDX' },
  { format: 'mrv', name: 'Marvin Document', extension: '.mrv', description: 'Marvin JS · 普通分子与二维键描绘' },
  { format: 'mol', name: 'MOL V2000', extension: '.mol', description: '通用交换 · 单结构，最多 999 个原子／键' },
  { format: 'mol-v3000', name: 'MOL V3000', extension: '.mol', description: '通用交换 · 支持更大结构与原子映射' },
  { format: 'rxn', name: 'RXN V2000', extension: '.rxn', description: '单步反应 · 反应物、产物、试剂和原子映射' },
  { format: 'rxn-v3000', name: 'RXN V3000', extension: '.rxn', description: '单步反应 · V3000 分子与明确角色' },
];
function asBytes(data: ImportData): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data !== 'string') fail('结构数据必须是文本、Uint8Array 或 ArrayBuffer', 'INVALID_INPUT');
}
function asText(data: ImportData): string {
  const bytes = asBytes(data);
  if (!bytes) return data as string;
  if (bytes.length > 80_000_000) fail('文件大小超过 80 MB 原生文档限额', 'SIZE_LIMIT');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('二进制文件不是有效 CDX，文本格式需使用 UTF-8', 'UNKNOWN_FORMAT'); }
}
export function detectFormat(input: ImportData): ImportFormat {
  const bytes = asBytes(input);
  if (bytes && isCdx(bytes)) return 'cdx';
  const data = asText(input);
  if (data.startsWith(CDX_BASE64_PREFIX)) return 'cdx';
  if(/^\s*\$RXN V3000\s*(?:\r?\n|$)/.test(data))return 'rxn-v3000';
  if(/^\s*\$RXN(?: V2000)?\s*(?:\r?\n|$)/.test(data))return 'rxn';
  if (/^\s*\{/.test(data)) return 'json';
  if (/<(?:\w+:)?CDXML[\s>]/i.test(data)) return 'cdxml';
  if (/<(?:\w+:)?(?:cml|MDocument|molecule)[\s>]/.test(data)) return 'mrv';
  if (/V3000/.test(data)) return 'mol-v3000';
  if (/V2000/.test(data)) return 'mol';
  fail('未识别格式。支持 CDX 二进制、JSON、CDXML、MRV、MOL 和 RXN V2000/V3000；SMILES 请使用结构计算面板。', 'UNKNOWN_FORMAT');
}
export function importDocument(input: ImportInput): ImportResult {
  try {
    const bytes = asBytes(input.data);
    if (bytes && bytes.length > 80_000_000) fail('文件大小超过 80 MB 原生文档限额', 'SIZE_LIMIT');
    const format = input.format ?? detectFormat(input.data);
    if (format === 'cdx') return readCdx(bytes ?? decodeCdx(input.data as string), input.name);
    const data = asText(input.data);
    if (!data.trim()) fail('请输入或选择一个结构文件');
    if (data.length > (format === 'json' ? 80_000_000 : 20_000_000)) fail('文件大小超过文本结构 20 MB／原生 JSON 80 MB 限额', 'SIZE_LIMIT');
    if (format === 'json') {
      const document = JSON.parse(data) as ChemicalDocument;
      validateDocument(document);
      if (Object.keys(document.graph.atoms).length > 2000 || Object.keys(document.graph.bonds).length > 2000) fail('首版文档最多支持 2000 个原子／键', 'SIZE_LIMIT');
      return { document: clone(document), issues: document.source?.issues ?? [] };
    }
    if (format === 'mol' || format === 'mol-v3000') return readMol(data, input.name);
    if(format==='rxn'||format==='rxn-v3000')return readRxn(data,input.name);
    if (format === 'cdxml') return readCdxml(data, input.name);
    if (format === 'mrv') return readMrv(data, input.name);
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
  if(input.format==='rxn'||input.format==='rxn-v3000'){
    issues.push(...rxnExportIssues(doc,input.format));if(doc.source?.issues.some(i=>i.severity!=='info'))issues.push({severity:'warning',code:'SOURCE_DATA_LOSS',message:'来源文件含未解释信息，RXN 重建无法保留这些信息；原生 JSON 可保留。'});
    if(issues.length&&!input.allowLossy)throw new FormatError('RXN 导出已阻止：请查看兼容报告并明确允许已报告的表示损失。','LOSSY_EXPORT_BLOCKED',issues);
    return {data:writeRxn(doc,input.format),format:input.format,issues,passthrough:false,preservation:'rebuilt'};
  }
  if (['mol', 'mol-v3000', 'mrv'].includes(input.format) && Object.values(doc.graph.atoms).some(a => a.attachment)) fail('此适配器尚未写入模板外部连接点；请使用 CDX、CDXML 或 JSON 保存', 'UNSUPPORTED_ATTACHMENT');
  if (['mol', 'mol-v3000', 'mrv'].includes(input.format) && (Object.values(doc.graph.atoms).some(a => a.query||a.queryConstraints) || Object.values(doc.graph.bonds).some(b => b.topology!==undefined||b.order === 'any' || b.order === 2.5))) fail('此适配器尚未写入查询条件或 2.5 键；请使用 CDXML、CDX 或 JSON 保存', 'UNSUPPORTED_QUERY');
  if (['mol', 'mol-v3000', 'mrv', 'cdx'].includes(input.format) && Object.values(doc.graph.atoms).some(a => a.substructure)) fail('此格式适配器尚未写入嵌套化学片段；请保存 CDXML 或 JSON', 'UNSUPPORTED_GROUP');
  if (input.format === 'cdx' && (Object.values(doc.graph.atoms).some(a => a.residueId !== undefined) || Object.values(doc.graph.bonds).some(b => b.sequenceConnectivity || b.externalNumbers))) fail('生物序列的 CDX 字段映射尚未实现；请保存 CDXML 或 JSON', 'UNSUPPORTED_PROPERTY');
  if (['mol', 'mol-v3000', 'mrv'].includes(input.format) && Object.values(doc.graph.bonds).some(b => b.reactionParticipation || b.sequenceConnectivity || b.externalNumbers)) fail('此适配器尚未写入反应键条件或生物序列元数据；请保存 CDXML 或 JSON', 'UNSUPPORTED_PROPERTY');
  if (input.format === 'cdx' && doc.source?.format === 'cdx') {
    try { return { ...exportSourceFile(doc), format: 'cdx' }; }
    catch (error) { if (!(error instanceof FormatError)) throw error; issues.push({ severity: 'warning', code: 'DOCUMENT_PRESERVATION_UNAVAILABLE', message: error.message }); }
  }
  if (input.format === 'cdxml' && (doc.source?.format === 'cdxml' || doc.source?.format === 'cdx')) {
    try {
      const result = doc.source.format === 'cdxml' ? exportSourceFile(doc) : { data: convertCdxDocumentToCdxml(doc), preservation: 'converted' as const };
      return { data: result.data, format: 'cdxml', issues: [], passthrough: false, preservation: result.preservation };
    } catch (error) {
      if (!(error instanceof FormatError)) throw error;
      issues.push({ severity: 'warning', code: 'DOCUMENT_PRESERVATION_UNAVAILABLE', message: error.message });
    }
  }
  if (doc.source?.issues.some(i => i.severity !== 'info')) {
    issues.push({ code: 'SOURCE_DATA_LOSS', severity: 'warning', message: '源文件包含未解释的信息。转换格式或编辑后重建文件，将无法保留这部分内容。原生 JSON 可完整保留源文件记录。' });
  }
  if (input.format !== 'cdxml' && (Object.keys(doc.depiction.objects ?? {}).length || Object.keys(doc.graph.reactions ?? {}).length)) issues.push({severity:'warning',code:'DOCUMENT_OBJECT_LOSS',message:'此格式的重建适配器尚未写入文档图元与反应步骤；原生 JSON、来源格式保留保存可保留。'});
  if (input.format === 'cdxml' && Object.values(doc.depiction.objects ?? {}).some(o => Object.keys(o.attributes).some(key => key.startsWith('CDXProperty')))) fail('部分原生 CDX 图元字段尚无 CDXML 映射；请保存来源 CDX 或 JSON', 'UNSUPPORTED_DOCUMENT');
  if (['mol','mol-v3000','mrv','cdx'].includes(input.format) && Object.values(doc.graph.atoms).some(a => a.multiAttachment || a.namedFragment || a.spatial || a.enhancedStereo)) fail('此格式的重建适配器尚未写入多中心连接、命名片段、三维坐标或增强立体组；请使用 CDXML 或 JSON', 'UNSUPPORTED_PROPERTY');
  if (['cdx', 'cdxml'].includes(input.format) && Object.values(doc.graph.atoms).some(a => a.atomMap !== undefined)) issues.push({ code: 'ATOM_MAP_LOSS', severity: 'warning', message: 'CDX/CDXML 适配器尚未写入原子映射编号；请使用 MRV 或 MOL 保存。' });
  if (['mol', 'mol-v3000', 'mrv'].includes(input.format) && (Object.values(doc.graph.atoms).some(a => a.geometry) || Object.values(doc.graph.bonds).some(b => b.circularOrdering))) issues.push({ code: 'STEREO_ORDERING_LOSS', severity: 'warning', message: '此适配器尚未写入显式四面体几何和双键连接顺序；楔键与二维坐标仍会写入。请使用 CDX、CDXML 或 JSON 完整保存。' });
  if (['mol', 'mol-v3000', 'mrv'].includes(input.format) && (Object.values(doc.graph.atoms).some(a => a.cipLabel) || Object.values(doc.graph.bonds).some(b => b.cipLabel))) issues.push({ code: 'CIP_CACHE_LOSS', severity: 'warning', message: '此适配器不写入来源 CIP 标签缓存，也不重新计算 CIP；二维楔键仍会写入。CDX、CDXML 或 JSON 可保留标签。' });
  if (['mol', 'mol-v3000', 'mrv'].includes(input.format) && Object.values(doc.depiction.bonds).some(d => d.doublePosition || ['dashed', 'bold', 'hash'].includes(d.style))) issues.push({ code: 'BOND_DISPLAY_LOSS', severity: 'warning', message: '此格式适配器尚未写入双键偏侧、虚线、粗线或等宽哈线描绘；CDX、CDXML 或 JSON 可保留。' });
  if (issues.length && !input.allowLossy) throw new FormatError('导出已阻止：请查看兼容报告，或明确允许有损导出。', 'LOSSY_EXPORT_BLOCKED', [{ severity: 'error', code: 'LOSSY_EXPORT_BLOCKED', message: '为避免静默丢失信息，默认阻止此次导出。' }, ...issues]);
  let data: string;
  if (input.format === 'cdx') data = writeCdx(doc);
  else if (input.format === 'cdxml') data = writeCdxml(doc);
  else if (input.format === 'mrv') data = writeMrv(doc);
  else data = writeMol(doc, input.format);
  return { data, format: input.format, issues, passthrough: false, preservation: 'rebuilt' };
}
