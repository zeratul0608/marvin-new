import { ELEMENTS } from '../core/model';
import { layoutActions } from '../core/layout';
import { atomCipLabels, connectionTypes, reactionParticipations } from '../core/chemistry-annotations';
import { atomReactionStereos, atomRingBondCounts, atomUnsaturatedBonds, bondTopologies } from '../core/query';
import { bracketUsages, polymerFlipTypes, polymerRepeatPatterns } from '../core/polymers';
import { geometryStride, reactionRoles } from '../core/drawing';
import type { AiToolDefinition } from './types';

type Schema = Record<string, unknown>;
const object = (properties: Record<string, Schema>, required: string[] = [], minProperties = 0): Schema => ({ type: 'object', properties, required, additionalProperties: false, ...(minProperties ? { minProperties } : {}) });
const text: Schema = { type: 'string', minLength: 1, maxLength: 256 };
const label: Schema = { type: 'string', minLength: 1, maxLength: 500 };
const integer: Schema = { type: 'integer' };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const positiveInteger: Schema = { type: 'integer', minimum: 1 };
const revision: Schema = { type: 'integer', minimum: 0 };
const atomIds: Schema = { type: 'array', items: text, maxItems: 2000, uniqueItems: true };
const chemistryAtomIds: Schema = { ...atomIds, maxItems: 1000 };
const position = object({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']);
const bondOrder: Schema = { enum: [1, 2, 2.5, 3, 'aromatic', 'any'] };
const topology: Schema = { enum: bondTopologies };
const depiction = object({ style: { enum: ['plain', 'wedge', 'hashed', 'wavy', 'dashed', 'bold', 'hash'] }, from: text, doublePosition: { enum: ['center', 'left', 'right'] }, secondaryStyle: { enum: ['plain', 'dashed'] } }, ['style', 'from']);
const hydrogens: Schema = { anyOf: [object({ mode: { const: 'auto' } }, ['mode']), object({ mode: { const: 'fixed' }, count: { type: 'integer', minimum: 0 } }, ['mode', 'count'])] };
const query: Schema = { anyOf: [
  object({ kind: { const: 'elements' }, elements: { type: 'array', minItems: 1, maxItems: ELEMENTS.length, uniqueItems: true, items: { enum: ELEMENTS } }, exclude: { type: 'boolean' } }, ['kind', 'elements']),
  object({ kind: { const: 'generic' }, label }, ['kind', 'label']),
  object({ kind: { const: 'any' }, label }, ['kind']),
] };
const queryConstraints = object({
  substituentsExactly: { type: 'integer', minimum: 0, maximum: 255 }, substituentsUpTo: { type: 'integer', minimum: 0, maximum: 255 },
  ringBondCount: { enum: atomRingBondCounts }, unsaturatedBonds: { enum: atomUnsaturatedBonds }, reactionChange: { const: true }, reactionStereo: { enum: atomReactionStereos },
}, [], 1);
const atomProperties = {
  charge: integer, isotope: nullable(positiveInteger), atomMap: nullable(positiveInteger), hydrogens, radical: { enum: [1, 2, 3, null] },
  query: nullable(query), queryConstraints: nullable(queryConstraints), sourceNumber: nullable(positiveInteger), attachmentIndex: nullable(positiveInteger),
  connectionType: nullable({ enum: connectionTypes }), residueId: nullable(positiveInteger), cipLabel: nullable({ enum: atomCipLabels }),
};
const enhancedStereo: Schema = { anyOf: [object({ type: { const: 'Absolute' } }, ['type']), object({ type: { enum: ['Or', 'And'] }, group: positiveInteger }, ['type', 'group'])] };
const ref: Schema = { ...text, pattern: '^\\$[A-Za-z][A-Za-z0-9_]*$' };
const bondOrdering: Schema = nullable({ type: 'array', minItems: 4, maxItems: 4, items: nullable(text) });
const stringMap: Schema = { type: 'object', maxProperties: 200, propertyNames: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[:A-Za-z_][\\w.:-]*$' }, additionalProperties: { type: 'string', maxLength: 4000 } };
const documentReference: Schema = { anyOf: [
  object({ kind: { enum: ['atom', 'bond', 'drawing'] }, id: text }, ['kind', 'id']),
  object({ kind: { const: 'molecule' }, atomIds, sourceId: text }, ['kind', 'atomIds']),
] };
const references: Schema = { type: 'array', items: documentReference, maxItems: 2000 };
const reactionChanges = object({ ...Object.fromEntries(reactionRoles.map(role => [role, references])), atomMappings: { type: 'array', maxItems: 2000, items: object({ mode: { enum: ['specified', 'manual', 'auto'] }, atoms: { type: 'array', maxItems: 2000, items: { type: 'array', minItems: 2, maxItems: 2, items: text } } }, ['mode', 'atoms']) } }, [], 1);
const operation = (type: string, properties: Record<string, Schema>, required: string[]) => object({ type: { const: type }, ...properties }, ['type', ...required]);

/** Every model operation is also validated by the editor's chemical transaction layer. */
export const AI_EDIT_OPERATION_SCHEMAS = [
  operation('add-atom', { ref, element: { enum: [...ELEMENTS, '*'] }, position, properties: object(atomProperties) }, ['element', 'position']),
  operation('update-atom', { atomId: text, changes: object({ element: { enum: [...ELEMENTS, '*'] }, ...atomProperties,
    enhancedStereo: nullable(enhancedStereo), namedFragment: nullable(object({ type: { enum: ['Fragment', 'Nickname'] }, label }, ['type', 'label'])),
    multiAttachment: nullable({ ...atomIds, minItems: 1 }), spatial: nullable({ type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } }),
  }, [], 1) }, ['atomId', 'changes']),
  operation('remove-atom', { atomId: text }, ['atomId']),
  operation('set-position', { atomId: text, position }, ['atomId', 'position']),
  operation('add-bond', { ref, atoms: { type: 'array', items: text, minItems: 2, maxItems: 2 }, order: bondOrder, topology, depiction }, ['atoms']),
  operation('update-bond', { bondId: text, order: bondOrder, topology: nullable(topology), depiction: nullable(depiction) }, ['bondId']),
  operation('remove-bond', { bondId: text }, ['bondId']),
  operation('set-atom-geometry', { atomId: text, bondOrdering }, ['atomId', 'bondOrdering']),
  operation('set-bond-ordering', { bondId: text, bondOrdering }, ['bondId', 'bondOrdering']),
  operation('invert-atom-stereo', { atomId: text }, ['atomId']),
  operation('invert-double-stereo', { bondId: text }, ['bondId']),
  operation('set-bond-annotations', { bondId: text, changes: object({ cipLabel: nullable({ enum: ['E', 'Z'] }), topology: nullable(topology), reactionParticipation: nullable({ enum: reactionParticipations }), sequenceConnectivity: nullable({ enum: ['Linear', 'Bridged', 'Staggered', 'Cyclic'] }), externalNumbers: nullable({ type: 'array', minItems: 2, maxItems: 2, items: nullable(positiveInteger) }) }, [], 1) }, ['bondId', 'changes']),
  operation('set-substructure-display', { atomId: text, expanded: { type: 'boolean' }, recursive: { type: 'boolean' } }, ['atomId', 'expanded']),
  operation('expand-substructure', { atomId: text, recursive: { type: 'boolean' } }, ['atomId']),
  operation('collapse-substructure', { atomIds: { ...atomIds, minItems: 1 }, label, ref }, ['atomIds', 'label']),
  operation('transform', { atomIds, transform: { enum: ['rotate-left', 'rotate-right', 'mirror-horizontal', 'mirror-vertical'] } }, ['atomIds', 'transform']),
  operation('layout', { atomIds, action: { enum: Object.keys(layoutActions) } }, ['atomIds', 'action']),
  operation('rename', { title: { type: 'string', maxLength: 500 } }, ['title']),
  operation('update-drawing', { objectId: text, changes: object({
    attributes: stringMap,
    geometry: object(Object.fromEntries(Object.keys(geometryStride).map(name => [name, { type: 'array', minItems: 1, maxItems: 4000, items: { type: 'number' } }]))),
    runs: { type: 'array', maxItems: 1000, items: object({ text: { type: 'string', maxLength: 20000 }, attributes: stringMap }, ['text', 'attributes']) },
  }, [], 1) }, ['objectId', 'changes']),
  operation('move-drawing', { objectId: text, delta: position }, ['objectId', 'delta']),
  operation('remove-drawing', { objectId: text }, ['objectId']),
  operation('update-reaction', { stepId: text, changes: reactionChanges }, ['stepId', 'changes']),
  operation('update-polymer', { objectId: text, changes: object({ usage: { enum: bracketUsages }, repeatPattern: nullable({ enum: polymerRepeatPatterns }), flipType: nullable({ enum: polymerFlipTypes }), repeatCount: nullable({ type: 'number', exclusiveMinimum: 0 }), componentOrder: nullable({ type: 'integer', minimum: 0, maximum: 32767 }), label: nullable({ type: 'string', maxLength: 256 }), atomIds: { ...atomIds, minItems: 1 } }, [], 1) }, ['objectId', 'changes']),
  operation('update-polymer-crossing', { objectId: text, bondId: text, innerAtomId: text }, ['objectId', 'bondId', 'innerAtomId']),
];

const operations: Schema = { type: 'array', minItems: 1, maxItems: 1000, items: { anyOf: AI_EDIT_OPERATION_SCHEMAS } };

export const AI_TOOLS: AiToolDefinition[] = [
  { name: 'read_structure', description: '读取完整文档、稳定ID、版本、选区；包括查询、内部片段、文档图元及反应。来源文件原文不发送。', parameters: object({}) },
  { name: 'read_selection', description: '读取当前原子、键或文档图元选区及版本。', parameters: object({}) },
  { name: 'select_atoms', description: '用真实ID选择原子、一条键或一个图元。选键时atomIds为空且提供bondId；选图元时atomIds为空且提供objectId；两者不能混用。空atomIds且无其它字段清空选区。', parameters: object({ atomIds, bondId: text, objectId: text }, ['atomIds']) },
  { name: 'apply_edits', description: '使用刚读取的expectedRevision提交整批化学或文档修改。支持普通绘图、查询约束、化学注释、片段展开/收起、图元、反应及聚合物；全部校验后原子化执行，失败整批不改。临时引用用$name。', parameters: object({ expectedRevision: revision, operations }, ['expectedRevision', 'operations']) },
  { name: 'check_structure', description: '读取现有诊断，包括查询、片段、价态和格式提示；不执行化学计算或认证。', parameters: object({}) },
  { name: 'analyze_molecule', description: '使用本地惰性加载的RDKit计算普通确定分子的SMILES、分子式、质量、LogP、tPSA、环数及常见立体标签；只读，不写入标签或修改文档。需要当前expectedRevision。atomIds=[]明确处理全文，非空必须是用户指定的完整分子，不能自动扩大选区。查询、内部片段、聚合物、轴或增强立体等不支持时保留原文档并报告，不得先删语义。', parameters: object({ expectedRevision: revision, atomIds: chemistryAtomIds }, ['expectedRevision', 'atomIds']) },
  { name: 'cleanup_molecule_2d', description: '用本地RDKit整理用户指定完整普通分子的二维布局，保持原子身份、化学连接和支持的异构构型，作为一个可撤销批次并遵从宿主预览。需要当前expectedRevision；atomIds=[]明确全文，非空不能切断键或自动扩展到其它原子。拒绝不支持的查询、内部片段、聚合物、轴或增强立体，不能为了清理而简化。', parameters: object({ expectedRevision: revision, atomIds: chemistryAtomIds }, ['expectedRevision', 'atomIds']) },
  { name: 'import_smiles', description: '仅当用户明确提供单条分子SMILES且要求导入/替换时，用本地RDKit生成二维结构并替换整份文档。需当前expectedRevision，受预览、只读权限和撤销保护。可用点分隔普通片段，不支持反应、多记录或名称转结构；不得从名称或猜测编造SMILES用于导入。', parameters: object({ expectedRevision: revision, smiles: { type: 'string', minLength: 1, maxLength: 50000, pattern: '^[^\\r\\n>]+$' }, title: { type: 'string', maxLength: 500 } }, ['expectedRevision', 'smiles']) },
  { name: 'load_template', description: '按用户要求用内置模板替换整份文档；需要当前expectedRevision。', parameters: object({ name: { enum: ['aspirin', 'caffeine', 'ethanol', 'benzene'] }, expectedRevision: revision }, ['name', 'expectedRevision']) },
  { name: 'import_structure', description: '仅导入用户明确提供的JSON、MOL、MRV、CDXML或RXN文本并替换当前文档，需当前expectedRevision；不能臆造名称转结构。', parameters: object({ data: { type: 'string', minLength: 1, maxLength: 250000 }, format: { enum: ['json', 'mol', 'mol-v3000', 'mrv', 'cdxml', 'rxn', 'rxn-v3000'] }, expectedRevision: revision }, ['data', 'expectedRevision']) },
  { name: 'undo_edit', description: '用户要求撤销时撤销历史一步，可能包含手动编辑；需要当前expectedRevision。', parameters: object({ expectedRevision: revision }, ['expectedRevision']) },
  { name: 'redo_edit', description: '用户要求重做时恢复历史一步；需要当前expectedRevision。', parameters: object({ expectedRevision: revision }, ['expectedRevision']) },
  { name: 'fit_canvas', description: '调整视图显示完整结构，不执行化学修改。', parameters: object({}) },
  { name: 'export_structure', description: '生成JSON、MOL、MRV、CDXML、RXN或SVG下载。禁止已知有损导出，模型只收到元信息，不收到全文；复杂内容优先JSON或兼容的CDXML。', parameters: object({ format: { enum: ['json', 'mol', 'mol-v3000', 'mrv', 'cdxml', 'rxn', 'rxn-v3000', 'svg'] } }, ['format']) },
];

/** Validates the exact public tool schema, including booleans, dictionary keys and bounds. */
export function validateAiArguments(value: unknown, schema: Schema, path = '参数'): void {
  if (schema.anyOf) {
    for (const option of schema.anyOf as Schema[]) { try { validateAiArguments(value, option, path); return; } catch { /* Try the next exact alternative. */ } }
    throw new Error(`${path}不符合允许的操作结构或包含未知字段`);
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) throw new Error(`${path}值无效`);
  if (schema.enum && !(schema.enum as readonly unknown[]).includes(value)) throw new Error(`${path}不在允许的枚举中`);
  if (schema.type === 'null' && value !== null) throw new Error(`${path}必须为 null`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path}必须为布尔值`);
  if (schema.type === 'string' && (typeof value !== 'string' || value.length < Number(schema.minLength ?? 0) || value.length > Number(schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(String(schema.pattern)).test(value))) throw new Error(`${path}字符串无效`);
  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value) || value < Number(schema.minimum ?? -Infinity) || value > Number(schema.maximum ?? Infinity) || schema.exclusiveMinimum !== undefined && value <= Number(schema.exclusiveMinimum)) throw new Error(`${path}数值无效`);
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < Number(schema.minItems ?? 0) || value.length > Number(schema.maxItems ?? Infinity) || schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) throw new Error(`${path}数组无效`);
    value.forEach((item, index) => validateAiArguments(item, schema.items as Schema, `${path}[${index}]`));
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}必须为对象`);
    const entries = Object.entries(value), properties = (schema.properties ?? {}) as Record<string, Schema>;
    if (entries.length < Number(schema.minProperties ?? 0) || entries.length > Number(schema.maxProperties ?? Infinity)) throw new Error(`${path}字段数量无效`);
    for (const [key, item] of entries) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`${path}含禁止的字段`);
      if (schema.propertyNames) validateAiArguments(key, schema.propertyNames as Schema, `${path}字段名`);
      const fieldSchema = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
      if (!fieldSchema || typeof fieldSchema !== 'object') throw new Error(`${path}含未知字段：${key}`);
      validateAiArguments(item, fieldSchema as Schema, `${path}.${key}`);
    }
    for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(value, key)) throw new Error(`${path}缺少字段：${key}`);
  }
}
