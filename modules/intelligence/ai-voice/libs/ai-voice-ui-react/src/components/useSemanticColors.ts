import { semanticColorRoles } from "@ghatana/tokens/semantic-roles";
import { useTheme } from "@ghatana/theme/react";

/** Use the host's resolved color mode and Shared's semantic color authority. */
export function useSemanticColors() {
  const { resolvedTheme } = useTheme();
  return semanticColorRoles[resolvedTheme];
}
