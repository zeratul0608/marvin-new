"""Direct CDX cross-validation with a separately installed RDKit build.

Run after validate-cdx-browser.mjs, from the repository root:
  python scripts/validate-cdx.py --dependencies .local/cdx-reference/validation-deps
Use --generate-fixtures only to regenerate the three RDKit-authored inputs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dependencies', type=Path)
parser.add_argument('--generate-fixtures', action='store_true')
args = parser.parse_args()
if args.dependencies:
    sys.path.insert(0, str(args.dependencies.resolve()))
from rdkit import Chem, rdBase
from rdkit.Chem import rdChemDraw, rdDepictor

assert Chem.HasChemDrawCDXSupport(), 'This RDKit build lacks binary CDX support'
expected = {
    'dimethylamine-simple': 'CNC', 'dimethylamine-styled': 'CNC',
    'rdkit-ethanol': 'CCO', 'rdkit-benzene': 'c1ccccc1',
    'rdkit-isotopes-charges': '[13CH3][15NH3+].[Cl-]',
}
if args.generate_fixtures:
    for name in ('rdkit-ethanol', 'rdkit-benzene', 'rdkit-isotopes-charges'):
        mol = Chem.MolFromSmiles(expected[name])
        rdDepictor.Compute2DCoords(mol)
        try:
            block = rdChemDraw.MolToChemDrawBlock(mol, rdChemDraw.CDXFormat.CDX)
            binary = block if isinstance(block, bytes) else block.encode('utf-8')
        except UnicodeDecodeError as error:
            # RDKit 2025.03.6's Python binding decodes a binary std::string as UTF-8.
            # Recover the original byte string supplied to that decoder, unchanged.
            binary = error.object
        assert binary.startswith(b'VjCD0100'), 'Unexpected RDKit CDX serialization'
        (Path('tests/fixtures/cdx') / (name + '.cdx')).write_bytes(binary)
    print('Regenerated RDKit fixtures; rerun the browser validator before validating outputs.')
    sys.exit(0)

directory = Path('docs/validation/cdx')
browser = json.loads((directory / 'browser-results.json').read_text(encoding='utf-8'))
params = Chem.CDXMLParserParams()
params.format = Chem.CDXMLFormat.CDX
params.sanitize = True
params.removeHs = False

def combine(molecules):
    assert molecules and all(m is not None for m in molecules), 'No molecule returned'
    mol = molecules[0]
    for extra in molecules[1:]:
        mol = Chem.CombineMols(mol, extra)
    return mol

def signature(mol):
    return Chem.MolToSmiles(mol)

results = []
for name, smiles in expected.items():
    path = directory / (name + '.cdx')
    data = path.read_bytes()
    assert data == (Path('tests/fixtures/cdx') / path.name).read_bytes(), 'Original bytes changed'
    canonical = signature(Chem.MolFromSmiles(smiles))
    raw_molecules = Chem.MolsFromCDXMLFile(str(path), params)
    raw_verified = bool(raw_molecules)
    if raw_verified:
        assert signature(combine(raw_molecules)) == canonical, name
    else:
        # The archived 165-byte minimal SDK example is accepted by our parser,
        # but this RDKit build returns zero molecules. Report, never call it a pass.
        assert name == 'dimethylamine-simple', f'{name}: unexpected empty CDX result'
    cdxml = combine(Chem.MolsFromCDXMLFile(str(directory / (name + '.cdxml'))))
    mol = Chem.MolFromMolFile(str(directory / (name + '.mol')), sanitize=True, removeHs=False)
    assert mol is not None, name
    assert signature(cdxml) == canonical and signature(mol) == canonical, name
    browser_case = next(c for c in browser['cases'] if c['file'] == path.name)
    assert cdxml.GetNumAtoms() == mol.GetNumAtoms() == browser_case['atoms'], name
    assert cdxml.GetNumBonds() == mol.GetNumBonds() == browser_case['bonds'], name
    digest = hashlib.sha256(data).hexdigest()
    assert digest == browser_case['sha256'], name
    results.append({'file': path.name, 'sha256': digest, 'directBinaryVerified': raw_verified,
                    'directBinaryOutcome': 'matched' if raw_verified else 'empty-result; external-reader limitation',
                    'canonicalSmiles': canonical, 'convertedCdxmlVerified': True, 'convertedMolVerified': True})

stereo = combine(Chem.MolsFromCDXMLFile(str(directory / 'rdkit-ring-stereo1.cdx'), params))
assert signature(stereo) == signature(Chem.MolFromSmiles('C1CC[C@H]2CCCC[C@H]2C1'))
negative = next(c for c in browser['failures'] if c['name'] == 'unsupported-ring-stereo')
assert negative['rejected'] and negative['documentUnchanged']
report = {'rdkitVersion': rdBase.rdkitVersion, 'binaryCdxSupported': True, 'cases': results,
          'unsupportedValidInput': {'file': 'rdkit-ring-stereo1.cdx', 'canonicalSmiles': signature(stereo),
                                    'independentlyReadable': True, 'editorRejectedWithoutChanges': True,
                                    'editorMessage': negative['message']}}
(directory / 'rdkit-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, indent=2))
