import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { showAdvancedEditor } from './browser-advanced-ui.mjs';

const { chromium } = await import(process.argv[2] || 'playwright');
const output = '.local/advanced-workspace';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], failures = [];
const viewports = [{width:1600,height:1100},{width:1280,height:900},{width:768,height:1024},{width:390,height:844}];
try {
  for (const viewport of viewports) {
    const page = await browser.newPage({viewport}), errors=[];
    page.on('pageerror', error=>errors.push(error.message)); page.setDefaultTimeout(12000);
    const editor = page.locator('chemical-editor').first();
    try {
      await page.goto(process.env.ADVANCED_UI_TEST_URL || 'http://127.0.0.1:5173/');
      await page.waitForFunction(()=>!!window.moleculeEditor);
      const initial=await page.evaluate(async()=>{
        const sdk=await import('/src/index.ts'), api=window.moleculeEditor;
        const doc=sdk.exampleDocument('ethanol'), center=Object.keys(doc.graph.atoms)[0];
        const fluorine=sdk.addAtom(doc,'F',{x:-1.5,y:1.5}), chlorine=sdk.addAtom(doc,'Cl',{x:-1.5,y:-1.5});
        sdk.addBond(doc,center,fluorine,1); sdk.addBond(doc,center,chlorine,1);
        const refs=Object.values(doc.graph.bonds).filter(bond=>bond.atoms.includes(center)).map(bond=>bond.id);
        doc.graph.atoms[center].geometry={type:'tetrahedral',bondOrdering:[...refs,null]};
        doc.graph.atoms[center].spatial=[0,0,0];
        api.setDocument(doc);
        const ids=Object.keys(api.getDocument().graph.atoms); api.setSelection({atomIds:[ids[0]]}); api.showPluginPanel();
        return {ids,snapshot:api.getSnapshot(),svg:api.exportSvg()};
      });
      await showAdvancedEditor(page,'fragments');
      const collapse=editor.locator('.collapse-controls'), label=editor.locator('[data-collapse-label]');
      await collapse.locator('summary').click(); await label.fill('Keep this draft');
      await label.evaluate(node=>{window.advancedDraftNode=node;});
      await editor.locator('[data-advanced-section="properties"]').click();
      const annotations=editor.locator('[data-advanced-panel="properties"] details').first();
      await annotations.locator('summary').click();
      await annotations.evaluate(node=>{window.advancedAnnotationNode=node;});
      const content=editor.locator('.advanced-content');
      const propertiesScroll=await content.evaluate(node=>{node.scrollTop=140;return node.scrollTop;});
      assert.ok(propertiesScroll>0,'The properties test must really exercise a scrollable inspector');
      await editor.locator('[data-advanced-section="queries"]').click();
      const queryDetails=editor.locator('.advanced-query-controls');
      if(!await queryDetails.evaluate(node=>node.open))await queryDetails.locator('summary').click();
      const queryScroll=await content.evaluate(node=>{node.scrollTop=35;return node.scrollTop;});
      await editor.locator('[data-advanced-section="properties"]').click();
      assert.ok(Math.abs(await content.evaluate(node=>node.scrollTop)-propertiesScroll)<2,'Properties scroll was lost across categories');
      assert.equal(await annotations.evaluate(node=>node===window.advancedAnnotationNode&&node.open),true,'Chemical annotation disclosure was rebuilt');
      await editor.locator('[data-advanced-section="queries"]').click();
      assert.ok(Math.abs(await content.evaluate(node=>node.scrollTop)-queryScroll)<2,'Queries inherited a different category scroll');
      await editor.locator('[data-advanced-section="fragments"]').click();
      assert.equal(await label.inputValue(),'Keep this draft');
      assert.equal(await label.evaluate(node=>node===window.advancedDraftNode),true,'Draft form node was remounted');
      assert.equal(await collapse.evaluate(node=>node.open),true);
      const basicTab=editor.locator('.inspector-tabs [data-inspector-plugin=""]');
      await basicTab.focus(); await basicTab.press('Enter');
      assert.equal(await basicTab.evaluate(node=>node.getRootNode().activeElement===node),true,'Returning to basic properties stranded keyboard focus');
      await editor.locator('[data-action="toggle-advanced"]').click();
      await showAdvancedEditor(page,'fragments');
      assert.equal(await label.inputValue(),'Keep this draft');
      assert.equal(await label.evaluate(node=>node===window.advancedDraftNode),true);
      assert.deepEqual(await page.evaluate(()=>window.moleculeEditor.getSnapshot()),initial.snapshot);
      assert.equal(await page.evaluate(()=>window.moleculeEditor.exportSvg()),initial.svg);
      await page.screenshot({path:`${output}/${viewport.width}-draft.png`});

      // Keyboard movement should scroll the toolbar itself, without moving the page
      // or changing categories until the user activates the focused button.
      const properties=editor.locator('[data-advanced-section="properties"]');
      await properties.click(); await properties.focus();
      const pageTop=await page.evaluate(()=>scrollY);
      await properties.press('End');
      const extensions=editor.locator('[data-advanced-section="extensions"]');
      assert.equal(await extensions.evaluate(node=>node.getRootNode().activeElement===node),true);
      assert.equal(await properties.getAttribute('aria-pressed'),'true');
      assert.equal(await editor.locator('[data-advanced-section][tabindex="0"]').count(),1);
      assert.equal(await extensions.evaluate(node=>{const r=node.getBoundingClientRect(),p=node.parentElement.getBoundingClientRect();return r.left>=p.left-2&&r.right<=p.right+2;}),true,'Focused category remained hidden beyond the toolbar viewport');
      assert.equal(await page.evaluate(()=>scrollY),pageTop,'Toolbar navigation scrolled the full page');
      await page.evaluate(()=>window.moleculeEditor.setSelection(window.moleculeEditor.getSelection()));
      assert.equal(await extensions.evaluate(node=>node.getRootNode().activeElement===node),true,'An unrelated render moved the toolbar focus');
      assert.equal(await extensions.evaluate(node=>{const r=node.getBoundingClientRect(),p=node.parentElement.getBoundingClientRect();return r.left>=p.left-2&&r.right<=p.right+2;}),true,'An unrelated render hid the focused unselected category');

      await extensions.press('Enter');
      assert.equal(await extensions.getAttribute('aria-pressed'),'true');
      const pluginTabs=editor.locator('.extension-tabs button');
      await pluginTabs.first().focus(); await pluginTabs.first().press('End');
      assert.equal(await pluginTabs.last().evaluate(node=>node.getRootNode().activeElement===node),true,JSON.stringify(await editor.evaluate(host=>({active:host.shadowRoot.activeElement?.outerHTML,tabs:[...host.shadowRoot.querySelectorAll('.extension-tabs button')].map(node=>({html:node.outerHTML,rect:node.getBoundingClientRect().toJSON()}))}))));
      assert.equal(await editor.locator('.extension-tabs button[tabindex="0"]').count(),1);
      await pluginTabs.last().press('Enter');
      assert.equal(await pluginTabs.last().getAttribute('aria-pressed'),'true');
      assert.deepEqual(await page.evaluate(()=>window.moleculeEditor.getSnapshot()),initial.snapshot);

      for (const [query,section] of [['原子映射','properties'],['聚合物','document'],['内部结构','fragments'],['查询','queries']]) {
        await page.keyboard.press('Control+k');
        const search=editor.locator('.command-search'); await search.fill(query);
        assert.ok(await editor.locator('.search-results [data-command]').count()>0,`No discoverable advanced result for ${query}`);
        await search.press('Enter');
        assert.equal(await editor.locator('.search-dialog').isVisible(),false);
        assert.equal(await editor.locator(`[data-advanced-section="${section}"]`).getAttribute('aria-pressed'),'true');
        assert.equal(await editor.locator(`[data-advanced-panel="${section}"]`).isVisible(),true);
      }
      assert.deepEqual(await page.evaluate(()=>window.moleculeEditor.getSnapshot()),initial.snapshot,'Finding advanced tools should not edit chemistry');
      assert.equal(await label.inputValue(),'Keep this draft','Search-based navigation discarded the fragment draft');

      // A draft belongs to its current selection and revision, not a different atom.
      await page.evaluate(id=>window.moleculeEditor.setSelection({atomIds:[id]}),initial.ids[1]);
      await showAdvancedEditor(page,'fragments');
      assert.equal(await label.inputValue(),'');
      assert.equal(await label.evaluate(node=>node===window.advancedDraftNode),false);
      if(!await collapse.evaluate(node=>node.open))await collapse.locator('summary').click();
      await label.fill('Discard when document changes');
      await page.evaluate(id=>window.moleculeEditor.applyEdits({operations:[{type:'update-atom',atomId:id,changes:{isotope:13}}]}),initial.ids[1]);
      assert.equal(await label.inputValue(),'');
      assert.equal(await page.evaluate(id=>window.moleculeEditor.getDocument().graph.atoms[id].isotope,initial.ids[1]),13);

      // Actual submissions rebuild chemical fields, then restore focus after the
      // selected advanced panel has become visible again.
      await page.evaluate(id=>window.moleculeEditor.setSelection({atomIds:[id]}),initial.ids[0]);
      await showAdvancedEditor(page,'properties');
      const radical=editor.locator('[data-property="radical"]');
      await radical.focus(); await radical.selectOption('2');
      assert.equal(await radical.evaluate(node=>node.getRootNode().activeElement===node),true,'Submitting a radical field lost its advanced focus');
      assert.equal(await page.evaluate(id=>window.moleculeEditor.getDocument().graph.atoms[id].radical,initial.ids[0]),2);
      const bondId=await page.evaluate(()=>Object.keys(window.moleculeEditor.getDocument().graph.bonds)[0]);
      await page.evaluate(id=>window.moleculeEditor.setSelection({atomIds:[],bondId:id}),bondId);
      await showAdvancedEditor(page,'queries');
      const topologyDetails=editor.locator('.bond-query-controls');
      if(!await topologyDetails.evaluate(node=>node.open))await topologyDetails.locator('summary').click();
      const topology=editor.locator('[data-bond-topology]');
      await topology.focus(); await topology.selectOption('Ring');
      assert.equal(await topology.evaluate(node=>node.getRootNode().activeElement===node),true,'Submitting a bond topology field lost its advanced focus');
      assert.equal(await page.evaluate(id=>window.moleculeEditor.getDocument().graph.bonds[id].topology,bondId),'Ring');
      await page.screenshot({path:`${output}/${viewport.width}-workspace.png`});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      assert.deepEqual(errors,[]);
      results.push({viewport,draftsRetainNode:true,detailsRetained:true,independentScroll:true,selectionAndRevisionInvalidateDrafts:true,rovingCategoryKeyboard:true,basicTabFocusRetained:true,rovingPluginKeyboard:true,focusedCategoryVisible:true,toolbarDoesNotScrollPage:true,unselectedToolbarFocusSurvivesRender:true,submittedFieldsRetainFocus:true,advancedSearch:true,uiPreservesChemicalSnapshot:true,errors});
      console.log(`Verified ${viewport.width}px: retained drafts, disclosures and scroll, keyboard navigation, advanced discovery`);
    } catch(error) {
      failures.push({viewport,error:error.message,stack:error.stack,errors});
      await page.screenshot({path:`${output}/${viewport.width}-failure.png`}).catch(()=>{});
      console.error(`Failed ${viewport.width}px: ${error.message}`);
    } finally {await page.close();}
  }
} finally {
  await browser.close();
  await writeFile(`${output}/browser-results.json`,JSON.stringify({browser:'Chrome',aiTested:false,results,failures},null,2)+'\n');
}
assert.deepEqual(failures,[],`${failures.length} advanced workspace scenario(s) failed`);
