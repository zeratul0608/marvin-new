"""Independently decode our polymer CDX bytes and CDXML references with Python stdlib."""
import json
from pathlib import Path
import struct
import xml.etree.ElementTree as ET

directory = Path('docs/validation/polymers')
cases = json.loads((directory / 'adapter-results.json').read_text(encoding='utf8'))['results']
usages = ['Unspecified', 'Unused1', 'Unused2', 'SRU', 'Monomer', 'Mer', 'Copolymer', 'CopolymerAlternating', 'CopolymerRandom', 'CopolymerBlock', 'Crosslink', 'Graft', 'Modification', 'Component', 'MixtureUnordered', 'MixtureOrdered', 'MultipleGroup', 'Generic', 'Anypolymer']

def binary_xml(data):
    assert data[:12] == b'VjCD0100\x04\x03\x02\x01'
    names = {0x8000: 'CDXML', 0x8001: 'page', 0x8003: 'fragment', 0x8004: 'n', 0x8005: 'b', 0x8007: 'graphic', 0x8017: 'bracketedgroup', 0x8018: 'bracketattachment', 0x8019: 'crossingbond'}
    references = {0x604: 'B', 0x605: 'E', 0xa27: 'BracketedObjectIDs', 0xa2b: 'GraphicID', 0xa2c: 'BondID', 0xa2d: 'InnerAtomID'}
    enums = {0xa24: ('BracketUsage', usages), 0xa25: ('PolymerRepeatPattern', ['HeadToTail', 'HeadToHead', 'EitherUnknown']), 0xa26: ('PolymerFlipType', ['Unspecified', 'NoFlip', 'Flip'])}
    cursor = 22
    def obj(tag):
        nonlocal cursor
        native_id, = struct.unpack_from('<I', data, cursor)
        cursor += 4
        node = ET.Element(names[tag], {'id': str(native_id)})
        while True:
            field, = struct.unpack_from('<H', data, cursor)
            cursor += 2
            if field == 0:
                return node
            if field & 0x8000:
                node.append(obj(field))
                continue
            length, = struct.unpack_from('<H', data, cursor)
            cursor += 2
            if length == 0xffff:
                length, = struct.unpack_from('<I', data, cursor)
                cursor += 4
            raw = data[cursor:cursor + length]
            assert len(raw) == length
            cursor += length
            if field in references:
                assert length % 4 == 0
                node.set(references[field], ' '.join(str(x[0]) for x in struct.iter_unpack('<I', raw)))
            elif field in enums:
                name, values = enums[field]
                node.set(name, values[int.from_bytes(raw, 'little')])
            elif field == 0xa28:
                assert length == 8
                node.set('RepeatCount', str(struct.unpack('<d', raw)[0]))
            elif field == 0xa29:
                assert length == 2
                node.set('ComponentOrder', str(struct.unpack('<h', raw)[0]))
            elif field == 0xa2a:
                styles, = struct.unpack_from('<H', raw)
                node.set('SRULabel', raw[2 + styles * 10:].decode('ascii'))
    tag, = struct.unpack_from('<H', data, cursor)
    cursor += 2
    root = obj(tag)
    assert cursor == len(data)
    return root

results = []
for case in cases:
    path = directory / case['file']
    root = binary_xml(path.read_bytes()) if case['format'] == 'cdx' else ET.parse(path).getroot()
    by_id = {el.get('id'): el for el in root.iter() if el.get('id')}
    atoms = [el.get('id') for el in root.iter('n')]
    bonds = [el.get('id') for el in root.iter('b')]
    def members(group, active=None):
        active = set() if active is None else set(active)
        assert group.get('id') not in active
        active.add(group.get('id'))
        found = set()
        for ref in group.get('BracketedObjectIDs', '').split():
            node = by_id[ref]
            if node.tag == 'n':
                found.add(ref)
            elif node.tag == 'bracketedgroup':
                found.update(members(node, active))
            elif node.tag == 'fragment':
                found.update(n.get('id') for n in node.iter('n'))
            else:
                raise AssertionError(node.tag)
        return found
    actual = []
    for group in root.iter('bracketedgroup'):
        inside = members(group)
        item = {'usage': group.get('BracketUsage', 'Unspecified'), 'repeatPattern': group.get('PolymerRepeatPattern', 'HeadToTail'), 'flipType': group.get('PolymerFlipType', 'Unspecified'), 'atomIndices': sorted(atoms.index(i) for i in inside), 'crossings': []}
        if group.get('RepeatCount') is not None:
            item['repeatCount'] = float(group.get('RepeatCount'))
        if group.get('SRULabel') is not None:
            item['label'] = group.get('SRULabel')
        for attachment in group.findall('bracketattachment'):
            assert by_id[attachment.get('GraphicID')].tag == 'graphic'
            for crossing in attachment.findall('crossingbond'):
                bond_id, inner_id = crossing.get('BondID'), crossing.get('InnerAtomID')
                bond = by_id[bond_id]
                endpoints = [bond.get('B'), bond.get('E')]
                assert inner_id in inside and inner_id in endpoints
                assert sum(e in inside for e in endpoints) == 1
                item['crossings'].append({'bondIndex': bonds.index(bond_id), 'innerAtomIndex': atoms.index(inner_id)})
        actual.append(item)
    assert actual == case['groups'], (case['file'], actual, case['groups'])
    results.append({'file': case['file'], 'groups': actual, 'nativeReferencesVerified': True})
(directory / 'independent-results.json').write_text(json.dumps({'validator': 'Python stdlib struct + ElementTree; does not invoke the application parser or RDKit.', 'validated': len(results), 'scope': 'Bracket usage, FLOAT64 repeat count, nested members, graphic/attachment/bond/inner-atom references. Does not certify general polymer expansion or commercial ChemDraw behavior.', 'results': results}, indent=2) + '\n', encoding='utf8')
print(f'{len(results)} polymer CDX/CDXML files independently verified.')
