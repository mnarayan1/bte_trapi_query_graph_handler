const helper = require('./helper');
const LogEntry = require('./log_entry');
const debug = require('debug')('bte:biothings-explorer-trapi:UpdatedExeEdge');
const utils = require('./utils');
const reverse = require('./biolink');

//This is an edge class based on QExeEdge with more features
module.exports = class UpdatedExeEdge {
  /**
   *
   * @param {string} id - QEdge ID
   * @param {object} info - QEdge info, e.g. subject, object, predicate
   */
  constructor(qEdge, reverse = false, prev_edge = undefined) {
    this.qEdge = qEdge;
    //nodes that make up this edge
    // this.connecting_nodes = [];
    this.reverse = reverse;
    this.prev_edge = prev_edge;
    //object and subject aliases
    this.input_equivalent_identifiers = {};
    this.output_equivalent_identifiers = {};
    //instances of query_node
    //this.object/subject are instances of QNode
    this.object = qEdge.object;
    this.subject = qEdge.subject;
    //entity counts
    // (object #) ----> ()
    this.object_entity_count = this.object.entity_count;
    // () ----> (subject #)
    this.subject_entity_count = this.subject.entity_count;
    //edge has been fully executed
    this.executed = false;
    //run initial checks
    this.logs = [];
    //this edges results
    this.results = [];
    //will need to pick lower value to use for q
    this.requires_entity_count_choice = false;
    //init state
    this.init();
  }

  init() {
    debug(`(2) Created Edge` +
    ` ${JSON.stringify(this.qEdge.getID())} Reverse = ${this.reverse}`)
    // this.checkInitialEntityCount();
    // this.checkConnectingNodes();
    this.checkEdgeEntityCounts();
  }

  checkEdgeEntityCounts() {
    //if both ends of edge have entity counts this edge will
    //require an extra step when saving results
    this.requires_entity_count_choice = this.object_entity_count && this.subject_entity_count ?
    true : false;
  }

  chooseLowerEntityValue() {
    //edge has both subject and object entity counts and must choose lower value
    //to use in query.
    debug(`(8) Choosing lower entity count in edge...`);
    if (this.object_entity_count && this.subject_entity_count) {
      if (this.object_entity_count == this.subject_entity_count) {
        // //(#) ---> ()
        // this.reverse = false;
        // //keep subject curie and delete object curie
        // this.held_object_curies = this.qEdge.object['curie'];
        // debug(`(8) Holding "object" ids ${JSON.stringify(this.held_object_curies)}`);
        // delete this.qEdge.object['curie'];
        // debug(`(8) Sub - Obj were same but chose subject (${this.subject_entity_count})`);

        //() <--- (#)
        this.reverse = true;
        //keep object curie and delete subject curie
        this.held_subject_curies = this.qEdge.subject['curie'];
        //tell node to hold curie in a temp field
        this.qEdge.subject.holdCurie();
        debug(`(8) Chose lower entity value in object (${this.object_entity_count})`);
      }
      else if (this.object_entity_count > this.subject_entity_count) {
        //(#) ---> ()
        this.reverse = false;
        //keep subject curie and delete object curie
        this.held_object_curies = this.qEdge.object['curie'];
        //tell node to hold curie in a temp field
        this.qEdge.object.holdCurie();
        debug(`(8) Chose lower entity value in subject (${this.subject_entity_count})`);
      } else {
        //() <--- (#)
        this.reverse = true;
        //keep object curie and delete subject curie
        this.held_subject_curies = this.qEdge.subject['curie'];
        //tell node to hold curie in a temp field
        this.qEdge.subject.holdCurie();
        debug(`(8) Chose lower entity value in object (${this.object_entity_count})`);
      }
    }else{
      debug(`(8) Error: Edge must have both object and subject entity values.`);
    }
  }

  extractCuriesFromResponse(res) {
    //will give you all curies found by semantic type, each type will have
    //a main ID and all of it's aliases
    debug(`(7) Before Updating "${this.qEdge.getID()}" (${this.subject.entity_count})---(${this.object.entity_count})`);
    debug(`(7) Updating entity counts for current edge and nodes.`);
    let all = {};
    res.forEach((result) => {
      //INPUTS
      result.$input.obj.forEach((o) => {
        //create semantic type if not included
        let type = o._leafSemanticType;
        if (!Object.hasOwnProperty.call(all, type)) {
          all[type] = {};
        }
        //get original and aliases
        let original = result.$input.original;
        let original_aliases = new Set();
        for (const prefix in o._dbIDs) {
          original_aliases.add(prefix + ':' + o._dbIDs[prefix]);
        }
        original_aliases = [...original_aliases];
        //check and add only unique
        let was_found = false;
        original_aliases.forEach((alias) => {
          if (Object.hasOwnProperty.call(all[type], alias)) {
            was_found = true;
          }
        });
        if (!was_found) {
          all[type][original] = original_aliases;
        }
      });
      //INPUTS
      result.$output.obj.forEach((o) => {
        //create semantic type if not included
        let type = o._leafSemanticType;
        if (!Object.hasOwnProperty.call(all, type)) {
          all[type] = {};
        }
        //get original and aliases
        let original = result.$output.original;
        let original_aliases = new Set();
        for (const prefix in o._dbIDs) {
          original_aliases.add(prefix + ':' + o._dbIDs[prefix]);
        }
        original_aliases = [...original_aliases];
        //check and add only unique
        let was_found = false;
        original_aliases.forEach((alias) => {
          if (Object.hasOwnProperty.call(all[type], alias)) {
            was_found = true;
          }
        });
        if (!was_found) {
          all[type][original] = original_aliases;
        }
      });
    });
    // {Gene:{'id': ['alias']}}
    // debug(`ALL ${JSON.stringify(all)}`);
    return all;
  }

  updateNodesCuries(res) {
    let curies_by_semantic_type = this.extractCuriesFromResponse(res);
    this.processCuries(curies_by_semantic_type);
  }

  processCuries(curies) {
    // {Gene:{'id': ['alias']}}
    for (const semantic_type in curies) {
      this.findNodeAndAddCurie(curies[semantic_type], semantic_type);
    }
    debug(`(7) Updated "${this.qEdge.getID()}" (${this.subject.entity_count})---(${this.object.entity_count})`);
  }

  findNodeAndAddCurie(curies, semanticType) {
    //check and update object
    debug(`Updating this edge's "${semanticType}" node curies`);
    let sub_cat = this.qEdge.subject.category.toString();
    let obj_cat = this.qEdge.object.category.toString();
    //match node by semantic type in category
    if (sub_cat.includes(semanticType)) {
      this.qEdge.subject.updateCuries(curies);
    }
    //check and update subject
    else if (obj_cat.includes(semanticType)) {
      this.qEdge.object.updateCuries(curies);
    }else{
      if (sub_cat.includes("NamedThing")) {
        this.qEdge.subject.updateCuries(curies);
      }else if(obj_cat.includes("NamedThing")){
        this.qEdge.object.updateCuries(curies);
      }else{
        debug(`Error: No match for "${semanticType}", did not update node entity counts.`);
      }
    }
  }

  updateEntityCounts() {
    //update counts
    this.object_entity_count = this.object.entity_count;
    this.subject_entity_count = this.subject.entity_count;
    this.checkEdgeEntityCounts();
  }

  storeResults(res) {
    debug(`(6) Storing results...`);
    //store unfiltered results from edge query in edge
    this.results = res;
    debug(`(7) Updating nodes based on edge results...`);
    this.updateNodesCuries(res);
    this.checkEdgeEntityCounts();
  }

  getID() {
    return this.qEdge.getID();
  }

  getHashedEdgeRepresentation() {
    const toBeHashed =
      this.getSubject().getCategories() + this.getPredicate() + this.getObject().getCategories() + this.getInputCurie();
    return new helper()._generateHash(toBeHashed);
  }

  expandPredicates(predicates) {
    const reducer = (acc, cur) => [...acc, ...reverse.getDescendantPredicates(cur)];
    return Array.from(new Set(predicates.reduce(reducer, [])));
  }

  getPredicate() {
    if (this.predicate === undefined) {
      return undefined;
    }
    const predicates = utils.toArray(this.predicate).map((item) => utils.removeBioLinkPrefix(item));
    const expandedPredicates = this.expandPredicates(predicates);
    debug(`Expanded edges: ${expandedPredicates}`);
    return expandedPredicates
      .map((predicate) => {
        return this.isReversed() === true ? reverse.reverse(predicate) : predicate;
      })
      .filter((item) => !(typeof item === 'undefined'));
  }

  getSubject() {
    if (this.reverse) {
      return this.qEdge.object;
    }
    return this.qEdge.subject;
  }

  getObject() {
    if (this.reverse) {
      return this.qEdge.subject;
    }
    return this.qEdge.object;
  }

  isReversed() {
    return this.reverse;
  }

  getInputCurie() {
    let curie = this.qEdge.subject.getCurie() || this.qEdge.object.getCurie();
    if (Array.isArray(curie)) {
      return curie;
    }
    return [curie];
  }

  getInputNode() {
    return this.reverse ? this.qEdge.object : this.qEdge.subject;
  }

  getOutputNode() {
    return this.reverse ? this.qEdge.subject : this.qEdge.object;
  }

  hasInputResolved() {
    return !(Object.keys(this.input_equivalent_identifiers).length === 0);
  }

  hasInput() {
    if (this.reverse) {
      return this.qEdge.object.hasInput();
    }
    return this.qEdge.subject.hasInput();
  }
};

