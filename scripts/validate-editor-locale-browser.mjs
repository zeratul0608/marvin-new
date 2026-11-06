import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {showAdvancedEditor} from './browser-advanced-ui.mjs';

const {chromium}=await import(process.argv[2]||'playwright');
const output='.local/editor-locale';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[],failures=[];
const viewports=[{width:1600,height:1100},{width:1280,height:900},{width:768,height:1024},{width:390,height:844}];
async function scan(page,state){
  return page.evaluate(state=>{
    const findings=[],ideograph=/[\u3400-\u9fff]/;
    const roots=[document,document.querySelector('chemical-editor').shadowRoot];
    const excluded='svg,textarea,pre,code,script,style,option,[data-i18n-skip],[data-i18n-user]';
    const excludedAttributes='svg,pre,code,script,style,option,[data-i18n-skip],[data-i18n-user]';
    const visible=node=>{
      for(let parent=node;parent;parent=parent.parentElement){if(parent.tagName==='DETAILS'&&!parent.open&&!parent.querySelector(':scope>summary')?.contains(node))return false;}
      const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&(!node.checkVisibility||node.checkVisibility());
    };
    const where=node=>[node.tagName.toLowerCase(),node.id?`#${node.id}`:'',node.className&&typeof node.className==='string'?`.${node.className.trim().replace(/\s+/g,'.')}`:''].join('');
    for(const root of roots){
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
      while(node=walker.nextNode()){
        const owner=node.parentElement,text=node.textContent.trim();
        if(!owner||!text||!ideograph.test(text)||owner.closest(excluded)||!visible(owner))continue;
        findings.push({state,kind:'text',where:where(owner),text:text.slice(0,500),dynamic:!!owner.closest('.issue-list,.dialog-message,.toast,.ai-status,.ai-context')});
      }
      for(const owner of root.querySelectorAll('[aria-label],[title],[placeholder]')){
        if(owner.closest(excludedAttributes)||!visible(owner))continue;
        for(const attribute of ['aria-label','title','placeholder']){const text=owner.getAttribute(attribute);if(text&&ideograph.test(text))findings.push({state,kind:attribute,where:where(owner),text:text.slice(0,500),dynamic:false});}
      }
    }
    return findings;
  },state);
}
try{
  for(const viewport of viewports){
    const page=await browser.newPage({viewport}),errors=[],untranslated=[];
    page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
    const editor=page.locator('chemical-editor').first();
    try{
      await page.goto(process.env.EDITOR_LOCALE_TEST_URL||'http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
      const initial=await page.evaluate(async()=>{
        const sdk=await import('/src/index.ts'),api=window.moleculeEditor,doc=sdk.exampleDocument('ethanol');
        doc.title='高级编辑';sdk.addAtom(doc,'*',{x:5,y:0},{query:{kind:'generic',label:'高级编辑'}});
        api.setDocument(doc);const atomId=Object.keys(api.getDocument().graph.atoms)[0];api.setSelection({atomIds:[atomId]});api.showPluginPanel();api.setLocale('zh-CN');
        window.localeChanges=[];api.addEventListener('localechange',event=>window.localeChanges.push(event.detail.locale));
        return {atomId,snapshot:api.getSnapshot(),svg:api.exportSvg()};
      });
      const language=editor.locator('.locale-select');assert.equal(await language.isVisible(),true);
      await language.focus();await language.selectOption('en');await page.waitForFunction(()=>document.documentElement.lang==='en');
      assert.equal(await page.evaluate(()=>window.moleculeEditor.getLocale()),'en');assert.equal(await editor.getAttribute('lang'),'en');
      assert.match(await editor.locator('[data-action="toggle-advanced"]').getAttribute('aria-label'),/advanced/i);
      assert.match(await editor.locator('[data-action="import"]').getAttribute('aria-label'),/import/i);
      assert.match(await editor.locator('[data-action="export"]').getAttribute('aria-label'),/export/i);
      assert.equal(await language.evaluate(node=>node.getRootNode().activeElement===node),true);
      assert.equal(await editor.locator('.document-title').inputValue(),'高级编辑');
      assert.equal(await page.evaluate(()=>window.moleculeEditor.exportSvg()),initial.svg);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'English chrome overflows the page');
      assert.equal(await page.locator('[data-page="ai-settings"]').evaluate(node=>{const bounds=node.getBoundingClientRect();return bounds.left>=0&&bounds.right<=innerWidth;}),true,'The English header hides AI settings beyond the viewport');
      untranslated.push(...await scan(page,'basic-en'));
      await page.screenshot({path:`${output}/${viewport.width}-basic-en.png`});

      await showAdvancedEditor(page,'fragments');const details=editor.locator('.collapse-controls');
      if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
      const label=editor.locator('[data-collapse-label]');await label.fill('高级编辑');await label.focus();
      await label.evaluate(node=>{window.localeDraftNode=node;});
      await page.evaluate(()=>window.moleculeEditor.setLocale('zh-CN'));
      assert.equal(await label.evaluate(node=>node.getRootNode().activeElement===node&&node===window.localeDraftNode),true);
      assert.equal(await label.inputValue(),'高级编辑');assert.equal(await details.evaluate(node=>node.open),true);
      await page.evaluate(()=>window.moleculeEditor.setLocale('en'));
      assert.equal(await label.inputValue(),'高级编辑');assert.equal(await label.evaluate(node=>node===window.localeDraftNode),true);
      untranslated.push(...await scan(page,'fragments-en'));
      for(const section of ['properties','queries','document']){
        await editor.locator(`[data-advanced-section="${section}"]`).click();
        assert.equal(await editor.locator(`[data-advanced-section="${section}"]`).getAttribute('aria-pressed'),'true');
        untranslated.push(...await scan(page,`${section}-en`));
      }
      assert.equal(await label.inputValue(),'高级编辑');
      assert.deepEqual(await page.evaluate(()=>window.moleculeEditor.getSnapshot()),initial.snapshot);

      // Inspect user source text in a modal: changing locale must preserve its DOM,
      // value and focus, and translate only the interface around it.
      await editor.locator('[data-action="import"]').click();const source=editor.locator('.import-source');
      const sourceText='<document title="高级编辑">导出</document>';await source.fill(sourceText);await source.focus();
      await source.evaluate(node=>{window.localeSourceNode=node;});
      await page.evaluate(()=>window.moleculeEditor.setLocale('zh-CN'));
      await page.evaluate(()=>window.moleculeEditor.setLocale('en'));
      assert.equal(await source.inputValue(),sourceText);
      assert.equal(await source.evaluate(node=>node===window.localeSourceNode&&node.getRootNode().activeElement===node),true);
      untranslated.push(...await scan(page,'import-dialog-en'));
      await editor.locator('.import-dialog [data-action="close-dialog"]').first().click();

      // Each built-in plugin is mounted already; opening it should render English
      // labels, including asynchronously loaded local model configuration.
      for(const id of ['structure-review','structure-layout','chemistry-engine']){
        const exists=await page.evaluate(id=>window.moleculeEditor.getPlugins().some(plugin=>plugin.id===id),id);
        if(!exists)continue;
        await page.evaluate(id=>window.moleculeEditor.showPluginPanel(id),id);
        await page.waitForTimeout(20);
        untranslated.push(...await scan(page,`${id}-en`));
      }
      await page.locator('[data-page="ai-settings"]').click();
      assert.equal(await editor.locator('[data-advanced-section="extensions"]').evaluate(node=>{const bounds=node.getBoundingClientRect(),parent=node.parentElement.getBoundingClientRect();return bounds.left>=parent.left-2&&bounds.right<=parent.right+2;}),true,'Opening a plugin leaves the selected English category outside its toolbar');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'The English advanced view overflows the page');
      const model=editor.locator('[data-ai-field="model"]');await model.waitFor({state:'visible'});
      await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('[data-ai-field="model"]').disabled);
      await model.fill('用户模型');await model.focus();await model.evaluate(node=>{window.localeModelNode=node;});
      await page.evaluate(()=>window.moleculeEditor.setLocale('zh-CN'));await page.evaluate(()=>window.moleculeEditor.setLocale('en'));
      assert.equal(await model.inputValue(),'用户模型');assert.equal(await model.evaluate(node=>node===window.localeModelNode&&node.getRootNode().activeElement===node),true);
      untranslated.push(...await scan(page,'ai-settings-en'));
      await page.screenshot({path:`${output}/${viewport.width}-settings-en.png`});
      assert.deepEqual(await page.evaluate(()=>window.moleculeEditor.getSnapshot()),initial.snapshot);
      assert.equal(await page.evaluate(()=>window.moleculeEditor.exportSvg()),initial.svg);

      // Use a local mock transport to verify user/model prose is not an interface key.
      await page.evaluate(async()=>{
        const sdk=await import('/src/index.ts'),api=window.moleculeEditor;
        api.unregisterPlugin('ai-assistant');window.localeMockCalls=0;
        api.registerPlugin(sdk.createAiAssistantPlugin({transport:{complete:async()=>{window.localeMockCalls++;return {text:'导出',toolCalls:[]};}}}));
        api.showPluginPanel('ai-assistant');
      });
      const mockMessage=editor.locator('[data-ai-field="message"]');await mockMessage.fill('撤销');
      await editor.locator('.ai-composer button[data-ai-action="send"]').click();
      await page.waitForFunction(()=>document.querySelector('chemical-editor').shadowRoot.querySelectorAll('.ai-message p').length===2);
      assert.deepEqual(await editor.locator('.ai-message p').allTextContents(),['撤销','导出']);
      await page.evaluate(()=>window.moleculeEditor.setLocale('zh-CN'));await page.evaluate(()=>window.moleculeEditor.setLocale('en'));
      assert.deepEqual(await editor.locator('.ai-message p').allTextContents(),['撤销','导出']);
      assert.equal(await page.evaluate(()=>window.localeMockCalls),1);
      assert.deepEqual(await page.evaluate(()=>window.moleculeEditor.getSnapshot()),initial.snapshot);

      await page.evaluate(()=>{
        window.localeMounts=0;window.localeDisposals=0;
        window.moleculeEditor.registerPlugin({id:'locale-check',name:'Locale check',version:'1.0.0',apiVersion:1,activate(context){context.addPanel({id:'draft',title:'Draft',mount(container){window.localeMounts++;const input=document.createElement('input');input.dataset.localePluginDraft='';input.setAttribute('aria-label','Draft');container.append(input);return()=>{window.localeDisposals++;};}});}});
        window.moleculeEditor.showPluginPanel('locale-check');
      });
      const pluginDraft=editor.locator('[data-locale-plugin-draft]');await pluginDraft.fill('高级编辑');await pluginDraft.focus();
      await pluginDraft.evaluate(node=>{window.localePluginNode=node;});
      await page.evaluate(()=>window.moleculeEditor.setLocale('zh-CN'));await page.evaluate(()=>window.moleculeEditor.setLocale('en'));
      assert.equal(await pluginDraft.inputValue(),'高级编辑');assert.equal(await pluginDraft.evaluate(node=>node===window.localePluginNode&&node.getRootNode().activeElement===node),true);
      assert.deepEqual(await page.evaluate(()=>({mounts:window.localeMounts,disposals:window.localeDisposals})),{mounts:1,disposals:0});
      assert.deepEqual(await page.evaluate(()=>window.moleculeEditor.getSnapshot()),initial.snapshot);
      const prefBefore=await language.inputValue();assert.equal(prefBefore,'en');
      await page.reload();await page.waitForFunction(()=>!!window.moleculeEditor&&window.moleculeEditor.getLocale()==='en'&&document.documentElement.lang==='en');
      assert.match(await editor.locator('[data-action="toggle-advanced"]').getAttribute('aria-label'),/advanced/i);
      assert.equal(await editor.locator('.locale-select').inputValue(),'en');
      await editor.locator('.locale-select').selectOption('zh-CN');await page.waitForFunction(()=>document.documentElement.lang==='zh-CN');
      assert.match(await editor.locator('[data-action="toggle-advanced"]').getAttribute('aria-label'),/高级/);
      await page.screenshot({path:`${output}/${viewport.width}-restored-zh.png`});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      assert.deepEqual(errors,[]);
      const unique=[...new Map(untranslated.map(item=>[JSON.stringify(item),item])).values()];
      assert.deepEqual(unique.filter(item=>!item.dynamic),[],'Untranslated visible interface text remains');
      results.push({viewport,englishInterface:true,localizedAria:true,documentLanguageSynchronized:true,preferenceSurvivesReload:true,roundTripChinese:true,userChineseValuesPreserved:true,sourceAndSvgUnchanged:true,formAndPluginNodesPreserved:true,focusPreserved:true,noChemicalHistoryChange:true,pluginMountedOnce:true,mockedConversationBodiesPreserved:true,englishLayoutContained:true,englishSelectedCategoryVisible:true,untranslated:unique,errors});
      console.log(`Verified ${viewport.width}px locale switching; ${unique.length} visible untranslated candidate(s)`);
    }catch(error){failures.push({viewport,error:error.message,stack:error.stack,untranslated,errors});await page.screenshot({path:`${output}/${viewport.width}-failure.png`}).catch(()=>{});console.error(`Failed ${viewport.width}px: ${error.message}`);}
    finally{await page.close();}
  }
}finally{await browser.close();await writeFile(`${output}/browser-results.json`,JSON.stringify({browser:'Chrome',aiTested:false,mockTransportTested:true,results,failures},null,2)+'\n');}
assert.deepEqual(failures,[],`${failures.length} editor locale scenario(s) failed`);
