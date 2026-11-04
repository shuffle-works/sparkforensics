// The per-finding-type tables assembled from the detector folders (detectors/index.ts): the public
// evidence fields each finding type reports and the fields that tell sibling findings apart in
// their id.
import type { FindingType } from './detectors.ts';
import type { AllKeys, FindingEvidenceMap } from './finding-types.ts';
import type { FindingOf } from './types.ts';
import type { UnionToIntersection } from './detectors/types.ts';
import detectFolders from './detectors/index.ts';

type DetectFolder = (typeof detectFolders)[number];

// The id hash's discriminator slots, in join order: reordering or renaming one changes every
// finding id, which needs an EVIDENCE_SCHEMA_VERSION bump.
export const DISCRIMINATOR_SLOTS = [
  'host', 'executorId', 'rule', 'variant', 'dimension',
  'direction', 'nodeName', 'rootName', 'subtreeSize', 'groupIndex', 'largerSideBytes',
  'rddId', 'relation', 'format', 'operator', 'executionIds',
] as const;
// Slots joined after DISCRIMINATOR_SLOTS only for the types that list them, so adding one leaves
// every other finding id unchanged.
export const APPENDED_SLOTS = ['planNodeIds'] as const;
export type DiscriminatorSlot = (typeof DISCRIMINATOR_SLOTS)[number] | (typeof APPENDED_SLOTS)[number];

// Each finding type's public evidence fields: exactly the keys of its FindingEvidenceMap entry,
// checked both ways at compile time. A field a detector adds for another core module (stageShape's
// totalCores, utilization's unrounded fraction) is left off both, so it never reaches the report;
// adding, renaming or dropping a key changes the report contract.
export const EVIDENCE_KEYS = Object.assign({}, ...detectFolders.map((folder) => folder.evidenceKeys)) as
  UnionToIntersection<DetectFolder['evidenceKeys']> satisfies { [T in FindingType]: readonly AllKeys<FindingEvidenceMap[T]>[] };

// Per type, the fields that tell apart sibling findings sharing one location and metric; without
// them those siblings hash to one id (see detector-contract.md, Finding ids).
export const ID_DISCRIMINATORS = Object.assign({}, ...detectFolders.map((folder) => folder.idDiscriminators)) as
  UnionToIntersection<DetectFolder['idDiscriminators']> satisfies { [T in FindingType]: readonly (DiscriminatorSlot & AllKeys<FindingOf<T>>)[] };
