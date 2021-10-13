/* eslint-disable no-unused-expressions */
import {
  GraphQLSchema,
  DocumentNode,
  GraphQLError,
  subscribe,
  ExecutionArgs,
  GraphQLResolveInfo,
  OperationTypeNode,
  GraphQLObjectType,
  getOperationAST,
  print,
  SelectionSetNode,
  ExecutionResult,
} from 'graphql';
import { ExecuteMeshFn, GetMeshOptions, Requester, SubscribeMeshFn } from './types';
import {
  MeshPubSub,
  KeyValueCache,
  RawSourceOutput,
  GraphQLOperation,
  SelectionSetParamOrFactory,
  SelectionSetParam,
} from '@graphql-mesh/types';

import { applyResolversHooksToSchema } from './resolvers-hooks';
import { MESH_CONTEXT_SYMBOL, MESH_API_CONTEXT_SYMBOL } from './constants';
import {
  applySchemaTransforms,
  ensureDocumentNode,
  getInterpolatedStringFactory,
  groupTransforms,
  ResolverDataBasedFactory,
  jitExecutorFactory,
  AggregateError,
  DefaultLogger,
} from '@graphql-mesh/utils';

import { InMemoryLiveQueryStore } from '@n1ru4l/in-memory-live-query-store';
import { delegateToSchema, IDelegateToSchemaOptions } from '@graphql-tools/delegate';
import { BatchDelegateOptions, batchDelegateToSchema } from '@graphql-tools/batch-delegate';
import { WrapQuery } from '@graphql-tools/wrap';
import { inspect, isDocumentNode, parseSelectionSet } from '@graphql-tools/utils';

export interface MeshInstance {
  execute: ExecuteMeshFn;
  subscribe: SubscribeMeshFn;
  schema: GraphQLSchema;
  rawSources: RawSourceOutput[];
  sdkRequester: Requester;
  destroy: () => void;
  pubsub: MeshPubSub;
  cache: KeyValueCache;
  liveQueryStore: InMemoryLiveQueryStore;
  /**
   * @deprecated
   * contextBuilder has no effect in the provided context anymore.
   * It will be removed in the next version
   */
  contextBuilder: (ctx: any) => Promise<any>;
  addCustomContextBuilder: (builder: CustomContextBuilders) => void;
}

type CustomContextBuilders = () => Promise<{
  [key: string]: any;
}>;

export async function getMesh(options: GetMeshOptions): Promise<MeshInstance> {
  const rawSources: RawSourceOutput[] = [];
  const customContextBuilders: CustomContextBuilders[] = [];

  const addCustomContextBuilder = (contextBuilder: CustomContextBuilders) => {
    customContextBuilders.push(contextBuilder);
  };
  const mergeContext = async (context: Record<string, any>) => {
    const allCustomContexts = await Promise.all(
      customContextBuilders.map(builder => {
        return builder();
      })
    );
    return Object.assign(context, ...allCustomContexts);
  };

  const { pubsub, cache, logger = new DefaultLogger('🕸️') } = options;

  const getMeshLogger = logger.child('GetMesh');
  getMeshLogger.debug(`Getting subschemas from source handlers`);
  let failed = false;
  await Promise.allSettled(
    options.sources.map(async apiSource => {
      const apiName = apiSource.name;
      const sourceLogger = logger.child(apiName);
      sourceLogger.debug(`Generating the schema`);
      try {
        const source = await apiSource.handler.getMeshSource();
        sourceLogger.debug(`The schema has been generated successfully`);

        let apiSchema = source.schema;

        sourceLogger.debug(`Analyzing transforms`);
        const { wrapTransforms, noWrapTransforms } = groupTransforms(apiSource.transforms);

        if (noWrapTransforms?.length) {
          sourceLogger.debug(`${noWrapTransforms.length} bare transforms found and applying`);
          apiSchema = applySchemaTransforms(apiSchema, source, null, noWrapTransforms);
        }

        rawSources.push({
          name: apiName,
          schema: apiSchema,
          executor: source.executor,
          transforms: wrapTransforms,
          contextVariables: source.contextVariables || [],
          handler: apiSource.handler,
          batch: 'batch' in source ? source.batch : true,
          merge: apiSource.merge,
        });
      } catch (e: any) {
        sourceLogger.error(`Failed to generate schema: ${e.message || e}`);
        failed = true;
      }
    })
  );

  if (failed) {
    throw new Error(
      `Schemas couldn't be generated successfully. Check for the logs by running Mesh with DEBUG=1 environmental variable to get more verbose output.`
    );
  }

  getMeshLogger.debug(`Schemas have been generated by the source handlers`);

  getMeshLogger.debug(`Merging schemas using the defined merging strategy.`);
  let unifiedSchema = await options.merger.getUnifiedSchema({
    rawSources,
    typeDefs: options.additionalTypeDefs,
    resolvers: options.additionalResolvers,
    transforms: options.transforms,
  });

  getMeshLogger.debug(`Creating JIT Executor`);
  const jitExecutor = jitExecutorFactory(unifiedSchema, 'unified', logger.child('JIT Executor'));

  getMeshLogger.debug(`Creating Live Query Store`);
  const liveQueryStore = new InMemoryLiveQueryStore({
    includeIdentifierExtension: true,
    execute: (args: any) => {
      const { document, contextValue, variableValues, rootValue, operationName }: ExecutionArgs = args;
      const operationAst = getOperationAST(document, operationName);
      if (!operationAst) {
        throw new Error(`Operation ${operationName} cannot be found!`);
      }
      const operationType = operationAst.operation;
      return jitExecutor({
        document,
        context: contextValue,
        variables: variableValues,
        operationName,
        rootValue,
        operationType,
      }) as ExecutionResult;
    },
  });

  const liveQueryInvalidationFactoryMap = new Map<string, ResolverDataBasedFactory<string>[]>();

  options.liveQueryInvalidations?.forEach(liveQueryInvalidation => {
    const rawInvalidationPaths = liveQueryInvalidation.invalidate;
    const factories = rawInvalidationPaths.map(rawInvalidationPath =>
      getInterpolatedStringFactory(rawInvalidationPath)
    );
    liveQueryInvalidationFactoryMap.set(liveQueryInvalidation.field, factories);
  });

  getMeshLogger.debug(`Creating event listener (resolverDone) for Live Query Store`);
  pubsub.subscribe('resolverDone', ({ result, resolverData }) => {
    if (resolverData?.info?.parentType && resolverData?.info?.fieldName) {
      const path = `${resolverData.info.parentType.name}.${resolverData.info.fieldName}`;
      if (liveQueryInvalidationFactoryMap.has(path)) {
        const invalidationPathFactories = liveQueryInvalidationFactoryMap.get(path);
        const invalidationPaths = invalidationPathFactories.map(invalidationPathFactory =>
          invalidationPathFactory({ ...resolverData, result })
        );
        liveQueryStore.invalidate(invalidationPaths);
      }
    }
  });

  getMeshLogger.debug(`Building Mesh Context`);
  const meshContext: Record<string, any> = {
    pubsub,
    cache,
    liveQueryStore,
    [MESH_CONTEXT_SYMBOL]: true,
  };
  getMeshLogger.debug(`Attaching in-context SDK, pubsub, cache and liveQueryStore to the context`);
  const sourceMap: Map<RawSourceOutput, GraphQLSchema> = unifiedSchema.extensions.sourceMap;
  await Promise.all(
    rawSources.map(async rawSource => {
      const rawSourceLogger = logger.child(`${rawSource.name}`);

      const rawSourceContext: any = {
        rawSource,
        [MESH_API_CONTEXT_SYMBOL]: true,
      };
      const transformedSchema = sourceMap.get(rawSource);
      const rootTypes: Record<OperationTypeNode, GraphQLObjectType> = {
        query: transformedSchema.getQueryType(),
        mutation: transformedSchema.getMutationType(),
        subscription: transformedSchema.getSubscriptionType(),
      };

      rawSourceLogger.debug(`Generating In Context SDK`);
      for (const operationType in rootTypes) {
        const rootType: GraphQLObjectType = rootTypes[operationType];
        if (rootType) {
          rawSourceContext[rootType.name] = {};
          const rootTypeFieldMap = rootType.getFields();
          for (const fieldName in rootTypeFieldMap) {
            const rootTypeField = rootTypeFieldMap[fieldName];
            const inContextSdkLogger = rawSourceLogger.child(`InContextSDK.${rootType.name}.${fieldName}`);
            rawSourceContext[rootType.name][fieldName] = async ({
              root,
              args,
              context,
              info,
              selectionSet,
              key,
              argsFromKeys,
              valuesFromResults,
            }: {
              root: any;
              args: any;
              context: any;
              info: GraphQLResolveInfo;
              selectionSet: SelectionSetParamOrFactory;
              key?: string;
              argsFromKeys?: (keys: string[]) => any;
              valuesFromResults?: (result: any, keys?: string[]) => any;
            }) => {
              inContextSdkLogger.debug(`Called with
- root: ${inspect(root)}
- args: ${inspect(args)}
- key: ${inspect(key)}`);
              const commonDelegateOptions: IDelegateToSchemaOptions = {
                schema: rawSource,
                rootValue: root,
                operation: operationType as OperationTypeNode,
                fieldName,
                returnType: rootTypeField.type,
                context,
                transformedSchema,
                info,
              };
              if (key && argsFromKeys) {
                const batchDelegationOptions: BatchDelegateOptions = {
                  ...commonDelegateOptions,
                  key,
                  argsFromKeys,
                  valuesFromResults,
                };
                if (selectionSet) {
                  const selectionSetFactory = normalizeSelectionSetParamOrFactory(selectionSet);
                  const path = [fieldName];
                  const wrapQueryTransform = new WrapQuery(path, selectionSetFactory, identical);
                  batchDelegationOptions.transforms = [wrapQueryTransform];
                }
                return batchDelegateToSchema(batchDelegationOptions);
              } else {
                const options: IDelegateToSchemaOptions = {
                  ...commonDelegateOptions,
                  args,
                };
                if (selectionSet) {
                  const selectionSetFactory = normalizeSelectionSetParamOrFactory(selectionSet);
                  const path = [fieldName];
                  const wrapQueryTransform = new WrapQuery(path, selectionSetFactory, identical);
                  options.transforms = [wrapQueryTransform];
                }
                const result = await delegateToSchema(options);
                if (valuesFromResults) {
                  return valuesFromResults(result);
                }
                return result;
              }
            };
          }
        }
      }
      meshContext[rawSource.name] = rawSourceContext;
    })
  );

  getMeshLogger.debug(`Attaching resolver hooks to the unified schema`);
  unifiedSchema = applyResolversHooksToSchema(unifiedSchema, pubsub, meshContext);

  const executionLogger = logger.child(`Execute`);
  const EMPTY_ROOT_VALUE: any = {};
  const EMPTY_CONTEXT_VALUE: any = {};
  const EMPTY_VARIABLES_VALUE: any = {};
  async function meshExecute<TVariables = any, TContext = any, TRootValue = any, TData = any>(
    document: GraphQLOperation<TData, TVariables>,
    variableValues: TVariables = EMPTY_VARIABLES_VALUE,
    contextValue: TContext = EMPTY_CONTEXT_VALUE,
    rootValue: TRootValue = EMPTY_ROOT_VALUE,
    operationName?: string
  ) {
    const printedDocument = typeof document === 'string' ? document : print(document);
    const documentNode = ensureDocumentNode(document);
    if (!operationName) {
      const operationAst = getOperationAST(documentNode);
      operationName = operationAst.name?.value;
    }
    const operationLogger = executionLogger.child(operationName || 'UnnamedOperation');

    contextValue = await mergeContext(contextValue);
    const executionParams = {
      document: documentNode,
      contextValue,
      rootValue,
      variableValues,
      schema: unifiedSchema,
      operationName,
    } as const;

    operationLogger.debug(
      `Execution started with
${inspect({
  ...(operationName ? {} : { query: printedDocument }),
  ...(rootValue ? { rootValue } : {}),
  ...(variableValues ? { variableValues } : {}),
})}`
    );

    const executionResult = await liveQueryStore.execute(executionParams);

    operationLogger.debug(
      `Execution done with
${inspect({
  ...(operationName ? {} : { query: printedDocument }),
  ...executionResult,
})}`
    );

    return executionResult;
  }

  const subscriberLogger = logger.child(`meshSubscribe`);
  async function meshSubscribe<TVariables = any, TContext = any, TRootValue = any, TData = any>(
    document: GraphQLOperation<TData, TVariables>,
    variableValues: TVariables = EMPTY_VARIABLES_VALUE,
    contextValue: TContext = EMPTY_CONTEXT_VALUE,
    rootValue: TRootValue = EMPTY_ROOT_VALUE,
    operationName?: string
  ) {
    const printedDocument = typeof document === 'string' ? document : print(document);
    const documentNode = ensureDocumentNode(document);
    if (!operationName) {
      const operationAst = getOperationAST(documentNode);
      operationName = operationAst.name?.value;
    }
    const operationLogger = subscriberLogger.child(operationName || 'UnnamedOperation');
    contextValue = await mergeContext(contextValue);
    const executionParams = {
      document: documentNode,
      contextValue,
      rootValue,
      variableValues,
      schema: unifiedSchema,
      operationName,
    } as const;

    operationLogger.debug(
      `Subscription started with
${inspect({
  ...(rootValue ? {} : { rootValue }),
  ...(variableValues ? {} : { variableValues }),
  ...(operationName ? {} : { query: printedDocument }),
})}`
    );
    const executionResult = await subscribe(executionParams);

    return executionResult;
  }

  class GraphQLMeshSdkError<Data = any, Variables = any> extends AggregateError {
    constructor(
      errors: ReadonlyArray<GraphQLError>,
      public document: DocumentNode,
      public variables: Variables,
      public data: Data
    ) {
      super(
        errors,
        `GraphQL Mesh SDK ${getOperationAST(document).operation} ${getOperationAST(document).name?.value || ''} failed!`
      );
    }
  }

  const localRequester: Requester = async <Result, TVariables, TContext, TRootValue>(
    document: DocumentNode,
    variables: TVariables,
    contextValue?: TContext,
    rootValue?: TRootValue,
    operationName?: string
  ) => {
    const executionResult = await meshExecute<TVariables, TContext, TRootValue>(
      document,
      variables,
      contextValue,
      rootValue,
      operationName
    );

    if ('data' in executionResult || 'errors' in executionResult) {
      if (executionResult.data && !executionResult.errors) {
        return executionResult.data as Result;
      } else {
        logger.error(`GraphQL Mesh SDK failed to execute:
        ${inspect({
          query: print(document),
          variables,
        })}`);
        throw new GraphQLMeshSdkError(
          executionResult.errors as ReadonlyArray<GraphQLError>,
          document,
          variables,
          executionResult.data
        );
      }
    } else {
      throw new Error('Not implemented');
    }
  };

  return {
    execute: meshExecute,
    subscribe: meshSubscribe,
    schema: unifiedSchema,
    rawSources,
    sdkRequester: localRequester,
    cache,
    pubsub,
    destroy: () => pubsub.publish('destroy', undefined),
    liveQueryStore,
    contextBuilder: async ctx => ctx || {},
    addCustomContextBuilder,
  };
}

function normalizeSelectionSetParam(selectionSetParam: SelectionSetParam) {
  if (typeof selectionSetParam === 'string') {
    return parseSelectionSet(selectionSetParam);
  }
  if (isDocumentNode(selectionSetParam)) {
    return parseSelectionSet(print(selectionSetParam));
  }
  return selectionSetParam;
}

function normalizeSelectionSetParamOrFactory(
  selectionSetParamOrFactory: SelectionSetParamOrFactory
): (subtree: SelectionSetNode) => SelectionSetNode {
  return function getSelectionSet(subtree: SelectionSetNode) {
    if (typeof selectionSetParamOrFactory === 'function') {
      const selectionSetParam = selectionSetParamOrFactory(subtree);
      return normalizeSelectionSetParam(selectionSetParam);
    } else {
      return normalizeSelectionSetParam(selectionSetParamOrFactory);
    }
  };
}

function identical<T>(val: T): T {
  return val;
}
