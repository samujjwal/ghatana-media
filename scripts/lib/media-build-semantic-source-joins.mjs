import fs from 'node:fs';
import yaml from 'yaml';

const P0 = '.product-experience/pdp-0-product-truth';
const P1 = '.product-experience/pdp-1-domain-data';
const P2 = '.product-experience/pdp-2-design-interface-system';
const P3 = '.product-experience/pdp-3-product-experience';

const parseYaml = (root, path) => yaml.parse(fs.readFileSync(`${root}/${path}`, 'utf8'));
const asArray = value => Array.isArray(value) ? value : [];
const selector = (path, collection, id) => `${path}#${collection}/@id=${id}`;

function indexById(records) {
  return new Map(asArray(records).filter(x => x && typeof x.id === 'string').map(x => [x.id, x]));
}

function exactIdSelectors(value, path, result = new Map()) {
  if (Array.isArray(value)) value.forEach((item, index) => exactIdSelectors(item, `${path}/${index}`, result));
  else if (value && typeof value === 'object') {
    if (typeof value.id === 'string') result.set(value.id, { selector: `${path}/@id=${value.id}`, record: value });
    for (const [key, child] of Object.entries(value)) exactIdSelectors(child, `${path}/${key}`, result);
  }
  return result;
}

function exactRefs(record, fields) {
  const refs = [];
  for (const field of fields) {
    const value = record?.[field];
    for (const ref of Array.isArray(value) ? value : (typeof value === 'string' ? [value] : [])) {
      if (typeof ref === 'string' && ref && ref !== 'UNBOUND') refs.push({ field, ref });
    }
  }
  return refs;
}

function selectorTarget(reference) {
  if (typeof reference !== 'string') return reference;
  const match = reference.match(/@id=([^/#]+)(?:\/|$)/);
  return match ? match[1] : reference;
}

function fieldJoin(joins, phase, relation, sourceRef, targetId) {
  if (!joins[relation]) joins[relation] = [];
  joins[relation].push({ phase, id: targetId, sourceRef });
}

/**
 * Build relations only from named, source-declared reference fields. ID equality
 * is used only to dereference an exact ID/ref; labels and semantic-name guesses
 * are never consulted. Missing selectors stay visible as blocker slots.
 */
export function buildSemanticSourceJoins({ root, traceRows }) {
  const capsPath = `${P0}/capabilities.yaml`;
  const reqPath = `${P0}/requirements.yaml`;
  const opsPath = `${P1}/operations.yaml`;
  const domainObjectsPath = `${P1}/domain-objects.yaml`;
  const actionPath = `${P3}/action-registry.yaml`;
  const statesPath = `${P1}/states.yaml`;
  const transitionsPath = `${P1}/transitions.yaml`;
  const guardsPath = `${P1}/transition-guard-contracts.yaml`;
  const handoffPath = `${P1}/handoff-contracts.yaml`;
  const purposePath = `${P3}/journey-purpose-bindings.yaml`;
  const channelPath = `${P3}/journey-channel-contract-bindings.yaml`;
  const componentPath = `${P2}/component-contracts.yaml`;
  const templatePath = `${P2}/gui/templates/catalog.yaml`;
  const recipePath = `${P2}/gui/recipes/catalog.yaml`;
  const layoutPath = `${P2}/gui/layout.yaml`;
  const patternPath = `${P2}/gui/patterns/catalog.yaml`;
  const journeyPath = `${P3}/journey-registry.yaml`;
  const screenPath = `${P3}/screen-registry.yaml`;
  const componentValuePath = `${P2}/component-value-types.yaml`;
  const tokenPath = `${P2}/media-token-aliases.yaml`;
  const compositionGrammarPath = `${P2}/gui/composition-validation-grammar.yaml`;
  const interfaceGrammarPath = `${P2}/interface-grammar.yaml`;
  const topologyPath = '.product-experience/surfaces/media-physical-topology.v1.json';
  const statusPaths = [0, 1, 2, 3].map(i => `docs/implementation/pdp-${i}-phase-dev-status.json`);

  const caps = parseYaml(root, capsPath);
  const reqs = parseYaml(root, reqPath);
  const ops = parseYaml(root, opsPath);
  const domainObjects = parseYaml(root, domainObjectsPath);
  const actions = parseYaml(root, actionPath);
  const states = parseYaml(root, statesPath);
  const transitions = parseYaml(root, transitionsPath);
  const guards = parseYaml(root, guardsPath);
  const handoffs = parseYaml(root, handoffPath);
  const purposes = parseYaml(root, purposePath);
  const channels = parseYaml(root, channelPath);
  const components = parseYaml(root, componentPath);
  const templates = parseYaml(root, templatePath);
  const recipes = parseYaml(root, recipePath);
  const layouts = parseYaml(root, layoutPath);
  const patterns = parseYaml(root, patternPath);
  const journeys = parseYaml(root, journeyPath);
  const screens = parseYaml(root, screenPath);
  const componentValueTypes = parseYaml(root, componentValuePath);
  const tokenAliases = parseYaml(root, tokenPath);
  const compositionGrammar = parseYaml(root, compositionGrammarPath);
  const interfaceGrammar = parseYaml(root, interfaceGrammarPath);
  const topology = JSON.parse(fs.readFileSync(`${root}/${topologyPath}`, 'utf8'));
  const statuses = statusPaths.map(path => JSON.parse(fs.readFileSync(`${root}/${path}`, 'utf8')));

  const capRecords = indexById(caps.capabilities);
  const reqRecords = indexById(reqs.requirements);
  const familyRecords = indexById(caps.families);
  const purposeRecords = indexById(purposes.records);
  const channelRecords = indexById(channels.edges);
  const componentRecords = indexById(components.components);
  const templateRecords = indexById(templates.templates);
  const recipeRecords = indexById(recipes.recipes);
  const layoutRecords = indexById(layouts.layouts);
  const patternRecords = indexById(patterns.patterns);
  const journeyRecords = indexById(journeys.journeys ?? journeys.records);
  const screenRecords = indexById(screens.screens ?? screens.records);
  const screenAndLaneViewRecords = indexById([...asArray(screens.screens), ...asArray(screens.laneViews)]);
  const componentValueRecords = exactIdSelectors(componentValueTypes, `${componentValuePath}#`);
  const tokenRecords = exactIdSelectors(tokenAliases, `${tokenPath}#`);
  const compositionRuleRecords = indexById(compositionGrammar.normativeRuleRecords);
  const interfaceInvariantSelectors = new Set(Object.keys(interfaceGrammar.invariants ?? {}).map(key => `${interfaceGrammarPath}#invariants/${key}`));
  const capOperationRecords = asArray(ops.capabilityOperationContracts?.records);
  const capabilityBoundRecords = asArray(ops.capabilityOperationContracts?.bounds);
  const inputPayloadRecords = asArray(ops.capabilityOperationContracts?.inputPayloadSchemas);
  const outputPayloadRecords = asArray(ops.capabilityOperationContracts?.outputPayloadSchemas);
  const ownerJourneyOperationRecords = asArray(ops.ownerDefinedJourneyOperationBindings?.records);
  const operationsRecords = [...asArray(ops.operations), ...asArray(ops.individualOperationContracts?.records), ...asArray(ops.ownerDefinedOperationContracts?.records)];
  const operationIndex = new Map(operationsRecords.filter(record => record.id).map(record => [record.id, record]));
  const domainObjectRecords = indexById(domainObjects.objects);
  const actionSelectors = new Map(asArray(actions.actions).filter(record => record?.id).map(record => [record.id, `${actionPath}#actions/@id=${record.id}`]));
  const operationSelectors = new Map([
    ...asArray(ops.operations).map(r => [r.id, `${opsPath}#operations/@id=${r.id}`]),
    ...asArray(ops.individualOperationContracts?.records).map(r => [r.id, `${opsPath}#individualOperationContracts/records/@id=${r.id}`]),
    ...asArray(ops.ownerDefinedOperationContracts?.records).map(r => [r.id, `${opsPath}#ownerDefinedOperationContracts/records/@id=${r.id}`])
  ]);
  const stateMachineRecords = asArray(states.stateMachines);
  const transitionRecords = [...asArray(transitions.transitionRecords), ...asArray(transitions.ownerDefinedTransitionRecords)];
  const guardRecords = asArray(guards.records);
  const handoffRecords = exactIdSelectors(handoffs, `${handoffPath}#`);

  const p1StatusIds = new Set(statuses[1].sourceIdentityIds ?? []);
  const p0CapIds = new Set(capRecords.keys());
  const p0RequirementIds = new Set(familyRecords.size ? [...familyRecords.values()].map(x => x.requirementId).filter(Boolean) : reqRecords.keys());
  const p2IdSets = {
    'p2-components': new Set(componentRecords.keys()),
    'p2-templates': new Set(templateRecords.keys()),
    'p2-recipes': new Set(recipeRecords.keys()),
    'p2-layouts': new Set(layoutRecords.keys()),
    'p2-patterns': new Set(patternRecords.keys())
  };
  const p3JourneyIds = new Set(journeyRecords.keys());
  const p3PurposeIds = new Set(purposeRecords.keys());
  const p3ChannelIds = new Set(channelRecords.keys());
  const topologyRows = [
    ...asArray(topology.manifestCandidates).map((r, i) => ({ ...r, phase: 'TOPOLOGY', kind: 'physical', sourceRef: `${topologyPath}#/manifestCandidates/${i}` })),
    ...asArray(topology.compositions).map((r, i) => ({ ...r, phase: 'TOPOLOGY', kind: r.kind === 'REPOSITORY_ROOT' ? 'REPOSITORY_ROOT' : 'SEMANTIC_COMPOSITION', sourceRef: `${topologyPath}#/compositions/${i}` })),
    ...asArray(topology.consumerCrosswalk).map((r, i) => ({ ...r, phase: 'TOPOLOGY', kind: 'consumer', sourceRef: `${topologyPath}#/consumerCrosswalk/${i}` }))
  ];
  const topologyIndex = new Map(topologyRows.map(row => [row.surfaceId, row]));
  const sourceFiles = [capsPath, reqPath, opsPath, domainObjectsPath, actionPath, statesPath, transitionsPath, guardsPath, handoffPath, purposePath, channelPath, componentPath, templatePath, recipePath, layoutPath, patternPath, journeyPath, screenPath, componentValuePath, tokenPath, compositionGrammarPath, interfaceGrammarPath, topologyPath, ...statusPaths];
  const yamlDocuments = new Map([[capsPath, caps], [reqPath, reqs], [opsPath, ops], [domainObjectsPath, domainObjects], [actionPath, actions], [statesPath, states], [transitionsPath, transitions], [guardsPath, guards], [handoffPath, handoffs], [purposePath, purposes], [channelPath, channels], [componentPath, components], [templatePath, templates], [recipePath, recipes], [layoutPath, layouts], [patternPath, patterns], [journeyPath, journeys], [screenPath, screens], [componentValuePath, componentValueTypes], [tokenPath, tokenAliases], [compositionGrammarPath, compositionGrammar], [interfaceGrammarPath, interfaceGrammar]]);
  const sourceSelectorExists = reference => {
    if (typeof reference !== 'string' || !reference.includes('#')) return false;
    const [path, fragment] = reference.split('#', 2);
    if (!path || !fs.existsSync(`${root}/${path}`)) return false;
    let document = yamlDocuments.get(path);
    if (!document) {
      try { document = path.endsWith('.json') ? JSON.parse(fs.readFileSync(`${root}/${path}`, 'utf8')) : parseYaml(root, path); yamlDocuments.set(path, document); }
      catch { return false; }
    }
    let value = document;
    let parts = (fragment ?? '').replace(/^\//, '').split('/').filter(Boolean).map(x => x.replaceAll('~1', '/').replaceAll('~0', '~'));
    if (fragment?.startsWith('/')) parts = fragment.slice(1).split('/').filter(Boolean).map(x => x.replaceAll('~1', '/').replaceAll('~0', '~'));
    for (const part of parts) {
      if (part.startsWith('@') && part.includes('=')) {
        const [field, ...rest] = part.slice(1).split('='); const expected = rest.join('=');
        if (Array.isArray(value)) value = value.find(item => item?.[field] === expected);
        else if (value && typeof value === 'object') value = Object.values(value).find(item => item?.[field] === expected);
      } else if (Array.isArray(value) && /^\d+$/.test(part)) value = value[Number(part)];
      else if (value && typeof value === 'object' && Object.hasOwn(value, part)) value = value[part];
      else return false;
      if (value === undefined) return false;
    }
    return value !== undefined;
  };
  const exactStateMachineTarget = reference => {
    if (typeof reference !== 'string') return null;
    // Several canonical PDP-1 selectors intentionally use the bare machine id.
    // Resolve only an exact machineId; never infer from state labels.
    if (stateMachineRecords.some(record => record.machineId === reference)) return reference;
    const prefix = `${statesPath}#`;
    if (reference.startsWith(prefix)) {
      const frag = reference.slice(prefix.length);
      const m = frag.match(/^stateMachines\/(?:@machineId=)?([^/]+)/);
      if (m && stateMachineRecords.some(record => record.machineId === m[1])) return m[1];
      const exact = frag.match(/^([^/]+)$/);
      if (exact && stateMachineRecords.some(record => record.machineId === exact[1])) return exact[1];
    }
    const pair = reference.match(/^([^/]+)\/([^/]+)$/);
    if (pair) {
      const machine = stateMachineRecords.find(record => record.machineId === pair[1]);
      if (machine && JSON.stringify(machine.stateDefinitionsByDimension ?? machine.stateDefinitions ?? {}).includes(`"id":"${pair[2]}"`)) return pair[1];
    }
    return null;
  };

  const sourceMembership = row => {
    if (row.phase === 'PDP-0' && row.kind === 'capability-intent') return capRecords.has(row.id) ? [selector(capsPath, 'capabilities', row.id)] : [];
    if (row.phase === 'PDP-0' && row.kind === 'requirement-group') {
      const id = familyRecords.get(row.familyId)?.requirementId;
      return id === row.id && reqRecords.has(id) ? [selector(capsPath, 'families', row.familyId), selector(reqPath, 'requirements', id)] : [];
    }
    if (row.phase === 'PDP-1') {
      const exactOperationSelector = operationSelectors.get(row.id);
      if (row.kind === 'operations' && exactOperationSelector) return [exactOperationSelector];
      if (row.kind === 'capabilityOperations') {
        const record = capOperationRecords.find(x => x.id === row.id);
        if (record) return [`${opsPath}#capabilityOperationContracts/records/@id=${row.id}`];
      }
      if (row.kind === 'stateMachines' && stateMachineRecords.some(x => x.machineId === row.id)) return [`${statesPath}#stateMachines/@machineId=${row.id}`];
      if (row.kind === 'transitions') {
        const list = asArray(transitions.transitionRecords).some(x => x.id === row.id) ? 'transitionRecords' : 'ownerDefinedTransitionRecords';
        if (transitionRecords.some(x => x.id === row.id)) return [`${transitionsPath}#${list}/@id=${row.id}`];
      }
      if (row.kind === 'guardContracts' && guardRecords.some(x => x.id === row.id)) return [`${guardsPath}#records/@id=${row.id}`];
      const key = `${row.kind}:${row.id}`;
      return p1StatusIds.has(key) ? [`docs/implementation/pdp-1-phase-dev-status.json#sourceIdentityIds/${key}`] : [];
    }
    if (row.phase === 'PDP-2' && p2IdSets[row.kind]?.has(row.id)) {
      const paths = { 'p2-components': componentPath, 'p2-templates': templatePath, 'p2-recipes': recipePath, 'p2-layouts': layoutPath, 'p2-patterns': patternPath };
      const collections = { 'p2-components': 'components', 'p2-templates': 'templates', 'p2-recipes': 'recipes', 'p2-layouts': 'layouts', 'p2-patterns': 'patterns' };
      return [selector(paths[row.kind], collections[row.kind], row.id)];
    }
    if (row.phase === 'PDP-2' && row.kind === 'p2-machine-interface-invariants') {
      return interfaceInvariantSelectors.has(row.id) ? [row.id] : [];
    }
    if (row.phase === 'PDP-2' && row.kind === 'p2-component-value-types') {
      const found = componentValueRecords.get(row.id);
      return found ? [found.selector] : [];
    }
    if (row.phase === 'PDP-2' && ['p2-semantic-token-aliases', 'p2-shared-public-css', 'p2-media-css-projection'].includes(row.kind)) {
      const found = tokenRecords.get(row.id);
      return found ? [found.selector] : [];
    }
    if (row.phase === 'PDP-2' && row.kind === 'p2-composition-rules') {
      return compositionRuleRecords.has(row.id) ? [selector(compositionGrammarPath, 'normativeRuleRecords', row.id)] : [];
    }
    if (row.phase === 'PDP-3' && row.kind === 'journey-step-purpose') return purposeRecords.has(row.id) ? [selector(purposePath, 'records', row.id)] : [];
    if (row.phase === 'PDP-3' && row.kind === 'journey-channel-edge') return channelRecords.has(row.id) ? [selector(channelPath, 'edges', row.id)] : [];
    if (row.phase === 'PDP-3' && row.kind === 'journey') return journeyRecords.has(row.id) ? [selector(journeyPath, 'journeys', row.id)] : [];
    if (row.phase === 'PDP-3' && row.kind === 'screen') {
      if (screenAndLaneViewRecords.has(row.id)) {
        const collection = screens.screens.some(item => item.id === row.id) ? 'screens' : 'laneViews';
        return [selector(screenPath, collection, row.id)];
      }
      return [];
    }
    if (row.phase === 'TOPOLOGY') return topologyIndex.has(row.id) ? [topologyIndex.get(row.id).sourceRef] : [];
    return [];
  };

  const tracePhaseIds = new Set(traceRows.map(item => `${item.phase}:${item.id}`));
  const rows = traceRows.map(row => {
    const joins = {};
    const unresolvedSourceSlots = [];
    const unresolvedSourceBlockers = [];
    const sourceRecordSelectors = sourceMembership(row);
    const addRefs = (record, fields, phase, relation, allowed) => {
      for (const { field, ref } of exactRefs(record, fields)) {
        const target = selectorTarget(ref);
        if (allowed(target)) fieldJoin(joins, phase, relation, `${field}=${ref}`, target);
        else {
          const slot = `${field}=${ref}`;
          unresolvedSourceSlots.push(slot);
          unresolvedSourceBlockers.push(`UNRESOLVED_DECLARED_REFERENCE:${row.id}:${slot}`);
        }
      }
    };

    if (row.phase === 'PDP-0' && row.kind === 'capability-intent') {
      const cap = capRecords.get(row.id);
      addRefs(cap, ['requirementIds'], 'PDP-0', 'p0Requirement', ref => reqRecords.has(ref));
      for (const record of capOperationRecords.filter(x => x.capabilityRef === row.id)) {
        const recordSelector = `${opsPath}#capabilityOperationContracts/records/@id=${record.id}`;
        fieldJoin(joins, 'PDP-1', 'p1CapabilityOperation', `${recordSelector}/capabilityRef`, record.id);
        for (const ref of asArray(record.operationRefs)) fieldJoin(joins, 'PDP-1', 'p1Operation', `${recordSelector}/operationRefs`, ref);
      }
      for (const p of purposeRecords.values()) if (asArray(p.capabilityRefs).includes(row.id)) fieldJoin(joins, 'PDP-3', 'p3Purpose', `${purposePath}#records/@id=${p.id}/capabilityRefs`, p.id);
    } else if (row.phase === 'PDP-0' && row.kind === 'requirement-group') {
      const req = reqRecords.get(row.id);
      addRefs(req, ['capabilityIds'], 'PDP-0', 'p0Capability', ref => capRecords.has(ref));
      for (const p of purposeRecords.values()) if (asArray(p.requirementRefs).includes(row.id)) fieldJoin(joins, 'PDP-3', 'p3Purpose', `${purposePath}#records/@id=${p.id}/requirementRefs`, p.id);
    } else if (row.phase === 'PDP-1') {
      const sourceId = row.id;
      if (row.kind === 'capabilityOperations') {
        const binding = capOperationRecords.find(x => x.id === sourceId);
        if (binding) {
          fieldJoin(joins, 'PDP-0', 'p0Capability', `${opsPath}#capabilityOperationContracts/records/@id=${binding.id}/capabilityRef`, binding.capabilityRef);
          for (const ref of asArray(binding.operationRefs)) fieldJoin(joins, 'PDP-1', 'p1Operation', `${opsPath}#capabilityOperationContracts/records/@id=${binding.id}/operationRefs`, ref);
        }
      }
      if (row.kind === 'capabilityBounds') for (const r of capabilityBoundRecords.filter(x => x.id === sourceId)) fieldJoin(joins, 'PDP-1', 'p1CapabilityBound', `${opsPath}#capabilityOperationContracts/bounds/@id=${r.id}`, r.id);
      if (row.kind === 'capabilityInputPayloadSchemas') for (const r of inputPayloadRecords.filter(x => x.id === sourceId)) fieldJoin(joins, 'PDP-1', 'p1InputSchema', `${opsPath}#capabilityOperationContracts/inputPayloadSchemas/@id=${r.id}`, r.id);
      if (row.kind === 'capabilityOutputPayloadSchemas') for (const r of outputPayloadRecords.filter(x => x.id === sourceId)) fieldJoin(joins, 'PDP-1', 'p1OutputSchema', `${opsPath}#capabilityOperationContracts/outputPayloadSchemas/@id=${r.id}`, r.id);
      const capBindings = capOperationRecords.filter(x => asArray(x.operationRefs).includes(sourceId));
      for (const b of capBindings) fieldJoin(joins, 'PDP-0', 'p0Capability', `${opsPath}#capabilityOperationContracts/records/@id=${b.id}/operationRefs`, b.capabilityRef);
      if (row.kind === 'operations') {
        const operation = operationIndex.get(sourceId);
        const operationSource = operationSelectors.get(sourceId);
        if (operation && operationSource) {
          addRefs(operation, ['capabilityRef', 'capabilityRefs'], 'PDP-0', 'p0Capability', ref => capRecords.has(ref));
          addRefs(operation, ['requirementRefs'], 'PDP-0', 'p0Requirement', ref => reqRecords.has(selectorTarget(ref)));
          for (const stateRef of asArray(operation.stateRefs)) {
            const machineId = exactStateMachineTarget(stateRef);
            if (machineId) fieldJoin(joins, 'PDP-1', 'p1StateMachine', `${operationSource}#stateRefs`, machineId);
            else {
              unresolvedSourceSlots.push(`stateRefs=${stateRef}`);
              unresolvedSourceBlockers.push(`UNRESOLVED_P1_STATE_SELECTOR:${row.id}:${stateRef}`);
            }
          }
          for (const field of ['actionRef', 'actionRefs']) for (const actionRef of (Array.isArray(operation[field]) ? operation[field] : operation[field] ? [operation[field]] : [])) {
            const actionSelector = actionSelectors.get(actionRef);
            if (actionSelector) fieldJoin(joins, 'PDP-3', 'p3ActionSelector', `${operationSource}/${field}`, actionSelector);
            for (const purpose of purposeRecords.values()) if (purpose.actionRef === actionRef || asArray(purpose.actionExactOperationRefs).includes(sourceId)) fieldJoin(joins, 'PDP-3', 'p3Purpose', `${operationSource}/${field}`, purpose.id);
          }
          for (const { field, ref } of exactRefs(operation, ['domainObjectRefs'])) {
            const object = domainObjectRecords.get(selectorTarget(ref));
            if (object) fieldJoin(joins, 'PDP-1', 'p1DomainObjectSelector', `${operationSource}/${field}`, `${domainObjectsPath}#objects/@id=${object.id}`);
          }
          // Operation sourceRefs are documentary only unless they are valid, exact
          // selectors. Keep valid authored selectors as endpoints without guessing
          // which entity a plain path might represent.
          for (const { field, ref } of exactRefs(operation, ['sourceRefs'])) if (sourceSelectorExists(ref)) {
            const phase = ref.includes('/pdp-0-') ? 'PDP-0' : ref.includes('/pdp-1-') ? 'PDP-1' : ref.includes('/pdp-2-') ? 'PDP-2' : ref.includes('/pdp-3-') ? 'PDP-3' : 'PDP-1';
            fieldJoin(joins, phase, 'sourceSelector', `${operationSource}/${field}`, ref);
          }
        }
        for (const binding of ownerJourneyOperationRecords.filter(x => x.operationRef === sourceId)) {
          const bindingSource = `${opsPath}#ownerDefinedJourneyOperationBindings/records/@id=${binding.id}`;
          addRefs(binding, ['capabilityRefs'], 'PDP-0', 'p0Capability', ref => capRecords.has(ref));
          addRefs(binding, ['requirementRefs'], 'PDP-0', 'p0Requirement', ref => reqRecords.has(selectorTarget(ref)));
          for (const stateRef of asArray(binding.stateRefs)) {
            const machineId = exactStateMachineTarget(stateRef);
            if (machineId) fieldJoin(joins, 'PDP-1', 'p1StateMachine', `${bindingSource}#stateRefs`, machineId);
            else {
              unresolvedSourceSlots.push(`stateRefs=${stateRef}`);
              unresolvedSourceBlockers.push(`UNRESOLVED_P1_STATE_SELECTOR:${row.id}:${stateRef}`);
            }
          }
          for (const purpose of purposeRecords.values()) if (purpose.stepRef === binding.journeyStepRef) fieldJoin(joins, 'PDP-3', 'p3Purpose', `${bindingSource}#journeyStepRef`, purpose.id);
        }
      }
      if (row.kind === 'stateMachines') {
        const machine = stateMachineRecords.find(x => x.machineId === sourceId);
        if (machine) {
          for (const transition of transitionRecords.filter(x => x.sourceMachineId === sourceId)) {
            const collection = asArray(transitions.transitionRecords).some(x => x.id === transition.id) ? 'transitionRecords' : 'ownerDefinedTransitionRecords';
            fieldJoin(joins, 'PDP-1', 'p1Transition', `${transitionsPath}#${collection}/@id=${transition.id}/sourceMachineId`, transition.id);
          }
          for (const edge of channelRecords.values()) for (const field of ['p1StateRefs', 'pdp1StateOrObservationRefs']) for (const stateRef of asArray(edge[field])) if (typeof stateRef === 'string' && stateRef.includes(`${statesPath}#stateMachines/${sourceId}/`)) fieldJoin(joins, 'PDP-3', 'p3ChannelEdge', `${channelPath}#edges/@id=${edge.id}/${field}`, edge.id);
        }
      }
      if (row.kind === 'transitions') {
        const transition = transitionRecords.find(x => x.id === sourceId);
        if (transition) {
          const transitionCollection = asArray(transitions.transitionRecords).some(x => x.id === transition.id) ? 'transitionRecords' : 'ownerDefinedTransitionRecords';
          const transitionSource = `${transitionsPath}#${transitionCollection}/@id=${transition.id}`;
          fieldJoin(joins, 'PDP-1', 'p1StateMachine', `${transitionSource}/sourceMachineId`, transition.sourceMachineId);
          for (const { field, ref } of exactRefs(transition, ['operationRefs'])) {
            const target = selectorTarget(ref);
            if (operationIndex.has(target) || capOperationRecords.some(record => record.id === target) || p1StatusIds.has(`operations:${target}`) || p1StatusIds.has(`capabilityOperations:${target}`)) fieldJoin(joins, 'PDP-1', 'p1Operation', `${transitionSource}/${field}`, target);
            else { unresolvedSourceSlots.push(`${field}=${ref}`); unresolvedSourceBlockers.push(`UNRESOLVED_DECLARED_REFERENCE:${row.id}:${field}=${ref}`); }
          }
          for (const guard of guardRecords.filter(x => x.transitionId === sourceId)) fieldJoin(joins, 'PDP-1', 'p1GuardContract', `${transitionSource}/id`, guard.id);
        }
      }
      if (row.kind === 'guardContracts') {
        const guard = guardRecords.find(x => x.id === sourceId);
        if (guard) fieldJoin(joins, 'PDP-1', 'p1Transition', `${guardsPath}#records/@id=${sourceId}/sourceTransitionRef`, guard.transitionId);
      }
      if (row.kind === 'operations') {
        for (const p of purposeRecords.values()) for (const field of ['operationRefs', 'actionExactOperationRefs', 'supportingOperationRefs']) if (asArray(p[field]).includes(sourceId)) fieldJoin(joins, 'PDP-3', 'p3Purpose', `${purposePath}#records/@id=${p.id}/${field}`, p.id);
        for (const e of channelRecords.values()) for (const field of ['pdp1OperationRefs']) if (asArray(e[field]).includes(sourceId)) fieldJoin(joins, 'PDP-3', 'p3ChannelEdge', `${channelPath}#edges/@id=${e.id}/${field}`, e.id);
      }
      if (row.kind === 'stateMachines') for (const e of channelRecords.values()) {
        for (const field of ['p1StateRefs', 'pdp1StateOrObservationRefs']) for (const stateRef of asArray(e[field])) if (exactStateMachineTarget(typeof stateRef === 'string' ? stateRef : stateRef?.stateRef) === sourceId) fieldJoin(joins, 'PDP-3', 'p3ChannelEdge', `${channelPath}#edges/@id=${e.id}/${field}`, e.id);
      }
    } else if (row.phase === 'PDP-2' && row.kind === 'p2-components') {
      const component = componentRecords.get(row.id);
      addRefs(component, ['capabilityRefs'], 'PDP-0', 'p0Capability', ref => capRecords.has(ref));
      for (const ref of asArray(component?.handoffRefs)) {
        const handoffId = selectorTarget(ref); const target = handoffRecords.get(handoffId);
        if (target) fieldJoin(joins, 'PDP-1', 'p1Handoff', `${componentPath}#components/@id=${row.id}/handoffRefs`, handoffId);
        else if (sourceSelectorExists(ref)) fieldJoin(joins, 'PDP-1', 'p1HandoffSelector', `${componentPath}#components/@id=${row.id}/handoffRefs`, ref);
        else { unresolvedSourceSlots.push(`handoffRefs=${ref}`); unresolvedSourceBlockers.push(`UNRESOLVED_HANDOFF_SELECTOR:${row.id}:${ref}`); }
      }
    } else if (row.phase === 'PDP-2') {
      const record = templateRecords.get(row.id) ?? recipeRecords.get(row.id) ?? layoutRecords.get(row.id) ?? patternRecords.get(row.id);
      addRefs(record, ['recipeRefs', 'compatibleLayoutRefs', 'templateRef', 'semanticPattern', 'patterns', 'compatibleTemplateRefs'], 'PDP-2', 'p2DesignReference', ref => [templateRecords, recipeRecords, layoutRecords, patternRecords].some(m => m.has(ref)));
    } else if (row.phase === 'PDP-3' && row.kind === 'journey-step-purpose') {
      const p = purposeRecords.get(row.id);
      addRefs(p, ['capabilityRefs'], 'PDP-0', 'p0Capability', ref => capRecords.has(ref));
      addRefs(p, ['requirementRefs'], 'PDP-0', 'p0Requirement', ref => reqRecords.has(ref));
      addRefs(p, ['operationRefs', 'actionExactOperationRefs', 'supportingOperationRefs'], 'PDP-1', 'p1Operation', ref => operationIndex.has(ref) || capOperationRecords.some(record => record.id === ref) || p1StatusIds.has(`operations:${ref}`) || p1StatusIds.has(`capabilityOperations:${ref}`));
      for (const stateRef of asArray(p?.stateRefs)) {
        const machineId = exactStateMachineTarget(stateRef);
        if (machineId) fieldJoin(joins, 'PDP-1', 'p1StateMachine', `${purposePath}#records/@id=${row.id}/stateRefs`, machineId);
        else if (sourceSelectorExists(stateRef)) fieldJoin(joins, 'PDP-1', 'p1StateSelector', `${purposePath}#records/@id=${row.id}/stateRefs`, stateRef);
        else { unresolvedSourceSlots.push(`stateRefs=${stateRef}`); unresolvedSourceBlockers.push(`UNRESOLVED_P1_STATE_SELECTOR:${row.id}:${stateRef}`); }
      }
      if (p?.viewRef) {
        if (screenAndLaneViewRecords.has(p.viewRef)) fieldJoin(joins, 'PDP-3', 'p3View', `${purposePath}#records/@id=${row.id}/viewRef`, p.viewRef);
        else { unresolvedSourceSlots.push(`viewRef=${p.viewRef}`); unresolvedSourceBlockers.push(`UNRESOLVED_P3_VIEW_SELECTOR:${row.id}:${p.viewRef}`); }
      }
      if (p?.stepRef) {
        if (sourceSelectorExists(p.stepRef)) fieldJoin(joins, 'PDP-3', 'p3Step', `${purposePath}#records/@id=${row.id}/stepRef`, p.stepRef);
        else { unresolvedSourceSlots.push(`stepRef=${p.stepRef}`); unresolvedSourceBlockers.push(`UNRESOLVED_P3_STEP_SELECTOR:${row.id}:${p.stepRef}`); }
      }
    } else if (row.phase === 'PDP-3' && row.kind === 'journey-channel-edge') {
      const e = channelRecords.get(row.id);
      for (const [index, binding] of asArray(e?.p1OperationBindings).entries()) if (binding.operationRef) {
        if (operationIndex.has(binding.operationRef) || capOperationRecords.some(record => record.id === binding.operationRef)) fieldJoin(joins, 'PDP-1', 'p1Operation', `${channelPath}#edges/@id=${row.id}/p1OperationBindings/${index}/operationRef`, binding.operationRef);
        else { unresolvedSourceSlots.push(`p1OperationBindings[${index}].operationRef=${binding.operationRef}`); unresolvedSourceBlockers.push(`UNRESOLVED_P1_OPERATION_SELECTOR:${row.id}:${binding.operationRef}`); }
      }
      for (const ref of asArray(e?.pdp1OperationRefs)) {
        if (operationIndex.has(ref) || capOperationRecords.some(record => record.id === ref) || p1StatusIds.has(`operations:${ref}`) || p1StatusIds.has(`capabilityOperations:${ref}`)) fieldJoin(joins, 'PDP-1', 'p1Operation', `${channelPath}#edges/@id=${row.id}/pdp1OperationRefs`, ref);
        else { unresolvedSourceSlots.push(`pdp1OperationRefs=${ref}`); unresolvedSourceBlockers.push(`UNRESOLVED_P1_OPERATION_SELECTOR:${row.id}:${ref}`); }
      }
      for (const [field, references] of [['p1StateRefs', e?.p1StateRefs], ['pdp1StateOrObservationRefs', e?.pdp1StateOrObservationRefs]]) for (const ref of asArray(references)) {
        const stateRef = typeof ref === 'string' ? ref : ref?.stateRef ?? ref?.sourceRef;
        const machineId = exactStateMachineTarget(stateRef);
        if (machineId) fieldJoin(joins, 'PDP-1', 'p1StateMachine', `${channelPath}#edges/@id=${row.id}/${field}`, machineId);
        else if (sourceSelectorExists(stateRef)) fieldJoin(joins, 'PDP-1', 'p1StateSelector', `${channelPath}#edges/@id=${row.id}/${field}`, stateRef);
        else { unresolvedSourceSlots.push(`${field}=${stateRef ?? JSON.stringify(ref)}`); unresolvedSourceBlockers.push(`UNRESOLVED_P1_STATE_SELECTOR:${row.id}:${stateRef ?? JSON.stringify(ref)}`); }
      }
      for (const [field, references] of [['p2GrammarRefs', e?.p2GrammarRefs], ['p2GrammarRef', e?.p2GrammarRef]]) for (const ref of (Array.isArray(references) ? references : references ? [references] : [])) {
        if (sourceSelectorExists(ref)) fieldJoin(joins, 'PDP-2', 'p2GrammarSelector', `${channelPath}#edges/@id=${row.id}/${field}`, ref);
        else { unresolvedSourceSlots.push(`${field}=${ref}`); unresolvedSourceBlockers.push(`UNRESOLVED_P2_GRAMMAR_SELECTOR:${row.id}:${ref}`); }
      }
      for (const ref of asArray(e?.purposeBindingRefs)) {
        const id = ref.match(/@id=([^/#]+)/)?.[1];
        if (id && purposeRecords.has(id) && sourceSelectorExists(ref)) fieldJoin(joins, 'PDP-3', 'p3Purpose', `${channelPath}#edges/@id=${row.id}/purposeBindingRefs`, id);
        else { unresolvedSourceSlots.push(`purposeBindingRefs=${ref}`); unresolvedSourceBlockers.push(`UNRESOLVED_PURPOSE_SELECTOR:${row.id}:${ref}`); }
      }
      if (e?.consumerSurfaceId) fieldJoin(joins, 'TOPOLOGY', 'consumer', `${channelPath}#edges/@id=${row.id}/consumerSurfaceId`, e.consumerSurfaceId);
    } else if (row.phase === 'PDP-3' && row.kind === 'journey') {
      for (const p of purposeRecords.values()) if (p.journeyRef === row.id) fieldJoin(joins, 'PDP-3', 'p3Purpose', `${purposePath}#records/@id=${p.id}/journeyRef`, p.id);
      for (const e of channelRecords.values()) if (e.journeyRef === row.id) fieldJoin(joins, 'PDP-3', 'p3ChannelEdge', `${channelPath}#edges/@id=${e.id}/journeyRef`, e.id);
    } else if (row.phase === 'PDP-3' && row.kind === 'screen') {
      const screen = screenRecords.get(row.id);
      for (const journeyRef of asArray(screen?.journeyRefs)) if (journeyRecords.has(journeyRef)) fieldJoin(joins, 'PDP-3', 'p3Journey', `${screenPath}#screens/@id=${row.id}/journeyRefs`, journeyRef);
      for (const p of purposeRecords.values()) if (p.viewRef === row.id) fieldJoin(joins, 'PDP-3', 'p3Purpose', `${purposePath}#records/@id=${p.id}/viewRef`, p.id);
      // Composition links are explicitly owner-approved in screen-registry.yaml.
      // Resolve only those exact screenId/templateId/layoutIds fields.
      for (const link of asArray(screens.compositionLinkOwnerReview?.approved).filter(item => item.screenId === row.id)) {
        const linkSelector = `${screenPath}#compositionLinkOwnerReview/approved/@screenId=${row.id}`;
        if (templateRecords.has(link.templateId)) fieldJoin(joins, 'PDP-2', 'p2Template', `${linkSelector}/templateId`, link.templateId);
        for (const layoutId of asArray(link.layoutIds)) if (layoutRecords.has(layoutId)) fieldJoin(joins, 'PDP-2', 'p2Layout', `${linkSelector}/layoutIds`, layoutId);
      }
    } else if (row.phase === 'TOPOLOGY') {
      const t = topologyIndex.get(row.id);
      if (row.kind === 'consumer') for (const edge of asArray(t?.intendedChannelEdgeIds)) fieldJoin(joins, 'PDP-3', 'p3ChannelEdge', `${topologyPath}#consumerCrosswalk/@surfaceId=${row.id}/intendedChannelEdgeIds`, edge);
      if (row.kind === 'consumer') for (const ref of asArray(t?.physicalRefs)) fieldJoin(joins, 'TOPOLOGY', 'physical', `${topologyPath}#consumerCrosswalk/@surfaceId=${row.id}/physicalRefs`, ref);
    }

    // The selected identity is valid only if its owner registry has an exact selector.
    // For identities with no declared relation this blocker explicitly records the missing source slot.
    if (!sourceRecordSelectors.length) {
      unresolvedSourceSlots.push(`sourceIdentity:${row.sourceIdField ?? row.kind}=${row.id}`);
      unresolvedSourceBlockers.push(`SOURCE_MEMBERSHIP_UNRESOLVED:${row.phase}:${row.kind}:${row.id}`);
    }
    const requiresCrossLayer = row.phase === 'PDP-0' || row.phase === 'PDP-3' || (row.phase === 'PDP-1' && ['capabilityOperations', 'operations', 'guardContracts', 'stateMachines', 'transitions'].includes(row.kind));
    if (requiresCrossLayer && Object.keys(joins).length === 0) {
      unresolvedSourceSlots.push(`crossLayerRelation:${row.phase}:${row.kind}`);
      unresolvedSourceBlockers.push(`SOURCE_RELATION_UNRESOLVED:${row.phase}:${row.kind}:${row.id}`);
    }
    for (const [relation, targets] of Object.entries(joins)) for (const target of targets) {
      const key = `${target.phase}:${target.id}`;
      if (tracePhaseIds.has(key)) target.endpointClassification = 'TRACE_IDENTITY';
      else if (typeof target.id === 'string' && target.id.includes('#') && sourceSelectorExists(target.id)) {
        target.endpointClassification = 'SOURCE_SELECTOR';
        target.targetSelector = target.id;
      } else if (target.phase === 'PDP-1' && operationIndex.has(target.id)) {
        target.endpointClassification = 'SOURCE_RECORD_NOT_IN_TRACE';
        target.targetSelector = operationSelectors.get(target.id) ?? null;
        unresolvedSourceSlots.push(`traceIdentityMissing:${relation}=${target.id}`);
        unresolvedSourceBlockers.push(`REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:${row.id}:${target.id}`);
      } else if (target.phase === 'PDP-1' && handoffRecords.has(target.id)) {
        target.endpointClassification = 'SOURCE_RECORD_NOT_IN_TRACE';
        target.targetSelector = handoffRecords.get(target.id).selector;
      } else {
        target.endpointClassification = 'UNRESOLVED_ENDPOINT';
        unresolvedSourceSlots.push(`unresolvedEndpoint:${relation}=${target.id}`);
        unresolvedSourceBlockers.push(`UNRESOLVED_JOIN_ENDPOINT:${row.id}:${relation}:${target.id}`);
      }
    }
    const normalizedJoins = Object.fromEntries(Object.entries(joins).map(([key, value]) => [key, value.sort((a, b) => `${a.phase}:${a.id}:${a.sourceRef}`.localeCompare(`${b.phase}:${b.id}:${b.sourceRef}`))]));
    return {
      phase: row.phase, kind: row.kind, identity: row.id, primaryPackageId: row.primaryPackageId,
      planningStatus: 'ASSIGNED_UNVERIFIED', sourceLocator: sourceRecordSelectors[0] ?? row.sourcePath ?? row.sourceIdField ?? null,
      sourceRecordSelectors, joins: normalizedJoins,
      unresolvedSourceSlots: [...new Set(unresolvedSourceSlots)].sort(),
      unresolvedSourceBlockers: [...new Set(unresolvedSourceBlockers)].sort(), codeSymbol: { status: 'UNBOUND', value: null }
    };
  });
  const p1Keys = (statuses[1].sourceIdentityIds ?? []).map(identity => `PDP-1:${identity}`);
  const p0Keys = [
    ...[...capRecords.keys()].map(id => `PDP-0:capability-intent:${id}`),
    ...[...reqRecords.keys()].map(id => `PDP-0:requirement-group:${id}`)
  ];
  const p2Keys = [
    ...[...componentRecords.keys()].map(id => `PDP-2:p2-components:${id}`),
    ...[...templateRecords.keys()].map(id => `PDP-2:p2-templates:${id}`),
    ...[...recipeRecords.keys()].map(id => `PDP-2:p2-recipes:${id}`),
    ...[...layoutRecords.keys()].map(id => `PDP-2:p2-layouts:${id}`),
    ...[...patternRecords.keys()].map(id => `PDP-2:p2-patterns:${id}`),
    ...[...componentValueRecords.keys()].map(id => `PDP-2:p2-component-value-types:${id}`),
    ...[...tokenRecords.entries()].map(([id, found]) => {
      const kind = found.selector.includes('/aliases/') ? 'p2-semantic-token-aliases' : Object.hasOwn(found.record, 'sharedCssVariableRef') ? 'p2-media-css-projection' : Object.hasOwn(found.record, 'publicCssRef') ? 'p2-shared-public-css' : 'p2-semantic-token-aliases';
      return `PDP-2:${kind}:${id}`;
    }),
    ...[...compositionRuleRecords.keys()].map(id => `PDP-2:p2-composition-rules:${id}`),
    ...[...interfaceInvariantSelectors].map(id => `PDP-2:p2-machine-interface-invariants:${id}`)
  ];
  const p3Keys = [
    ...[...screenAndLaneViewRecords.keys()].map(id => `PDP-3:screen:${id}`),
    ...[...journeyRecords.keys()].map(id => `PDP-3:journey:${id}`),
    ...[...purposeRecords.keys()].map(id => `PDP-3:journey-step-purpose:${id}`),
    ...[...channelRecords.keys()].map(id => `PDP-3:journey-channel-edge:${id}`)
  ];
  const topologyKeys = topologyRows.map(row => `TOPOLOGY:${row.kind}:${row.surfaceId}`);
  const authoritativeIdentityKeys = [...p0Keys, ...p1Keys, ...p2Keys, ...p3Keys, ...topologyKeys].sort();
  return { rows, sourceFiles, authoritativeIdentityKeys };
}
