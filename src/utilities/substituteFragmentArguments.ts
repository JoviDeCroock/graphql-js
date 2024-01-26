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
): SelectionSetNode {
  const fragmentVariableDefinitions = def.variableDefinitions;
  if (fragmentVariableDefinitions == null || fragmentVariableDefinitions.length === 0) {
    return def.selectionSet;
  }

  // We check whether we have arguments given by the fragment-spread
  // we then replace our variable definitions in the fragment-definition
  // with the values passed in by the spread.
  const argumentValues = fragmentArgumentSubstitutions(
    fragmentVariableDefinitions,
    fragmentSpread.arguments,
  );

  return visit(def.selectionSet, {
    Variable(node) {
      return argumentValues.get(node.name.value);
    },
  });
}

export function fragmentArgumentSubstitutions(
  variableDefinitions: ReadonlyArray<VariableDefinitionNode>,
  argumentValues: Maybe<ReadonlyArray<ArgumentNode>>,
): Map<string, ValueNode>  {
  const substitutions = new Map<string, ValueNode>();
  if (argumentValues) {
    for (const argument of argumentValues) {
      substitutions.set(argument.name.value, argument.value);
    }
  }

  for (const variableDefinition of variableDefinitions) {
    const variableName = variableDefinition.variable.name.value;
    if (substitutions.has(variableName)) {
      continue;
    }

    const defaultValue = variableDefinition.defaultValue;
    if (defaultValue) {
      substitutions.set(variableName, defaultValue);
    } else {
      // We need a way to allow unset arguments without accidentally
      // replacing an unset fragment argument with an operation
      // variable value. Fragment arguments must always have LOCAL scope.
      //
      // TODO: To remove this hack, we need to either:
      //    - include fragment argument scope when evaluating fields
      //    - make unset fragment arguments invalid
      //
      // Requiring the spread to pass all non-default-defined arguments is nice,
      // but makes field argument default values impossible to use.
      substitutions.set(variableName, {
        kind: Kind.VARIABLE,
        name: { kind: Kind.NAME, value: '__UNSET' },
      });
    }
  }
  return substitutions;
}
