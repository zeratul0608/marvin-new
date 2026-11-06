"""Independently compare private expanded-group CDXML with its original XML.

Uses only Python's ElementTree. It does not import the application's parser,
projection, graph matcher or edit implementation, and never publishes source XML.
"""
import argparse
from collections import Counter
import copy
import json
from pathlib import Path
import xml.etree.ElementTree as ET

MARKER = 'MoleculeWorkbench.ExpandedView'
MARKER_ATTRIBUTES = {'Name', 'TagType', 'Value', 'Persistent', 'Visible', 'id', 'DisplayName', 'Tracking', 'PositioningType', 'PositioningAngle', 'PositioningOffset'}
REFERENCES = set('AltGroupID Attachments B BasisObjects BondCircularOrdering BondID BondOrdering BracketedObjectIDs ChemicalPropertyDisplayID ConnectionOrder CrossingBonds E GraphicID InnerAtomID ReactionStepArrows ReactionStepAtomMap ReactionStepAtomMapAuto ReactionStepAtomMapManual ReactionStepObjectsAboveArrow ReactionStepObjectsBelowArrow ReactionStepPlusses ReactionStepProducts ReactionStepReactants RepresentsProperty SplitterPositions SupersededBy object ArrowSource ArrowTarget'.split())
MASS_BASELINE = {1: 1, 6: 12, 7: 14, 8: 16, 16: 32, 15: 31, 9: 19, 17: 35, 35: 79, 53: 127}
QUERY_TYPES = {'ElementList', 'GenericNickname', 'Unspecified'}
NESTED_TYPES = {'Fragment', 'Nickname', 'Unspecified', 'AnonymousAlternativeGroup'}
OTHER_VIRTUAL_TYPES = {'Fragment', 'Nickname', 'ExternalConnectionPoint', 'MultiAttachment', 'AnonymousAlternativeGroup'}
NUMERIC_LAYOUT = {'p', 'BoundingBox', 'xyz', 'Head3D', 'Tail3D', 'Center3D', 'MajorAxisEnd3D', 'MinorAxisEnd3D', 'CurvePoints'}


def name(element):
    return element.tag.rsplit('}', 1)[-1]


def children(element, tag):
    return [child for child in element if name(child) == tag]


def text(value):
    # Ignore indentation between XML objects, retaining meaningful label spaces.
    return '' if value is None or not value.strip() else value


def canonical(element):
    return (element.tag, tuple(sorted(element.attrib.items())), text(element.text), text(element.tail), tuple(canonical(child) for child in element))


def segment(element):
    return f'{name(element)}[@id={element.get("id")}]' if element.get('id') else name(element)


def scoped_nodes(fragment):
    result = []
    def visit(parent):
        for child in parent:
            if name(child) == 'n':
                result.append(child)
            else:
                visit(child)
    visit(fragment)
    return result


def nested(node):
    return node.get('NodeType') in NESTED_TYPES and bool(children(node, 'fragment'))


def top_wrapper(root, native_id):
    matches = []
    def visit(parent):
        for child in parent:
            if name(child) == 'n':
                if child.get('id') == native_id:
                    matches.append(child)
            else:
                visit(child)
    visit(root)
    if len(matches) != 1:
        raise ValueError(f'Expected one top-level wrapper {native_id}; found {len(matches)}')
    if not nested(matches[0]):
        raise ValueError(f'Target {native_id} is no longer a nested chemical group')
    return matches[0]


def remove_markers(root):
    result = copy.deepcopy(root)
    marked = []
    for parent in result.iter():
        markers = [child for child in parent if name(child) == 'objecttag' and child.get('Name') == MARKER]
        if len(markers) > 1:
            raise ValueError(f'Duplicate ExpandedView markers on {segment(parent)}')
        for marker in markers:
            if name(parent) != 'n' or not nested(parent):
                raise ValueError('ExpandedView marker is not attached to a nested chemical node')
            if set(marker.attrib) - MARKER_ATTRIBUTES or marker.get('TagType') != 'String' or marker.get('Value') != '1' or len(marker) or text(marker.text) or text(marker.tail):
                raise ValueError(f'Invalid ExpandedView marker on {segment(parent)}')
            if any(marker.get(key) not in (None, 'yes', 'no') for key in ('Persistent', 'Visible', 'Tracking')):
                raise ValueError('Invalid ExpandedView marker boolean')
            marked.append(parent.get('id'))
            parent.remove(marker)
    return result, marked


def compare_exact(before, after, path='CDXML', differences=None):
    differences = [] if differences is None else differences
    if before.tag != after.tag:
        differences.append({'path': path, 'field': 'tag', 'before': before.tag, 'after': after.tag})
        return differences
    for key in sorted(set(before.attrib) | set(after.attrib)):
        if before.get(key) != after.get(key):
            differences.append({'path': path, 'field': key, 'before': before.get(key), 'after': after.get(key)})
    for key in ('text', 'tail'):
        if text(getattr(before, key)) != text(getattr(after, key)):
            differences.append({'path': path, 'field': key, 'before': text(getattr(before, key)), 'after': text(getattr(after, key))})
    if len(before) != len(after):
        differences.append({'path': path, 'field': 'children', 'before': len(before), 'after': len(after)})
    for index, (left, right) in enumerate(zip(before, after)):
        compare_exact(left, right, f'{path}/{segment(left)}[{index}]', differences)
    return differences


def identities(root):
    result = []
    def visit(element, owners):
        kind = name(element)
        if kind in ('n', 'b', 'fragment'):
            native_id = element.get('id')
            if kind in ('n', 'fragment') and not native_id:
                raise ValueError(f'{kind} is missing its native identity')
            result.append((kind, native_id, tuple(owners)))
            owners = owners + [(kind, native_id)]
        for child in element:
            visit(child, owners)
    visit(root, [])
    return result


def reference_signature(root):
    result = []
    def visit(element, path):
        path = path + [segment(element)]
        for key in sorted(REFERENCES & set(element.attrib)):
            result.append(('/'.join(path), key, tuple(element.get(key).split())))
        for child in element:
            visit(child, path)
    visit(root, [])
    return result


def boundary_signature(root):
    parents = {child: parent for parent in root.iter() for child in parent}
    groups = []
    for node in root.iter():
        if name(node) != 'n' or not nested(node):
            continue
        adjacent = [bond for bond in children(parents[node], 'b') if node.get('id') in (bond.get('B'), bond.get('E'))]
        external = node.get('BondOrdering', '').split() or [bond.get('id') for bond in adjacent]
        branches = []
        for fragment in children(node, 'fragment'):
            ports = [atom for atom in scoped_nodes(fragment) if atom.get('NodeType') == 'ExternalConnectionPoint']
            inferred = [port.get('id') for port in sorted(ports, key=lambda p: int(p.get('ExternalConnectionNum', '0')))]
            order = fragment.get('ConnectionOrder', '').split() or inferred
            port_edges = [(port.get('id'), tuple((bond.get('id'), bond.get('B'), bond.get('E'), bond.get('Order', '1')) for bond in children(fragment, 'b') if port.get('id') in (bond.get('B'), bond.get('E')))) for port in ports]
            branches.append((fragment.get('id'), tuple(order), tuple(port_edges)))
        groups.append((node.get('id'), tuple(external), tuple(branches)))
    return groups


def ordinary(node):
    kind = node.get('NodeType', 'Element')
    return not nested(node) and kind not in QUERY_TYPES | OTHER_VIRTUAL_TYPES


def query_label(node):
    return node.get('GenericNickname', ''.join(node.itertext()).strip()) if node.get('NodeType') == 'GenericNickname' else ''.join(node.itertext()).strip() or None


def expected_edit(fragment, depth=0):
    if depth >= 16:
        raise ValueError('Expected edit recursion exceeded 16 levels')
    nodes = scoped_nodes(fragment)
    # Exact priority used by the audit: ordinary -> query -> nested first branch.
    atom = next((node for node in nodes if ordinary(node)), None)
    if atom is not None:
        prior = int(atom.get('Isotope', '0'))
        mass = (prior if prior else MASS_BASELINE.get(int(atom.get('Element', '6')), 100)) + 1
        return {'kind': 'nested-' * depth + 'isotope', 'nativeId': atom.get('id'), 'beforeIsotope': prior or None, 'afterIsotope': mass}
    atom = next((node for node in nodes if not nested(node) and node.get('NodeType') in QUERY_TYPES), None)
    if atom is not None:
        if atom.get('NodeType') == 'ElementList':
            raise ValueError('Audit query-position fallback does not meet the required actual chemistry/query edit')
        before = query_label(atom)
        return {'kind': 'nested-' * depth + 'query-condition', 'nativeId': atom.get('id'), 'beforeQuery': before, 'afterQuery': (before if before is not None else 'query') + '_edited'}
    atom = next((node for node in nodes if nested(node)), None)
    if atom is not None:
        return expected_edit(children(atom, 'fragment')[0], depth + 1)
    raise ValueError('Branch contains no actual editable chemical/query content')


def numeric_layout_equal(before, after):
    try:
        left, right = [float(v) for v in before.split()], [float(v) for v in after.split()]
        return bool(left) and len(left) == len(right) and all(abs(a - b) <= 1e-9 for a, b in zip(left, right))
    except (ValueError, AttributeError):
        return False


def compare_edited(before, after, edits, allowed, differences, port_additions, path='CDXML'):
    if before.tag != after.tag:
        differences.append({'path': path, 'field': 'tag', 'before': before.tag, 'after': after.tag})
        return
    kind = name(before)
    edit = edits.get(before.get('id')) if kind == 'n' else None
    for key in sorted(set(before.attrib) | set(after.attrib)):
        previous, current = before.get(key), after.get(key)
        if previous == current:
            continue
        expected = edit and ((key == 'Isotope' and 'afterIsotope' in edit and current == str(edit['afterIsotope'])) or (key == 'GenericNickname' and before.get('NodeType') == 'GenericNickname' and current == edit.get('afterQuery')))
        reason = 'requested-chemical-edit' if expected else None
        if not reason and previous is not None and current is None:
            if key in ('BoundingBox', 'Warning'):
                reason = 'invalidated-layout-box' if key == 'BoundingBox' else 'removed-source-warning'
            elif key == 'AS' and kind == 'n' or key == 'BS' and kind == 'b':
                reason = 'invalidated-cip-cache'
        if not reason and previous is None and (kind, before.get('id'), key) in port_additions:
            # Independently checked against inferred source port/bond order below.
            reason = 'explicit-existing-port-order'
        if not reason and key in NUMERIC_LAYOUT and numeric_layout_equal(previous, current):
            reason = 'equivalent-numeric-layout-format'
        item = {'path': path, 'field': key, 'before': previous, 'after': current}
        (allowed if reason else differences).append({**item, **({'reason': reason} if reason else {})})
    for key in ('text', 'tail'):
        if text(getattr(before, key)) != text(getattr(after, key)):
            differences.append({'path': path, 'field': key, 'before': text(getattr(before, key)), 'after': text(getattr(after, key))})
    left, right = list(before), list(after)
    if edit:
        old_labels, new_labels = children(before, 't'), children(after, 't')
        if len(new_labels) != 1 or len(old_labels) > 1:
            differences.append({'path': path, 'field': 'edited-label-count', 'before': len(old_labels), 'after': len(new_labels)})
        else:
            if old_labels and old_labels[0].get('id') != new_labels[0].get('id'):
                differences.append({'path': path, 'field': 'edited-label-native-id'})
            if 'afterIsotope' in edit:
                superscripts = [''.join(run.itertext()) for run in new_labels[0].iter() if name(run) == 's' and int(run.get('face', '0')) & 0x40]
                if str(edit['afterIsotope']) not in superscripts:
                    differences.append({'path': path, 'field': 'isotope-display', 'expected': edit['afterIsotope']})
            elif ''.join(new_labels[0].itertext()).strip() != edit['afterQuery']:
                differences.append({'path': path, 'field': 'query-display', 'expected': edit['afterQuery'], 'after': ''.join(new_labels[0].itertext()).strip()})
            allowed.append({'path': path, 'field': 'chemical-label', 'reason': 'requested-chemical-edit', 'before': [''.join(label.itertext()) for label in old_labels], 'after': [''.join(label.itertext()) for label in new_labels]})
        left = [child for child in left if name(child) != 't']
        right = [child for child in right if name(child) != 't']
    # Derived stereo captions must disappear together with invalidated AS caches.
    if kind == 'n' and before.get('AS') not in (None, 'N', 'U') and after.get('AS') is None:
        for child in left[:]:
            if name(child) == 'objecttag' and child.get('Name') == 'stereo' and not any(name(other) == 'objecttag' and other.get('Name') == 'stereo' for other in right):
                left.remove(child)
                allowed.append({'path': path, 'field': 'stereo-objecttag', 'reason': 'invalidated-cip-caption'})
    if len(left) != len(right):
        differences.append({'path': path, 'field': 'children', 'before': len(left), 'after': len(right)})
    for index, (old, new) in enumerate(zip(left, right)):
        compare_edited(old, new, edits, allowed, differences, port_additions, f'{path}/{segment(old)}[{index}]')


def validate_case(original, view, edited, target):
    original, original_markers = remove_markers(original)
    view, view_markers = remove_markers(view)
    edited, edited_markers = remove_markers(edited)
    native_id = str(target['nativeId'])
    wrapper, shown_wrapper, edited_wrapper = [top_wrapper(root, native_id) for root in (original, view, edited)]
    expected_markers = set(original_markers) | {node.get('id') for node in wrapper.iter() if name(node) == 'n' and nested(node)}
    if set(view_markers) != expected_markers or set(edited_markers) != expected_markers:
        raise ValueError('ExpandedView marker set does not match the requested recursive target')
    view_differences = compare_exact(original, view)
    if view_differences:
        return None, {'stage': 'view', 'differenceCount': len(view_differences), 'differences': view_differences[:30]}
    if canonical(wrapper) != canonical(shown_wrapper):
        raise ValueError('View wrapper differs from its original chemical subtree')
    original_identities = identities(original)
    native_ids = [native_id for _, native_id, _ in original_identities if native_id]
    if len(native_ids) != len(set(native_ids)):
        raise ValueError('Native chemical identities are not globally unique')
    if original_identities != identities(edited):
        raise ValueError('Native chemical node/bond/fragment IDs or hierarchy changed')
    if boundary_signature(original) != boundary_signature(edited):
        raise ValueError('External bonds, internal ports, branch order or boundary bond orders changed')
    fragments = children(wrapper, 'fragment')
    if len(fragments) != len(children(edited_wrapper, 'fragment')):
        raise ValueError('Target branch count changed')
    expected = [dict(expected_edit(fragment), branch=index) for index, fragment in enumerate(fragments)]
    ids = [entry['nativeId'] for entry in expected]
    if None in ids or len(ids) != len(set(ids)):
        raise ValueError('Audit edit target native identities are ambiguous')
    edited_nodes = {node.get('id'): node for node in edited.iter() if name(node) == 'n'}
    for entry in expected:
        node = edited_nodes.get(entry['nativeId'])
        if node is None:
            raise ValueError('A selected chemical edit target was removed')
        if 'afterIsotope' in entry:
            if node.get('Isotope') != str(entry['afterIsotope']):
                raise ValueError(f'Branch {entry["branch"]} isotope differs from the audit selection rule')
            entry['actualIsotope'] = int(node.get('Isotope'))
        else:
            if query_label(node) != entry['afterQuery']:
                raise ValueError(f'Branch {entry["branch"]} query label differs from the audit selection rule')
            entry['actualQuery'] = query_label(node)
    allowed, differences = [], []
    port_additions = set()
    for node in original.iter():
        if name(node) == 'n' and nested(node):
            port_additions.add(('n', node.get('id'), 'BondOrdering'))
            port_additions.update(('fragment', fragment.get('id'), 'ConnectionOrder') for fragment in children(node, 'fragment'))
    compare_edited(original, edited, {entry['nativeId']: entry for entry in expected}, allowed, differences, port_additions)
    # Check all native object references independently of the tree comparator.
    original_refs, edited_refs = reference_signature(original), reference_signature(edited)
    originals = Counter(original_refs)
    current = Counter(edited_refs)
    removed_refs = list((originals - current).elements())
    added_refs = list((current - originals).elements())
    if removed_refs or any(attribute not in ('ConnectionOrder', 'BondOrdering') for _, attribute, _ in added_refs):
        differences.append({'field': 'native-object-references', 'removed': removed_refs[:10], 'unexpectedAdded': [ref for ref in added_refs if ref[1] not in ('ConnectionOrder', 'BondOrdering')][:10]})
    if differences:
        return None, {'stage': 'edited', 'differenceCount': len(differences), 'differences': differences[:30], 'allowedChangeCounts': dict(Counter(change['reason'] for change in allowed))}
    result = {**target, 'viewWholeDocumentIdenticalExceptMarkers': True, 'viewWrapperIdenticalExceptMarkers': True, 'recursiveMarkers': len(expected_markers), 'branches': len(fragments), 'nativeChemicalHierarchyPreserved': True, 'nativeAtomCount': sum(name(node) == 'n' for node in wrapper.iter()), 'nativeBondCount': sum(name(node) == 'b' for node in wrapper.iter()), 'boundaryPortsAndOrdersPreserved': True, 'wrapperChemicalAnnotationsAndRepresentReferencesPreserved': True, 'allNativeReferencesPreserved': True, 'everyBranchChemicallyEdited': True, 'edits': expected, 'expectedSerializationChangeCounts': dict(Counter(change['reason'] for change in allowed)), 'serializationChangeExamples': [change for change in allowed if change['reason'] != 'requested-chemical-edit'][:12]}
    return result, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--targets', type=Path, default=Path('docs/validation/expanded-groups/targets.json'))
    parser.add_argument('--source-root', type=Path, default=Path('.local/chemdraw26-unpacked/files'))
    parser.add_argument('--audit-dir', type=Path, default=Path('.local/expanded-group-audit'))
    parser.add_argument('--output', type=Path, default=Path('docs/validation/expanded-groups/independent-results.json'))
    parser.add_argument('--limit', type=int, help='Validate only the first N targets while private audit artifacts are still being generated.')
    args = parser.parse_args()
    manifest = json.loads(args.targets.read_text(encoding='utf-8'))
    if args.limit is not None and args.limit < 1:
        parser.error('--limit must be positive')
    targets = manifest['targets'][:args.limit] if args.limit is not None else manifest['targets']
    results, failures, sources = [], [], {}
    for index, target in enumerate(targets):
        try:
            if target['file'] not in sources:
                sources[target['file']] = ET.parse(args.source_root / target['file']).getroot()
            view_path, edited_path = [args.audit_dir / f'{index:04d}-{stage}.cdxml' for stage in ('view', 'edited')]
            result, failure = validate_case(sources[target['file']], ET.parse(view_path).getroot(), ET.parse(edited_path).getroot(), target)
            if failure:
                failures.append({**target, 'index': index, **failure})
            else:
                results.append(result)
        except (ValueError, ET.ParseError, OSError, KeyError, TypeError) as error:
            failures.append({**target, 'index': index, 'stage': 'validation', 'error': str(error)})
    summary = {'targeted': len(targets), 'manifestTargets': len(manifest['targets']), 'limitedRun': args.limit is not None, 'independentlyValidated': len(results), 'viewFilesCompared': len(results), 'editedFilesCompared': len(results), 'editedBranches': sum(row['branches'] for row in results), 'failures': len(failures)}
    report = {'validator': 'Python standard-library ElementTree; independent of application parser and projection', 'selectionRule': 'For each branch, first ordinary atom isotope + 1 (H1/C12/N14/O16/S32/P31/F19/Cl35/Br79/I127; other elements 100), otherwise first generic/any query label + _edited, otherwise recurse into first nested group first branch. Element-list position-only edits are rejected.', 'scope': 'Strict whole-document and wrapper XML comparison for view files, ignoring only valid ExpandedView markers and indentation. Edited files preserve native chemical identities/hierarchy, all boundary references and native object references. Only the independently predicted isotope/query edits and their labels, derived CIP-cache invalidation, removed Warning/BoundingBox values, explicit equivalent port orders and numerically equivalent layout formatting are accepted and recorded. No RDKit reinterpretation or flattening of ambiguous chemistry.', 'summary': summary, 'results': results, 'failures': failures}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
