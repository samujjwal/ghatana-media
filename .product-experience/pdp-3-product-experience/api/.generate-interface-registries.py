from pathlib import Path
import re
import yaml
import subprocess

root = Path('.product-experience/pdp-3-product-experience')

def write(folder, name, body):
    path = root / folder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body.rstrip() + '\n')

# OpenAPI operations are taken directly from the canonical OpenAPI document.
openapi = yaml.safe_load(Path('contracts/openapi/media.yaml').read_text())
operations = []
for path, path_item in openapi['paths'].items():
    for method, operation in path_item.items():
        if method.lower() in {'get', 'post', 'put', 'patch', 'delete'}:
            operations.append((method.upper(), path, operation.get('operationId', 'operation-id-owner-review-pending'), operation))
api = ['schemaVersion: media.api-registry.v1', 'productId: media', 'source: contracts/openapi/media.yaml', 'status: source-inventory; experience-bindings-pending-owner-review', 'operations:']
for method, path, opid, operation in operations:
    api += [f'  - id: media.http.{opid}', f'    method: {method}', f'    path: "{path}"', f'    operationId: {opid}']
    if operation.get('summary'):
        api += ['    summary: "' + str(operation['summary']).replace('"', "'") + '"']
    params = [p.get('name') for p in operation.get('parameters', []) if p.get('name')]
    api += ['    parameters: [' + ', '.join(params) + ']']
    body_ref = operation.get('requestBody', {}).get('content', {}).get('application/json', {}).get('schema', {}).get('$ref')
    api += ['    requestSchema: ' + (body_ref if body_ref else 'none')]
    responses = operation.get('responses', {})
    api += ['    responseStatuses: [' + ', '.join(str(s) for s in responses) + ']']
    api += ['    experienceBinding: pending-owner-review']
write('api', 'api-registry.yaml', '\n'.join(api))

# Include all repository proto RPCs, preserving their actual service and file identity.
protos = sorted(Path('.').glob('**/*.proto'))
rpc_rows = []
for proto in protos:
    if any(part in {'.git', 'node_modules', 'build', 'target', 'archive'} for part in proto.parts):
        continue
    source = proto.read_text(errors='ignore')
    package = re.search(r'^package\s+([^;]+);', source, re.M)
    for svc, body in re.findall(r'service\s+(\w+)\s*\{(.*?)\}', source, re.S):
        for match in re.finditer(r'rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)', body):
            rpc, reqstream, req, respstream, resp = match.groups()
            rpc_rows.append((proto.as_posix(), package.group(1) if package else 'package-owner-review-pending', svc, rpc, req, resp, bool(reqstream), bool(respstream)))
grpc = ['schemaVersion: media.grpc-service-registry.v1', 'productId: media', 'status: active-source-inventory; requested-43-count-exceeds-26-active-proto-rpcs; owner-reconciliation-pending', 'sourceRule: every-rpc-is-derived-from-a-non-archived-repository-proto-service-declaration', 'observedRpcCount: ' + str(len(rpc_rows)), 'requestedRpcCount: 43', 'unresolvedRpcCount: ' + str(max(0, 43-len(rpc_rows))), 'rpcs:']
for source, package, service, rpc, req, resp, client_stream, server_stream in rpc_rows:
    grpc += [f'  - id: media.grpc.{service}.{rpc}', f'    service: {service}', f'    method: {rpc}', f'    package: {package}', f'    source: {source}', f'    request: {req}', f'    response: {resp}', f'    clientStreaming: {str(client_stream).lower()}', f'    serverStreaming: {str(server_stream).lower()}', '    experienceBinding: pending-owner-review']
write('grpc', 'service-registry.yaml', '\n'.join(grpc))

# Production SDK public methods; internal and private methods are deliberately excluded.
sdk_source = Path('libs/audio-video-client/src/operations.ts').read_text()
sdk_index = Path('libs/audio-video-client/src/index.ts').read_text()
sdk_operation_api = sdk_source[sdk_source.find('export class MediaOperationHandle'):]
sdk_client_api = sdk_index[sdk_index.find('export class AudioVideoClient'):sdk_index.find('export function createAudioVideoClient')]
sdk_rows = [m for m in re.findall(r'\bpublic\s+(?:async\s+)?([A-Za-z_]\w*)\s*\(', sdk_operation_api + '\n' + sdk_client_api) if m != 'constructor']
sdk_rows += [m for m in re.findall(r'^\s+(?:async\s+)?([A-Za-z_]\w*)\s*\(', sdk_client_api, re.M) if m != 'constructor' and m not in {'emitEvent', 'requireConfig', 'callService', 'toError', 'shouldRetry', 'extractStatusCode', 'calculateBackoffDelay'}]
sdk = ['schemaVersion: media.sdk-method-registry.v1', 'productId: media', 'source: libs/audio-video-client/src/operations.ts', 'status: public-method-inventory; full-language-bindings-pending-owner-review', 'methods:']
for method in dict.fromkeys(sdk_rows):
    source = 'libs/audio-video-client/src/index.ts' if re.search(r'\bpublic\s+(?:async\s+)?' + re.escape(method) + r'\s*\(', sdk_client_api) else 'libs/audio-video-client/src/operations.ts'
    sdk += [f'  - id: media.sdk.{method}', f'    method: {method}', '    visibility: public', f'    source: {source}', '    experienceBinding: pending-owner-review']
write('sdk', 'operation-registry.yaml', '\n'.join(sdk))

# Actual four registered agent tool handler IDs.
tools = ['av.speech-to-text', 'av.text-to-speech', 'av.vision-analysis', 'av.multimodal-inference']
handlers = ['SpeechToTextToolHandler', 'TextToSpeechToolHandler', 'VisionAnalysisToolHandler', 'MultimodalInferenceToolHandler']
tool_doc = ['schemaVersion: media.tool-registry.v1', 'productId: media', 'status: four-registered-tool-handlers; contracts-and-experience-bindings-pending-owner-review', 'source: libs/common/src/main/java/com/ghatana/audio/video/tools', 'tools:']
for tool, handler in zip(tools, handlers):
    tool_doc += [f'  - id: {tool}', f'    handler: {handler}', '    registration: AudioVideoToolHandlerFactory', '    experienceBinding: pending-owner-review']
write('agent-tools', 'tool-registry.yaml', '\n'.join(tool_doc))

# Lifecycle event vocabulary as observed in the implemented SDK event emitter and service code.
event_sources = [Path('libs/audio-video-client/src/index.ts')]
events_found = set()
for source in event_sources:
    text = source.read_text()
    events_found.update(re.findall(r'(?:emitEvent|addEventListener|removeEventListener)\(\s*[`\'\"]([^`\'\"]+)', text))
events = ['schemaVersion: media.event-registry.v1', 'productId: media', 'status: observed-runtime-events; domain-lifecycle-coverage-pending-owner-review', 'sources:', '  - libs/audio-video-client/src/index.ts', 'events:']
for event in sorted(events_found):
    events += [f'  - id: media.event.{event}', f'    eventName: "{event}"', '    lifecycleMeaning: pending-owner-review', '    finalityAndOrdering: pending-owner-review']
write('events', 'event-registry.yaml', '\n'.join(events))

# Governed service inventory is explicitly source-bound and does not imply qualification.
service_files = sorted(Path('modules').glob('**/*Service.java'))
services = ['schemaVersion: media.service-registry.v1', 'productId: media', 'status: implementation-inventory; ownership-and-qualification-pending-review', 'serviceRule: implementation-presence-does-not-imply-public-contract-or-qualification', 'services:']
for source in service_files:
    text = source.read_text(errors='ignore')
    package = re.search(r'^package\s+([\w.]+);', text, re.M)
    classes = re.findall(r'\b(?:public\s+)?(?:final\s+)?class\s+(\w+Service)\b', text)
    for cls in dict.fromkeys(classes):
        services += [f'  - id: media.service.{cls}', f'    implementation: {((package.group(1) + ".") if package else "")}{cls}', f'    source: {source.as_posix()}', '    owner: pending-owner-review', '    qualification: not-inferred']
write('services', 'service-registry.yaml', '\n'.join(services))

# Keep the fixture simulator's finite command inventory distinct from production CLI claims.
cli_source = Path('libs/media-experience-simulation/src/cli.ts').read_text()
registry_source = root / 'cli' / 'command-registry.yaml'
current = registry_source.read_text()
help_block = re.search(r'  Commands:\n(.*?)\n\nGlobal option:', cli_source, re.S)
command_lines = re.findall(r'^  (.+)$', help_block.group(1), re.M) if help_block else []
cli_doc = ['schemaVersion: media.command-registry.v1', 'productId: media', 'status: implemented-local-fixture-command-simulator; production-runtime-cli-not-connected', 'executionScope: deterministic-synthetic-fixtures-only; no-Media-runtime-or-provider-connection', 'source: libs/media-experience-simulation/src/cli.ts', 'commands:']
for command_line in command_lines:
    command, options = command_line.split(' --', 1)
    command = command.strip()
    flags = re.findall(r'(--[a-z][a-z0-9-]*)', '--' + options)
    slug = re.sub(r'[^a-z0-9]+', '-', command.lower()).strip('-')
    cli_doc += [f'  - id: media.fixture-cli.{slug}', f'    canonicalCommand: "ghatana-media {command}"', '    options: [' + ', '.join(flags) + ']', '    execution: synthetic-fixture-only']
cli_doc += ['globalOptions:', '  - --format human|json|jsonl', '  - --scenario <fixture-id>', 'productionCliDisposition: no-production-cli-command-claims-in-this-fixture-registry']
write('cli', 'command-registry.yaml', '\n'.join(cli_doc))

# Expand all canonical baseline and selected-lane contracts from the staged post-move source.
registry = (root / 'screen-registry.yaml').read_text()
canonical = list(dict.fromkeys(re.findall(r'^  - (screen-contracts/[^\n]+)$', registry, re.M)))
pattern_catalog = yaml.safe_load(Path('.product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml').read_text())
known_patterns = {item['id'].split('.')[-1]: item['id'] for item in pattern_catalog.get('patterns', [])}
token_catalog = yaml.safe_load(Path('.product-experience/pdp-2-design-interface-system/media-token-aliases.yaml').read_text())
known_tokens = {item['id'].removeprefix('media.token.'): item['id'] for item in token_catalog.get('aliases', [])}
for ref in canonical:
    path = root / ref
    original = subprocess.check_output(['git', 'show', ':' + path.as_posix()], text=True)
    contract = yaml.safe_load(original)
    slug = path.stem
    if any(word in slug for word in ('job-status', 'check-job-outcome', 'transcription-progress')):
        pattern_key = 'job-status-and-recovery'
    elif any(word in slug for word in ('import-media', 'upload')):
        pattern_key = 'upload-and-verification'
    elif any(word in slug for word in ('caption', 'transcript', 'speech')):
        pattern_key = 'caption-editor' if 'caption' in slug and 'compare' not in slug else 'transcript-and-playback'
    elif any(word in slug for word in ('compare', 'exact-version')):
        pattern_key = 'version-comparison'
    elif any(word in slug for word in ('rights', 'consent', 'voice')):
        pattern_key = 'rights-and-consent-review'
    elif 'provenance' in slug:
        pattern_key = 'provenance-and-lineage'
    elif any(word in slug for word in ('quality', 'inspect-output', 'inspect-media')):
        pattern_key = 'quality-and-uncertainty'
    elif 'source' in slug:
        pattern_key = 'source-picker'
    elif 'project' in slug or slug == 'resume-work':
        pattern_key = 'project-browser'
    elif any(word in slug for word in ('create', 'compose', 'render', 'plan')):
        pattern_key = 'creation-plan-review'
    else:
        pattern_key = 'safe-confirmation-and-unknown-outcome'
    states = set(contract.get('states', []))
    token_keys = []
    if states & {'completed', 'complete', 'verified', 'saved'}: token_keys.append('state.completed')
    if states & {'queued', 'running', 'transferring', 'in-progress', 'saving'}: token_keys.append('state.in-progress')
    if states & {'needs-review', 'review-required', 'approval-required', 'owner-review-required'}: token_keys.append('state.needs-review')
    if states & {'blocked', 'failed', 'denied', 'unavailable'}: token_keys.append('state.blocked')
    if any(word in slug for word in ('source', 'provenance', 'inspect', 'compare')): token_keys += ['trust.measured', 'surface.source', 'surface.derived']
    token_ids = list(dict.fromkeys(known_tokens[key] for key in token_keys if key in known_tokens)) or ['media.token.state.needs-review']
    channel = contract.get('channel', 'media.channel.owner-review-pending')
    actions = contract.get('actions', [])
    journeys = contract.get('journeyRefs', [])
    fixtures = contract.get('fixtureRefs', [])
    purpose = str(contract.get('purpose', 'Owner-defined screen purpose')).replace('"', "'")
    additions = [
        'surfaceContract:', f'  surfaceRef: {channel}', '  status: channel-and-host-rendering-owner-review-pending',
        'templateContract:', f'  templateRef: media.template.{contract.get("screenId", "media.view.owner-review-pending").split(".")[-1]}', '  kind: template-owner-review-pending',
        'layoutContract:', '  primaryRegion: intent-and-context', '  supportingRegions: anatomy-list-order', '  responsiveRuleRef: existing-responsive-description',
        'patternRefs:', f'  - {known_patterns.get(pattern_key, "media.gui.pattern.safe-confirmation-and-unknown-outcome")}',
        'tokenRefs:', *[f'  - {item}' for item in token_ids], 'domainRefs:', '  - media.domain.media',
        'actionRefs:', *([f'  - {item}' for item in actions] or ['  - media.action.owner-review-pending']),
        'operationRefs:', '  - media.operation.owner-review-pending',
        'stateContract:', '  sourceStates: existing-screen-states', '  transitionAuthority: owning-domain-contract-pending-review',
        'entryExitContract:', f'  entry: {purpose}', '  exit: explicit-action-or-navigation; preserve-current-resource-identity', '  journeyRefs:',
        *([f'    - {item}' for item in journeys] or ['    - owner-review-pending']),
        'consequenceContract:', '  actionEffects: resolved-by-operation-owner-before-production-binding', '  uncertainty: retain-current-identities-and-show-explicit-unknown-finality', '  destructiveOrExternalEffects: require-current-authority-and-owner-confirmation',
        'responsiveContract:', '  behavior: ' + str(contract.get('responsive', 'owner-review-pending')).replace('\n', ' '),
        'fixtureContract:', '  fixtureRefs:', *([f'    - {item}' for item in fixtures] or ['    - pending-owner-fixture-review']),
        'verificationContract:', '  checks:', '    - schema-and-reference-integrity', '    - keyboard-and-responsive-coverage', '    - state-and-recovery-fixture-coverage', '  ownerReview: pending',
    ]
    path.write_text(original.rstrip() + '\n' + '\n'.join(additions) + '\n')
