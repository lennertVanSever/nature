import neo4j from 'neo4j-driver';
export const driver = neo4j.driver('bolt://localhost:7687', neo4j.auth.basic('lennert', 'neo4j'));
export const session = driver.session();