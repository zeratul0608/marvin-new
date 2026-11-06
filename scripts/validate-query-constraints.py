"""Independent native-field validation of chemical query conditions.

Uses only ElementTree and struct; never imports the SDK, its projection, RDKit,
or the application's CDX parser. --prepare creates small, original native files.
"""
import argparse
import base64
import json
from pathlib import Path
import struct
import xml.etree.ElementTree as ET

DIRECTORY = Path('docs/validation/query-constraints')
ELEMENTS = ('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split()
ENUMS = {
    'ringBondCount': {-1: 'Unspecified', 0: 'NoRingBonds', 1: 'AsDrawn', 2: 'SimpleRing', 3: 'Fusion', 4: 'SpiroOrHigher'},
    'unsaturatedBonds': {0: 'Unspecified', 1: 'MustBeAbsent', 2: 'MustBePresent'},
    'reactionStereo': {0: 'Unspecified', 1: 'Inversion', 2: 'Retention'},
    'topology': {0: 'Unspecified', 1: 'Ring', 2: 'Chain', 3: 'RingOrChain'},
}
FIELDS = {
    'substituentsExactly': ('SubstituentsExactly', 0x0436, 'B'),
    'substituentsUpTo': ('SubstituentsUpTo', 0x0435, 'B'),
    'ringBondCount': ('RingBondCount', 0x0425, 'b'),
    'unsaturatedBonds': ('UnsaturatedBonds', 0x0426, 'b'),
    'reactionChange': ('RxnChange', 0x0427, ''),
    'reactionStereo': ('RxnStereo', 0x0428, 'b'),
}


def local_name(element):
    return element.tag.rsplit('}', 1)[-1]


def element_symbol(number):
    if not 1 <= number <= len(ELEMENTS):
        raise ValueError(f'Invalid atomic number {number}')
    return ELEMENTS[number - 1]


def checked_count(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 255:
        raise ValueError(f'Query count must be a UINT8, got {value}')
    return value


def number_from_text(value):
    if not value or value.strip() != value or not value.isdecimal():
        raise ValueError(f'Invalid unsigned integer {value!r}')
    return checked_count(int(value))


def xml_constraints(node):
    result = {}
    for field, (attribute, _, _) in FIELDS.items():
        if attribute not in node.attrib:
            continue
        value = node.get(attribute)
        if field in ('substituentsExactly', 'substituentsUpTo'):
            result[field] = number_from_text(value)
        elif field == 'reactionChange':
            if value not in ('yes', 'no'):
                raise ValueError(f'Invalid RxnChange value {value}')
            if value == 'yes':
                result[field] = True
        else:
            if value not in ENUMS[field].values():
                raise ValueError(f'Invalid {attribute} enum {value}')
            result[field] = value
    return result


def decode_xml(file):
    root = ET.parse(file).getroot()
    if local_name(root) != 'CDXML':
        raise ValueError('Expected CDXML root')
    nodes = [node for node in root.iter() if local_name(node) == 'n']
    edges = [edge for edge in root.iter() if local_name(edge) == 'b']
    if any(any(local_name(child) == 'fragment' for child in node) for node in nodes):
        raise ValueError('This independent fixture contract requires flat native graphs')
    ids = [node.get('id') for node in nodes]
    if None in ids or len(set(ids)) != len(ids):
        raise ValueError('Native node identities missing or ambiguous')
    atoms = []
    for node in nodes:
        kind = node.get('NodeType', 'Element')
        atom = {'element': element_symbol(int(node.get('Element', '6'))) if kind == 'Element' else '*'}
        conditions = xml_constraints(node)
        if conditions:
            atom['queryConstraints'] = conditions
        atoms.append(atom)
    bonds = []
    for edge in edges:
        try:
            endpoints = [ids.index(edge.get('B')), ids.index(edge.get('E'))]
        except ValueError as error:
            raise ValueError('Bond references a missing native atom') from error
        text = edge.get('Order', '1')
        order = {'1': 1, '2': 2, '3': 3, '1.5': 'aromatic', '2.5': 2.5, 'any': 'any'}.get(text)
        if order is None:
            raise ValueError(f'Unsupported independent bond order {text}')
        bond = {'atoms': endpoints, 'order': order}
        if 'Topology' in edge.attrib:
            value = edge.get('Topology')
            if value not in ENUMS['topology'].values():
                raise ValueError(f'Invalid Topology {value}')
            bond['topology'] = value
        bonds.append(bond)
    return {'atoms': atoms, 'bonds': bonds}


def parse_cdx(data):
    if data.startswith(b'cdx:base64,'):
        data = base64.b64decode(data.split(b',', 1)[1], validate=True)
    if data[:12] != b'VjCD0100\x04\x03\x02\x01':
        raise ValueError('Invalid CDX magic/endian marker')
    offset = 22 if len(data) >= 24 and data[12:22] == bytes(10) and data[22:24] == b'\x00\x80' else 28
    if data[12:offset] != bytes(offset - 12):
        raise ValueError('Nonzero reserved CDX header bytes')
    root = {'tag': 0x8000, 'id': 0, 'props': {}, 'children': []}
    stack = [root]
    ended = False
    while offset < len(data):
        if offset + 2 > len(data):
            raise ValueError('Truncated CDX tag')
        tag = struct.unpack_from('<H', data, offset)[0]
        offset += 2
        if tag == 0:
            if len(stack) == 1:
                ended = True
                break
            finished = stack.pop()
            if finished['tag'] == 0x8000 and len(stack) == 1 and offset == len(data):
                ended = True
                break
        elif tag & 0x8000:
            if offset + 4 > len(data):
                raise ValueError('Truncated CDX object identity')
            native_id = struct.unpack_from('<I', data, offset)[0]
            offset += 4
            node = {'tag': tag, 'id': native_id, 'props': {}, 'children': []}
            stack[-1]['children'].append(node)
            stack.append(node)
        else:
            if offset + 2 > len(data):
                raise ValueError('Truncated CDX property size')
            length = struct.unpack_from('<H', data, offset)[0]
            offset += 2
            if length == 0xFFFF:
                if offset + 4 > len(data):
                    raise ValueError('Truncated extended CDX property size')
                length = struct.unpack_from('<I', data, offset)[0]
                offset += 4
            if offset + length > len(data) or tag in stack[-1]['props']:
                raise ValueError('Truncated or duplicate CDX property')
            stack[-1]['props'][tag] = data[offset:offset + length]
            offset += length
    if not ended or len(stack) != 1 or any(data[offset:]):
        raise ValueError('CDX object closure/trailing data mismatch')
    return root


def integer(props, tag, kind, default=None):
    if tag not in props:
        if default is not None:
            return default
        raise ValueError(f'Missing CDX property {tag:#06x}')
    value = props[tag]
    if len(value) != struct.calcsize('<' + kind):
        raise ValueError(f'Invalid binary width for CDX {tag:#06x}: {len(value)}')
    return struct.unpack('<' + kind, value)[0]


def flatten(node):
    yield node
    for child in node['children']:
        yield from flatten(child)


def decode_cdx(file):
    root = parse_cdx(Path(file).read_bytes())
    objects = list(flatten(root))
    nodes = [node for node in objects if node['tag'] == 0x8004]
    edges = [node for node in objects if node['tag'] == 0x8005]
    if any(any(child['tag'] == 0x8003 for child in node['children']) for node in nodes):
        raise ValueError('This independent fixture contract requires flat native graphs')
    ids = [node['id'] for node in nodes]
    if len(set(ids)) != len(ids):
        raise ValueError('Native node identities are ambiguous')
    atoms = []
    for node in nodes:
        props = node['props']
        atom = {'element': element_symbol(integer(props, 0x0402, 'H', 6)) if integer(props, 0x0400, 'H', 1) == 1 else '*'}
        conditions = {}
        for field, (_, tag, kind) in FIELDS.items():
            if tag not in props:
                continue
            if field == 'reactionChange':
                if props[tag] != b'':
                    raise ValueError('RxnChange must have exactly zero payload bytes')
                conditions[field] = True
            else:
                value = integer(props, tag, kind)
                if field in ENUMS:
                    if value not in ENUMS[field]:
                        raise ValueError(f'Unknown native enum for {field}: {value}')
                    conditions[field] = ENUMS[field][value]
                else:
                    conditions[field] = checked_count(value)
        if conditions:
            atom['queryConstraints'] = conditions
        atoms.append(atom)
    bonds = []
    for edge in edges:
        props = edge['props']
        endpoints = [integer(props, tag, 'I') for tag in (0x0604, 0x0605)]
        if any(native_id not in ids for native_id in endpoints):
            raise ValueError('Native CDX bond endpoint missing')
        value = integer(props, 0x0600, 'H', 1)
        if value not in (1, 2, 4, 128, 256, 65535):
            raise ValueError(f'Unsupported native bond order {value}')
        bond = {'atoms': [ids.index(native_id) for native_id in endpoints], 'order': {1: 1, 2: 2, 4: 3, 128: 'aromatic', 256: 2.5, 65535: 'any'}[value]}
        if 0x0606 in props:
            value = integer(props, 0x0606, 'b')
            if value not in ENUMS['topology']:
                raise ValueError(f'Unknown CDX Topology {value}')
            bond['topology'] = ENUMS['topology'][value]
        bonds.append(bond)
    return {'atoms': atoms, 'bonds': bonds}


def property_bytes(tag, data):
    return struct.pack('<HH', tag, len(data)) + data


def object_bytes(tag, native_id, content):
    return struct.pack('<HI', tag, native_id) + b''.join(content) + b'\x00\x00'


def encode_fixture(expected):
    nodes = []
    for index, atom in enumerate(expected['atoms']):
        props = [property_bytes(0x0402, struct.pack('<H', ELEMENTS.index(atom['element']) + 1)), property_bytes(0x0200, struct.pack('<ii', 0, index * 30 * 65536))]
        for field, value in atom.get('queryConstraints', {}).items():
            _, tag, kind = FIELDS[field]
            if field == 'reactionChange':
                if value:
                    props.append(property_bytes(tag, b''))
            else:
                if field in ENUMS:
                    value = next(code for code, label in ENUMS[field].items() if label == value)
                props.append(property_bytes(tag, struct.pack('<' + kind, value)))
        nodes.append(object_bytes(0x8004, index + 4, props))
    edges = []
    for index, bond in enumerate(expected['bonds']):
        props = [property_bytes(0x0604, struct.pack('<I', bond['atoms'][0] + 4)), property_bytes(0x0605, struct.pack('<I', bond['atoms'][1] + 4)), property_bytes(0x0600, struct.pack('<H', bond['order']))]
        if 'topology' in bond:
            value = next(code for code, label in ENUMS['topology'].items() if label == bond['topology'])
            props.append(property_bytes(0x0606, struct.pack('<b', value)))
        edges.append(object_bytes(0x8005, index + 4 + len(nodes), props))
    font = struct.pack('<HHHHH', 0, 1, 3, 1252, 5) + b'Arial'
    return b'VjCD0100\x04\x03\x02\x01' + bytes(16) + property_bytes(0x0100, font) + object_bytes(0x8001, 2, [object_bytes(0x8003, 3, nodes + edges)]) + b'\x00\x00'


def xml_fixture(expected, explicit_no=False):
    root = ET.Element('CDXML')
    fragment = ET.SubElement(ET.SubElement(root, 'page', id='2'), 'fragment', id='3')
    for index, atom in enumerate(expected['atoms']):
        node = ET.SubElement(fragment, 'n', id=str(index + 4), p=f'{index * 30} 0', Element=str(ELEMENTS.index(atom['element']) + 1))
        for field, value in atom.get('queryConstraints', {}).items():
            node.set(FIELDS[field][0], 'yes' if field == 'reactionChange' and value else str(value))
        if explicit_no and index == 0:
            node.set('RxnChange', 'no')
    for index, bond in enumerate(expected['bonds']):
        edge = ET.SubElement(fragment, 'b', id=str(index + 4 + len(expected['atoms'])), B=str(bond['atoms'][0] + 4), E=str(bond['atoms'][1] + 4), Order=str(bond['order']))
        if 'topology' in bond:
            edge.set('Topology', bond['topology'])
    return ET.tostring(root, encoding='unicode') + '\n'


def prepare(directory):
    scenarios = [
        ('all-fields', {'substituentsExactly': 2, 'substituentsUpTo': 4, 'ringBondCount': 'Fusion', 'unsaturatedBonds': 'MustBePresent', 'reactionChange': True, 'reactionStereo': 'Inversion'}, 'Ring'),
        ('zero-explicit-default', {'substituentsExactly': 0, 'substituentsUpTo': 0, 'ringBondCount': 'Unspecified', 'unsaturatedBonds': 'Unspecified', 'reactionStereo': 'Unspecified'}, 'Unspecified'),
        ('max-count-255', {'substituentsExactly': 255, 'substituentsUpTo': 255, 'ringBondCount': 'SpiroOrHigher', 'unsaturatedBonds': 'MustBeAbsent', 'reactionStereo': 'Retention'}, 'RingOrChain'),
        ('empty-presence-rxn-change', {'reactionChange': True}, 'Chain'),
        ('as-drawn', {'ringBondCount': 'AsDrawn'}, 'RingOrChain'),
        ('simple-ring', {'ringBondCount': 'SimpleRing'}, 'Ring'),
        ('no-ring', {'ringBondCount': 'NoRingBonds'}, 'Chain'),
    ]
    directory.mkdir(parents=True, exist_ok=True)
    results = []
    for scenario, conditions, topology in scenarios:
        expected = {'atoms': [{'element': 'C', 'queryConstraints': conditions}, {'element': 'N'}], 'bonds': [{'atoms': [0, 1], 'order': 1, 'topology': topology}]}
        for format in ('cdxml', 'cdx'):
            file = f'native-{scenario}.{format}'
            path = directory / file
            if format == 'cdx':
                path.write_bytes(encode_fixture(expected))
            else:
                path.write_text(xml_fixture(expected, scenario == 'zero-explicit-default'), encoding='utf8')
            actual = decode_cdx(path) if format == 'cdx' else decode_xml(path)
            if actual != expected:
                raise AssertionError(f'Independent fixture self-check failed: {file}')
            results.append({'scenario': scenario, 'file': file, 'format': format, 'expected': expected})
    manifest = {'scope': 'Own original native fixtures from published CDX/CDXML types. Conditions can contradict the drawn graph; no concrete molecule or successful database match is claimed.', 'filesPrepared': len(results), 'results': results}
    (directory / 'native-fixtures.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
    print(f'Prepared and independently decoded {len(results)} native query fixtures.')


def validate(directory, adapter):
    results, failures = [], []
    for entry in adapter['results']:
        file = entry['file']
        try:
            format = entry.get('format', Path(file).suffix[1:])
            actual = decode_cdx(directory / file) if format == 'cdx' else decode_xml(directory / file)
            if actual != entry['expected']:
                raise ValueError(f'Native fields differ: actual={actual!r}; expected={entry["expected"]!r}')
            results.append({'scenario': entry.get('scenario'), 'file': file, 'format': format, 'nativeFields': actual, 'byteWidthsAndEnumsChecked': True, 'reactionChangeZeroLengthChecked': format == 'cdx'})
        except (ValueError, KeyError, OSError, ET.ParseError, struct.error) as error:
            failures.append({'file': file, 'error': str(error)[:2000]})
    report = {'validator': 'Python standard-library ElementTree and independent little-endian CDX decoder', 'scope': 'Checks the exact seven native query fields, concrete element identity, connectivity, enum values and binary lengths. Does not evaluate Markush sets, database matching or reaction feasibility.', 'summary': {'targeted': len(adapter['results']), 'validated': len(results), 'failures': len(failures)}, 'results': results, 'failures': failures}
    (directory / 'independent-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print(json.dumps(report['summary']))
    if failures:
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=DIRECTORY)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--manifest', type=Path)
    args = parser.parse_args()
    if args.prepare:
        prepare(args.directory)
    else:
        manifest = args.manifest or args.directory / 'adapter-results.json'
        validate(args.directory, json.loads(manifest.read_text(encoding='utf8')))


if __name__ == '__main__':
    main()
