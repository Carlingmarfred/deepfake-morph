const EPSILON = 1e-9;

export function solveOptimalTransport(costMatrix, supply, demand, options = {}) {
  const maxIterations = options.maxIterations ?? 500;
  const tolerance = options.tolerance ?? 1e-8;
  const rowCount = costMatrix.length;
  const columnCount = costMatrix[0]?.length ?? 0;

  if (!rowCount || !columnCount) {
    throw new Error("The cost matrix must be non-empty.");
  }

  if (supply.length !== rowCount || demand.length !== columnCount) {
    throw new Error("Supply and demand must match the cost matrix dimensions.");
  }

  const supplyMass = sum(supply);
  const demandMass = sum(demand);

  if (Math.abs(supplyMass - demandMass) > 1e-7) {
    throw new Error("Optimal transport requires balanced total mass.");
  }

  const transport = Array.from({ length: rowCount }, () => Array(columnCount).fill(0));
  const basis = new Set();

  initializeLeastCostPlan(costMatrix, supply.slice(), demand.slice(), transport, basis);
  completeBasisWithZeroFlows(costMatrix, basis, rowCount, columnCount);

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const { u, v } = computePotentials(costMatrix, basis, rowCount, columnCount);
    let entering = null;
    let mostNegativeReducedCost = -tolerance;

    for (let row = 0; row < rowCount; row += 1) {
      for (let column = 0; column < columnCount; column += 1) {
        const cellKey = keyFor(row, column);
        if (basis.has(cellKey)) {
          continue;
        }

        const reducedCost = costMatrix[row][column] - u[row] - v[column];

        if (reducedCost < mostNegativeReducedCost) {
          mostNegativeReducedCost = reducedCost;
          entering = { row, column };
        }
      }
    }

    if (!entering) {
      return {
        plan: transport,
        iterations: iteration - 1,
        totalCost: computeTotalCost(costMatrix, transport),
        activePairs: countPositiveEntries(transport),
      };
    }

    const cycle = buildCycle(entering, basis, rowCount, columnCount);
    pivotAlongCycle(transport, basis, cycle, entering);
  }

  throw new Error("Transport simplex exceeded the iteration limit.");
}

function initializeLeastCostPlan(costMatrix, supply, demand, transport, basis) {
  const activeRows = new Set(supply.map((_, index) => index));
  const activeColumns = new Set(demand.map((_, index) => index));

  while (activeRows.size > 0 && activeColumns.size > 0) {
    let bestCell = null;

    for (const row of activeRows) {
      for (const column of activeColumns) {
        if (!bestCell || costMatrix[row][column] < bestCell.cost) {
          bestCell = { row, column, cost: costMatrix[row][column] };
        }
      }
    }

    if (!bestCell) {
      break;
    }

    const shipped = Math.min(supply[bestCell.row], demand[bestCell.column]);
    transport[bestCell.row][bestCell.column] = shipped;
    basis.add(keyFor(bestCell.row, bestCell.column));

    supply[bestCell.row] -= shipped;
    demand[bestCell.column] -= shipped;

    if (supply[bestCell.row] <= EPSILON) {
      activeRows.delete(bestCell.row);
    }

    if (demand[bestCell.column] <= EPSILON) {
      activeColumns.delete(bestCell.column);
    }
  }
}

function completeBasisWithZeroFlows(costMatrix, basis, rowCount, columnCount) {
  const dsu = new DisjointSet(rowCount + columnCount);

  for (const cellKey of basis) {
    const { row, column } = parseKey(cellKey);
    dsu.union(row, rowCount + column);
  }

  const candidates = [];

  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const cellKey = keyFor(row, column);
      if (!basis.has(cellKey)) {
        candidates.push({ row, column, cost: costMatrix[row][column] });
      }
    }
  }

  candidates.sort((left, right) => left.cost - right.cost);

  for (const candidate of candidates) {
    if (basis.size >= rowCount + columnCount - 1) {
      break;
    }

    if (dsu.union(candidate.row, rowCount + candidate.column)) {
      basis.add(keyFor(candidate.row, candidate.column));
    }
  }
}

function computePotentials(costMatrix, basis, rowCount, columnCount) {
  const rowAdjacency = Array.from({ length: rowCount }, () => []);
  const columnAdjacency = Array.from({ length: columnCount }, () => []);

  for (const cellKey of basis) {
    const { row, column } = parseKey(cellKey);
    rowAdjacency[row].push(column);
    columnAdjacency[column].push(row);
  }

  const u = Array(rowCount).fill(null);
  const v = Array(columnCount).fill(null);
  const queue = [{ type: "row", index: 0 }];
  u[0] = 0;

  while (queue.length > 0) {
    const current = queue.shift();

    if (current.type === "row") {
      for (const column of rowAdjacency[current.index]) {
        if (v[column] !== null) {
          continue;
        }

        v[column] = costMatrix[current.index][column] - u[current.index];
        queue.push({ type: "column", index: column });
      }
      continue;
    }

    for (const row of columnAdjacency[current.index]) {
      if (u[row] !== null) {
        continue;
      }

      u[row] = costMatrix[row][current.index] - v[current.index];
      queue.push({ type: "row", index: row });
    }
  }

  return {
    u: u.map((value) => value ?? 0),
    v: v.map((value) => value ?? 0),
  };
}

function buildCycle(entering, basis, rowCount, columnCount) {
  const rowAdjacency = Array.from({ length: rowCount }, () => []);
  const columnAdjacency = Array.from({ length: columnCount }, () => []);

  for (const cellKey of basis) {
    const { row, column } = parseKey(cellKey);
    rowAdjacency[row].push(column);
    columnAdjacency[column].push(row);
  }

  const startNode = rowNode(entering.row);
  const goalNode = columnNode(entering.column);
  const queue = [startNode];
  const previous = new Map([[startNode, null]]);

  while (queue.length > 0) {
    const current = queue.shift();

    if (current === goalNode) {
      break;
    }

    const neighbors = current.startsWith("r")
      ? rowAdjacency[nodeIndex(current)].map((column) => columnNode(column))
      : columnAdjacency[nodeIndex(current)].map((row) => rowNode(row));

    for (const neighbor of neighbors) {
      if (!previous.has(neighbor)) {
        previous.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }

  if (!previous.has(goalNode)) {
    throw new Error("Could not construct a cycle for the entering variable.");
  }

  const nodePath = [];
  let cursor = goalNode;

  while (cursor) {
    nodePath.push(cursor);
    cursor = previous.get(cursor);
  }

  nodePath.reverse();

  const pathCells = [];

  for (let index = 0; index < nodePath.length - 1; index += 1) {
    const currentNode = nodePath[index];
    const nextNode = nodePath[index + 1];

    if (currentNode.startsWith("r")) {
      pathCells.push({
        row: nodeIndex(currentNode),
        column: nodeIndex(nextNode),
      });
    } else {
      pathCells.push({
        row: nodeIndex(nextNode),
        column: nodeIndex(currentNode),
      });
    }
  }

  return [{ row: entering.row, column: entering.column }, ...pathCells.reverse()];
}

function pivotAlongCycle(transport, basis, cycle, entering) {
  const minusCells = cycle.filter((_, index) => index % 2 === 1);
  let step = Infinity;
  let leaving = minusCells[0];

  for (const cell of minusCells) {
    const value = transport[cell.row][cell.column];
    if (value < step) {
      step = value;
      leaving = cell;
    }
  }

  basis.add(keyFor(entering.row, entering.column));

  cycle.forEach((cell, index) => {
    const delta = index % 2 === 0 ? step : -step;
    const nextValue = transport[cell.row][cell.column] + delta;
    transport[cell.row][cell.column] = Math.abs(nextValue) <= EPSILON ? 0 : nextValue;
  });

  basis.delete(keyFor(leaving.row, leaving.column));
}

function computeTotalCost(costMatrix, transport) {
  let total = 0;

  for (let row = 0; row < transport.length; row += 1) {
    for (let column = 0; column < transport[row].length; column += 1) {
      total += costMatrix[row][column] * transport[row][column];
    }
  }

  return total;
}

function countPositiveEntries(matrix) {
  let count = 0;

  for (const row of matrix) {
    for (const value of row) {
      if (value > EPSILON) {
        count += 1;
      }
    }
  }

  return count;
}

function keyFor(row, column) {
  return `${row}:${column}`;
}

function parseKey(key) {
  const [row, column] = key.split(":").map(Number);
  return { row, column };
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function rowNode(index) {
  return `r${index}`;
}

function columnNode(index) {
  return `c${index}`;
}

function nodeIndex(node) {
  return Number(node.slice(1));
}

class DisjointSet {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = Array(size).fill(0);
  }

  find(value) {
    if (this.parent[value] !== value) {
      this.parent[value] = this.find(this.parent[value]);
    }

    return this.parent[value];
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);

    if (leftRoot === rightRoot) {
      return false;
    }

    if (this.rank[leftRoot] < this.rank[rightRoot]) {
      this.parent[leftRoot] = rightRoot;
      return true;
    }

    if (this.rank[leftRoot] > this.rank[rightRoot]) {
      this.parent[rightRoot] = leftRoot;
      return true;
    }

    this.parent[rightRoot] = leftRoot;
    this.rank[leftRoot] += 1;
    return true;
  }
}
