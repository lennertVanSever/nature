import { makeAugmentedSchema, inferSchema } from 'neo4j-graphql-js';
import { ApolloServer } from 'apollo-server';
import { driver } from '../neo4j/index.js';


const schemaInferenceOptions = {
  alwaysIncludeRelationships: false
};



const inferAugmentedSchema = driver => {
  return inferSchema(driver, schemaInferenceOptions).then(result => {
    let schema = result.typeDefs;
    const overrideSchemaType = (type, toInsert) => {
      const selectTypeRegex = new RegExp(`type ${type} {(.*?)}`, 'gs');
      let selectedType = selectTypeRegex.exec(schema)[0];
      selectedType = selectedType.replace('}', '');
      selectedType += `
        ${toInsert}
      }
      `
      schema = schema.replace(selectTypeRegex, selectedType);
    }


    overrideSchemaType(
      'NationalPark',
      `
      distanceFromPoint(latitude: Float!, longitude: Float!): Float
      @cypher(
        statement: "return distance(this.location, Point({ latitude: latitude, longitude: longitude })) / 1000"
      )
      `
    )

    overrideSchemaType(
      'Country',
      `
      shortestPathToOtherCountry(otherCountryCode: String!): [Country] @relation(name: "borders", direction: "IN")
      @cypher(
        statement: """
          MATCH (from:Country {code: this.code})
          MATCH (to:Country {code: otherCountryCode})
          WHERE NOT from = to
          MATCH p = shortestPath((from)-[:borders*]-(to))
          UNWIND nodes(p) as n
          RETURN distinct n
        """
      )
      `
    )
    console.log(schema);
    return makeAugmentedSchema({
      typeDefs: schema,
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