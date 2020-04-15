import fetch from 'node-fetch';
import { driver, session } from '../neo4j/index.js';
import { asyncForEach } from '../utils/async';

const countryNameRemap = {
  'Bolivia': 'Bolivia (Plurinational State of)',
  'North Macedonia': 'Macedonia (the former Yugoslav Republic of)',
  'Republic of China (Taiwan)': 'Taiwan',
  'South Korea': `Korea (Republic of)`,
  'United States': 'United States of America'
}
const getCountries = async (callback) => {
  const countries = await session.run(
    `
      MATCH (country:Country)
      RETURN country
      ORDER BY country.name
    `
  );
  await asyncForEach(countries.records, async (record) => {
    await callback(record.get('country').properties)
  })
}

const setCountryCodes = async ({ name, code }) => {
  let fetchUrl = `https://restcountries.eu/rest/v2/name/${encodeURI(name)}`;
  if (countryNameRemap[name]) fetchUrl = `https://restcountries.eu/rest/v2/name/${countryNameRemap[name]}?fullText=true`;
  try {
    const response = await fetch(fetchUrl);
    const data = await response.json();
    const [{ alpha3Code: code }] = data;
    await session.run(
      `
      MATCH (country:Country)
      WHERE country.name = $name
      SET country.code = $code
      return country
      `, {
        name,
        code,
      }
    );
  }
  catch(e) {
    console.log(name);
  }
}

const setBorderRelationShip = async ({ code }) => {
  if (code) {
    const fetchUrl = `https://restcountries.eu/rest/v2/alpha/${code}`;
    try {
      const response = await fetch(fetchUrl);
      const data = await response.json();
      await asyncForEach(data.borders, async (borderCode) => {
        console.log(code, borderCode);
        const result = await session.run(
          `
          MATCH(a: Country { code: $code1 })
          MATCH(b: Country { code: $code2 })
          MERGE(a)-[:borders]-(b)
          return a, b
          `, {
            code1: code,
            code2: borderCode,
          }
        )
        console.log(result.records[0].get('a').properties);
      })
    }
    catch(e) {
      console.log(e);
    }
  }
}

const insertMissingCountries = async () => {
  try {
    const response = await fetch('https://restcountries.eu/rest/v2/all');
    const data = await response.json();
    await asyncForEach(data, async (country) => {
      const { name, alpha3Code: code } = country;
      const matchingCountry = await session.run(
        `
        MATCH (country:Country)
        WHERE country.code = $code
        AND NOT (country)-[:partOf]-()
        RETURN country.name
        `, {
          code,
        }
      );
      if (matchingCountry.records.length) {
        let { region: continentName } = country;
        if (continentName && continentName !== 'Polar') {
          if (continentName === 'Americas') {
            if (country.subregion === 'South America') continentName = country.subregion;
            continentName = 'North and Central America';
          }

          const test = await session.run(
            `
              MATCH (a:Country),(b:Continent)
              WHERE a.code = $code AND b.name = $continentName
              MERGE (a)-[r:partOf]->(b)
              return a, b
            `, {
              code,
              continentName
            }
          )

          console.log(test.records[0].length);
        }
        // await session.run(
        //   `
        //   MERGE (n:Country { name: $name, code: $code })
        //   `,
        //   {
        //     name,
        //     code
        //   }
        // );
      }
    });
  }
  catch(e) {
    console.log(e);
  }
}


const manualAdaptions = async () => {
  const test = await session.run(
    `
      MATCH (france:Country { name: "France" }), (suriname:Country { name: "Suriname" })
      MATCH (france)-[r:borders]-(suriname)
      DELETE r
    `
  )
  console.log(test.records[0]);
}


(async () => {
  // await insertMissingCountries()
  // await getCountries(setCountryCodes)
  // await getCountries(setBorderRelationShip)
  await manualAdaptions();
  driver.close()
})();