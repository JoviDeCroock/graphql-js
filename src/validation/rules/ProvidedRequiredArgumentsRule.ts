import { inspect } from '../../jsutils/inspect.js';

import { GraphQLError } from '../../error/GraphQLError.js';

import type {
  FieldNode,
  FragmentSpreadNode,
  InputValueDefinitionNode,
  VariableDefinitionNode,
} from '../../language/ast.js';
import { Kind } from '../../language/kinds.js';
import { print } from '../../language/printer.js';
import type { ASTVisitor } from '../../language/visitor.js';

import type { GraphQLArgument } from '../../type/definition.js';
import { isRequiredArgument, isType } from '../../type/definition.js';
import { specifiedDirectives } from '../../type/directives.js';

import type { GraphQLVariableSignature } from '../../utilities/getVariableSignature.js';

import type {
  SDLValidationContext,
  ValidationContext,
} from '../ValidationContext.js';

/**
 * Provided required arguments
 *
 * A field or directive is only valid if all required (non-null without a
 * default value) field arguments have been provided.
 */
export function ProvidedRequiredArgumentsRule(
  context: ValidationContext,
): ASTVisitor {
  return {
    // eslint-disable-next-line new-cap
    ...ProvidedRequiredArgumentsOnDirectivesRule(context),
    Field: {
      // Validate on leave to allow for deeper errors to appear first.
      leave(fieldNode) {
        const fieldDef = context.getFieldDef();
        if (!fieldDef) {
          return false;
        }

        hasRequiredArgs(context, fieldNode, fieldDef.args);
      },
    },
    FragmentSpread: {
      // Validate on leave to allow for deeper errors to appear first.
      leave(spreadNode) {
        const fragmentSignature = context.getFragmentSignature();
        if (!fragmentSignature) {
          return false;
        }

        hasRequiredArgs(
          context,
          spreadNode,
          Array.from(fragmentSignature.variableSignatures.values()),
        );
      },
    },
  };
}

function hasRequiredArgs(
  context: ValidationContext,
  node: FieldNode | FragmentSpreadNode,
  args: ReadonlyArray<GraphQLArgument | GraphQLVariableSignature>,
): void {
  const providedArgs = new Set(
    // FIXME: https://github.com/graphql/graphql-js/issues/2203
    /* c8 ignore next */
    node.arguments?.map((arg) => arg.name.value),
  );
  for (const argDef of args) {
    if (!providedArgs.has(argDef.name) && isRequiredArgument(argDef)) {
      const locatedAtStr =
        (node.kind === Kind.FIELD ? 'Field' : 'Fragment') +
        ` "${node.name.value}"`;
      const argTypeStr = inspect(argDef.type);
      context.reportError(
        new GraphQLError(
          `${locatedAtStr} argument "${argDef.name}" of type "${argTypeStr}" is required, but it was not provided.`,
          { nodes: node },
        ),
      );
    }
  }
}

/**
 * @internal
 */
export function ProvidedRequiredArgumentsOnDirectivesRule(
  context: ValidationContext | SDLValidationContext,
): ASTVisitor {
  const requiredArgsMap = new Map<
    string,
    Map<string, GraphQLArgument | InputValueDefinitionNode>
  >();

  const schema = context.getSchema();
  const definedDirectives = schema?.getDirectives() ?? specifiedDirectives;
  for (const directive of definedDirectives) {
    requiredArgsMap.set(
      directive.name,
      new Map(
        directive.args.filter(isRequiredArgument).map((arg) => [arg.name, arg]),
      ),
    );
  }

  const astDefinitions = context.getDocument().definitions;
  for (const def of astDefinitions) {
    if (def.kind === Kind.DIRECTIVE_DEFINITION) {
      // FIXME: https://github.com/graphql/graphql-js/issues/2203
      /* c8 ignore next */
      const argNodes = def.arguments ?? [];

      requiredArgsMap.set(
        def.name.value,
        new Map(
          argNodes
            .filter(isRequiredArgumentNode)
            .map((arg) => [arg.name.value, arg]),
        ),
      );
    }
  }

  return {
    Directive: {
      // Validate on leave to allow for deeper errors to appear first.
      leave(directiveNode) {
        const directiveName = directiveNode.name.value;
        const requiredArgs = requiredArgsMap.get(directiveName);
        if (requiredArgs != null) {
          // FIXME: https://github.com/graphql/graphql-js/issues/2203
          /* c8 ignore next */
          const argNodes = directiveNode.arguments ?? [];
          const argNodeMap = new Set(argNodes.map((arg) => arg.name.value));
          for (const [argName, argDef] of requiredArgs.entries()) {
            if (!argNodeMap.has(argName)) {
              const argType = isType(argDef.type)
                ? inspect(argDef.type)
                : print(argDef.type);
              context.reportError(
                new GraphQLError(
                  `Directive "@${directiveName}" argument "${argName}" of type "${argType}" is required, but it was not provided.`,
                  { nodes: directiveNode },
                ),
              );
            }
          }
        }
      },
    },
  };
}

function isRequiredArgumentNode(
  arg: InputValueDefinitionNode | VariableDefinitionNode,
): boolean {
  return arg.type.kind === Kind.NON_NULL_TYPE && arg.defaultValue == null;
}
