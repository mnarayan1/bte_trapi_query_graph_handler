const helper = require('./helper');
const debug = require('debug')('bte:biothings-explorer-trapi:QEdge');
const utils = require('./utils');
const biolink = require('./biolink');
const { Record } = require('@biothings-explorer/api-response-transform');
const QNode = require('./query_node');

module.exports = class QEdge {
  /**
   *
   * @param {object} info - QEdge info, e.g. ID, subject, object, predicate
   * @param {boolean} reverse - is QEdge reversed?
   */
  constructor(info, reverse) {
    this.id = info.id;
    this.predicate = info.predicates;
    this.subject = info.frozen === true ? new QNode(info.subject) : info.subject;
    this.object = info.frozen === true ? new QNode(info.object) : info.object;
    this.expanded_predicates = [];
    this.qualifier_constraints = info.qualifier_constraints || [];

    this.reverse = this.subject?.getCurie?.() === undefined && this.object?.getCurie?.() !== undefined;

    this.reverse = info.reverse !== undefined ? info.reverse : this.reverse;
    this.reverse = reverse !== undefined ? reverse : this.reverse;

    this.init();

    //edge has been fully executed
    this.executed = info.executed === undefined ? false : info.executed;
    //run initial checks
    this.logs = info.logs === undefined ? [] : info.logs;

    //this edges query response records
    if (info.records && info.frozen === true) this.records = info.records.map((recordJSON) => new Record(recordJSON));
    else this.records = [];

    debug(`(2) Created Edge` + ` ${JSON.stringify(this.getID())} Reverse = ${this.reverse}`);
  }

  freeze() {
    return {
      id: this.id,
      predicate: this.predicate,
      expanded_predicates: this.expanded_predicates,
      qualifier_constraints: this.qualifier_constraints,
      executed: this.executed,
      reverse: this.reverse,
      logs: this.logs,
      subject: this.subject.freeze(),
      object: this.object.freeze(),
      predicate: this.predicate,
      records: this.records.map((record) => record.freeze()),
      frozen: true,
    };
  }

  init() {
    this.expanded_predicates = this.getPredicate();
  }

  getID() {
    return this.id;
  }

  getHashedEdgeRepresentation() {
    // all values sorted so same qEdge with slightly different orders will hash the same
    const qualifiersSorted = (this.getSimpleQualifierConstraints() || [])
      .map((qualifierSet) => {
        return Object.entries(qualifierSet)
          .sort(([qTa, qVa], [qTb, qVb]) => qTa.localeCompare(qTb))
          .reduce((str, [qType, qVal]) => `${str}${qType}:${qVal};`, '');
      })
      .sort((setString1, setString2) => setString1.localeCompare(setString2));

    const toBeHashed =
      (this.getInputNode().getCategories() || []).sort() +
      (this.getPredicate() || []).sort() +
      (this.getOutputNode().getCategories() || []).sort() +
      (this.getInputCurie() || []).sort() +
      qualifiersSorted;

    return helper._generateHash(toBeHashed);
  }

  expandPredicates(predicates) {
    const reducer = (acc, cur) => [...acc, ...biolink.getDescendantPredicates(cur)];
    return Array.from(new Set(predicates.reduce(reducer, [])));
  }

  getPredicate() {
    if (this.predicate === undefined || this.predicate === null) {
      return undefined;
    }
    const predicates = utils.toArray(this.predicate).map((item) => utils.removeBioLinkPrefix(item));
    const expandedPredicates = this.expandPredicates(predicates);
    debug(`Expanded edges: ${expandedPredicates}`);
    return expandedPredicates
      .map((predicate) => {
        return this.isReversed() === true ? biolink.reverse(predicate) : predicate;
      })
      .filter((item) => !(typeof item === 'undefined'));
  }

  expandQualifierConstraints(constraints) {
    return constraints.map((qualifierSetObj) => {
      return {
        qualifier_set: qualifierSetObj.qualifier_set.map(({ qualifier_type_id, qualifier_value }) => {
          const new_qualifier_values = qualifier_type_id.includes('predicate') ?
            Array.from(new Set(biolink.getDescendantPredicates(utils.removeBioLinkPrefix(qualifier_value)).map(item => `biolink:${utils.removeBioLinkPrefix(item)}`))) :
            Array.from(new Set(biolink.getDescendantQualifiers(utils.removeBioLinkPrefix(qualifier_value))));

          return {
            qualifier_type_id,
            qualifier_value: new_qualifier_values
          }
        })
      }
    })
  }

  getQualifierConstraints() {
    if (!this.qualifier_constraints) {
      return [];
    }
    if (this.isReversed()) {
      return this.qualifier_constraints.map((qualifierSetObj) => {
        return {
          qualifier_set: qualifierSetObj.qualifier_set.map(({ qualifier_type_id, qualifier_value }) => {
            let newQualifierType = qualifier_type_id;
            let newQualifierValue = qualifier_value;
            if (qualifier_type_id.includes('predicate')) {
              newQualifierValue = `biolink:${this.getReversedPredicate(qualifier_value.replace('biolink:', ''))}`;
            }
            if (qualifier_type_id.includes('subject')) {
              newQualifierType = qualifier_type_id.replace('subject', 'object');
            }
            if (qualifier_type_id.includes('object')) {
              newQualifierType = qualifier_type_id.replace('object', 'subject');
            }
            return {
              qualifier_type_id: newQualifierType,
              qualifier_value: newQualifierValue,
            };
          }),
        };
      });
    }
    return this.qualifier_constraints;
  }

  getSimpleQualifierConstraints() {
    const constraints = this.getQualifierConstraints().map((qualifierSetObj) => {
      return Object.fromEntries(
        qualifierSetObj.qualifier_set.map(({ qualifier_type_id, qualifier_value }) => [
          qualifier_type_id.replace('biolink:', ''),
          qualifier_value.replace('biolink:', ''),
        ]),
      );
    });
    return constraints.length > 0 ? constraints : undefined;
  }

  getSimpleExpandedQualifierConstraints() {
    const constraints = this.expandQualifierConstraints(this.getQualifierConstraints()).map((qualifierSetObj) => {
      return Object.fromEntries(
        qualifierSetObj.qualifier_set.map(({ qualifier_type_id, qualifier_value }) => [
          utils.removeBioLinkPrefix(qualifier_type_id),
          utils.toArray(qualifier_value).map(e => utils.removeBioLinkPrefix(e)),
        ]),
      );
    });
    return constraints.length > 0 ? constraints : undefined;
  }

  chooseLowerEntityValue() {
    //edge has both subject and object entity counts and must choose lower value
    //to use in query.
    debug(`(8) Choosing lower entity count in edge...`);
    if (this.object.entity_count && this.subject.entity_count) {
      if (this.object.entity_count == this.subject.entity_count) {
        // //(#) ---> ()
        this.reverse = false;
        this.object.holdCurie();
        debug(`(8) Sub - Obj were same but chose subject (${this.subject.entity_count})`);
      } else if (this.object.entity_count > this.subject.entity_count) {
        //(#) ---> ()
        this.reverse = false;
        //tell node to hold curie in a temp field
        this.object.holdCurie();
        debug(`(8) Chose lower entity value in subject (${this.subject.entity_count})`);
      } else {
        //() <--- (#)
        this.reverse = true;
        //tell node to hold curie in a temp field
        this.subject.holdCurie();
        debug(`(8) Chose lower entity value in object (${this.object.entity_count})`);
      }
    } else {
      debug(`(8) Error: Edge must have both object and subject entity values.`);
    }
  }

  extractCuriesFromRecords(records, isReversed) {
    //will give you all curies found by semantic type, each type will have
    //a main ID and all of it's aliases
    debug(`(7) Updating Entities in "${this.getID()}"`);
    let typesToInclude = isReversed ? this.subject.getCategories() : this.object.getCategories();
    debug(`(7) Collecting Types: "${JSON.stringify(typesToInclude)}"`);
    let all = {};
    records.forEach((record) => {
      const subjectTypes = record.subject.semanticType.map((type) => type.replace('biolink:', ''));
      const objectTypes = record.object.semanticType.map((type) => type.replace('biolink:', ''));
      const nodeOriginals = {
        subject: record.subject.original,
        object: record.object.original,
      };

      Object.entries({ subject: subjectTypes, object: objectTypes }).forEach(([node, nodeTypes]) => {
        nodeTypes.forEach((nodeType) => {
          const nodeOriginal = nodeOriginals[node];

          if (!typesToInclude.includes(nodeType) && !typesToInclude.includes('NamedThing')) {
            return;
          }
          if (!all[nodeType]) {
            all[nodeType] = {};
          }
          let originalAliases = new Set();
          record[node].equivalentCuries.forEach((curie) => {
            originalAliases.add(curie);
          });
          originalAliases = [...originalAliases];
          // check and add only unique
          let wasFound = false;
          originalAliases.forEach((alias) => {
            if (all[nodeType][alias]) {
              wasFound = true;
            }
          });
          if (!wasFound) {
            all[nodeType][nodeOriginal] = originalAliases;
          }

          if (!all[nodeType][nodeOriginal] || all[nodeType][nodeOriginal].length === 0) {
            if (record[node].curie.length > 0) {
              // else #2 check curie
              all[nodeType][nodeOriginal] = [record[node].curie];
            } else {
              // #3 last resort check original
              all[nodeType][nodeOriginal] = [nodeOriginal];
            }
          }
        });
      });

      // record.subject.normalizedInfo.forEach((o) => {
      //   //create semantic type if not included
      //   let type = o._leafSemanticType;
      //   if (
      //     typesToInclude.includes(type) ||
      //     typesToInclude.includes('NamedThing') ||
      //     typesToInclude.toString().includes(type)
      //   ) {

      //     //get original and aliases
      //     let original = record.subject.original;
      //     //#1 prefer equivalent ids
      //     if (Object.hasOwnProperty.call(o, '_dbIDs')) {
      //       let original_aliases = new Set();
      //       for (const prefix in o._dbIDs) {
      //         //check if array
      //         if (Array.isArray(o._dbIDs[prefix])) {
      //           o._dbIDs[prefix].forEach((single_alias) => {
      //             if (single_alias) {
      //               if (single_alias.includes(':')) {
      //                 //value already has prefix
      //                 original_aliases.add(single_alias);
      //               } else {
      //                 //concat with prefix
      //                 original_aliases.add(prefix + ':' + single_alias);
      //               }
      //             }
      //           });
      //         } else {
      //           if (o._dbIDs[prefix].includes(':')) {
      //             //value already has prefix
      //             original_aliases.add(o._dbIDs[prefix]);
      //           } else {
      //             //concat with prefix
      //             original_aliases.add(prefix + ':' + o._dbIDs[prefix]);
      //           }
      //         }
      //       }
      //       original_aliases = [...original_aliases];
      //       //check and add only unique
      //       let was_found = false;
      //       original_aliases.forEach((alias) => {
      //         if (Object.hasOwnProperty.call(all[type], alias)) {
      //           was_found = true;
      //         }
      //       });
      //       if (!was_found) {
      //         all[type][original] = original_aliases;
      //       }
      //     }

      //   }
      // });

      // record.object.normalizedInfo.forEach((o) => {
      //   //create semantic type if not included
      //   let type = o._leafSemanticType;
      //   if (
      //     typesToInclude.includes(type) ||
      //     typesToInclude.includes('NamedThing') ||
      //     typesToInclude.toString().includes(type)
      //   ) {
      //     if (!Object.hasOwnProperty.call(all, type)) {
      //       all[type] = {};
      //     }
      //     //get original and aliases
      //     let original = record.object.original;

      //     //#1 prefer equivalent ids
      //     if (Object.hasOwnProperty.call(o, '_dbIDs')) {
      //       let original_aliases = new Set();
      //       for (const prefix in o._dbIDs) {
      //         //check if array
      //         if (Array.isArray(o._dbIDs[prefix])) {
      //           o._dbIDs[prefix].forEach((single_alias) => {
      //             if (single_alias) {
      //               if (single_alias.includes(':')) {
      //                 //value already has prefix
      //                 original_aliases.add(single_alias);
      //               } else {
      //                 //concat with prefix
      //                 original_aliases.add(prefix + ':' + single_alias);
      //               }
      //             }
      //           });
      //         } else {
      //           if (o._dbIDs[prefix].includes(':')) {
      //             //value already has prefix
      //             original_aliases.add(o._dbIDs[prefix]);
      //           } else {
      //             //concat with prefix
      //             original_aliases.add(prefix + ':' + o._dbIDs[prefix]);
      //           }
      //         }
      //       }
      //       original_aliases = [...original_aliases];
      //       //check and add only unique
      //       let was_found = false;
      //       original_aliases.forEach((alias) => {
      //         if (Object.hasOwnProperty.call(all[type], alias)) {
      //           was_found = true;
      //         }
      //       });
      //       if (!was_found) {
      //         all[type][original] = original_aliases;
      //       }
      //     }
      //     //else #2 check curie
      //     else if (Object.hasOwnProperty.call(o, 'curie')) {
      //       if (Array.isArray(o.curie)) {
      //         all[type][original] = o.curie;
      //       } else {
      //         all[type][original] = [o.curie];
      //       }
      //     }
      //     //#3 last resort check original
      //     else {
      //       all[type][original] = [original];
      //     }
      //   }
      // });
    });
    debug(`Collected entity ids in records: ${JSON.stringify(Object.keys(all))}`);
    return all;
    // {Gene:{'id': ['alias']}}
  }

  _combineCuries(curies) {
    //combine all curies in case there are
    //multiple categories in this node since
    //they are separated by type
    let combined = {};
    for (const type in curies) {
      for (const original in curies[type]) {
        combined[original] = curies[type][original];
      }
    }
    return combined;
  }

  updateNodesCuries(records) {
    //update node queried (1) ---> (update)
    let curies_by_semantic_type = this.extractCuriesFromRecords(records, this.reverse);
    let combined_curies = this._combineCuries(curies_by_semantic_type);
    this.reverse ? this.subject.updateCuries(combined_curies) : this.object.updateCuries(combined_curies);
    //update node used as input (1 [update]) ---> ()
    let curies_by_semantic_type_2 = this.extractCuriesFromRecords(records, !this.reverse);
    let combined_curies_2 = this._combineCuries(curies_by_semantic_type_2);
    !this.reverse ? this.subject.updateCuries(combined_curies_2) : this.object.updateCuries(combined_curies_2);
  }

  applyNodeConstraints() {
    debug(`(6) Applying Node Constraints to ${this.records.length} records.`);
    let kept = [];
    let save_kept = false;
    let sub_constraints = this.subject.constraints;
    if (sub_constraints && sub_constraints.length) {
      let from = this.reverse ? 'object' : 'subject';
      debug(`Node (subject) constraints: ${JSON.stringify(sub_constraints)}`);
      save_kept = true;
      for (let i = 0; i < this.records.length; i++) {
        const res = this.records[i];
        let keep = true;
        //apply constraints
        for (let x = 0; x < sub_constraints.length; x++) {
          const constraint = sub_constraints[x];
          keep = this.meetsConstraint(constraint, res, from);
        }
        //pass or not
        if (keep) {
          kept.push(res);
        }
      }
    }

    let obj_constraints = this.object.constraints;
    if (obj_constraints && obj_constraints.length) {
      let from = this.reverse ? 'subject' : 'object';
      debug(`Node (object) constraints: ${JSON.stringify(obj_constraints)}`);
      save_kept = true;
      for (let i = 0; i < this.records.length; i++) {
        const res = this.records[i];
        let keep = true;
        //apply constraints
        for (let x = 0; x < obj_constraints.length; x++) {
          const constraint = obj_constraints[x];
          keep = this.meetsConstraint(constraint, res, from);
        }
        //pass or not
        if (keep) {
          kept.push(res);
        }
      }
    }
    if (save_kept) {
      //only override recordss if there was any filtering done.
      this.records = kept;
      debug(`(6) Reduced to (${this.records.length}) records.`);
    } else {
      debug(`(6) No constraints. Skipping...`);
    }
  }

  meetsConstraint(constraint, record, from) {
    //list of attribute ids in node
    let available_attributes = new Set();
    for (const key in record[from].attributes) {
      available_attributes.add(key);
    }
    available_attributes = [...available_attributes];
    // debug(`ATTRS ${JSON.stringify(record[from].normalizedInfo[0]._leafSemanticType)}` +
    // ` ${from} : ${JSON.stringify(available_attributes)}`);
    //determine if node even contains right attributes
    let filters_found = available_attributes.filter((attr) => attr == constraint.id);
    if (!filters_found.length) {
      //node doesn't have the attribute needed
      return false;
    } else {
      //match attr by name, parse only attrs of interest
      let node_attributes = {};
      filters_found.forEach((filter) => {
        node_attributes[filter] = record[from].attributes[filter];
      });
      switch (constraint.operator) {
        case '==':
          for (const key in node_attributes) {
            if (!isNaN(constraint.value)) {
              if (Array.isArray(node_attributes[key])) {
                if (
                  node_attributes[key].includes(constraint.value) ||
                  node_attributes[key].includes(constraint.value.toString())
                ) {
                  return true;
                }
              } else {
                if (
                  node_attributes[key] == constraint.value ||
                  node_attributes[key] == constraint.value.toString() ||
                  node_attributes[key] == parseInt(constraint.value)
                ) {
                  return true;
                }
              }
            } else {
              if (Array.isArray(node_attributes[key])) {
                if (node_attributes[key].includes(constraint.value)) {
                  return true;
                }
              } else {
                if (
                  node_attributes[key] == constraint.value ||
                  node_attributes[key] == constraint.value.toString() ||
                  node_attributes[key] == parseInt(constraint.value)
                ) {
                  return true;
                }
              }
            }
          }
          return false;
        case '>':
          for (const key in node_attributes) {
            if (Array.isArray(node_attributes[key])) {
              for (let index = 0; index < node_attributes[key].length; index++) {
                const element = node_attributes[key][index];
                if (parseInt(element) > parseInt(constraint.value)) {
                  return true;
                }
              }
            } else {
              if (parseInt(node_attributes[key]) > parseInt(constraint.value)) {
                return true;
              }
            }
          }
          return false;
        case '>=':
          for (const key in node_attributes) {
            if (Array.isArray(node_attributes[key])) {
              for (let index = 0; index < node_attributes[key].length; index++) {
                const element = node_attributes[key][index];
                if (parseInt(element) >= parseInt(constraint.value)) {
                  return true;
                }
              }
            } else {
              if (parseInt(node_attributes[key]) >= parseInt(constraint.value)) {
                return true;
              }
            }
          }
          return false;
        case '<':
          for (const key in node_attributes) {
            if (Array.isArray(node_attributes[key])) {
              for (let index = 0; index < node_attributes[key].length; index++) {
                const element = node_attributes[key][index];
                if (parseInt(element) > parseInt(constraint.value)) {
                  return true;
                }
              }
            } else {
              if (parseInt(node_attributes[key]) < parseInt(constraint.value)) {
                return true;
              }
            }
          }
          return false;
        case '<=':
          for (const key in node_attributes) {
            if (Array.isArray(node_attributes[key])) {
              for (let index = 0; index < node_attributes[key].length; index++) {
                const element = node_attributes[key][index];
                if (parseInt(element) <= parseInt(constraint.value)) {
                  return true;
                }
              }
            } else {
              if (parseInt(node_attributes[key]) <= parseInt(constraint.value)) {
                return true;
              }
            }
          }
          return false;
        default:
          debug(`Node operator not handled ${constraint.operator}`);
          return false;
      }
    }
  }

  storeRecords(records) {
    debug(`(6) Storing records...`);
    //store new records in current edge
    this.records = records;
    //will update records if any constraints are found
    this.applyNodeConstraints();
    debug(`(7) Updating nodes based on edge records...`);
    this.updateNodesCuries(records);
  }

  expandPredicates(predicates) {
    const reducer = (acc, cur) => [...acc, ...biolink.getDescendantPredicates(cur)];
    return Array.from(new Set(predicates.reduce(reducer, [])));
  }

  getInputNode() {
    if (this.reverse) {
      return this.object;
    }
    return this.subject;
  }

  getOutputNode() {
    if (this.reverse) {
      return this.subject;
    }
    return this.object;
  }

  isReversed() {
    return this.reverse;
  }

  getInputCurie() {
    let curie = this.subject.getCurie() || this.object.getCurie();
    if (Array.isArray(curie)) {
      return curie;
    }
    return [curie];
  }

  hasInputResolved() {
    return this.getInputNode().hasEquivalentIDs();
  }

  hasInput() {
    if (this.reverse) {
      return this.object.hasInput();
    }
    return this.subject.hasInput();
  }

  getReversedPredicate(predicate) {
    return predicate ? biolink.reverse(predicate) : undefined;
  }
};
