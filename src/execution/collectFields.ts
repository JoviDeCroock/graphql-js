import { AccumulatorMap } from '../jsutils/AccumulatorMap.js';
import { invariant } from '../jsutils/invariant.js';
import type { ObjMap } from '../jsutils/ObjMap.js';

import type {
  FieldNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  OperationDefinitionNode,
  SelectionSetNode,
  ValueNode,
} from '../language/ast.js';
import { OperationTypeNode } from '../language/ast.js';
import { Kind } from '../language/kinds.js';

import type { GraphQLObjectType } from '../type/definition.js';
import { isInputType } from '../type/definition.js';
import { isAbstractType } from '../type/definition.js';
import {
  GraphQLDeferDirective,
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
} from '../type/directives.js';
import type { GraphQLSchema } from '../type/schema.js';

import { typeFromAST } from '../utilities/typeFromAST.js';
import { valueFromAST } from '../utilities/valueFromAST.js';
import { valueFromASTUntyped } from '../utilities/valueFromASTUntyped.js';

import { getDirectiveValues } from './values.js';

export interface DeferUsage {
  label: string | undefined;
  parentDeferUsage: DeferUsage | undefined;
}

export interface FieldDetails {
  node: FieldNode;
  deferUsage: DeferUsage | undefined;
  fragmentVariableValues?: ObjMap<unknown> | undefined
}

interface CollectFieldsContext {
  schema: GraphQLSchema;
  fragments: ObjMap<FragmentDefinitionNode>;
  operation: OperationDefinitionNode;
  runtimeType: GraphQLObjectType;
  visitedFragmentNames: Set<string>;
  variableValues: { [variable: string]: unknown },
}

/**
 * Given a selectionSet, collects all of the fields and returns them.
 *
 * CollectFields requires the "runtime type" of an object. For a field that
 * returns an Interface or Union type, the "runtime type" will be the actual
 * object type returned by that field.
 *
 * @internal
 */
export function collectFields(
  schema: GraphQLSchema,
  fragments: ObjMap<FragmentDefinitionNode>,
  variableValues: { [variable: string]: unknown },
  runtimeType: GraphQLObjectType,
  operation: OperationDefinitionNode,
): Map<string, ReadonlyArray<FieldDetails>> {
  const groupedFieldSet = new AccumulatorMap<string, FieldDetails>();
  const context: CollectFieldsContext = {
    schema,
    fragments,
    runtimeType,
    variableValues,
    operation,
    visitedFragmentNames: new Set(),
  };

  collectFieldsImpl(context, operation.selectionSet, groupedFieldSet, variableValues);
  return groupedFieldSet;
}

/**
 * Given an array of field nodes, collects all of the subfields of the passed
 * in fields, and returns them at the end.
 *
 * CollectSubFields requires the "return type" of an object. For a field that
 * returns an Interface or Union type, the "return type" will be the actual
 * object type returned by that field.
 *
 * @internal
 */
// eslint-disable-next-line max-params
export function collectSubfields(
  schema: GraphQLSchema,
  fragments: ObjMap<FragmentDefinitionNode>,
  variableValues: { [variable: string]: unknown },
  operation: OperationDefinitionNode,
  returnType: GraphQLObjectType,
  fieldDetails: ReadonlyArray<FieldDetails>,
): Map<string, ReadonlyArray<FieldDetails>> {
  const context: CollectFieldsContext = {
    schema,
    fragments,
    runtimeType: returnType,
    variableValues,
    operation,
    visitedFragmentNames: new Set(),
  };
  const subGroupedFieldSet = new AccumulatorMap<string, FieldDetails>();

  for (const fieldDetail of fieldDetails) {
    const node = fieldDetail.node;
    if (node.selectionSet) {
      collectFieldsImpl(
        context,
        node.selectionSet,
        subGroupedFieldSet,
        undefined,
        fieldDetail.deferUsage,
      );
    }
  }

  return subGroupedFieldSet;
}

// eslint-disable-next-line max-params
function collectFieldsImpl(
  context: CollectFieldsContext,
  selectionSet: SelectionSetNode,
  groupedFieldSet: AccumulatorMap<string, FieldDetails>,
  fragmentVariableValues?: ObjMap<unknown>,
  parentDeferUsage?: DeferUsage,
  deferUsage?: DeferUsage,
): void {
  const {
    schema,
    fragments,
    runtimeType,
    variableValues,
    operation,
    visitedFragmentNames,
  } = context;

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        const vars = fragmentVariableValues ?? variableValues;
        if (!shouldIncludeNode(vars, selection)) {
          continue;
        }
        groupedFieldSet.add(getFieldEntryKey(selection), {
          node: selection,
          deferUsage: deferUsage ?? parentDeferUsage,
          fragmentVariableValues: fragmentVariableValues ?? undefined,
        });
        break;
      }
      case Kind.INLINE_FRAGMENT: {
        if (
          !shouldIncludeNode(variableValues, selection) ||
          !doesFragmentConditionMatch(schema, selection, runtimeType)
        ) {
          continue;
        }

        const newDeferUsage = getDeferUsage(
          operation,
          variableValues,
          selection,
          parentDeferUsage,
        );

        collectFieldsImpl(
          context,
          selection.selectionSet,
          groupedFieldSet,
          fragmentVariableValues,
          parentDeferUsage,
          newDeferUsage ?? deferUsage,
        );

        break;
      }
      case Kind.FRAGMENT_SPREAD: {
        const fragmentName = selection.name.value;

        const newDeferUsage = getDeferUsage(
          operation,
          variableValues,
          selection,
          parentDeferUsage,
        );

        if (
          !newDeferUsage &&
          (visitedFragmentNames.has(fragmentName) ||
            !shouldIncludeNode(variableValues, selection))
        ) {
          continue;
        }

        const fragment = fragments[fragmentName];
        if (
          fragment == null ||
          !doesFragmentConditionMatch(schema, fragment, runtimeType)
        ) {
          continue;
        }

        if (!newDeferUsage) {
          visitedFragmentNames.add(fragmentName);
        }

        // We need to introduce a concept of shadowing:
        //
        // - when a fragment defines a variable that is in the parent scope but not given
        //   in the fragment-spread we need to look at this variable as undefined and check
        //   whether the definition has a defaultValue, if not remove it from the variableValues.
        // - when a fragment does not define a variable we need to copy it over from the parent
        //   scope as that variable can still get used in spreads later on in the selectionSet.
        // - when a value is passed in through the fragment-spread we need to copy over the key-value
        //   into our variable-values.
        if (fragment.variableDefinitions) {
          const rawVariables: ObjMap<unknown> = {};

          const argumentValueLookup = new Map<string, ValueNode>();
          if (selection.arguments) {
            for (const argument of selection.arguments) {
              argumentValueLookup.set(argument.name.value, argument.value);
            }
          }

          for (const variableDefinition of fragment.variableDefinitions) {
            const variableName = variableDefinition.variable.name.value;
            const value = argumentValueLookup.get(variableName);
            if (value) {
              const varType = typeFromAST(context.schema, variableDefinition.type);
              if (varType && isInputType(varType)) {
                const argumentValue = valueFromAST(value, varType, { ...variableValues, ...fragmentVariableValues });
                rawVariables[variableName] = argumentValue
                continue;
              }
            } else if (variableDefinition.defaultValue) {
              rawVariables[variableName] = valueFromASTUntyped(variableDefinition.defaultValue, { ...variableValues, ...fragmentVariableValues });
            }
          }

          collectFieldsImpl(
            context,
            fragment.selectionSet,
            groupedFieldSet,
            rawVariables,
            parentDeferUsage,
            newDeferUsage ?? deferUsage,
          );
        } else {
          collectFieldsImpl(
            context,
            fragment.selectionSet,
            groupedFieldSet,
            undefined,
            parentDeferUsage,
            newDeferUsage ?? deferUsage,
          );
        }
        break;
      }
    }
  }
}

/**
 * Returns an object containing the `@defer` arguments if a field should be
 * deferred based on the experimental flag, defer directive present and
 * not disabled by the "if" argument.
 */
function getDeferUsage(
  operation: OperationDefinitionNode,
  variableValues: { [variable: string]: unknown },
  node: FragmentSpreadNode | InlineFragmentNode,
  parentDeferUsage: DeferUsage | undefined,
): DeferUsage | undefined {
  const defer = getDirectiveValues(GraphQLDeferDirective, node, variableValues);

  if (!defer) {
    return;
  }

  if (defer.if === false) {
    return;
  }

  invariant(
    operation.operation !== OperationTypeNode.SUBSCRIPTION,
    '`@defer` directive not supported on subscription operations. Disable `@defer` by setting the `if` argument to `false`.',
  );

  return {
    label: typeof defer.label === 'string' ? defer.label : undefined,
    parentDeferUsage,
  };
}

/**
 * Determines if a field should be included based on the `@include` and `@skip`
 * directives, where `@skip` has higher precedence than `@include`.
 */
function shouldIncludeNode(
  variableValues: { [variable: string]: unknown },
  node: FragmentSpreadNode | FieldNode | InlineFragmentNode,
): boolean {
  const skip = getDirectiveValues(GraphQLSkipDirective, node, variableValues);
  if (skip?.if === true) {
    return false;
  }

  const include = getDirectiveValues(
    GraphQLIncludeDirective,
    node,
    variableValues,
  );
  if (include?.if === false) {
    return false;
  }
  return true;
}

/**
 * Determines if a fragment is applicable to the given type.
 */
function doesFragmentConditionMatch(
  schema: GraphQLSchema,
  fragment: FragmentDefinitionNode | InlineFragmentNode,
  type: GraphQLObjectType,
): boolean {
  const typeConditionNode = fragment.typeCondition;
  if (!typeConditionNode) {
    return true;
  }
  const conditionalType = typeFromAST(schema, typeConditionNode);
  if (conditionalType === type) {
    return true;
  }
  if (isAbstractType(conditionalType)) {
    return schema.isSubType(conditionalType, type);
  }
  return false;
}

/**
 * Implements the logic to compute the key of a given field's entry
 */
function getFieldEntryKey(node: FieldNode): string {
  return node.alias ? node.alias.value : node.name.value;
}
