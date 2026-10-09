import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { evaluatePdpTransition } from "../scripts/lib/pdp1-transition-guard-definition-evaluator.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const transitions = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/transitions.yaml"), "utf8"));
const states = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/states.yaml"), "utf8"));
const guards = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/transition-guard-contracts.yaml"), "utf8"));
const matrix = transitions.ownerMachineRaceApplicability;
const allTransitions = [...transitions.transitionRecords, ...transitions.ownerDefinedTransitionRecords];
const byId = new Map(guards.records.map((record) => [record.transitionId, record]));

function setPositiveFacts(expression, facts = {}) {
  if (expression.fact) setFact(facts,expression.fact,true);
  else if (expression.all) expression.all.forEach((child) => setPositiveFacts(child, facts));
  else if (expression.any) { setPositiveFacts(expression.any[0],facts); expression.any.slice(1).forEach(child=>setFalseFacts(child,facts)); }
  else if (expression.not) setFact(facts,expression.not.fact,false);
  return facts;
}
function setFact(facts,fact,value){
  if(fact==="tenant.matches"){facts.tenant={requestTenantId:value?"tenant-a":"tenant-a",resourceTenantId:value?"tenant-a":"tenant-b"};return;}
  if(fact==="expectedVersionMatches"){facts.version={expected:"rev-2",current:value?"rev-2":"stale"};return;}
  if(fact==="expectedVersionConflicts"){facts.version={expected:"rev-2",current:value?"stale":"rev-2"};return;}
  if(fact==="consentPerEffectCurrent"){facts.consent={status:value?"ACTIVE":"REVOKED",current:value,tenantId:"tenant-a",purposes:["media.process"]};return;}
  facts.guardFacts[fact]=value;
}
function setFalseFacts(expression,facts={tenant:{requestTenantId:"tenant-a",resourceTenantId:"tenant-a"},guardFacts:{}}){
  if(expression.fact)setFact(facts,expression.fact,false);
  else if(expression.all)setFalseFacts(expression.all[0],facts);
  else if(expression.any)expression.any.forEach(child=>setFalseFacts(child,facts));
  else if(expression.not)setFact(facts,expression.not.fact,true);
  return facts;
}
function setInvalidFacts(expression,facts={tenant:{requestTenantId:"tenant-a",resourceTenantId:"tenant-a"},guardFacts:{}}){
  if(expression.fact)setFact(facts,expression.fact,"not-a-boolean");
  else if(expression.all)expression.all.forEach(child=>setInvalidFacts(child,facts));
  else if(expression.any)expression.any.forEach(child=>setInvalidFacts(child,facts));
  else if(expression.not)setInvalidFacts(expression.not,facts);
  return facts;
}
function clearFacts(expression,facts={tenant:{requestTenantId:"tenant-a",resourceTenantId:"tenant-a"},guardFacts:{}}){
  if(expression.fact)removeFact(facts,expression.fact);
  else if(expression.all)expression.all.forEach(child=>clearFacts(child,facts));
  else if(expression.any)expression.any.forEach(child=>clearFacts(child,facts));
  else if(expression.not)clearFacts(expression.not,facts);
  return facts;
}
function collectOperators(node,found=[]){if(!node||typeof node!=="object")return found;if(node.any)found.push({kind:"any",node});if(node.not)found.push({kind:"not",node});for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(child=>collectOperators(child,found));else if(value&&typeof value==="object")collectOperators(value,found);}return found;}
function fixture(edge) {
  const facts = setPositiveFacts(edge.when,{tenant:{requestTenantId:"tenant-a",resourceTenantId:"tenant-a"},version:{expected:"rev-2",current:"rev-2"},consent:{status:"ACTIVE",current:true,tenantId:"tenant-a",purposes:["media.process"]},purpose:"media.process",guardFacts:{}});
  return facts;
}
function falseFact(facts, fact) {
  if (fact === "expectedVersionMatches") facts.version.current = "stale";
  else if (fact === "expectedVersionConflicts") facts.version.current = facts.version.expected;
  else if (fact === "consentPerEffectCurrent") { facts.consent.status="REVOKED"; facts.consent.current=false; }
  else facts.guardFacts[fact]=false;
}
function removeFact(facts, fact) {
  if (fact === "expectedVersionMatches" || fact === "expectedVersionConflicts") delete facts.version;
  else if (fact === "consentPerEffectCurrent") delete facts.consent;
  else delete facts.guardFacts[fact];
}
function mandatoryFacts(expression, found = new Set(), optional=false) {
  if (expression.fact) { if (!optional && expression.fact !== "tenant.matches") found.add(expression.fact); return [...found]; }
  if (expression.all) expression.all.forEach((node) => mandatoryFacts(node,found,optional));
  if (expression.any) expression.any.forEach((node) => mandatoryFacts(node,found,true));
  if (expression.not) mandatoryFacts(expression.not,found,true);
  return [...found];
}
function evaluate(id, from, to, facts) { return evaluatePdpTransition({transitions,states,guardContracts:guards,transitionId:id,from,to,facts}); }

test("race applicability accounts for all 11 machines, 87 states and 55 source/owner edges", () => {
  assert.equal(matrix.id, "media.pdp1.race-applicability-by-machine.v1");
  assert.equal(matrix.coverage.machineCount, 11);
  assert.equal(matrix.coverage.sourceAndOwnerStateCount, 87);
  assert.equal(matrix.coverage.sourceAndOwnerTransitionCount, 55);
  assert.equal(matrix.coverage.guardContractCount, 55);
  assert.equal(matrix.records.length, states.stateMachines.length);
  assert.equal(new Set(matrix.records.map((row) => row.machineId)).size, 11);
  assert.deepEqual(Object.keys(matrix.records[0].raceApplicability).sort(), ["cancelRace","deliveryAck","externalEffect","providerDispatch","retry","staleFence"]);
  for (const machine of states.stateMachines) {
    const row=matrix.records.find((x)=>x.machineId===machine.machineId);
    const stateCount=machine.stateDefinitions?.length ?? Object.values(machine.stateDefinitionsByDimension??{}).flat().length;
    const edgeList=allTransitions.filter((edge)=>edge.sourceMachineId===machine.machineId);
    assert.equal(row.stateCount,stateCount,machine.machineId);
    assert.equal(row.transitionCount,edgeList.length,machine.machineId);
    assert.equal(row.transitionGuardContractRefs.length,edgeList.length,machine.machineId);
    assert.equal(row.stateRefs.length,stateCount,machine.machineId);
    for(const ref of row.stateRefs){
      const id=ref.split("/@id=").at(-1);
      assert.ok((machine.stateDefinitions??Object.values(machine.stateDefinitionsByDimension??{}).flat()).some((state)=>state.id===id),`resolves exact state ref ${ref}`);
    }
    assert.deepEqual(new Set(row.transitionGuardContractRefs),new Set(edgeList.map((edge)=>`.product-experience/pdp-1-domain-data/transition-guard-contracts.yaml#records/@id=${guards.records.find((record)=>record.transitionId===edge.id).id}`)));
    for(const axis of Object.values(row.raceApplicability)){
      assert.ok(["APPLICABLE","NOT_APPLICABLE"].includes(axis.disposition));
      if(axis.disposition==="NOT_APPLICABLE") assert.ok(matrix.rationaleCodeSemantics[axis.rationaleCode],`${machine.machineId} has exact N/A rationale`);
    }
    assert.match(row.unknownResolution, /unknown|uncertainty/i);
  }
});

test("all 55 transitions allow each declared legal edge and reject every forbidden source pair", () => {
  assert.equal(allTransitions.length,55);
  assert.equal(guards.records.length,55);
  let testedEdges=0,negativePredicates=0;
  for(const transition of allTransitions){
    const contract=byId.get(transition.id);
    assert.ok(contract,`${transition.id} resolves exact guard contract`);
    assert.equal(contract.sourceMachineId,transition.sourceMachineId);
    for(const edge of contract.edgeRules){
      assert.ok(transition.from.includes(edge.from)&&transition.to.includes(edge.to));
      assert.equal(evaluate(transition.id,edge.from,edge.to,fixture(edge)).allowed,true,`${transition.id} ${edge.from}->${edge.to}`);
      for(const fact of mandatoryFacts(edge.when)){
        const denied=fixture(edge); falseFact(denied,fact);
        assert.equal(evaluate(transition.id,edge.from,edge.to,denied).allowed,false,`${transition.id} rejects ${fact}`);
        const missing=fixture(edge); removeFact(missing,fact);
        assert.equal(evaluate(transition.id,edge.from,edge.to,missing).allowed,false,`${transition.id} fails closed without ${fact}`);
        negativePredicates++;
      }
      testedEdges++;
    }
    const machine=states.stateMachines.find(item=>item.machineId===transition.sourceMachineId);
    const stateRows=machine.stateDefinitionsByDimension?machine.stateDefinitionsByDimension[transition.stateDimension]??[]:machine.stateDefinitions??[];
    const stateIds=stateRows.map(row=>row.id);
    const legal=new Set(contract.edgeRules.map(edge=>`${edge.from}\0${edge.to}`));
    // Test the full cartesian product, not just a hand-picked path. On a
    // dimensioned machine, include names from all its dimensions too; a label
    // from another dimension must not become valid by string substitution.
    const everyMachineState=(machine.stateDefinitionsByDimension
      ? Object.values(machine.stateDefinitionsByDimension).flat()
      : machine.stateDefinitions??[]);
    const allStateIds=[...new Set(everyMachineState.map(row=>row.id))];
    for(const from of allStateIds)for(const to of allStateIds){
      if(!legal.has(`${from}\0${to}`))assert.equal(evaluate(transition.id,from,to,fixture(contract.edgeRules[0])).allowed,false,`${transition.id} forbids ${from}->${to}`);
    }
    assert.equal(evaluate(transition.id,"__unknown_state__",transition.to[0],fixture(contract.edgeRules[0])).allowed,false,`${transition.id} rejects unknown source state`);
    assert.equal(evaluate(transition.id,transition.from[0],"__unknown_state__",fixture(contract.edgeRules[0])).allowed,false,`${transition.id} rejects unknown target state`);
    const foreign=states.stateMachines.find(item=>item.machineId!==transition.sourceMachineId);
    const foreignState=(foreign.stateDefinitions??Object.values(foreign.stateDefinitionsByDimension??{}).flat())[0]?.id;
    if(foreignState)assert.equal(evaluate(transition.id,foreignState,transition.to[0],fixture(contract.edgeRules[0])).allowed,false,`${transition.id} rejects foreign machine/dimension state`);
    // Changing the declared machine or dimension in an otherwise matching
    // source record is source drift and must never widen the transition.
    const driftedTransitions=structuredClone(transitions);
    const driftedRecord=[...driftedTransitions.transitionRecords,...driftedTransitions.ownerDefinedTransitionRecords].find(row=>row.id===transition.id);
    driftedRecord.sourceMachineId=foreign.machineId;
    assert.equal(evaluatePdpTransition({transitions:driftedTransitions,states,guardContracts:guards,transitionId:transition.id,from:contract.edgeRules[0].from,to:contract.edgeRules[0].to,facts:fixture(contract.edgeRules[0])}).allowed,false,`${transition.id} rejects machine-name substitution`);
    if(transition.stateDimension!==undefined){
      const changedDimension=structuredClone(transitions);
      const dimensionRecord=[...changedDimension.transitionRecords,...changedDimension.ownerDefinedTransitionRecords].find(row=>row.id===transition.id);
      dimensionRecord.stateDimension=`${transition.stateDimension}-foreign`;
      assert.equal(evaluatePdpTransition({transitions:changedDimension,states,guardContracts:guards,transitionId:transition.id,from:contract.edgeRules[0].from,to:contract.edgeRules[0].to,facts:fixture(contract.edgeRules[0])}).allowed,false,`${transition.id} rejects dimension substitution`);
    }
    for(const edge of contract.edgeRules)for(const {kind,node}of collectOperators(edge.when)){
      if(kind==="any"){
        assert.equal(evaluate(transition.id,edge.from,edge.to,setFalseFacts(node)).allowed,false,`${transition.id} does not pass when all any-alternatives are false`);
        assert.equal(evaluate(transition.id,edge.from,edge.to,clearFacts(node)).allowed,false,`${transition.id} any does not hide unknown alternatives`);
        assert.equal(evaluate(transition.id,edge.from,edge.to,setInvalidFacts(node)).allowed,false,`${transition.id} any does not hide invalid alternatives`);
      }
      else{
        const negated=node.not.fact;
        const falseOperand=fixture(edge);setFact(falseOperand,negated,false);
        const absent=fixture(edge);removeFact(absent,negated);
        const present=fixture(edge);setFact(present,negated,true);
        const invalid=fixture(edge);setFact(invalid,negated,"not-a-boolean");
        assert.equal(evaluate(transition.id,edge.from,edge.to,falseOperand).allowed,true,`${transition.id} NOT accepts only a known false operand`);
        assert.equal(evaluate(transition.id,edge.from,edge.to,absent).allowed,false,`${transition.id} NOT rejects unknown operand`);
        assert.equal(evaluate(transition.id,edge.from,edge.to,present).allowed,false,`${transition.id} NOT rejects true operand`);
        assert.equal(evaluate(transition.id,edge.from,edge.to,invalid).allowed,false,`${transition.id} NOT rejects invalid operand`);
      }
    }
  }
  assert.ok(testedEdges>55);
  assert.ok(negativePredicates>250);
});
