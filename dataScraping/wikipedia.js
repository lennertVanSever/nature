const fetch = require('node-fetch');
var html2json = require('html2json').html2json;
const neo4j = require('neo4j-driver')
const driver = neo4j.driver('bolt://localhost:7687', neo4j.auth.basic('lennert', 'neo4j'));
const session = driver.session();
const fs = require('fs');
var cheerio = require('cheerio'),
    cheerioTableparser = require('cheerio-tableparser');


async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

const createContinents = async (callback) => {
  const response = await fetch('https://en.wikipedia.org/w/api.php?action=parse&page=List_of_national_parks&format=json&prop=sections');
  const data = await response.json();
  await asyncForEach(data.parse.sections, async ({ number, line: continentName, index }) => {
    if (index < 7) {
      await session.run(
        `
        CREATE (n:Continent { name: $continentName })
        `,
        {
          continentName
        }
      );
      await callback(continentName, number)
    }
  });
}

const removeWikiPrefix = link => link.replace('/wiki/', '');

const getCountryMetaData = async (continentName, sectionId) => {
  // console.log(continentName, sectionId);
  const response = await fetch(`https://en.wikipedia.org/w/api.php?action=parse&page=List_of_national_parks&format=json&section=${sectionId}`);
  const data = await response.json();
  textData = html2json(data.parse.text['*'])
  await asyncForEach(textData.child[0].child, async ({ child, tag }) => {
    if (tag === 'table') {
      const tr = child[1].child;
      await asyncForEach(tr, async ({ child }) => {
        if (child) {
          await asyncForEach(child, async ({ node, child }) => {
            if (node === 'element' && child && child[0].node === 'element') {
              const nationalParksLink = removeWikiPrefix(child[0].attr.href);
              const countryName = child[0].child[0].text;
              await createCountry(countryName, nationalParksLink, continentName)
            }
          })
        }
      })
    }
  })
}

const activeWikiLink = link => link && !link.includes('redlink=1');

const createCountry = async (countryName, nationalParksLink, continentName) => {
  if (activeWikiLink(nationalParksLink) && isNaN(countryName)) {
      await session.run(
        `
        MERGE (n:Country { name: $countryName, nationalParksLink: $nationalParksLink })
        `,
        {
          countryName,
          nationalParksLink
        }
      );
      await session.run(
        `
          MATCH (a:Country),(b:Continent)
          WHERE a.name = "${countryName}" AND b.name = "${continentName}"
          CREATE (a)-[r:locatedIn]->(b)
          RETURN type(r)
        `, {
          countryName,
          continentName
        }
      );
      console.log(countryName, nationalParksLink, continentName);
  }
}

const decodeHtmlHexCode = (input) => {
  const REG_HEX = /&#x([a-fA-F0-9]+);/g;

  return input.replace(REG_HEX, function(match, group1){
      var num = parseInt(group1, 16); //=> 39
      return String.fromCharCode(num); //=> '
  });
}

const createNationalPark = async (countryName, nationalParkWikiLink, nationalParkName) => {
  console.log(countryName, nationalParkWikiLink, nationalParkName);
    await session.run(
      `
      MERGE (n:NationalPark { name: $nationalParkName, wikiLink: $nationalParkWikiLink })
      `,
      {
        nationalParkName,
        nationalParkWikiLink
      }
    );
    await session.run(
      `
        MATCH (a:NationalPark),(b:Country)
        WHERE a.name = "${nationalParkName}" AND b.name = "${countryName}"
        MERGE (a)-[r:locatedIn]->(b)
        RETURN type(r)
      `, {
        nationalParkName,
        countryName
      }
    );
}

const sleep = ms => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const getCountryList = async (callback) => {
  const countriesData = await session.run(
    `
      MATCH (country:Country)
      RETURN country.nationalParksLink, country.name
      ORDER BY country.name
    `
  );
  await callback(countriesData);
}

const getCountryWithoutRelationshipsList = async (callback) => {
  const countriesData = await session.run(
    `
    MATCH (country:Country)
    WHERE size((country)--()) = 1
    RETURN country.nationalParksLink, country.name
    ORDER BY country.name
    `
  );
  await getNationalParkData(countriesData, createNationalPark);
}

const getNationalParkData = async (countriesData, callback) => {
  await asyncForEach(countriesData.records, async (record, index) => {
    const countryName = record.get('country.name');
    const wikiFetchLink = `https://en.wikipedia.org/w/api.php?action=parse&page=${record.get('country.nationalParksLink')}&format=json&redirects`;

    const fetchData = async (countryName, wikiFetchLink) => {
      try {
        const response = await fetch(wikiFetchLink);
        const data = await response.json();
        await sleep(1000);

        const canContinueToProcess = (() => {
          const { redirects } = data.parse;
          if (redirects.length === 0) return true;
          if (redirects[0].tofragment) {
            console.log(redirects);
            return false;
          }
          return true;
        })();

        
        if (canContinueToProcess) {
            const raw = data.parse.text['*'].replace(/(\r\n|\n|\r)/gm, "");
            let htmlTable = raw.match(/<table class="(wikitable|sortable)(.*?)<\/table>/g);
            if (htmlTable) {
              htmlTable = htmlTable.join('')
              $ = cheerio.load(htmlTable);
              cheerioTableparser($);
              table = $("table").parsetable();
              const nameLinks = table[0][0] === 'Name' ? table[0] : table[1];
              await asyncForEach(nameLinks, async (nameLink) => {
                // const cleanNameLink = decodeHtmlHexCode(nameLink.replace(/\&quot;/g, '').replace(/\\/g, '').replace(/title="(.*?)>/g, '>'))
                if (nameLink !== 'Name' && nameLink) {
                  const selectedLink = $(nameLink).find('a:first-child');
                  console.log(wikiFetchLink, selectedLink);
                  if (selectedLink) {
                    const { href: wikiLink, title: name } = selectedLink.attr();
                    if (wikiLink && name && activeWikiLink(wikiLink)) {
                      await callback(countryName, wikiLink, name);
                    }
                  }
                }
              })
            } else {
              const firstUnorderedList = /<ul><li><a(.*?)<\/ul>/.exec(raw)[0];
              var $ = cheerio.load(firstUnorderedList);
              const nameLinks = [];
              $('li a:first-child').each(function(i, elm) {
                const { href: wikiLink, title: name } = $(this).attr();
                if (activeWikiLink(wikiLink) && name) {
                  nameLinks.push({ wikiLink, name });
                }
              })
              await asyncForEach(nameLinks, async ({ wikiLink, name }) => {
                await callback(countryName, wikiLink, name);
              });
            }
        }
           
      } catch(e) {
        console.log(e, 'ERROR')
      }
    }
    await fetchData(countryName, wikiFetchLink);
  })
}

const updateNationalPark = async (nationalParkId, latitude, longitude, description) => {
  console.log(nationalParkId, latitude, longitude, description);
  await session.run(
    `
    MATCH (nationalPark:NationalPark)
    WHERE ID(nationalPark) = ${nationalParkId}
    SET nationalPark.latitude = ${latitude}, nationalPark.longitude = ${longitude}, nationalPark.wikiDescription = ${description} 
    return nationalPark
    `, {
      nationalParkId,
      latitude,
      longitude,
      description
    }
  );
}

const addImagesToNationalPark = async (images, nationalParkId) => {
  await asyncForEach(images, async ({ title: name }, index) => {
    console.log(name, index);
    await session.run(
      `
      MERGE (n:Image { name: $name, index: $index })
      `,
      {
        name,
        index
      }
    );
    await session.run(
      `
        MATCH (a:Image),(b:NationalPark)
        WHERE a.name = $name AND ID(b) = $nationalParkId
        MERGE (a)-[r:shotIn]->(b)
        RETURN type(r)
      `, {
        name,
        nationalParkId
      }
    );

  });
}

const getNationalParkMetaData = async () => {
  const nationalParks = await session.run(
    `
      MATCH (nationalPark:NationalPark)
      RETURN nationalPark.wikiLink, ID(nationalPark)
      ORDER BY nationalPark.name
    `
  );

  await asyncForEach(nationalParks.records, async (record, index) => {
    const nationalParkWikiLink = removeWikiPrefix(record.get('nationalPark.wikiLink'));
    const nationalParkId = record.get('ID(nationalPark)');
    const wikiFetchLink = `https://en.wikipedia.org/w/api.php?format=json&action=query&prop=images|coordinates|extracts&exintro&explaintext&titles=${nationalParkWikiLink}&redirects`;
    try {
      const response = await fetch(wikiFetchLink);
      const data = await response.json();
      await sleep(1000);
      const {
        query: {
          pages
        }
      } = data;

      const {
        images,
        coordinates: [{
          lat, lon
        }],
        extract
      } = pages[Object.keys(pages)[0]];
      await updateNationalPark(nationalParkId, lat, lon, JSON.stringify(extract));
      await addImagesToNationalPark(images, nationalParkId)
    }
    catch(e) {
      console.log(e);
    }
  });

}

const setMetaDataImage = async (id, url, width, height) => {
  console.log(id, url, width, height);
  await session.run(
    `
    MATCH (image:Image)
    WHERE ID(image) = $id
    SET image.url = $url, image.width = $width, image.height = $height
    return image
    `, {
      id,
      url,
      width,
      height
    }
  );
}

const getMetaDataImages = async () => {
  const images = await session.run(
    `
      MATCH (image:Image)
      WHERE NOT EXISTS(image.url)
      RETURN image.url, image.fileReference, ID(image)
      ORDER BY image.name
    `
  );
  await asyncForEach(images.records, async (record, index) => {
    const imageFileReference = encodeURI(record.get('image.fileReference'));
    const imageId = record.get('ID(image)');
    console.log(imageFileReference);
    const wikiFetchLink = `https://en.wikipedia.org/w/api.php?action=query&titles=${imageFileReference}&prop=imageinfo&iiprop=url|dimensions&format=json&iiurlwidth=700`;
    try {
      const response = await fetch(wikiFetchLink);
      const data = await response.json();
      await sleep(1000);

      const {
        query: {
          pages
        }
      } = data;

      const {
        thumburl: url,
        thumbwidth: width,
        thumbheight: height
      } = pages[Object.keys(pages)[0]].imageinfo[0];
      setMetaDataImage(imageId, url, width, height);
    }
    catch(e) {
      console.log(e);
    }
  });
}

const cleanUpImageName = async () => {
  const images = await session.run(
    `
      MATCH (image:Image)
      return image.name, ID(image)
    `
  );
  await asyncForEach(images.records, async (record, index) => {
    const imageName = record.get('image.name');
    const imageId = record.get('ID(image)');
    console.log(imageId);
    const newImageName = decodeURI(imageName.replace('File:', '').replace(/\..+/g, ''));
    if (newImageName) {
      await session.run(
        `
          MATCH (image:Image)
          WHERE ID(image) = $imageId
          SET image.name = $newImageName
          RETURN image
        `,
        {
          imageId,
          newImageName
        }
      );
    }

  });
}

(async () => {
  // await createContinents(
  //   getCountryMetaData
  // )
  // await getCountryList(getNationalParkData(createNationalPark));
  // await getCountryWithoutRelationshipsList();

  // await getNationalParkMetaData();
  // await getMetaDataImages();
  await cleanUpImageName();
  driver.close()
})();
