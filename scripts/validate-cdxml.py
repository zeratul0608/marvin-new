"""Independently validate the checked-in browser-downloaded CDXML artifacts.

Install RDKit separately, then run from the repository root:
  python scripts/validate-cdxml.py --dependencies .local/cdx-reference/validation-deps
The application has no RDKit runtime dependency.
"""
import argparse
import json
import math
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dependencies', type=Path)
args = parser.parse_args()
if args.dependencies:
    sys.path.insert(0, str(args.dependencies.resolve()))
from rdkit import Chem, rdBase

directory = Path('docs/validation/cdxml')
expected = {
    'cdx-simple': 'CNC',
    'cdx-styled': 'CNC',
    'cdxml-simple-edited': 'C[15NH]C',
    'cdxml-styled-edited': 'C[15NH]C',
    'ethanol-mrv': 'CCO',
    'aspirin': 'CC(=O)Oc1ccccc1C(=O)O',
    'isotopes-charges-hydrogens': '[13CH3][15NH3+].[Cl-]',
    'wedge': 'FC(Cl)(Br)I',
}
results = []
for name, smiles in expected.items():
    path = directory / (name + '.cdxml')
    root = ET.parse(path).getroot()
    assert root.tag == 'CDXML', path
    nodes, bonds = root.findall('.//n'), root.findall('.//b')
    ids = [e.attrib['id'] for e in root.iter() if e.tag in ('page', 'fragment', 'n', 'b')]
    assert len(ids) == len(set(ids)), f'{name}: duplicate IDs'
    node_ids = {e.attrib['id'] for e in nodes}
    for node in nodes:
        point = [float(v) for v in node.attrib['p'].split()]
        assert len(point) == 2 and all(map(math.isfinite, point)), name
    for bond in bonds:
        assert bond.attrib['B'] in node_ids and bond.attrib['E'] in node_ids, name
    molecules = Chem.MolsFromCDXMLFile(str(path), sanitize=True, removeHs=False)
    assert molecules and all(m is not None for m in molecules), f'{name}: RDKit rejected output'
    molecule = molecules[0]
    for extra in molecules[1:]:
        molecule = Chem.CombineMols(molecule, extra)
    assert molecule.GetNumAtoms() == len(nodes) and molecule.GetNumBonds() == len(bonds), name
    reference = Chem.MolFromSmiles(smiles)
    # Remove stereo only for comparing connectivity. Preserve isotope, charge and H counts.
    # Wedge depiction is checked separately below; the editor does not assign CIP labels.
    comparison, reference_comparison = Chem.Mol(molecule), Chem.Mol(reference)
    Chem.RemoveStereochemistry(comparison)
    Chem.RemoveStereochemistry(reference_comparison)
    actual = Chem.MolToSmiles(comparison)
    assert actual == Chem.MolToSmiles(reference_comparison), f'{name}: {actual} != {smiles}'
    attributes = lambda m: sorted((a.GetAtomicNum(), a.GetIsotope(), a.GetFormalCharge(), a.GetTotalNumHs()) for a in m.GetAtoms())
    assert attributes(molecule) == attributes(reference), f'{name}: isotope/charge/H mismatch'
    centers = Chem.FindMolChiralCenters(molecule, includeUnassigned=True)
    if name == 'wedge':
        assert len(centers) == 1 and centers[0][1] in ('R', 'S'), 'RDKit did not read the wedge depiction'
    results.append({'file': path.name, 'atoms': molecule.GetNumAtoms(), 'bonds': molecule.GetNumBonds(),
                    'canonicalSmiles': Chem.MolToSmiles(molecule), 'chiralCenters': centers,
                    'xmlValid': True, 'chemistryMatches': True})

report = {'rdkitVersion': rdBase.rdkitVersion, 'cases': results}
(directory / 'rdkit-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, indent=2))
