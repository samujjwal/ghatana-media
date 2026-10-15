#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalizeVerificationValue,
  captureRepositorySourceCurrentness,
  isRepositorySourceCurrentness,
} from '@ghatana/verification-planner';
import { buildPdp1SourceCensus } from './report-media-pdp-readiness.mjs';
import { observeMediaDiscoveryCurrentness } from './media-discovery-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const parseYaml = requireTools('yaml').parse;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_ROOTS = {
  ghatana: '../ghatana',
  'ghatana-products': '../ghatana-products',
  gharbatai: '../gharbatai',
  'ghatana-tools': '../ghatana-tools',
  'ghatana-lifecycle': '../ghatana-lifecycle',
  'ghatana-shared': '../ghatana-shared',
};
const COMMON_PDP1_REFS = [
  '.product-experience/source-manifest.yaml',
  '.product-experience/surface-registry.yaml',
  '.product-experience/surfaces/media-physical-topology.v1.json',
  '.product-experience/decision-log.md',
  '.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md',
  '.product-experience/pdp-1-domain-data/',
  '.product-experience/interface-parity/',
  'package.json',
  'pnpm-lock.yaml',
  'scripts/check-media-contract-parity.mjs',
  'scripts/report-media-pdp-readiness.mjs',
  'tests/media-pdp-p1-dev-status.test.mjs',
  'tests/media-contract-parity.test.mjs',
  'tests/media-contract-parity-definition-only-cli.test.mjs',
  'tests/pdp1-owner-action-wire-contracts.test.mjs',
  'tests/pdp1-transition-guard-definition-evaluator.test.mjs',
];
const REQUIRED_TEST_COMMAND = 'node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs tests/pdp1-owner-action-wire-contracts.test.mjs tests/pdp1-transition-guard-definition-evaluator.test.mjs tests/pdp-truth-domain-typed-observations.test.mjs tests/media-pdp1-mdc30-owner-result-bindings.test.mjs tests/pdp1-operation-current-source-review.test.mjs tests/pdp1-interface-current-source-review.test.mjs tests/media-discovery-pdp1-c22-impact.test.mjs tests/media-discovery-pdp1-capture-source-chains.test.mjs tests/media-discovery-pdp1-three-review-source-transition.test.mjs tests/media-discovery-pdp1-supplemental-owner-status-join.test.mjs';
const PDP1_OPERATION_PARITY_SUCCESSOR_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp1-operation-parity-projection-impact-2026-10-14-r1.json';
const PDP1_OPERATION_PARITY_SUCCESSOR_TEST_PATH = 'tests/media-discovery-pdp1-operation-parity-impact.test.mjs';
const PDP1_OPERATION_PARITY_TEST_COMMAND = `node --test ${PDP1_OPERATION_PARITY_SUCCESSOR_TEST_PATH}`;
const REQUIRED_DEFINITION_ONLY_COMMAND = 'node scripts/check-media-contract-parity.mjs --definition-only';
const REQUIRED_STRICT_COMMAND = 'pnpm check:contract-parity';
const REQUIRED_LOCAL_EXPERIENCE_COMMAND = 'pnpm check:product-experience-local';
const HISTORICAL_PDP1_EXIT_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json';
const CURRENT_CUT_PDP1_PREDECESSOR_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json';
const CURRENT_CUT_PDP1_PREDECESSOR_DIGEST = 'sha256:63ee158301047bd715b586c41368a4d576a0b1e224672d08e2ced08349ad00fc';
const CURRENT_CUT_OWNER_DIRECTIONS_PATH = 'docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json';
const PDP3_STATUS_GUARD_IMPACT_PATH = 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json';
const PDP1_ADAPTER_TEST_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp1-adapter-test-pin-impact-2026-10-14-r1.json';
const PDP1_GUARD_PATH = 'scripts/report-media-pdp-readiness.mjs';
const PDP1_GUARD_PREDECESSOR_DIGEST = 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c';
const PDP1_GUARD_OBSERVED_DIGEST = 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1';
const PDP1_ADAPTER_TEST_PATH = 'tests/pdp-experience-capability-invocation-adapters.test.mjs';
const PDP1_ADAPTER_TEST_PREDECESSOR_DIGEST = 'sha256:b3fed6206114180160768270461e0c0175adfd0938e3029238a265ae6ef843b5';
const PDP1_ADAPTER_TEST_OBSERVED_DIGEST = 'sha256:a062b06080d9aeb0b3bd0695aaa2affca0aca8583fe020bdcadcaa2a5b98e5ed';
const PDP1_ADAPTER_TEST_COMMAND = 'node --test tests/pdp-experience-capability-invocation-adapters.test.mjs';
const PDP1_OPERATIONS_PATH = '.product-experience/pdp-1-domain-data/operations.yaml';
const PDP1_OPERATIONS_REVIEW_PATH = '.product-experience/pdp-1-domain-data/operations-current-source-review.json';
const PDP1_OPERATIONS_PREDECESSOR_DIGEST = 'sha256:11d51ef9cdc69e2dde09b3a72241a19a321be40372b19850e4d29c3ec2fb3e04';
const PDP1_OPERATIONS_REVIEW_PREDECESSOR_DIGEST = 'sha256:c73e44c375c9b20a120e63200065484775ded0d4749057b45a2aa7d773f54c69';
const PDP1_OPERATIONS_OBSERVED_DIGEST = 'sha256:63e36ea20e5b5f7e6fa84d3a7f2bdd2f611835b415aa25205bcf0b290fb7f952';
const CURRENT_CUT_OWNER_DIRECTIONS_DIGEST = 'sha256:4dc505154364b4ef98836e327cc556f1d24adf937d964913caba09c49c4176a4';
const CURRENT_CUT_PDP1_OWNER_CHANGE_PATHS = [
  '.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md',
  '.product-experience/source-manifest.yaml',
  '.product-experience/surface-registry.yaml',
  'apps/media-experience-explorer/specification-artifacts.json',
];
const PDP1_OPERATION_DELTA_IDS = [
  'media.observation-contract.rights-decision.v1',
  'media.observation-contract.destination-delivery-acknowledgment.v1',
  'media.observation-contract.delegated-integration-result-context.v1',
  'media.observation-contract.processing-parameter-read.v1',
  'media.observation-contract.effective-processing-constraints.v1',
  'media.observation-contract.transcript-submission-lineage.v1',
  'media.observation-contract.job-status-seven-dimension.v1',
  'media.observation-contract.output-preview-version-lineage.v1',
];
const PDP1_REVIEWED_OPERATION_IDS = [
  'media.operation.capability.media-speech-synthesis-dub',
  'media.operation.fallback-selection.confirm.v1',
];
const PDP1_NEW_OPERATION_IDENTITY_IDS = [
  'capabilityInputPayloadSchemas:media.typed-input.source-media-with-speech-dub',
  'operations:media.operation.fallback-selection.confirm.v1',
  'uiActions:media.action.confirm-selected-fallback',
];
const PDP1_ADDITIONAL_DEFINITION_PATHS = [
  '.product-experience/decision-log.md',
  '.product-experience/pdp-1-domain-data/decisions.yaml',
  '.product-experience/pdp-1-domain-data/handoff-contracts.yaml',
];
const PDP1_PXD163_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp0-pxd163-source-impact-2026-10-14-r1.json';
const PDP1_PARITY_TEST_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp1-parity-test-pin-impact-2026-10-14-r1.json';
const CURRENT_CUT_SOURCE_IMPACT_PATH = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json';
const CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r2.json';
const PDP1_OWNER_WIRE_IMPACT_PATH = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r5.json';
const PDP1_OWNER_WIRE_PREDECESSOR_IMPACT_PATH = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r3.json';
const PDP1_INTERFACE_REVIEW_IMPACT_PATH = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r4.json';
const PDP1_STATUS_TEST_IMPACT_PATH = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r6.json';
const PDP1_STATUS_TEST_IMPACT_DIGEST = 'sha256:c1ce0894867da5c2d710d0739c50cd7b9a1fa634a2c327c28f4a9aeeabd49c91';
const PDP1_STATUS_TEST_PATH = 'tests/media-pdp-p1-dev-status.test.mjs';
const PDP1_STATUS_TEST_PREDECESSOR_DIGEST = 'sha256:3ff1576a4a3987f5b1e05d15ae77e35a62745260e127ebcb28c1bb49ef7ef82e';
const PDP1_STATUS_TEST_OBSERVED_DIGEST = 'sha256:5201e4b1915f35594641f8683ee3c499bb563259ed5f3387f027ce787bf0899d';
const PDP1_DEV_STATUS_TEST_REFRESH_PATH = 'docs/implementation/observations/media-discovery-pdp1-dev-status-test-refresh-2026-10-14-r1.json';
const PDP1_DEV_STATUS_TEST_REFRESH_DIGEST = 'sha256:1f5dee27302e0c3de768ecb94d606d1682bc78256c4ed9f687ac1885ff5ebd1c';
const PDP1_DEV_STATUS_TEST_R22_PREDECESSOR_DIGEST = 'sha256:8362bf108a1f05577e6cdc858cd1565c6afc4193eea102a475e0b1d145abc9ad';
const PDP1_DEV_STATUS_TEST_OBSERVED_DIGEST = 'sha256:73f4a04489bc6725285624c9c6a31df25235c2d8760c3c2de06deed8ab204aa4';
const PDP1_THREE_SOURCE_TRANSITION_PATH = 'docs/implementation/observations/media-pdp1-three-source-transition-no-meaning-disposition-2026-10-14.json';
const PDP1_THREE_SOURCE_TRANSITION_DIGEST = 'sha256:0232e292777457b3b87b02ed1639dd9e5f507237bda6c195decb1defcc34cc50';
const PDP1_THREE_SOURCE_TRANSITION_ROWS = [
  { path: '.product-experience/pdp-1-domain-data/handoff-contracts.yaml', predecessorSha256: 'sha256:3605ff3a216e8187acad158666be6e0a13801ee947099a7e657e3e29c59e9338', observedSha256: 'sha256:0055cb68ee08825d8936763353e011ffa5e3979562c42685566d525a6a074024' },
  { path: 'tests/media-pdp-p1-dev-status.test.mjs', predecessorSha256: 'sha256:5201e4b1915f35594641f8683ee3c499bb563259ed5f3387f027ce787bf0899d', observedSha256: 'sha256:8362bf108a1f05577e6cdc858cd1565c6afc4193eea102a475e0b1d145abc9ad' },
  { path: 'tests/media-contract-parity.test.mjs', predecessorSha256: 'sha256:3b2ebd2a9dcbe68f1afb86438fa55953851596a5d5c359a888bc94bb95eb4cc4', observedSha256: 'sha256:3141669eedcf4e26aca5e63e057cd4b9b5f11d75761149e81ed69cd6566da67b' },
];
const PDP0_REPORTER_SUCCESSOR_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp0-r6-successor-impact-2026-10-14-r1.json';
const PDP0_REPORTER_SUCCESSOR_IMPACT_DIGEST = 'sha256:7fe0da3920240dc3f37d9a267f71a6ce25c74ce94586b0157cc9169356f5b996';
const PDP0_REPORTER_SUCCESSOR_PREDECESSOR_DIGEST = 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573';
const PDP0_REPORTER_SUCCESSOR_OBSERVED_DIGEST = 'sha256:4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f';
const PDP1_INTERFACE_REVIEW_IMPACT_DIGEST = 'sha256:5f7b6cc3ef178c0a8df2f35d0085cb27e504cc577e2168b45d1ca4e2964e95d6';
const PDP1_ADDITIONAL_SOURCE_IMPACT_DIGEST = 'sha256:e42ea147206f041b5cb3b76a81227314630f775201f1bf099a6e4aace38c6860';
const PDP1_OWNER_WIRE_IMPACT_DIGEST = 'sha256:3b51e39e86468041c02518839e88235337d68e02980bcc6ae1bbecbd1a38986c';
const PDP1_OWNER_WIRE_PREDECESSOR_IMPACT_DIGEST = 'sha256:a3994ba98f8dabf14a1f61f2974fb4c008831083c102e5392bd5ec187ade3f57';
const PDP0_R6_EXIT_DIGEST = 'sha256:dac98419a6a2314741d584e120f7a9e7a3190559cbde7b6ca7e5d5b1a785aabb';
const PDP0_R6_CURRENTNESS_DIGEST = 'sha256:826b0a69673818e9e97046fc4288af4cdf59d724f78bc2e6db5709f8d3b7bf65';
const PDP1_INTERFACE_REVIEW_PATH = '.product-experience/interface-parity/current-source-review.json';
const PDP1_INTERFACE_REVIEW_PREDECESSOR_DIGEST = 'sha256:9f9150548c5e4e97881cc08dd28df0c4b892d88ad51e783e5f51465e1d8715c2';
const PDP1_INTERFACE_REVIEW_OBSERVED_DIGEST = 'sha256:0ce764d11912596ee39057db9bd0f2dfbf3c85f6269d55632bda3b3e6e4ad0dd';
const PDP1_INTERFACE_REVIEW_OPERATIONS_PIN_DIGEST = 'sha256:ec1e29eceb76333dec91b52b94d20fa882456dcb52989b1794c4f9c58fdfd111';
const PDP1_OWNER_WIRE_PATH = '.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml';
const PDP1_OWNER_WIRE_PREDECESSOR_DIGEST = 'sha256:f6155c1bf0a1851b0fa45f631ce09eb459d2b8d5d8df6cd03a3dd6d634be19cf';
const PDP1_C22_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp1-c22-semantic-repair-impact-2026-10-14.json';
const PDP1_PXD164_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp1-pxd164-semantic-repair-impact-2026-10-14-r1.json';
const PDP1_PXD164_PREDECESSOR_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r22.json';
const PDP1_PXD164_PREDECESSOR_DIGEST = 'sha256:bb448dc45d3db788ef16802f8a92dc8054a6fc6aaa27f047c42b4f6c91feb303';
const PDP1_PXD164_MEANING_OWNER_ID = 'media.operation.action.request-admitted-speech-operation';
const PDP1_PXD164_SOURCE_ROWS = [
  { path: '.product-experience/decision-log.md', selector: '.product-experience/decision-log.md#PXD-164', predecessorSha256: 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c', observedSha256: 'sha256:97ad3104abec9ba6670804394c68a11c663f37171e90ea2a1f2e629aa5619bbc', classification: 'PXD164_SPEECH_SELECTED_TARGET_WRAPPER_SEMANTIC_REPAIR' },
  { path: '.product-experience/pdp-1-domain-data/operations-current-source-review.json', selector: '.product-experience/pdp-1-domain-data/operations-current-source-review.json#reviewedOperationDefinitions/@id=media.operation.action.request-admitted-speech-operation', predecessorSha256: 'sha256:d5f83fad612d6598165072137390c70c8d4dfdc549a236a29c7bda34b50b6d0c', observedSha256: 'sha256:e5a86cd601694697ad735ab10803f215ef8078b8704dc7dc2645435a490e74bc', classification: 'PXD164_SPEECH_SELECTED_TARGET_WRAPPER_SEMANTIC_REPAIR_REVIEW' },
  { path: '.product-experience/pdp-1-domain-data/operations.yaml', selector: '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.request-admitted-speech-operation', predecessorSha256: 'sha256:62d0a4050a43da1c58a63d12adaa7c27055c63afc51580bd1e2478d1da3dace8', observedSha256: 'sha256:63e36ea20e5b5f7e6fa84d3a7f2bdd2f611835b415aa25205bcf0b290fb7f952', classification: 'PXD164_SPEECH_SELECTED_TARGET_WRAPPER_SEMANTIC_REPAIR' },
  { path: '.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml', selector: '.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml#records/@id=media.owner-action-wire.request-admitted-speech-operation.v1', predecessorSha256: 'sha256:19605e76b089ffc91cc7a08ce09bed375c638c29edf7b623df61ca2e89cfcf0b', observedSha256: 'sha256:c5f6a711b9b8d90e139aeeda5bc22eebd90648f544a9dca17bb72b7cafb55bda', classification: 'PXD164_SPEECH_SELECTED_TARGET_WRAPPER_WIRE_ALIGNMENT' },
];
const PDP1_PXD164_VERIFICATION_INPUT_PATHS = [
  'scripts/lib/pdp-selected-target-operation-binding.mjs',
  'tests/pdp1-j04-selected-target-operation-binding.test.mjs',
  'tests/pdp1-operation-current-source-review.test.mjs',
];
const PDP1_PXD164_VERIFICATION_ONLY_TRANSITION = {
  path: 'tests/pdp1-operation-current-source-review.test.mjs',
  predecessorSha256: 'sha256:0eba3c1f978587e94052b717ecb3a712104e972cfeeeddeef65982a5ebf2f641',
  observedSha256: 'sha256:fae9e284461a294d15de7acfc05fa739f26ccf20b351107916fe32206497e331',
  classification: 'PDP1_FOCUSED_VERIFICATION_ONLY',
};
const PDP1_C22_IMPACT_DIGEST = 'sha256:51fe23d5b02a8c08755bd010affa0051cbb87117aaa962fdb2ecdf0a6b5484cd';
const PDP1_C22_OPERATIONS_DIGEST = 'sha256:62d0a4050a43da1c58a63d12adaa7c27055c63afc51580bd1e2478d1da3dace8';
const PDP1_C22_OPERATIONS_PREDECESSOR_DIGEST = 'sha256:ec1e29eceb76333dec91b52b94d20fa882456dcb52989b1794c4f9c58fdfd111';
const PDP1_C22_OWNER_WIRE_DIGEST = 'sha256:19605e76b089ffc91cc7a08ce09bed375c638c29edf7b623df61ca2e89cfcf0b';
const PDP1_C22_OWNER_WIRE_PREDECESSOR_DIGEST = 'sha256:e7c432e0244e7c719d211d16dd7c7d94d1c7dc87b33f339ed72ddcf5bd6e4a9b';
const PDP1_C22_OPERATION_SELECTOR = '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.deliver-exact-version/resultSchema';
const PDP1_C22_WIRE_SELECTOR = '.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml#resultProjectionBindings/@sourceOperationRef=media.operation.action.deliver-exact-version';
const PDP1_C22_REVIEW_INPUT_DIGESTS = {
  '.product-experience/pdp-1-domain-data/operations-current-source-review.json': 'sha256:6a00513dbe97182091a5b1b47fad2dc3e702ffaed962b835d2d4dffb822ff5b8',
  '.product-experience/interface-parity/current-source-review.json': 'sha256:90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76',
  'tests/media-pdp1-mdc30-owner-result-bindings.test.mjs': 'sha256:4e81b7e2caf29cbc7e81a16d2253d9214f420e6b9541b34787eb47837cb8839e',
  'tests/pdp1-operation-current-source-review.test.mjs': 'sha256:0eba3c1f978587e94052b717ecb3a712104e972cfeeeddeef65982a5ebf2f641',
  'tests/pdp1-interface-current-source-review.test.mjs': 'sha256:9a5251fd20311b470e6ac4e43b173f2a2fbb0066d4a55d1fd4a63945a14ba630',
};
const PDP1_THREE_REVIEW_TRANSITIONS_PATH = 'docs/implementation/observations/media-discovery-pdp1-three-review-source-transition-2026-10-14.json';
const PDP1_THREE_REVIEW_TRANSITIONS_DIGEST = 'sha256:818473ba21b71a6c04915bbc6deeafc2672e7f076132aed66bb75e74639f56fb';
const PDP1_INTERFACE_REVIEW_PIN_REFRESH_PATH = 'docs/implementation/observations/media-discovery-pdp1-interface-review-source-pin-refresh-2026-10-14-r1.json';
const PDP1_INTERFACE_REVIEW_PIN_REFRESH_DIGEST = 'sha256:e85a9806d93445687d2d111094feefb39a257f77ed7ef243126898e98444c140';
const PDP1_INTERFACE_REVIEW_PIN_REFRESH_PREDECESSOR = 'sha256:866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd';
const PDP1_INTERFACE_REVIEW_PIN_REFRESH_OBSERVED = 'sha256:64796cfb0db909a36e030041b2d51d02fd19fc115d703cc16bca37116f92ed06';
const PDP2_R5_SOURCE_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r5.json';
const PDP2_R5_SOURCE_IMPACT_DIGEST = 'sha256:3966422b98832e7473f1ed7dd6982ddc128dea19b2bf1ceb8941aa74e23fd343';
const PDP2_R5_INTERFACE_REVIEW_PREDECESSOR = 'sha256:90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76';
const PDP2_R5_INTERFACE_REVIEW_OBSERVED = PDP1_INTERFACE_REVIEW_PIN_REFRESH_PREDECESSOR;
const PDP2_R1_SOURCE_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp2-additional-source-impact-2026-10-14-r1.json';
const PDP2_R1_SOURCE_IMPACT_DIGEST = 'sha256:481448c2c761d425d3fbaff5761fcd689ef80482f68f3762a4e70d90f4b357ac';
const PDP2_R1_INTERFACE_REVIEW_PREDECESSOR = PDP1_INTERFACE_REVIEW_PIN_REFRESH_PREDECESSOR;
const PDP2_R1_INTERFACE_REVIEW_OBSERVED = PDP1_INTERFACE_REVIEW_PIN_REFRESH_OBSERVED;
const PDP1_SEMANTIC_REVIEW_REFRESH_DIGEST = 'sha256:15ec0101ba8d7c178bed46b116284b0de1150ac38caacedd65904225ab4b51c9';
const PDP1_TYPED_OBSERVATION_TEST_PATH = 'tests/pdp-truth-domain-typed-observations.test.mjs';
const PDP1_TYPED_OBSERVATION_TEST_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp1-typed-observation-test-refresh-2026-10-14-r1.json';
const PDP1_TYPED_OBSERVATION_TEST_IMPACT_DIGEST = 'sha256:5b7904bb6124665358f41810200c5f578facbcbe6e126d565a8acbbac51f7190';
const PDP1_TYPED_OBSERVATION_TEST_PREDECESSOR_DIGEST = 'sha256:e824ac21970a39795f6d4abd1dc9c1965bbf941024ea03b2aba58f903966916a';
const PDP1_TYPED_OBSERVATION_TEST_OBSERVED_DIGEST = 'sha256:ba78025d7b39f910d8fbbde1219419f497cf0c3fcaef93abc5a131268eeaaee7';
const PDP1_R22_EXIT_DIGEST = 'sha256:bb448dc45d3db788ef16802f8a92dc8054a6fc6aaa27f047c42b4f6c91feb303';
const PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PREDECESSOR_PATH = 'docs/implementation/observations/media-discovery-pdp1-owner-status-join-test-refresh-2026-10-14.json';
const PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PREDECESSOR_DIGEST = 'sha256:d55f93aca8f4a48d0fe7f249f13d475d0d4cbbdfbcc8019abfba8af51f3eb681';
const PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PATH = 'docs/implementation/observations/media-discovery-pdp1-owner-status-join-test-refresh-2026-10-14-r2.json';
const PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_DIGEST = 'sha256:89a8fb541ea527c4b314a7c1c1b588b4465ca33ca2107cc9b7315b4c951c68aa';
const PDP1_OWNER_STATUS_JOIN_TEST_R3_PATH = 'docs/implementation/observations/media-discovery-pdp1-owner-status-join-test-refresh-2026-10-14-r3.json';
const PDP1_OWNER_STATUS_JOIN_TEST_R3_DIGEST = 'sha256:f5ef16bdf4b23b866135de97ecf43b876f985e630a54980af7edecdcee433686';
const PDP1_OWNER_STATUS_JOIN_TEST_PATH = 'tests/media-discovery-pdp1-supplemental-owner-status-join.test.mjs';
const PDP1_OWNER_STATUS_JOIN_TEST_PREDECESSOR_DIGEST = 'sha256:0c0b593a3cfa0a1cecfc1c6eb016d4c1f6019a24bbc2ea5755e849c679bd4839';
const PDP1_OWNER_STATUS_JOIN_TEST_OBSERVED_DIGEST = 'sha256:ec1169c9c7a5c147dac13a24460d5f73dc9517861752bb0b5b1fe72f9f068d88';
const PDP1_THREE_REVIEW_TRANSITIONS = [
  { path: '.product-experience/interface-parity/current-source-review.json', predecessorSha256: 'sha256:0ce764d11912596ee39057db9bd0f2dfbf3c85f6269d55632bda3b3e6e4ad0dd', observedSha256: 'sha256:90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76' },
  { path: PDP1_OPERATIONS_REVIEW_PATH, predecessorSha256: 'sha256:e0fff26ea178606b97098ccd255aedec443d495227c563adbce671db1f0a5d21', observedSha256: 'sha256:6a00513dbe97182091a5b1b47fad2dc3e702ffaed962b835d2d4dffb822ff5b8' },
  { path: 'tests/pdp1-owner-action-wire-contracts.test.mjs', predecessorSha256: 'sha256:95e37d1273fd5aef4e1dc00cc68226aee9a04a235fed19b12a479fe47c979cb5', observedSha256: 'sha256:e1f628e3b24e8054d0a5f9a7d5925306c1be9db05919c685628e3b71a56ad58e' },
];
const CURRENT_CUT_PDP0_SUCCESSOR_PATH = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json';
const CURRENT_CUT_PDP0_SUCCESSOR_CURRENTNESS_PATH = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r10.json';
const CURRENT_CUT_PDP0_SUCCESSOR_DIGEST = 'sha256:f6c0e6a693ce74b0997743bbd2317f9f7ae0ab25e6f562aabf77f1ad2a9375a9';
const CURRENT_CUT_PDP0_SUCCESSOR_CURRENTNESS_DIGEST = 'sha256:1f2ee24f5913b8d9d9fc6d306a2d1356347f16e437e49de59e3f502643c83d0e';
const CURRENT_CUT_PDP0_SUCCESSOR_MATERIAL_FINGERPRINT = 'sha256:af292ca4f4d3d932fa081c42bb09273a286ec8aae83975a827f63cbc633b4687';
const IMMEDIATE_PDP0_PREDECESSOR_PATH = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r11.json';
const IMMEDIATE_PDP0_PREDECESSOR_CURRENTNESS_PATH = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r11.json';
const IMMEDIATE_PDP0_PREDECESSOR_DIGEST = 'sha256:fe8e73184cf385328a4974a9a3b2aad84ff9033fb999c80c10f49c3db066c4ea';
const IMMEDIATE_PDP0_PREDECESSOR_CURRENTNESS_DIGEST = 'sha256:b6986cd2e93241c9962d1215977c99f899949f87da15a72d8087e6ad130d7026';
const IMMEDIATE_PDP0_PREDECESSOR_MATERIAL_FINGERPRINT = 'sha256:d9fc2839dc341cb05250e31093a2250678a9004febffaf290d4852e29f7282f1';
const IMMEDIATE_PDP0_PREDECESSOR_OBSERVED_HEAD = 'e58e67084a4871dc21fb10523f0bcd0df8167d47';
const CURRENT_CUT_SOURCE_PATHS = [
  'scripts/report-media-pdp-readiness.mjs',
  '.product-experience/interface-parity/current-source-review.json',
  'tests/media-pdp-p1-dev-status.test.mjs',
];
const CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS = {
  'scripts/report-media-pdp-readiness.mjs': 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1',
  '.product-experience/interface-parity/current-source-review.json': 'sha256:14cf6c3d9ea948e39e41ffa2de3453c08b7b6a23267f407f3504c5462b7428fc',
  'tests/media-pdp-p1-dev-status.test.mjs': 'sha256:5a007a561cc96659d7da63d2470727237d1496c3a50c80682253a9d542846599',
};
const CURRENT_CUT_SOURCE_OBSERVED_DIGESTS = {
  'scripts/report-media-pdp-readiness.mjs': 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573',
  '.product-experience/interface-parity/current-source-review.json': 'sha256:62765cbb335572f28570fe650b3955aaa028f314322490e17e466d3ca9234abf',
  'tests/media-pdp-p1-dev-status.test.mjs': 'sha256:3ff1576a4a3987f5b1e05d15ae77e35a62745260e127ebcb28c1bb49ef7ef82e',
};
const PDP1_R1_OPERATIONS_DIGEST = 'sha256:317878be9ebe9c978f356a4e81060620fcb69af02ea25c2ff1d47bd20180c069';
const PDP1_R1_OPERATIONS_REVIEW_DIGEST = 'sha256:71a27400d00faccba8643393259c1322861593783015426b6eeddbcf068afaf2';
const PDP1_R1_REVIEWED_DEFINITION_IDS = [
  'media.observation-contract.rights-decision.v1',
  'media.observation-contract.destination-delivery-acknowledgment.v1',
  'media.observation-contract.delegated-integration-result-context.v1',
  'media.observation-contract.processing-parameter-read.v1',
  'media.observation-contract.effective-processing-constraints.v1',
];
const PRE_PXD164_CURRENT_CUT_PDP1_TEST_COMMAND = 'node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs tests/pdp1-owner-action-wire-contracts.test.mjs tests/pdp1-transition-guard-definition-evaluator.test.mjs tests/pdp-truth-domain-typed-observations.test.mjs';
const CURRENT_CUT_PDP1_TEST_COMMAND = `${PRE_PXD164_CURRENT_CUT_PDP1_TEST_COMMAND} tests/pdp1-j04-selected-target-operation-binding.test.mjs`;
const CURRENT_CUT_PDP1_TEST_FILES = CURRENT_CUT_PDP1_TEST_COMMAND.split(' ').slice(2);
const CURRENT_CUT_PDP1_SOURCE_PATHS = [
  'tests/pdp1-j04-selected-target-operation-binding.test.mjs',
  'scripts/lib/pdp-selected-target-operation-binding.mjs',
];
const PDP1_PARITY_TEST_PATHS = [
  'tests/media-contract-parity.test.mjs',
  'tests/media-contract-parity-definition-only-cli.test.mjs',
];
const REQUIRED_TEST_FILES = [
  'tests/media-pdp-p1-dev-status.test.mjs',
  'tests/media-contract-parity.test.mjs',
  'tests/media-contract-parity-definition-only-cli.test.mjs',
  'tests/pdp1-owner-action-wire-contracts.test.mjs',
  'tests/pdp1-transition-guard-definition-evaluator.test.mjs',
  'tests/pdp-truth-domain-typed-observations.test.mjs',
  'tests/media-pdp1-mdc30-owner-result-bindings.test.mjs',
  'tests/pdp1-operation-current-source-review.test.mjs',
  'tests/pdp1-interface-current-source-review.test.mjs',
  'tests/media-discovery-pdp1-c22-impact.test.mjs',
  'tests/media-discovery-pdp1-capture-source-chains.test.mjs',
  'tests/media-discovery-pdp1-three-review-source-transition.test.mjs',
  'tests/media-discovery-pdp1-supplemental-owner-status-join.test.mjs',
];

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hashValue(value) {
  return sha256(canonicalizeVerificationValue(value));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseTestOutcome(command, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  const outcome = {
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  };
  if (command === REQUIRED_TEST_COMMAND || command === CURRENT_CUT_PDP1_TEST_COMMAND || command === PDP1_OPERATION_PARITY_TEST_COMMAND) {
    const tests = output.match(/(?:ℹ|#)\s+tests\s+(\d+)/u);
    const passed = output.match(/(?:ℹ|#)\s+pass\s+(\d+)/u);
    const failed = output.match(/(?:ℹ|#)\s+fail\s+(\d+)/u);
    const skipped = output.match(/(?:ℹ|#)\s+skipped\s+(\d+)/u);
    Object.assign(outcome, {
      status: result.exitCode === 0 ? 'PASS' : 'FAIL',
      testCount: tests ? Number(tests[1]) : null,
      passedCount: passed ? Number(passed[1]) : null,
      failedCount: failed ? Number(failed[1]) : null,
      skippedCount: skipped ? Number(skipped[1]) : null,
    });
  } else {
    const sourceFindings = output.match(/source findings audited:\s*(\d+)\s*\((\d+) dispositioned;\s*(\d+) unresolved\)/u);
    const historicalFindings = output.match(/historical source findings:\s*(\d+)\s*\((\d+) dispositioned;\s*(\d+) unresolved;\s*(\d+) retired routes\)/u);
    Object.assign(outcome, {
      status: command === REQUIRED_STRICT_COMMAND
        ? (result.exitCode === 1 ? 'NON_GREEN_EXPECTED_OWNER_ADMISSION_FINDING' : 'UNEXPECTED_RESULT')
        : (result.exitCode === 0 ? 'PASS' : 'FAIL'),
      sourceFindings: sourceFindings ? {
        audited: Number(sourceFindings[1]), dispositioned: Number(sourceFindings[2]), unresolved: Number(sourceFindings[3]),
      } : null,
      historicalFindings: historicalFindings ? {
        audited: Number(historicalFindings[1]), dispositioned: Number(historicalFindings[2]), unresolved: Number(historicalFindings[3]), retiredRoutes: Number(historicalFindings[4]),
      } : null,
      unresolvedFinding: output.match(/^\s*- semantic binding unresolved:\s*(.+)$/mu)?.[1]?.trim().replace(/;{2,}/gu, ';') ?? null,
    });
  }
  return outcome;
}

function snapshotPdp1Logs() {
  const directory = path.join(root, 'docs/implementation/verification/pdp-38');
  return new Map(fs.readdirSync(directory)
    .filter((entry) => /^P1-.*\.log$/u.test(entry))
    .map((entry) => [path.join(directory, entry), fs.readFileSync(path.join(directory, entry))]));
}

function runRequiredChecks(dimensions) {
  const startedHead = git(['rev-parse', 'HEAD']);
  const localCheckInputBefore = sha256(fs.readFileSync(path.join(root, 'scripts/check-product-experience-local.mjs')));
  const priming = [captureRepositorySourceCurrentness(root, dimensions), captureRepositorySourceCurrentness(root, dimensions)];
  const before = captureRepositorySourceCurrentness(root, dimensions);
  const pdp1LogsBefore = snapshotPdp1Logs();
  const testResult = runCommand(process.execPath, ['--test', ...REQUIRED_TEST_FILES]);
  const operationParityImpactTestResult = runCommand(process.execPath, ['--test', PDP1_OPERATION_PARITY_SUCCESSOR_TEST_PATH]);
  const currentCutTestResult = runCommand(process.execPath, ['--test', ...CURRENT_CUT_PDP1_TEST_FILES]);
  const localExperienceResult = runCommand('pnpm', ['check:product-experience-local']);
  const strictResult = runCommand('pnpm', ['check:contract-parity']);
  const definitionResult = runCommand(process.execPath, ['scripts/check-media-contract-parity.mjs', '--definition-only']);
  const generatedLogChanges = [];
  for (const [absolutePath, priorContents] of pdp1LogsBefore) {
    if (!fs.existsSync(absolutePath)) continue;
    const afterContents = fs.readFileSync(absolutePath);
    if (!afterContents.equals(priorContents)) {
      fs.writeFileSync(absolutePath, priorContents);
      generatedLogChanges.push({
        path: path.relative(root, absolutePath),
        generatedSha256: sha256(afterContents),
        restoredSha256: sha256(priorContents),
        restoredToPreRunBytes: true,
      });
    }
  }
  const afterCaptures = [captureRepositorySourceCurrentness(root, dimensions), captureRepositorySourceCurrentness(root, dimensions)];
  const after = afterCaptures[1];
  const stable = captureIsStable(before) && afterCaptures.every(captureIsStable)
    && before.sourceToken === after.sourceToken
    && before.contentFingerprint === after.contentFingerprint
    && before.pathMembershipDigest === after.pathMembershipDigest;
  const testOutcomes = [
    parseTestOutcome(REQUIRED_TEST_COMMAND, testResult),
    parseTestOutcome(PDP1_OPERATION_PARITY_TEST_COMMAND, operationParityImpactTestResult),
    parseTestOutcome(CURRENT_CUT_PDP1_TEST_COMMAND, currentCutTestResult),
    parseTestOutcome(REQUIRED_LOCAL_EXPERIENCE_COMMAND, localExperienceResult),
    parseTestOutcome(REQUIRED_STRICT_COMMAND, strictResult),
    parseTestOutcome(REQUIRED_DEFINITION_ONLY_COMMAND, definitionResult),
  ];
  const localCheckInputAfter = sha256(fs.readFileSync(path.join(root, 'scripts/check-product-experience-local.mjs')));
  return {
    runner: 'scripts/record-media-discovery-pdp1-phase-exit.mjs',
    startedHead,
    completedHead: git(['rev-parse', 'HEAD']),
    sourceBinding: {
      stable,
      sourceTokenBefore: before.sourceToken ?? null,
      contentFingerprintBefore: before.contentFingerprint ?? null,
      pathMembershipDigestBefore: before.pathMembershipDigest ?? null,
      sourceToken: after.sourceToken ?? null,
      contentFingerprint: after.contentFingerprint ?? null,
      pathMembershipDigest: after.pathMembershipDigest ?? null,
      before: summarizeCapture(before),
      after: afterCaptures.map(summarizeCapture),
      lifecyclePriming: priming.map(summarizeCapture),
      generatedLogsRestored: generatedLogChanges,
      testInputContentDigests: {
        ...Object.fromEntries(REQUIRED_TEST_FILES.map((sourcePath) => [sourcePath, sha256(fs.readFileSync(path.join(root, sourcePath)))])),
        ...Object.fromEntries(CURRENT_CUT_PDP1_SOURCE_PATHS.map((sourcePath) => [sourcePath, sha256(fs.readFileSync(path.join(root, sourcePath)))])),
        [PDP1_OPERATION_PARITY_SUCCESSOR_TEST_PATH]: sha256(fs.readFileSync(path.join(root, PDP1_OPERATION_PARITY_SUCCESSOR_TEST_PATH))),
      },
      localExperienceCheckInput: {
        path: 'scripts/check-product-experience-local.mjs',
        sha256Before: localCheckInputBefore,
        sha256After: localCheckInputAfter,
        stable: localCheckInputBefore === localCheckInputAfter,
      },
    },
    testOutcomes,
  };
}

function validateReporterImpactRecord(impact, observedDigests, historicalDigests, statusPins, semanticPins) {
  const receiptPath = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r4.json';
  const receipt = readJson(receiptPath);
  const receiptDigest = sha256(fs.readFileSync(path.join(root, receiptPath)));
  const cut = impact.predecessorCuts?.find((entry) => entry.phase === 'PDP-1');
  const delta = impact.sourceDelta;
  const valid = impact.schemaVersion === 'media.discovery-predecessor-source-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-PREDECESSOR-IMPACT-PDP3-STATUS-GUARD-2026-10-14-R1'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY'
    && impact.campaign?.activePhase === 'PDP-0'
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.authorityRef === '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PRODUCT_AND_ENGINEERING_SOURCE_IMPACT_REVIEW'
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && delta?.path === PDP1_GUARD_PATH
    && delta?.predecessorSha256 === PDP1_GUARD_PREDECESSOR_DIGEST
    && delta?.observedSha256 === PDP1_GUARD_OBSERVED_DIGEST
    && Array.isArray(delta?.changedFunctions)
    && delta.changedFunctions.length === 2
    && delta.changedFunctions[0] === 'buildPdp3SourceCensus'
    && delta.changedFunctions[1] === 'buildPdp3DevStatus'
    && delta?.predecessorPhaseMeaningDisposition?.['PDP-1'] === 'NO_MEANING_CHANGE'
    && Array.isArray(delta?.changedMeaningIds) && delta.changedMeaningIds.length === 0
    && Array.isArray(delta?.outstandingPredecessorMeaningIds) && delta.outstandingPredecessorMeaningIds.length === 0
    && delta?.freshCurrentnessRequired === true
    && cut?.receiptRef === receiptPath
    && cut?.receiptSha256 === receiptDigest
    && cut?.materialSourceSetFingerprint === 'sha256:1da1c83eda4ad1f4bed0ad35c27564887ca06b05ea2251a7f1f8b49e1c9176d5'
    && cut?.materialPathCount === 329
    && cut?.recordedPathDigest === PDP1_GUARD_PREDECESSOR_DIGEST
    && receipt.phase === 'PDP-1'
    && receipt.sourceCurrentness?.materialSourceSetFingerprint === cut.materialSourceSetFingerprint
    && Object.keys(receipt.sourceCurrentness?.sourceContentDigests ?? {}).length === 329
    && receipt.sourceCurrentness.sourceContentDigests[PDP1_GUARD_PATH] === PDP1_GUARD_PREDECESSOR_DIGEST
    && `sha256:${String(statusPins[PDP1_GUARD_PATH] ?? '').replace(/^sha256:/u, '')}` === PDP1_GUARD_PREDECESSOR_DIGEST
    && `sha256:${String(semanticPins[PDP1_GUARD_PATH] ?? '').replace(/^sha256:/u, '')}` === PDP1_GUARD_PREDECESSOR_DIGEST
    && impact.decision?.status === 'APPROVED_INTERNAL_NON_IMPACT_FOR_EXACT_SOURCE_DELTA'
    && impact.decision?.reusePriorPdp0Pdp1Pdp2Meaning === true
    && impact.decision?.preserveHistoricalReceipts === true
    && impact.decision?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && impact.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && impact.decision?.build === 'NOT_ENTERED'
    && impact.decision?.delivery === 'BLOCKED'
    && JSON.stringify(impact.decision?.requiresOrderedTechnicalCurrentnessRecapture) === JSON.stringify(['PDP-0', 'PDP-1', 'PDP-2'])
    && (observedDigests[PDP1_GUARD_PATH]?.digest ?? observedDigests[PDP1_GUARD_PATH]) === PDP1_GUARD_OBSERVED_DIGEST
    && historicalDigests[PDP1_GUARD_PATH] === PDP1_GUARD_PREDECESSOR_DIGEST;
  return { valid, impact, path: PDP1_GUARD_PATH, predecessorSha256: PDP1_GUARD_PREDECESSOR_DIGEST, observedSha256: PDP1_GUARD_OBSERVED_DIGEST };
}

export function validatePdp1InterfaceReviewImpactRecord(record, { predecessorRecord, observedDigests, historicalDigests, statusPins, semanticPins,
  recordPath = PDP1_INTERFACE_REVIEW_IMPACT_PATH, predecessorRecordPath = CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH,
  historicalSuccessor = false } = {}) {
  const historicalCut = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const historicalCutDigests = historicalCut.sourceCurrentness?.sourceContentDigests ?? {};
  const r1Impact = readJson(CURRENT_CUT_SOURCE_IMPACT_PATH);
  const r1InterfaceDelta = r1Impact.sourceDeltas?.find((delta) => delta.path === PDP1_INTERFACE_REVIEW_PATH);
  const historicalOperationsPin = historicalCutDigests[PDP1_OPERATIONS_PATH];
  const parentDigest = sha256(fs.readFileSync(path.join(root, predecessorRecordPath)));
  const predecessorDelta = predecessorRecord?.sourceDelta;
  const historicalInterfaceDigest = historicalCutDigests[PDP1_INTERFACE_REVIEW_PATH];
  const impactDigest = sha256(fs.readFileSync(path.join(root, recordPath)));
  const sourceDelta = record?.sourceDelta;
  const observed = historicalSuccessor ? sourceDelta?.observedSha256
    : observedDigests?.[PDP1_INTERFACE_REVIEW_PATH]?.digest ?? observedDigests?.[PDP1_INTERFACE_REVIEW_PATH];
  const exactSuccessorTransition = historicalSuccessor
    ? validatePdp1ThreeReviewSourceTransition(readJson(PDP1_THREE_REVIEW_TRANSITIONS_PATH), {
      observedDigests, statusPins, semanticPins,
    }) : null;
  const authorizedCurrentSuccessor = historicalSuccessor
    && exactSuccessorTransition?.valid === true
    && exactSuccessorTransition.rowChecks.find((row) => row.path === PDP1_INTERFACE_REVIEW_PATH)?.predecessorSha256 === sourceDelta?.observedSha256
    && exactSuccessorTransition.rowChecks.find((row) => row.path === PDP1_INTERFACE_REVIEW_PATH)?.valid === true
    && validatePdp1InterfaceReviewPinRefreshImpact().valid === true
    && validatePdp1InterfaceReviewPinRefreshImpact().predecessorSha256 === 'sha256:866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd'
    && validatePdp1InterfaceReviewPinRefreshImpact().observedSha256 === sha256(fs.readFileSync(path.join(root, PDP1_INTERFACE_REVIEW_PATH)));
  const valid = record?.schemaVersion === 'media.discovery-pdp1-additional-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-INTERFACE-REVIEW-IMPACT-2026-10-14-R4'
    && impactDigest === PDP1_INTERFACE_REVIEW_IMPACT_DIGEST
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY' && record?.campaign?.phase === 'PDP-1'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record?.authority?.authorityRef === '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && record?.authority?.userAuthorization === 'NO_ADDITIONAL_P1_MEANING_FOR_EXACT_INTERFACE-REVIEW-PATH'
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.parentImpact?.ref === predecessorRecordPath
    && record?.parentImpact?.recordId === predecessorRecord?.recordId
    && record?.parentImpact?.sha256 === parentDigest
    && sourceDelta?.path === PDP1_INTERFACE_REVIEW_PATH
    && sourceDelta?.selector === 'sources[.product-experience/pdp-1-domain-data/operations.yaml].sha256'
    && sourceDelta?.predecessorSha256 === predecessorDelta?.observedSha256
    && sourceDelta?.predecessorSha256 === PDP1_INTERFACE_REVIEW_PREDECESSOR_DIGEST
    && sourceDelta?.observedSha256 === historicalInterfaceDigest
    && sourceDelta?.observedSha256 === PDP1_INTERFACE_REVIEW_OBSERVED_DIGEST
    && observed === sourceDelta?.observedSha256
    && (historicalSuccessor ? authorizedCurrentSuccessor
      : sha256(fs.readFileSync(path.join(root, PDP1_INTERFACE_REVIEW_PATH))) === sourceDelta?.observedSha256)
    && sourceDelta?.pinnedOperationsSha256 === PDP1_INTERFACE_REVIEW_OPERATIONS_PIN_DIGEST
    && historicalOperationsPin === PDP1_INTERFACE_REVIEW_OPERATIONS_PIN_DIGEST
    && predecessorDelta?.predecessorSha256 === r1InterfaceDelta?.observedSha256
    && historicalDigests?.[PDP1_INTERFACE_REVIEW_PATH] === r1InterfaceDelta?.predecessorSha256
    && historicalCutDigests[PDP1_INTERFACE_REVIEW_PATH] === PDP1_INTERFACE_REVIEW_OBSERVED_DIGEST
    && sourceDelta?.classification === 'PDP1_INTERFACE_REVIEW_SOURCE_PIN_CORRECTION'
    && sourceDelta?.meaningChange === 'NO_ADDITIONAL_P1_MEANING'
    && Array.isArray(sourceDelta?.meaningIdsChanged) && sourceDelta.meaningIdsChanged.length === 0
    && sourceDelta?.requiresFreshCurrentness === true
    && record?.decision?.status === 'INTERNAL_SCOPED_IMPACT_DISPOSITION'
    && record?.decision?.pdp1MeaningDisposition === 'NO_ADDITIONAL_P1_MEANING_FOR_EXACT_INTERFACE_REVIEW_PATH'
    && record?.decision?.preserveHistoricalReceipts === true
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentAcceptance === 'NOT_CLAIMED'
    && record?.decision?.runtime === 'NOT_CLAIMED'
    && record?.decision?.closure === 'NOT_CLAIMED'
    && record?.decision?.delivery === 'NOT_CLAIMED'
    && record?.decision?.release === 'NOT_CLAIMED';
  return { valid, recordRef: recordPath, recordId: record?.recordId ?? null, digest: impactDigest,
    path: PDP1_INTERFACE_REVIEW_PATH, predecessorSha256: sourceDelta?.predecessorSha256 ?? null,
    observedSha256: sourceDelta?.observedSha256 ?? null,
    historicalSuccessor, authorizedCurrentSuccessor };
}

export function validatePdp1AdditionalSourceImpactRecord(record, { impact, observedDigests, historicalDigests, statusPins, semanticPins, recordPath = CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH }) {
  const interfacePath = '.product-experience/interface-parity/current-source-review.json';
  const historicalCut = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const historicalCutDigests = historicalCut.sourceCurrentness?.sourceContentDigests ?? {};
  const r1Delta = (impact?.sourceDeltas ?? []).find((delta) => delta.path === interfacePath);
  const currentSha256 = historicalCutDigests[interfacePath] ?? null;
  const sourceDelta = record?.sourceDelta;
  const parentDigest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_SOURCE_IMPACT_PATH)));
  const successorRecord = readJson(PDP1_INTERFACE_REVIEW_IMPACT_PATH);
  const successorDelta = successorRecord?.sourceDelta;
  const successorReview = validatePdp1InterfaceReviewImpactRecord(successorRecord, {
    predecessorRecord: record, observedDigests, historicalDigests, statusPins, semanticPins, historicalSuccessor: true,
  });
  const successorValid = successorReview.valid;
  const valid = record?.schemaVersion === 'media.discovery-pdp1-additional-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R2'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY'
    && record?.campaign?.phase === 'PDP-1'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record?.authority?.authorityRef === '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.parentImpact?.ref === CURRENT_CUT_SOURCE_IMPACT_PATH
    && record?.parentImpact?.recordId === 'MEDIA-DISCOVERY-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1'
    && record?.parentImpact?.sha256 === parentDigest
    && sourceDelta?.path === interfacePath
    && sourceDelta?.selector === `${PDP1_OPERATIONS_REVIEW_PATH}#currentSourceCutDeltaReview/supplementalPdp1DefinitionDelta`
    && sourceDelta?.predecessorSha256 === r1Delta?.observedSha256
    && sourceDelta?.predecessorSha256 === r1Delta?.observedSha256
    && sourceDelta?.observedSha256 === PDP1_INTERFACE_REVIEW_PREDECESSOR_DIGEST
    && currentSha256 === PDP1_INTERFACE_REVIEW_OBSERVED_DIGEST
    && successorValid
    && historicalDigests[interfacePath] === r1Delta?.predecessorSha256
    && historicalDigests[interfacePath] === r1Delta?.predecessorSha256
    && sourceDelta?.classification === 'PDP1_REVIEW_ARTIFACT_REFRESH_FOR_SEPARATELY_REVIEWED_OPERATION_DELTA'
    && sourceDelta?.meaningChange === 'NO_ADDITIONAL_MEANING'
    && Array.isArray(sourceDelta?.meaningIdsChanged) && sourceDelta.meaningIdsChanged.length === 0
    && Array.isArray(sourceDelta?.additionalMeaningIds) && sourceDelta.additionalMeaningIds.length === 0
    && sourceDelta?.requiresFreshCurrentness === true
    && record?.decision?.status === 'INTERNAL_SCOPED_IMPACT_DISPOSITION'
    && record?.decision?.pdp1MeaningDisposition === 'NO_ADDITIONAL_MEANING_FOR_EXACT_INTERFACE_REVIEW_REFRESH'
    && record?.decision?.preserveHistoricalReceipts === true
    && record?.decision?.externalContractOwnerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentReview === 'NOT_CLAIMED'
    && record?.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.decision?.lifecycleClosure === 'NOT_ENTERED'
    && record?.decision?.delivery === 'BLOCKED';
  return { valid, recordRef: PDP1_INTERFACE_REVIEW_IMPACT_PATH, recordId: successorRecord?.recordId ?? null,
    digest: successorReview.digest, path: interfacePath, predecessorSha256: successorDelta?.predecessorSha256 ?? null,
    observedSha256: successorDelta?.observedSha256 ?? null,
    previousImpactRef: CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH, previousImpactDigest: sha256(fs.readFileSync(path.join(root, recordPath))) };
}

export function validatePdp1OwnerWireImpactRecord(record, { observedDigests, historicalDigests,
  recordPath = PDP1_OWNER_WIRE_IMPACT_PATH } = {}) {
  const predecessorPath = PDP1_OWNER_WIRE_PREDECESSOR_IMPACT_PATH;
  const predecessorRecord = readJson(predecessorPath);
  const predecessorDigest = sha256(fs.readFileSync(path.join(root, predecessorPath)));
  const r2Digest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH)));
  const liveDigest = sha256(fs.readFileSync(path.join(root, PDP1_OWNER_WIRE_PATH)));
  const sourceDeltas = record?.sourceDeltas;
  const delta = sourceDeltas?.[0];
  const observed = observedDigests?.[PDP1_OWNER_WIRE_PATH]?.digest ?? observedDigests?.[PDP1_OWNER_WIRE_PATH];
  const authorizedAt = Date.parse(record?.observedAt ?? '');
  const valid = record?.schemaVersion === 'media.discovery-pdp1-additional-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-OWNER-ACTION-WIRE-IMPACT-2026-10-14-R5'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY' && record?.campaign?.phase === 'PDP-1'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record?.authority?.authorityRef === '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && record?.authority?.userAuthorization === 'Authorize no additional PDP-1 meaning (Recommended)'
    && record?.authority?.authorizationEvidence?.channel === 'DIRECT_USER_REPLY_IN_CURRENT_TASK'
    && record?.authority?.authorizationEvidence?.exactResponse === 'Authorize no additional PDP-1 meaning (Recommended)'
    && record?.authority?.authorizationEvidence?.authorizedPath === PDP1_OWNER_WIRE_PATH
    && record?.authority?.authorizationEvidence?.predecessorSha256 === PDP1_OWNER_WIRE_PREDECESSOR_DIGEST
    && record?.authority?.authorizationEvidence?.observedSha256 === liveDigest
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && Number.isFinite(authorizedAt) && new Date(authorizedAt).toISOString().startsWith('2026-10-14T')
    && record?.observedAt !== '2026-10-14T00:00:00.000Z'
    && record?.parentImpact?.ref === predecessorPath
    && record?.parentImpact?.recordId === predecessorRecord?.recordId
    && record?.parentImpact?.sha256 === predecessorDigest
    && record?.supersedes?.ref === predecessorPath
    && record?.supersedes?.recordId === predecessorRecord?.recordId
    && record?.supersedes?.sha256 === predecessorDigest
    && predecessorRecord?.parentImpact?.ref === CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH
    && predecessorRecord?.parentImpact?.recordId === 'MEDIA-DISCOVERY-PDP1-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R2'
    && predecessorRecord?.parentImpact?.sha256 === r2Digest
    && Array.isArray(sourceDeltas) && sourceDeltas.length === 1
    && delta?.path === PDP1_OWNER_WIRE_PATH
    && delta?.selector === 'resultProjectionBindings and records/@id=media.owner-action-wire.deliver-exact-version.v1|media.owner-action-wire.inspect-consent-and-permitted-use.v1/semantics/sourceDeclaredResultFields'
    && delta?.predecessorSha256 === PDP1_OWNER_WIRE_PREDECESSOR_DIGEST
    && historicalDigests?.[PDP1_OWNER_WIRE_PATH] === PDP1_OWNER_WIRE_PREDECESSOR_DIGEST
    && delta?.observedSha256 === liveDigest && observed === liveDigest
    && JSON.stringify(delta?.sourceFields) === JSON.stringify([
      'deliveryRequestFingerprint', 'deliveryRequestResultRef', 'exactTargetRef',
      'artifactDigest', 'artifactVersionRef', 'sourceArtifactVersionRef', 'sourceDigest',
    ])
    && delta?.classification === 'PDP1_NOT_EXPOSED_MAPPING_LEDGER_REFRESH'
    && delta?.meaningChange === 'NO_ADDITIONAL_PDP1_MEANING'
    && Array.isArray(delta?.meaningIdsChanged) && delta.meaningIdsChanged.length === 0
    && delta?.requiresFreshCurrentness === true
    && record?.decision?.status === 'INTERNAL_SCOPED_IMPACT_DISPOSITION'
    && record?.decision?.pdp1MeaningDisposition === 'NO_ADDITIONAL_PDP1_MEANING_FOR_EXACT_OWNER_ACTION_WIRE_LEDGER_REFRESH'
    && record?.decision?.preserveHistoricalReceipts === true
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentAcceptance === 'NOT_CLAIMED'
    && record?.decision?.runtime === 'NOT_ADMITTED'
    && record?.decision?.closure === 'NOT_ENTERED'
    && record?.decision?.delivery === 'BLOCKED'
    && record?.decision?.release === 'NOT_CLAIMED';
  return { valid, recordRef: recordPath, recordId: record?.recordId ?? null, digest: record ? sha256(fs.readFileSync(path.join(root, recordPath))) : null,
    path: PDP1_OWNER_WIRE_PATH, predecessorSha256: delta?.predecessorSha256 ?? null, observedSha256: delta?.observedSha256 ?? null };
}

export function validatePdp1C22SemanticRepairImpact(record, {
  observedDigests = {}, historicalDigests = {}, statusPins = {}, semanticPins = {}, recordPath = PDP1_C22_IMPACT_PATH,
} = {}) {
  if (recordPath !== PDP1_C22_IMPACT_PATH) {
    return { valid: false, recordRef: recordPath, recordId: record?.recordId ?? null, digest: null,
      sourceDeltas: [], operationSemanticsValid: false, wireSemanticsValid: false, exactDeltas: false, reviewInputsValid: false };
  }
  const diskRecord = readJson(recordPath);
  const suppliedRecordMatchesDisk = canonicalizeVerificationValue(record) === canonicalizeVerificationValue(diskRecord);
  const impactDigest = sha256(fs.readFileSync(path.join(root, recordPath)));
  const operationBytes = fs.readFileSync(path.join(root, PDP1_OPERATIONS_PATH));
  const wireBytes = fs.readFileSync(path.join(root, PDP1_OWNER_WIRE_PATH));
  const r16 = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const r16SourceDigests = r16.sourceCurrentness?.sourceContentDigests ?? {};
  const operationsDigest = sha256(operationBytes);
  const wireDigest = sha256(wireBytes);
  const pxd164Impact = validatePdp1Pxd164SemanticRepairImpact(readJson(PDP1_PXD164_IMPACT_PATH), { observedDigests });
  const pxd164OperationDigest = pxd164Impact.sourceDeltas.find((row) => row.path === PDP1_OPERATIONS_PATH)?.observedSha256;
  const pxd164WireDigest = pxd164Impact.sourceDeltas.find((row) => row.path === PDP1_OWNER_WIRE_PATH)?.observedSha256;
  const interfacePinRefreshImpact = validatePdp1InterfaceReviewPinRefreshImpact();
  const operations = parseYaml(operationBytes.toString('utf8'));
  const wire = parseYaml(wireBytes.toString('utf8'));
  const operation = operations.ownerDefinedOperationContracts?.records?.find(({ id }) => id === 'media.operation.action.deliver-exact-version');
  const projection = wire.resultProjectionBindings?.find(({ sourceOperationRef }) =>
    sourceOperationRef === '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.deliver-exact-version');
  const wireRecord = wire.records?.find(({ id }) => id === 'media.owner-action-wire.deliver-exact-version.v1');
  const success = wireRecord?.resultSchema?.oneOf?.find(({ properties }) => properties?.outcome?.const === 'REQUEST_ACCEPTED');
  const rejected = wireRecord?.resultSchema?.oneOf?.find(({ properties }) => properties?.outcome?.enum);
  const expectedFields = [
    'requestId', 'deliveryRequestId', 'deliveryRequestResultRef', 'deliveryRequestFingerprint',
    'exactTargetRef', 'artifactVersionId', 'destinationRef', 'ownerReceipt', 'observedAt',
  ];
  const expectedWireRequired = ['operationRef', 'actionRef', 'outcome', ...expectedFields];
  const operationParityProjectionImpact = validatePdp1OperationParityProjectionImpact(undefined, { observedDigests });
  const observation = readText('.product-experience/decision-log.md');
  const c22Decision = observation.split('\n').filter((line) => line.includes('C22 / J22')).join('\n');
  const reviewInputsValid = Object.entries(PDP1_C22_REVIEW_INPUT_DIGESTS).every(([sourcePath, expected]) => {
    const liveDigest = sha256(fs.readFileSync(path.join(root, sourcePath)));
    const successorRow = operationParityProjectionImpact.rowChecks.find((row) => row.path === sourcePath);
    const pxd164VerificationTransition = pxd164Impact.valid
      && sourcePath === PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.path
      && pxd164Impact.verificationInputs.find((row) => row.path === sourcePath)?.liveSha256 === liveDigest
      && record?.reviewInputs?.[sourcePath] === PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.predecessorSha256
      && pxd164Impact.recordId === 'MEDIA-DISCOVERY-PDP1-PXD164-SEMANTIC-REPAIR-IMPACT-2026-10-14-R1';
    const interfacePinRefreshTransition = sourcePath === PDP1_INTERFACE_REVIEW_PATH
      && interfacePinRefreshImpact.valid
      && record?.reviewInputs?.[sourcePath] === expected
      && successorRow?.observedSha256 === interfacePinRefreshImpact.predecessorSha256
      && interfacePinRefreshImpact.observedSha256 === liveDigest;
    return record?.reviewInputs?.[sourcePath] === expected
      && (liveDigest === expected || operationParityProjectionImpact.valid
        && successorRow?.predecessorSha256 === expected && successorRow?.observedSha256 === liveDigest
        || pxd164Impact.valid && pxd164Impact.sourceDeltas.some((row) => row.path === sourcePath && row.observedSha256 === liveDigest)
        || pxd164VerificationTransition || interfacePinRefreshTransition);
  });
  const operationSemanticsValid = operation?.operationKind === 'COMMAND'
    && operation.resultSchema?.successOutcome === 'REQUEST_ACCEPTED'
    && JSON.stringify(operation.resultSchema?.fields) === JSON.stringify(expectedFields)
    && operation.resultSchema?.fieldContracts?.deliveryRequestFingerprint?.computedBy === 'authenticated-trusted-host'
    && operation.resultSchema?.fieldContracts?.deliveryRequestFingerprint?.excludes?.includes('acknowledgment-query-fingerprint')
    && operation.resultSchema?.fieldContracts?.deliveryRequestResultRef?.identifies === 'immutable-result-of-this-delivery-request';
  const wireSemanticsValid = JSON.stringify(projection?.sourceDeclaredFields) === JSON.stringify(expectedFields.slice().sort())
    && JSON.stringify(projection?.normalizedSuccessFields) === JSON.stringify(expectedFields.slice().sort())
    && projection?.normalizedOnlyFields?.length === 0
    && JSON.stringify(success?.required) === JSON.stringify(expectedWireRequired)
    && success?.properties?.deliveryRequestFingerprint?.pattern === '^sha256:[a-f0-9]{64}$'
    && rejected?.properties?.outcome?.enum?.includes('UNKNOWN')
    && rejected?.properties?.outcome?.enum?.includes('REJECTED');
  const deltas = record?.sourceDeltas ?? [];
  const operationDelta = deltas.find(({ path: sourcePath }) => sourcePath === PDP1_OPERATIONS_PATH);
  const wireDelta = deltas.find(({ path: sourcePath }) => sourcePath === PDP1_OWNER_WIRE_PATH);
  const exactDeltas = deltas.length === 2
    && operationDelta?.selector === PDP1_C22_OPERATION_SELECTOR
    && operationDelta?.predecessorSha256 === PDP1_C22_OPERATIONS_PREDECESSOR_DIGEST
    && operationDelta?.observedSha256 === PDP1_C22_OPERATIONS_DIGEST
    && wireDelta?.selector === PDP1_C22_WIRE_SELECTOR
    && wireDelta?.predecessorSha256 === PDP1_C22_OWNER_WIRE_PREDECESSOR_DIGEST
    && wireDelta?.observedSha256 === PDP1_C22_OWNER_WIRE_DIGEST
    && deltas.every((delta) => delta.phase === 'PDP-1'
      && delta.classification === 'PXD163_MDC30_C22_SEMANTIC_REPAIR'
      && delta.meaningChange === 'PDP1_MEANING_CHANGED_AND_REVIEWED_UNDER_DELEGATED_INTERNAL_SOURCE_REVIEW'
      && JSON.stringify(delta.meaningIdsChanged) === JSON.stringify(['PXD-163/MDC30-C-22'])
      && delta.requiresFreshCurrentness === true);
  const boundaries = record?.boundaries;
  const valid = suppliedRecordMatchesDisk
    && impactDigest === PDP1_C22_IMPACT_DIGEST
    && record?.schemaVersion === 'media.discovery-pdp1-c22-semantic-repair-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-C22-SEMANTIC-REPAIR-IMPACT-2026-10-14'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY' && record?.campaign?.phase === 'PDP-1'
    && record?.decisionRef === '.product-experience/decision-log.md#PXD-163'
    && record?.taskId === 'MDC30-C-22'
    && record?.reviewDisposition === 'INTERNAL_SOURCE_DEFINITION_REVIEW_COMPLETE; PDP_PHASE_ACCEPTANCE_NOT_CLAIMED'
    && record?.limitation === 'This source-bound internal review covers only the listed exact R16-to-current C22 source transitions and selectors. It is not external owner acceptance, independent specialist acceptance, PDP phase acceptance, native closure, runtime or transport admission, or release authorization.'
    && record?.operationSelector === PDP1_C22_OPERATION_SELECTOR
    && record?.wireSelector === PDP1_C22_WIRE_SELECTOR
    && record?.resultTuple?.successOutcome === 'REQUEST_ACCEPTED'
    && JSON.stringify(record?.resultTuple?.operationResultFields) === JSON.stringify(expectedFields)
    && JSON.stringify(record?.resultTuple?.wireSuccessRequired) === JSON.stringify(expectedWireRequired)
    && JSON.stringify(record?.resultTuple?.negativeOutcomes) === JSON.stringify(['REJECTED', 'UNKNOWN'])
    && record?.resultTuple?.fingerprintComputedBy === 'authenticated-trusted-host'
    && record?.resultTuple?.acknowledgmentIsSeparate === true
    && reviewInputsValid
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record?.authority?.decisionRole === 'INTERNAL_PDP1_SOURCE_DEFINITION_REVIEW'
    && record?.authority?.humanOwnerAcceptance === 'NOT_CLAIMED'
    && record?.authority?.independentSpecialistAcceptance === 'NOT_CLAIMED'
    && record?.sourcePredecessor?.ref === CURRENT_CUT_PDP1_PREDECESSOR_PATH
    && record?.sourcePredecessor?.sha256 === CURRENT_CUT_PDP1_PREDECESSOR_DIGEST
    && r16?.observationId === 'MEDIA-PDP1-CURRENTNESS-CURRENT-CUT-R16'
    && sha256(fs.readFileSync(path.join(root, CURRENT_CUT_PDP1_PREDECESSOR_PATH))) === CURRENT_CUT_PDP1_PREDECESSOR_DIGEST
    && record?.sourcePredecessor?.sourceDigests?.[PDP1_OPERATIONS_PATH] === PDP1_C22_OPERATIONS_PREDECESSOR_DIGEST
    && record?.sourcePredecessor?.sourceDigests?.[PDP1_OWNER_WIRE_PATH] === PDP1_C22_OWNER_WIRE_PREDECESSOR_DIGEST
    && exactDeltas
    && (operationsDigest === PDP1_C22_OPERATIONS_DIGEST || pxd164Impact.valid && operationsDigest === pxd164OperationDigest)
    && (wireDigest === PDP1_C22_OWNER_WIRE_DIGEST || pxd164Impact.valid && wireDigest === pxd164WireDigest)
    && (observedDigests[PDP1_OPERATIONS_PATH]?.digest ?? observedDigests[PDP1_OPERATIONS_PATH]) === operationsDigest
    && (observedDigests[PDP1_OWNER_WIRE_PATH]?.digest ?? observedDigests[PDP1_OWNER_WIRE_PATH]) === wireDigest
    && r16SourceDigests[PDP1_OPERATIONS_PATH] === PDP1_C22_OPERATIONS_PREDECESSOR_DIGEST
    && r16SourceDigests[PDP1_OWNER_WIRE_PATH] === PDP1_C22_OWNER_WIRE_PREDECESSOR_DIGEST
    && [PDP1_C22_OPERATIONS_PREDECESSOR_DIGEST, PDP1_C22_OPERATIONS_DIGEST, ...(pxd164Impact.valid ? [pxd164OperationDigest] : [])].includes(`sha256:${String(statusPins[PDP1_OPERATIONS_PATH] ?? '').replace(/^sha256:/u, '')}`)
    && [PDP1_C22_OPERATIONS_PREDECESSOR_DIGEST, PDP1_C22_OPERATIONS_DIGEST, ...(pxd164Impact.valid ? [pxd164OperationDigest] : [])].includes(`sha256:${String(semanticPins[PDP1_OPERATIONS_PATH] ?? '').replace(/^sha256:/u, '')}`)
    && [PDP1_C22_OWNER_WIRE_PREDECESSOR_DIGEST, PDP1_C22_OWNER_WIRE_DIGEST, ...(pxd164Impact.valid ? [pxd164WireDigest] : [])].includes(`sha256:${String(statusPins[PDP1_OWNER_WIRE_PATH] ?? '').replace(/^sha256:/u, '')}`)
    && [PDP1_C22_OWNER_WIRE_PREDECESSOR_DIGEST, PDP1_C22_OWNER_WIRE_DIGEST, ...(pxd164Impact.valid ? [pxd164WireDigest] : [])].includes(`sha256:${String(semanticPins[PDP1_OWNER_WIRE_PATH] ?? '').replace(/^sha256:/u, '')}`)
    && operationSemanticsValid && wireSemanticsValid
    && c22Decision.includes('deliveryRequestFingerprint')
    && c22Decision.includes('only current authoritative destination evidence may establish ACK')
    && boundaries?.externalOwnerAcceptance === 'NOT_CLAIMED'
    && boundaries?.independentSpecialistAcceptance === 'NOT_CLAIMED'
    && boundaries?.nativeClosure === 'NOT_ENTERED'
    && boundaries?.runtimeAdmission === 'NOT_ADMITTED'
    && boundaries?.transportAdmission === 'NOT_ADMITTED'
    && boundaries?.release === 'NOT_AUTHORIZED';
  return {
    valid, recordRef: recordPath, recordId: record?.recordId ?? null, digest: impactDigest,
    sourceDeltas: deltas.map(({ path: sourcePath, selector, phase, predecessorSha256, observedSha256, classification, meaningChange, meaningIdsChanged }) => ({
      path: sourcePath, selector, phase, predecessorSha256, observedSha256, classification, meaningChange, meaningIdsChanged,
    })),
    operationSemanticsValid, wireSemanticsValid, exactDeltas, reviewInputsValid, suppliedRecordMatchesDisk,
    operationParityProjectionImpact,
  };
}

export function validatePdp2R1InterfaceReviewSuccessorImpact(record = readJson(PDP2_R1_SOURCE_IMPACT_PATH), {
  recordPath = PDP2_R1_SOURCE_IMPACT_PATH,
} = {}) {
  const onDisk = readJson(PDP2_R1_SOURCE_IMPACT_PATH);
  const digest = sha256(fs.readFileSync(path.join(root, PDP2_R1_SOURCE_IMPACT_PATH)));
  const deltas = record?.sourceDeltas ?? [];
  const matchingDeltas = deltas.filter((row) => row.path === PDP1_INTERFACE_REVIEW_PATH);
  const row = matchingDeltas[0];
  const userAuthorization = record?.authority?.userAuthorization;
  const authorizedTransitions = userAuthorization?.authorizedTransitions ?? [];
  const matchingAuthorizations = authorizedTransitions.filter((transition) => transition.path === PDP1_INTERFACE_REVIEW_PATH);
  const authorizedTransition = matchingAuthorizations[0];
  const valid = recordPath === PDP2_R1_SOURCE_IMPACT_PATH
    && digest === PDP2_R1_SOURCE_IMPACT_DIGEST
    && canonicalizeVerificationValue(record) === canonicalizeVerificationValue(onDisk)
    && record?.schemaVersion === 'media.discovery-pdp2-additional-source-impact.v3'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP2-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R1'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY'
    && record?.campaign?.activePhase === 'PDP-2'
    && userAuthorization?.status === 'AUTHORIZED'
    && userAuthorization?.authorizedBy === 'USER'
    && userAuthorization?.exactResponses?.includes('Authorize these three exact transitions (Recommended)')
    && matchingDeltas.length === 1
    && row?.phase === 'PDP-2'
    && row?.predecessorSha256 === PDP2_R1_INTERFACE_REVIEW_PREDECESSOR
    && row?.observedSha256 === PDP2_R1_INTERFACE_REVIEW_OBSERVED
    && row?.classification === 'PDP1_INTERFACE_SOURCE_REVIEW_REFRESH'
    && row?.meaningChange === 'NO_ADDITIONAL_PDP2_MEANING'
    && Array.isArray(row?.meaningIdsChanged) && row.meaningIdsChanged.length === 0
    && row?.requiresFreshCurrentness === true
    && matchingAuthorizations.length === 1
    && authorizedTransition?.predecessorSha256 === PDP2_R1_INTERFACE_REVIEW_PREDECESSOR
    && authorizedTransition?.observedSha256 === PDP2_R1_INTERFACE_REVIEW_OBSERVED
    && record?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.independentReview === 'NOT_CLAIMED'
    && record?.lifecycleClosure === 'NOT_ENTERED'
    && record?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.delivery === 'NOT_AUTHORIZED'
    && record?.release === 'NOT_AUTHORIZED';
  return {
    valid,
    recordRef: recordPath,
    recordId: record?.recordId ?? null,
    digest,
    predecessorSha256: row?.predecessorSha256 ?? null,
    observedSha256: row?.observedSha256 ?? null,
    matchingDeltaCount: matchingDeltas.length,
    matchingAuthorizationCount: matchingAuthorizations.length,
    ownerAcceptance: record?.ownerAcceptance ?? null,
    independentReview: record?.independentReview ?? null,
    lifecycleClosure: record?.lifecycleClosure ?? null,
    runtimeAdmission: record?.runtimeAdmission ?? null,
    delivery: record?.delivery ?? null,
    release: record?.release ?? null,
  };
}

export function validatePdp1InterfaceReviewPinRefreshImpact(record = readJson(PDP1_INTERFACE_REVIEW_PIN_REFRESH_PATH), {
  recordPath = PDP1_INTERFACE_REVIEW_PIN_REFRESH_PATH,
  pdp2R1SourceImpact = readJson(PDP2_R1_SOURCE_IMPACT_PATH),
} = {}) {
  const pdp2R5 = readJson(PDP2_R5_SOURCE_IMPACT_PATH);
  const pdp2R5Digest = sha256(fs.readFileSync(path.join(root, PDP2_R5_SOURCE_IMPACT_PATH)));
  const pdp2R5Row = pdp2R5?.sourceDeltas?.find((row) => row.path === PDP1_INTERFACE_REVIEW_PATH
    && row.predecessorSha256 === PDP2_R5_INTERFACE_REVIEW_PREDECESSOR
    && row.observedSha256 === PDP2_R5_INTERFACE_REVIEW_OBSERVED);
  const pdp2R5Authorization = pdp2R5?.authority?.authorizationEvidence?.some((evidence) =>
    evidence.authorizedTransitions?.some((row) => row.path === PDP1_INTERFACE_REVIEW_PATH
      && row.predecessorSha256 === PDP2_R5_INTERFACE_REVIEW_PREDECESSOR
      && row.observedSha256 === PDP2_R5_INTERFACE_REVIEW_OBSERVED));
  const pdp2R1Successor = validatePdp2R1InterfaceReviewSuccessorImpact(pdp2R1SourceImpact);
  const onDisk = readJson(PDP1_INTERFACE_REVIEW_PIN_REFRESH_PATH);
  const currentInterfaceDigest = sha256(fs.readFileSync(path.join(root, PDP1_INTERFACE_REVIEW_PATH)));
  const currentOperationsDigest = sha256(fs.readFileSync(path.join(root, PDP1_OPERATIONS_PATH)));
  const currentOperationsReviewDigest = sha256(fs.readFileSync(path.join(root, PDP1_OPERATIONS_REVIEW_PATH)));
  const currentSemanticReviewDigest = sha256(fs.readFileSync(path.join(root, 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json')));
  const transition = record?.sourceTransition;
  const valid = recordPath === PDP1_INTERFACE_REVIEW_PIN_REFRESH_PATH
    && pdp2R5?.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R5'
    && pdp2R5Digest === PDP2_R5_SOURCE_IMPACT_DIGEST
    && pdp2R5Row?.classification === 'PDP2_INTERFACE_CURRENT_SOURCE_REVIEW_REFRESH'
    && pdp2R5Row?.meaningChange === 'NO_ADDITIONAL_PDP2_MEANING'
    && JSON.stringify(pdp2R5Row?.meaningIdsChanged) === JSON.stringify([])
    && pdp2R5Row?.requiresFreshCurrentness === true
    && pdp2R5Authorization === true
    && PDP1_INTERFACE_REVIEW_PIN_REFRESH_PREDECESSOR === pdp2R5Row?.observedSha256
    && pdp2R1Successor.valid
    && pdp2R1Successor.predecessorSha256 === pdp2R5Row?.observedSha256
    && pdp2R1Successor.observedSha256 === PDP1_INTERFACE_REVIEW_PIN_REFRESH_OBSERVED
    && canonicalizeVerificationValue(record) === canonicalizeVerificationValue(onDisk)
    && sha256(fs.readFileSync(path.join(root, PDP1_INTERFACE_REVIEW_PIN_REFRESH_PATH))) === PDP1_INTERFACE_REVIEW_PIN_REFRESH_DIGEST
    && record?.schemaVersion === 'media.pdp1-source-impact.v1'
    && record?.recordId === 'MEDIA-PDP1-INTERFACE-REVIEW-SOURCE-PIN-REFRESH-2026-10-14-R1'
    && record?.phase === 'PDP-1'
    && record?.classification === 'INTERNAL_SOURCE_PIN_REVIEW_REFRESH_NO_ADDITIONAL_PDP1_MEANING'
    && transition?.path === PDP1_INTERFACE_REVIEW_PATH
    && transition?.predecessorSha256 === PDP1_INTERFACE_REVIEW_PIN_REFRESH_PREDECESSOR
    && transition?.observedSha256 === PDP1_INTERFACE_REVIEW_PIN_REFRESH_OBSERVED
    && currentInterfaceDigest === PDP1_INTERFACE_REVIEW_PIN_REFRESH_OBSERVED
    && record?.currentPins?.[PDP1_OPERATIONS_PATH] === currentOperationsDigest
    && record?.currentPins?.[PDP1_OPERATIONS_REVIEW_PATH] === currentOperationsReviewDigest
    && record?.currentPins?.[PDP1_INTERFACE_REVIEW_PATH] === currentInterfaceDigest
    && record?.currentPins?.['docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json'] === currentSemanticReviewDigest
    && currentSemanticReviewDigest === PDP1_SEMANTIC_REVIEW_REFRESH_DIGEST
    && typeof record?.disposition === 'string'
    && record.disposition.includes('adds no PDP-1 product meaning')
    && record?.scopeLimits?.externalOwnerAcceptance === 'NOT_CLAIMED'
    && record?.scopeLimits?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && record?.scopeLimits?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.scopeLimits?.transportAdmission === 'NOT_ADMITTED'
    && record?.scopeLimits?.lifecycleClosure === 'NOT_ENTERED'
    && record?.scopeLimits?.delivery === 'NOT_CLAIMED'
    && record?.scopeLimits?.release === 'NOT_CLAIMED'
    && record?.scopeLimits?.tests === 'NOT_CLAIMED'
    && record?.scopeLimits?.phaseCapture === 'NOT_CLAIMED';
  return { valid, recordRef: recordPath, recordId: record?.recordId ?? null,
    digest: sha256(fs.readFileSync(path.join(root, PDP1_INTERFACE_REVIEW_PIN_REFRESH_PATH))),
    predecessorSha256: transition?.predecessorSha256 ?? null,
    observedSha256: transition?.observedSha256 ?? null, liveSha256: currentInterfaceDigest,
    semanticReviewSha256: currentSemanticReviewDigest,
    predecessorAuthorization: { recordRef: PDP2_R5_SOURCE_IMPACT_PATH, recordId: pdp2R5?.recordId ?? null,
      digest: pdp2R5Digest, predecessorSha256: pdp2R5Row?.predecessorSha256 ?? null,
      observedSha256: pdp2R5Row?.observedSha256 ?? null, authorized: pdp2R5Authorization === true },
    successorAuthorization: pdp2R1Successor };
}

export function validatePdp1TypedObservationTestRefreshImpact(record = readJson(PDP1_TYPED_OBSERVATION_TEST_IMPACT_PATH), {
  recordPath = PDP1_TYPED_OBSERVATION_TEST_IMPACT_PATH,
  testInputDigests = {},
} = {}) {
  const onDisk = readJson(PDP1_TYPED_OBSERVATION_TEST_IMPACT_PATH);
  const predecessorPath = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r22.json';
  const predecessor = readJson(predecessorPath);
  const predecessorDigest = sha256(fs.readFileSync(path.join(root, predecessorPath)));
  const transition = record?.sourceTransition;
  const liveTestDigest = sha256(fs.readFileSync(path.join(root, PDP1_TYPED_OBSERVATION_TEST_PATH)));
  const suppliedDigest = testInputDigests[PDP1_TYPED_OBSERVATION_TEST_PATH]?.digest
    ?? testInputDigests[PDP1_TYPED_OBSERVATION_TEST_PATH];
  const valid = recordPath === PDP1_TYPED_OBSERVATION_TEST_IMPACT_PATH
    && canonicalizeVerificationValue(record) === canonicalizeVerificationValue(onDisk)
    && sha256(fs.readFileSync(path.join(root, PDP1_TYPED_OBSERVATION_TEST_IMPACT_PATH))) === PDP1_TYPED_OBSERVATION_TEST_IMPACT_DIGEST
    && predecessorDigest === PDP1_R22_EXIT_DIGEST
    && predecessor?.testRun?.sourceBinding?.testInputContentDigests?.[PDP1_TYPED_OBSERVATION_TEST_PATH] === PDP1_TYPED_OBSERVATION_TEST_PREDECESSOR_DIGEST
    && record?.schemaVersion === 'media.pdp1-test-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-TYPED-OBSERVATION-TEST-REFRESH-2026-10-14-R1'
    && record?.phase === 'PDP-1'
    && record?.predecessor?.ref === predecessorPath
    && record?.predecessor?.sha256 === PDP1_R22_EXIT_DIGEST
    && record?.predecessor?.testPath === PDP1_TYPED_OBSERVATION_TEST_PATH
    && record?.predecessor?.testSha256 === PDP1_TYPED_OBSERVATION_TEST_PREDECESSOR_DIGEST
    && transition?.path === PDP1_TYPED_OBSERVATION_TEST_PATH
    && transition?.predecessorSha256 === PDP1_TYPED_OBSERVATION_TEST_PREDECESSOR_DIGEST
    && transition?.observedSha256 === PDP1_TYPED_OBSERVATION_TEST_OBSERVED_DIGEST
    && transition?.classification === 'PDP1_REGRESSION_TEST_EXPECTATION_ALIGNMENT'
    && transition?.meaningChange === 'NO_PDP1_MEANING_CHANGE'
    && JSON.stringify(transition?.meaningIdsChanged) === JSON.stringify([])
    && transition?.requiresFreshCurrentness === true
    && suppliedDigest === PDP1_TYPED_OBSERVATION_TEST_OBSERVED_DIGEST
    && liveTestDigest === PDP1_TYPED_OBSERVATION_TEST_OBSERVED_DIGEST
    && record?.reviewedPinSeparation?.priorSupplementalDefinitionReviewOperationsSha256 === '62d0a4050a43da1c58a63d12adaa7c27055c63afc51580bd1e2478d1da3dace8'
    && record?.reviewedPinSeparation?.pdp164PredecessorOperationsSha256 === 'sha256:62d0a4050a43da1c58a63d12adaa7c27055c63afc51580bd1e2478d1da3dace8'
    && record?.reviewedPinSeparation?.currentOperationsSha256 === sha256(fs.readFileSync(path.join(root, PDP1_OPERATIONS_PATH)))
    && record?.reviewedPinSeparation?.pdp164MeaningOwnerId === 'media.operation.action.request-admitted-speech-operation'
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && record?.decision?.meaningDisposition === 'NO_PDP1_PRODUCT_MEANING_CHANGE'
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentAcceptance === 'NOT_CLAIMED'
    && record?.decision?.nativeClosure === 'NOT_ENTERED'
    && record?.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.decision?.delivery === 'NOT_CLAIMED'
    && record?.decision?.release === 'NOT_CLAIMED';
  return { valid, recordRef: recordPath, recordId: record?.recordId ?? null,
    digest: sha256(fs.readFileSync(path.join(root, PDP1_TYPED_OBSERVATION_TEST_IMPACT_PATH))),
    predecessorRef: predecessorPath, predecessorExitDigest: predecessorDigest,
    predecessorTestSha256: record?.predecessor?.testSha256 ?? null,
    observedTestSha256: transition?.observedSha256 ?? null, liveTestSha256: liveTestDigest };
}

export function validatePdp1DevStatusTestRefreshImpact(record = readJson(PDP1_DEV_STATUS_TEST_REFRESH_PATH), {
  testInputDigests = {}, recordPath = PDP1_DEV_STATUS_TEST_REFRESH_PATH,
} = {}) {
  const predecessorPath = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r22.json';
  const predecessor = readJson(predecessorPath);
  const predecessorDigest = sha256(fs.readFileSync(path.join(root, predecessorPath)));
  const onDisk = readJson(PDP1_DEV_STATUS_TEST_REFRESH_PATH);
  const testPath = 'tests/media-pdp-p1-dev-status.test.mjs';
  const liveDigest = sha256(fs.readFileSync(path.join(root, testPath)));
  const suppliedDigest = testInputDigests?.[testPath]?.digest ?? testInputDigests?.[testPath];
  const delta = record?.sourceTransition;
  const valid = recordPath === PDP1_DEV_STATUS_TEST_REFRESH_PATH
    && canonicalizeVerificationValue(record) === canonicalizeVerificationValue(onDisk)
    && sha256(fs.readFileSync(path.join(root, PDP1_DEV_STATUS_TEST_REFRESH_PATH))) === PDP1_DEV_STATUS_TEST_REFRESH_DIGEST
    && predecessorDigest === PDP1_R22_EXIT_DIGEST
    && predecessor?.testRun?.sourceBinding?.testInputContentDigests?.[testPath] === PDP1_DEV_STATUS_TEST_R22_PREDECESSOR_DIGEST
    && record?.schemaVersion === 'media.pdp1-test-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-DEV-STATUS-TEST-REFRESH-2026-10-14-R1'
    && record?.predecessor?.ref === predecessorPath
    && record?.predecessor?.sha256 === PDP1_R22_EXIT_DIGEST
    && record?.predecessor?.testPath === testPath
    && record?.predecessor?.testSha256 === PDP1_DEV_STATUS_TEST_R22_PREDECESSOR_DIGEST
    && delta?.path === testPath
    && delta?.predecessorSha256 === PDP1_DEV_STATUS_TEST_R22_PREDECESSOR_DIGEST
    && delta?.observedSha256 === PDP1_DEV_STATUS_TEST_OBSERVED_DIGEST
    && suppliedDigest === PDP1_DEV_STATUS_TEST_OBSERVED_DIGEST
    && liveDigest === PDP1_DEV_STATUS_TEST_OBSERVED_DIGEST
    && delta?.classification === 'PDP1_REGRESSION_TEST_EXPECTATION_ALIGNMENT'
    && delta?.meaningChange === 'NO_PDP1_MEANING_CHANGE'
    && JSON.stringify(delta?.meaningIdsChanged) === JSON.stringify([])
    && delta?.requiresFreshCurrentness === true
    && record?.reviewedPinSeparation?.priorSupplementalDefinitionReviewOperationsSha256 === '62d0a4050a43da1c58a63d12adaa7c27055c63afc51580bd1e2478d1da3dace8'
    && record?.reviewedPinSeparation?.pdp164PredecessorOperationsSha256 === 'sha256:62d0a4050a43da1c58a63d12adaa7c27055c63afc51580bd1e2478d1da3dace8'
    && record?.reviewedPinSeparation?.currentOperationsSha256 === sha256(fs.readFileSync(path.join(root, PDP1_OPERATIONS_PATH)))
    && record?.reviewedPinSeparation?.pdp164MeaningOwnerId === 'media.operation.action.request-admitted-speech-operation'
    && record?.decision?.meaningDisposition === 'NO_PDP1_PRODUCT_MEANING_CHANGE'
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentAcceptance === 'NOT_CLAIMED'
    && record?.decision?.nativeClosure === 'NOT_ENTERED'
    && record?.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.decision?.delivery === 'NOT_CLAIMED'
    && record?.decision?.release === 'NOT_CLAIMED';
  return { valid, recordRef: recordPath, recordId: record?.recordId ?? null, digest: PDP1_DEV_STATUS_TEST_REFRESH_DIGEST,
    predecessorRef: predecessorPath, predecessorExitDigest: predecessorDigest,
    predecessorTestSha256: record?.predecessor?.testSha256 ?? null,
    observedSha256: suppliedDigest ?? null, liveSha256: liveDigest };
}

export function validatePdp1ThreeReviewSourceTransition(record, {
  observedDigests = {}, statusPins = {}, semanticPins = {}, recordPath = PDP1_THREE_REVIEW_TRANSITIONS_PATH,
  operationParityProjectionImpact = null,
} = {}) {
  if (recordPath !== PDP1_THREE_REVIEW_TRANSITIONS_PATH) {
    return { valid: false, recordRef: recordPath, recordId: record?.recordId ?? null, digest: null, rowChecks: [] };
  }
  const diskRecord = readJson(recordPath);
  const suppliedRecordMatchesDisk = canonicalizeVerificationValue(record) === canonicalizeVerificationValue(diskRecord);
  const digest = sha256(fs.readFileSync(path.join(root, recordPath)));
  const predecessor = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const predecessorDigests = predecessor.sourceCurrentness?.sourceContentDigests ?? {};
  const projectionRecord = readJson(PDP1_OPERATION_PARITY_SUCCESSOR_IMPACT_PATH);
  const projectionImpact = operationParityProjectionImpact
    ?? validatePdp1OperationParityProjectionImpact(undefined, { observedDigests });
  const pxd164Impact = validatePdp1Pxd164SemanticRepairImpact(readJson(PDP1_PXD164_IMPACT_PATH), { observedDigests });
  const interfacePinRefreshImpact = validatePdp1InterfaceReviewPinRefreshImpact();
  const pinDigest = (pins, sourcePath) => `sha256:${String(pins?.[sourcePath] ?? '').replace(/^sha256:/u, '')}`;
  const sourceTransitions = record?.sourceTransitions ?? [];
  const rowChecks = PDP1_THREE_REVIEW_TRANSITIONS.map((expected, index) => {
    const row = sourceTransitions[index];
    const observed = observedDigests?.[expected.path]?.digest ?? observedDigests?.[expected.path];
    const live = sha256(fs.readFileSync(path.join(root, expected.path)));
    const statusPin = pinDigest(statusPins, expected.path);
    const semanticPin = pinDigest(semanticPins, expected.path);
    const successorRow = projectionImpact.valid
      ? projectionImpact.rowChecks.find((candidate) => candidate.path === expected.path
        && candidate.predecessorSha256 === expected.observedSha256)
      : null;
    const recordedProjectionRow = projectionRecord.sourceDeltas?.find((candidate) => candidate.path === expected.path
      && candidate.predecessorSha256 === expected.observedSha256);
    const pxd164Successor = pxd164Impact.valid
      ? pxd164Impact.sourceDeltas.find((candidate) => candidate.path === expected.path
        && candidate.predecessorSha256 === recordedProjectionRow?.observedSha256)
      : null;
    const interfacePinSuccessor = expected.path === PDP1_INTERFACE_REVIEW_PATH
      && projectionImpact.valid && interfacePinRefreshImpact.valid
      && interfacePinRefreshImpact.predecessorSha256 === successorRow?.observedSha256
      ? interfacePinRefreshImpact.observedSha256 : null;
    const terminalDigest = interfacePinSuccessor ?? pxd164Successor?.observedSha256 ?? successorRow?.observedSha256 ?? null;
    const allowedPins = [expected.predecessorSha256, expected.observedSha256,
      ...(recordedProjectionRow?.observedSha256 ? [recordedProjectionRow.observedSha256] : []),
      ...(successorRow?.observedSha256 ? [successorRow.observedSha256] : []),
      ...(interfacePinSuccessor ? [interfacePinRefreshImpact.predecessorSha256, interfacePinSuccessor] : []),
      ...(pxd164Successor ? [pxd164Successor.predecessorSha256, pxd164Successor.observedSha256] : []),
      ...(terminalDigest ? [terminalDigest] : [])];
    return {
      path: expected.path,
      valid: row?.path === expected.path
        && row?.predecessorSha256 === expected.predecessorSha256
        && row?.observedSha256 === expected.observedSha256
        && predecessorDigests[expected.path] === expected.predecessorSha256
        && (observed === expected.observedSha256 || terminalDigest !== null && observed === terminalDigest)
        && live === observed
        && allowedPins.includes(statusPin)
        && allowedPins.includes(semanticPin),
      predecessorSha256: expected.predecessorSha256,
      observedSha256: row?.observedSha256 ?? observed ?? null,
      liveSha256: live,
      statusPinSha256: statusPin,
      semanticPinSha256: semanticPin,
    };
  });
  const authorization = record?.authority?.authorizationEvidence;
  const valid = suppliedRecordMatchesDisk
    && digest === PDP1_THREE_REVIEW_TRANSITIONS_DIGEST
    && record?.schemaVersion === 'media.discovery-pdp1-three-review-source-transition.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-THREE-REVIEW-SOURCE-TRANSITION-2026-10-14'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY' && record?.campaign?.phase === 'PDP-1'
    && record?.predecessor?.ref === CURRENT_CUT_PDP1_PREDECESSOR_PATH
    && record?.predecessor?.sha256 === CURRENT_CUT_PDP1_PREDECESSOR_DIGEST
    && sha256(fs.readFileSync(path.join(root, CURRENT_CUT_PDP1_PREDECESSOR_PATH))) === CURRENT_CUT_PDP1_PREDECESSOR_DIGEST
    && predecessor?.observationId === 'MEDIA-PDP1-CURRENTNESS-CURRENT-CUT-R16'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_SOURCE_TRANSITION_DISPOSITION'
    && authorization?.providedBy === 'PARENT_TASK_RELAYING_EXPLICIT_USER_AUTHORIZATION'
    && authorization?.exactStatement === 'Authorization is now explicit for the three exact R16→current PDP-1 transitions'
    && JSON.stringify(authorization?.authorizedTransitions) === JSON.stringify(PDP1_THREE_REVIEW_TRANSITIONS)
    && sourceTransitions.length === PDP1_THREE_REVIEW_TRANSITIONS.length
    && interfacePinRefreshImpact.valid
    && rowChecks.every(({ valid: rowValid }) => rowValid)
    && record?.decision?.status === 'INTERNAL_SCOPED_SOURCE_TRANSITION_DISPOSITION'
    && record?.decision?.meaningDisposition === 'NO_MEANING_CHANGE_FOR_THE_THREE_EXACT_SOURCE_TRANSITIONS'
    && record?.decision?.freshPdp1CurrentnessRecapture === 'REQUIRED'
    && record?.decision?.preserveHistoricalReceipts === true
    && record?.boundaries?.externalOwnerAcceptance === 'NOT_CLAIMED'
    && record?.boundaries?.independentAcceptance === 'NOT_CLAIMED'
    && record?.boundaries?.nativeClosure === 'NOT_ENTERED'
    && record?.boundaries?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.boundaries?.release === 'NOT_AUTHORIZED'
    && record?.limitation === 'This disposition covers only the three exact R16-to-current PDP-1 source transitions listed. It preserves prior receipts, requires fresh PDP-1 currentness, and makes no owner acceptance, independent acceptance, native closure, runtime admission, or release claim.';
  return { valid, recordRef: recordPath, recordId: record?.recordId ?? null, digest, predecessorRef: CURRENT_CUT_PDP1_PREDECESSOR_PATH,
    predecessorDigest: sha256(fs.readFileSync(path.join(root, CURRENT_CUT_PDP1_PREDECESSOR_PATH))), rowChecks, suppliedRecordMatchesDisk,
    };
}

export function validatePdp1OwnerStatusJoinTestTransition(record, {
  testInputDigests = {}, recordPath = PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PATH,
} = {}) {
  if (recordPath === PDP1_OWNER_STATUS_JOIN_TEST_R3_PATH) {
    const onDisk = readJson(PDP1_OWNER_STATUS_JOIN_TEST_R3_PATH);
    const r2Path = PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PATH;
    const r2 = readJson(r2Path);
    const r2Digest = sha256(fs.readFileSync(path.join(root, r2Path)));
    const r11ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r11.json';
    const r11CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r11.json';
    const r11ExitDigest = sha256(fs.readFileSync(path.join(root, r11ExitPath)));
    const r11CurrentnessDigest = sha256(fs.readFileSync(path.join(root, r11CurrentnessPath)));
    const r4Path = 'docs/implementation/observations/media-discovery-pdp1-owner-status-join-test-refresh-2026-10-14-r4.json';
    const r4 = readJson(r4Path);
    const r4Digest = sha256(fs.readFileSync(path.join(root, r4Path)));
    const r12ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json';
    const r12CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json';
    const r4SuccessorValid = () => r4Digest === 'sha256:6ae84822c2f245d39c552ac333595fd22842709061acbe9721bc57304c354756'
      && r4?.recordId === 'MEDIA-DISCOVERY-PDP1-OWNER-STATUS-JOIN-TEST-REFRESH-2026-10-14-R4'
      && r4?.predecessor?.ref === PDP1_OWNER_STATUS_JOIN_TEST_R3_PATH
      && r4?.predecessor?.sha256 === PDP1_OWNER_STATUS_JOIN_TEST_R3_DIGEST
      && r4?.predecessor?.testPath === PDP1_OWNER_STATUS_JOIN_TEST_PATH
      && r4?.predecessor?.testSha256 === record?.sourceTransition?.observedSha256
      && r4?.predecessor?.pdp0ExitRef === r12ExitPath
      && r4?.predecessor?.pdp0ExitSha256 === 'sha256:91aeae0aad488bc8eb29d40bf955e527ef072ada762948064bc8e50422c5a5c5'
      && sha256(fs.readFileSync(path.join(root, r12ExitPath))) === r4?.predecessor?.pdp0ExitSha256
      && r4?.predecessor?.pdp0CurrentnessRef === r12CurrentnessPath
      && r4?.predecessor?.pdp0CurrentnessSha256 === 'sha256:14882e245fa1676138cfc5bd51ef0403cb96cf2f77542caa2c57dc683ca8b159'
      && sha256(fs.readFileSync(path.join(root, r12CurrentnessPath))) === r4?.predecessor?.pdp0CurrentnessSha256
      && r4?.sourceTransition?.path === PDP1_OWNER_STATUS_JOIN_TEST_PATH
      && r4?.sourceTransition?.predecessorSha256 === record?.sourceTransition?.observedSha256
      && r4?.sourceTransition?.observedSha256 === suppliedDigest
      && r4?.sourceTransition?.classification === 'PDP1_REGRESSION_TEST_IMMEDIATE_PREDECESSOR_REFRESH'
      && r4?.sourceTransition?.productMeaningChange === 'NONE'
      && r4?.sourceTransition?.requiresFreshCurrentnessCapture === true
      && liveDigest === r4?.sourceTransition?.observedSha256
      && r4?.decision?.meaningDisposition === 'NO_PDP1_PRODUCT_MEANING_CHANGE'
      && r4?.decision?.freshPdp1CurrentnessRecapture === 'REQUIRED'
      && r4?.boundaries?.ownerAcceptance === 'NOT_CLAIMED'
      && r4?.boundaries?.independentAcceptance === 'NOT_CLAIMED'
      && r4?.boundaries?.nativeClosure === 'NOT_ENTERED'
      && r4?.boundaries?.runtimeAdmission === 'NOT_ADMITTED'
      && r4?.boundaries?.release === 'NOT_AUTHORIZED';
    const liveDigest = sha256(fs.readFileSync(path.join(root, PDP1_OWNER_STATUS_JOIN_TEST_PATH)));
    const suppliedDigest = testInputDigests?.[PDP1_OWNER_STATUS_JOIN_TEST_PATH]?.digest
      ?? testInputDigests?.[PDP1_OWNER_STATUS_JOIN_TEST_PATH];
    const transition = record?.sourceTransition;
    const valid = canonicalizeVerificationValue(record) === canonicalizeVerificationValue(onDisk)
      && sha256(fs.readFileSync(path.join(root, PDP1_OWNER_STATUS_JOIN_TEST_R3_PATH))) === PDP1_OWNER_STATUS_JOIN_TEST_R3_DIGEST
      && r2Digest === PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_DIGEST
      && r2?.recordId === 'MEDIA-DISCOVERY-PDP1-OWNER-STATUS-JOIN-TEST-REFRESH-2026-10-14-R2'
      && r2?.sourceTransition?.observedSha256 === record?.predecessor?.testSha256
      && record?.schemaVersion === 'media.discovery-pdp1-test-source-transition.v1'
      && record?.recordId === 'MEDIA-DISCOVERY-PDP1-OWNER-STATUS-JOIN-TEST-REFRESH-2026-10-14-R3'
      && record?.predecessor?.ref === r2Path
      && record?.predecessor?.sha256 === r2Digest
      && record?.predecessor?.testPath === PDP1_OWNER_STATUS_JOIN_TEST_PATH
      && record?.predecessor?.pdp0ExitRef === r11ExitPath
      && record?.predecessor?.pdp0ExitSha256 === 'sha256:fe8e73184cf385328a4974a9a3b2aad84ff9033fb999c80c10f49c3db066c4ea'
      && r11ExitDigest === record?.predecessor?.pdp0ExitSha256
      && record?.predecessor?.pdp0CurrentnessRef === r11CurrentnessPath
      && record?.predecessor?.pdp0CurrentnessSha256 === 'sha256:b6986cd2e93241c9962d1215977c99f899949f87da15a72d8087e6ad130d7026'
      && r11CurrentnessDigest === record?.predecessor?.pdp0CurrentnessSha256
      && record?.predecessor?.materialSourceSetFingerprint === 'sha256:d9fc2839dc341cb05250e31093a2250678a9004febffaf290d4852e29f7282f1'
      && record?.authority?.decisionRole === 'INTERNAL_TEST_CURRENTNESS_DISPOSITION'
      && record?.sourceTransition?.path === PDP1_OWNER_STATUS_JOIN_TEST_PATH
      && record?.sourceTransition?.predecessorSha256 === 'sha256:ec1169c9c7a5c147dac13a24460d5f73dc9517861752bb0b5b1fe72f9f068d88'
      && record?.sourceTransition?.observedSha256 === 'sha256:7373bb3f4e165274086a92b6d496ee845503ce7e261a4d40967efd1db75e737d'
      && r4SuccessorValid()
      && transition?.classification === 'PDP1_REGRESSION_TEST_IMMEDIATE_PREDECESSOR_REFRESH'
      && transition?.productMeaningChange === 'NONE'
      && transition?.requiresFreshCurrentnessCapture === true
      && record?.decision?.meaningDisposition === 'NO_PDP1_PRODUCT_MEANING_CHANGE'
      && record?.decision?.freshPdp1CurrentnessRecapture === 'REQUIRED'
      && record?.decision?.preserveHistoricalReceipts === true
      && record?.boundaries?.ownerAcceptance === 'NOT_CLAIMED'
      && record?.boundaries?.independentAcceptance === 'NOT_CLAIMED'
      && record?.boundaries?.nativeClosure === 'NOT_ENTERED'
      && record?.boundaries?.runtimeAdmission === 'NOT_ADMITTED'
      && record?.boundaries?.release === 'NOT_AUTHORIZED';
    return { valid, recordRef: PDP1_OWNER_STATUS_JOIN_TEST_R3_PATH, recordId: record?.recordId ?? null,
      digest: sha256(fs.readFileSync(path.join(root, PDP1_OWNER_STATUS_JOIN_TEST_R3_PATH))), predecessorRef: r2Path,
      predecessorDigest: r2Digest, sourcePath: PDP1_OWNER_STATUS_JOIN_TEST_PATH,
      predecessorSha256: record?.sourceTransition?.predecessorSha256 ?? null,
      observedSha256: suppliedDigest ?? null, liveSha256: liveDigest, exactR4Successor: r4SuccessorValid() };
  }
  if (recordPath !== PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PATH) {
    return { valid: false, recordRef: recordPath, recordId: record?.recordId ?? null, digest: null };
  }
  const diskRecord = readJson(recordPath);
  const suppliedRecordMatchesDisk = canonicalizeVerificationValue(record) === canonicalizeVerificationValue(diskRecord);
  const digest = sha256(fs.readFileSync(path.join(root, recordPath)));
  const predecessorRecord = readJson(PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PREDECESSOR_PATH);
  const predecessorDigest = sha256(fs.readFileSync(path.join(root, PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PREDECESSOR_PATH)));
  const successorComparable = structuredClone(record ?? {});
  delete successorComparable.recordId;
  delete successorComparable.observedAt;
  delete successorComparable.supersedes;
  delete successorComparable.correction;
  const predecessorComparable = structuredClone(predecessorRecord);
  delete predecessorComparable.recordId;
  delete predecessorComparable.observedAt;
  const timestamp = Date.parse(record?.observedAt ?? '');
  const timestampIsCanonicalUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(record?.observedAt ?? '')
    && Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().replace(/\.000Z$/u, 'Z') === record.observedAt;
  const predecessor = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const sourceDigest = testInputDigests?.[PDP1_OWNER_STATUS_JOIN_TEST_PATH]?.digest
    ?? testInputDigests?.[PDP1_OWNER_STATUS_JOIN_TEST_PATH];
  const liveDigest = sha256(fs.readFileSync(path.join(root, PDP1_OWNER_STATUS_JOIN_TEST_PATH)));
  const transition = record?.sourceTransition;
  const valid = suppliedRecordMatchesDisk
    && digest === PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_DIGEST
    && predecessorDigest === PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PREDECESSOR_DIGEST
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-OWNER-STATUS-JOIN-TEST-REFRESH-2026-10-14-R2'
    && record?.supersedes?.ref === PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PREDECESSOR_PATH
    && record?.supersedes?.sha256 === PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PREDECESSOR_DIGEST
    && record?.supersedes?.recordId === predecessorRecord?.recordId
    && record?.supersedes?.reason === 'Correct only the observedAt timestamp for current evidence; retain the exact authorized test transition and no-product-meaning scope.'
    && record?.correction?.scope === 'TIMESTAMP_ONLY_SUCCESSOR_DISPOSITION'
    && record?.correction?.previousObservedAt === predecessorRecord?.observedAt
    && record?.correction?.currentObservedAtSource === 'clock__curr_time at 2026-10-14 19:53:08 UTC'
    && record?.correction?.sourceTransitionUnchanged === true
    && canonicalizeVerificationValue(successorComparable) === canonicalizeVerificationValue(predecessorComparable)
    && timestampIsCanonicalUtc
    && timestamp <= Date.now()
    && sha256(fs.readFileSync(path.join(root, CURRENT_CUT_PDP1_PREDECESSOR_PATH))) === CURRENT_CUT_PDP1_PREDECESSOR_DIGEST
    && predecessor?.observationId === 'MEDIA-PDP1-CURRENTNESS-CURRENT-CUT-R16'
    && predecessor?.campaign?.observedHead === record?.predecessor?.observedHead
    && record?.predecessor?.ref === CURRENT_CUT_PDP1_PREDECESSOR_PATH
    && record?.predecessor?.sha256 === CURRENT_CUT_PDP1_PREDECESSOR_DIGEST
    && record?.predecessor?.testSourceBaseline === `HEAD:${PDP1_OWNER_STATUS_JOIN_TEST_PATH}`
    && record?.predecessor?.testSourcePredecessorSha256 === PDP1_OWNER_STATUS_JOIN_TEST_PREDECESSOR_DIGEST
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_AUTHORIZATION'
    && record?.authority?.decisionRole === 'INTERNAL_TEST_CURRENTNESS_DISPOSITION'
    && transition?.path === PDP1_OWNER_STATUS_JOIN_TEST_PATH
    && transition?.predecessorSha256 === PDP1_OWNER_STATUS_JOIN_TEST_PREDECESSOR_DIGEST
    && transition?.observedSha256 === PDP1_OWNER_STATUS_JOIN_TEST_OBSERVED_DIGEST
    && sourceDigest === PDP1_OWNER_STATUS_JOIN_TEST_OBSERVED_DIGEST
    && liveDigest === PDP1_OWNER_STATUS_JOIN_TEST_OBSERVED_DIGEST
    && transition?.classification === 'PDP1_REGRESSION_TEST_FIXTURE_REFRESH'
    && transition?.productMeaningChange === 'NONE'
    && transition?.requiresFreshCurrentnessCapture === true
    && record?.decision?.status === 'INTERNAL_TEST_CURRENTNESS_DISPOSITION'
    && record?.decision?.meaningDisposition === 'NO_PDP1_PRODUCT_MEANING_CHANGE'
    && record?.decision?.freshPdp1CurrentnessRecapture === 'REQUIRED'
    && record?.decision?.preserveHistoricalReceipts === true
    && record?.boundaries?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.boundaries?.independentAcceptance === 'NOT_CLAIMED'
    && record?.boundaries?.nativeClosure === 'NOT_ENTERED'
    && record?.boundaries?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.boundaries?.release === 'NOT_AUTHORIZED'
    && record?.limitation === 'This internal disposition covers only the exact regression-test source transition shown. It changes no PDP-1 product meaning, requires fresh PDP-1 currentness capture, and makes no owner acceptance, independent acceptance, native closure, runtime admission, or release claim.';
  return { valid, recordRef: recordPath, recordId: record?.recordId ?? null, digest,
    predecessorRef: PDP1_OWNER_STATUS_JOIN_TEST_TRANSITION_PREDECESSOR_PATH, predecessorDigest,
    observedAt: record?.observedAt ?? null, timestampNotFuture: timestampIsCanonicalUtc && timestamp <= Date.now(),
    sourcePath: PDP1_OWNER_STATUS_JOIN_TEST_PATH, predecessorSha256: transition?.predecessorSha256 ?? null,
    observedSha256: sourceDigest ?? null, liveSha256: liveDigest, suppliedRecordMatchesDisk };
}

export function validatePdp1InterfaceReviewSuccessorChain({ observedDigests = {}, historicalDigests = {}, statusPins = {}, semanticPins = {}, threeReviewTransition, c22Impact } = {}) {
  const interfacePath = PDP1_INTERFACE_REVIEW_PATH;
  const r1 = readJson(CURRENT_CUT_SOURCE_IMPACT_PATH);
  const r2 = readJson(CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH);
  const r4 = readJson(PDP1_INTERFACE_REVIEW_IMPACT_PATH);
  const r16 = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const interfaceSource = readJson(interfacePath);
  const r1Delta = r1.sourceDeltas?.find((row) => row.path === interfacePath);
  const r2Delta = r2.sourceDelta;
  const r4Delta = r4.sourceDelta;
  const currentDigest = sha256(fs.readFileSync(path.join(root, interfacePath)));
  const projectionImpact = validatePdp1OperationParityProjectionImpact(undefined, { observedDigests });
  const interfacePinRefreshImpact = validatePdp1InterfaceReviewPinRefreshImpact();
  const pxd164Impact = validatePdp1Pxd164SemanticRepairImpact(readJson(PDP1_PXD164_IMPACT_PATH), { observedDigests });
  const pxd164OperationDigest = pxd164Impact.sourceDeltas.find((row) => row.path === PDP1_OPERATIONS_PATH)?.observedSha256;
  const pxd164OperationReviewDigest = pxd164Impact.sourceDeltas.find((row) => row.path === PDP1_OPERATIONS_REVIEW_PATH)?.observedSha256;
  const observed = observedDigests?.[interfacePath]?.digest ?? observedDigests?.[interfacePath];
  const statusDigest = `sha256:${String(statusPins?.[interfacePath] ?? '').replace(/^sha256:/u, '')}`;
  const semanticDigest = `sha256:${String(semanticPins?.[interfacePath] ?? '').replace(/^sha256:/u, '')}`;
  const operationDigest = sha256(fs.readFileSync(path.join(root, PDP1_OPERATIONS_PATH)));
  const operationReviewDigest = sha256(fs.readFileSync(path.join(root, PDP1_OPERATIONS_REVIEW_PATH)));
  const operationReview = readJson(PDP1_OPERATIONS_REVIEW_PATH);
  const transitionRow = threeReviewTransition?.rowChecks?.find((row) => row.path === interfacePath);
  const reviewPinChecks = {
    operationsReviewCurrentSource: `sha256:${String(operationReview.currentSourceSha256 ?? '').replace(/^sha256:/u, '')}` === operationDigest,
    interfaceSourceOperationPin: `sha256:${String(interfaceSource.sources?.find((row) => row.path === PDP1_OPERATIONS_PATH)?.sha256 ?? '').replace(/^sha256:/u, '')}` === operationDigest,
    interfaceReviewOperationPin: `sha256:${String(interfaceSource.currentSourceCutDeltaReview?.operationsSha256 ?? '').replace(/^sha256:/u, '')}` === operationDigest,
    operationReviewDigest: operationReviewDigest === PDP1_C22_REVIEW_INPUT_DIGESTS[PDP1_OPERATIONS_REVIEW_PATH]
      || projectionImpact.valid && operationReviewDigest === projectionImpact.rowChecks.find((row) => row.path === PDP1_OPERATIONS_REVIEW_PATH)?.observedSha256
      || pxd164Impact.valid && operationReviewDigest === pxd164OperationReviewDigest,
    interfaceReviewDigest: sha256(fs.readFileSync(path.join(root, PDP1_INTERFACE_REVIEW_PATH))) === PDP1_C22_REVIEW_INPUT_DIGESTS[PDP1_INTERFACE_REVIEW_PATH]
      || projectionImpact.valid && sha256(fs.readFileSync(path.join(root, PDP1_INTERFACE_REVIEW_PATH))) === projectionImpact.rowChecks.find((row) => row.path === PDP1_INTERFACE_REVIEW_PATH)?.observedSha256
      || interfacePinRefreshImpact.valid && currentDigest === interfacePinRefreshImpact.observedSha256,
  };
  const historyChecks = {
    r1Digest: sha256(fs.readFileSync(path.join(root, CURRENT_CUT_SOURCE_IMPACT_PATH))) === 'sha256:1530e22dfb8c60296123ec95d494c53fc2f5ff81be7c8fc47bf0252661d2655b',
    r2Digest: sha256(fs.readFileSync(path.join(root, CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH))) === PDP1_ADDITIONAL_SOURCE_IMPACT_DIGEST,
    r4Digest: sha256(fs.readFileSync(path.join(root, PDP1_INTERFACE_REVIEW_IMPACT_PATH))) === PDP1_INTERFACE_REVIEW_IMPACT_DIGEST,
    r1Edges: r1Delta?.predecessorSha256 === CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS[interfacePath]
      && r1Delta?.observedSha256 === CURRENT_CUT_SOURCE_OBSERVED_DIGESTS[interfacePath]
      && r1Delta?.historicalPdp1MaterialSha256 === r1Delta?.predecessorSha256,
    r2Edges: r2?.parentImpact?.recordId === r1?.recordId && r2?.parentImpact?.sha256 === sha256(fs.readFileSync(path.join(root, CURRENT_CUT_SOURCE_IMPACT_PATH)))
      && r2Delta?.predecessorSha256 === r1Delta?.observedSha256 && r2Delta?.observedSha256 === PDP1_INTERFACE_REVIEW_PREDECESSOR_DIGEST,
    r4Edges: r4?.parentImpact?.recordId === r2?.recordId && r4?.parentImpact?.sha256 === sha256(fs.readFileSync(path.join(root, CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH)))
      && r4Delta?.predecessorSha256 === PDP1_INTERFACE_REVIEW_PREDECESSOR_DIGEST && r4Delta?.observedSha256 === PDP1_INTERFACE_REVIEW_OBSERVED_DIGEST,
    r16Cut: r16.sourceCurrentness?.sourceContentDigests?.[interfacePath] === PDP1_INTERFACE_REVIEW_OBSERVED_DIGEST,
  };
  const recordChecks = {
    r2Meaning: r2Delta?.classification === 'PDP1_REVIEW_ARTIFACT_REFRESH_FOR_SEPARATELY_REVIEWED_OPERATION_DELTA'
      && r2Delta?.meaningChange === 'NO_ADDITIONAL_MEANING' && Array.isArray(r2Delta?.meaningIdsChanged) && r2Delta.meaningIdsChanged.length === 0,
    r4SelectorMeaning: r4Delta?.selector === 'sources[.product-experience/pdp-1-domain-data/operations.yaml].sha256'
      && r4Delta?.meaningChange === 'NO_ADDITIONAL_P1_MEANING' && Array.isArray(r4Delta?.meaningIdsChanged) && r4Delta.meaningIdsChanged.length === 0,
    r4Authority: r4.authority?.userAuthorization === 'NO_ADDITIONAL_P1_MEANING_FOR_EXACT_INTERFACE-REVIEW-PATH'
      && r4.decision?.ownerAcceptance === 'NOT_CLAIMED' && r4.decision?.independentAcceptance === 'NOT_CLAIMED',
    sourceStatus: observed === currentDigest
      && (statusDigest === currentDigest || projectionImpact.valid
        && statusDigest === projectionImpact.rowChecks.find((row) => row.path === interfacePath)?.predecessorSha256
        || interfacePinRefreshImpact.valid && statusDigest === interfacePinRefreshImpact.predecessorSha256)
      && semanticDigest === currentDigest,
    transitionEdge: transitionRow?.valid === true && transitionRow?.predecessorSha256 === PDP1_INTERFACE_REVIEW_OBSERVED_DIGEST
      && transitionRow?.observedSha256 === PDP1_THREE_REVIEW_TRANSITIONS[0].observedSha256,
  };
  const valid = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_SOURCE_IMPACT_PATH))) === 'sha256:1530e22dfb8c60296123ec95d494c53fc2f5ff81be7c8fc47bf0252661d2655b'
    && sha256(fs.readFileSync(path.join(root, CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH))) === PDP1_ADDITIONAL_SOURCE_IMPACT_DIGEST
    && sha256(fs.readFileSync(path.join(root, PDP1_INTERFACE_REVIEW_IMPACT_PATH))) === PDP1_INTERFACE_REVIEW_IMPACT_DIGEST
    && r1Delta?.predecessorSha256 === CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS[interfacePath]
    && r1Delta?.observedSha256 === CURRENT_CUT_SOURCE_OBSERVED_DIGESTS[interfacePath]
    && r1Delta?.historicalPdp1MaterialSha256 === r1Delta?.predecessorSha256
    && r2.parentImpact?.ref === CURRENT_CUT_SOURCE_IMPACT_PATH
    && r2.parentImpact?.recordId === r1.recordId
    && r2.parentImpact?.sha256 === sha256(fs.readFileSync(path.join(root, CURRENT_CUT_SOURCE_IMPACT_PATH)))
    && r2Delta?.path === interfacePath
    && r2Delta?.predecessorSha256 === r1Delta?.observedSha256
    && r2Delta?.observedSha256 === PDP1_INTERFACE_REVIEW_PREDECESSOR_DIGEST
    && r2Delta?.classification === 'PDP1_REVIEW_ARTIFACT_REFRESH_FOR_SEPARATELY_REVIEWED_OPERATION_DELTA'
    && r2Delta?.meaningChange === 'NO_ADDITIONAL_MEANING'
    && Array.isArray(r2Delta?.meaningIdsChanged) && r2Delta.meaningIdsChanged.length === 0
    && r4.parentImpact?.ref === CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH
    && r4.parentImpact?.recordId === r2.recordId
    && r4.parentImpact?.sha256 === sha256(fs.readFileSync(path.join(root, CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH)))
    && r4Delta?.path === interfacePath
    && r4Delta?.selector === 'sources[.product-experience/pdp-1-domain-data/operations.yaml].sha256'
    && r4Delta?.predecessorSha256 === PDP1_INTERFACE_REVIEW_PREDECESSOR_DIGEST
    && r4Delta?.observedSha256 === PDP1_INTERFACE_REVIEW_OBSERVED_DIGEST
    && r4Delta?.meaningChange === 'NO_ADDITIONAL_P1_MEANING'
    && Array.isArray(r4Delta?.meaningIdsChanged) && r4Delta.meaningIdsChanged.length === 0
    && r4.authority?.userAuthorization === 'NO_ADDITIONAL_P1_MEANING_FOR_EXACT_INTERFACE-REVIEW-PATH'
    && r4.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && r4.decision?.independentAcceptance === 'NOT_CLAIMED'
    && r16.sourceCurrentness?.sourceContentDigests?.[interfacePath] === PDP1_INTERFACE_REVIEW_OBSERVED_DIGEST
    && threeReviewTransition?.valid === true
    && transitionRow?.valid === true
    && transitionRow.predecessorSha256 === PDP1_INTERFACE_REVIEW_OBSERVED_DIGEST
    && transitionRow.observedSha256 === PDP1_THREE_REVIEW_TRANSITIONS[0].observedSha256
    && (currentDigest === PDP1_THREE_REVIEW_TRANSITIONS[0].observedSha256
      || projectionImpact.valid && currentDigest === projectionImpact.rowChecks.find((row) => row.path === interfacePath)?.observedSha256
      || interfacePinRefreshImpact.valid && currentDigest === interfacePinRefreshImpact.observedSha256)
    && observed === currentDigest
    && (statusDigest === currentDigest || projectionImpact.valid
      && statusDigest === projectionImpact.rowChecks.find((row) => row.path === interfacePath)?.predecessorSha256
      || interfacePinRefreshImpact.valid && statusDigest === interfacePinRefreshImpact.predecessorSha256)
    && semanticDigest === currentDigest
    && c22Impact?.valid === true
    && (operationDigest === PDP1_C22_OPERATIONS_DIGEST || pxd164Impact.valid && operationDigest === pxd164OperationDigest)
    && c22Impact.sourceDeltas?.find((row) => row.path === PDP1_OPERATIONS_PATH)?.predecessorSha256 === PDP1_C22_OPERATIONS_PREDECESSOR_DIGEST
    && c22Impact.sourceDeltas?.find((row) => row.path === PDP1_OPERATIONS_PATH)?.observedSha256 === PDP1_C22_OPERATIONS_DIGEST
    && c22Impact.sourceDeltas?.find((row) => row.path === PDP1_OPERATIONS_PATH)?.selector === PDP1_C22_OPERATION_SELECTOR
    && c22Impact.sourceDeltas?.find((row) => row.path === PDP1_OPERATIONS_PATH)?.classification === 'PXD163_MDC30_C22_SEMANTIC_REPAIR'
    && c22Impact.sourceDeltas?.find((row) => row.path === PDP1_OPERATIONS_PATH)?.meaningChange === 'PDP1_MEANING_CHANGED_AND_REVIEWED_UNDER_DELEGATED_INTERNAL_SOURCE_REVIEW'
    && JSON.stringify(c22Impact.sourceDeltas?.find((row) => row.path === PDP1_OPERATIONS_PATH)?.meaningIdsChanged) === JSON.stringify(['PXD-163/MDC30-C-22'])
    && (operationReviewDigest === PDP1_C22_REVIEW_INPUT_DIGESTS[PDP1_OPERATIONS_REVIEW_PATH]
      || projectionImpact.valid && operationReviewDigest === projectionImpact.rowChecks.find((row) => row.path === PDP1_OPERATIONS_REVIEW_PATH)?.observedSha256)
    && `sha256:${String(operationReview.currentSourceSha256 ?? '').replace(/^sha256:/u, '')}` === operationDigest
    && (`sha256:${String(interfaceSource.sources?.find((row) => row.path === PDP1_OPERATIONS_PATH)?.sha256 ?? '').replace(/^sha256:/u, '')}` === operationDigest
      || pxd164Impact.valid && `sha256:${String(interfaceSource.sources?.find((row) => row.path === PDP1_OPERATIONS_PATH)?.sha256 ?? '').replace(/^sha256:/u, '')}` === PDP1_C22_OPERATIONS_DIGEST)
    && (`sha256:${String(interfaceSource.currentSourceCutDeltaReview?.operationsSha256 ?? '').replace(/^sha256:/u, '')}` === operationDigest
      || pxd164Impact.valid && `sha256:${String(interfaceSource.currentSourceCutDeltaReview?.operationsSha256 ?? '').replace(/^sha256:/u, '')}` === PDP1_C22_OPERATIONS_DIGEST);
  return { valid, path: interfacePath, r1PredecessorSha256: r1Delta?.predecessorSha256 ?? null,
    r1ObservedSha256: r1Delta?.observedSha256 ?? null, r2ObservedSha256: r2Delta?.observedSha256 ?? null,
    r4ObservedSha256: r4Delta?.observedSha256 ?? null, r16IntermediateSha256: r16.sourceCurrentness?.sourceContentDigests?.[interfacePath] ?? null,
    currentSha256: currentDigest, statusPinSha256: statusDigest, semanticPinSha256: semanticDigest,
    currentOperationsSha256: operationDigest, currentOperationsReviewSha256: operationReviewDigest, reviewPinChecks, historyChecks, recordChecks,
    interfacePinRefreshImpact,
    operationParityProjectionImpact: projectionImpact };
}

export function validatePdp1OwnerWireC22SuccessorChain({ observedDigests = {}, historicalDigests = {}, statusPins = {}, semanticPins = {}, c22Impact } = {}) {
  const r5 = readJson(PDP1_OWNER_WIRE_IMPACT_PATH);
  const r3 = readJson(PDP1_OWNER_WIRE_PREDECESSOR_IMPACT_PATH);
  const r16 = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const row = r5.sourceDeltas?.[0];
  const c22Row = c22Impact?.sourceDeltas?.find((entry) => entry.path === PDP1_OWNER_WIRE_PATH);
  const currentDigest = sha256(fs.readFileSync(path.join(root, PDP1_OWNER_WIRE_PATH)));
  const pxd164Impact = validatePdp1Pxd164SemanticRepairImpact(readJson(PDP1_PXD164_IMPACT_PATH), { observedDigests });
  const pxd164WireDigest = pxd164Impact.sourceDeltas.find((entry) => entry.path === PDP1_OWNER_WIRE_PATH)?.observedSha256;
  const observed = observedDigests?.[PDP1_OWNER_WIRE_PATH]?.digest ?? observedDigests?.[PDP1_OWNER_WIRE_PATH];
  const statusDigest = `sha256:${String(statusPins?.[PDP1_OWNER_WIRE_PATH] ?? '').replace(/^sha256:/u, '')}`;
  const semanticDigest = `sha256:${String(semanticPins?.[PDP1_OWNER_WIRE_PATH] ?? '').replace(/^sha256:/u, '')}`;
  const valid = sha256(fs.readFileSync(path.join(root, PDP1_OWNER_WIRE_IMPACT_PATH))) === PDP1_OWNER_WIRE_IMPACT_DIGEST
    && sha256(fs.readFileSync(path.join(root, PDP1_OWNER_WIRE_PREDECESSOR_IMPACT_PATH))) === PDP1_OWNER_WIRE_PREDECESSOR_IMPACT_DIGEST
    && r5.recordId === 'MEDIA-DISCOVERY-PDP1-OWNER-ACTION-WIRE-IMPACT-2026-10-14-R5'
    && r5.parentImpact?.ref === PDP1_OWNER_WIRE_PREDECESSOR_IMPACT_PATH
    && r5.parentImpact?.recordId === r3.recordId
    && r5.parentImpact?.sha256 === PDP1_OWNER_WIRE_PREDECESSOR_IMPACT_DIGEST
    && row?.path === PDP1_OWNER_WIRE_PATH
    && row?.predecessorSha256 === PDP1_OWNER_WIRE_PREDECESSOR_DIGEST
    && row?.observedSha256 === PDP1_C22_OWNER_WIRE_PREDECESSOR_DIGEST
    && row?.selector === 'resultProjectionBindings and records/@id=media.owner-action-wire.deliver-exact-version.v1|media.owner-action-wire.inspect-consent-and-permitted-use.v1/semantics/sourceDeclaredResultFields'
    && row?.classification === 'PDP1_NOT_EXPOSED_MAPPING_LEDGER_REFRESH'
    && row?.meaningChange === 'NO_ADDITIONAL_PDP1_MEANING'
    && Array.isArray(row?.meaningIdsChanged) && row.meaningIdsChanged.length === 0
    && r5.authority?.authorizationEvidence?.authorizedPath === PDP1_OWNER_WIRE_PATH
    && r5.authority?.authorizationEvidence?.predecessorSha256 === row.predecessorSha256
    && r5.authority?.authorizationEvidence?.observedSha256 === row.observedSha256
    && r5.authority?.humanIndependentSignatureProvided === false
    && r5.authority?.externalContractOwnerAcceptanceProvided === false
    && r5.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && r5.decision?.independentAcceptance === 'NOT_CLAIMED'
    && r5.decision?.runtime === 'NOT_ADMITTED'
    && r5.decision?.closure === 'NOT_ENTERED'
    && r16.sourceCurrentness?.sourceContentDigests?.[PDP1_OWNER_WIRE_PATH] === PDP1_C22_OWNER_WIRE_PREDECESSOR_DIGEST
    && c22Impact?.valid === true
    && c22Row?.predecessorSha256 === PDP1_C22_OWNER_WIRE_PREDECESSOR_DIGEST
    && c22Row?.observedSha256 === PDP1_C22_OWNER_WIRE_DIGEST
    && c22Row?.selector === PDP1_C22_WIRE_SELECTOR
    && c22Row?.classification === 'PXD163_MDC30_C22_SEMANTIC_REPAIR'
    && c22Row?.meaningChange === 'PDP1_MEANING_CHANGED_AND_REVIEWED_UNDER_DELEGATED_INTERNAL_SOURCE_REVIEW'
    && JSON.stringify(c22Row?.meaningIdsChanged) === JSON.stringify(['PXD-163/MDC30-C-22'])
    && (currentDigest === PDP1_C22_OWNER_WIRE_DIGEST || pxd164Impact.valid && currentDigest === pxd164WireDigest)
    && observed === currentDigest
    && [PDP1_C22_OWNER_WIRE_DIGEST, pxd164WireDigest].includes(statusDigest)
    && [PDP1_C22_OWNER_WIRE_DIGEST, pxd164WireDigest].includes(semanticDigest);
  return { valid, path: PDP1_OWNER_WIRE_PATH, r5PredecessorSha256: row?.predecessorSha256 ?? null,
    r5ObservedSha256: row?.observedSha256 ?? null, r16IntermediateSha256: r16.sourceCurrentness?.sourceContentDigests?.[PDP1_OWNER_WIRE_PATH] ?? null,
    c22MeaningChange: c22Row?.meaningChange ?? null, c22MeaningIdsChanged: c22Row?.meaningIdsChanged ?? [],
    currentSha256: currentDigest, statusPinSha256: statusDigest, semanticPinSha256: semanticDigest };
}

export function validatePdp1StatusTestImpactRecord(record, { observedDigests, historicalDigests, statusPins, semanticPins,
  recordPath = PDP1_STATUS_TEST_IMPACT_PATH } = {}) {
  const parentRecord = readJson(CURRENT_CUT_SOURCE_IMPACT_PATH);
  const parentDelta = parentRecord.sourceDeltas?.find((entry) => entry.path === PDP1_STATUS_TEST_PATH);
  const parentDigest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_SOURCE_IMPACT_PATH)));
  const impactDigest = sha256(fs.readFileSync(path.join(root, recordPath)));
  const r16 = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const r16Digests = r16.sourceCurrentness?.sourceContentDigests ?? {};
  const delta = record?.sourceDelta;
  const valid = record?.schemaVersion === 'media.discovery-pdp1-additional-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-TEST-CENSUS-IMPACT-2026-10-14-R6'
    && impactDigest === PDP1_STATUS_TEST_IMPACT_DIGEST
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY' && record?.campaign?.phase === 'PDP-1'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && record?.authority?.userAuthorization === 'Authorize scoped impact disposition (Recommended)'
    && record?.authority?.authorizationEvidence?.channel === 'DIRECT_USER_REPLY_IN_CURRENT_TASK'
    && record?.authority?.authorizationEvidence?.exactResponse === 'Authorize scoped impact disposition (Recommended)'
    && record?.authority?.authorizationEvidence?.authorizedPath === PDP1_STATUS_TEST_PATH
    && record?.authority?.authorizationEvidence?.predecessorSha256 === PDP1_STATUS_TEST_PREDECESSOR_DIGEST
    && record?.authority?.authorizationEvidence?.observedSha256 === PDP1_STATUS_TEST_OBSERVED_DIGEST
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && recordPath === PDP1_STATUS_TEST_IMPACT_PATH
    && record?.parentImpact?.ref === CURRENT_CUT_SOURCE_IMPACT_PATH
    && record?.parentImpact?.recordId === 'MEDIA-DISCOVERY-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1'
    && record?.parentImpact?.sha256 === parentDigest
    && record?.parentImpact?.sha256 === 'sha256:1530e22dfb8c60296123ec95d494c53fc2f5ff81be7c8fc47bf0252661d2655b'
    && parentDelta?.path === PDP1_STATUS_TEST_PATH
    && parentDelta?.predecessorSha256 === CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS[PDP1_STATUS_TEST_PATH]
    && parentDelta?.observedSha256 === PDP1_STATUS_TEST_PREDECESSOR_DIGEST
    && delta?.path === PDP1_STATUS_TEST_PATH
    && delta?.phase === 'PDP-1'
    && delta?.predecessorSha256 === PDP1_STATUS_TEST_PREDECESSOR_DIGEST
    && historicalDigests?.[PDP1_STATUS_TEST_PATH] === CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS[PDP1_STATUS_TEST_PATH]
    && r16Digests[PDP1_STATUS_TEST_PATH] === PDP1_STATUS_TEST_OBSERVED_DIGEST
    && delta?.observedSha256 === PDP1_STATUS_TEST_OBSERVED_DIGEST
    && delta?.classification === 'STRUCTURAL_REGRESSION_TEST_CENSUS_EXPECTATION_CORRECTION'
    && delta?.meaningChange === 'NONE'
    && Array.isArray(delta?.meaningIdsChanged) && delta.meaningIdsChanged.length === 0
    && delta?.requiresFreshCurrentness === true
    && record?.decision?.status === 'INTERNAL_SCOPED_IMPACT_DISPOSITION'
    && record?.decision?.pdp1MeaningDisposition === 'NO_PRODUCT_MEANING_CHANGE_FOR_EXACT_TEST_FILE_DELTA'
    && record?.decision?.preserveHistoricalReceipts === true
    && record?.decision?.freshTechnicalCurrentnessRecapture === 'REQUIRED'
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentAcceptance === 'NOT_CLAIMED'
    && record?.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.decision?.nativePdpClosure === 'NOT_ENTERED'
    && record?.decision?.delivery === 'NOT_AUTHORIZED'
    && record?.decision?.release === 'NOT_AUTHORIZED';
  return { valid, recordRef: recordPath, recordId: record?.recordId ?? null, digest: impactDigest,
    path: PDP1_STATUS_TEST_PATH, predecessorSha256: delta?.predecessorSha256 ?? null,
    observedSha256: delta?.observedSha256 ?? null };
}

export function validatePdp0ReporterSuccessorImpact({ impact: impactOverride, p0Exit: p0ExitOverride, p0Currentness: p0CurrentnessOverride } = {}) {
  const impact = impactOverride ?? readJson(PDP0_REPORTER_SUCCESSOR_IMPACT_PATH);
  const p0Exit = p0ExitOverride ?? readJson(CURRENT_CUT_PDP0_SUCCESSOR_PATH);
  const p0Currentness = p0CurrentnessOverride ?? readJson(CURRENT_CUT_PDP0_SUCCESSOR_CURRENTNESS_PATH);
  const impactDigest = sha256(fs.readFileSync(path.join(root, PDP0_REPORTER_SUCCESSOR_IMPACT_PATH)));
  const p0ExitDigest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_PDP0_SUCCESSOR_PATH)));
  const p0CurrentnessDigest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_PDP0_SUCCESSOR_CURRENTNESS_PATH)));
  const delta = impact.sourceDeltas?.[0];
  const p0Disposition = p0Exit.successorSourceImpactDisposition;
  const p0ReporterCurrentDigest = p0Exit.sourceCurrentness?.sourceContentDigests?.[PDP1_GUARD_PATH];
  const statusPins = readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet;
  const semanticPins = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json').sourceFingerprints;
  const r6ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r6.json';
  const r6CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r6.json';
  const valid = impactDigest === PDP0_REPORTER_SUCCESSOR_IMPACT_DIGEST
    && impact.schemaVersion === 'media.discovery.pdp0-successor-source-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-PDP0-R6-SUCCESSOR-IMPACT-2026-10-14-R1'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY' && impact.campaign?.activePhase === 'PDP-0'
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.authorizationEvidence?.channel === 'DIRECT_USER_REPLY_IN_CURRENT_TASK'
    && impact.authority?.authorizationEvidence?.exactResponse === 'Authorize this exact transition (Recommended)'
    && impact.authority?.authorizationEvidence?.authorizedPath === PDP1_GUARD_PATH
    && impact.authority?.authorizationEvidence?.predecessorSha256 === PDP0_REPORTER_SUCCESSOR_PREDECESSOR_DIGEST
    && impact.authority?.authorizationEvidence?.observedSha256 === PDP0_REPORTER_SUCCESSOR_OBSERVED_DIGEST
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && impact.sourceDeltas?.length === 1
    && delta?.path === PDP1_GUARD_PATH
    && JSON.stringify(delta.phases) === JSON.stringify(['PDP-0', 'PDP-1'])
    && delta.predecessorSha256 === PDP0_REPORTER_SUCCESSOR_PREDECESSOR_DIGEST
    && delta.observedSha256 === PDP0_REPORTER_SUCCESSOR_OBSERVED_DIGEST
    && delta.classification === 'PDP_STATUS_REPORTER_SELECTION_CHANGE'
    && JSON.stringify(delta.changedMeaningIds) === JSON.stringify([])
    && delta.freshCurrentnessRequired === true
    && impact.decision?.status === 'APPROVED_INTERNAL_NO_MEANING_CHANGE_FOR_EXACT_SUCCESSOR_DELTA'
    && impact.decision?.pdp0MeaningDisposition === 'NO_PDP0_MEANING_CHANGE_FOR_EXACT_SOURCE_DELTA'
    && impact.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && impact.decision?.independentSignoff === 'NOT_CLAIMED'
    && impact.decision?.lifecycleClosure === 'NOT_ENTERED'
    && impact.decision?.runtime === 'NOT_ADMITTED'
    && impact.decision?.delivery === 'BLOCKED'
    && impact.decision?.release === 'NOT_AUTHORIZED'
    && impact.decision?.freshTechnicalCurrentness === 'REQUIRED'
    && JSON.stringify(impact.decision?.orderedTechnicalCurrentness) === JSON.stringify(['PDP-0', 'PDP-1'])
    && impact.predecessorCuts?.length === 1
    && impact.predecessorCuts[0]?.phase === 'PDP-0'
    && impact.predecessorCuts[0]?.exitRef === r6ExitPath
    && impact.predecessorCuts[0]?.exitSha256 === PDP0_R6_EXIT_DIGEST
    && sha256(fs.readFileSync(path.join(root, r6ExitPath))) === PDP0_R6_EXIT_DIGEST
    && impact.predecessorCuts[0]?.currentnessRef === r6CurrentnessPath
    && impact.predecessorCuts[0]?.currentnessSha256 === PDP0_R6_CURRENTNESS_DIGEST
    && sha256(fs.readFileSync(path.join(root, r6CurrentnessPath))) === PDP0_R6_CURRENTNESS_DIGEST
    && p0ExitDigest === CURRENT_CUT_PDP0_SUCCESSOR_DIGEST
    && p0CurrentnessDigest === CURRENT_CUT_PDP0_SUCCESSOR_CURRENTNESS_DIGEST
    && p0Exit.phase === 'PDP-0' && p0Exit.phaseExit?.status === 'PASS'
    && p0Exit.sourceCurrentness?.status === 'PASS'
    && p0Exit.developmentStatus?.status === 'DEV_COMPLETE'
    && p0ReporterCurrentDigest === PDP0_REPORTER_SUCCESSOR_OBSERVED_DIGEST
    && sha256(fs.readFileSync(path.join(root, PDP1_GUARD_PATH))) === PDP0_REPORTER_SUCCESSOR_OBSERVED_DIGEST
    && `sha256:${String(statusPins[PDP1_GUARD_PATH] ?? '').replace(/^sha256:/u, '')}` === PDP0_REPORTER_SUCCESSOR_OBSERVED_DIGEST
    && `sha256:${String(semanticPins[PDP1_GUARD_PATH] ?? '').replace(/^sha256:/u, '')}` === PDP0_REPORTER_SUCCESSOR_OBSERVED_DIGEST
    && p0Disposition?.path === 'tests/pdp-truth-domain.test.mjs'
    && p0Disposition?.classification === 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION'
    && p0Disposition?.authorityRef === 'docs/implementation/observations/media-discovery-pdp0-r8-successor-impact-2026-10-14-r2.json'
    && p0Disposition?.authoritySha256 === 'sha256:9bf1e6f82b403916fd13c6d27905bb4db1ca92489ff531fb59b15d8074efd25a'
    && p0Disposition?.predecessorSha256 === 'sha256:0d94c83f6c081f2e67a4ba20752c0cdfff03f26ae1d9d87860d9ba97047964e0'
    && p0Disposition?.observedSha256 === 'sha256:8ef1a6d5e11dc2e10ca32c3e6813fc8671c22a6c7f7038d48300d52f8feae578'
    && JSON.stringify(p0Disposition?.meaningIdsChanged) === JSON.stringify([])
    && p0Disposition?.ownerAcceptance === 'NOT_CLAIMED'
    && p0Disposition?.independentSignoff === 'NOT_CLAIMED'
    && p0Disposition?.lifecycleClosure === 'NOT_ENTERED'
    && p0Disposition?.runtime === 'NOT_ADMITTED'
    && p0Disposition?.delivery === 'BLOCKED'
    && p0Currentness.observationId === 'MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R10'
    && p0Currentness.phaseDisposition?.currentSourceCurrentness === 'PASS'
    && p0Currentness.phaseDisposition?.ownerAcceptanceClaim === 'NOT_CLAIMED'
    && p0Currentness.phaseDisposition?.pdp0Exit === 'PASS_INTERNAL_IMPACT_DISPOSITION_ONLY'
    && p0Currentness.phaseDisposition?.discoveryBarrier === 'FAIL_PDP1_PDP3_NOT_VALIDATED'
    && p0Currentness.phaseDisposition?.build === 'NOT_ENTERED'
    && p0Currentness.phaseDisposition?.pdpClosure === 'NOT_ENTERED'
    && p0Currentness.phaseDisposition?.delivery === 'BLOCKED';
  return { valid, recordId: impact.recordId, impactRef: PDP0_REPORTER_SUCCESSOR_IMPACT_PATH, impactDigest, p0ExitRef: CURRENT_CUT_PDP0_SUCCESSOR_PATH,
    p0ExitDigest, p0CurrentnessRef: CURRENT_CUT_PDP0_SUCCESSOR_CURRENTNESS_PATH, p0CurrentnessDigest,
    predecessorSha256: delta?.predecessorSha256 ?? null, observedSha256: delta?.observedSha256 ?? null,
    p0ReporterCurrentDigest, separateP0ImpactPath: p0Disposition?.path ?? null };
}

export function validatePdp1Pxd164SemanticRepairImpact(record, {
  observedDigests = {}, recordPath = PDP1_PXD164_IMPACT_PATH,
} = {}) {
  const predecessor = readJson(PDP1_PXD164_PREDECESSOR_PATH);
  const predecessorDigests = predecessor.sourceCurrentness?.sourceContentDigests ?? {};
  const onDisk = readJson(PDP1_PXD164_IMPACT_PATH);
  const rows = record?.sourceDeltas ?? [];
  const rowChecks = PDP1_PXD164_SOURCE_ROWS.map((expected) => {
    const row = rows.find((candidate) => candidate.path === expected.path);
    const observed = observedDigests?.[expected.path]?.digest ?? observedDigests?.[expected.path];
    const live = sha256(fs.readFileSync(path.join(root, expected.path)));
    return {
      path: expected.path,
      valid: row?.path === expected.path
        && row?.selector === expected.selector
        && row?.predecessorSha256 === expected.predecessorSha256
        && row?.observedSha256 === expected.observedSha256
        && row?.phase === 'PDP-1'
        && row?.classification === expected.classification
        && row?.meaningChange === 'PDP1_MEANING_CHANGED_AND_REVIEWED_UNDER_DELEGATED_INTERNAL_SOURCE_REVIEW'
        && JSON.stringify(row?.meaningIdsChanged) === JSON.stringify([PDP1_PXD164_MEANING_OWNER_ID])
        && row?.requiresFreshCurrentness === true
        && predecessorDigests[expected.path] === expected.predecessorSha256
        && observed === expected.observedSha256
        && live === expected.observedSha256,
      predecessorSha256: row?.predecessorSha256 ?? null,
      observedSha256: observed ?? null,
      liveSha256: live,
    };
  });
  const verificationInputChecks = PDP1_PXD164_VERIFICATION_INPUT_PATHS.map((sourcePath) => ({
    path: sourcePath,
    valid: record?.verificationInputs?.[sourcePath] === sha256(fs.readFileSync(path.join(root, sourcePath))),
    recordedSha256: record?.verificationInputs?.[sourcePath] ?? null,
    liveSha256: sha256(fs.readFileSync(path.join(root, sourcePath))),
  }));
  const verificationInputTransition = record?.verificationInputTransitions?.[0];
  const predecessorVerificationDigest = predecessor?.testRun?.sourceBinding?.testInputContentDigests?.[PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.path];
  const verificationInputTransitionValid = record?.verificationInputTransitions?.length === 1
    && verificationInputTransition?.path === PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.path
    && verificationInputTransition?.predecessorSha256 === PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.predecessorSha256
    && predecessorVerificationDigest === PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.predecessorSha256
    && verificationInputTransition?.observedSha256 === PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.observedSha256
    && record?.verificationInputs?.[PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.path] === PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.observedSha256
    && verificationInputTransition?.classification === PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.classification
    && verificationInputTransition?.meaningChange === 'NO_PDP1_MEANING_CHANGE'
    && Array.isArray(verificationInputTransition?.meaningIdsChanged) && verificationInputTransition.meaningIdsChanged.length === 0
    && verificationInputTransition?.requiresFreshCurrentness === true;
  const valid = recordPath === PDP1_PXD164_IMPACT_PATH
    && canonicalizeVerificationValue(record) === canonicalizeVerificationValue(onDisk)
    && sha256(fs.readFileSync(path.join(root, PDP1_PXD164_PREDECESSOR_PATH))) === PDP1_PXD164_PREDECESSOR_DIGEST
    && predecessor?.phase === 'PDP-1'
    && predecessor?.phaseExit?.status === 'PASS'
    && predecessor?.sourceCurrentness?.status === 'PASS'
    && predecessor?.developmentStatus?.status === 'DEV_COMPLETE'
    && predecessor?.developmentStatus?.outstandingMeaningIds?.length === 0
    && record?.schemaVersion === 'media.discovery-pdp1-semantic-repair-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-PXD164-SEMANTIC-REPAIR-IMPACT-2026-10-14-R1'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY'
    && record?.campaign?.phase === 'PDP-1'
    && record?.decisionRef === '.product-experience/decision-log.md#PXD-164'
    && record?.meaningOwnerId === PDP1_PXD164_MEANING_OWNER_ID
    && record?.sourcePredecessor?.ref === PDP1_PXD164_PREDECESSOR_PATH
    && record?.sourcePredecessor?.sha256 === PDP1_PXD164_PREDECESSOR_DIGEST
    && PDP1_PXD164_SOURCE_ROWS.every((expected) => record?.sourcePredecessor?.sourceDigests?.[expected.path] === expected.predecessorSha256)
    && rows.length === PDP1_PXD164_SOURCE_ROWS.length
    && rowChecks.every((check) => check.valid)
    && verificationInputChecks.every((check) => check.valid)
    && verificationInputTransitionValid
    && JSON.stringify(record?.pdp0ImpactAssessment?.meaningIdsChanged) === JSON.stringify([])
    && record?.pdp0ImpactAssessment?.disposition === 'NO_PDP0_MEANING_CHANGE'
    && record?.downstreamImpact?.pdp2 === 'NOT_YET_DISPOSITIONED_REQUIRES_SOURCE_IMPACT_REVIEW_AFTER_PDP1_CURRENTNESS'
    && record?.downstreamImpact?.pdp3 === 'REQUIRES_RECAPTURE_AFTER_AFFECTED_PDP2_CURRENTNESS'
    && JSON.stringify(record?.downstreamImpact?.orderedTechnicalCurrentnessRecapture) === JSON.stringify(['PDP-1', 'AFFECTED_PDP-2', 'PDP-3'])
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && record?.decision?.status === 'INTERNAL_SCOPED_PDP1_SEMANTIC_REPAIR_IMPACT_DISPOSITION'
    && record?.decision?.pdp1MeaningDisposition === 'EXACT_PXD164_OWNER_ID_MEANING_CHANGED'
    && record?.decision?.preserveHistoricalReceipts === true
    && record?.decision?.freshTechnicalCurrentnessRequired === true
    && record?.decision?.pdp2ImpactDisposition === 'NOT_CLAIMED_REQUIRES_SEPARATE_REVIEW'
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentReview === 'NOT_CLAIMED'
    && record?.decision?.nativeClosure === 'NOT_ENTERED'
    && record?.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.decision?.release === 'NOT_AUTHORIZED';
  return { valid, recordRef: recordPath, recordId: record?.recordId ?? null, predecessorRef: PDP1_PXD164_PREDECESSOR_PATH,
    predecessorDigest: PDP1_PXD164_PREDECESSOR_DIGEST, sourceDeltas: rowChecks, verificationInputs: verificationInputChecks };
}

export function validatePdp1Pxd164SupplementalPinDispositions({
  record = readJson(PDP1_PXD164_IMPACT_PATH),
  recordPath = PDP1_PXD164_IMPACT_PATH,
  statusPins = {},
  semanticPins = {},
  fileDigests = {},
} = {}) {
  const impact = validatePdp1Pxd164SemanticRepairImpact(record, { observedDigests: fileDigests, recordPath });
  const sourceRows = new Map((record?.sourceDeltas ?? []).map((row) => [row.path, row]));
  const expected = [
    ...PDP1_PXD164_SOURCE_ROWS.filter((row) => [
      '.product-experience/decision-log.md',
      '.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml',
    ].includes(row.path)),
    PDP1_PXD164_VERIFICATION_ONLY_TRANSITION,
  ];
  return expected.map((transition) => {
    const verificationOnly = transition.path === PDP1_PXD164_VERIFICATION_ONLY_TRANSITION.path;
    const row = verificationOnly ? record?.verificationInputTransitions?.[0] : sourceRows.get(transition.path);
    const predecessorSha256 = transition.predecessorSha256;
    const observedSha256 = transition.observedSha256;
    const pinDigest = `sha256:${String(statusPins?.[transition.path] ?? '').replace(/^sha256:/u, '')}`;
    const semanticPinDigest = `sha256:${String(semanticPins?.[transition.path] ?? '').replace(/^sha256:/u, '')}`;
    const fileDigest = fileDigests?.[transition.path]?.digest ?? fileDigests?.[transition.path];
    const valid = impact.valid
      && row?.path === transition.path
      && row?.predecessorSha256 === predecessorSha256
      && row?.observedSha256 === observedSha256
      && pinDigest === predecessorSha256
      && semanticPinDigest === observedSha256
      && fileDigest === observedSha256
      && row?.requiresFreshCurrentness === true
      && (verificationOnly
        ? row?.classification === transition.classification
          && row?.meaningChange === 'NO_PDP1_MEANING_CHANGE'
          && Array.isArray(row?.meaningIdsChanged) && row.meaningIdsChanged.length === 0
        : row?.classification === transition.classification
          && row?.meaningChange === 'PDP1_MEANING_CHANGED_AND_REVIEWED_UNDER_DELEGATED_INTERNAL_SOURCE_REVIEW'
          && JSON.stringify(row?.meaningIdsChanged) === JSON.stringify([PDP1_PXD164_MEANING_OWNER_ID]));
    return {
      valid,
      impact: record,
      path: transition.path,
      predecessorSha256,
      observedSha256,
      classification: verificationOnly ? 'PDP1_FOCUSED_VERIFICATION_ONLY' : row?.classification,
      meaningChange: verificationOnly ? 'NO_PDP1_MEANING_CHANGE' : row?.meaningChange,
      meaningIdsChanged: verificationOnly ? [] : row?.meaningIdsChanged,
      note: verificationOnly
        ? 'Exact PXD-164 verification-input transition; no PDP-1 meaning change.'
        : `Exact PXD-164 source row for ${PDP1_PXD164_MEANING_OWNER_ID}.`,
      freshCurrentnessRequired: true,
      impactRef: PDP1_PXD164_IMPACT_PATH,
      impactRecordId: record?.recordId ?? null,
      validationDetails: impact,
    };
  });
}

export function validatePdp1ThreeSourceTransitionDisposition(record, {
  observedDigests = {}, historicalDigests = {}, statusPins = {}, semanticPins = {},
  recordPath = PDP1_THREE_SOURCE_TRANSITION_PATH,
} = {}) {
  const recordDigest = sha256(fs.readFileSync(path.join(root, recordPath)));
  const predecessor = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const predecessorDigest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_PDP1_PREDECESSOR_PATH)));
  const predecessorDigests = predecessor.sourceCurrentness?.sourceContentDigests ?? {};
  const transitions = record?.sourceTransitions ?? [];
  const projectionImpact = validatePdp1OperationParityProjectionImpact(undefined, { observedDigests, statusPins, semanticPins });
  const pxd164Impact = validatePdp1Pxd164SemanticRepairImpact(readJson(PDP1_PXD164_IMPACT_PATH), { observedDigests });
  const devStatusTestImpact = validatePdp1DevStatusTestRefreshImpact(undefined, { testInputDigests: observedDigests });
  const projectionRows = projectionImpact.rowChecks ?? [];
  const liveDigest = (sourcePath) => sha256(fs.readFileSync(path.join(root, sourcePath)));
  const pinDigest = (pins, sourcePath) => `sha256:${String(pins?.[sourcePath] ?? '').replace(/^sha256:/u, '')}`;
  const rowChecks = PDP1_THREE_SOURCE_TRANSITION_ROWS.map((expected, index) => {
    const row = transitions[index];
    const observed = observedDigests?.[expected.path]?.digest ?? observedDigests?.[expected.path];
    const live = liveDigest(expected.path);
    const statusPin = pinDigest(statusPins, expected.path);
    const semanticPin = pinDigest(semanticPins, expected.path);
    const allowedPins = [expected.predecessorSha256, expected.observedSha256];
    const devStatusTestSuccessor = expected.path === PDP1_STATUS_TEST_PATH && devStatusTestImpact.valid
      && devStatusTestImpact.predecessorTestSha256 === expected.observedSha256
      && devStatusTestImpact.observedSha256 === observed;
    if (devStatusTestSuccessor) allowedPins.push(devStatusTestImpact.predecessorTestSha256, devStatusTestImpact.observedSha256);
    const r22Digest = readJson(PDP1_PXD164_PREDECESSOR_PATH).sourceCurrentness?.sourceContentDigests?.[expected.path];
    const projectionRow = projectionRows.find((entry) => entry.path === expected.path);
    const chainedR19Projection = [0, 1].includes(index) && projectionImpact.valid && pxd164Impact.valid
      && projectionRow?.predecessorSha256 === expected.observedSha256
      && projectionRow?.observedSha256 === r22Digest
      && r22Digest === live && observed === live
      && (index !== 1 || pxd164Impact.sourceDeltas.find((entry) => entry.path === PDP1_OPERATIONS_REVIEW_PATH)?.predecessorSha256 === r22Digest
        && pxd164Impact.sourceDeltas.find((entry) => entry.path === PDP1_OPERATIONS_REVIEW_PATH)?.observedSha256 === live)
      && statusPin === live && semanticPin === live;
    return {
      path: expected.path,
      predecessorSha256: row?.predecessorSha256 ?? null,
      valid: row?.path === expected.path
        && row?.phase === 'PDP-1'
        && row?.predecessorSha256 === expected.predecessorSha256
        && row?.observedSha256 === expected.observedSha256
        && predecessorDigests[expected.path] === expected.predecessorSha256
        && (((live === expected.observedSha256 && observed === expected.observedSha256
          && allowedPins.includes(statusPin) && allowedPins.includes(semanticPin)) || chainedR19Projection)
          || (devStatusTestSuccessor && live === observed
            && allowedPins.includes(statusPin) && allowedPins.includes(semanticPin)))
        && row?.meaningChange === 'NONE'
        && Array.isArray(row?.meaningIdsChanged) && row.meaningIdsChanged.length === 0
        && row?.requiresFreshCurrentness === true,
      observedSha256: observed ?? null,
      liveSha256: live,
      statusPinSha256: statusPin,
      semanticPinSha256: semanticPin,
    };
  });
  const separateDelta = record?.separateDelta;
  const separateDeltaValid = separateDelta?.path === PDP1_OPERATIONS_PATH
    && separateDelta?.disposition === 'SEMANTICALLY_REVIEWED_SEPARATELY_AND_KEPT_OUTSIDE_THIS_AUTHORIZATION_SCOPE'
    && separateDelta?.meaningIdsReviewed === PDP1_OPERATION_DELTA_IDS.length
    && separateDelta?.includedInNoMeaningTransitionSet === false
    && separateDelta?.includedInAuthorizedTransitions === false;
  const decision = record?.decision;
  const boundariesValid = record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && decision?.status === 'INTERNAL_SCOPED_DISPOSITION_ONLY'
    && decision?.pdp1MeaningDisposition === 'NO_PRODUCT_MEANING_CHANGE_FOR_THE_THREE_EXACT_TRANSITIONS'
    && decision?.preserveHistoricalReceipts === true
    && decision?.freshPdp1CurrentnessRecapture === 'REQUIRED'
    && decision?.externalOwnerAcceptance === 'NOT_CLAIMED'
    && decision?.independentSignoff === 'NOT_CLAIMED'
    && decision?.nativePdpClosure === 'NOT_ENTERED'
    && decision?.runtimeAdmission === 'NOT_ADMITTED'
    && decision?.delivery === 'NOT_AUTHORIZED'
    && decision?.release === 'NOT_AUTHORIZED'
    && typeof record?.limitation === 'string'
    && record.limitation.includes('Historical receipts are preserved')
    && record.limitation.includes('fresh PDP-1 currentness must be established')
    && record.limitation.includes('does not constitute external owner acceptance')
    && record.limitation.includes('outside this no-meaning transition set and authorization scope');
  const valid = recordPath === PDP1_THREE_SOURCE_TRANSITION_PATH
    && recordDigest === PDP1_THREE_SOURCE_TRANSITION_DIGEST
    && record?.schemaVersion === 'media.discovery-pdp1-source-transition-disposition.v1'
    && record?.recordId === 'MEDIA-PDP1-THREE-SOURCE-TRANSITION-NO-MEANING-2026-10-14'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY' && record?.campaign?.phase === 'PDP-1'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && record?.authority?.userAuthorization === 'Authorize these three exact transitions (Recommended)'
    && record?.authority?.authorizationEvidence?.channel === 'DIRECT_USER_REPLY_IN_CURRENT_TASK'
    && record?.authority?.authorizationEvidence?.exactResponse === 'Authorize these three exact transitions (Recommended)'
    && JSON.stringify(record?.authority?.authorizationEvidence?.authorizedPaths) === JSON.stringify(PDP1_THREE_SOURCE_TRANSITION_ROWS.map((row) => row.path))
    && record?.predecessor?.exitRef === CURRENT_CUT_PDP1_PREDECESSOR_PATH
    && record?.predecessor?.exitSha256 === CURRENT_CUT_PDP1_PREDECESSOR_DIGEST
    && predecessorDigest === CURRENT_CUT_PDP1_PREDECESSOR_DIGEST
    && Object.keys(predecessorDigests).length === 329
    && record?.predecessor?.materialSourcePathCount === 329
    && transitions.length === PDP1_THREE_SOURCE_TRANSITION_ROWS.length
    && rowChecks.every((entry) => entry.valid)
    && separateDeltaValid && boundariesValid
    && Object.hasOwn(record?.separateDelta ?? {}, 'includedInNoMeaningTransitionSet');
  return { valid, recordRef: recordPath, recordId: record?.recordId ?? null, recordDigest, predecessorRef: CURRENT_CUT_PDP1_PREDECESSOR_PATH,
    predecessorDigest, predecessorPathCount: Object.keys(predecessorDigests).length, transitionCount: transitions.length,
    meaningDisposition: decision?.pdp1MeaningDisposition ?? null, rowChecks, separateDeltaValid, boundariesValid };
}

export function validateCurrentCutSourceImpactRecord(impact, observedDigests, historicalDigests, statusPins, semanticPins, testRun, additionalSourceImpact = null, statusTestImpact = null, threeSourceTransition = null, interfaceReviewChain = null) {
  const impactDigest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_SOURCE_IMPACT_PATH)));
  const deltas = impact.sourceDeltas ?? [];
  const byPath = new Map(deltas.map((delta) => [delta.path, delta]));
  const oldGuardImpact = readJson(PDP3_STATUS_GUARD_IMPACT_PATH);
  const oldGuardImpactDigest = sha256(fs.readFileSync(path.join(root, PDP3_STATUS_GUARD_IMPACT_PATH)));
  const chainedReporter = deltas.find((delta) => delta.path === PDP1_GUARD_PATH);
  const oldGuardStep = chainedReporter?.predecessorChain?.[0];
  const oldReporterStatusPins = { ...statusPins, [PDP1_GUARD_PATH]: PDP1_GUARD_PREDECESSOR_DIGEST.slice('sha256:'.length) };
  const oldReporterSemanticPins = { ...semanticPins, [PDP1_GUARD_PATH]: PDP1_GUARD_PREDECESSOR_DIGEST.slice('sha256:'.length) };
  const oldReporterCheck = validateReporterImpactRecord(
    oldGuardImpact,
    { ...observedDigests, [PDP1_GUARD_PATH]: PDP1_GUARD_OBSERVED_DIGEST },
    historicalDigests,
    oldReporterStatusPins,
    oldReporterSemanticPins,
  );
  const reporterSuccessorImpact = validatePdp0ReporterSuccessorImpact();
  const devStatusTestSuccessorImpact = validatePdp1DevStatusTestRefreshImpact(undefined, {
    testInputDigests: observedDigests,
  });
  const currentPathFinalDigests = {
    [PDP1_GUARD_PATH]: reporterSuccessorImpact.observedSha256,
    [PDP1_INTERFACE_REVIEW_PATH]: interfaceReviewChain?.currentSha256 ?? (observedDigests[PDP1_INTERFACE_REVIEW_PATH]?.digest ?? observedDigests[PDP1_INTERFACE_REVIEW_PATH]),
    [PDP1_STATUS_TEST_PATH]: devStatusTestSuccessorImpact.valid
      ? devStatusTestSuccessorImpact.observedSha256
      : threeSourceTransition?.rowChecks?.find((entry) => entry.path === PDP1_STATUS_TEST_PATH)?.observedSha256
        ?? (observedDigests[PDP1_STATUS_TEST_PATH]?.digest ?? observedDigests[PDP1_STATUS_TEST_PATH]),
  };
  const requiredOutcome = (testRun?.outcomes ?? testRun?.testOutcomes)?.find((entry) => entry.command === CURRENT_CUT_PDP1_TEST_COMMAND);
  const requiredInputDigests = testRun?.testInputContentDigests ?? testRun?.sourceBinding?.testInputContentDigests ?? {};
  const testEvidenceValid = testRun?.sourceBinding?.stable === true
    && testRun?.startedHead === testRun?.completedHead
    && requiredOutcome?.status === 'PASS'
    && requiredOutcome?.exitCode === 0
    && Number.isInteger(requiredOutcome?.testCount)
    && requiredOutcome.testCount > 0
    && requiredOutcome.passedCount === requiredOutcome.testCount
    && requiredOutcome.failedCount === 0
    && requiredOutcome.skippedCount === 0
    && REQUIRED_TEST_FILES.every((sourcePath) => requiredInputDigests[sourcePath]
      === sha256(fs.readFileSync(path.join(root, sourcePath))))
    && CURRENT_CUT_PDP1_SOURCE_PATHS.every((sourcePath) => requiredInputDigests[sourcePath]
      === sha256(fs.readFileSync(path.join(root, sourcePath))));
  const interfacePath = '.product-experience/interface-parity/current-source-review.json';
  const statusTestPath = PDP1_STATUS_TEST_PATH;
  const reporter = byPath.get(PDP1_GUARD_PATH);
  const interfaceReview = byPath.get(interfacePath);
  const statusTest = byPath.get(statusTestPath);
  const exactPaths = deltas.length === CURRENT_CUT_SOURCE_PATHS.length
    && deltas.every((delta, index) => delta.path === CURRENT_CUT_SOURCE_PATHS[index])
    && new Set(deltas.map((delta) => delta.path)).size === CURRENT_CUT_SOURCE_PATHS.length;
  const exactHashes = CURRENT_CUT_SOURCE_PATHS.every((sourcePath) => {
    const delta = byPath.get(sourcePath);
    const statusTestCorrection = sourcePath === statusTestPath && statusTestImpact?.valid;
    const pinDigest = (pins) => `sha256:${String(pins?.[sourcePath] ?? '').replace(/^sha256:/u, '')}`;
    const finalStatusTestDigest = devStatusTestSuccessorImpact.valid
      ? devStatusTestSuccessorImpact.observedSha256
      : threeSourceTransition?.rowChecks?.find((entry) => entry.path === statusTestPath)?.observedSha256;
    const statusTestIntermediateDigest = threeSourceTransition?.rowChecks?.find((entry) => entry.path === statusTestPath)?.observedSha256;
    const finalReporterDigest = reporterSuccessorImpact.observedSha256;
    const transitionRowForTest = threeSourceTransition?.rowChecks?.find((entry) => entry.path === statusTestPath);
    return delta
      && delta.predecessorSha256 === CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS[sourcePath]
      && delta.observedSha256 === CURRENT_CUT_SOURCE_OBSERVED_DIGESTS[sourcePath]
      && (statusTestCorrection
        ? statusTestImpact.predecessorSha256 === delta.observedSha256
          && statusTestImpact.observedSha256 === transitionRowForTest?.predecessorSha256
          && threeSourceTransition?.valid === true && transitionRowForTest?.valid === true
          && finalStatusTestDigest === (observedDigests[sourcePath]?.digest ?? observedDigests[sourcePath])
          && (devStatusTestSuccessorImpact.valid
            ? devStatusTestSuccessorImpact.predecessorTestSha256 === statusTestIntermediateDigest
              && pinDigest(statusPins) === statusTestIntermediateDigest
              && pinDigest(semanticPins) === statusTestIntermediateDigest
            : pinDigest(statusPins) === finalStatusTestDigest && pinDigest(semanticPins) === finalStatusTestDigest)
        : sourcePath === PDP1_GUARD_PATH
        ? reporterSuccessorImpact.valid
          && delta.observedSha256 === reporterSuccessorImpact.predecessorSha256
          && finalReporterDigest === (observedDigests[sourcePath]?.digest ?? observedDigests[sourcePath])
          && pinDigest(statusPins) === finalReporterDigest
          && pinDigest(semanticPins) === finalReporterDigest
        : sourcePath === interfacePath && interfaceReviewChain?.valid === true
        ? interfaceReviewChain.r1ObservedSha256 === delta.observedSha256
          && interfaceReviewChain.currentSha256 === (observedDigests[sourcePath]?.digest ?? observedDigests[sourcePath])
          && pinDigest(statusPins) === interfaceReviewChain.statusPinSha256
          && interfaceReviewChain.semanticPinSha256 === interfaceReviewChain.currentSha256
          && pinDigest(semanticPins) === interfaceReviewChain.currentSha256
        : delta.observedSha256 === (observedDigests[sourcePath]?.digest ?? observedDigests[sourcePath]))
      && historicalDigests[sourcePath] === (sourcePath === PDP1_GUARD_PATH
        ? PDP1_GUARD_PREDECESSOR_DIGEST : CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS[sourcePath])
      && (statusTestCorrection
        ? devStatusTestSuccessorImpact.valid
          ? pinDigest(statusPins) === statusTestIntermediateDigest
          : pinDigest(statusPins) === finalStatusTestDigest
        : sourcePath === PDP1_GUARD_PATH
        ? pinDigest(statusPins) === finalReporterDigest
        : sourcePath === interfacePath && interfaceReviewChain?.valid === true
        ? pinDigest(statusPins) === interfaceReviewChain.statusPinSha256
        : pinDigest(statusPins) === delta.observedSha256)
      && (statusTestCorrection
        ? devStatusTestSuccessorImpact.valid
          ? pinDigest(semanticPins) === statusTestIntermediateDigest
          : pinDigest(semanticPins) === finalStatusTestDigest
        : sourcePath === PDP1_GUARD_PATH
        ? pinDigest(semanticPins) === finalReporterDigest
        : sourcePath === interfacePath && interfaceReviewChain?.valid === true
        ? pinDigest(semanticPins) === interfaceReviewChain.currentSha256
        : pinDigest(semanticPins) === delta.observedSha256);
  });
  const valid = impact.schemaVersion === 'media.discovery-current-cut-source-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY'
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.authorityRef === '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && exactPaths && exactHashes
    && reporter?.classification === 'PDP_STATUS_TEST_REPORTER_SELECTION_ONLY'
    && Array.isArray(reporter.changedFunctions)
    && JSON.stringify(reporter.changedFunctions) === JSON.stringify(['buildP103TestArgs', 'runRequiredChecks'])
    && Array.isArray(reporter.meaningIdsChanged) && reporter.meaningIdsChanged.length === 0
    && reporter.predecessorChain?.length === 1
    && oldGuardStep?.receiptRef === PDP3_STATUS_GUARD_IMPACT_PATH
    && oldGuardStep?.receiptSha256 === oldGuardImpactDigest
    && oldGuardStep?.fromSha256 === PDP1_GUARD_PREDECESSOR_DIGEST
    && oldGuardStep?.toSha256 === PDP1_GUARD_OBSERVED_DIGEST
    && oldReporterCheck.valid
    && reporterSuccessorImpact.valid
    && interfaceReviewChain?.valid === true
    && interfaceReview?.classification === 'PDP1_REVIEW_ARTIFACT_REFRESH_FOR_SEPARATELY_REVIEWED_OPERATION_DELTA'
    && interfaceReview.relatedDefinitionSource === PDP1_OPERATIONS_PATH
    && interfaceReview.relatedDefinitionSha256 === PDP1_R1_OPERATIONS_DIGEST
    && interfaceReview.relatedDefinitionReviewSource === PDP1_OPERATIONS_REVIEW_PATH
    && interfaceReview.relatedDefinitionReviewSha256 === PDP1_R1_OPERATIONS_REVIEW_DIGEST
    && JSON.stringify(interfaceReview.relatedReviewedDefinitionIds) === JSON.stringify(PDP1_R1_REVIEWED_DEFINITION_IDS)
    && Array.isArray(interfaceReview.additionalMeaningIds) && interfaceReview.additionalMeaningIds.length === 0
    && interfaceReview.meaningChange === 'NO_ADDITIONAL_MEANING_BEYOND_SEPARATELY_REVIEWED_PDP1_OPERATION_DELTA'
    && interfaceReview.requiresFreshCurrentness === true
    && statusTest?.classification === 'REGRESSION_COVERAGE'
    && statusTest?.meaningChange === 'NONE'
    && Array.isArray(statusTest.meaningIdsChanged) && statusTest.meaningIdsChanged.length === 0
    && statusTest.requiresFreshCurrentness === true
    && testEvidenceValid
    && impact.requiredEvidence?.command === PRE_PXD164_CURRENT_CUT_PDP1_TEST_COMMAND
    && impact.requiredEvidence?.status === 'PASS_AT_R10_AND_RERUN_DURING_SUCCESSOR_CURRENTNESS_CAPTURE'
    && impact.requiredEvidence?.referenceStatus === 'PASS'
    && impact.requiredEvidence?.referenceTestCount === 75
    && impact.requiredEvidence?.referencePassedCount === 75
    && impact.requiredEvidence?.referenceFailedCount === 0
    && impact.requiredEvidence?.referenceSkippedCount === 0
    && impact.decision?.status === 'APPROVED_INTERNAL_IMPACT_DISPOSITION_FOR_EXACT_SOURCE_DELTAS'
    && impact.decision?.pdp0MeaningDisposition === 'NO_MEANING_CHANGE_FOR_EXACT_REVIEWED_SOURCE_DELTAS'
    && impact.decision?.pdp1MeaningDisposition === 'NO_ADDITIONAL_MEANING_IDS_IN_THESE_THREE_PATH_CHANGES; OPERATIONS_YAML_DELTA_REMAINS_SEPARATELY_REVIEWED'
    && JSON.stringify(impact.decision?.requiresOrderedTechnicalCurrentnessRecapture) === JSON.stringify(['PDP-0', 'PDP-1'])
    && impact.decision?.preserveHistoricalReceipts === true
    && impact.decision?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && impact.decision?.externalContractOwnerAcceptance === 'NOT_CLAIMED'
    && impact.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && impact.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && impact.decision?.delivery === 'BLOCKED';
  return { valid, impactRef: CURRENT_CUT_SOURCE_IMPACT_PATH, impactDigest, impactRecordId: impact.recordId, testEvidenceValid,
    reporterSuccessorImpact,
    validationDetails: { exactPaths, exactHashes, oldReporterImpactValid: oldReporterCheck.valid, testEvidenceValid,
      hashMatches: CURRENT_CUT_SOURCE_PATHS.map((sourcePath) => ({
        path: sourcePath,
        predecessor: historicalDigests[sourcePath] === (sourcePath === PDP1_GUARD_PATH
          ? PDP1_GUARD_PREDECESSOR_DIGEST : CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS[sourcePath]),
        r1Observed: CURRENT_CUT_SOURCE_OBSERVED_DIGESTS[sourcePath],
        finalObserved: currentPathFinalDigests[sourcePath],
        observed: (observedDigests[sourcePath]?.digest ?? observedDigests[sourcePath]) === currentPathFinalDigests[sourcePath],
        statusPin: sourcePath === PDP1_STATUS_TEST_PATH && devStatusTestSuccessorImpact.valid
          ? `sha256:${String(statusPins[sourcePath] ?? '').replace(/^sha256:/u, '')}` === devStatusTestSuccessorImpact.predecessorTestSha256
          : `sha256:${String(statusPins[sourcePath] ?? '').replace(/^sha256:/u, '')}` === currentPathFinalDigests[sourcePath],
        semanticPin: sourcePath === PDP1_STATUS_TEST_PATH && devStatusTestSuccessorImpact.valid
          ? `sha256:${String(semanticPins[sourcePath] ?? '').replace(/^sha256:/u, '')}` === devStatusTestSuccessorImpact.predecessorTestSha256
          : `sha256:${String(semanticPins[sourcePath] ?? '').replace(/^sha256:/u, '')}` === currentPathFinalDigests[sourcePath],
      })),
      testInputsMatch: REQUIRED_TEST_FILES.map((sourcePath) => ({ path: sourcePath,
        expected: sha256(fs.readFileSync(path.join(root, sourcePath))), actual: requiredInputDigests[sourcePath],
        matches: requiredInputDigests[sourcePath] === sha256(fs.readFileSync(path.join(root, sourcePath))) })),
      outcome: requiredOutcome ?? null,
      testSourceStable: testRun?.sourceBinding?.stable === true,
      headStable: testRun?.startedHead === testRun?.completedHead,
      exactAuthority: impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW',
      exactDecision: impact.decision?.pdp1MeaningDisposition === 'NO_ADDITIONAL_MEANING_IDS_IN_THESE_THREE_PATH_CHANGES; OPERATIONS_YAML_DELTA_REMAINS_SEPARATELY_REVIEWED' } };
}

function validateAdapterTestImpactRecord(impact, statusPins, semanticPins, fileDigests) {
  const delta = impact.sourceDelta;
  const evidence = impact.testEvidence;
  const valid = impact.schemaVersion === 'media.discovery-pdp1-status-pin-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-PDP1-ADAPTER-TEST-PIN-IMPACT-2026-10-14-R1'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY'
    && impact.campaign?.phase === 'PDP-1'
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.authorityRef === '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PRODUCT_AND_ENGINEERING_SOURCE_IMPACT_REVIEW'
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && delta?.path === PDP1_ADAPTER_TEST_PATH
    && delta?.predecessorSha256 === PDP1_ADAPTER_TEST_PREDECESSOR_DIGEST
    && delta?.observedSha256 === PDP1_ADAPTER_TEST_OBSERVED_DIGEST
    && Array.isArray(delta?.historicalPinSets)
    && delta.historicalPinSets.length === 2
    && delta.historicalPinSets.includes('PDP1_DEVELOPMENT_STATUS_SOURCE_SHA_SET')
    && delta.historicalPinSets.includes('PDP1_SEMANTIC_REVIEW_SOURCE_FINGERPRINTS')
    && delta?.historicalPdp1MaterialSourceContainsPath === false
    && delta?.classification === 'PDP3_CONSUMER_TEST_ONLY; PDP1_DEFERRED_EVIDENCE_STATUS_PIN_REFRESH_REQUIRED; NO_PDP1_DEFINITION_MEANING_CHANGE'
    && delta?.meaningChange === 'NONE'
    && Array.isArray(delta?.meaningIdsChanged) && delta.meaningIdsChanged.length === 0
    && delta?.requiresFreshCurrentness === true
    && evidence?.command === PDP1_ADAPTER_TEST_COMMAND
    && evidence?.sourceSha256 === PDP1_ADAPTER_TEST_OBSERVED_DIGEST
    && evidence?.status === 'PASS'
    && evidence?.testCount === 6
    && evidence?.passCount === 6
    && evidence?.failCount === 0
    && evidence?.skippedCount === 0
    && evidence?.stdoutSha256 === 'sha256:8983d0917ae2ec1abff3fd15c24f0eabdc99b1ca767caa40a332d6e080fac19d'
    && impact.decision?.status === 'APPROVED_INTERNAL_NON_IMPACT_FOR_EXACT_PDP1_PIN_DELTA'
    && impact.decision?.pdp1DefinitionMeaningDisposition === 'NO_MEANING_CHANGE'
    && impact.decision?.requiresFreshPdp1Currentness === true
    && impact.decision?.preserveHistoricalReceipts === true
    && impact.decision?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && impact.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && impact.decision?.build === 'NOT_ENTERED'
    && impact.decision?.delivery === 'BLOCKED'
    && `sha256:${String(statusPins[PDP1_ADAPTER_TEST_PATH] ?? '').replace(/^sha256:/u, '')}` === PDP1_ADAPTER_TEST_PREDECESSOR_DIGEST
    && `sha256:${String(semanticPins[PDP1_ADAPTER_TEST_PATH] ?? '').replace(/^sha256:/u, '')}` === PDP1_ADAPTER_TEST_PREDECESSOR_DIGEST
    && fileDigests[PDP1_ADAPTER_TEST_PATH]?.digest === PDP1_ADAPTER_TEST_OBSERVED_DIGEST;
  return { valid, impact, path: PDP1_ADAPTER_TEST_PATH, predecessorSha256: PDP1_ADAPTER_TEST_PREDECESSOR_DIGEST, observedSha256: PDP1_ADAPTER_TEST_OBSERVED_DIGEST };
}

export function validatePdp1OperationDefinitionDelta(
  fileDigests,
  historicalDigests,
  semanticReview = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json'),
  { sourceText = readText(PDP1_OPERATIONS_PATH), reviewText = readText(PDP1_OPERATIONS_REVIEW_PATH) } = {},
) {
  const review = JSON.parse(reviewText);
  const delta = review.currentSourceCutDeltaReview?.supplementalPdp1DefinitionDelta;
  const sourceDigest = fileDigests[PDP1_OPERATIONS_PATH]?.digest ?? null;
  const reviewDigest = fileDigests[PDP1_OPERATIONS_REVIEW_PATH]?.digest ?? null;
  const source = parseYaml(sourceText);
  const contracts = new Map((source.ownerTypedObservationContracts?.records ?? []).map((record) => [record.id, record]));
  const validations = new Map((source.ownerTypedObservationValidationRules?.records ?? [])
    .map((record) => [record.observationContractRef?.split('@id=').at(-1), record]));
  const capabilityContracts = new Map((source.capabilityOperationContracts?.records ?? []).map((record) => [record.id, record]));
  const ownerOperationContracts = new Map((source.ownerDefinedOperationContracts?.records ?? []).map((record) => [record.id, record]));
  const reviewedRecords = delta?.reviewedRecords ?? [];
  const recordsResolveExactly = reviewedRecords.length === PDP1_OPERATION_DELTA_IDS.length
    && reviewedRecords.map((record) => record.id).every((id, index) => id === PDP1_OPERATION_DELTA_IDS[index])
    && reviewedRecords.every((record) => {
      const contract = contracts.get(record.id);
      const validation = validations.get(record.id);
      const expectedSelector = `${PDP1_OPERATIONS_PATH}#ownerTypedObservationContracts/records/@id=${record.id}`;
      const expectedValidationSelector = validation
        ? `${PDP1_OPERATIONS_PATH}#ownerTypedObservationValidationRules/records/@id=${validation.id}` : null;
      return contract && validation
        && record.selector === expectedSelector
        && record.validationRuleId === validation.id
        && record.validationSelector === expectedValidationSelector
        && record.operationKind === 'QUERY'
        && record.bindingStatus === contract.bindingStatus
        && JSON.stringify(record.operationRefs) === JSON.stringify(contract.operationRefs)
        && typeof record.meaning === 'string' && record.meaning.length > 40;
    });
  const reviewedOperationRecords = delta?.reviewedOperationRecords ?? [];
  const capabilitySelector = `${PDP1_OPERATIONS_PATH}#capabilityOperationContracts/records/@id=${PDP1_REVIEWED_OPERATION_IDS[0]}`;
  const ownerOperationSelector = `${PDP1_OPERATIONS_PATH}#ownerDefinedOperationContracts/records/@id=${PDP1_REVIEWED_OPERATION_IDS[1]}`;
  const dubBindings = capabilityContracts.get(PDP1_REVIEWED_OPERATION_IDS[0])?.resultSchema?.bindingRules ?? [];
  const fallbackContract = ownerOperationContracts.get(PDP1_REVIEWED_OPERATION_IDS[1]);
  const fallbackBindings = {
    bindingRuleIds: (fallbackContract?.bindingRules ?? []).map((record) => record.id),
    evidenceJoinRuleIds: (fallbackContract?.evidenceJoinRules ?? []).map((record) => record.id),
    resultBindingIds: (fallbackContract?.resultBindings ?? []).flatMap((record) => (record.bindings ?? []).map((binding) => binding.id)),
  };
  const operationRecordsResolveExactly = reviewedOperationRecords.length === PDP1_REVIEWED_OPERATION_IDS.length
    && reviewedOperationRecords.map((record) => record.id).every((id, index) => id === PDP1_REVIEWED_OPERATION_IDS[index])
    && reviewedOperationRecords[0]?.selector === capabilitySelector
    && reviewedOperationRecords[0]?.bindingCollection === 'resultSchema.bindingRules[].id'
    && Array.isArray(dubBindings) && dubBindings.length > 0
    && JSON.stringify(reviewedOperationRecords[0]?.bindingIds) === JSON.stringify(dubBindings.map((binding) => binding.id))
    && reviewedOperationRecords[1]?.selector === ownerOperationSelector
    && Object.keys(fallbackBindings).every((key) => Array.isArray(fallbackBindings[key]) && fallbackBindings[key].length > 0
      && JSON.stringify(reviewedOperationRecords[1]?.[key]) === JSON.stringify(fallbackBindings[key]))
    && fallbackContract?.operationKind === 'COMMAND'
    && fallbackContract?.requestSchema?.required?.includes('explicitConfirmation')
    && fallbackContract?.requestSchema?.required?.includes('originalRequestFingerprint')
    && fallbackContract?.requestSchema?.required?.includes('originalJobId');
  const semanticSupplement = (semanticReview.supplementaryReviews ?? [])
    .find((record) => record.id === 'P1-current-owner-typed-observation-definition-delta-2026-10-14');
  const currentReview = semanticReview.currentCutReview?.supplementalDefinitionDeltaReview;
  const pxd164 = readJson(PDP1_PXD164_IMPACT_PATH);
  const reviewedOperationsPredecessor = pxd164.sourcePredecessor?.sourceDigests?.[PDP1_OPERATIONS_PATH];
  const reviewedOperationsReviewPredecessor = pxd164.sourcePredecessor?.sourceDigests?.[PDP1_OPERATIONS_REVIEW_PATH];
  const reviewedIdentityIds = semanticReview.reviewedIdentityIds ?? [];
  const exactIdentityCensus = reviewedIdentityIds.length === 2026
    && new Set(reviewedIdentityIds).size === 2026
    && PDP1_NEW_OPERATION_IDENTITY_IDS.every((identity) => reviewedIdentityIds.includes(identity));
  const checks = {
    reviewSchema: review.schemaVersion === 'media.pdp1-operation-current-source-review.v1'
      && review.sourcePath === PDP1_OPERATIONS_PATH,
    sourcePins: sourceDigest === PDP1_OPERATIONS_OBSERVED_DIGEST
      && sourceDigest === sha256(sourceText)
      && review.currentSourceSha256 === sourceDigest?.replace(/^sha256:/u, '')
      && review.currentSourceCutDeltaReview?.currentSourceSha256 === review.currentSourceSha256
      && delta?.currentSourceSha256 === sourceDigest?.replace(/^sha256:/u, '')
      && sourceDigest === `sha256:${review.currentSourceSha256}`,
    semanticDeltaDeclaration: delta?.schemaVersion === 'media.pdp1-operation-definition-delta-review.v1'
      && delta.status === 'REVIEWED_CURRENT_SOURCE_SEMANTIC_DELTA'
      && delta.predecessorSourceSha256 === PDP1_OPERATIONS_PREDECESSOR_DIGEST.replace(/^sha256:/u, '')
      && delta.reviewAuthority === 'AI assistant acting under explicit user delegation for internal Media source-definition review; this is not a human owner signature, external contract-owner acceptance, independent specialist attestation, or phase-exit receipt.'
      && delta.materiality === 'PDP1_NORMATIVE_DEFINITION_CHANGE_REQUIRING_OWNING_PHASE_REVIEW_AND_FRESH_CURRENTNESS',
    exactCurrentContracts: recordsResolveExactly,
    exactReviewedOperationBindings: operationRecordsResolveExactly,
    reviewArtifactLineage: delta.sourceReviewArtifactPath === PDP1_OPERATIONS_REVIEW_PATH
      && delta.predecessorReviewArtifactSha256 === PDP1_OPERATIONS_REVIEW_PREDECESSOR_DIGEST
      && delta.reviewArtifactDisposition === 'SOURCE_REVIEW_EVIDENCE_REFRESH_FOR_THE_EXACT_PDP1_SEMANTIC_DELTA'
      && delta.reviewArtifactRequiresFreshCurrentness === true
      && reviewDigest === sha256(reviewText)
      && historicalDigests[PDP1_OPERATIONS_REVIEW_PATH] === PDP1_OPERATIONS_REVIEW_PREDECESSOR_DIGEST
      && reviewDigest !== null,
    currentnessAndHistory: delta.freshCurrentnessRequired === true
      && delta.historicalReceiptsPreserved === true
      && historicalDigests[PDP1_OPERATIONS_PATH] === PDP1_OPERATIONS_PREDECESSOR_DIGEST,
    boundaries: delta.preservedBoundaries?.ownerTypedObservationsRemainQueries === true
      && delta.preservedBoundaries?.runtimeAdmission === 'NOT_ADMITTED'
      && delta.preservedBoundaries?.transportAdmission === 'NOT_ADMITTED'
      && delta.preservedBoundaries?.externalContractOwnerAcceptance === 'NOT_CLAIMED'
      && delta.preservedBoundaries?.independentSpecialistAttestation === 'NOT_CLAIMED'
      && delta.preservedBoundaries?.unknownEvidenceRemainsUnknown === true
      && delta.preservedBoundaries?.noEndpointOrProductionBehaviorAdded === true
      && delta.preservedBoundaries?.proposalOperationInventoryRemainsUnaccepted === true
      && delta.preservedBoundaries?.proposalOperationRecordCount === 14,
    identityCensus: exactIdentityCensus,
    fullIdentityReview: semanticReview.sourceCutStable === true
      && semanticReview.outstandingMeaningIds?.length === 0
      && exactIdentityCensus
      && semanticReview.sourceFingerprints?.[PDP1_OPERATIONS_PATH] === review.currentSourceSha256
      && semanticReview.sourceFingerprints?.[PDP1_OPERATIONS_REVIEW_PATH] === reviewDigest.replace(/^sha256:/u, ''),
    supplementarySemanticReview: currentReview?.sourceSha256 === reviewedOperationsPredecessor?.replace(/^sha256:/u, '')
      && currentReview?.sourceReviewArtifactSha256 === reviewedOperationsReviewPredecessor
      && currentReview?.identitySetChanged === true
      && currentReview?.existingIdentityCountPreserved === 2023
      && JSON.stringify(currentReview?.reviewedRecordIds) === JSON.stringify(PDP1_OPERATION_DELTA_IDS)
      && JSON.stringify(currentReview?.reviewedOperationRecords) === JSON.stringify(PDP1_REVIEWED_OPERATION_IDS)
      && JSON.stringify(currentReview?.newIdentityIds) === JSON.stringify(PDP1_NEW_OPERATION_IDENTITY_IDS)
      && currentReview?.resultingIdentityCount === 2026
      && currentReview?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
      && currentReview?.externalContractOwnerAcceptance === 'NOT_CLAIMED'
      && currentReview?.runtimeAdmission === 'NOT_ADMITTED'
      && currentReview?.transportAdmission === 'NOT_ADMITTED'
      && semanticSupplement?.sourceSha256 === sourceDigest?.replace(/^sha256:/u, '')
      && semanticSupplement?.reviewedPopulationIdsPreserved === 2023
      && semanticSupplement?.identitySetChanged === true
      && JSON.stringify(semanticSupplement?.newIdentityIds) === JSON.stringify(PDP1_NEW_OPERATION_IDENTITY_IDS)
      && semanticSupplement?.resultingIdentityCount === 2026
      && semanticSupplement?.reviewedPopulationIdCountResult === 2026
      && semanticSupplement?.externalOwnerAcceptance === 'NOT_CLAIMED'
      && semanticSupplement?.independentSpecialistAttestation === 'NOT_CLAIMED'
      && semanticSupplement?.runtimeAdmission === 'NOT_ADMITTED'
      && semanticSupplement?.transportAdmission === 'NOT_ADMITTED'
      && semanticSupplement?.lifecycleClosure === 'NOT_ENTERED'
      && semanticSupplement?.sourceReviewArtifactSha256 === reviewDigest,
  };
  const valid = Object.values(checks).every(Boolean);
  return {
    valid,
    sourcePath: PDP1_OPERATIONS_PATH,
    sourceReviewPath: PDP1_OPERATIONS_REVIEW_PATH,
    predecessorSha256: PDP1_OPERATIONS_PREDECESSOR_DIGEST,
    observedSha256: sourceDigest,
    reviewArtifactPredecessorSha256: PDP1_OPERATIONS_REVIEW_PREDECESSOR_DIGEST,
    reviewArtifactObservedSha256: reviewDigest,
    reviewedDefinitionIds: reviewedRecords.map((record) => record.id),
    validationChecks: checks,
    classification: 'PDP1_DEFINITION_SEMANTIC_DELTA_REVIEWED_UNDER_USER_DELEGATION',
    requiresFreshCurrentness: true,
    limitation: 'Internal definition review only; no human owner signature, external acceptance, independent attestation, runtime admission, or phase receipt is asserted.',
  };
}

export function pdp1SemanticDefinitionPinDisposition(sourcePath, semanticDelta) {
  if (semanticDelta?.valid !== true) return null;
  if (sourcePath === PDP1_OPERATIONS_PATH) {
    return {
      classification: 'PDP1_DEFINITION_SEMANTIC_DELTA_REVIEWED_UNDER_USER_DELEGATION',
      meaningChange: 'PDP1_MEANING_CHANGED_AND_REVIEWED',
      note: `Reviewed exact PDP-1 definition delta ${semanticDelta.reviewedDefinitionIds.join(', ')} under explicit user-delegated internal source-definition authority.`,
      sourceReviewPath: semanticDelta.sourceReviewPath,
      requiresFreshCurrentness: semanticDelta.requiresFreshCurrentness,
      externalContractOwnerAcceptance: 'NOT_CLAIMED',
      independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
    };
  }
  if (sourcePath === PDP1_OPERATIONS_REVIEW_PATH) {
    return {
      classification: 'PDP1_SEMANTIC_REVIEW_ARTIFACT_REFRESH',
      meaningChange: 'REVIEW_ARTIFACT_FOR_REVIEWED_PDP1_SEMANTIC_DELTA',
      note: `This exact current-source review artifact records the reviewed PDP-1 definition delta ${semanticDelta.reviewedDefinitionIds.join(', ')}; it is evidence for the source change, not a separate product-definition change.`,
      sourceReviewPath: semanticDelta.sourceReviewPath,
      requiresFreshCurrentness: semanticDelta.requiresFreshCurrentness,
      externalContractOwnerAcceptance: 'NOT_CLAIMED',
      independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
    };
  }
  return null;
}

function validateParityTestPinImpactRecord(impact, statusPins, semanticPins, fileDigests, historicalDigests, testRun) {
  const expected = [
    {
      path: PDP1_PARITY_TEST_PATHS[0],
      predecessorSha256: 'sha256:582b43c7ef832f14a3c8db30b004ecb4e50c13640d12b7df51245240453dc03e',
      historicalMaterialSha256: 'sha256:3b2ebd2a9dcbe68f1afb86438fa55953851596a5d5c359a888bc94bb95eb4cc4',
    },
    {
      path: PDP1_PARITY_TEST_PATHS[1],
      predecessorSha256: 'sha256:61e516a75c72196c697f7480af8a9ab0805796af1ec4fd3b7f6606c51fb7c3c1',
      historicalMaterialSha256: 'sha256:fb5844bcafe7e5d6dfbc6ce19dfbbd68c84476855089ce17b0a353d31ae663e4',
    },
  ];
  const rows = impact.sourceDeltas ?? [];
  const outcome = testRun?.testOutcomes?.find((entry) => entry.command === REQUIRED_TEST_COMMAND);
  const sourceInputsMatch = expected.every(({ path: sourcePath }) =>
    testRun?.sourceBinding?.testInputContentDigests?.[sourcePath] === fileDigests[sourcePath]?.digest);
  const evidencePasses = impact.requiredEvidence?.command === REQUIRED_TEST_COMMAND
    && impact.requiredEvidence?.status === 'REQUIRED_FOR_DISPOSITION'
    && outcome?.status === 'PASS' && outcome.exitCode === 0
    && Number.isInteger(outcome.testCount) && outcome.testCount > 0
    && outcome.passedCount === outcome.testCount && outcome.failedCount === 0 && outcome.skippedCount === 0
    && testRun?.sourceBinding?.stable === true
    && testRun.startedHead === testRun.completedHead
    && sourceInputsMatch;
  const authorized = impact.schemaVersion === 'media.discovery-pdp1-parity-test-pin-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-PDP1-PARITY-TEST-PIN-IMPACT-2026-10-14-R1'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY'
    && impact.campaign?.phase === 'PDP-1'
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && rows.length === expected.length
    && expected.every((expectedRow, index) => {
      const row = rows[index];
      const observed = fileDigests[expectedRow.path]?.digest;
      const statusPin = `sha256:${String(statusPins[expectedRow.path] ?? '').replace(/^sha256:/u, '')}`;
      const semanticPin = String(semanticPins[expectedRow.path] ?? '').replace(/^sha256:/u, '');
      return row?.path === expectedRow.path
        && row.predecessorSha256 === expectedRow.predecessorSha256
        && row.observedSha256 === observed
        && row.historicalPinSets?.length === 2
        && row.historicalPinSets.includes('PDP1_DEVELOPMENT_STATUS_SOURCE_SHA_SET')
        && row.historicalPinSets.includes('PDP1_SEMANTIC_REVIEW_SOURCE_FINGERPRINTS')
        && row.historicalPdp1MaterialSourceContainsPath === true
        && row.historicalPdp1MaterialSourceSha256 === expectedRow.historicalMaterialSha256
        && row.classification === 'REGRESSION_COVERAGE'
        && row.meaningChange === 'NONE'
        && Array.isArray(row.meaningIdsChanged) && row.meaningIdsChanged.length === 0
        && row.expectedAssertions?.length > 0
        && row.requiresFreshCurrentness === true
        && statusPin === expectedRow.predecessorSha256
        && historicalDigests[expectedRow.path] === expectedRow.historicalMaterialSha256
        && semanticPin === observed?.replace(/^sha256:/u, '')
        && observed !== null && observed !== undefined;
    })
    && impact.decision?.status === 'SCOPED_INTERNAL_TEST_PIN_RECONCILIATION'
    && impact.decision?.meaningDisposition === 'TEST_COVERAGE_ONLY'
    && impact.decision?.requiresFreshPdp1Currentness === true
    && impact.decision?.preserveHistoricalReceipts === true
    && impact.decision?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && impact.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && impact.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && impact.decision?.delivery === 'BLOCKED';
  const valid = authorized && evidencePasses;
  return expected.map((expectedRow, index) => {
    const row = rows[index] ?? {};
    return {
      valid,
      impact,
      path: expectedRow.path,
      predecessorSha256: expectedRow.predecessorSha256,
      observedSha256: fileDigests[expectedRow.path]?.digest ?? null,
      classification: 'REGRESSION_COVERAGE',
      meaningChange: 'NONE',
      freshCurrentnessRequired: true,
      testEvidence: outcome ?? null,
      impactRef: PDP1_PARITY_TEST_IMPACT_PATH,
      impactRecordId: impact.recordId ?? null,
      sourceDelta: row,
    };
  });
}

export function validatePdp1SupplementalPinDispositions({
  reporterImpact = readJson(PDP3_STATUS_GUARD_IMPACT_PATH),
  adapterTestImpact = readJson(PDP1_ADAPTER_TEST_IMPACT_PATH),
  parityTestImpact = readJson(PDP1_PARITY_TEST_IMPACT_PATH),
  threeSourceTransition = readJson(PDP1_THREE_SOURCE_TRANSITION_PATH),
  statusPins = readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet,
  semanticPins = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json').sourceFingerprints,
  fileDigests = {},
  historicalDigests = readJson(HISTORICAL_PDP1_EXIT_PATH).sourceCurrentness?.sourceContentDigests ?? {},
  testRun = null,
} = {}) {
  const reporter = validateReporterImpactRecord(reporterImpact, fileDigests, historicalDigests, statusPins, semanticPins);
  const adapterTest = validateAdapterTestImpactRecord(adapterTestImpact, statusPins, semanticPins, fileDigests);
  const parityTests = validateParityTestPinImpactRecord(parityTestImpact, statusPins, semanticPins, fileDigests, historicalDigests, testRun);
  const operationParityProjectionImpact = validatePdp1OperationParityProjectionImpact(undefined, { observedDigests: fileDigests });
  const threeSource = validatePdp1ThreeSourceTransitionDisposition(threeSourceTransition, {
    observedDigests: fileDigests, historicalDigests, statusPins, semanticPins,
  });
  const reporterSuccessor = validatePdp0ReporterSuccessorImpact();
  const reporterPinDigest = (pins) => `sha256:${String(pins?.[PDP1_GUARD_PATH] ?? '').replace(/^sha256:/u, '')}`;
  const reporterAllowedPins = [reporterSuccessor.predecessorSha256, reporterSuccessor.observedSha256];
  const reporterPinsValid = reporterAllowedPins.includes(reporterPinDigest(statusPins))
    && reporterAllowedPins.includes(reporterPinDigest(semanticPins));
  return [
    { ...reporter, impactRef: PDP3_STATUS_GUARD_IMPACT_PATH, impactDigest: sha256(fs.readFileSync(path.join(root, PDP3_STATUS_GUARD_IMPACT_PATH))),
      classification: 'PDP3_STATUS_GUARD_ONLY; PDP1_NO_MEANING_CHANGE', meaningChange: 'NONE', freshCurrentnessRequired: true },
    { ...adapterTest, impactRef: PDP1_ADAPTER_TEST_IMPACT_PATH, impactDigest: sha256(fs.readFileSync(path.join(root, PDP1_ADAPTER_TEST_IMPACT_PATH))),
      classification: 'PDP3_CONSUMER_TEST_ONLY; PDP1_DEFERRED_EVIDENCE_STATUS_PIN_REFRESH_REQUIRED; NO_PDP1_DEFINITION_MEANING_CHANGE', meaningChange: 'NONE', freshCurrentnessRequired: true,
      testEvidence: adapterTestImpact.testEvidence },
    ...parityTests,
    ...PDP1_THREE_SOURCE_TRANSITION_ROWS.map((row) => ({
      valid: threeSource.valid && threeSource.rowChecks.find((entry) => entry.path === row.path)?.valid === true,
      impact: threeSourceTransition,
      path: row.path,
      predecessorSha256: row.predecessorSha256,
      observedSha256: row.observedSha256,
      classification: 'USER_AUTHORIZED_EXACT_PDP1_SOURCE_TRANSITION_NO_MEANING',
      meaningChange: 'NONE',
      note: 'Exact transition validated from R16; source-currentness recapture remains required.',
      freshCurrentnessRequired: true,
      impactRef: PDP1_THREE_SOURCE_TRANSITION_PATH,
      impactRecordId: threeSourceTransition.recordId ?? null,
      impactDigest: threeSource.recordDigest,
      validationDetails: threeSource,
    })),
    {
      valid: reporterSuccessor.valid && reporterPinsValid,
      impact: reporterSuccessor,
      path: PDP1_GUARD_PATH,
      predecessorSha256: reporterSuccessor.predecessorSha256,
      observedSha256: reporterSuccessor.observedSha256,
      classification: 'PDP0_AUTHORIZED_REPORTER_SUCCESSOR_NO_MEANING; PDP1_STATUS_SELECTION_ONLY',
      meaningChange: 'NONE',
      note: 'Exact reporter successor validated against the authorized PDP-0 R6 impact and R10 currentness proof.',
      freshCurrentnessRequired: true,
      impactRef: PDP0_REPORTER_SUCCESSOR_IMPACT_PATH,
      impactRecordId: reporterSuccessor.impact?.recordId ?? 'MEDIA-DISCOVERY-PDP0-R6-SUCCESSOR-IMPACT-2026-10-14-R1',
      impactDigest: reporterSuccessor.impactDigest,
      validationDetails: { ...reporterSuccessor, reporterPinsValid },
    },
  ];
}

export function validateCurrentCutOwnerDirections(ownerDirections, observedDigest) {
  const impactReview = ownerDirections?.predecessorImpactReviews?.find((review) => review.phase === 'PDP-1');
  const sourceChanges = impactReview?.sourceChanges ?? [];
  return observedDigest === CURRENT_CUT_OWNER_DIRECTIONS_DIGEST
    && ownerDirections.schemaVersion === 'media.discovery-current-cut-owner-directions.v2'
    && ownerDirections.decisionId === 'MEDIA-DISCOVERY-CURRENT-CUT-OWNER-2026-10-13-R2'
    && impactReview?.sourceCut === HISTORICAL_PDP1_EXIT_PATH
    && sourceChanges.length === CURRENT_CUT_PDP1_OWNER_CHANGE_PATHS.length
    && sourceChanges.every((change, index) => change.path === CURRENT_CUT_PDP1_OWNER_CHANGE_PATHS[index]);
}

export function pdp1OwnerStatusJoinObservation(observedDigests, freshMaterialSourceSetFingerprint, testRun = null, additionalSourceImpactInput = null, ownerWireImpactInput = null) {
  const historical = readJson(HISTORICAL_PDP1_EXIT_PATH);
  const currentCutPredecessor = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const currentCutPredecessorDigest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_PDP1_PREDECESSOR_PATH)));
  const currentCutPredecessorValidation = validatePdp1SourcePredecessor(
    currentCutPredecessor, CURRENT_CUT_PDP1_PREDECESSOR_PATH, currentCutPredecessorDigest,
  );
  const ownerDirections = readJson(CURRENT_CUT_OWNER_DIRECTIONS_PATH);
  const ownerDirectionsDigest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_OWNER_DIRECTIONS_PATH)));
  const impactSupplement = readJson(PDP3_STATUS_GUARD_IMPACT_PATH);
  const semanticReview = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json');
  const impactReview = ownerDirections.predecessorImpactReviews?.find((review) => review.phase === 'PDP-1');
  const historicalDigests = historical.sourceCurrentness?.sourceContentDigests ?? {};
  const sourceChanges = impactReview?.sourceChanges ?? [];
  const observedPaths = Object.keys(observedDigests).sort();
  const currentCutPredecessorDigests = currentCutPredecessor.sourceCurrentness?.sourceContentDigests ?? {};
  const predecessorPaths = Object.keys(currentCutPredecessorDigests).sort();
  const missingPaths = predecessorPaths.filter((sourcePath) => !Object.hasOwn(observedDigests, sourcePath));
  const additionalPaths = observedPaths.filter((sourcePath) => !Object.hasOwn(historicalDigests, sourcePath));
  const pathComparisons = predecessorPaths.map((sourcePath) => ({
    path: sourcePath,
    predecessorSha256: currentCutPredecessorDigests[sourcePath],
    observedSha256: observedDigests[sourcePath] ?? null,
    matches: observedDigests[sourcePath] === currentCutPredecessorDigests[sourcePath],
  }));
  const changedPaths = pathComparisons.filter((entry) => !entry.matches);
  const reviewedChanges = new Map(sourceChanges.map((change) => [change.path, change]));
  const currentImpact = readJson(CURRENT_CUT_SOURCE_IMPACT_PATH);
  const phaseStatusPins = readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet;
  const operationParityProjectionImpact = validatePdp1OperationParityProjectionImpact(undefined, {
    observedDigests,
    statusPins: phaseStatusPins,
    semanticPins: semanticReview.sourceFingerprints,
    testRun,
  });
  const statusTestImpactRecord = readJson(PDP1_STATUS_TEST_IMPACT_PATH);
  const pxd164ImpactRecord = readJson(PDP1_PXD164_IMPACT_PATH);
  const threeSourceTransitionRecord = readJson(PDP1_THREE_SOURCE_TRANSITION_PATH);
  const threeSourceTransitionReview = validatePdp1ThreeSourceTransitionDisposition(threeSourceTransitionRecord, {
    observedDigests, historicalDigests, statusPins: phaseStatusPins, semanticPins: semanticReview.sourceFingerprints,
  });
  const c22ImpactRecord = readJson(PDP1_C22_IMPACT_PATH);
  const c22ImpactReview = validatePdp1C22SemanticRepairImpact(c22ImpactRecord, {
    observedDigests, historicalDigests, statusPins: phaseStatusPins, semanticPins: semanticReview.sourceFingerprints,
  });
  const threeReviewTransitionRecord = readJson(PDP1_THREE_REVIEW_TRANSITIONS_PATH);
  const threeReviewTransitionReview = validatePdp1ThreeReviewSourceTransition(threeReviewTransitionRecord, {
    observedDigests, statusPins: phaseStatusPins, semanticPins: semanticReview.sourceFingerprints,
    operationParityProjectionImpact,
  });
  const interfaceReviewChain = validatePdp1InterfaceReviewSuccessorChain({
    observedDigests, historicalDigests, statusPins: phaseStatusPins, semanticPins: semanticReview.sourceFingerprints,
    threeReviewTransition: threeReviewTransitionReview, c22Impact: c22ImpactReview,
  });
  const ownerWireC22Chain = validatePdp1OwnerWireC22SuccessorChain({
    observedDigests, historicalDigests, statusPins: phaseStatusPins, semanticPins: semanticReview.sourceFingerprints,
    c22Impact: c22ImpactReview,
  });
  const ownerStatusJoinTestTransitionRecord = readJson(PDP1_OWNER_STATUS_JOIN_TEST_R3_PATH);
  const ownerStatusJoinTestTransitionReview = validatePdp1OwnerStatusJoinTestTransition(ownerStatusJoinTestTransitionRecord, {
    testInputDigests: testRun?.sourceBinding?.testInputContentDigests ?? {},
    recordPath: PDP1_OWNER_STATUS_JOIN_TEST_R3_PATH,
  });
  const reporterSuccessorImpact = validatePdp0ReporterSuccessorImpact();
  const currentPathFinalDigests = {
    [PDP1_GUARD_PATH]: reporterSuccessorImpact.observedSha256,
    [PDP1_INTERFACE_REVIEW_PATH]: interfaceReviewChain.currentSha256,
    [PDP1_STATUS_TEST_PATH]: threeSourceTransitionReview.rowChecks?.find((entry) => entry.path === PDP1_STATUS_TEST_PATH)?.observedSha256,
  };
  const statusTestImpactReview = validatePdp1StatusTestImpactRecord(statusTestImpactRecord, {
    observedDigests,
    historicalDigests,
    statusPins: phaseStatusPins,
    semanticPins: semanticReview.sourceFingerprints,
  });
  const pxd164ImpactReview = validatePdp1Pxd164SemanticRepairImpact(pxd164ImpactRecord, { observedDigests });
  const additionalImpact = additionalSourceImpactInput?.record ?? null;
  const additionalImpactReview = additionalImpact ? validatePdp1AdditionalSourceImpactRecord(additionalImpact, {
    impact: currentImpact,
    observedDigests,
    historicalDigests,
    statusPins: phaseStatusPins,
    semanticPins: semanticReview.sourceFingerprints,
    recordPath: additionalSourceImpactInput.path,
  }) : { valid: false, recordRef: null, recordId: null, digest: null, path: null };
  const ownerWireImpact = ownerWireImpactInput?.record ?? null;
  const ownerWireImpactReview = ownerWireImpact ? validatePdp1OwnerWireImpactRecord(ownerWireImpact, {
    observedDigests, historicalDigests, recordPath: ownerWireImpactInput.path,
  }) : { valid: false, recordRef: null, recordId: null, digest: null, path: null };
  const byCurrentImpactPath = new Map((currentImpact.sourceDeltas ?? []).map((delta) => [delta.path, delta]));
  const reporterImpact = validateReporterImpactRecord(
    impactSupplement,
    { ...observedDigests, [PDP1_GUARD_PATH]: PDP1_GUARD_OBSERVED_DIGEST },
    historicalDigests,
    { ...readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet,
      [PDP1_GUARD_PATH]: PDP1_GUARD_PREDECESSOR_DIGEST.slice('sha256:'.length) },
    { ...readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json').sourceFingerprints,
      [PDP1_GUARD_PATH]: PDP1_GUARD_PREDECESSOR_DIGEST.slice('sha256:'.length) },
  );
  const currentImpactReview = validateCurrentCutSourceImpactRecord(
    currentImpact,
    observedDigests,
    historicalDigests,
    phaseStatusPins,
    semanticReview.sourceFingerprints,
    testRun,
    additionalImpactReview,
    statusTestImpactReview,
    threeSourceTransitionReview,
    interfaceReviewChain,
  );
  const operationDeltaReview = validatePdp1OperationDefinitionDelta(
    Object.fromEntries(Object.entries(observedDigests).map(([sourcePath, digest]) => [sourcePath, { digest }])),
    historicalDigests,
    semanticReview,
  );
  const operationDeltaValid = operationDeltaReview.valid;
  const supplementValid = reporterSuccessorImpact.valid && threeSourceTransitionReview.valid
    && threeReviewTransitionReview.valid && ownerStatusJoinTestTransitionReview.valid
    && interfaceReviewChain.valid && ownerWireC22Chain.valid && operationDeltaValid
    && operationParityProjectionImpact.valid;
  const pxd163Impact = readJson(PDP1_PXD163_IMPACT_PATH);
  const pxd163ImpactValid = pxd163Impact.sourcePath === PDP1_ADDITIONAL_DEFINITION_PATHS[0]
    && pxd163Impact.predecessorSha256 === historicalDigests[PDP1_ADDITIONAL_DEFINITION_PATHS[0]]
    && pxd163Impact.observedSha256 === observedDigests[PDP1_ADDITIONAL_DEFINITION_PATHS[0]]
    && pxd163Impact.pdp0ImpactAssessment?.sourceSelector === `${PDP1_ADDITIONAL_DEFINITION_PATHS[0]}#PXD-163`
    && Array.isArray(pxd163Impact.pdp0ImpactAssessment?.meaningIdsChanged)
    && pxd163Impact.pdp0ImpactAssessment.meaningIdsChanged.length === 0
    && pxd163Impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && pxd163Impact.ownerAcceptance === 'NOT_CLAIMED'
    && pxd163Impact.independentReview === 'NOT_CLAIMED'
    && pxd163Impact.lifecycleClosure === 'NOT_ENTERED'
    && pxd163Impact.runtimeAdmission === 'NOT_ADMITTED'
    && pxd163Impact.delivery === 'BLOCKED';
  const p1Decisions = parseYaml(readText(PDP1_ADDITIONAL_DEFINITION_PATHS[1])).decisions ?? [];
  const scopedDecision = p1Decisions.filter((record) => record.id === 'media.pdp1.decision.mdc30-task-operation-result-joins');
  const handoff = parseYaml(readText(PDP1_ADDITIONAL_DEFINITION_PATHS[2])).handoffs?.pdp1ToPdp2CanonicalDomain;
  const additionalDefinitionChangesValid = pxd163ImpactValid
    && PDP1_ADDITIONAL_DEFINITION_PATHS.every((sourcePath) => historicalDigests[sourcePath]
      && observedDigests[sourcePath]
      && historicalDigests[sourcePath] !== observedDigests[sourcePath])
    && scopedDecision.length === 1
    && scopedDecision[0].state === 'OWNER_DEFINED_LOGICAL_MEANING; independent-acceptance-pending'
    && scopedDecision[0].sourceRefs?.includes(`${PDP1_ADDITIONAL_DEFINITION_PATHS[0]}#PXD-163`)
    && scopedDecision[0].pending === 'focused-source-validation; affected-PDP-2-and-PDP-3-currentness; independent-PDP-acceptance'
    && scopedDecision[0].scopeStatus === 'delegated-internal-Media-source-definition-only; no external-owner-observation-or-runtime-admission'
    && handoff?.sourcePopulations?.ownerDefinedOperations?.count === 107
    && handoff?.sourcePopulations?.ownerDefinedOperations?.source === `${PDP1_OPERATIONS_PATH}#ownerDefinedOperationContracts/records`;
  const expectedChangedPaths = new Set([
    PDP1_GUARD_PATH,
    PDP1_OPERATIONS_PATH,
    PDP1_OWNER_WIRE_PATH,
    PDP1_OPERATIONS_REVIEW_PATH,
    ...(pxd164ImpactReview.valid ? ['.product-experience/decision-log.md'] : []),
    '.product-experience/interface-parity/current-source-review.json',
    ...(operationParityProjectionImpact.valid ? ['.product-experience/interface-parity/operation-parity.yaml'] : []),
    'tests/pdp1-owner-action-wire-contracts.test.mjs',
    ...PDP1_THREE_SOURCE_TRANSITION_ROWS.map((row) => row.path),
  ]);
  const reviewedChangesValid = supplementValid
    && changedPaths.length === expectedChangedPaths.size
    && changedPaths.every((entry) => expectedChangedPaths.has(entry.path));
  const approvedChangedPaths = new Set(supplementValid ? expectedChangedPaths : []);
  const exactChangedPathSet = changedPaths.length === approvedChangedPaths.size
    && changedPaths.every((entry) => approvedChangedPaths.has(entry.path));
  const valid = historical.phase === 'PDP-1'
    && historical.phaseExit?.status === 'PASS'
    && validateCurrentCutOwnerDirections(ownerDirections, ownerDirectionsDigest)
    && DIGEST.test(freshMaterialSourceSetFingerprint ?? '')
    && predecessorPaths.length === 329
    && observedPaths.length === 329
    && changedPaths.length === expectedChangedPaths.size
    && changedPaths.every((entry) => expectedChangedPaths.has(entry.path))
    && missingPaths.length === 0
    && additionalPaths.length === 0
    && reviewedChangesValid
    && operationDeltaValid
    && c22ImpactReview.valid
    && threeSourceTransitionReview.valid
    && threeReviewTransitionReview.valid
    && ownerStatusJoinTestTransitionReview.valid
    && interfaceReviewChain.valid
    && ownerWireC22Chain.valid
    && reporterSuccessorImpact.valid
    && pxd164ImpactReview.valid
    && currentCutPredecessorValidation.valid
    && exactChangedPathSet
    && changedPaths.every((entry) => entry.matches === false);
  return {
    status: valid ? 'ACCEPTED_FOR_EXACT_CURRENT_FINGERPRINT_WITH_REVIEWED_DELTA' : 'BLOCKED_OWNER_STATUS_JOIN_MISMATCH',
    valid,
    historicalExitRef: HISTORICAL_PDP1_EXIT_PATH,
    historicalExitDigest: sha256(fs.readFileSync(path.join(root, HISTORICAL_PDP1_EXIT_PATH))),
    ownerDirectionsRef: CURRENT_CUT_OWNER_DIRECTIONS_PATH,
    ownerDirectionsDigest,
    ownerDecisionId: ownerDirections.decisionId ?? null,
    supplementalPdp1DefinitionReview: operationDeltaReview,
    c22SemanticRepairImpact: c22ImpactReview,
    threeReviewSourceTransitionDisposition: threeReviewTransitionReview,
    pxd164SemanticRepairImpact: pxd164ImpactReview,
    operationParityProjectionImpact,
    ownerStatusJoinTestTransitionDisposition: ownerStatusJoinTestTransitionReview,
    interfaceReviewSuccessorChain: interfaceReviewChain,
    ownerWireC22SuccessorChain: ownerWireC22Chain,
    predecessorMaterialSourceSetFingerprint: historical.sourceCurrentness?.materialSourceSetFingerprint ?? null,
    freshMaterialSourceSetFingerprint,
    predecessorExitRef: CURRENT_CUT_PDP1_PREDECESSOR_PATH,
    predecessorExitDigest: currentCutPredecessorDigest,
    predecessorExitValid: currentCutPredecessorValidation.valid,
    predecessorPathCount: predecessorPaths.length,
    observedPathCount: observedPaths.length,
    unchangedPathCount: pathComparisons.filter((entry) => entry.matches).length,
    ownerApprovedChangedPathCount: changedPaths.filter((entry) => approvedChangedPaths.has(entry.path)).length,
    unapprovedChangedPathCount: changedPaths.filter((entry) => !approvedChangedPaths.has(entry.path)).length,
    unapprovedChangedPaths: changedPaths.filter((entry) => !approvedChangedPaths.has(entry.path)).map((entry) => entry.path),
    missingPathCount: missingPaths.length,
    additionalPathCount: additionalPaths.length,
    meaningIdsChangedCount: operationDeltaReview.reviewedDefinitionIds.length,
    allChangesRequireFreshCurrentness: supplementValid
      && threeSourceTransitionReview.rowChecks.every((row) => row.valid)
      && reporterSuccessorImpact.valid
      && operationDeltaReview.requiresFreshCurrentness === true,
    changedPathsComparedToR16: changedPaths.map((entry) => ({
      path: entry.path,
      predecessorSha256: entry.predecessorSha256,
      observedSha256: observedDigests[entry.path] ?? null,
      approvedForExactTransition: expectedChangedPaths.has(entry.path),
    })),
    threeSourceTransitionDisposition: {
      valid: threeSourceTransitionReview.valid,
      ref: threeSourceTransitionReview.recordRef,
      recordId: threeSourceTransitionReview.recordId,
      digest: threeSourceTransitionReview.recordDigest,
      predecessorRef: threeSourceTransitionReview.predecessorRef,
      predecessorDigest: threeSourceTransitionReview.predecessorDigest,
      predecessorPathCount: threeSourceTransitionReview.predecessorPathCount,
      rows: threeSourceTransitionReview.rowChecks,
      separateOperationsDelta: {
        path: PDP1_OPERATIONS_PATH,
        reviewedMeaningIds: operationDeltaReview.reviewedDefinitionIds,
        includedInNoMeaningTransitionSet: false,
        operationDeltaValid,
      },
    },
    reporterSuccessorImpactProof: reporterSuccessorImpact,
    sourceChanges: sourceChanges.map((change) => ({
      path: change.path,
      predecessorSha256: historicalDigests[change.path] ?? null,
      ownerReviewedSha256: change.observedSha256,
      observedSha256: observedDigests[change.path] ?? null,
      meaningIdsChangedAtReviewedCut: change.meaningIdsChangedAtReviewedCut ?? [],
      requiresFreshCurrentness: change.requiresFreshCurrentness === true,
      matches: historicalDigests[change.path] === change.recordedSha256
        && observedDigests[change.path] === change.observedSha256,
    })).concat(
      ...CURRENT_CUT_SOURCE_PATHS.map((sourcePath) => {
        const delta = byCurrentImpactPath.get(sourcePath);
        const statusTestCorrection = sourcePath === PDP1_STATUS_TEST_PATH && statusTestImpactReview.valid;
        return {
          path: sourcePath,
          predecessorSha256: historicalDigests[sourcePath] ?? null,
          ownerReviewedSha256: currentPathFinalDigests[sourcePath] ?? delta?.observedSha256 ?? null,
          observedSha256: observedDigests[sourcePath] ?? null,
          meaningIdsChangedAtReviewedCut: statusTestCorrection
            ? statusTestImpactRecord.sourceDelta.meaningIdsChanged : delta?.meaningIdsChanged ?? delta?.additionalMeaningIds ?? [],
          classification: statusTestCorrection ? statusTestImpactRecord.sourceDelta.classification : delta?.classification ?? null,
          requiresFreshCurrentness: statusTestCorrection
            ? statusTestImpactRecord.sourceDelta.requiresFreshCurrentness === true : delta?.requiresFreshCurrentness === true,
          matches: statusTestCorrection
            ? historicalDigests[sourcePath] === delta?.predecessorSha256
              && statusTestImpactReview.predecessorSha256 === delta?.observedSha256
              && threeSourceTransitionReview?.valid === true
              && currentPathFinalDigests[sourcePath] === observedDigests[sourcePath]
            : sourcePath === PDP1_INTERFACE_REVIEW_PATH
              ? interfaceReviewChain?.valid === true && currentPathFinalDigests[PDP1_INTERFACE_REVIEW_PATH] === observedDigests[sourcePath]
                && `sha256:${String(phaseStatusPins[sourcePath] ?? '').replace(/^sha256:/u, '')}` === currentPathFinalDigests[sourcePath]
                && `sha256:${String(semanticReview.sourceFingerprints[sourcePath] ?? '').replace(/^sha256:/u, '')}` === currentPathFinalDigests[sourcePath]
              : sourcePath === PDP1_GUARD_PATH
                ? reporterSuccessorImpact.valid && currentPathFinalDigests[sourcePath] === observedDigests[sourcePath]
                : historicalDigests[sourcePath] === delta?.predecessorSha256
                  && observedDigests[sourcePath] === delta?.observedSha256,
          impactRef: statusTestCorrection ? PDP1_STATUS_TEST_IMPACT_PATH : CURRENT_CUT_SOURCE_IMPACT_PATH,
          authorityRef: statusTestCorrection ? 'DIRECT_USER_REPLY_IN_CURRENT_TASK' : currentImpact.authority?.authorityRef ?? null,
          independentApproval: currentImpact.decision?.independentApproval ?? null,
        };
      }),
      {
        path: PDP1_OPERATIONS_PATH,
        predecessorSha256: historicalDigests[PDP1_OPERATIONS_PATH] ?? null,
        ownerReviewedSha256: operationDeltaReview.observedSha256,
        observedSha256: observedDigests[PDP1_OPERATIONS_PATH] ?? null,
          meaningIdsChangedAtReviewedCut: operationDeltaReview.reviewedDefinitionIds,
        reviewedDefinitionIds: operationDeltaReview.reviewedDefinitionIds,
        classification: operationDeltaReview.classification,
        requiresFreshCurrentness: operationDeltaReview.requiresFreshCurrentness,
        matches: operationDeltaValid && historicalDigests[PDP1_OPERATIONS_PATH] === operationDeltaReview.predecessorSha256
          && observedDigests[PDP1_OPERATIONS_PATH] === operationDeltaReview.observedSha256,
        authority: 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION_FOR_INTERNAL_DEFINITION_REVIEW',
        independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
        externalContractOwnerAcceptance: 'NOT_CLAIMED',
      },
      {
        path: PDP1_OPERATIONS_REVIEW_PATH,
        predecessorSha256: historicalDigests[PDP1_OPERATIONS_REVIEW_PATH] ?? null,
        ownerReviewedSha256: operationDeltaReview.reviewArtifactObservedSha256,
        observedSha256: observedDigests[PDP1_OPERATIONS_REVIEW_PATH] ?? null,
        meaningIdsChangedAtReviewedCut: [],
        classification: 'PDP1_SEMANTIC_REVIEW_ARTIFACT_REFRESH',
        requiresFreshCurrentness: true,
        matches: operationDeltaValid && historicalDigests[PDP1_OPERATIONS_REVIEW_PATH] === operationDeltaReview.reviewArtifactPredecessorSha256
          && observedDigests[PDP1_OPERATIONS_REVIEW_PATH] === operationDeltaReview.reviewArtifactObservedSha256,
        authority: 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION_FOR_INTERNAL_DEFINITION_REVIEW',
        independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
        externalContractOwnerAcceptance: 'NOT_CLAIMED',
      },
      {
        path: PDP1_OWNER_WIRE_PATH,
        predecessorSha256: PDP1_C22_OWNER_WIRE_PREDECESSOR_DIGEST,
        ownerReviewedSha256: PDP1_C22_OWNER_WIRE_DIGEST,
        observedSha256: observedDigests[PDP1_OWNER_WIRE_PATH] ?? null,
        meaningIdsChangedAtReviewedCut: ['PXD-163/MDC30-C-22'],
        classification: 'PXD163_MDC30_C22_SEMANTIC_REPAIR',
        requiresFreshCurrentness: true,
        matches: c22ImpactReview.valid,
        impactRef: PDP1_C22_IMPACT_PATH,
        impactDigest: c22ImpactReview.digest,
        externalOwnerAcceptance: 'NOT_CLAIMED',
        independentSpecialistAcceptance: 'NOT_CLAIMED',
      },
    ),
    supplementalImpactReviewRef: CURRENT_CUT_SOURCE_IMPACT_PATH,
    supplementalImpactReviewDigest: currentImpactReview.impactDigest,
    predecessorReporterImpactRef: PDP3_STATUS_GUARD_IMPACT_PATH,
    predecessorReporterImpactDigest: sha256(fs.readFileSync(path.join(root, PDP3_STATUS_GUARD_IMPACT_PATH))),
    currentCutSourceImpactReview: currentImpactReview,
    c22SemanticRepairImpact: c22ImpactReview,
    additionalSourceImpactDisposition: additionalImpact ? {
      valid: additionalImpactReview.valid,
      ref: additionalImpactReview.recordRef,
      recordId: additionalImpactReview.recordId,
      digest: additionalImpactReview.digest,
      path: additionalImpactReview.path,
      predecessorSha256: additionalImpactReview.predecessorSha256,
      observedSha256: additionalImpactReview.observedSha256,
      ownerAcceptance: 'NOT_CLAIMED',
      independentReview: 'NOT_CLAIMED',
    } : null,
    ownerWireSourceImpactDisposition: ownerWireImpact ? {
      valid: ownerWireImpactReview.valid,
      ref: ownerWireImpactReview.recordRef,
      recordId: ownerWireImpactReview.recordId,
      digest: ownerWireImpactReview.digest,
      path: ownerWireImpactReview.path,
      predecessorSha256: ownerWireImpactReview.predecessorSha256,
      observedSha256: ownerWireImpactReview.observedSha256,
      ownerAcceptance: 'NOT_CLAIMED',
      independentAcceptance: 'NOT_CLAIMED',
    } : null,
    statusTestSourceImpactDisposition: {
      valid: statusTestImpactReview.valid,
      ref: statusTestImpactReview.recordRef,
      recordId: statusTestImpactReview.recordId,
      digest: statusTestImpactReview.digest,
      path: statusTestImpactReview.path,
      predecessorSha256: statusTestImpactReview.predecessorSha256,
      observedSha256: statusTestImpactReview.observedSha256,
      ownerAcceptance: 'NOT_CLAIMED',
      independentAcceptance: 'NOT_CLAIMED',
    },
    testEvidence: currentImpactReview.testEvidenceValid ? {
      command: CURRENT_CUT_PDP1_TEST_COMMAND,
      status: 'PASS',
      testCount: (testRun?.outcomes ?? testRun?.testOutcomes)?.find((entry) => entry.command === CURRENT_CUT_PDP1_TEST_COMMAND)?.testCount ?? null,
      passedCount: (testRun?.outcomes ?? testRun?.testOutcomes)?.find((entry) => entry.command === CURRENT_CUT_PDP1_TEST_COMMAND)?.passedCount ?? null,
      failedCount: (testRun?.outcomes ?? testRun?.testOutcomes)?.find((entry) => entry.command === CURRENT_CUT_PDP1_TEST_COMMAND)?.failedCount ?? null,
      skippedCount: (testRun?.outcomes ?? testRun?.testOutcomes)?.find((entry) => entry.command === CURRENT_CUT_PDP1_TEST_COMMAND)?.skippedCount ?? null,
    } : { status: 'MISSING_OR_INVALID' },
    limitation: 'Scoped internal owner materiality join for the exact reviewed delta; it is not exact-cut owner acceptance, independent approval, lifecycle closure, or release qualification.',
  };
}

function trackedPathSet() {
  const tracked = git(['ls-files', '-z']).split('\0');
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  return new Set([...tracked, ...untracked].filter(Boolean));
}

function expandRef(ref, availablePaths) {
  const repoPath = ref.split('#', 1)[0].replace(/\/+$/u, '');
  if (availablePaths.has(repoPath)) return [repoPath];
  const prefix = `${repoPath}/`;
  return [...availablePaths].filter((candidate) => candidate.startsWith(prefix)).sort();
}

function indexUnique(rows, name) {
  const result = new Map();
  for (const row of rows) {
    if (!row || typeof row.surfaceId !== 'string' || result.has(row.surfaceId)) {
      throw new TypeError(`Missing or duplicate ${name} identity`);
    }
    result.set(row.surfaceId, row);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateMatrixAndTopology(matrix, topology, registry, census, domainObjects, operationDefinitions) {
  const p1 = matrix.cells.filter((cell) => cell.phase === 'PDP-1');
  const physical = indexUnique(topology.manifestCandidates, 'physical candidate');
  const compositions = indexUnique(topology.compositions, 'composition');
  const consumers = indexUnique(topology.consumerCrosswalk, 'consumer');
  const registrySurfaces = indexUnique(registry.surfaces, 'surface registry');
  const canonicalDomainObjectIds = new Set((domainObjects.objects ?? []).map((object) => object.id));
  const canonicalOperationIds = new Set([
    ...(operationDefinitions.operations ?? []).flatMap((operation) => [operation.id, operation.operationId]),
    ...((operationDefinitions.ownerDefinedOperationContracts?.records ?? []).flatMap((operation) => [operation.id, operation.operationId])),
    operationDefinitions.ownerDefinedTtsRequestOriginContract?.id,
  ].filter(Boolean));
  const rows = indexUnique(p1, 'PDP-1 cell');
  const errors = [];

  if (p1.length !== 50 || rows.size !== 50 || matrix.denominators?.phaseReviewCells !== 200) {
    errors.push('PDP1_MATRIX_DENOMINATOR_MISMATCH');
  }
  if (physical.size !== 26 || compositions.size !== 7 || consumers.size !== 17
      || [...compositions.values()].filter((row) => row.kind === 'SEMANTIC_COMPOSITION').length !== 6
      || [...compositions.values()].filter((row) => row.kind === 'REPOSITORY_ROOT').length !== 1) {
    errors.push('LIVE_TOPOLOGY_DENOMINATOR_MISMATCH');
  }

  for (const [surfaceId, source] of physical) {
    const cell = rows.get(surfaceId);
    const applicability = source.phaseApplicability?.['PDP-1'];
    if (!cell || cell.surfaceKind !== 'PHYSICAL_CANDIDATE'
        || cell.owner !== source.owner || cell.physicalDisposition !== source.disposition
        || cell.phaseApplicabilityDisposition !== applicability?.disposition
        || cell.phaseApplicabilityRationale !== applicability?.rationale) {
      errors.push(`PHYSICAL_CELL_TOPOLOGY_MISMATCH:${surfaceId}`);
      continue;
    }
    for (const reference of [applicability.authorityRef, applicability.operationAuthorityRef].filter(Boolean)) {
      if (!cell.inspectWhere.some((entry) => entry.includes(reference))
          || !cell.parentSourceAuthorityRefs.includes(reference)) {
        errors.push(`PHYSICAL_CANONICAL_AUTHORITY_REFERENCE_MISSING:${surfaceId}:${reference}`);
      }
    }
    for (const id of applicability.domainObjectIds ?? []) {
      if (!canonicalDomainObjectIds.has(id)) {
        errors.push(`PHYSICAL_DOMAIN_IDENTITY_MISSING:${surfaceId}:${id}`);
      }
    }
    for (const id of applicability.operationIds ?? []) {
      if (!canonicalOperationIds.has(id)) errors.push(`PHYSICAL_OPERATION_IDENTITY_MISSING:${surfaceId}:${id}`);
    }
  }

  for (const [surfaceId, source] of compositions) {
    const cell = rows.get(surfaceId);
    const applicability = source.phaseApplicability?.['PDP-1'];
    const expectedKind = source.kind === 'REPOSITORY_ROOT' ? 'REPOSITORY_ROOT' : 'SEMANTIC_COMPOSITION';
    if (!cell || cell.surfaceKind !== expectedKind || cell.owner !== source.canonicalOwner
        || cell.phaseApplicabilityDisposition !== applicability?.disposition
        || cell.phaseApplicabilityRationale !== applicability?.rationale) {
      errors.push(`COMPOSITION_CELL_TOPOLOGY_MISMATCH:${surfaceId}`);
      continue;
    }
    if (!cell.parentSourceAuthorityRefs.includes('.product-experience/pdp-1-domain-data/domain-objects.yaml')) {
      errors.push(`COMPOSITION_DOMAIN_AUTHORITY_MISSING:${surfaceId}`);
    }
    if (source.kind === 'SEMANTIC_COMPOSITION'
        && !cell.parentSourceAuthorityRefs.includes('.product-experience/pdp-1-domain-data/operations.yaml')) {
      errors.push(`COMPOSITION_OPERATION_AUTHORITY_MISSING:${surfaceId}`);
    }
    for (const id of applicability.domainObjectIds ?? []) {
      if (!canonicalDomainObjectIds.has(id)) {
        errors.push(`COMPOSITION_DOMAIN_IDENTITY_MISSING:${surfaceId}:${id}`);
      }
    }
    for (const id of applicability.operationIds ?? []) {
      if (!canonicalOperationIds.has(id)) errors.push(`COMPOSITION_OPERATION_IDENTITY_MISSING:${surfaceId}:${id}`);
    }
  }

  for (const [surfaceId, source] of consumers) {
    const cell = rows.get(surfaceId);
    const registered = registrySurfaces.get(surfaceId);
    const p1Applicable = registered?.applicablePdpArtifacts?.includes('PDP-1') === true;
    const expectedDisposition = p1Applicable ? 'APPLICABLE_CONSUMER_BINDING' : 'NOT_APPLICABLE_ARCHIVED';
    const expectedReason = source.statusReason ?? registered?.applicabilityRationale;
    if (!cell || cell.surfaceKind !== 'CONSUMER_BINDING' || !registered
        || JSON.stringify(cell.consumerCrosswalkRefs?.slice().sort()) !== JSON.stringify([...(source.physicalRefs ?? [])].sort())
        || JSON.stringify(cell.owner) !== JSON.stringify(registered.owners)
        || cell.phaseApplicabilityDisposition !== expectedDisposition
        || cell.phaseApplicabilityRationale !== expectedReason
        || !cell.inspectWhere.includes(source.registryAuthority ?? '.product-experience/surface-registry.yaml')
        || !cell.inspectWhere.includes('.product-experience/surfaces/media-physical-topology.v1.json')) {
      errors.push(`CONSUMER_BINDING_MISMATCH:${surfaceId}`);
    }
    if (!p1Applicable && surfaceId !== 'media.surface.desktop-archive') {
      errors.push(`UNJUSTIFIED_PDP1_CONSUMER_NA:${surfaceId}`);
    }
  }

  const expectedIds = new Set([...physical.keys(), ...compositions.keys(), ...consumers.keys()]);
  if (expectedIds.size !== rows.size || [...expectedIds].some((surfaceId) => !rows.has(surfaceId))) {
    errors.push('PDP1_MATRIX_TOPOLOGY_ID_SET_MISMATCH');
  }
  return { cells: p1, errors };
}

function buildCellPaths(matrixCells, topology, availablePaths) {
  const physical = new Map(topology.manifestCandidates.map((row) => [row.surfaceId, row]));
  const compositions = new Map(topology.compositions.map((row) => [row.surfaceId, row]));
  const consumers = new Map(topology.consumerCrosswalk.map((row) => [row.surfaceId, row]));
  const cellsBySurface = new Map(matrixCells.map((cell) => [cell.surfaceId, cell]));
  const memo = new Map();

  const refsFor = (cell, seen = new Set()) => {
    if (memo.has(cell.surfaceId)) return memo.get(cell.surfaceId);
    if (seen.has(cell.surfaceId)) throw new TypeError(`Cycle in PDP-1 source membership at ${cell.surfaceId}`);
    seen.add(cell.surfaceId);
    const refs = [...COMMON_PDP1_REFS, ...cell.inspectWhere];
    if (consumers.has(cell.surfaceId)) {
      for (const physicalId of consumers.get(cell.surfaceId).physicalRefs ?? []) {
        const physicalCell = cellsBySurface.get(physicalId);
        if (physicalCell) refs.push(...refsFor(physicalCell, seen));
      }
    }
    const composition = compositions.get(cell.surfaceId);
    if (composition) {
      for (const childId of composition.children ?? []) {
        const child = cellsBySurface.get(childId);
        if (child) refs.push(...refsFor(child, seen));
      }
    }
    if (cell.surfaceKind === 'REPOSITORY_ROOT') {
      for (const child of matrixCells.filter((candidate) => candidate.surfaceKind === 'CONSUMER_BINDING')) {
        refs.push(...refsFor(child, seen));
      }
    }
    seen.delete(cell.surfaceId);
    const paths = [...new Set(refs.flatMap((reference) => expandRef(reference, availablePaths)))].sort();
    memo.set(cell.surfaceId, paths);
    return paths;
  };

  return matrixCells.map((cell) => ({
    cellId: `${cell.surfaceId}:PDP-1`,
    surfaceId: cell.surfaceId,
    phase: 'PDP-1',
    cellType: cell.surfaceKind,
    owner: cell.owner,
    applicability: {
      disposition: cell.phaseApplicabilityDisposition,
      rationale: cell.phaseApplicabilityRationale,
      authorityRefs: cell.parentSourceAuthorityRefs ?? [],
      consumerCrosswalkRefs: cell.consumerCrosswalkRefs ?? [],
    },
    paths: refsFor(cell),
    predecessorPhase: 'PDP-0',
  }));
}

function externalContractObservation(sourceManifestSha, predecessorCurrentness) {
  const currentness = predecessorCurrentness;
  const blockers = [];
  const sourceManifestPath = '.product-experience/source-manifest.yaml';
  const sourceManifestWasCurrentAtP0 = currentness?.sourceContentDigests?.[sourceManifestPath] === sourceManifestSha;
  if (!sourceManifestWasCurrentAtP0) blockers.push('SOURCE_MANIFEST_CHANGED_AFTER_PDP0_EXIT');
  const current = (currentness?.externalOwnerContracts?.repositories ?? []).map((repository) => {
    const externalRoot = path.resolve(root, SOURCE_ROOTS[repository.repositoryId] ?? '');
    return {
      repositoryId: repository.repositoryId,
      recordedRevision: repository.recordedRevision,
      files: repository.files.map((file) => {
        const absolutePath = path.join(externalRoot, ...file.path.split('/'));
        let observedContentSha256 = null;
        try {
          if (fs.statSync(absolutePath).isFile()) observedContentSha256 = sha256(fs.readFileSync(absolutePath));
        } catch {}
        return {
          path: file.path,
          declaredContentSha256: file.declaredContentSha256,
          observedContentSha256,
          digestMatches: observedContentSha256 === file.declaredContentSha256,
        };
      }),
    };
  });
  const files = current.flatMap((repository) => repository.files);
  const digestMismatches = files.filter((file) => !file.digestMatches);
  if (files.length !== 30 || digestMismatches.length) blockers.push('EXTERNAL_OWNER_CONTRACT_DIGESTS_NOT_CURRENT');
  return {
    totalFiles: files.length,
    digestMatches: files.length - digestMismatches.length,
    digestMismatches,
    repositories: current,
    providerRegistryFingerprint: currentness?.externalOwnerContracts?.providerRegistryFingerprint ?? null,
    sourceManifestCurrentAtPdp0Predecessor: sourceManifestWasCurrentAtP0,
    blockers,
  };
}

function phasePinReview(status, semanticReview, mdc10, fileDigests, testRun) {
  const staleStatusPins = Object.entries(status.sourceShaSet ?? {})
    .filter(([sourcePath, recorded]) => fileDigests[sourcePath]?.digest !== `sha256:${recorded.replace(/^sha256:/u, '')}`)
    .map(([sourcePath, recorded]) => ({
      path: sourcePath,
      historicalSha256: `sha256:${recorded.replace(/^sha256:/u, '')}`,
      currentSha256: fileDigests[sourcePath]?.digest ?? null,
    }));
  const staleSemanticPins = Object.entries(semanticReview.sourceFingerprints ?? {})
    .filter(([sourcePath, recorded]) => fileDigests[sourcePath]?.digest !== `sha256:${recorded.replace(/^sha256:/u, '')}`)
    .map(([sourcePath, recorded]) => ({
      path: sourcePath,
      historicalSha256: `sha256:${recorded.replace(/^sha256:/u, '')}`,
      currentSha256: fileDigests[sourcePath]?.digest ?? null,
    }));
  const allowedClassifications = new Set([
    'DOCUMENTATION_STATUS_ONLY',
    'VALIDATION_LOGIC_CLASSIFICATION',
    'REGRESSION_COVERAGE',
  ]);
  const rawDispositions = new Map((mdc10.historicalPdp1PinChanges?.changes ?? []).map((entry) => [entry.path, entry]));
  const p1TestEvidence = (testRun?.testOutcomes ?? []).find((outcome) => outcome.command === REQUIRED_TEST_COMMAND);
  const historicalDigests = readJson(HISTORICAL_PDP1_EXIT_PATH).sourceCurrentness?.sourceContentDigests ?? {};
  const supplementalPinDispositions = validatePdp1SupplementalPinDispositions({
    reporterImpact: readJson(PDP3_STATUS_GUARD_IMPACT_PATH),
    adapterTestImpact: readJson(PDP1_ADAPTER_TEST_IMPACT_PATH),
    parityTestImpact: readJson(PDP1_PARITY_TEST_IMPACT_PATH),
    statusPins: status.sourceShaSet ?? {},
    semanticPins: semanticReview.sourceFingerprints ?? {},
    fileDigests,
    historicalDigests,
    testRun,
  });
  supplementalPinDispositions.push(...validatePdp1Pxd164SupplementalPinDispositions({
    record: readJson(PDP1_PXD164_IMPACT_PATH),
    statusPins: status.sourceShaSet ?? {},
    semanticPins: semanticReview.sourceFingerprints ?? {},
    fileDigests,
  }));
  const operationParityProjectionImpact = validatePdp1OperationParityProjectionImpact(undefined, { observedDigests: fileDigests, testRun });
  const operationParityImpactRecord = readJson(PDP1_OPERATION_PARITY_SUCCESSOR_IMPACT_PATH);
  for (const rowCheck of operationParityProjectionImpact.rowChecks) {
    const row = operationParityImpactRecord.sourceDeltas.find((entry) => entry.path === rowCheck.path);
    supplementalPinDispositions.push({
      valid: operationParityProjectionImpact.valid && rowCheck.valid,
      impact: operationParityImpactRecord,
      path: rowCheck.path,
      predecessorSha256: rowCheck.predecessorSha256,
      observedSha256: rowCheck.observedSha256,
      classification: row.classification,
      meaningChange: row.pdp1MeaningDisposition,
      note: 'Exact R19-to-live PDP-1 currentness successor impact; no owner or independent acceptance is claimed.',
      freshCurrentnessRequired: true,
      impactRef: PDP1_OPERATION_PARITY_SUCCESSOR_IMPACT_PATH,
      impactRecordId: operationParityProjectionImpact.recordId,
      impactDigest: operationParityProjectionImpact.recordDigest,
      testEvidence: row.path === 'tests/pdp1-interface-current-source-review.test.mjs' ? operationParityProjectionImpact.testOutcome : null,
      validationDetails: operationParityProjectionImpact,
    });
  }
  const validSupplementalDispositions = new Map(supplementalPinDispositions
    .filter((entry) => entry.valid)
    .map((entry) => [entry.path, entry]));
  const semanticDefinitionDelta = validatePdp1OperationDefinitionDelta(fileDigests, historicalDigests, semanticReview);
  const semanticDefinitionDispositions = new Map([PDP1_OPERATIONS_PATH, PDP1_OPERATIONS_REVIEW_PATH]
    .map((sourcePath) => [sourcePath, pdp1SemanticDefinitionPinDisposition(sourcePath, semanticDefinitionDelta)])
    .filter(([, disposition]) => disposition !== null));
  const isNonMeaningDisposition = (entry) => entry
    && allowedClassifications.has(entry.classification)
    && ['NONE', 'NONE_IDENTIFIED'].includes(entry.meaningChange)
    && (typeof entry.note === 'string' && entry.note.trim().length > 0
      || entry.classification === 'REGRESSION_COVERAGE'
        && p1TestEvidence?.status === 'PASS' && p1TestEvidence.exitCode === 0
        && p1TestEvidence.testCount > 0 && p1TestEvidence.skippedCount === 0);
  const dispositions = new Map([...rawDispositions].filter(([, entry]) => isNonMeaningDisposition(entry)));
  const hasDisposition = (sourcePath) => dispositions.has(sourcePath)
    || validSupplementalDispositions.has(sourcePath)
    || semanticDefinitionDispositions.has(sourcePath);
  const unclassifiedStatusPins = staleStatusPins.filter((entry) => !hasDisposition(entry.path));
  const unclassifiedSemanticPins = staleSemanticPins.filter((entry) => !hasDisposition(entry.path));
  const pinChangeDisposition = (entry) => {
    const supplemental = validSupplementalDispositions.get(entry.path);
    const semanticDefinition = semanticDefinitionDispositions.get(entry.path);
    const ordinary = dispositions.get(entry.path);
    return semanticDefinition ? {
      classification: semanticDefinition.classification,
      meaningChange: semanticDefinition.meaningChange,
      note: semanticDefinition.note,
      sourceReviewPath: semanticDefinition.sourceReviewPath,
      requiresFreshCurrentness: semanticDefinition.requiresFreshCurrentness,
      externalContractOwnerAcceptance: 'NOT_CLAIMED',
      independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
    } : supplemental ? pdp1SupplementalPinChangeDisposition(supplemental) : {
      classification: ordinary?.classification ?? 'UNCLASSIFIED',
      meaningChange: ordinary?.meaningChange ?? 'UNCLASSIFIED',
      note: ordinary?.note ?? (ordinary?.classification === 'REGRESSION_COVERAGE' ? `Test-only source; verified by the source-bound ${p1TestEvidence?.testCount ?? 0}-case PDP-1 suite with zero skips.` : null),
    };
  };
  return {
    historicalStatusPinCount: Object.keys(status.sourceShaSet ?? {}).length,
    historicalStatusCurrentPinCount: Object.keys(status.sourceShaSet ?? {}).length - staleStatusPins.length,
    historicalStatusChangedPinCount: staleStatusPins.length,
    historicalStatusMissingPinCount: staleStatusPins.filter((entry) => entry.currentSha256 === null).length,
    historicalSemanticReviewPinCount: Object.keys(semanticReview.sourceFingerprints ?? {}).length,
    historicalSemanticReviewCurrentPinCount: Object.keys(semanticReview.sourceFingerprints ?? {}).length - staleSemanticPins.length,
    historicalSemanticReviewChangedPinCount: staleSemanticPins.length,
    statusPinChanges: staleStatusPins.map((entry) => ({ ...entry, ...pinChangeDisposition(entry) })),
    semanticReviewPinChanges: staleSemanticPins.map((entry) => ({ ...entry, ...pinChangeDisposition(entry) })),
    invalidDispositionPaths: [
      ...[...rawDispositions].filter(([, entry]) => !isNonMeaningDisposition(entry)).map(([sourcePath]) => sourcePath),
      ...supplementalPinDispositions.filter((entry) => !entry.valid).map((entry) => entry.path),
      ...(!semanticDefinitionDelta.valid ? [PDP1_OPERATIONS_PATH] : []),
    ],
    dispositionObservationDigest: sha256(readText('docs/implementation/observations/media-discovery-pdp1-mdc10-contract-parity-2026-10-13-r1.json')),
    supplementalPinDispositions,
    semanticDefinitionDeltaReview: semanticDefinitionDelta,
    unclassifiedStatusPins,
    unclassifiedSemanticPins,
    continuityDecision: unclassifiedStatusPins.length === 0 && unclassifiedSemanticPins.length === 0
      ? 'CARRY_FORWARD_PRIOR_IDENTITY_REVIEW_WITH_EXACT_PDP1_SEMANTIC_DELTA_AND_TEST_DISPOSITIONS'
      : 'BLOCKED_UNCLASSIFIED_HISTORICAL_PIN_CHANGES',
  };
}

export function pdp1SupplementalPinChangeDisposition(supplemental) {
  return {
    classification: supplemental.classification,
    meaningChange: supplemental.meaningChange,
    meaningIdsChanged: supplemental.meaningIdsChanged ?? supplemental.sourceDelta?.meaningIdsChanged ?? [],
    note: supplemental.note ?? supplemental.impact.sourceDelta?.changeSummary ?? supplemental.impact.sourceDelta?.classification ?? null,
    supplementalImpactRef: supplemental.impactRef,
    supplementalImpactRecordId: supplemental.impact.recordId,
    requiresFreshCurrentness: supplemental.freshCurrentnessRequired,
  };
}

function summarizeCapture(capture) {
  return {
    status: capture?.status ?? 'UNKNOWN',
    continuity: capture?.journal?.continuity ?? 'UNKNOWN',
    membershipChangeState: capture?.journal?.membershipChangeState ?? 'UNKNOWN',
    additions: capture?.journal?.membershipAdditions?.length ?? null,
    removals: capture?.journal?.membershipRemovals?.length ?? null,
    changedPaths: capture?.journal?.changedPaths?.length ?? null,
    externalChanges: capture?.journal?.externalChanges?.length ?? null,
    snapshotScope: capture?.metrics?.snapshotScope ?? 'UNKNOWN',
  };
}

function captureIsStable(capture) {
  return isRepositorySourceCurrentness(capture)
    && capture.journal?.continuity === 'CONTINUOUS'
    && capture.journal?.membershipChangeState === 'KNOWN'
    && capture.journal?.membershipAdditions?.length === 0
    && capture.journal?.membershipRemovals?.length === 0
    && capture.journal?.changedPaths?.length === 0
    && capture.journal?.externalChanges?.length === 0
    && capture.metrics?.snapshotScope === 'REPOSITORY_SCOPE';
}

function delegatedOwnerDirectionObservation() {
  const decisionPath = '.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md';
  const decision = readText(decisionPath);
  const p1Line = decision.split('\n').find((line) => line.includes('`MEDIA-OWN-P1`')) ?? '';
  const approved = decision.includes('**Decision ID:** `MEDIA-DISCOVERY-OWNER-AUTHORIZATION-2026-10-13`')
    && p1Line.includes('**APPROVE DESIGN DIRECTION**')
    && p1Line.includes('No new PDP-1 currentness')
    && p1Line.includes('passed tests');
  return {
    decisionId: 'MEDIA-DISCOVERY-OWNER-AUTHORIZATION-2026-10-13',
    decisionRef: `${decisionPath}#MEDIA-OWN-P1`,
    sourceSha256: sha256(decision),
    status: approved ? 'APPROVED_DESIGN_DIRECTION' : 'MISSING_OR_CONTRADICTORY_DECISION',
    sourceRow: p1Line,
    explicitLimits: ['NO_NEW_PDP1_CURRENTNESS', 'NO_RUNTIME_PARITY', 'NO_DEPLOYED_HOST', 'NO_TRANSPORT_OWNER_ACCEPTANCE', 'NO_PASSED_TESTS'],
  };
}

export function validatePdp1SourcePredecessor(predecessor, predecessorPath, predecessorDigest) {
  const cells = predecessor?.sourceCurrentness?.cells ?? [];
  const cellIds = new Set(cells.map((cell) => cell.cellId));
  const fingerprint = predecessor?.sourceCurrentness?.materialSourceSetFingerprint;
  const recordedPredecessor = readJson(CURRENT_CUT_PDP1_PREDECESSOR_PATH);
  const valid = predecessorPath === CURRENT_CUT_PDP1_PREDECESSOR_PATH
    && predecessorDigest === CURRENT_CUT_PDP1_PREDECESSOR_DIGEST
    && predecessorDigest === sha256(fs.readFileSync(path.join(root, CURRENT_CUT_PDP1_PREDECESSOR_PATH)))
    && JSON.stringify(predecessor) === JSON.stringify(recordedPredecessor)
    && predecessor?.schemaVersion === 'media.discovery-pdp1-currentness-observation.v1'
    && predecessor?.observationId === 'MEDIA-PDP1-CURRENTNESS-CURRENT-CUT-R16'
    && predecessor?.phase === 'PDP-1'
    && predecessor?.sourceCurrentness?.status === 'PASS'
    && DIGEST.test(fingerprint ?? '')
    && cells.length === 50 && cellIds.size === 50
    && cells.every((cell) => cell.cellId?.endsWith(':PDP-1')
      && cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0
      && DIGEST.test(cell.sourceSetFingerprint ?? '') && DIGEST.test(cell.expectedPathSetFingerprint ?? ''));
  return {
    valid,
    predecessorRef: predecessorPath,
    predecessorDigest,
    materialSourceSetFingerprint: fingerprint ?? null,
    cellCount: cells.length,
    uniqueCellCount: cellIds.size,
  };
}

export function validatePdp0Predecessor(p0Exit, p0ExitPath, p0Digest, p0Currentness, p0CurrentnessPath, p0CurrentnessDigest, matrixCutMatches, expectedP0ExitPath = CURRENT_CUT_PDP0_SUCCESSOR_PATH) {
  void matrixCutMatches;
  void expectedP0ExitPath;
  // The matrix is the authority for which PDP-0 receipt may precede a PDP-1
  // capture. Do not let the caller select a receipt by supplying matching
  // objects or a boolean assertion; resolve and verify the exact current cut.
  const matrix = readJson('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
  const authoritativeExitPath = matrix.currentCut?.phaseExit;
  const authoritativeCurrentnessPath = matrix.currentCut?.currentnessObservation;
  const safeObservationRef = (ref) => typeof ref === 'string'
    && !path.isAbsolute(ref) && !ref.startsWith('../') && !ref.includes('\\')
    && ref.startsWith('docs/implementation/observations/media-discovery-pdp0-')
    && path.relative(root, path.resolve(root, ref)).split(path.sep).join('/') === ref;
  const safeReceiptRefs = safeObservationRef(authoritativeExitPath) && safeObservationRef(authoritativeCurrentnessPath);
  const onDiskExit = safeReceiptRefs ? readJson(authoritativeExitPath) : null;
  const onDiskCurrentness = safeReceiptRefs ? readJson(authoritativeCurrentnessPath) : null;
  const onDiskExitDigest = safeReceiptRefs && fs.existsSync(path.join(root, authoritativeExitPath))
    ? sha256(fs.readFileSync(path.join(root, authoritativeExitPath))) : null;
  const onDiskCurrentnessDigest = safeReceiptRefs && fs.existsSync(path.join(root, authoritativeCurrentnessPath))
    ? sha256(fs.readFileSync(path.join(root, authoritativeCurrentnessPath))) : null;
  const r12ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json';
  const r12CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json';
  const r12ImpactPath = 'docs/implementation/observations/media-discovery-pdp0-r11-successor-impact-2026-10-14-r1.json';
  const r11ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r11.json';
  const r11CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r11.json';
  const r12Selected = authoritativeExitPath === r12ExitPath
    && authoritativeCurrentnessPath === r12CurrentnessPath;
  const r12ReceiptDigestsBound = !r12Selected
    || (onDiskExitDigest === 'sha256:91aeae0aad488bc8eb29d40bf955e527ef072ada762948064bc8e50422c5a5c5'
      && onDiskCurrentnessDigest === 'sha256:14882e245fa1676138cfc5bd51ef0403cb96cf2f77542caa2c57dc683ca8b159');
  const r12SuccessorImpactValid = (() => {
    if (!r12Selected || !r12ReceiptDigestsBound || !safeObservationRef(r12ImpactPath)) return false;
    const impactBytes = fs.existsSync(path.join(root, r12ImpactPath))
      ? fs.readFileSync(path.join(root, r12ImpactPath)) : null;
    const impactDigest = impactBytes ? sha256(impactBytes) : null;
    let impact;
    try { impact = impactBytes ? JSON.parse(impactBytes.toString('utf8')) : null; } catch { return false; }
    const predecessorExitBytes = fs.existsSync(path.join(root, r11ExitPath))
      ? fs.readFileSync(path.join(root, r11ExitPath)) : null;
    const predecessorCurrentnessBytes = fs.existsSync(path.join(root, r11CurrentnessPath))
      ? fs.readFileSync(path.join(root, r11CurrentnessPath)) : null;
    let predecessorExit;
    let predecessorCurrentness;
    try {
      predecessorExit = predecessorExitBytes ? JSON.parse(predecessorExitBytes.toString('utf8')) : null;
      predecessorCurrentness = predecessorCurrentnessBytes ? JSON.parse(predecessorCurrentnessBytes.toString('utf8')) : null;
    } catch { return false; }
    const predecessorDigests = predecessorExit?.sourceCurrentness?.sourceContentDigests ?? {};
    const successorDigests = onDiskExit?.sourceCurrentness?.sourceContentDigests ?? {};
    const sharedPaths = Object.keys(predecessorDigests).sort();
    const successorPaths = Object.keys(successorDigests).sort();
    const predecessorCurrentnessDigests = predecessorCurrentness?.sourceContentDigests ?? {};
    const predecessorFingerprint = predecessorExit?.sourceCurrentness?.materialSourceSetFingerprint;
    const computedPredecessorFingerprint = hashValue({
      schemaVersion: 'media.pdp0-material-source-set.v1',
      cells: (predecessorExit?.sourceCurrentness?.cells ?? [])
        .map((cell) => ({ cellId: cell.cellId, sourceSetFingerprint: cell.sourceSetFingerprint }))
        .sort((left, right) => left.cellId.localeCompare(right.cellId)),
    });
    const changedPaths = sharedPaths.filter((sourcePath) => predecessorDigests[sourcePath] !== successorDigests[sourcePath]);
    const delta = impact?.sourceDeltas;
    const sourcePath = '.product-experience/pdp-0-product-truth/generated/product-definition.candidate.json';
    const exactTransition = impactDigest === 'sha256:d19e50d4dbc75c7770ea1f01e8c2776676282a9a8b0f717961ea10a24554aa67'
      && impact?.schemaVersion === 'media.discovery.pdp0-successor-source-impact.v1'
      && impact?.recordId === 'MEDIA-DISCOVERY-PDP0-R11-SUCCESSOR-IMPACT-2026-10-14-R1'
      && impact?.campaign?.repository === 'samujjwal/ghatana-media'
      && impact?.campaign?.stage === 'DISCOVERY'
      && impact?.campaign?.activePhase === 'PDP-0'
      && impact?.predecessorCut?.phase === 'PDP-0'
      && impact?.predecessorCut?.exitRef === r11ExitPath
      && impact?.predecessorCut?.exitSha256 === sha256(predecessorExitBytes ?? Buffer.alloc(0))
      && impact?.predecessorCut?.currentnessRef === r11CurrentnessPath
      && impact?.predecessorCut?.currentnessSha256 === sha256(predecessorCurrentnessBytes ?? Buffer.alloc(0))
      && impact?.predecessorCut?.materialSourceSetFingerprint === predecessorExit?.sourceCurrentness?.materialSourceSetFingerprint
      && impact?.predecessorCut?.materialPathCount === 146
      && impact?.predecessorCut?.topology?.totalCells === 50
      && predecessorExit?.schemaVersion === 'media.discovery-phase-exit.v1'
      && predecessorExit?.phase === 'PDP-0'
      && predecessorExit?.recordId === 'MEDIA-PDP0-EXIT-52e29f7282f1'
      && predecessorExit?.sourceCurrentness?.status === 'PASS'
      && predecessorExit?.sourceCurrentness?.sourceCurrent === true
      && predecessorExit?.sourceCurrentness?.denominators?.totalCells === 50
      && predecessorCurrentness?.schemaVersion === 'media.discovery-pdp0-currentness-observation.v1'
      && predecessorCurrentness?.observationId === 'MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R11'
      && predecessorCurrentness?.phaseDisposition?.currentSourceCurrentness === 'PASS'
      && predecessorCurrentness?.phaseDisposition?.sourceCurrent === true
      && predecessorCurrentness?.materialSourceSetFingerprint === predecessorFingerprint
      && predecessorFingerprint === computedPredecessorFingerprint
      && predecessorCurrentness?.denominators?.totalCells === 50
      && Object.keys(predecessorDigests).length === 146
      && canonicalizeVerificationValue(sharedPaths) === canonicalizeVerificationValue(Object.keys(predecessorCurrentnessDigests).sort())
      && sharedPaths.every((sourcePath) => DIGEST.test(predecessorDigests[sourcePath] ?? '')
        && predecessorCurrentnessDigests[sourcePath] === predecessorDigests[sourcePath])
      && impact?.sourceDeltas?.length === 1
      && delta?.[0]?.path === sourcePath
      && delta?.[0]?.phase === 'PDP-1'
      && delta?.[0]?.classification === 'PDP1_DECISION_SOURCE_INVENTORY_PROJECTION_NO_PDP0_MEANING'
      && delta?.[0]?.predecessorSha256 === predecessorDigests[sourcePath]
      && delta?.[0]?.observedSha256 === successorDigests[sourcePath]
      && delta?.[0]?.pdp0MeaningChange === 'NONE'
      && Array.isArray(delta?.[0]?.pdp0MeaningIdsChanged) && delta[0].pdp0MeaningIdsChanged.length === 0
      && delta?.[0]?.freshCurrentnessRequired === true
      && impact?.decision?.status === 'INTERNAL_SCOPED_NO_PDP0_MEANING_CHANGE_FOR_EXACT_R11_DELTA'
      && impact?.decision?.pdp0MeaningDisposition === 'NO_PDP0_MEANING_CHANGE'
      && impact?.decision?.ownerAcceptance === 'NOT_CLAIMED'
      && impact?.decision?.independentSignoff === 'NOT_CLAIMED'
      && impact?.decision?.lifecycleClosure === 'NOT_ENTERED'
      && impact?.decision?.runtime === 'NOT_ADMITTED'
      && impact?.decision?.delivery === 'BLOCKED'
      && impact?.decision?.release === 'NOT_AUTHORIZED'
      && impact?.authority?.humanIndependentSignatureProvided === false
      && impact?.authority?.qualifiedExternalSpecialistSignoffProvided === false
      && impact?.authority?.externalContractOwnerAcceptanceProvided === false
      && impact?.authority?.nativeLifecycleReceiptProvided === false
      && impact?.predecessorCut?.materialPathCount === sharedPaths.length
      && canonicalizeVerificationValue(sharedPaths) === canonicalizeVerificationValue(successorPaths)
      && changedPaths.length === 1 && changedPaths[0] === sourcePath
      && predecessorExit?.phaseExit?.status === 'PASS'
      && predecessorCurrentness?.phaseDisposition?.currentSourceCurrentness === 'PASS'
      && sha256(predecessorExitBytes ?? Buffer.alloc(0)) === impact?.predecessorCut?.exitSha256
      && sha256(predecessorCurrentnessBytes ?? Buffer.alloc(0)) === impact?.predecessorCut?.currentnessSha256;
    const disposition = onDiskExit?.successorSourceImpactDisposition;
    return exactTransition
      && disposition?.authorityRef === r12ImpactPath
      && disposition?.authoritySha256 === impactDigest
      && disposition?.path === sourcePath
      && disposition?.classification === 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION'
      && disposition?.predecessorSha256 === predecessorDigests[sourcePath]
      && disposition?.observedSha256 === successorDigests[sourcePath]
      && disposition?.meaningIdsChanged?.length === 0
      && disposition?.ownerAcceptance === 'NOT_CLAIMED'
      && disposition?.independentSignoff === 'NOT_CLAIMED'
      && disposition?.lifecycleClosure === 'NOT_ENTERED'
      && disposition?.runtime === 'NOT_ADMITTED'
      && disposition?.delivery === 'BLOCKED';
  })();
  const callerRecordsMatchDisk = canonicalizeVerificationValue(p0Exit) === canonicalizeVerificationValue(onDiskExit)
    && canonicalizeVerificationValue(p0Currentness) === canonicalizeVerificationValue(onDiskCurrentness)
    && p0Digest === onDiskExitDigest && p0CurrentnessDigest === onDiskCurrentnessDigest;
  const derivedCurrentnessPath = typeof authoritativeExitPath === 'string'
    ? authoritativeExitPath.replace('-exit-', '-currentness-') : null;
  const sourceDigests = onDiskExit?.sourceCurrentness?.sourceContentDigests ?? {};
  const currentnessDigests = onDiskCurrentness?.sourceContentDigests ?? {};
  const sourcePaths = Object.keys(sourceDigests).sort();
  const currentnessPaths = Object.keys(currentnessDigests).sort();
  const sourceMapValid = sourcePaths.length === 146
    && new Set(sourcePaths).size === 146
    && sourcePaths.every((sourcePath) => DIGEST.test(sourceDigests[sourcePath] ?? '')
      && DIGEST.test(currentnessDigests[sourcePath] ?? '')
      && sourceDigests[sourcePath] === currentnessDigests[sourcePath])
    && canonicalizeVerificationValue(sourcePaths) === canonicalizeVerificationValue(currentnessPaths);
  const exitFingerprint = onDiskExit?.sourceCurrentness?.materialSourceSetFingerprint;
  const computedFingerprint = hashValue({
    schemaVersion: 'media.pdp0-material-source-set.v1',
    cells: (onDiskExit?.sourceCurrentness?.cells ?? [])
      .map((cell) => ({ cellId: cell.cellId, sourceSetFingerprint: cell.sourceSetFingerprint }))
      .sort((left, right) => left.cellId.localeCompare(right.cellId)),
  });
  const fingerprintBound = exitFingerprint === computedFingerprint
    && onDiskExit?.developmentStatus?.currentMaterialSourceSetFingerprint === computedFingerprint
    && onDiskCurrentness?.materialSourceSetFingerprint === computedFingerprint
    && matrix.currentCut?.materialSourceSetFingerprint === computedFingerprint
    && matrix.currentCut?.pdp0MaterialSourceSetFingerprint === computedFingerprint;
  const cells = p0Exit?.sourceCurrentness?.cells ?? [];
  const currentnessCells = p0Currentness?.physicalCompositeConsumerCells ?? [];
  const uniqueCellIds = new Set(cells.map((cell) => cell.cellId));
  const currentnessCellMap = new Map(currentnessCells.map((cell) => [cell.cellId, cell]));
  const fingerprint = p0Exit?.developmentStatus?.currentMaterialSourceSetFingerprint;
  const recordedExit = onDiskExit;
  const recordedCurrentness = onDiskCurrentness;
  const ownerStatusJoin = p0Exit?.ownerStatusJoin;
  const successorImpact = p0Exit?.successorSourceImpactDisposition;
  const cellsCongruent = cells.length === 50 && currentnessCells.length === 50
    && uniqueCellIds.size === 50 && currentnessCellMap.size === 50
    && cells.every((cell) => {
      const currentnessCell = currentnessCellMap.get(cell.cellId);
      return currentnessCell
        && cell.surfaceId === currentnessCell.surfaceId
        && cell.cellType === currentnessCell.cellType
        && cell.sourceCurrentness === currentnessCell.sourceCurrentness
        && cell.sourceCurrentness === 'CURRENT'
        && cell.sourceSetFingerprint === currentnessCell.sourceSetFingerprint
        && cell.expectedPathSetFingerprint === currentnessCell.expectedPathSetFingerprint
        && cell.expectedPathCount === currentnessCell.expectedPathCount
        && (cell.blockers?.length ?? 0) === 0
        && (currentnessCell.blockers?.length ?? 0) === 0;
    });
  const phaseDispositionBound = r12Selected
    ? r12SuccessorImpactValid
      && p0Currentness?.phaseDisposition?.pdp0Exit === 'PASS_INTERNAL_IMPACT_DISPOSITION_ONLY'
      && p0Currentness?.phaseDisposition?.discoveryBarrier === 'FAIL_PDP1_PDP3_NOT_VALIDATED'
    : p0Currentness?.phaseDisposition?.pdp0Exit === 'BLOCKED_PENDING_OWNER_ACCEPTANCE'
      && p0Currentness?.phaseDisposition?.discoveryBarrier === 'FAIL_PDP0_OWNER_ACCEPTANCE_PENDING_AND_PDP1_PDP3_NOT_VALIDATED';
  const limitationOnly = p0Exit?.delegatedOwnerAcceptance?.status === 'INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_ONLY_NOT_OWNER_ACCEPTANCE'
    && p0Exit?.delegatedOwnerAcceptance?.humanIndependentSignatureProvided === false
    && p0Exit?.delegatedOwnerAcceptance?.qualifiedExternalSpecialistSignoffProvided === false
    && p0Exit?.successorSourceImpactDisposition?.classification === 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION'
    && p0Exit?.successorSourceImpactDisposition?.ownerAcceptance === 'NOT_CLAIMED'
    && p0Exit?.successorSourceImpactDisposition?.independentSignoff === 'NOT_CLAIMED'
    && p0Exit?.successorSourceImpactDisposition?.lifecycleClosure === 'NOT_ENTERED'
    && p0Exit?.successorSourceImpactDisposition?.runtime === 'NOT_ADMITTED'
    && p0Exit?.successorSourceImpactDisposition?.delivery === 'BLOCKED'
    && (typeof ownerStatusJoin === 'string'
      ? ownerStatusJoin === 'CURRENT_SOURCE_WITH_INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_NOT_OWNER_ACCEPTANCE'
      : ownerStatusJoin?.status === 'CURRENT_SOURCE_WITH_INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_NOT_OWNER_ACCEPTANCE')
    && (p0Exit?.sourceCurrentness?.limitation ?? ownerStatusJoin?.limitation ?? '').includes('does not claim owner acceptance')
    && p0Currentness?.phaseDisposition?.ownerAcceptance === 'NOT_OBTAINED'
    && p0Currentness?.phaseDisposition?.ownerAcceptanceClaim === 'NOT_CLAIMED'
    && p0Currentness?.limitations?.some((limitation) => limitation.includes('does not assert independent semantic acceptance'))
    && phaseDispositionBound;
  const currentnessValid = p0Currentness?.schemaVersion === 'media.discovery-pdp0-currentness-observation.v1'
    && p0Currentness?.observationId === `MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-${authoritativeExitPath?.match(/current-cut-(r\d+)\.json$/u)?.[1]?.toUpperCase() ?? ''}`
    && p0Currentness.phaseDisposition?.currentSourceCurrentness === 'PASS'
    && p0Currentness.phaseDisposition?.sourceCurrent === true
    && p0Currentness.materialSourceSetFingerprint === fingerprint
    && p0Exit?.sourceCurrentness?.materialSourceSetFingerprint === fingerprint
    && p0Currentness.denominators?.totalCells === 50
    && p0Currentness.physicalCompositeConsumerCells?.length === 50
    && new Set(p0Currentness.physicalCompositeConsumerCells.map((cell) => cell.cellId)).size === 50
    && p0Currentness.physicalCompositeConsumerCells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && p0Exit?.campaign?.observedHead === p0Currentness.campaign?.observedHead;
  const matrixCutIsCurrent = safeReceiptRefs
    && matrix.currentCut?.phaseExit === authoritativeExitPath
    && matrix.currentCut?.currentnessObservation === authoritativeCurrentnessPath
    && matrix.currentCut?.phaseExitRecordId === onDiskExit?.recordId
    && matrix.currentCut?.repositoryHead === onDiskExit?.campaign?.observedHead
    && matrix.currentCut?.materialSourceSetFingerprint === onDiskExit?.sourceCurrentness?.materialSourceSetFingerprint
    && onDiskExit?.campaign?.repository === 'samujjwal/ghatana-media'
    && onDiskCurrentness?.campaign?.repository === 'samujjwal/ghatana-media'
    && authoritativeCurrentnessPath === derivedCurrentnessPath
    && p0ExitPath === authoritativeExitPath
    && p0CurrentnessPath === authoritativeCurrentnessPath;
  const valid = matrixCutIsCurrent
    && callerRecordsMatchDisk
    && JSON.stringify(p0Exit) === JSON.stringify(recordedExit)
    && JSON.stringify(p0Currentness) === JSON.stringify(recordedCurrentness)
    && p0Exit?.schemaVersion === 'media.discovery-phase-exit.v1'
    && p0Exit?.phase === 'PDP-0'
    && p0Exit?.recordId === `MEDIA-PDP0-EXIT-${fingerprint?.slice(-12)}`
    && fingerprintBound
    && sourceMapValid
    && p0Exit?.sourceCurrentness?.status === 'PASS'
    && p0Exit?.sourceCurrentness?.sourceCurrent === true
    && p0Exit?.phaseExit?.status === 'PASS'
    && p0Exit?.phaseExit?.sourceCurrentness === 'PASS'
    && p0Exit?.phaseExit?.delegatedOwnerAcceptance === 'NOT_CLAIMED_IMPACT_DISPOSITION_ONLY'
    && p0Exit?.developmentStatus?.status === 'DEV_COMPLETE'
    && Array.isArray(p0Exit.developmentStatus?.outstandingMeaningIds)
    && p0Exit.developmentStatus.outstandingMeaningIds.length === 0
    && DIGEST.test(fingerprint ?? '')
    && p0Exit.sourceCurrentness.denominators?.totalCells === 50
    && p0Exit.sourceCurrentness.materialPathDenominator?.uniquePaths === 146
    && cellsCongruent
    && limitationOnly
    && currentnessValid;
  return {
    valid: valid && currentnessValid,
    exitRef: p0ExitPath,
    exitDigest: p0Digest,
    currentnessRef: p0CurrentnessPath,
    currentnessDigest: p0CurrentnessDigest,
    currentnessValid,
    matrixCutMatches: matrixCutIsCurrent,
    sourceMapValid,
    fingerprintBound,
    exitRecordId: p0Exit.recordId,
    materialSourceSetFingerprint: fingerprint ?? null,
    observedHead: p0Exit.campaign?.observedHead ?? null,
    cellCount: cells.length,
    uniqueCellCount: uniqueCellIds.size,
    cellsCongruent,
    limitationOnly,
  };
}

function priorPdp1Attempts(currentSuffix) {
  const directory = path.join(root, 'docs/implementation/observations');
  return fs.readdirSync(directory)
    .filter((name) => name.startsWith('media-discovery-pdp1-exit-') && name.endsWith('.json')
      && name !== `media-discovery-pdp1-exit-${currentSuffix}.json`)
    .sort()
    .map((name) => {
      const absolutePath = path.join(directory, name);
      const record = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
      return {
        ref: path.relative(root, absolutePath),
        digest: sha256(fs.readFileSync(absolutePath)),
        phaseExitStatus: record.phaseExit?.status ?? 'UNKNOWN',
        observedAt: record.observedAt ?? null,
        blockers: record.phaseExit?.blockers ?? [],
        supersessionRule: 'A later current source capture governs the present phase decision; earlier records remain immutable history.',
      };
    });
}

export function validatePdp1OperationParityProjectionImpact(record = readJson(PDP1_OPERATION_PARITY_SUCCESSOR_IMPACT_PATH), {
  observedDigests = {},
  testRun = null,
  statusPins = readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet,
  semanticPins = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json').sourceFingerprints,
} = {}) {
  const predecessorPath = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r19.json';
  const predecessor = readJson(predecessorPath);
  const predecessorDigest = sha256(fs.readFileSync(path.join(root, predecessorPath)));
  const expected = [
    {
      path: '.product-experience/interface-parity/operation-parity.yaml',
      selector: 'ownerDefinedSourceTruthMatrix[id=media.p2.rule.interface-source-truth-matrix.v1]; action=media.action.confirm-selected-fallback; operation=media.operation.fallback-selection.confirm.v1',
      predecessorSha256: 'sha256:8b95782fe47cb7e44ec159c168399f78a674dbc1c6f72065881c278f7e3c13d6',
      observedSha256: 'sha256:24e4699d42dd1a2a0363628387fdf2a12c539f8ac697a0b8771277bbd4aa8555',
      classification: 'PDP2_SOURCE_TRUTH_PROJECTION_REFRESH',
      disposition: 'NO_PDP1_MEANING_CHANGE',
    },
    {
      path: PDP1_INTERFACE_REVIEW_PATH,
      selector: 'sources[path=.product-experience/interface-parity/operation-parity.yaml].sha256; currentSourceCutDeltaReview',
      predecessorSha256: 'sha256:90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76',
      observedSha256: 'sha256:866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd',
      classification: 'PDP1_REVIEW_ARTIFACT_REFRESH_FOR_PDP2_PROJECTION',
      disposition: 'NO_ADDITIONAL_PDP1_MEANING',
    },
    {
      path: PDP1_OPERATIONS_REVIEW_PATH,
      selector: 'currentSourceCutDeltaReview; interfacePopulationReconciliation',
      predecessorSha256: 'sha256:6a00513dbe97182091a5b1b47fad2dc3e702ffaed962b835d2d4dffb822ff5b8',
      observedSha256: 'sha256:d5f83fad612d6598165072137390c70c8d4dfdc549a236a29c7bda34b50b6d0c',
      classification: 'PDP1_REVIEW_ARTIFACT_REFRESH_FOR_PDP2_PROJECTION',
      disposition: 'NO_ADDITIONAL_PDP1_MEANING',
    },
    {
      path: 'tests/pdp1-interface-current-source-review.test.mjs',
      selector: 'operation-parity projection source-pin and review-refresh assertions',
      predecessorSha256: 'sha256:9a5251fd20311b470e6ac4e43b173f2a2fbb0066d4a55d1fd4a63945a14ba630',
      observedSha256: 'sha256:00f3b6352180c83c70ebd4fab8d44582fc3cb56904d3e232da4c12931d940b67',
      classification: 'REGRESSION_COVERAGE',
      disposition: 'TEST_ONLY_NO_PRODUCT_MEANING_CHANGE',
    },
  ];
  const rows = record?.sourceDeltas ?? [];
  const historicalDigests = predecessor.sourceCurrentness?.sourceContentDigests ?? {};
  const historicalTestDigest = predecessor.testRun?.sourceBinding?.testInputContentDigests?.[expected[3].path];
  const operationParity = parseYaml(readText(expected[0].path));
  const currentInterfaceReview = readJson(PDP1_INTERFACE_REVIEW_PATH);
  const operationDefinition = parseYaml(readText(PDP1_OPERATIONS_PATH));
  const actionRegistry = parseYaml(readText('.product-experience/pdp-3-product-experience/action-registry.yaml'));
  const pxd164ObservedDigests = { ...observedDigests };
  for (const expectedRow of PDP1_PXD164_SOURCE_ROWS) {
    if (pxd164ObservedDigests[expectedRow.path] === undefined) {
      pxd164ObservedDigests[expectedRow.path] = sha256(fs.readFileSync(path.join(root, expectedRow.path)));
    }
  }
  const pxd164Impact = validatePdp1Pxd164SemanticRepairImpact(readJson(PDP1_PXD164_IMPACT_PATH), {
    observedDigests: pxd164ObservedDigests,
  });
  const interfacePinRefreshImpact = validatePdp1InterfaceReviewPinRefreshImpact();
  const pxd164ReviewDelta = pxd164Impact.sourceDeltas.find((row) => row.path === PDP1_OPERATIONS_REVIEW_PATH);
  const exactLiveDigests = expected.map((entry) => sha256(fs.readFileSync(path.join(root, entry.path))));
  const suppliedDigests = expected.map((entry) => observedDigests[entry.path]?.digest ?? observedDigests[entry.path] ?? exactLiveDigests[expected.indexOf(entry)]);
  const projectionRuleExists = operationParity.normativeRuleRecords?.some((rule) => rule.id === 'media.p2.rule.interface-source-truth-matrix.v1');
  const operationExists = JSON.stringify(operationDefinition).includes('media.operation.fallback-selection.confirm.v1');
  const actionExists = JSON.stringify(actionRegistry).includes('media.action.confirm-selected-fallback');
  const interfaceReviewPinsProjection = currentInterfaceReview.sources?.some((source) =>
    source.path === expected[0].path
      && `sha256:${String(source.sha256 ?? '').replace(/^sha256:/u, '')}` === expected[0].observedSha256);
  const requiredOutcome = (testRun?.testOutcomes ?? testRun?.outcomes ?? []).find((entry) => entry.command === REQUIRED_TEST_COMMAND);
  const impactTestOutcome = (testRun?.testOutcomes ?? testRun?.outcomes ?? []).find((entry) => entry.command === PDP1_OPERATION_PARITY_TEST_COMMAND);
  const testEvidenceValid = testRun === null || (
    testRun.sourceBinding?.stable === true
      && testRun.startedHead === testRun.completedHead
      && testRun.sourceBinding?.testInputContentDigests?.[expected[3].path] === exactLiveDigests[3]
      && testRun.sourceBinding?.testInputContentDigests?.[PDP1_OPERATION_PARITY_SUCCESSOR_TEST_PATH]
        === sha256(fs.readFileSync(path.join(root, PDP1_OPERATION_PARITY_SUCCESSOR_TEST_PATH)))
      && requiredOutcome?.status === 'PASS' && requiredOutcome.exitCode === 0
      && Number.isInteger(requiredOutcome.testCount) && requiredOutcome.testCount > 0
      && requiredOutcome.passedCount === requiredOutcome.testCount
      && requiredOutcome.failedCount === 0 && requiredOutcome.skippedCount === 0
      && impactTestOutcome?.status === 'PASS' && impactTestOutcome.exitCode === 0
      && Number.isInteger(impactTestOutcome.testCount) && impactTestOutcome.testCount > 0
      && impactTestOutcome.passedCount === impactTestOutcome.testCount
      && impactTestOutcome.failedCount === 0 && impactTestOutcome.skippedCount === 0
  );
  const rowChecks = expected.map((entry, index) => {
    const row = rows[index] ?? {};
    const historical = index === 3 ? historicalTestDigest : historicalDigests[entry.path];
    const pinDigest = (pins) => `sha256:${String(pins?.[entry.path] ?? '').replace(/^sha256:/u, '')}`;
    const allowedPins = [entry.predecessorSha256, entry.observedSha256];
    const chainedPxd164ReviewRefresh = index === 2 && pxd164Impact.valid
      && pxd164ReviewDelta?.predecessorSha256 === entry.observedSha256
      && pxd164ReviewDelta?.observedSha256 === exactLiveDigests[index]
      && suppliedDigests[index] === exactLiveDigests[index]
      && [entry.observedSha256, exactLiveDigests[index]].includes(pinDigest(statusPins))
      && [entry.observedSha256, exactLiveDigests[index]].includes(pinDigest(semanticPins));
    const chainedInterfaceReviewRefresh = index === 1 && interfacePinRefreshImpact.valid
      && interfacePinRefreshImpact.predecessorSha256 === entry.observedSha256
      && interfacePinRefreshImpact.observedSha256 === exactLiveDigests[index]
      && suppliedDigests[index] === exactLiveDigests[index]
      && pinDigest(statusPins) === interfacePinRefreshImpact.predecessorSha256
      && pinDigest(semanticPins) === interfacePinRefreshImpact.observedSha256;
    const testSpecific = index === 3
      ? row.phase === 'PDP-1 regression test' && row.classification === 'REGRESSION_COVERAGE'
      : row.phase === entry.phase || row.phase === (index === 0 ? 'PDP-2 projection; PDP-1 source meaning unchanged' : 'PDP-1 review artifact');
    return {
      path: entry.path,
      predecessorSha256: entry.predecessorSha256,
      observedSha256: exactLiveDigests[index],
      valid: row.path === entry.path
        && row.selector === entry.selector
        && row.predecessorSha256 === entry.predecessorSha256
        && historical === entry.predecessorSha256
        && row.observedSha256 === entry.observedSha256
        && (suppliedDigests[index] === entry.observedSha256 && exactLiveDigests[index] === entry.observedSha256
          && allowedPins.includes(pinDigest(statusPins)) && allowedPins.includes(pinDigest(semanticPins))
          || chainedPxd164ReviewRefresh || chainedInterfaceReviewRefresh)
        && row.classification === entry.classification
        && row.pdp1MeaningDisposition === entry.disposition
        && Array.isArray(row.meaningIdsChanged) && row.meaningIdsChanged.length === 0
        && row.requiresFreshPdp1Currentness === true
        && testSpecific,
    };
  });
  const valid = record?.schemaVersion === 'media.discovery-pdp1-operation-parity-projection-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP1-OPERATION-PARITY-PROJECTION-IMPACT-2026-10-14-R1'
    && record?.recordKind === 'INTERNAL_SOURCE_BOUND_SUCCESSOR_IMPACT_DISPOSITION'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY' && record?.campaign?.phase === 'PDP-1'
    && record?.campaign?.predecessorObservation === predecessorPath
    && record?.campaign?.predecessorObservationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R19'
    && record?.campaign?.predecessorObservationSha256 === predecessorDigest
    && predecessor?.observationId === record?.campaign?.predecessorObservationId
    && record?.predecessor?.observationRef === predecessorPath
    && record?.predecessor?.materialSourceSetFingerprint === predecessor.sourceCurrentness?.materialSourceSetFingerprint
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_TASK_DELEGATION'
    && record?.authority?.authorizationScope === 'Exact R19-to-live transitions for the operation-parity projection, its two source-review refreshes, and the changed interface-review regression test.'
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && rows.length === expected.length
    && new Set(rows.map((row) => row.path)).size === expected.length
    && rowChecks.every((row) => row.valid)
    && operationParity.schemaVersion === 'media.interface-parity.operation.v1'
    && projectionRuleExists && operationExists && actionExists && interfaceReviewPinsProjection
    && record?.evidence?.testRunRequired === true
    && record?.evidence?.testPath === expected[3].path
    && testEvidenceValid
    && record?.evidence?.projectionRuleId === 'media.p2.rule.interface-source-truth-matrix.v1'
    && record?.evidence?.pdp1OperationId === 'media.operation.fallback-selection.confirm.v1'
    && record?.evidence?.pdp3ActionId === 'media.action.confirm-selected-fallback'
    && record?.decision?.status === 'SCOPED_INTERNAL_SUCCESSOR_IMPACT_DISPOSITION'
    && record?.decision?.pdp1MeaningDisposition === 'NO_PDP1_MEANING_CHANGE_FOR_THE_PROJECTION_REFRESH_REVIEW_REFRESHES_AND_TEST_ONLY_CHANGE'
    && record?.decision?.requiresFreshPdp1Currentness === true
    && record?.decision?.preserveHistoricalReceipts === true
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentAcceptance === 'NOT_CLAIMED'
    && record?.decision?.humanIndependentSignature === 'NOT_PROVIDED'
    && record?.decision?.qualifiedExternalSpecialistSignoff === 'NOT_PROVIDED'
    && record?.decision?.externalContractOwnerAcceptance === 'NOT_PROVIDED'
    && record?.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && record?.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.decision?.delivery === 'BLOCKED'
    && record?.decision?.release === 'NOT_AUTHORIZED';
  return {
    valid,
    recordRef: PDP1_OPERATION_PARITY_SUCCESSOR_IMPACT_PATH,
    recordId: record?.recordId ?? null,
    recordDigest: sha256(fs.readFileSync(path.join(root, PDP1_OPERATION_PARITY_SUCCESSOR_IMPACT_PATH))),
    predecessorRef: predecessorPath,
    predecessorDigest,
    rowChecks,
    projectionRuleExists,
    operationExists,
    actionExists,
    interfaceReviewPinsProjection,
    testEvidenceValid,
    testOutcome: requiredOutcome ?? null,
    impactTestOutcome: impactTestOutcome ?? null,
    ownerAcceptance: 'NOT_CLAIMED',
    independentAcceptance: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtimeAdmission: 'NOT_ADMITTED',
    delivery: 'BLOCKED',
    release: 'NOT_AUTHORIZED',
  };
}

export function loadPdp1OwnerWireImpactInput() {
  return { path: PDP1_OWNER_WIRE_IMPACT_PATH, record: readJson(PDP1_OWNER_WIRE_IMPACT_PATH) };
}

function makeObservation({ suffix, testRun, p0ExitPath, additionalSourceImpactPath = null }) {
  const matrixPath = 'docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json';
  const statusPath = 'docs/implementation/pdp-1-phase-dev-status.json';
  const reviewPath = 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json';
  const mdc10Path = 'docs/implementation/observations/media-discovery-pdp1-mdc10-contract-parity-2026-10-13-r1.json';
  const matrixDigest = sha256(fs.readFileSync(path.join(root, matrixPath)));
  const matrix = readJson(matrixPath);
  const status = readJson(statusPath);
  const semanticReview = readJson(reviewPath);
  const mdc10 = readJson(mdc10Path);
  const p0Exit = readJson(p0ExitPath);
  const p0CurrentnessPath = p0ExitPath.replace('-exit-', '-currentness-');
  const p0Currentness = readJson(p0CurrentnessPath);
  const topology = readJson('.product-experience/surfaces/media-physical-topology.v1.json');
  const registry = parseYaml(readText('.product-experience/surface-registry.yaml'));
  const census = buildPdp1SourceCensus(root);
  const domainObjects = parseYaml(readText('.product-experience/pdp-1-domain-data/domain-objects.yaml'));
  const operationDefinitions = parseYaml(readText('.product-experience/pdp-1-domain-data/operations.yaml'));
  const topologyReview = validateMatrixAndTopology(matrix, topology, registry, census, domainObjects, operationDefinitions);
  const previousFingerprints = p0Exit.sourceCurrentness;
  const dimensions = {
    ownerGraphFingerprint: previousFingerprints.ownerGraphFingerprint,
    physicalCatalogFingerprint: previousFingerprints.physicalCatalogFingerprint,
    providerRegistryFingerprint: previousFingerprints.providerRegistryFingerprint,
  };
  const availablePaths = trackedPathSet();
  const sourceCells = buildCellPaths(topologyReview.cells, topology, availablePaths);
  const lifecyclePriming = [
    captureRepositorySourceCurrentness(root, dimensions),
    captureRepositorySourceCurrentness(root, dimensions),
  ];
  const technical = observeMediaDiscoveryCurrentness(root, sourceCells.map((cell) => ({
    ...cell,
    ownerGraphFingerprint: dimensions.ownerGraphFingerprint,
    physicalCatalogFingerprint: dimensions.physicalCatalogFingerprint,
    providerRegistryFingerprint: dimensions.providerRegistryFingerprint,
  })));
  const consistencyCaptures = [
    captureRepositorySourceCurrentness(root, dimensions),
    captureRepositorySourceCurrentness(root, dimensions),
  ];
  const currentCapture = consistencyCaptures[1];
  const fileDigests = currentCapture?.fileContentDigests ?? {};
  const primingSummary = lifecyclePriming.map(summarizeCapture);
  const consistencySummary = consistencyCaptures.map(summarizeCapture);
  const consistencyStable = consistencyCaptures.every(captureIsStable)
    && consistencyCaptures.every((capture) => capture.sourceToken === technical.sourceToken
      && capture.contentFingerprint === technical.contentFingerprint
      && capture.pathMembershipDigest === technical.pathMembershipDigest);
  const pinReview = phasePinReview(status, semanticReview, mdc10, fileDigests, testRun);
  const p0Digest = sha256(fs.readFileSync(path.join(root, p0ExitPath)));
  const p0CurrentnessDigest = sha256(fs.readFileSync(path.join(root, p0CurrentnessPath)));
  const matrixCutMatches = matrix.currentCut?.phaseExit === p0ExitPath
    && matrix.currentCut?.currentnessObservation === p0CurrentnessPath
    && matrix.currentCut?.phaseExitRecordId === p0Exit.recordId
    && matrix.currentCut?.materialSourceSetFingerprint === p0Exit.developmentStatus?.currentMaterialSourceSetFingerprint;
  const p0Predecessor = validatePdp0Predecessor(p0Exit, p0ExitPath, p0Digest, p0Currentness, p0CurrentnessPath, p0CurrentnessDigest, matrixCutMatches, p0ExitPath);
  const p0ExitValid = p0Predecessor.valid;
  const p0SourceSetFingerprint = p0Predecessor.materialSourceSetFingerprint;
  const currentSourceManifestDigest = fileDigests['.product-experience/source-manifest.yaml']?.digest ?? null;
  const externalContracts = externalContractObservation(currentSourceManifestDigest, p0Currentness);
  const censusIdentitySetMatches = census.identityIds?.length === semanticReview.reviewedIdentityIds?.length
    && new Set(census.identityIds).size === census.identityIds.length
    && census.identityIds.every((identity) => semanticReview.reviewedIdentityIds.includes(identity));
  const semanticReviewCarryForward = semanticReview.status === 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW'
    && semanticReview.phase === 'PDP-1'
    && semanticReview.sourceCutStable === true
    && semanticReview.outstandingMeaningIds?.length === 0
    && censusIdentitySetMatches
    && pinReview.semanticDefinitionDeltaReview?.valid === true
    && pinReview.unclassifiedStatusPins.length === 0
    && pinReview.unclassifiedSemanticPins.length === 0;
  const ownerDirection = delegatedOwnerDirectionObservation();
  const historicalStatusValid = status.phase === 'PDP-1'
    && status.status === 'DEV_COMPLETE'
    && Array.isArray(status.outstandingMeaningIds)
    && status.outstandingMeaningIds.length === 0;
  const testOutcomes = testRun.testOutcomes;
  const requiredTest = testOutcomes.find((outcome) => outcome.command === REQUIRED_TEST_COMMAND);
  const localExperienceCheck = testOutcomes.find((outcome) => outcome.command === REQUIRED_LOCAL_EXPERIENCE_COMMAND);
  const strictParity = testOutcomes.find((outcome) => outcome.command === REQUIRED_STRICT_COMMAND);
  const definitionOnly = testOutcomes.find((outcome) => outcome.command === REQUIRED_DEFINITION_ONLY_COMMAND);
  const testInputDigestsMatchCapture = REQUIRED_TEST_FILES.every((sourcePath) =>
    testRun.sourceBinding?.testInputContentDigests?.[sourcePath] === fileDigests[sourcePath]?.digest);
  const localExperienceCheckInputMatchesCurrent = testRun.sourceBinding?.localExperienceCheckInput?.stable === true
    && testRun.sourceBinding.localExperienceCheckInput.sha256After
      === sha256(fs.readFileSync(path.join(root, testRun.sourceBinding.localExperienceCheckInput.path)));
  const testsBoundToCurrentCut = testRun.sourceBinding?.stable === true
    && testRun.startedHead === testRun.completedHead
    && testRun.completedHead === git(['rev-parse', 'HEAD'])
    && testRun.sourceBinding?.sourceToken === technical.sourceToken
    && testRun.sourceBinding?.contentFingerprint === technical.contentFingerprint
    && testRun.sourceBinding?.pathMembershipDigest === technical.pathMembershipDigest
    && testInputDigestsMatchCapture
    && localExperienceCheckInputMatchesCurrent;
  const testOutcomesValid = requiredTest?.status === 'PASS' && requiredTest.exitCode === 0
    && Number.isInteger(requiredTest.testCount) && requiredTest.testCount > 0
    && requiredTest.passedCount === requiredTest.testCount && requiredTest.failedCount === 0 && requiredTest.skippedCount === 0
    && definitionOnly?.status === 'PASS' && definitionOnly.exitCode === 0
    && strictParity?.status === 'NON_GREEN_EXPECTED_OWNER_ADMISSION_FINDING' && strictParity.exitCode === 1
    && strictParity.sourceFindings?.unresolved === 1
    && strictParity.sourceFindings.audited === 47
    && strictParity.sourceFindings.dispositioned === 46
    && strictParity.unresolvedFinding === 'PDP-1 operations remain proposal-only; structural identities are not accepted mappings'
    && definitionOnly?.sourceFindings?.audited === 47
    && definitionOnly.sourceFindings.dispositioned === 45
    && definitionOnly.sourceFindings.unresolved === 0
    && localExperienceCheck?.status === 'PASS' && localExperienceCheck.exitCode === 0
    && testsBoundToCurrentCut;
  const currentCells = technical.cells.map((cell) => {
    const expectedPaths = cell.expectedPaths ?? [];
    const fileContentDigests = cell.fileContentDigests ?? {};
    const cellMatrix = topologyReview.cells.find((row) => row.surfaceId === cell.surfaceId);
    const sourceSetFingerprint = hashValue({
      schemaVersion: 'media.pdp1-phase-cell-material.v1',
      cellId: cell.cellId,
      owner: cellMatrix?.owner,
      applicability: cell.applicability,
      expectedPaths,
      fileContentDigests,
    });
    return {
      cellId: cell.cellId,
      surfaceId: cell.surfaceId,
      cellType: cell.cellType,
      owner: cellMatrix?.owner ?? null,
      applicability: cell.applicability,
      sourceCurrentness: cell.sourceCurrentness,
      expectedPathCount: expectedPaths.length,
      expectedPathSetFingerprint: hashValue(expectedPaths),
      sourceSetFingerprint,
      expectedPaths,
      fileContentDigests,
      blockers: [...new Set([...(cell.blockers ?? []), ...(topologyReview.errors.filter((error) => error.includes(cell.surfaceId)))])],
    };
  });
  const allCellsCurrent = currentCells.length === 50
    && new Set(currentCells.map((cell) => cell.cellId)).size === 50
    && currentCells.every((cell) => cell.sourceCurrentness === 'CURRENT' && cell.blockers.length === 0);
  const sourceSetByPath = {};
  for (const cell of currentCells) {
    for (const [sourcePath, digest] of Object.entries(cell.fileContentDigests)) {
      if (sourceSetByPath[sourcePath] && sourceSetByPath[sourcePath] !== digest) {
        throw new Error(`Inconsistent Lifecycle digest for ${sourcePath}`);
      }
      sourceSetByPath[sourcePath] = digest;
    }
  }
  const p0SourceDigests = p0Exit.sourceCurrentness?.sourceContentDigests ?? {};
  const predecessorSharedPathChecks = Object.entries(sourceSetByPath)
    .filter(([sourcePath]) => Object.hasOwn(p0SourceDigests, sourcePath))
    .map(([sourcePath, current]) => ({
      path: sourcePath,
      predecessorSha256: p0SourceDigests[sourcePath] ?? null,
      currentSha256: current ?? null,
      matches: p0SourceDigests[sourcePath] === current,
    }));
  const predecessorSharedPathMismatches = predecessorSharedPathChecks.filter((entry) => !entry.matches);
  const firstCellPaths = new Set(currentCells[0]?.expectedPaths ?? []);
  for (const cell of currentCells.slice(1)) {
    for (const sourcePath of [...firstCellPaths]) if (!cell.expectedPaths.includes(sourcePath)) firstCellPaths.delete(sourcePath);
  }
  const sharedMaterialPaths = [...firstCellPaths].sort();
  const materialSourceSetFingerprint = hashValue({
    schemaVersion: 'media.pdp1-material-source-set.v1',
    phase: 'PDP-1',
    priorPhaseExitAttempts: priorPdp1Attempts(suffix),
    cells: currentCells.map((cell) => ({ cellId: cell.cellId, sourceSetFingerprint: cell.sourceSetFingerprint }))
      .sort((left, right) => left.cellId.localeCompare(right.cellId)),
  });
  const additionalSourceImpactInput = additionalSourceImpactPath ? {
    path: additionalSourceImpactPath,
    record: readJson(additionalSourceImpactPath),
  } : null;
  const ownerWireImpactInput = additionalSourceImpactPath ? loadPdp1OwnerWireImpactInput() : null;
  const ownerStatusJoin = pdp1OwnerStatusJoinObservation(sourceSetByPath, materialSourceSetFingerprint, testRun,
    additionalSourceImpactInput, ownerWireImpactInput);
  const lifecycleBlockers = [...new Set([
    ...technical.blockers,
    ...consistencySummary.flatMap((capture, index) => capture.status === 'UNKNOWN' ? [`CONSISTENCY_CAPTURE_${index + 1}_UNKNOWN`] : []),
    ...(!consistencyStable ? ['POST_CAPTURE_SOURCE_OR_LIFECYCLE_STATE_CHANGED'] : []),
  ])];
  const sourceBlockers = [
    ...topologyReview.errors,
    ...(!p0ExitValid ? ['PDP0_PREDECESSOR_EXIT_NOT_PASS'] : []),
    ...(!ownerStatusJoin.valid ? ['PDP1_CURRENT_CUT_OWNER_STATUS_JOIN_NOT_EXACT'] : []),
    ...(!DIGEST.test(p0SourceSetFingerprint ?? '') ? ['PDP0_PREDECESSOR_MATERIAL_FINGERPRINT_MISSING'] : []),
    ...(predecessorSharedPathMismatches.length ? ['PDP0_PREDECESSOR_SHARED_SOURCE_CHANGED'] : []),
    ...(!consistencyStable ? ['LIFECYCLE_CAPTURE_NOT_STABLE'] : []),
    ...(!allCellsCurrent ? ['ONE_OR_MORE_PDP1_CELLS_NOT_CURRENT'] : []),
    ...externalContracts.blockers,
    ...(!semanticReviewCarryForward ? ['CURRENT_FULL_DENOMINATOR_SEMANTIC_REVIEW_NOT_ESTABLISHED'] : []),
    ...(!historicalStatusValid ? ['HISTORICAL_PDP1_STATUS_INCONSISTENT_OR_OUTSTANDING_TASKS'] : []),
    ...(ownerDirection.status !== 'APPROVED_DESIGN_DIRECTION' ? ['DELEGATED_PDP1_DESIGN_DIRECTION_MISSING_OR_CONTRADICTORY'] : []),
    ...(pinReview.unclassifiedStatusPins.length ? ['UNCLASSIFIED_HISTORICAL_STATUS_PINS'] : []),
    ...(pinReview.unclassifiedSemanticPins.length ? ['UNCLASSIFIED_HISTORICAL_SEMANTIC_REVIEW_PINS'] : []),
    ...((census.integrityIssues ?? []).map((issue) => `P1_CENSUS:${issue}`)),
    ...((!Array.isArray(testOutcomes) || !testOutcomesValid) ? ['REQUIRED_PDP1_TEST_OR_PARITY_OUTCOME_INVALID'] : []),
  ];
  const sourceCurrentnessPass = sourceBlockers.length === 0;
  const currentStatus = sourceCurrentnessPass ? 'DEV_COMPLETE' : 'IN_PROGRESS';
  const requiredTestOutcomes = [requiredTest, localExperienceCheck, strictParity, definitionOnly].filter(Boolean);
  const observation = {
    schemaVersion: 'media.discovery-pdp1-currentness-observation.v1',
    observationId: `MEDIA-PDP1-CURRENTNESS-${suffix.toUpperCase()}`,
    observedAt: new Date().toISOString(),
    campaign: {
      repository: 'samujjwal/ghatana-media',
      branch: git(['branch', '--show-current']),
      observedHead: git(['rev-parse', 'HEAD']),
      observedOriginMain: git(['rev-parse', 'origin/main']),
      scope: 'Repository-wide Media Discovery; PDP-1 only.',
      baselineSha: status.mainSha,
    },
    phase: 'PDP-1',
    decisionInputs: {
      matrix: {
        path: matrixPath,
        sha256: matrixDigest,
        excludedFromPdp1MaterialPathDenominator: true,
        currentPdp0Cut: {
          phaseExit: matrix.currentCut?.phaseExit ?? null,
          currentnessObservation: matrix.currentCut?.currentnessObservation ?? null,
          phaseExitRecordId: matrix.currentCut?.phaseExitRecordId ?? null,
          materialSourceSetFingerprint: matrix.currentCut?.materialSourceSetFingerprint ?? null,
          matchesValidatedPredecessor: matrixCutMatches,
        },
      },
    },
    predecessor: {
      phase: 'PDP-0',
      ...p0Predecessor,
      status: p0ExitValid ? 'PASS' : 'FAIL',
      sharedSourcePathChecks: predecessorSharedPathChecks,
      sharedSourcePathMismatchCount: predecessorSharedPathMismatches.length,
    },
    ownerStatusJoin,
    developmentStatus: {
      status: currentStatus,
      historicalStatus: status.status,
      historicalMainSha: status.mainSha,
      historicalOutstandingMeaningIds: status.outstandingMeaningIds ?? [],
      outstandingMeaningIds: sourceCurrentnessPass ? [] : sourceBlockers,
      currentMaterialSourceSetFingerprint: materialSourceSetFingerprint,
      sourceIdentityCount: census.identityIds?.length ?? 0,
      sourceRecordCount: census.sourceRecordCount ?? {},
    },
    authority: {
      delegatedOwnerDirection: ownerDirection,
      exactPdp1SourceCutOwnerAcceptance: 'NOT_RECORDED',
      independentHumanOrQualifiedSignoff: 'NOT_CLAIMED',
      historicalSemanticReviewRef: reviewPath,
      currentSemanticReviewContinuity: semanticReviewCarryForward ? pinReview.continuityDecision : 'BLOCKED',
      semanticReviewPopulation: {
        currentIdentityCount: census.identityIds?.length ?? 0,
        historicalReviewedIdentityCount: semanticReview.reviewedIdentityIds?.length ?? 0,
        exactIdentitySetMatches: censusIdentitySetMatches,
        outstandingMeaningIds: semanticReview.outstandingMeaningIds ?? [],
      },
      historicalPinReview: pinReview,
      runtimeAdmission: 'NOT_CLAIMED',
      fourAgentTools: 'NOT_ADMITTED',
    },
    sourceCurrentness: {
      status: sourceCurrentnessPass ? 'PASS' : 'FAIL',
      sourceCurrent: sourceCurrentnessPass,
      lifecycle: {
        authoritySchema: technical.authoritySchema,
        captureModel: technical.captureModel,
        continuity: technical.continuity,
        sourceToken: technical.sourceToken,
        contentFingerprint: technical.contentFingerprint,
        pathMembershipDigest: technical.pathMembershipDigest,
        consistencyStable,
        zeroWorkEligibleAtCapture: technical.zeroWorkEligible,
        lifecyclePriming: primingSummary,
        consistencyCaptures: consistencySummary,
        blockers: lifecycleBlockers,
      },
      denominators: { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: currentCells.length },
      materialPathDenominator: {
        uniquePaths: Object.keys(sourceSetByPath).length,
        sharedPaths: sharedMaterialPaths.length,
        cellSpecificPaths: Object.keys(sourceSetByPath).length - sharedMaterialPaths.length,
      },
      sharedMaterialPaths,
      sourceContentDigests: sourceSetByPath,
      ownerGraphFingerprint: dimensions.ownerGraphFingerprint,
      physicalCatalogFingerprint: dimensions.physicalCatalogFingerprint,
      providerRegistryFingerprint: dimensions.providerRegistryFingerprint,
      materialSourceSetFingerprint,
      externalOwnerContracts: externalContracts,
      cells: currentCells,
      blockers: sourceBlockers,
    },
    testRun: {
      runner: testRun.runner,
      startedHead: testRun.startedHead,
      completedHead: testRun.completedHead,
      sourceBinding: testRun.sourceBinding,
      outcomes: requiredTestOutcomes,
    },
    strictAdmission: {
      status: strictParity?.status ?? 'NOT_RECORDED',
      blockingFinding: strictParity?.unresolvedFinding ?? 'NOT_RECORDED',
      disposition: 'OWNER_ACCEPTANCE_AND_RUNTIME_ADMISSION; NOT_A_PDP1_MEANING_DEFECT',
      fourAgentTools: ['av.speech-to-text', 'av.text-to-speech', 'av.vision-analysis', 'av.multimodal-inference'].map((toolId) => ({ toolId, status: 'NOT_ADMITTED' })),
    },
    phaseExit: {
      status: sourceCurrentnessPass ? 'PASS' : 'FAIL',
      sourceCurrentness: sourceCurrentnessPass ? 'PASS' : 'FAIL',
      developmentStatus: currentStatus,
      delegatedOwnerDirection: ownerDirection.status,
      exactCutOwnerAcceptance: 'NOT_RECORDED',
      requiredChecks: testOutcomesValid ? 'PASS_WITH_EXPECTED_STRICT_ADMISSION_FINDING' : 'FAIL',
      blockers: sourceBlockers,
      nextLegalAction: sourceCurrentnessPass ? 'ADVANCE_TO_PDP2_MDC20' : 'REPAIR_MDC11_OR_MDC12_BLOCKERS_AND_RECAPTURE_PDP1',
    },
    independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
    lifecycleClosure: 'NOT_ENTERED',
    build: 'NOT_ENTERED',
    delivery: 'BLOCKED',
  };
  return observation;
}

const PDP0_3_PHASE_CELL_MATRIX_PATH = 'docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json';

export function resolvePdp1PredecessorPaths({ matrix = readJson(PDP0_3_PHASE_CELL_MATRIX_PATH), explicitExitPath = null } = {}) {
  const exitPath = matrix?.currentCut?.phaseExit;
  const currentnessPath = matrix?.currentCut?.currentnessObservation;
  const isSafeRepositoryRef = (ref) => typeof ref === 'string'
    && !path.isAbsolute(ref) && !ref.startsWith('../') && !ref.includes('\\')
    && path.relative(root, path.resolve(root, ref)).split(path.sep).join('/') === ref;
  if (!isSafeRepositoryRef(exitPath) || !isSafeRepositoryRef(currentnessPath)
      || !exitPath.startsWith('docs/implementation/observations/media-discovery-pdp0-exit-')
      || !currentnessPath.startsWith('docs/implementation/observations/media-discovery-pdp0-currentness-')
      || exitPath.replace('-exit-', '-currentness-') !== currentnessPath) {
    throw new Error('The PDP-0 matrix current cut must reference a safe, paired exit and currentness receipt.');
  }
  if (explicitExitPath !== null) {
    const suppliedAbsolutePath = path.resolve(root, explicitExitPath);
    const suppliedPath = path.relative(root, suppliedAbsolutePath).split(path.sep).join('/');
    if (!isSafeRepositoryRef(suppliedPath)) {
      throw new Error('PDP-0 predecessor path must resolve inside the repository.');
    }
    if (suppliedPath !== exitPath) {
      throw new Error(`Explicit PDP-0 predecessor must match the live matrix current cut: ${exitPath}.`);
    }
  }
  return { exitPath, currentnessPath };
}

function main() {
  const suffix = process.argv[2];
  const p0ExitArgument = process.argv[3];
  const additionalImpactArgument = process.argv[4];
  let predecessorPaths;
  try {
    predecessorPaths = resolvePdp1PredecessorPaths({ explicitExitPath: p0ExitArgument ?? null });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const { exitPath: p0ExitPath } = predecessorPaths;
  if (!/^[a-z0-9-]+$/u.test(suffix ?? '')) {
    process.stderr.write('Usage: node scripts/record-media-discovery-pdp1-phase-exit.mjs <fresh-cut-suffix> [pdp0-exit-path] [additional-source-impact-json]\n');
    process.exitCode = 2;
    return;
  }
  let additionalSourceImpactPath = null;
  if (additionalImpactArgument) {
    const absoluteImpactPath = path.resolve(root, additionalImpactArgument);
    additionalSourceImpactPath = path.relative(root, absoluteImpactPath).split(path.sep).join('/');
    if (!additionalSourceImpactPath || additionalSourceImpactPath.startsWith('../') || path.isAbsolute(additionalSourceImpactPath)
        || additionalSourceImpactPath !== CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH) {
      process.stderr.write(`Additional PDP-1 source impact path must be ${CURRENT_CUT_ADDITIONAL_SOURCE_IMPACT_PATH}.\n`);
      process.exitCode = 2;
      return;
    }
  }
  const outputPath = `docs/implementation/observations/media-discovery-pdp1-exit-${suffix}.json`;
  if (fs.existsSync(path.join(root, outputPath))) throw new Error(`Refusing to overwrite immutable observation: ${outputPath}`);
  const p0Exit = readJson(p0ExitPath);
  const dimensions = {
    ownerGraphFingerprint: p0Exit.sourceCurrentness.ownerGraphFingerprint,
    physicalCatalogFingerprint: p0Exit.sourceCurrentness.physicalCatalogFingerprint,
    providerRegistryFingerprint: p0Exit.sourceCurrentness.providerRegistryFingerprint,
  };
  const testRun = runRequiredChecks(dimensions);
  const observation = makeObservation({ suffix, testRun, p0ExitPath, additionalSourceImpactPath });
  const absolutePath = path.join(root, outputPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const descriptor = fs.openSync(absolutePath, 'wx');
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(observation, null, 2)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
  process.stdout.write(`${JSON.stringify({ outputPath, phaseExit: observation.phaseExit, materialSourceSetFingerprint: observation.sourceCurrentness.materialSourceSetFingerprint, cellCount: observation.sourceCurrentness.cells.length }, null, 2)}\n`);
  if (observation.phaseExit.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
