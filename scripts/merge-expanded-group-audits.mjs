import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const files=process.argv.slice(2);assert.ok(files.length,'Pass the completed audit partition JSON files');
const directory='docs/validation/expanded-groups',manifest=JSON.parse(await readFile(`${directory}/targets.json`,'utf8'));
const parts=await Promise.all(files.map(async file=>JSON.parse(await readFile(file,'utf8'))));parts.sort((a,b)=>a.range.start-b.range.start);
let next=0;const results=[];
for(const part of parts){
 assert.equal(part.range.start,next,'Partitions must be contiguous with no overlap');assert.equal(part.summary.failures,0,'A partition failed');assert.equal(part.failures.length,0,'A partition contains failed cases');
 assert.equal(part.results.length,part.range.end-part.range.start,'Incomplete partition');
 for(const [index,row]of part.results.entries()){
  const expected=manifest.targets[part.range.start+index];
  for(const key of ['file','nativeId','label','category'])assert.equal(row[key],expected[key],`Target mismatch at ${part.range.start+index}`);
  assert.ok(row.viewSourceSaved&&row.allBranchesEditedAndSourceSaved&&row.jsonRestored&&row.undoRedo,'Incomplete validation proof');results.push(row);
 }
 next=part.range.end;
}
assert.equal(next,manifest.targets.length,'Partitions do not cover all targets');
const summary={targeted:next,expandedGroupView:results.length,editedBranches:results.reduce((n,row)=>n+row.branches,0),allBranchesEditedAndSourceSaved:results.length,failures:0};
await writeFile(`${directory}/corpus-results.json`,JSON.stringify({scope:parts[0].scope,execution:{independentPartitions:parts.map(part=>part.range),completeCoverageVerified:true},summary,results,failures:[]},null,2)+'\n');console.log(JSON.stringify(summary,null,2));
