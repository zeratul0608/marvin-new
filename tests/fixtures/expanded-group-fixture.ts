import {abbreviationXml,recursiveAbbreviationXml} from './abbreviation-fixture';
export const peptideGroupXml=abbreviationXml.replace('NodeType="Fragment"','NodeType="Fragment" ResidueID="3" ExternalConnectionType="Peptide"');
export const nestedPeptideGroupXml=recursiveAbbreviationXml.replace('NodeType="Fragment"','NodeType="Fragment" ResidueID="8" ExternalConnectionType="Peptide"');
export const alternativesGroupXml='<CDXML><page id="1"><fragment id="2"><n id="3" NodeType="AnonymousAlternativeGroup" p="0 0"><fragment id="10"><n id="11" Element="8" p="0 0" NumHydrogens="2"/></fragment><fragment id="20"><n id="21" Element="7" p="0 0" NumHydrogens="3"/></fragment><t><s>O or N</s></t></n></fragment></page></CDXML>';
export const referencedGroupXml=abbreviationXml.replace('</page>','<graphic id="800" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="20 5 22 7"><represent id="801" object="20" attribute="Radical"/></graphic></page>');
export const inconsistentBoundaryXml=abbreviationXml.replace('<b id="30" B="3" E="20"/>','<b id="30" B="3" E="20" Order="1.5"/>');
