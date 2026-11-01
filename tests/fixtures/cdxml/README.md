# CDXML reference fixtures

`dimethylamine-simple.cdxml` and `dimethylamine-styled.cdxml` are the XML examples transcribed from the archived ChemDraw SDK documentation, preserved by IUPAC FAIRSpec:

- https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/IntroExampleSimple.htm
- https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/IntroExampleComplex.htm

The XML text was extracted from the first `<tt>` block containing the complete CDXML document. HTML formatting contributes whitespace; chemical attributes and IDs have not been changed. These are documentation examples, not newly authored ChemDraw files. Both represent dimethylamine (C2H7N, 3 atoms, 2 bonds), matching the binary CDX fixtures in the adjacent directory.

The minimal example omits bond, page and fragment IDs. The styled example contains `AS="N"` / `BS="N"` (symmetric, non-stereogenic), a specified hydrogen count, labels, and page styles. Tests force rewritten CDXML after editing, compare chemistry and coordinates, and verify refusal of actual unsupported stereochemical descriptors.
