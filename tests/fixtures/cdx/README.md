# CDX compatibility fixtures

These two original binary examples accompany the archived ChemDraw CDX SDK documentation, preserved by the IUPAC FAIRSpec project:

- `dimethylamine-simple.cdx`: https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/dimethylaminesimple.cdx
- `dimethylamine-styled.cdx`: https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/dimethylamine.cdx

Expected chemical graph: dimethylamine, C2H7N, three heavy atoms and two single bonds. The styled example contains a nitrogen label, document styles, and non-stereogenic CIP annotations. Binary files are retained unchanged.

Explanations: [simple example](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/IntroExampleSimple.htm), [ChemDraw-produced styled example](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/IntroExampleComplex.htm).

The TypeScript tests additionally construct small independent binary cases for bond-order bits, reversed wedge anchors, isotope/charge/hydrogen properties, malformed input, unsupported semantics and resource limits. Passing these tests does not establish full ChemDraw document compatibility.

## Additional independent binary fixtures (2026-11-01)

- `rdkit-ethanol.cdx`, `rdkit-benzene.cdx`, `rdkit-isotopes-charges.cdx` were generated with RDKit 2025.03.6's ChemDraw binary writer, from `CCO`, `c1ccccc1` and `[13CH3][15NH3+].[Cl-]`. These are independent producer outputs, not binary streams assembled by this project's parser tests, and are not claimed to be files manually saved in ChemDraw. They use a 22-byte preamble with an explicit Document object. Reproduce with `python scripts/validate-cdx.py --dependencies .local/cdx-reference/validation-deps --generate-fixtures`; see the script for the Python binding's binary string workaround.
- `rdkit-ring-stereo1.cdx` is an unchanged third-party file from [RDKit's CDXML test-data directory](https://github.com/rdkit/rdkit/blob/master/Code/GraphMol/test_data/CDXML/ring-stereo1.cdx). Git blob SHA-1: `2dca0711ac53969cf5409ffa9b8fdc611a9bfa2a`. It is readable by the independent RDKit binary reader, but contains chemical property `0x044a` unsupported by this editor. It is a refusal/state-preservation test, not a successful import case. The applicable upstream notice is retained in [RDKIT-LICENSE.txt](RDKIT-LICENSE.txt).

Browser and independent verification results, exact byte hashes and conversion outputs are retained in [the CDX validation report](../../../docs/validation/cdx/README.md).
