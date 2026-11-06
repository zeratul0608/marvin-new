"""Validate RXN roles, mapped chemistry, stereochemistry and reaction centers with native RDKit."""
import argparse
import json
from pathlib import Path
import sys
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dependencies',type=Path)
parser.add_argument('--prepare',action='store_true',help='Generate native V2000/V3000 fixtures before running the JS preparation script.')
args=parser.parse_args()
if args.dependencies:
    sys.path.insert(0,str(args.dependencies.resolve()))
from rdkit import Chem,rdBase
from rdkit.Chem import rdChemReactions as R
from rdkit.Chem import rdDepictor
from rdkit.Geometry import Point3D
directory=Path('docs/validation/rxn')
directory.mkdir(parents=True,exist_ok=True)
if args.prepare:
    reaction=R.ReactionFromSmarts('[13CH3:1][OH:2]>O>[13CH2:1]=[O:2]',useSmiles=True)
    # Use implicit-H ordinary chemistry; the app deliberately rejects native
    # explicit VAL constraints, whose editing semantics its model does not store.
    for role,offset in [(reaction.GetReactants(),(0,0)),(reaction.GetProducts(),(5,0)),(reaction.GetAgents(),(2.5,2))]:
        for mol in role:
            for atom in mol.GetAtoms():
                atom.SetNumExplicitHs(0)
                atom.SetNoImplicit(False)
            mol.UpdatePropertyCache(strict=False)
            rdDepictor.Compute2DCoords(mol)
            conformer=mol.GetConformer()
            for i in range(mol.GetNumAtoms()):
                p=conformer.GetAtomPosition(i)
                conformer.SetAtomPosition(i,Point3D(p.x+offset[0],p.y+offset[1],0))
    for version in ('v2000','v3000'):
        (directory/f'native-{version}.rxn').write_text(R.ReactionToRxnBlock(reaction,separateAgents=True,forceV3000=version=='v3000'),encoding='utf8')
    print('Generated native RDKit V2000/V3000 RXN fixtures.')
    raise SystemExit()
cases=json.loads((directory/'adapter-results.json').read_text(encoding='utf8'))['results']
def signature(reaction):
    return tuple(tuple(sorted(Chem.MolToSmiles(m,isomericSmiles=True) for m in role)) for role in (reaction.GetReactants(),reaction.GetProducts(),reaction.GetAgents()))
results=[]
for case in cases:
    raw=(directory/case['file']).read_text(encoding='utf8')
    reaction=R.ReactionFromRxnBlock(raw,sanitize=True,removeHs=False,strictParsing=True)
    expected=R.ReactionFromSmarts(case['referenceSmiles'],useSmiles=True)
    assert reaction is not None and expected is not None,case['file']
    assert signature(reaction)==signature(expected),(case['file'],signature(reaction),signature(expected))
    counts=[reaction.GetNumReactantTemplates(),reaction.GetNumProductTemplates(),reaction.GetNumAgentTemplates()]
    assert counts==case['roles'],(case['file'],counts)
    if case.get('reactionCenter'):
        actual=[reaction.GetReactantTemplate(0).GetBondWithIdx(0).GetIntProp('molReactStatus'),reaction.GetProductTemplate(0).GetBondWithIdx(0).GetIntProp('molReactStatus')]
        assert actual==case['reactionCenter'],(case['file'],actual)
    results.append({'file':case['file'],'roles':counts,'reactionSmiles':R.ReactionToSmiles(reaction),'mapNumbers':[[a.GetAtomMapNum() for a in mol.GetAtoms()] for mol in reaction.GetReactants()],'stereoAtoms':[[tag for _,tag in Chem.FindMolChiralCenters(mol,includeUnassigned=True)] for mol in reaction.GetReactants()],'reactionCentersVerified':bool(case.get('reactionCenter'))})
(directory/'independent-results.json').write_text(json.dumps({'rdkitVersion':rdBase.rdkitVersion,'validated':len(results),'scope':'Native RXN parser verifies each role separately, canonical mapped/isotopic isomeric SMILES, agents, and RXCTR. Includes native-produced fixtures imported and rebuilt by the app; not certification of all RXN features.','results':results},indent=2)+'\n',encoding='utf8')
print(f'Native RDKit {rdBase.rdkitVersion}: {len(results)} RXN files independently verified.')
