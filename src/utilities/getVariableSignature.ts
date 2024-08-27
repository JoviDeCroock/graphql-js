import type { VariableDefinitionNode } from '../language/ast.js';

import type { GraphQLType } from '../type/definition.js';
import { isInputType } from '../type/definition.js';
import type { GraphQLSchema } from '../type/schema.js';

import { typeFromAST } from './typeFromAST.js';
import { valueFromAST } from './valueFromAST.js';

export interface GraphQLVariableSignature {
  readonly name: string;
  readonly type: GraphQLType | undefined;
  readonly defaultValue: unknown;
  readonly definition: VariableDefinitionNode;
}

export function getVariableSignature(
  schema: GraphQLSchema,
  varDefNode: VariableDefinitionNode,
): GraphQLVariableSignature {
  const varName = varDefNode.variable.name.value;
  const varType = typeFromAST(schema, varDefNode.type);

  return {
    name: varName,
    type: varType,
    defaultValue: isInputType(varType)
      ? valueFromAST(varDefNode.defaultValue, varType)
      : undefined,
    definition: varDefNode,
  };
}
