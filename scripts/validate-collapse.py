"""Verify flat, contracted and restored CDXML using native RDKit's independent parser."""
import argparse
import json
from pathlib import Path
import sys
import copy
import xml.etree.ElementTree as ET
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dependencies', type=Path)
args = parser.parse_args()
if args.dependencies:
    sys.path.insert(0, str(args.dependencies.resolve()))
from rdkit import Chem, rdBase
directory = Path('docs/validation/collapse')
cases = json.loads((directory / 'adapter-results.json').read_text(encoding='utf8'))['results']
results = []
direct_count = 0
extracted_count = 0
for case in cases:
    for stage in ('original', 'collapsed', 'restored'):
        file = case[stage]
        params = Chem.CDXMLParserParams()
        params.sanitize = True
        params.removeHs = False
        molecules = Chem.MolsFromCDXMLFile(str(directory / file), params)
        assert len(molecules) == 1 and molecules[0] is not None, file
        mol = molecules[0]
        mode = 'direct-file'
        direct_smiles = Chem.MolToSmiles(mol)
        # RDKit 2025.03.6 molzip needs an external connection to remove an
        # abbreviation's display wrapper. A closed whole-molecule label has
        # no such connection. Verify that exact container independently and
        # feed its untouched child fragment to the native chemical parser.
        tree = ET.parse(directory / file)
        root = tree.getroot()
        fragments = root.findall('./page/fragment')
        if stage == 'collapsed' and len(fragments) == 1:
            outer = fragments[0]
            nodes, edges = outer.findall('n'), outer.findall('b')
            if len(nodes) == 1 and not edges and nodes[0].get('NodeType') == 'Fragment':
                nested = nodes[0].findall('fragment')
                assert len(nested) == 1 and not nested[0].findall('.//n[@NodeType="ExternalConnectionPoint"]'), file
                # The only extra parsed component must be the isolated label,
                # never an unexpected chemical component that gets discarded.
                parts = list(Chem.GetMolFrags(mol, asMols=True))
                labels = [p for p in parts if p.GetNumAtoms() == 1 and p.GetAtomWithIdx(0).GetAtomicNum() == 0]
                chemical = [p for p in parts if p not in labels]
                assert len(labels) == 1 and len(chemical) == 1, (file, direct_smiles)
                assert Chem.MolToSmiles(chemical[0]) == case['canonicalIsomericSmiles'], (file, direct_smiles)
                page = root.find('page')
                page.remove(outer)
                page.append(copy.deepcopy(nested[0]))
                molecules = Chem.MolsFromCDXML(ET.tostring(root, encoding='unicode'), params)
                assert len(molecules) == 1 and molecules[0] is not None, file
                mol = molecules[0]
                mode = 'untouched-child-fragment'
        if mode == 'direct-file':
            direct_count += 1
        else:
            extracted_count += 1
        smiles = Chem.MolToSmiles(mol)
        assert smiles == case['canonicalIsomericSmiles'], (file, smiles, case['canonicalIsomericSmiles'])
        assert mol.GetNumAtoms() == case['atomCount'] and mol.GetNumBonds() == case['bondCount'], file
        tags = [label for _, label in Chem.FindMolChiralCenters(mol, includeUnassigned=True) if label != '?']
        assert sorted(tags) == sorted(case['stereoAtoms']), (file, tags, case['stereoAtoms'])
        results.append({'file': file, 'stage': stage, 'mode': mode, 'directParserSmiles': direct_smiles, 'canonicalIsomericSmiles': smiles, 'countsVerified': True, 'stereoAtoms': tags})
(directory / 'independent-results.json').write_text(json.dumps({'rdkitVersion': rdBase.rdkitVersion, 'directFilesValidated': direct_count, 'closedChildrenValidated': extracted_count, 'validated': len(results), 'scope': 'Native parser verifies isomeric SMILES, counts and common stereochemistry. Closed labels without external ports expose a RDKit 2025.03.6 wrapper-fusion limitation: their exact untouched XML child is verified separately after asserting the sole extra native component is one isolated wildcard. These are not counted as direct full-file interoperability. Not commercial ChemDraw certification.', 'results': results}, indent=2) + '\n', encoding='utf8')
print(f'RDKit {rdBase.rdkitVersion}: {direct_count} direct files and {extracted_count} closed-label child fragments verified.')
