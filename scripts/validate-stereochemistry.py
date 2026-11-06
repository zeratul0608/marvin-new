"""Independently check that exported wedge inversion changes chirality and alkene reflection changes E/Z."""
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

directory = Path('docs/validation/stereochemistry')
cases = json.loads((directory / 'browser-results.json').read_text(encoding='utf8'))['results']
results = []
for case in cases:
    params = Chem.CDXMLParserParams()
    params.format = Chem.CDXMLFormat.CDX if case['format'] == 'cdx' else Chem.CDXMLFormat.CDXML
    params.sanitize = True
    params.removeHs = False
    molecules = Chem.MolsFromCDXMLFile(str(directory / case['file']), params)
    assert len(molecules) == 1 and molecules[0] is not None, case['file']
    mol = molecules[0]
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    smiles = Chem.MolToSmiles(mol)
    if case['scenario'].startswith('tetra'):
        centers = Chem.FindMolChiralCenters(mol, includeUnassigned=True)
        assert len(centers) == 1 and centers[0][1] in ('R', 'S'), (case['file'], centers)
        stereo = centers[0][1]
        assert mol.GetNumAtoms() == 5 and mol.GetNumBonds() == 4
    else:
        double = [b for b in mol.GetBonds() if b.GetBondType() == Chem.BondType.DOUBLE]
        assert len(double) == 1 and double[0].GetStereo() in (Chem.BondStereo.STEREOE, Chem.BondStereo.STEREOZ), (case['file'], smiles)
        stereo = str(double[0].GetStereo())
        assert mol.GetNumAtoms() == 4 and mol.GetNumBonds() == 3
    results.append({'file': case['file'], 'scenario': case['scenario'], 'format': case['format'], 'canonicalIsomericSmiles': smiles, 'stereo': stereo})

for format in ('cdx', 'cdxml'):
    by_case = {r['scenario']: r for r in results if r['format'] == format}
    assert by_case['tetra-original']['stereo'] != by_case['tetra-inverted']['stereo']
    assert by_case['tetra-original']['stereo'] == by_case['tetra-mirrored']['stereo']
    assert by_case['alkene-trans']['stereo'] == 'STEREOE'
    assert by_case['alkene-cis']['stereo'] == 'STEREOZ'
for scenario in {r['scenario'] for r in results}:
    pair = [r for r in results if r['scenario'] == scenario]
    assert pair[0]['canonicalIsomericSmiles'] == pair[1]['canonicalIsomericSmiles']
report = {'rdkitVersion': rdBase.rdkitVersion, 'validated': len(results),
          'scope': 'Chirality from wedge depiction, chirality preservation under mirror, alkene E/Z from drawing, connectivity and counts. Does not certify ChemDraw layout or all stereo classes.',
          'cases': results}
(directory / 'independent-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(f"RDKit {rdBase.rdkitVersion}: {len(results)} stereo files independently verified.")
