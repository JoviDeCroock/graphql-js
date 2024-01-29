import type { Maybe } from '../jsutils/Maybe.js';

import type {
  ArgumentNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  SelectionSetNode,
  ValueNode,
  VariableDefinitionNode,
} from '../language/ast.js';
import { Kind } from '../language/kinds.js';
import { visit } from '../language/visitor.js';

/**
 * Replaces all fragment argument values with non-fragment-scoped values.
 *
 * NOTE: fragment arguments are scoped to the fragment they're defined on.
 * Therefore, after we apply the passed-in arguments, all remaining variables
 * must be either operation defined variables or explicitly unset.
 */
export function substituteFragmentArguments(
  def: FragmentDefinitionNode,
  fragmentSpread: FragmentSpreadNode,
): Record<string, any> {
  const fragmentDefinitionVariables = def.variableDefinitions;
  if (fragmentDefinitionVariables == null || fragmentDefinitionVariables.length === 0) {
    return def.selectionSet;
  }

  const substitutions = new Map<string, ValueNode>();
  if (fragmentSpread.arguments) {
    for (const argument of fragmentSpread.arguments) {
      substitutions.set(argument.name.value, argument.value);
    }
  }

  return fragmentDefinitionVariables.reduce((acc, variableDefinition) => {
    const key = variableDefinition.variable.name.value;
    const value = substitutions.get(variableDefinition.variable.name.value);
    if (value) {
      return { ...acc, [key]: value }
    }

    if (variableDefinition.defaultValue) {
      return { ...acc, [key]: variableDefinition.defaultValue };
    }

    return acc;
  })

  return fragmentArgumentSubstitutions(
    fragmentDefinitionVariables,
    fragmentSpread.arguments,
  );
}

export function fragmentArgumentSubstitutions(
  variableDefinitions: ReadonlyArray<VariableDefinitionNode>,
  argumentValues: Maybe<ReadonlyArray<ArgumentNode>>,
): Map<string, ValueNode> {
  const substitutions = new Map<string, ValueNode>();
  if (argumentValues) {
    for (const argument of argumentValues) {
      substitutions.set(argument.name.value, argument.value);
    }
  }

  for (const variableDefinition of variableDefinitions) {
    const argumentName = variableDefinition.variable.name.value;
    if (substitutions.has(argumentName)) {
      continue;
    }

    const defaultValue = variableDefinition.defaultValue;
    if (defaultValue) {
      substitutions.set(argumentName, defaultValue);
    } else {
      // We need a way to allow unset arguments without accidentally
      // replacing an unset fragment argument with an operation
      // variable value. Fragment arguments must always have LOCAL scope.
      //
      // To remove this hack, we need to either:
      //    - include fragment argument scope when evaluating fields
      //    - make unset fragment arguments invalid
      // Requiring the spread to pass all non-default-defined arguments is nice,
      // but makes field argument default values impossible to use.
      substitutions.set(argumentName, {
        kind: Kind.VARIABLE,
        name: { kind: Kind.NAME, value: '__UNSET' },
      });
    }
  }
  return substitutions;
}
