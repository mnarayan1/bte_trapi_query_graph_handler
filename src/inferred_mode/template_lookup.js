const fs = require('fs').promises;
const path = require('path');
const async = require('async');

exports.getTemplates = async (lookups) => {
  const getFiles = async (dir) => {
    const rootFiles = await fs.readdir(path.resolve(dir));
    return await async.reduce(rootFiles, [], async (arr, fname) => {
      const fPath = path.join(dir, fname);
      if ((await fs.lstat(fPath)).isDirectory()) {
        return [...arr, ...(await getFiles(fPath))];
      }
      return [...arr, fPath];
    });
  };
  const templatePathsOnly = await getFiles(path.resolve(__dirname, '../../data/templates'));
  const templatePaths = Object.fromEntries(
    templatePathsOnly.map((templatePath) => {
      return [path.basename(templatePath), templatePath];
    }),
  );
  const templateGroups = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../data/templateGroups.json')));
  const matchingTemplatePaths = [
    ...templateGroups.reduce((matches, group) => {
      const lookupMatch = lookups.some((lookup) => {
        return (
          group.subject.includes(lookup.subject) &&
          group.object.includes(lookup.object) &&
          group.predicate.includes(lookup.predicate) &&
          Object.entries(lookup.qualifiers || {}).every(([qualifierType, qualifierValue]) => {
            return (group.qualifiers || {})[qualifierType] && group.qualifiers[qualifierType] === qualifierValue;
          })
        );
      });

      if (lookupMatch) {
        group.templates.forEach((template) => {
          if (!matches.includes(templatePaths[template])) {
            matches.push(templatePaths[template])
          }
        });
      }
      return matches;
    }, []),
  ];
  return await async.map(matchingTemplatePaths, async (templatePath) => {
    return {
      template: templatePath.substring(templatePath.lastIndexOf('/') + 1),
      queryGraph: JSON.parse(await fs.readFile(templatePath)).message.query_graph,
    };
  });
};

exports.supportedLookups = async () => {
  const edges = new Set();
  const templateGroups = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../data/templateGroups.json')));
  templateGroups.forEach((group) => {
    group.subject.forEach((subject) => {
      group.predicate.forEach((predicate) => {
        group.object.forEach((object) => {
          edges.add({
            subject: `biolink:${subject}`,
            predicate: `biolink:${predicate}`,
            object: `biolink:${object}`,
            qualifiers: group.qualifiers
          });
        });
      });
    });
  });
  return [...edges];
}
