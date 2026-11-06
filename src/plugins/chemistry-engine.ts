import type {ChemistryAnalysis,ChemistryEngine} from '../chemistry/engine';
import {loadChemistryEngine} from '../chemistry/runtime';
import type {EditOperation} from '../core/edits';
import type {EditorPlugin,EditorSnapshot} from '../editor/api-types';

export interface ChemistryPluginOptions{loadEngine?:()=>Promise<ChemistryEngine>}
/** Lazy, offline chemical computation layered on the existing revision-safe editor. */
export function createChemistryPlugin(options:ChemistryPluginOptions={}):EditorPlugin{
  return {id:'chemistry-engine',name:'化学计算',version:'1.0.0',apiVersion:1,
    description:'本地自动二维清理、常见立体标签计算、分子性质分析与 SMILES 输入。',
    activate(context){
      let disposed=false,busy=false,analysis:ChemistryAnalysis|undefined,smiles='',status='选择完整分子后计算；未选择时处理整份文档。',resultRevision=-1;
      const views=new Set<()=>void>();const refresh=()=>views.forEach(render=>render());
      const load=options.loadEngine??loadChemistryEngine;
      const ensure=(snapshot:EditorSnapshot)=>{if(disposed)throw new Error('化学计算插件已停用，结果未提交。');if(context.editor.getSnapshot().revision!==snapshot.revision)throw new Error('计算期间文档已更新，请重新计算；旧结果未覆盖当前文档。');};
      const perform=async(action:'analyze'|'clean-2d'|'assign-stereo'|'import-smiles',input?:unknown)=>{
        if(busy)throw new Error('化学计算正在进行，请稍候。');
        const snapshot=context.editor.getSnapshot();busy=true;status='正在加载本地计算模块并处理结构…';refresh();
        try{
          const engine=await load();ensure(snapshot);
          if(action==='import-smiles'){
            const text=typeof input==='string'?input:input&&typeof input==='object'&&typeof (input as {smiles?:unknown}).smiles==='string'?(input as {smiles:string}).smiles:smiles;
            const doc=engine.importSmiles(text);ensure(snapshot);context.editor.import({format:'json',data:JSON.stringify(doc)});context.editor.fit();
            analysis=engine.analyze(context.editor.getDocument());resultRevision=context.editor.getSnapshot().revision;status='SMILES 已载入，自动生成二维坐标；可一步撤销。';
          }else if(action==='clean-2d'){
            const result=engine.cleanup2D(snapshot.document,snapshot.selection.atomIds);ensure(snapshot);
            context.editor.applyEdits({expectedRevision:snapshot.revision,operations:result.operations});context.editor.fit();
            status=`已清理 ${result.atomIds.length} 个原子；结构与已指定异构构型复核通过，可撤销。`;
          }else{
            const result=engine.analyze(snapshot.document,snapshot.selection.atomIds);ensure(snapshot);
            if(action==='assign-stereo'){
              const operations:EditOperation[]=[],selected=new Set(result.atomIds);
              for(const id of result.atomIds)if(snapshot.document.graph.atoms[id].cipLabel!==result.stereoAtoms[id])operations.push({type:'update-atom',atomId:id,changes:{cipLabel:result.stereoAtoms[id]??null}});
              for(const bond of Object.values(snapshot.document.graph.bonds))if(bond.atoms.every(id=>selected.has(id))&&bond.cipLabel!==result.stereoBonds[bond.id])operations.push({type:'set-bond-annotations',bondId:bond.id,changes:{cipLabel:result.stereoBonds[bond.id]??null}});
              context.editor.applyEdits({expectedRevision:snapshot.revision,operations});
              status=`已更新 ${Object.keys(result.stereoAtoms).length} 个原子及 ${Object.keys(result.stereoBonds).length} 条双键的计算标签；未指定中心不会自动指定构型。`;
            }else status='化学分析完成。计算值基于当前二维分子图，未修改结构。';
            analysis=result;resultRevision=context.editor.getSnapshot().revision;
          }
          context.notify(status);return action==='clean-2d'?{revision:context.editor.getSnapshot().revision}:analysis;
        }catch(error){status=error instanceof Error?error.message:String(error);if(!disposed)context.notify(status);throw error;}
        finally{busy=false;if(!disposed)refresh();}
      };
      const cleanups=[
        context.on('change',()=>{analysis=undefined;resultRevision=-1;if(!busy)status='文档已修改，请重新计算。';refresh();}),
        context.on('selectionchange',()=>{analysis=undefined;resultRevision=-1;if(!busy)status='选区已更新。请选择完整分子；未选择时处理整份文档。';refresh();}),
        ...([['clean-2d','自动二维清理'],['analyze','计算分子性质'],['assign-stereo','计算并写入立体标签'],['import-smiles','从 SMILES 载入结构']] as const).map(([id,title])=>context.registerCommand({id,title,execute:input=>perform(id,input)})),
        context.addPanel({id:'chemistry',title:'本地化学计算',mount(container){
          const doc=container.ownerDocument,notice=doc.createElement('p'),statusEl=doc.createElement('p'),summary=doc.createElement('dl'),output=doc.createElement('textarea'),input=doc.createElement('textarea'),buttons:HTMLButtonElement[]=[];
          notice.textContent='计算在本机浏览器完成。请选择完整分子；未选择时作用于整份文档。查询、轴手性和复杂片段仍按原模型保存，当前计算入口会明确报告限制。';notice.style.cssText='font-size:12px;line-height:1.7';
          statusEl.setAttribute('role','status');statusEl.dataset.chemistryStatus='';statusEl.style.cssText='font-size:12px;line-height:1.7;overflow-wrap:anywhere';
          container.append(notice);
          for(const [action,title]of [['clean-2d','自动二维清理'],['analyze','计算分子性质'],['assign-stereo','计算并写入立体标签']] as const){
            const button=doc.createElement('button');button.type='button';button.textContent=title;button.dataset.chemistryAction=action;button.style.cssText='display:block;width:100%;margin:8px 0';button.addEventListener('click',()=>void perform(action).catch(()=>{}));buttons.push(button);container.append(button);
          }
          summary.style.cssText='display:grid;grid-template-columns:1fr auto;gap:6px;margin:12px 0;font-size:12px';summary.dataset.chemistrySummary='';
          output.readOnly=true;output.setAttribute('aria-label','计算所得 SMILES');output.style.cssText='width:100%;min-height:70px;resize:vertical;font-size:12px';output.hidden=true;
          input.setAttribute('aria-label','输入 SMILES');input.placeholder='输入单条分子 SMILES，例如 CC(=O)Oc1ccccc1C(=O)O';input.style.cssText='width:100%;min-height:70px;resize:vertical;font-size:12px';input.value=smiles;input.addEventListener('input',()=>{smiles=input.value;});
          const label=doc.createElement('label');label.textContent='从 SMILES 建立结构';label.append(input);
          const importButton=doc.createElement('button');importButton.type='button';importButton.dataset.chemistryAction='import-smiles';importButton.textContent='用 SMILES 替换画布（可撤销）';importButton.style.cssText='display:block;width:100%;margin:8px 0';importButton.addEventListener('click',()=>void perform('import-smiles',input.value).catch(()=>{}));buttons.push(importButton);
          container.append(statusEl,summary,output,label,importButton);
          const render=()=>{
            buttons.forEach(b=>b.disabled=busy);statusEl.textContent=status;
            if(!analysis||resultRevision!==context.editor.getSnapshot().revision){summary.replaceChildren();output.hidden=true;return;}
            const rows:[string,string|number][]=[['计算引擎',`RDKit ${analysis.version}`],['分子式',analysis.formula],['平均分子量',analysis.molecularWeight.toFixed(4)],['单同位素精确质量',analysis.exactMass.toFixed(6)],['总形式电荷',analysis.formalCharge],['环数 / 芳香原子',`${analysis.ringCount} / ${analysis.aromaticAtomIds.length}`],['常见原子 / 双键立体标签',`${Object.keys(analysis.stereoAtoms).length} / ${Object.keys(analysis.stereoBonds).length}`],['未指定立体中心',analysis.unspecifiedStereoCenters],['LogP（计算）',analysis.descriptors.logP.toFixed(3)],['tPSA（Å²）',analysis.descriptors.tpsa.toFixed(2)]];
            summary.replaceChildren(...rows.flatMap(([label,value])=>{const term=doc.createElement('dt'),detail=doc.createElement('dd');term.textContent=label;detail.textContent=String(value);detail.style.cssText='margin:0;text-align:right';return[term,detail];}));output.value=analysis.smiles;output.hidden=false;
          };views.add(render);render();return()=>{views.delete(render);container.replaceChildren();};
        }}),
      ];
      return()=>{disposed=true;cleanups.reverse().forEach(cleanup=>cleanup());views.clear();};
    },
  };
}
