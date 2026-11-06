"""Independently parse browser downloads using RDKit; explicitly exclude unsupported template-boundary semantics."""
import argparse
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dependencies', type=Path)
args = parser.parse_args()
if args.dependencies:
    sys.path.insert(0, str(args.dependencies.resolve()))
from rdkit import Chem, rdBase

directory = Path('docs/validation/chemdraw26')
browser = json.loads((directory / 'browser-results.json').read_text(encoding='utf8'))
references = {'ethanol': 'CCO', 'aspirin': 'CC(=O)Oc1ccccc1C(=O)O',
              'caffeine': 'Cn1c(=O)c2c(ncn2C)n(C)c1=O', 'benzene': 'c1ccccc1',
              'singlet': '[CH2]', 'doublet': '[CH3]', 'triplet': '[CH2]',
              'dashed': 'CCO', 'bold': 'CCO', 'hash': 'CCO',
              'double-left': 'C=CO', 'double-right': 'C=CO'}
results = []
for case in browser['results']:
    file, scenario = case['file'], case['scenario']
    if scenario == 'attachment':
        # RDKit 2025.03.6 misinterprets a top-level ExternalConnectionPoint as C.
        # Do not count an accepted parse as evidence of correct template semantics.
        results.append({'file': file, 'independentChemistryValidation': False,
                        'reason': 'RDKit does not correctly represent standalone ChemDraw external connection points; browser/native field tests cover them.'})
        if case['format'] == 'cdxml':
            root = ET.parse(directory / file).getroot()
            nodes = [n for n in root.iter('n') if n.get('NodeType') == 'ExternalConnectionPoint']
            assert len(nodes) == 1 and 'Element' not in nodes[0].attrib
        continue
    params = Chem.CDXMLParserParams()
    params.format = Chem.CDXMLFormat.CDX if case['format'] == 'cdx' else Chem.CDXMLFormat.CDXML
    params.sanitize = True
    params.removeHs = False
    molecules = Chem.MolsFromCDXMLFile(str(directory / file), params)
    assert molecules and all(m is not None for m in molecules), file
    mol = molecules[0]
    for other in molecules[1:]:
        mol = Chem.CombineMols(mol, other)
    smiles = Chem.MolToSmiles(mol)
    expected = Chem.MolToSmiles(Chem.MolFromSmiles(references[scenario]))
    assert smiles == expected, (file, smiles, expected)
    assert mol.GetNumAtoms() == case['atoms'] and mol.GetNumBonds() == case['bonds'], file
    radicals = sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms())
    assert radicals == (1 if scenario == 'doublet' else 2 if scenario in ('singlet', 'triplet') else 0), file
    results.append({'file': file, 'independentChemistryValidation': True,
                    'canonicalSmiles': smiles, 'radicalElectrons': radicals})

report = {'rdkitVersion': rdBase.rdkitVersion, 'validated': sum(r['independentChemistryValidation'] for r in results),
          'notValidated': sum(not r['independentChemistryValidation'] for r in results),
          'scope': 'Connectivity, counts and radical electron counts. RDKit does not certify singlet/triplet spin distinction or exact depiction/layout.',
          'cases': results}
(directory / 'independent-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(f"RDKit {rdBase.rdkitVersion}: {report['validated']} chemical files verified; {report['notValidated']} template files explicitly excluded.")
