"""Native RDKit independently interprets both collapsed CDXML and expanded CDX/CDXML."""
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
directory = Path('docs/validation/expansion')
cases = json.loads((directory / 'adapter-results.json').read_text(encoding='utf8'))['results']
originals = {}
results = []
for case in cases:
    scenario = case['scenario']
    if scenario not in originals:
        molecules = Chem.MolsFromCDXMLFile(str(directory / f'{scenario}-original.cdxml'))
        assert len(molecules) == 1 and molecules[0] is not None, scenario
        originals[scenario] = Chem.MolToSmiles(molecules[0])
    params = Chem.CDXMLParserParams()
    params.format = Chem.CDXMLFormat.CDX if case['format'] == 'cdx' else Chem.CDXMLFormat.CDXML
    params.sanitize = True
    params.removeHs = False
    molecules = Chem.MolsFromCDXMLFile(str(directory / case['file']), params)
    assert len(molecules) == 1 and molecules[0] is not None, case['file']
    mol = molecules[0]
    smiles = Chem.MolToSmiles(mol)
    assert smiles == originals[scenario] == case['canonicalIsomericSmiles'], (case['file'], smiles, originals[scenario], case['canonicalIsomericSmiles'])
    assert mol.GetNumAtoms() == case['atomCount'] and mol.GetNumBonds() == case['bondCount'], case['file']
    stereo = [tag for _, tag in Chem.FindMolChiralCenters(mol, includeUnassigned=True) if tag != '?']
    assert sorted(stereo) == sorted(case['stereoAtoms']), (case['file'], stereo)
    results.append({'file': case['file'], 'canonicalIsomericSmiles': smiles, 'matchesOriginalCollapsedCDXML': True, 'countsVerified': True, 'stereoAtoms': stereo})
report = {'rdkitVersion': rdBase.rdkitVersion, 'originalFiles': len(originals), 'expandedFiles': len(results), 'scope': 'Native Python RDKit independently interprets the original nested CDXML and expanded CDX/CDXML, then compares canonical isomeric SMILES, atom/bond counts and R/S. Independent runtime and parser, same chemistry toolkit family; not ChemDraw certification.', 'originals': originals, 'results': results}
(directory / 'independent-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(f'RDKit {rdBase.rdkitVersion}: {len(originals)} original nested structures match {len(results)} expanded outputs.')
