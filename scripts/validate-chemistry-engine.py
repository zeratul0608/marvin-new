"""Independently read generated CDX/CDXML with native RDKit, checking chemistry and mass."""
import argparse
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dependencies', type=Path)
args = parser.parse_args()
if args.dependencies:
    sys.path.insert(0, str(args.dependencies.resolve()))
from rdkit import Chem, rdBase
from rdkit.Chem import Descriptors, rdMolDescriptors

directory = Path('docs/validation/chemistry-engine')
cases = json.loads((directory / 'adapter-results.json').read_text(encoding='utf8'))['results']
results = []
for case in cases:
    params = Chem.CDXMLParserParams()
    params.format = Chem.CDXMLFormat.CDX if case['format'] == 'cdx' else Chem.CDXMLFormat.CDXML
    params.sanitize = True
    params.removeHs = False
    molecules = Chem.MolsFromCDXMLFile(str(directory / case['file']), params)
    assert len(molecules) == 1 and molecules[0] is not None, case['file']
    mol = molecules[0]
    expected = Chem.MolFromSmiles(case['inputSmiles'])
    smiles = Chem.MolToSmiles(mol)
    assert smiles == Chem.MolToSmiles(expected), (case['file'], smiles, Chem.MolToSmiles(expected))
    assert abs(Descriptors.MolWt(mol) - case['molecularWeight']) < 0.001, case['file']
    assert abs(rdMolDescriptors.CalcExactMolWt(mol) - case['exactMass']) < 0.000001, case['file']
    centers = Chem.FindMolChiralCenters(mol, includeUnassigned=True)
    atom_stereo = [label for _, label in centers if label != '?']
    bond_stereo = [str(b.GetStereo()).removeprefix('STEREO') for b in mol.GetBonds() if b.GetStereo() in (Chem.BondStereo.STEREOE, Chem.BondStereo.STEREOZ)]
    assert sorted(atom_stereo) == sorted(case['stereoAtoms']), (case['file'], centers)
    assert sorted(bond_stereo) == sorted(case['stereoBonds']), (case['file'], bond_stereo)
    results.append({'file': case['file'], 'smiles': smiles, 'formula': rdMolDescriptors.CalcMolFormula(mol), 'massVerified': True, 'stereoAtoms': atom_stereo, 'stereoBonds': bond_stereo})
report = {'rdkitVersion': rdBase.rdkitVersion, 'validated': len(results), 'scope': 'Native Python RDKit independently parses generated CDX/CDXML and verifies isomeric SMILES, exact and average mass, R/S and E/Z. Independent runtime/parser, not an independent chemistry toolkit or ChemDraw certification.', 'results': results}
(directory / 'independent-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(f'Native RDKit {rdBase.rdkitVersion}: {len(results)} CDX/CDXML files independently verified.')
