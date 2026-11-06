import type {ChemicalDocument} from '../src/core/types';
import type {stereoProjection} from '../src/formats/stereo';
export function equivalentDocuments(sdk:{documentProjection:typeof stereoProjection},actual:ChemicalDocument,expected:ChemicalDocument):boolean;
