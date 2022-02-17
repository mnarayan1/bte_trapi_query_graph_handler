const QEdge = require('./query_edge');
const InvalidQueryGraphError = require('./exceptions/invalid_query_graph_error');
const LogEntry = require('./log_entry');
const ExeEdge = require('./query_execution_edge');
const debug = require('debug')('bte:biothings-explorer-trapi:query_graph');
const QNode = require('./query_node');
const biolink = require('./biolink');
const id_resolver = require('biomedical_id_resolver');
const _ = require('lodash');
const utils = require('./utils');

module.exports = class QueryGraphHandler {
  constructor(queryGraph) {
    this.queryGraph = queryGraph;
    this.logs = [];
  }

  _validateEmptyNodes(queryGraph) {
    if (Object.keys(queryGraph.nodes).length === 0) {
      throw new InvalidQueryGraphError('Your Query Graph has no nodes defined.');
    }
  }

  _validateEmptyEdges(queryGraph) {
    if (Object.keys(queryGraph.edges).length === 0) {
      throw new InvalidQueryGraphError('Your Query Graph has no edges defined.');
    }
  }

  _validateNodeEdgeCorrespondence(queryGraph) {
    for (let edge_id in queryGraph.edges) {
      if (!(this.queryGraph.edges[edge_id].subject in queryGraph.nodes)) {
        throw new InvalidQueryGraphError(`The subject of edge ${edge_id} is not defined in the query graph.`);
      }
      if (!(this.queryGraph.edges[edge_id].object in queryGraph.nodes)) {
        throw new InvalidQueryGraphError(`The object of edge ${edge_id} is not defined in the query graph.`);
      }
    }
  }

  _validate(queryGraph) {
    this._validateEmptyEdges(queryGraph);
    this._validateEmptyNodes(queryGraph);
    this._validateNodeEdgeCorrespondence(queryGraph);
  }

  /**
   * @private
   */
    async _findNodeCategories(ids) {
      if (ids.length == 1) {
        let category = await id_resolver.resolveSRI({
            unknown: ids
        });
        debug(`Query node missing categories...Looking for match...`);
        if (Object.hasOwnProperty.call(category, ids[0])) {
            category = category[ids[0]][0]['semanticType'];
            return ["biolink:" + category];
        } else {
            debug(`No category match found for ${JSON.stringify(ids)}.`);
            return [];
        }
    } else {
      const categories = await id_resolver.resolveSRI({unknown: ids});
      const commonCategories = _.intersection(
        ...Object.values(categories)
        .map(curie => curie[0].semanticTypes)
        .filter(semanticTypes => !semanticTypes.every(item => item === null))
        .map(semanticTypes => semanticTypes.map(t => utils.removeBioLinkPrefix(t)))
        );
      if (!commonCategories.length) {
        debug('Given IDs have no common categories. Cannot infer categories.');
        this.logs.push('Unable to infer multi-ID category (no categories in common)');
        return [];
      }
      const tree = biolink.biolink._biolink_class_tree._objects_in_tree
      try {
        const mostSpecificCommonCategory = commonCategories.reduce((prev, cat) => {
          let parent = cat;
          if (tree[cat]._children.includes(prev)) {
            return prev;
          }
          while (parent) {
            if (prev === parent || tree[prev]._children.includes(cat)) {
              return cat;
            } else if (tree[parent]._children.includes(prev)) {
              return cat;
            }
            parent = tree[parent]._parent;
          }
          return prev;
        }, commonCategories[0]);
        return ["biolink:" + mostSpecificCommonCategory];
      } catch (error) {
        debug(`Unable to retrieve categories due to error ${error}`);
        return [];
      }
    }
  }

   /**
   * @private
   */
    async _storeNodes() {
      let nodes = {};
      for (let node_id in this.queryGraph.nodes) {
        //if node has ID but no categories
        if (
          (!Object.hasOwnProperty.call(this.queryGraph.nodes[node_id], 'categories') &&
          Object.hasOwnProperty.call(this.queryGraph.nodes[node_id], 'ids')) ||
          (Object.hasOwnProperty.call(this.queryGraph.nodes[node_id], 'categories') &&
          this.queryGraph.nodes[node_id].categories.length == 0 &&
          Object.hasOwnProperty.call(this.queryGraph.nodes[node_id], 'ids'))
          ) {
          let category = await this._findNodeCategories(this.queryGraph.nodes[node_id].ids);
          this.queryGraph.nodes[node_id].categories = category;
          debug(`Node category found. Assigning value: ${JSON.stringify(this.queryGraph.nodes[node_id])}`);
          this.logs.push(
            new LogEntry(
            'DEBUG',
            null,
            `Assigned missing node ID category: ${JSON.stringify(this.queryGraph.nodes[node_id])}`).getLog(),
          );
          nodes[node_id] = new QNode(node_id, this.queryGraph.nodes[node_id]);
        }else{
          debug(`Creating node...`);
          nodes[node_id] = new QNode(node_id, this.queryGraph.nodes[node_id]);
        }

      }
      this.logs.push(
        new LogEntry('DEBUG', null, `BTE identified ${Object.keys(nodes).length} QNodes from your query graph`).getLog(),
      );
      return nodes;
    }

  /**
   * @private
   */
   async _storeEdges() {
    if (this.nodes === undefined) {
      this.nodes = await this._storeNodes();
    }
    let edges = {};
    for (let edge_id in this.queryGraph.edges) {
      let edge_info = {
        ...this.queryGraph.edges[edge_id],
        ...{
          subject: this.nodes[this.queryGraph.edges[edge_id].subject],
          object: this.nodes[this.queryGraph.edges[edge_id].object],
        },
      };
      //store in each node ids of edges connected to them
      this.nodes[this.queryGraph.edges[edge_id].subject].updateConnection(edge_id);
      this.nodes[this.queryGraph.edges[edge_id].object].updateConnection(edge_id);

      edges[edge_id] = new QEdge(edge_id, edge_info);
    }
    this.logs.push(
      new LogEntry('DEBUG', null, `BTE identified ${Object.keys(edges).length} QEdges from your query graph`).getLog(),
    );
    return edges;
  }

  /**
   *
   */
  async calculateEdges() {
    this._validate(this.queryGraph);
    //populate edge and node info
    debug(`(1) Creating edges for manager...`);
    if (this.edges === undefined) {
      this.edges = await this._storeEdges();
    }
    let edges = {};
    let edge_index = 0;
    //create a smart query edge per edge in query
    for (const edge_id in this.edges) {
      edges[edge_index] = [
        // () ----> ()
        this.edges[edge_id].object.curie ?
        new ExeEdge(this.edges[edge_id], true, undefined) :
        new ExeEdge(this.edges[edge_id], false, undefined)
        // reversed () <---- ()
      ];
      edge_index++;
    }
    return edges;
  }

};
