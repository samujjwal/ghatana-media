const PRIMARY = [
  "media.navigation.destination.home",
  "media.navigation.destination.projects",
  "media.navigation.destination.assets",
  "media.navigation.destination.activity",
];
const UTILITY = [
  "media.navigation.utility.settings",
  "media.navigation.utility.account",
  "media.navigation.utility.help",
];
const GUARDS = [
  "media.navigation.guard.authorization-before-protected-load",
  "media.navigation.guard.no-provider-global-destination",
  "media.navigation.guard.navigation-does-not-dispatch",
  "media.navigation.guard.identity-and-workspace-are-separate",
];

function exactMembers(actual, expected, field) {
  if (!Array.isArray(actual) || actual.length !== expected.length ||
      new Set(actual).size !== actual.length || expected.some((value) => !actual.includes(value))) {
    throw new Error(`${field} must contain exactly the owner-defined navigation identities`);
  }
}

/** Validate the bounded Media default-navigation definition; this does not test a rendered UI. */
export function validateMediaDefaultNavigationRule(informationArchitecture) {
  const records = informationArchitecture?.normativeRuleRecords;
  if (!Array.isArray(records)) throw new Error("normativeRuleRecords is required");
  const matches = records.filter((record) => record?.id === "media.navigation.default-global-and-utility-placement.v1");
  if (matches.length !== 1) throw new Error("exactly one Media default-navigation rule is required");
  const rule = matches[0];
  exactMembers(rule.primaryNavigation, PRIMARY, "primaryNavigation");
  exactMembers(rule.utilityNavigation, UTILITY, "utilityNavigation");
  exactMembers(rule.guardrailIds, GUARDS, "guardrailIds");
  if (rule.scope !== "default-product-navigation-placement" ||
      rule.status !== "MEDIA_OWNER_DEFINITION_ONLY; independent-PDP3-review-open; runtime-NOT_ADMITTED") {
    throw new Error("navigation scope or admission boundary drifted");
  }
  if (!Array.isArray(rule.negativeCases) || rule.negativeCases.length < 4) {
    throw new Error("negativeCases must cover provider, utility, access, and dispatch boundaries");
  }
  return true;
}
