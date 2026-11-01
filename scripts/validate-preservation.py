"""Independently read outputs from validate-preservation-browser.mjs with RDKit."""
import argparse
import hashlib
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

assert Chem.HasChemDrawCDXSupport(), 'RDKit binary CDX support is required'
directory = Path('docs/validation/preservation')
original = Path('tests/fixtures/cdx/dimethylamine-styled.cdx').read_bytes()
assert (directory / 'original-styled.cdx').read_bytes() == original
params = Chem.CDXMLParserParams()
params.format = Chem.CDXMLFormat.CDX
params.removeHs = False

def combine(molecules):
    assert molecules and all(m is not None for m in molecules)
    mol = molecules[0]
    for other in molecules[1:]:
        mol = Chem.CombineMols(mol, other)
    return mol

results = []
for name, smiles, binary in [('styled-moved.cdx', 'CNC', True), ('ethanol-18o-anion.cdx', 'CC[18O-]', True),
                             ('ethanol-18o-anion.cdxml', 'CC[18O-]', False)]:
    molecules = Chem.MolsFromCDXMLFile(str(directory / name), params) if binary else Chem.MolsFromCDXMLFile(str(directory / name))
    mol = combine(molecules)
    actual = Chem.MolToSmiles(mol)
    assert actual == Chem.MolToSmiles(Chem.MolFromSmiles(smiles)), (name, actual)
    results.append({'file': name, 'canonicalSmiles': actual, 'independentlyReadable': True, 'chemistryMatches': True})

text = (directory / 'annotated-moved.cdxml').read_text(encoding='utf-8')
root = ET.fromstring(text)
assert root.find('.//font').get('name') == 'Courier'
assert root.find('.//graphic').attrib == {'id': '7', 'GraphicType': 'Rectangle', 'BoundingBox': '40 40 80 80'}
assert ''.join(root.find('.//t').itertext()) == 'keep <text> & symbols'
assert root.find('.//n').get('id') == '3' and root.find('.//n').get('p') == '10 -5'
assert '<!-- independent text and graphic -->' in text
assert '<![CDATA[keep <text> & symbols]]>' in text
assert '<!DOCTYPE CDXML SYSTEM "http://example.invalid/cdxml.dtd">' in text
assert text.count('<?xml') == 1

report = {'rdkitVersion': rdBase.rdkitVersion, 'originalBytesIdentical': True,
          'originalSha256': hashlib.sha256(original).hexdigest(), 'cases': results,
          'annotatedXml': {'syntaxValid': True, 'fontPreserved': True, 'graphicPreserved': True,
                           'textPreserved': True, 'cdataPreserved': True, 'commentPreserved': True,
                           'doctypePreserved': True, 'atomIdPreserved': True, 'editedPositionMatches': True}}
(directory / 'independent-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, indent=2))
