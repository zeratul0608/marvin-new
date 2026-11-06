// Property type facts from the archived ChemDraw SDK, not inferred from payload bytes.
// https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/TableOfProperties.htm
export const cdxReferenceTags = new Set([0x000e, 0x0012, 0x0431, 0x0432, 0x0434, 0x0505, 0x0604, 0x0605, 0x060b, 0x060e, 0x0a27, 0x0a2b, 0x0a2c, 0x0a2d, 0x0b82, 0x0bb1, 0x0c00, 0x0c01, 0x0c02, 0x0c03, 0x0c04, 0x0c05, 0x0c06, 0x0c07, 0x0c08, 0x1ff0]);
export const cdxLiteralTags = new Set([
  0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0008, 0x0009, 0x000a, 0x000b, 0x000c, 0x000f,
  0x0010, 0x0011, 0x0100, 0x0200, 0x0201, 0x0202, 0x0203, 0x0204, 0x0205, 0x0207, 0x0208, 0x0209,
  0x020a, 0x020b, 0x020c, 0x020d, 0x020e, 0x020f, 0x0300, 0x0301, 0x0302, 0x0400, 0x0401, 0x0402,
  0x0403, 0x0404, 0x0420, 0x0421, 0x0422, 0x0423, 0x0424, 0x0425, 0x0426, 0x0427, 0x0428, 0x0429,
  0x042b, 0x042e, 0x042f, 0x0430, 0x0433, 0x0435, 0x0436, 0x0437, 0x0438, 0x0439, 0x043a, 0x043b,
  0x043c, 0x043d, 0x043e, 0x043f, 0x0440, 0x0442, 0x0443, 0x0444, 0x0445, 0x0446, 0x0447, 0x0500,
  0x0501, 0x0502, 0x0503, 0x0504, 0x0600, 0x0601, 0x0602, 0x0603, 0x0606, 0x0607, 0x0608, 0x0609,
  0x060a, 0x060c, 0x060d, 0x060f, 0x0700, 0x0701, 0x0702, 0x0703, 0x0704, 0x0705, 0x0706, 0x0707,
  0x0708, 0x0800, 0x0801, 0x0802, 0x0803, 0x0804, 0x0805, 0x0806, 0x0807, 0x0808, 0x0809, 0x080a,
  0x080b, 0x080c, 0x080d, 0x080e, 0x080f, 0x0810, 0x0811, 0x0812, 0x0813, 0x0814, 0x0815, 0x0816,
  0x0817, 0x0818, 0x0819, 0x081a, 0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822,
  0x0823, 0x0824, 0x0825, 0x0826, 0x0900, 0x0901, 0x0902, 0x0a00, 0x0a01, 0x0a02, 0x0a03, 0x0a04,
  0x0a05, 0x0a06, 0x0a07, 0x0a08, 0x0a20, 0x0a21, 0x0a22, 0x0a23, 0x0a24, 0x0a25, 0x0a26, 0x0a28,
  0x0a29, 0x0a2a, 0x0a2e, 0x0a2f, 0x0a30, 0x0a31, 0x0a32, 0x0a33, 0x0a34, 0x0a35, 0x0a36, 0x0a37,
  0x0a38, 0x0a38, 0x0a3a, 0x0a3b, 0x0a3c, 0x0a3d, 0x0a80, 0x0a81, 0x0a82, 0x0a83, 0x0a84, 0x0a85,
  0x0a86, 0x0a87, 0x0a88, 0x0a89, 0x0aa0, 0x0aa1, 0x0aa2, 0x0aa3, 0x0aa4, 0x0aa5, 0x0ab0, 0x0ab1,
  0x0ab2, 0x0b00, 0x0b01, 0x0b02, 0x0b80, 0x0b81, 0x0b83, 0x0b84, 0x0b85, 0x0b86, 0x0b87, 0x0b88,
  0x0bb0, 0x0bb2, 0x0d00, 0x0d03, 0x0d04, 0x0d06, 0x0d07, 0x0d08, 0x0e00, 0x0f00, 0x0f01, 0x0f02,
  0x0f03, 0x1000, 0x1001, 0x1002, 0x1100, 0x1ff1, 0x0206,
]);
export const xmlLiteralAttributes = new Set(["AS", "AbnormalValence", "Absolute", "AngularSize", "ArrowEquilibriumRatio", "ArrowHeadHead", "ArrowHeadTail", "ArrowHeadType", "ArrowShaftSpacing", "ArrowType", "AtomNumber", "BS", "BeginAttach", "BoldWidth", "BondLength", "BondSpacing", "BondSpacingAbs", "BottomLeft", "BottomRight", "BoundingBox", "BoundsInParent", "BracketType", "BracketUsage", "CaptionColor", "CaptionFace", "CaptionFont", "CaptionJustification", "CaptionLineHeight", "CaptionSize", "Center3D", "ChainAngle", "Charge", "ChemicalPropertyIsActive", "ChemicalPropertyType", "Class", "Closed", "Comment", "ComponentOrder", "ConstraintMax", "ConstraintMin", "ConstraintType", "CornerRadius", "CreationDate", "CreationProgram", "CreationUserName", "CrossReferenceContainer", "CrossReferenceDocument", "CrossReferenceIdentifier", "CrossReferenceSequence", "CurvePoints", "CurvePoints3D", "CurveSpacing", "CurveType", "DihedralIsChiral", "Dipole", "Display", "Display2", "DoublePosition", "DrawingSpace", "Element", "ElementList", "EndAttach", "EnhancedStereoGroupNum", "EnhancedStereoType", "ExternalConnectionType", "FillType", "FixInPlaceExtent", "FixInPlaceGap", "Footer", "FooterPosition", "Formula", "FractionalWidths", "FrameType", "FreeSites", "GenericNickname", "GeometricFeature", "Geometry", "GraphicType", "GroupFrame", "HDash", "HDot", "HashSpacing", "Head3D", "HeadCenterSize", "HeadSize", "HeadWidth", "Header", "HeaderPosition", "Height", "HeightPages", "HideImplicitHydrogens", "IgnoreUnconnectedAtoms", "IgnoreWarnings", "ImplicitHydrogens", "Integral", "InterpretChemically", "Isotope", "IsotopicAbundance", "Justification", "LabelAlignment", "LabelColor", "LabelDisplay", "LabelFace", "LabelFont", "LabelJustification", "LabelLineHeight", "LabelSize", "LineHeight", "LineStarts", "LineType", "LineWidth", "LinkCountHigh", "LinkCountLow", "LipSize", "MacPrintInfo", "Magnification", "MarginWidth", "ModificationDate", "ModificationProgram", "ModificationUserName", "Name", "NoGo", "NodeType", "NumColumns", "NumHydrogens", "NumRows", "OrbitalType", "Order", "OriginFraction", "OvalType", "PageDefinition", "PageOverlap", "PaneHeight", "Persistent", "PointIsDirected", "PolymerFlipType", "PolymerRepeatPattern", "PositioningAngle", "PositioningOffset", "PositioningType", "PrintMargins", "PrintTrimMarks", "Racemic", "Radical", "RectangleType", "RegistryAuthority", "RegistryNumber", "RelationValue", "Relative", "RepeatCount", "Rf", "RingBondCount", "RotationAngle", "RxnChange", "RxnParticipation", "RxnStereo", "SRULabel", "SequenceIdentifier", "ShadowSize", "ShowAtomEnhancedStereo", "ShowAtomNumber", "ShowAtomQuery", "ShowAtomStereo", "ShowBondQuery", "ShowBondRxn", "ShowBondStereo", "ShowBorders", "ShowNonTerminalCarbonLabels", "ShowOrigin", "ShowRf", "ShowSideTicks", "ShowSolventFront", "ShowTerminalCarbonLabels", "Side", "SolventFrontFraction", "SubstituentsExactly", "SubstituentsUpTo", "SymbolType", "TagType", "Tail", "Tail3D", "TextFrame", "TopLeft", "TopRight", "Topology", "Tracking", "Translation", "UnsaturatedBonds", "Valence", "Visible", "Warning", "Weight", "Width", "WidthPages", "WinPrintInfo", "WindowIsZoomed", "WindowPosition", "WindowSize", "WordWrapWidth", "XAxisLabel", "XLow", "XSpacing", "XType", "YAxisLabel", "YLow", "YScale", "YType", "Z", "bgcolor", "charset", "color", "colortable", "extent", "extent3D", "face", "font", "fonttable", "name", "p", "size", "xmlns", "xyz"]);
export const xmlReferenceAttributes = new Set(["AltGroupID", "Attachments", "B", "BasisObjects", "BondCircularOrdering", "BondID", "BondOrdering", "BracketedObjectIDs", "ChemicalPropertyDisplayID", "ConnectionOrder", "CrossingBonds", "E", "GraphicID", "InnerAtomID", "ReactionStepArrows", "ReactionStepAtomMap", "ReactionStepAtomMapAuto", "ReactionStepAtomMapManual", "ReactionStepObjectsAboveArrow", "ReactionStepObjectsBelowArrow", "ReactionStepPlusses", "ReactionStepProducts", "ReactionStepReactants", "RepresentsProperty", "SplitterPositions", "SupersededBy", "object"]);

// Layout request flag carried by ChemDraw 26 CDXML; not an object reference.
xmlLiteralAttributes.add("NeedsClean");
cdxLiteralTags.add(0x0448);
cdxLiteralTags.add(0x044b);
cdxLiteralTags.add(0x044d);
for (const tag of [0x0828, 0x0829, 0x082a, 0x0832]) cdxLiteralTags.add(tag);
xmlLiteralAttributes.add('ResidueID');
xmlLiteralAttributes.add('ExternalConnectionNum');
xmlLiteralAttributes.add('AtomID');
xmlLiteralAttributes.add('ShowSequenceTermini');
xmlLiteralAttributes.add('Connectivity');
xmlLiteralAttributes.add('BeginExternalNum');
xmlLiteralAttributes.add('EndExternalNum');
xmlLiteralAttributes.add('ShowResidueID');
for (const name of ['SequenceType', 'highlightColor', 'HideImplicitHydrogens']) xmlLiteralAttributes.add(name);
cdxReferenceTags.add(0x0013); // ChemDraw 26 SupersededBy; native attribute registry maps tag 19.
for (const name of ['ArrowheadHead','ArrowheadTail','ArrowheadType','ArrowheadCenterSize','ArrowheadWidth','MajorAxisEnd3D','MinorAxisEnd3D','FadePercent','ShowPerspective','NumberResidueBlocks','MonomerRenderingStyle']) xmlLiteralAttributes.add(name);
for (const name of ['JPEG','PNG','TIFF','GIF','WindowsMetafile','EnhancedMetafile','CompressedEnhancedMetafile','UncompressedEnhancedMetafileSize']) xmlLiteralAttributes.add(name);
for (const name of ['UnitID','StartRange','EndRange','ShowScale','AxisWidth','LabelsAngle','LabelText']) xmlLiteralAttributes.add(name);
for (const name of ['BandValue','ShowValue','MarkerAngle','MarkerOffset','DisplayName','Value']) xmlLiteralAttributes.add(name);
for (const name of ['ArrowSource','ArrowTarget']) xmlReferenceAttributes.add(name);
xmlLiteralAttributes.add('BioShapeType'); // Enumerated shape type; not an object reference.
// Scalar BioDraw geometry parameters from the public CDXML DTD. Object IDs
// remain governed by xmlReferenceAttributes and are never admitted generically.
for(const name of ['CylinderDistance','CylinderHeight','CylinderWidth','DNAWaveHeight','DNAWaveLength','DNAWaveOffset','DNAWaveWidth','EnzymeHeight','EnzymeReceptorSize','EnzymeWidth','GproteinLowerHeight','GproteinUpperHeight','GolgiHeight','GolgiLength','GolgiWidth','HelixProteinExtra','ImmunoglobinHeight','ImmunoglobinWidth','MembraneElementSize','MembraneEndAngle','MembraneMajorAxisSize','MembraneMinorAxisSize','MembraneStartAngle','NeckHeight','NeckWidth','PipeWidth'])xmlLiteralAttributes.add(name);
