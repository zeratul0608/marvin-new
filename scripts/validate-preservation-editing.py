"""Independently validate CDX/CDXML outputs after label and topology edits."""
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

directory = Path('docs/validation/preservation-expanded')
browser = json.loads((directory / 'browser-results.json').read_text(encoding='utf-8'))
expected = {'isotope-charge': 'C[15NH2+]C', 'element': 'CPC', 'add-atom': 'CNCO',
            'add-to-label': 'C[NH+](C)C', 'delete-atom': 'CN', 'delete-bond': 'C.CN', 'rewire-bond': 'CCN', 'live-preview': 'C[15NH]C'}
assert Chem.HasChemDrawCDXSupport()
results = []
for case in browser['cases']:
    params = Chem.CDXMLParserParams()
    params.format = Chem.CDXMLFormat.CDX if case['kind'] == 'cdx' else Chem.CDXMLFormat.CDXML
    params.sanitize = True
    params.removeHs = False
    molecules = Chem.MolsFromCDXMLFile(str(directory / case['file']), params)
    assert molecules and all(m is not None for m in molecules), case['file']
    mol = molecules[0]
    for other in molecules[1:]:
        mol = Chem.CombineMols(mol, other)
    actual = Chem.MolToSmiles(mol)
    assert actual == Chem.MolToSmiles(Chem.MolFromSmiles(expected[case['scenario']])), (case['file'], actual)
    assert mol.GetNumAtoms() == case['atoms'] and mol.GetNumBonds() == case['bonds'], case['file']
    results.append({'file': case['file'], 'canonicalSmiles': actual, 'chemistryMatches': True})

report = {'rdkitVersion': rdBase.rdkitVersion, 'cases': results}
(directory / 'independent-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, indent=2))
