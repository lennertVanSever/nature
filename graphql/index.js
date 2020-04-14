import { makeAugmentedSchema, inferSchema } from 'neo4j-graphql-js';
import { ApolloServer } from 'apollo-server';
import { driver } from '../neo4j/index.js';


const schemaInferenceOptions = {
  alwaysIncludeRelationships: false
};

const inferAugmentedSchema = driver => {
  return inferSchema(driver, schemaInferenceOptions).then(result => {
    const selectNationalParkTypeRegexp = new RegExp('type NationalPark {(.*?)}', 'gs');
    let nationalParkType = selectNationalParkTypeRegexp.exec(result.typeDefs)[0];
    nationalParkType = nationalParkType.replace('}', '');
    nationalParkType += `
      distanceFromPoint(latitude: Float, longitude: Float): Float
        @cypher(
          statement: "return distance(this.location, Point({ latitude: latitude, longitude: longitude })) / 1000"
        )
    }
    `
    const overridenTypeDefs = result.typeDefs.replace(selectNationalParkTypeRegexp, nationalParkType);
    return makeAugmentedSchema({
      typeDefs: overridenTypeDefs,
    });
  });
};

const createServer = augmentedSchema =>
  new ApolloServer({
    schema: augmentedSchema,
    context: ({ req }) => {
      return {
        driver,
        req
      };
    }
  });

const port = process.env.GRAPHQL_LISTEN_PORT || 8080;

inferAugmentedSchema(driver)
  .then(createServer)
  .then(server => server.listen(port, '0.0.0.0'))
  .then(({ url }) => {
    console.log(`GraphQL API ready at ${url}`);
  })
  .catch(err => console.error(err));