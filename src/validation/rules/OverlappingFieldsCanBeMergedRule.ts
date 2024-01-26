import { inspect } from '../../jsutils/inspect.js';
import type { Maybe } from '../../jsutils/Maybe.js';

import { GraphQLError } from '../../error/GraphQLError.js';

import type {
  DirectiveNode,
  FieldNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  SelectionSetNode,
  ValueNode,
} from '../../language/ast.js';
import { Kind } from '../../language/kinds.js';
import { print } from '../../language/printer.js';
import type { ASTVisitor } from '../../language/visitor.js';

import type {
  GraphQLField,
  GraphQLNamedType,
  GraphQLOutputType,
} from '../../type/definition.js';
import {
  getNamedType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
} from '../../type/definition.js';

import { keyForFragmentSpread } from '../../utilities/keyForFragmentSpread.js';
import { sortValueNode } from '../../utilities/sortValueNode.js';
import { substituteFragmentArguments } from '../../utilities/substituteFragmentArguments.js';
import { typeFromAST } from '../../utilities/typeFromAST.js';

import type { ValidationContext } from '../ValidationContext.js';
import type { ObjMap } from '../../jsutils/ObjMap.js';

/* eslint-disable max-params */
// This file contains a lot of such errors but we plan to refactor it anyway
// so just disable it for entire file.

function reasonMessage(message: ConflictReasonMessage): string {
  if (Array.isArray(message)) {
    return message
      .map((subC) => {
        const subConflict = subC;
        if (subConflict.kind === 'FIELD') {
          return (
            `subfields "${subConflict.responseName}" conflict because ` +
            reasonMessage(subConflict.reasonMessage)
          );
        }
        return (
          `child spreads "${subConflict.fragmentName}" conflict because ` +
          reasonMessage(subConflict.reasonMessage)
        );
      })
      .join(' and ');
  }
  return message;
}

/**
 * Overlapping fields can be merged
 *
 * A selection set is only valid if all fields (including spreading any
 * fragments) either correspond to distinct response names or can be merged
 * without ambiguity.
 *
 * See https://spec.graphql.org/draft/#sec-Field-Selection-Merging
 */
export function OverlappingFieldsCanBeMergedRule(
  context: ValidationContext,
): ASTVisitor {
  // A memoization for when two fragments are compared "between" each other for
  // conflicts. Two fragments may be compared many times, so memoizing this can
  // dramatically improve the performance of this validator.
  const comparedFragmentPairs = new PairSet();

  // A cache for the "field map" and list of fragment names found in any given
  // selection set. Selection sets may be asked for this information multiple
  // times, so this improves the performance of this validator.
  const cachedFieldsAndFragmentSpreads = new Map();

  return {
    SelectionSet(selectionSet) {
      const conflicts = findConflictsWithinSelectionSet(
        context,
        cachedFieldsAndFragmentSpreads,
        comparedFragmentPairs,
        context.getParentType(),
        selectionSet,
      );
      for (const { reason, selectionPath1, selectionPath2 } of conflicts) {
        const reasonMsg = reasonMessage(reason.reasonMessage);
        const errorNodes = { nodes: selectionPath1.concat(selectionPath2) };
        if (reason.kind === 'FIELD') {
          context.reportError(
            new GraphQLError(
              `Fields "${reason.responseName}" conflict because ${reasonMsg}. Use different aliases on the fields to fetch both if this was intentional.`,
              errorNodes,
            ),
          );
        } else {
          // FRAGMENT_SPREAD
          context.reportError(
            new GraphQLError(
              // Fragments can't be aliased, so there's no easy way to resolve these conflicts today.
              `Spreads "${reason.fragmentName}" conflict because ${reasonMsg}.`,
              errorNodes,
            ),
          );
        }
      }
    },
  };
}

interface Conflict {
  reason: ConflictReason;
  selectionPath1: Array<FieldNode | FragmentSpreadNode>;
  selectionPath2: Array<FieldNode | FragmentSpreadNode>;
}
// Field name and reason.
type ConflictReason = FieldConflictReason | FragmentSpreadConflictReason;
interface FieldConflictReason {
  kind: 'FIELD';
  responseName: string;
  reasonMessage: ConflictReasonMessage;
}
interface FragmentSpreadConflictReason {
  kind: 'FRAGMENT_SPREAD';
  fragmentName: string;
  reasonMessage: ConflictReasonMessage;
}
// Reason is a string, or a nested list of conflicts.
type ConflictReasonMessage = string | Array<ConflictReason>;
// Tuple defining a field node in a context.
type NodeAndDef = [
  Maybe<GraphQLNamedType>,
  FieldNode,
  Maybe<GraphQLField<unknown, unknown>>,
];
// Map of array of those.
type NodeAndDefCollection = Map<string, Array<NodeAndDef>>;
type FragmentSpreadsByKey = ObjMap<FragmentSpreadNode>;
type FieldsAndFragmentSpreads = readonly [
  NodeAndDefCollection,
  FragmentSpreadsByKey,
];

/**
 * Algorithm:
 *
 * Conflicts occur when two fields exist in a query which will produce the same
 * response name, but represent differing values, thus creating a conflict.
 * The algorithm below finds all conflicts via making a series of comparisons
 * between fields. In order to compare as few fields as possible, this makes
 * a series of comparisons "within" sets of fields and "between" sets of fields.
 *
 * Given any selection set, a collection produces both a set of fields by
 * also including all inline fragments, as well as a list of fragments
 * referenced by fragment spreads.
 *
 * A) Each selection set represented in the document first compares "within" its
 * collected set of fields, finding any conflicts between every pair of
 * overlapping fields.
 * Note: This is the *only time* that a the fields "within" a set are compared
 * to each other. After this only fields "between" sets are compared.
 *
 * B) Also, if any fragment is referenced in a selection set, then a
 * comparison is made "between" the original set of fields and the
 * referenced fragment.
 *
 * C) Also, if multiple fragments are referenced, then comparisons
 * are made "between" each referenced fragment.
 *
 * D) When comparing "between" a set of fields and a referenced fragment, first
 * a comparison is made between each field in the original set of fields and
 * each field in the the referenced set of fields.
 *
 * E) Also, if any fragment is referenced in the referenced selection set,
 * then a comparison is made "between" the original set of fields and the
 * referenced fragment (recursively referring to step D).
 *
 * F) When comparing "between" two fragments, first a comparison is made between
 * each field in the first referenced set of fields and each field in the the
 * second referenced set of fields.
 *
 * G) Also, any fragments referenced by the first must be compared to the
 * second, and any fragments referenced by the second must be compared to the
 * first (recursively referring to step F).
 *
 * H) When comparing two fields, if both have selection sets, then a comparison
 * is made "between" both selection sets, first comparing the set of fields in
 * the first selection set with the set of fields in the second.
 *
 * I) Also, if any fragment is referenced in either selection set, then a
 * comparison is made "between" the other set of fields and the
 * referenced fragment.
 *
 * J) Also, if two fragments are referenced in both selection sets, then a
 * comparison is made "between" the two fragments.
 *
 */

// Find all conflicts found "within" a selection set, including those found
// via spreading in fragments. Called when visiting each SelectionSet in the
// GraphQL Document.
function findConflictsWithinSelectionSet(
  context: ValidationContext,
  cachedFieldsAndFragmentSpreads: Map<
    SelectionSetNode,
    FieldsAndFragmentSpreads
  >,
  comparedFragmentPairs: PairSet,
  parentType: Maybe<GraphQLNamedType>,
  selectionSet: SelectionSetNode,
): Array<Conflict> {
  const conflicts: Array<Conflict> = [];

  const [fieldMap, spreadCollection] = getFieldsAndFragmentSpreads(
    context,
    cachedFieldsAndFragmentSpreads,
    parentType,
    selectionSet,
  );

  // (A) Find find all conflicts "within" the fields of this selection set.
  // Note: this is the *only place* `collectConflictsWithin` is called.
  collectConflictsWithin(
    context,
    conflicts,
    cachedFieldsAndFragmentSpreads,
    comparedFragmentPairs,
    fieldMap,
  );

  const fragmentSpreads = Object.values(spreadCollection);
  // (B) Then collect conflicts between these fields and those represented by
  // each spread fragment name found.
  for (let i = 0; i < fragmentSpreads.length; i++) {
    collectConflictsBetweenFieldsAndFragment(
      context,
      conflicts,
      cachedFieldsAndFragmentSpreads,
      comparedFragmentPairs,
      false,
      fieldMap,
      fragmentSpreads[i],
    );
    // (C) Then compare this fragment with all other fragments found in this
    // selection set to collect conflicts between fragments spread together.
    // This compares each item in the list of fragment names to every other
    // item in that same list (except for itself).
    for (let j = i + 1; j < fragmentSpreads.length; j++) {
      collectConflictsBetweenFragments(
        context,
        conflicts,
        cachedFieldsAndFragmentSpreads,
        comparedFragmentPairs,
        false,
        fragmentSpreads[i],
        fragmentSpreads[j],
      );
    }
  }
  return conflicts;
}

// Collect all conflicts found between a set of fields and a fragment reference
// including via spreading in any nested fragments.
function collectConflictsBetweenFieldsAndFragment(
  context: ValidationContext,
  conflicts: Array<Conflict>,
  cachedFieldsAndFragmentSpreads: Map<
    SelectionSetNode,
    FieldsAndFragmentSpreads
  >,
  comparedFragmentPairs: PairSet,
  areMutuallyExclusive: boolean,
  fieldMap: NodeAndDefCollection,
  fragmentSpread: FragmentSpreadNode,
): void {
  const fragmentName = fragmentSpread.name.value;
  const fragmentDef = context.getFragment(fragmentName);
  if (!fragmentDef) {
    return;
  }

  const fragmentKey = keyForFragmentSpread(fragmentSpread);
  const [fieldMap2, referencedFragmentSpreads] =
    getReferencedFieldsAndFragmentSpreads(
      context,
      cachedFieldsAndFragmentSpreads,
      fragmentDef,
      fragmentSpread,
    );

  // Do not compare a fragment's fieldMap to itself.
  if (fieldMap === fieldMap2) {
    return;
  }

  // (D) First collect any conflicts between the provided collection of fields
  // and the collection of fields represented by the given fragment.
  collectConflictsBetween(
    context,
    conflicts,
    cachedFieldsAndFragmentSpreads,
    comparedFragmentPairs,
    areMutuallyExclusive,
    fieldMap,
    fieldMap2,
  );

  // (E) Then collect any conflicts between the provided collection of fields
  // and any fragment names found in the given fragment.
  for (const [
    referencedFragmentKey,
    referencedFragmentSpread,
  ] of Object.entries(referencedFragmentSpreads)) {
    // Memoize so two fragments are not compared for conflicts more than once.
    if (
      comparedFragmentPairs.has(
        referencedFragmentKey,
        fragmentKey,
        areMutuallyExclusive,
      )
    ) {
      continue;
    }
    comparedFragmentPairs.add(
      referencedFragmentKey,
      fragmentKey,
      areMutuallyExclusive,
    );

    collectConflictsBetweenFieldsAndFragment(
      context,
      conflicts,
      cachedFieldsAndFragmentSpreads,
      comparedFragmentPairs,
      areMutuallyExclusive,
      fieldMap,
      referencedFragmentSpread,
    );
  }
}

// Collect all conflicts found between two fragments, including via spreading in
// any nested fragments.
function collectConflictsBetweenFragments(
  context: ValidationContext,
  conflicts: Array<Conflict>,
  cachedFieldsAndFragmentSpreads: Map<
    SelectionSetNode,
    FieldsAndFragmentSpreads
  >,
  comparedFragmentPairs: PairSet,
  areMutuallyExclusive: boolean,
  fragmentSpread1: FragmentSpreadNode,
  fragmentSpread2: FragmentSpreadNode,
): void {
  const fragmentKey1 = keyForFragmentSpread(fragmentSpread1);
  const fragmentKey2 = keyForFragmentSpread(fragmentSpread2);
  // No need to compare a fragment to itself.
  if (fragmentKey1 === fragmentKey2) {
    return;
  }

  // Memoize so two fragments are not compared for conflicts more than once.
  if (
    comparedFragmentPairs.has(
      fragmentKey1,
      fragmentKey2,
      areMutuallyExclusive,
    )
  ) {
    return;
  }
  comparedFragmentPairs.add(fragmentKey1, fragmentKey2, areMutuallyExclusive);

  // Two unique fragment spreads reference the same fragment,
  // which is a conflict
  if (fragmentSpread1.name.value === fragmentSpread2.name.value) {
    conflicts.push({
      reason: {
        kind: 'FRAGMENT_SPREAD',
        fragmentName: fragmentSpread1.name.value,
        reasonMessage: `${fragmentKey1} and ${fragmentKey2} have different fragment arguments`,
      },
      selectionPath1: [fragmentSpread1],
      selectionPath2: [fragmentSpread2],
    });
    return;
  }

  const fragmentDef1 = context.getFragment(fragmentSpread1.name.value);
  const fragmentDef2 = context.getFragment(fragmentSpread2.name.value);
  if (!fragmentDef1 || !fragmentDef2) {
    return;
  }

  const [fieldMap1, referencedFragmentSpreads1] =
    getReferencedFieldsAndFragmentSpreads(
      context,
      cachedFieldsAndFragmentSpreads,
      fragmentDef1,
      fragmentSpread1,
    );
  const [fieldMap2, referencedFragmentSpreads2] =
    getReferencedFieldsAndFragmentSpreads(
      context,
      cachedFieldsAndFragmentSpreads,
      fragmentDef2,
      fragmentSpread2,
    );

  // (F) First, collect all conflicts between these two collections of fields
  // (not including any nested fragments).
  collectConflictsBetween(
    context,
    conflicts,
    cachedFieldsAndFragmentSpreads,
    comparedFragmentPairs,
    areMutuallyExclusive,
    fieldMap1,
    fieldMap2,
  );

  // (G) Then collect conflicts between the first fragment and any nested
  // fragments spread in the second fragment.
  for (const referencedFragmentSpread2 of Object.values(
    referencedFragmentSpreads2,
  )) {
    collectConflictsBetweenFragments(
      context,
      conflicts,
      cachedFieldsAndFragmentSpreads,
      comparedFragmentPairs,
      areMutuallyExclusive,
      fragmentSpread1,
      referencedFragmentSpread2,
    );
  }

  // (G) Then collect conflicts between the second fragment and any nested
  // fragments spread in the first fragment.
  for (const referencedFragmentSpread1 of Object.values(
    referencedFragmentSpreads1,
  )) {
    collectConflictsBetweenFragments(
      context,
      conflicts,
      cachedFieldsAndFragmentSpreads,
      comparedFragmentPairs,
      areMutuallyExclusive,
      referencedFragmentSpread1,
      fragmentSpread2,
    );
  }
}

// Find all conflicts found between two selection sets, including those found
// via spreading in fragments. Called when determining if conflicts exist
// between the sub-fields of two overlapping fields.
function findConflictsBetweenSubSelectionSets(
  context: ValidationContext,
  cachedFieldsAndFragmentSpreads: Map<
    SelectionSetNode,
    FieldsAndFragmentSpreads
  >,
  comparedFragmentPairs: PairSet,
  areMutuallyExclusive: boolean,
  parentType1: Maybe<GraphQLNamedType>,
  selectionSet1: SelectionSetNode,
  parentType2: Maybe<GraphQLNamedType>,
  selectionSet2: SelectionSetNode,
): Array<Conflict> {
  const conflicts: Array<Conflict> = [];

  const [fieldMap1, fragmentSpreads1] = getFieldsAndFragmentSpreads(
    context,
    cachedFieldsAndFragmentSpreads,
    parentType1,
    selectionSet1,
  );
  const [fieldMap2, fragmentSpreads2] = getFieldsAndFragmentSpreads(
    context,
    cachedFieldsAndFragmentSpreads,
    parentType2,
    selectionSet2,
  );

  // (H) First, collect all conflicts between these two collections of field.
  collectConflictsBetween(
    context,
    conflicts,
    cachedFieldsAndFragmentSpreads,
    comparedFragmentPairs,
    areMutuallyExclusive,
    fieldMap1,
    fieldMap2,
  );

  // (I) Then collect conflicts between the first collection of fields and
  // those referenced by each fragment name associated with the second.
  for (const fragmentSpread2 of Object.values(fragmentSpreads2)) {
    collectConflictsBetweenFieldsAndFragment(
      context,
      conflicts,
      cachedFieldsAndFragmentSpreads,
      comparedFragmentPairs,
      areMutuallyExclusive,
      fieldMap1,
      fragmentSpread2,
    );
  }

  // (I) Then collect conflicts between the second collection of fields and
  // those referenced by each fragment name associated with the first.
  for (const fragmentSpread1 of Object.values(fragmentSpreads1)) {
    collectConflictsBetweenFieldsAndFragment(
      context,
      conflicts,
      cachedFieldsAndFragmentSpreads,
      comparedFragmentPairs,
      areMutuallyExclusive,
      fieldMap2,
      fragmentSpread1,
    );
  }

  // (J) Also collect conflicts between any fragment names by the first and
  // fragment names by the second. This compares each item in the first set of
  // names to each item in the second set of names.
  for (const fragmentSpread1 of Object.values(fragmentSpreads1)) {
    for (const fragmentSpread2 of Object.values(fragmentSpreads2)) {
      collectConflictsBetweenFragments(
        context,
        conflicts,
        cachedFieldsAndFragmentSpreads,
        comparedFragmentPairs,
        areMutuallyExclusive,
        fragmentSpread1,
        fragmentSpread2,
      );
    }
  }
  return conflicts;
}

// Collect all Conflicts "within" one collection of fields.
function collectConflictsWithin(
  context: ValidationContext,
  conflicts: Array<Conflict>,
  cachedFieldsAndFragmentSpreads: Map<
    SelectionSetNode,
    FieldsAndFragmentSpreads
  >,
  comparedFragmentPairs: PairSet,
  fieldMap: NodeAndDefCollection,
): void {
  // A field map is a keyed collection, where each key represents a response
  // name and the value at that key is a list of all fields which provide that
  // response name. For every response name, if there are multiple fields, they
  // must be compared to find a potential conflict.
  for (const [responseName, fields] of fieldMap.entries()) {
    // This compares every field in the list to every other field in this list
    // (except to itself). If the list only has one item, nothing needs to
    // be compared.
    if (fields.length > 1) {
      for (let i = 0; i < fields.length; i++) {
        for (let j = i + 1; j < fields.length; j++) {
          const conflict = findFieldConflicts(
            context,
            cachedFieldsAndFragmentSpreads,
            comparedFragmentPairs,
            false, // within one collection is never mutually exclusive
            responseName,
            fields[i],
            fields[j],
          );
          if (conflict) {
            conflicts.push(conflict);
          }
        }
      }
    }
  }
}

// Collect all Conflicts between two collections of fields. This is similar to,
// but different from the `collectConflictsWithin` function above. This check
// assumes that `collectConflictsWithin` has already been called on each
// provided collection of fields. This is true because this validator traverses
// each individual selection set.
function collectConflictsBetween(
  context: ValidationContext,
  conflicts: Array<Conflict>,
  cachedFieldsAndFragmentSpreads: Map<
    SelectionSetNode,
    FieldsAndFragmentSpreads
  >,
  comparedFragmentPairs: PairSet,
  parentFieldsAreMutuallyExclusive: boolean,
  fieldMap1: NodeAndDefCollection,
  fieldMap2: NodeAndDefCollection,
): void {
  // A field map is a keyed collection, where each key represents a response
  // name and the value at that key is a list of all fields which provide that
  // response name. For any response name which appears in both provided field
  // maps, each field from the first field map must be compared to every field
  // in the second field map to find potential conflicts.
  for (const [responseName, fields1] of fieldMap1.entries()) {
    const fields2 = fieldMap2.get(responseName);
    if (fields2 != null) {
      for (const field1 of fields1) {
        for (const field2 of fields2) {
          const conflict = findFieldConflicts(
            context,
            cachedFieldsAndFragmentSpreads,
            comparedFragmentPairs,
            parentFieldsAreMutuallyExclusive,
            responseName,
            field1,
            field2,
          );
          if (conflict) {
            conflicts.push(conflict);
          }
        }
      }
    }
  }
}

// Determines if there is a conflict between two particular fields, including
// comparing their sub-fields.
function findFieldConflicts(
  context: ValidationContext,
  cachedFieldsAndFragmentSpreads: Map<
    SelectionSetNode,
    FieldsAndFragmentSpreads
  >,
  comparedFragmentPairs: PairSet,
  parentFieldsAreMutuallyExclusive: boolean,
  responseName: string,
  field1: NodeAndDef,
  field2: NodeAndDef,
): Maybe<Conflict> {
  const [parentType1, node1, def1] = field1;
  const [parentType2, node2, def2] = field2;

  // If it is known that two fields could not possibly apply at the same
  // time, due to the parent types, then it is safe to permit them to diverge
  // in aliased field or arguments used as they will not present any ambiguity
  // by differing.
  // It is known that two parent types could never overlap if they are
  // different Object types. Interface or Union types might overlap - if not
  // in the current state of the schema, then perhaps in some future version,
  // thus may not safely diverge.
  const areMutuallyExclusive =
    parentFieldsAreMutuallyExclusive ||
    (parentType1 !== parentType2 &&
      isObjectType(parentType1) &&
      isObjectType(parentType2));

  if (!areMutuallyExclusive) {
    // Two aliases must refer to the same field.
    const name1 = node1.name.value;
    const name2 = node2.name.value;
    if (name1 !== name2) {
      return {
        reason: {
          kind: 'FIELD',
          responseName,
          reasonMessage: `"${name1}" and "${name2}" are different fields`,
        },
        selectionPath1: [node1],
        selectionPath2: [node2],
      };
    }

    // Two field calls must have the same arguments.
    if (!sameArguments(node1, node2)) {
      return {
        reason: {
          kind: 'FIELD',
          responseName,
          reasonMessage: 'they have differing arguments',
        },
        selectionPath1: [node1],
        selectionPath2: [node2],
      };
    }
  }

  // FIXME https://github.com/graphql/graphql-js/issues/2203
  const directives1 = /* c8 ignore next */ node1.directives ?? [];
  const directives2 = /* c8 ignore next */ node2.directives ?? [];
  if (!sameStreams(directives1, directives2)) {
    return {
      reason: {
        kind: 'FIELD',
        responseName,
        reasonMessage: 'they have differing stream directives',
      },
      selectionPath1: [node1],
      selectionPath2: [node2],
    };
  }

  // The return type for each field.
  const type1 = def1?.type;
  const type2 = def2?.type;

  if (type1 && type2 && doTypesConflict(type1, type2)) {
    return {
      reason: {
        kind: 'FIELD',
        responseName,
        reasonMessage: `they return conflicting types "${inspect(
          type1,
        )}" and "${inspect(type2)}"`,
      },
      selectionPath1: [node1],
      selectionPath2: [node2],
    };
  }

  // Collect and compare sub-fields. Use the same "visited fragment names" list
  // for both collections so fields in a fragment reference are never
  // compared to themselves.
  const selectionSet1 = node1.selectionSet;
  const selectionSet2 = node2.selectionSet;
  if (selectionSet1 && selectionSet2) {
    const conflicts = findConflictsBetweenSubSelectionSets(
      context,
      cachedFieldsAndFragmentSpreads,
      comparedFragmentPairs,
      areMutuallyExclusive,
      getNamedType(type1),
      selectionSet1,
      getNamedType(type2),
      selectionSet2,
    );
    return subfieldConflicts(conflicts, responseName, node1, node2);
  }
}

function sameArguments(
  node1: FieldNode | DirectiveNode,
  node2: FieldNode | DirectiveNode,
): boolean {
  const args1 = node1.arguments;
  const args2 = node2.arguments;

  if (args1 === undefined || args1.length === 0) {
    return args2 === undefined || args2.length === 0;
  }
  if (args2 === undefined || args2.length === 0) {
    return false;
  }

  if (args1.length !== args2.length) {
    return false;
  }

  const values2 = new Map(args2.map(({ name, value }) => [name.value, value]));
  return args1.every((arg1) => {
    const value1 = arg1.value;
    const value2 = values2.get(arg1.name.value);
    if (value2 === undefined) {
      return false;
    }

    return stringifyValue(value1) === stringifyValue(value2);
  });
}

function stringifyValue(value: ValueNode): string | null {
  return print(sortValueNode(value));
}

function getStreamDirective(
  directives: ReadonlyArray<DirectiveNode>,
): DirectiveNode | undefined {
  return directives.find((directive) => directive.name.value === 'stream');
}

function sameStreams(
  directives1: ReadonlyArray<DirectiveNode>,
  directives2: ReadonlyArray<DirectiveNode>,
): boolean {
  const stream1 = getStreamDirective(directives1);
  const stream2 = getStreamDirective(directives2);
  if (!stream1 && !stream2) {
    // both fields do not have streams
    return true;
  } else if (stream1 && stream2) {
    // check if both fields have equivalent streams
    return sameArguments(stream1, stream2);
  }
  // fields have a mix of stream and no stream
  return false;
}

// Two types conflict if both types could not apply to a value simultaneously.
// Composite types are ignored as their individual field types will be compared
// later recursively. However List and Non-Null types must match.
function doTypesConflict(
  type1: GraphQLOutputType,
  type2: GraphQLOutputType,
): boolean {
  if (isListType(type1)) {
    return isListType(type2)
      ? doTypesConflict(type1.ofType, type2.ofType)
      : true;
  }
  if (isListType(type2)) {
    return true;
  }
  if (isNonNullType(type1)) {
    return isNonNullType(type2)
      ? doTypesConflict(type1.ofType, type2.ofType)
      : true;
  }
  if (isNonNullType(type2)) {
    return true;
  }
  if (isLeafType(type1) || isLeafType(type2)) {
    return type1 !== type2;
  }
  return false;
}

// Given a selection set, return the collection of fields (a mapping of response
// name to field nodes and definitions) as well as a list of fragment names
// referenced via fragment spreads.
function getFieldsAndFragmentSpreads(
  context: ValidationContext,
  cachedFieldsAndFragmentSpreads: Map<
    SelectionSetNode,
    FieldsAndFragmentSpreads
  >,
  parentType: Maybe<GraphQLNamedType>,
  selectionSet: SelectionSetNode,
): FieldsAndFragmentSpreads {
  const cached = cachedFieldsAndFragmentSpreads.get(selectionSet);
  if (cached) {
    return cached;
  }
  const nodeAndDefs: NodeAndDefCollection = new Map();
  const fragmentSpreads: ObjMap<FragmentSpreadNode> = Object.create(null);
  _collectFieldsAndFragmentSpreads(
    context,
    parentType,
    selectionSet,
    nodeAndDefs,
    fragmentSpreads,
  );
  const result = [nodeAndDefs, fragmentSpreads] as const;
  cachedFieldsAndFragmentSpreads.set(selectionSet, result);
  return result;
}

// Given a reference to a fragment, return the represented collection of fields
// as well as a list of nested referenced fragment spreads.
function getReferencedFieldsAndFragmentSpreads(
  context: ValidationContext,
  cachedFieldsAndFragmentSpreads: Map<
    SelectionSetNode,
    FieldsAndFragmentSpreads
  >,
  fragmentDef: FragmentDefinitionNode,
  fragmentSpread: FragmentSpreadNode,
) {
  const fragmentSelectionSet = substituteFragmentArguments(
    fragmentDef,
    fragmentSpread,
  );

  // Short-circuit building a type from the node if possible.
  const cached = cachedFieldsAndFragmentSpreads.get(fragmentSelectionSet);
  if (cached) {
    return cached;
  }

  const fragmentType = typeFromAST(
    context.getSchema(),
    fragmentDef.typeCondition,
  );
  return getFieldsAndFragmentSpreads(
    context,
    cachedFieldsAndFragmentSpreads,
    fragmentType,
    fragmentSelectionSet,
  );
}

function _collectFieldsAndFragmentSpreads(
  context: ValidationContext,
  parentType: Maybe<GraphQLNamedType>,
  selectionSet: SelectionSetNode,
  nodeAndDefs: NodeAndDefCollection,
  fragmentSpreads: FragmentSpreadsByKey,
): void {
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        const fieldName = selection.name.value;
        let fieldDef;
        if (isObjectType(parentType) || isInterfaceType(parentType)) {
          fieldDef = parentType.getFields()[fieldName];
        }
        const responseName = selection.alias
          ? selection.alias.value
          : fieldName;

        let nodeAndDefsList = nodeAndDefs.get(responseName);
        if (nodeAndDefsList == null) {
          nodeAndDefsList = [];
          nodeAndDefs.set(responseName, nodeAndDefsList);
        }
        nodeAndDefsList.push([parentType, selection, fieldDef]);
        break;
      }
      case Kind.FRAGMENT_SPREAD:
        fragmentSpreads[keyForFragmentSpread(selection)] = selection;
        break;
      case Kind.INLINE_FRAGMENT: {
        const typeCondition = selection.typeCondition;
        const inlineFragmentType = typeCondition
          ? typeFromAST(context.getSchema(), typeCondition)
          : parentType;
        _collectFieldsAndFragmentSpreads(
          context,
          inlineFragmentType,
          selection.selectionSet,
          nodeAndDefs,
          fragmentSpreads,
        );
        break;
      }
    }
  }
}

// Given a series of Conflicts which occurred between two sub-fields, generate
// a single Conflict.
function subfieldConflicts(
  conflicts: ReadonlyArray<Conflict>,
  responseName: string,
  node1: FieldNode,
  node2: FieldNode,
): Maybe<Conflict> {
  if (conflicts.length > 0) {
    return {
      reason: {
        kind: 'FIELD',
        responseName,
        reasonMessage: conflicts.map((conflict) => conflict.reason),
      },
      selectionPath1: [
        node1,
        ...conflicts.map((subConflict) => subConflict.selectionPath1).flat(),
      ],
      selectionPath2: [
        node2,
        ...conflicts.map((subConflict) => subConflict.selectionPath2).flat(),
      ],
    };
  }
}

/**
 * A way to keep track of pairs of things when the ordering of the pair does not matter.
 */
class PairSet {
  _data: Map<string, Map<string, boolean>>;

  constructor() {
    this._data = new Map();
  }

  has(a: string, b: string, areMutuallyExclusive: boolean): boolean {
    const [key1, key2] = a < b ? [a, b] : [b, a];

    const result = this._data.get(key1)?.get(key2);
    if (result === undefined) {
      return false;
    }

    // areMutuallyExclusive being false is a superset of being true, hence if
    // we want to know if this PairSet "has" these two with no exclusivity,
    // we have to ensure it was added as such.
    return areMutuallyExclusive ? true : areMutuallyExclusive === result;
  }

  add(a: string, b: string, areMutuallyExclusive: boolean): void {
    const [key1, key2] = a < b ? [a, b] : [b, a];

    const map = this._data.get(key1);
    if (map === undefined) {
      this._data.set(key1, new Map([[key2, areMutuallyExclusive]]));
    } else {
      map.set(key2, areMutuallyExclusive);
    }
  }
}
