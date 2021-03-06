import { MeshPubSub } from '@graphql-mesh/types';
import { GraphQLSchema } from 'graphql';
import { IResolvers } from '@graphql-tools/utils';
export declare function applyResolversHooksToResolvers(resolvers: IResolvers, pubsub: MeshPubSub, meshContext: any): IResolvers;
export declare function applyResolversHooksToSchema(schema: GraphQLSchema, pubsub: MeshPubSub, meshContext: any): GraphQLSchema;
